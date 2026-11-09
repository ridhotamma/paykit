/**
 * Aulaa client — the one place that turns a shop's stored credentials into
 * live Aulaa API calls.
 *
 * Aulaa's API v1 is plain REST (`https://api.aulaa.co`) authenticated with a
 * project API key as a Bearer token. There is no vendor SDK and no separate
 * sandbox host: a project is in sandbox or live mode in the dashboard, and the
 * response's `is_test` field tells the two apart.
 *
 * Server-only by contract: the API key moves money and must never reach a
 * browser bundle. That is why this module lives behind the
 * `@ridhotamma/paykit/aulaa` subpath and is never re-exported from the main
 * barrel.
 */

import { z } from 'zod'

import { mergeCredentialBlobs } from '../credentials'

export class AulaaApiError extends Error {
  readonly status: number
  readonly body: unknown
  /** The existing payment id a 409 duplicate-order response points at. */
  readonly paymentId: string | null

  constructor(status: number, message: string, body?: unknown, paymentId: string | null = null) {
    super(message)
    this.name = 'AulaaApiError'
    this.status = status
    this.body = body
    this.paymentId = paymentId
  }
}

function aulaaBodyDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return typeof body === 'string' ? body.slice(0, 200) : ''
  }
  const record = body as Record<string, unknown>
  return String(record.error ?? record.message ?? '')
}

export function describeAulaaError(error: unknown): string {
  if (error instanceof AulaaApiError) {
    const detail = aulaaBodyDetail(error.body)
    return `Aulaa answered ${error.status}${detail ? `: ${detail}` : ''}.`
  }
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The secrets one shop's Aulaa connection needs.
 *
 * `apiKey` is the project API key (`pgw_id_…`, shown once when created).
 * `webhookSecret` is the same project's Webhook Secret: Aulaa signs every
 * callback with it (`X-Webhook-Signature`) and there is no separate signing
 * key to configure.
 */
export const aulaaCredentialsSchema = z.object({
  apiKey: z.string().trim().min(1, 'Aulaa API Key is required.'),
  webhookSecret: z.string().trim().min(1, 'Aulaa Webhook Secret is required.'),
})

export type AulaaCredentials = z.infer<typeof aulaaCredentialsSchema>

export type AulaaCredentialsResult =
  { ok: true; credentials: AulaaCredentials } | { ok: false; error: string }

/**
 * Read a shop's Aulaa credentials out of its stored JSON blobs.
 *
 * A connection stores two JSON strings — `credentials` (the sealed secrets)
 * and `config` (the non-secrets) — so both are merged before validation, with
 * the credentials blob authoritative for any key it carries (see
 * `mergeCredentialBlobs`). Returns `ok: false` with a seller-readable reason
 * when either secret is missing.
 */
export function readAulaaCredentials(
  blobs: ReadonlyArray<Record<string, string | undefined> | null | undefined>,
): AulaaCredentialsResult {
  const merged = mergeCredentialBlobs(blobs)

  const parsed = aulaaCredentialsSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `Aulaa credentials are not configured correctly (${problems}).` }
  }

  return { ok: true, credentials: parsed.data }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/** The one Aulaa API host; sandbox and live projects share it. */
export function aulaaApiBase(): string {
  return 'https://api.aulaa.co'
}

function aulaaAuthHeader(credentials: AulaaCredentials): string {
  return `Bearer ${credentials.apiKey}`
}

async function readAulaaBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function throwForStatus(action: string, response: Response, body: unknown): never {
  const record =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  const detail = aulaaBodyDetail(body)
  const paymentId =
    typeof record?.payment_id === 'string' && record.payment_id !== '' ? record.payment_id : null
  throw new AulaaApiError(
    response.status,
    `Aulaa ${action} failed (${response.status})${detail ? `: ${detail}` : ''}.`,
    body,
    paymentId,
  )
}

async function aulaaRequest(
  credentials: AulaaCredentials,
  action: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: aulaaAuthHeader(credentials),
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${aulaaApiBase()}${path}`, { ...init, headers })
  const body = await readAulaaBody(response)
  if (!response.ok) throwForStatus(action, response, body)
  return body
}

/* -------------------------------------------------------------------------- */
/* Payment methods                                                            */
/* -------------------------------------------------------------------------- */

export const aulaaPaymentMethodSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  is_available: z.boolean().optional(),
  min_amount: z.number().int().nonnegative(),
  max_amount: z.number().int().nonnegative(),
})

export type AulaaPaymentMethod = z.infer<typeof aulaaPaymentMethodSchema>

export const aulaaPaymentMethodsResponseSchema = z.object({
  country: z.string().min(1),
  currency: z.string().min(1),
  methods: z.array(aulaaPaymentMethodSchema),
})

/**
 * The project's active payment methods.
 *
 * This is also the connection test: an invalid or inactive API key answers
 * 401/403, while a valid one returns the project's own catalogue.
 */
export async function getAulaaPaymentMethods(
  credentials: AulaaCredentials,
): Promise<AulaaPaymentMethod[]> {
  const body = await aulaaRequest(credentials, 'payment method list', '/v1/payments/methods', {
    method: 'GET',
  })
  const parsed = aulaaPaymentMethodsResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new AulaaApiError(
      200,
      'Aulaa answered with an unreadable payment method list.',
      body,
    )
  }
  return parsed.data.methods
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                   */
/* -------------------------------------------------------------------------- */

/** The `POST /v1/payments` request body, as `./charge` builds it. */
export interface AulaaCreatePaymentRequest {
  /** Unique per project; also the correlation key the webhook echoes. */
  order_id: string
  /** Full rupiah — the order's remaining balance. */
  amount: number
  /** Optional method code (`qris`, `bca_va`, …); omitted lets the buyer choose. */
  payment_method?: string
  /** Where Aulaa sends the buyer after payment. */
  redirect_url?: string
}

export const aulaaPaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().min(1),
  status: z.string().min(1),
  amount: z.number().int(),
  fee_amount: z.number().int().nullish(),
  charged_amount: z.number().int().nullish(),
  currency: z.string().min(1),
  country_code: z.string().min(1).nullish(),
  payment_method: z.string().nullish(),
  payment_link: z.string().min(1),
  redirect_url: z.string().nullish(),
  is_test: z.boolean().optional(),
  expired_at: z.string().nullish(),
  paid_at: z.string().nullish(),
  created_at: z.string().nullish(),
})

export type AulaaPayment = z.infer<typeof aulaaPaymentSchema>

function parseAulaaPayment(body: unknown, action: string): AulaaPayment {
  const parsed = aulaaPaymentSchema.safeParse(body)
  if (!parsed.success) {
    throw new AulaaApiError(200, `Aulaa ${action} answered with an unreadable payment.`, body)
  }
  return parsed.data
}

/**
 * Create the payment link the buyer pays.
 *
 * Aulaa makes `order_id` unique per project: a repeat answers `409` with the
 * existing `payment_id` rather than creating a second charge. The adapter
 * handles that conflict as an idempotent retry (see `../../universal/adapters/aulaa`).
 */
export async function createAulaaPayment(
  credentials: AulaaCredentials,
  body: AulaaCreatePaymentRequest,
): Promise<AulaaPayment> {
  const response = await aulaaRequest(credentials, 'payment creation', '/v1/payments', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseAulaaPayment(response, 'payment creation')
}

/** Read one payment back by the Aulaa invoice id (not the merchant order id). */
export async function getAulaaPayment(
  credentials: AulaaCredentials,
  paymentId: string,
): Promise<AulaaPayment> {
  const response = await aulaaRequest(
    credentials,
    `payment ${paymentId}`,
    `/v1/payments/${encodeURIComponent(paymentId)}`,
    { method: 'GET' },
  )
  return parseAulaaPayment(response, `payment ${paymentId}`)
}

/** Cancel a still-pending payment. Paid/expired/cancelled payments answer 409. */
export async function cancelAulaaPayment(
  credentials: AulaaCredentials,
  paymentId: string,
): Promise<AulaaPayment> {
  const response = await aulaaRequest(
    credentials,
    `payment ${paymentId} cancellation`,
    `/v1/payments/${encodeURIComponent(paymentId)}/cancel`,
    { method: 'POST' },
  )
  return parseAulaaPayment(response, `payment ${paymentId} cancellation`)
}
