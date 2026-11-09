/**
 * DOKU client — credential handling, DOKU Checkout creation and the
 * Non-SNAP status read.
 *
 * DOKU's Checkout API is plain REST with a signed header set rather than a
 * vendor SDK:
 *
 *   POST /checkout/v1/payment          create the hosted checkout
 *   GET  /orders/v1/status/{invoice}   read the transaction back
 *
 * Every request signs the method, path, timestamp and (for POST) the exact
 * body bytes with the project Secret Key. See `./signature` for the scheme.
 *
 * Server-only by contract: the Secret Key moves money and must never reach a
 * browser bundle. That is why this module lives behind the
 * `@ridhotamma/paykit/doku` subpath and is never re-exported from the main
 * barrel.
 */

import { z } from 'zod'

import { mergeCredentialBlobs } from '../credentials'
import {
  dokuDigest,
  dokuRequestTimestamp,
  dokuSignatureHeader,
  type DokuSignatureComponents,
} from './signature'

export class DokuApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'DokuApiError'
    this.status = status
    this.body = body
  }
}

function dokuBodyDetail(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200)
  if (typeof body !== 'object' || body === null) return ''
  const record = body as Record<string, unknown>
  const messages = Array.isArray(record.error_messages)
    ? record.error_messages.filter((item): item is string => typeof item === 'string')
    : Array.isArray(record.message)
      ? record.message.filter((item): item is string => typeof item === 'string')
      : typeof record.message === 'string'
        ? [record.message]
        : []
  return messages.join('; ')
}

export function describeDokuError(error: unknown): string {
  if (error instanceof DokuApiError) {
    const detail = dokuBodyDetail(error.body)
    return `DOKU answered ${error.status}${detail ? `: ${detail}` : ''}.`
  }
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

export const DOKU_ENVIRONMENTS = ['sandbox', 'production'] as const

export type DokuEnvironment = (typeof DOKU_ENVIRONMENTS)[number]

/**
 * The secrets and settings one shop's DOKU connection needs.
 *
 * `clientId` (`MCH-…`) and `secretKey` come from the DOKU Back Office. The
 * environment selects the API host; the same credentials do not work on both,
 * so an unset value falls back to sandbox rather than to a guess.
 */
export const dokuCredentialsSchema = z.object({
  clientId: z.string().trim().min(1, 'DOKU Client ID is required.'),
  secretKey: z.string().trim().min(1, 'DOKU Secret Key is required.'),
  environment: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value === '' ? 'sandbox' : value))
    .pipe(z.enum(DOKU_ENVIRONMENTS))
    .default('sandbox'),
})

export type DokuCredentials = z.infer<typeof dokuCredentialsSchema>

export type DokuCredentialsResult =
  { ok: true; credentials: DokuCredentials } | { ok: false; error: string }

/**
 * Read a shop's DOKU credentials out of its stored JSON blobs.
 *
 * A connection stores two JSON strings — `credentials` (the sealed secrets)
 * and `config` (the non-secrets) — so both are merged before validation, with
 * the credentials blob authoritative for any key it carries (see
 * `mergeCredentialBlobs`). Returns `ok: false` with a seller-readable reason
 * when either secret is missing.
 */
export function readDokuCredentials(
  blobs: ReadonlyArray<Record<string, string | undefined> | null | undefined>,
): DokuCredentialsResult {
  const merged = mergeCredentialBlobs(blobs)

  const parsed = dokuCredentialsSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `DOKU credentials are not configured correctly (${problems}).` }
  }

  return { ok: true, credentials: parsed.data }
}

/** The API host for one DOKU deployment. */
export function dokuApiBase(environment: DokuEnvironment): string {
  return environment === 'production' ? 'https://api.doku.com' : 'https://api-sandbox.doku.com'
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

async function readDokuBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function throwForStatus(action: string, response: Response, body: unknown): never {
  const detail = dokuBodyDetail(body)
  throw new DokuApiError(
    response.status,
    `DOKU ${action} failed (${response.status})${detail ? `: ${detail}` : ''}.`,
    body,
  )
}

/**
 * One signed DOKU request.
 *
 * `path` is used verbatim as both the URL path and the `Request-Target`
 * component — DOKU signs the path the merchant asks for, so the two must not
 * drift apart. POST bodies are serialised once and the digest is taken over
 * those exact bytes.
 */
async function dokuRequest(
  credentials: DokuCredentials,
  action: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<unknown> {
  const requestId = globalThis.crypto.randomUUID()
  const requestTimestamp = dokuRequestTimestamp()
  const bodyText = init.body === undefined ? undefined : JSON.stringify(init.body)
  const digest = bodyText === undefined ? undefined : await dokuDigest(bodyText)

  const components: DokuSignatureComponents = {
    clientId: credentials.clientId,
    requestId,
    requestTimestamp,
    requestTarget: path,
    ...(digest !== undefined ? { digest } : {}),
  }
  const signature = await dokuSignatureHeader(components, credentials.secretKey)

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Client-Id': credentials.clientId,
    'Request-Id': requestId,
    'Request-Timestamp': requestTimestamp,
    Signature: signature,
  }
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${dokuApiBase(credentials.environment)}${path}`, {
    method: init.method,
    headers,
    ...(bodyText !== undefined ? { body: bodyText } : {}),
  })
  const body = await readDokuBody(response)
  if (!response.ok) throwForStatus(action, response, body)
  return body
}

/* -------------------------------------------------------------------------- */
/* Checkout creation                                                          */
/* -------------------------------------------------------------------------- */

/** One `order.line_items` entry on a DOKU Checkout request. */
export interface DokuLineItem {
  id?: string
  name: string
  quantity: number
  price: number
  sku?: string
  category?: string
  url?: string
  image_url?: string
  type?: string
}

/** The `POST /checkout/v1/payment` request body, as `./charge` builds it. */
export interface DokuCreateCheckoutRequest {
  order: {
    /** Full rupiah — the order's remaining balance. */
    amount: number
    /** Merchant invoice number; DOKU's idempotency/correlation key. */
    invoice_number: string
    currency?: string
    /** Where DOKU sends the buyer after paying (the checkout page's button). */
    callback_url?: string
    /** Where the result page's "back to merchant" button goes. */
    callback_url_result?: string
    language?: string
    auto_redirect?: boolean
    line_items?: DokuLineItem[]
  }
  payment?: {
    /** Checkout page lifetime in minutes; DOKU defaults to 60. */
    payment_due_date?: number
    /** Pin the checkout to these exact DOKU channel codes. */
    payment_method_types?: string[]
    type?: 'SALE'
  }
  customer?: {
    id?: string
    name?: string
    email?: string
    phone?: string
    country?: string
  }
  additional_info?: {
    /** Override the dashboard notification URL; its path must match. */
    override_notification_url?: string
  }
}

const dokuNumeric = z.coerce.number()

export const dokuCreateCheckoutResponseSchema = z.object({
  message: z.array(z.string()).optional(),
  response: z.object({
    order: z.object({
      amount: dokuNumeric,
      invoice_number: z.string().min(1),
      currency: z.string().optional(),
      session_id: z.string().optional(),
    }),
    payment: z.object({
      url: z.string().min(1),
      token_id: z.string().optional(),
      /** `yyyyMMddHHmmss` in UTC+7, per DOKU's response contract. */
      expired_date: z.string().nullish(),
      payment_method_types: z.array(z.string()).optional(),
    }),
  }),
})

export interface DokuCreatedCheckout {
  paymentUrl: string
  invoiceNumber: string
  amount: number
  tokenId: string | null
  /** DOKU's `yyyyMMddHHmmss` (UTC+7) expiry, or null when absent. */
  expiredAt: string | null
}

/** Create the hosted checkout the buyer pays. */
export async function createDokuCheckout(
  credentials: DokuCredentials,
  body: DokuCreateCheckoutRequest,
): Promise<DokuCreatedCheckout> {
  const response = await dokuRequest(credentials, 'checkout creation', '/checkout/v1/payment', {
    method: 'POST',
    body,
  })
  const parsed = dokuCreateCheckoutResponseSchema.safeParse(response)
  if (!parsed.success) {
    throw new DokuApiError(200, 'DOKU answered with an unreadable checkout response.', response)
  }
  const payment = parsed.data.response.payment
  return {
    paymentUrl: payment.url,
    invoiceNumber: parsed.data.response.order.invoice_number,
    amount: parsed.data.response.order.amount,
    tokenId: payment.token_id ?? null,
    expiredAt: payment.expired_date ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/* Status / notification body                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The transaction shape shared by `GET /orders/v1/status` and the HTTP
 * notification. Only the fields PayKit needs are required; DOKU is free to add
 * more, and the parser deliberately ignores them.
 */
export const dokuTransactionSchema = z.object({
  order: z.object({
    invoice_number: z.string().min(1),
    amount: dokuNumeric,
    status: z.string().optional(),
  }),
  transaction: z.object({
    status: z.string().min(1),
    date: z.string().nullish(),
    original_request_id: z.string().nullish(),
  }),
  service: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  acquirer: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  channel: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
})

export type DokuTransaction = z.infer<typeof dokuTransactionSchema>

/** Parse a status response or notification body; `null` when it is not one. */
export function parseDokuTransaction(payload: unknown): DokuTransaction | null {
  const parsed = dokuTransactionSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/**
 * Read a transaction back by the merchant invoice number.
 *
 * DOKU asks callers to wait ~60 seconds after payment before asking; the
 * webhook is the primary settlement source and this is the reconcile path.
 * The invoice number is the same value stored as `paymentReference`.
 */
export async function getDokuTransactionStatus(
  credentials: DokuCredentials,
  invoiceNumber: string,
): Promise<DokuTransaction> {
  const path = `/orders/v1/status/${encodeURIComponent(invoiceNumber)}`
  const response = await dokuRequest(credentials, `status for ${invoiceNumber}`, path, {
    method: 'GET',
  })
  const parsed = parseDokuTransaction(response)
  if (!parsed) {
    throw new DokuApiError(200, 'DOKU answered with an unreadable transaction status.', response)
  }
  return parsed
}
