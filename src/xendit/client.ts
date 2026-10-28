/**
 * Xendit client factory — the one place that turns a shop's stored
 * credentials into live Xendit calls.
 *
 * Server-only by contract: the secret key moves money and must never reach
 * a browser bundle. That is why this module lives behind the
 * `@ridhotamma/paykit/xendit` subpath and is never re-exported from the main
 * barrel — the admin UI imports the registry from `.`, servers import the
 * logic from `./xendit`.
 *
 * **Official SDK, with one documented gap.** Credential handling and the
 * legacy invoice read-back go through `xendit-node` (`createXenditClient`).
 * The SDK (v7) does not expose the Payment Sessions API (`POST /sessions`)
 * yet — its surface stops at the legacy Invoice and the per-channel Payment
 * Request APIs — while Xendit's own docs name Payment Sessions the
 * replacement for the legacy payment link. The session transport therefore
 * stays a thin fetch against the SDK's configured base URL, authenticated
 * with the same secret key the SDK client holds, so there is exactly one
 * credential shape and one host. The legacy invoice read is kept solely to
 * reconcile charges created before the migration.
 */

import { Xendit, XenditSdkError } from 'xendit-node'
import { z } from 'zod'

import { mergeCredentialBlobs } from '../credentials'

export class XenditApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'XenditApiError'
    this.status = status
    this.body = body
  }
}

/** The seller-readable line for one SDK or transport failure. */
function xenditErrorDetail(error: XenditSdkError | XenditApiError): string {
  if (error instanceof XenditSdkError) {
    return error.errorMessage?.trim() || error.message
  }
  return typeof error.body === 'object' && error.body !== null
    ? String(
        (error.body as Record<string, unknown>).message ??
          (error.body as Record<string, unknown>).error_code ??
          '',
      )
    : typeof error.body === 'string'
      ? error.body.slice(0, 200)
      : ''
}

/** Wrap an SDK failure so callers can branch on `status` (404 vs 401). */
function wrapXenditSdkError(error: unknown, action: string): never {
  if (error instanceof XenditSdkError) {
    const status = typeof error.status === 'number' ? error.status : 0
    const detail = xenditErrorDetail(error)
    throw new XenditApiError(
      status,
      `Xendit ${action} failed (${status})${detail ? `: ${detail}` : ''}.`,
      error.rawResponse,
    )
  }
  throw error instanceof Error ? error : new Error(String(error))
}

export function describeXenditError(error: unknown): string {
  if (error instanceof XenditApiError) {
    const detail =
      typeof error.body === 'object' && error.body !== null
        ? String(
            (error.body as Record<string, unknown>).message ??
              (error.body as Record<string, unknown>).error_code ??
              '',
          )
        : typeof error.body === 'string'
          ? error.body.slice(0, 200)
          : ''
    return `Xendit answered ${error.status}${detail ? `: ${detail}` : ''}.`
  }
  if (error instanceof XenditSdkError) {
    return `Xendit answered ${error.status}: ${xenditErrorDetail(error)}`
  }
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The secrets one shop's Xendit connection needs.
 *
 * `secretKey` comes from the Xendit dashboard → Settings → Developers → API
 * keys (`xnd_development_…` for sandbox, `xnd_production_…` for live — the
 * key itself selects the environment, so there is no `environment` field to
 * mismatch). `webhookToken` is the account's callback token from Settings →
 * Webhooks, and authenticates every invoice callback the shop receives.
 */
export const xenditCredentialsSchema = z.object({
  secretKey: z.string().trim().min(1, 'Xendit Secret Key is required.'),
  webhookToken: z.string().trim().min(1, 'Xendit webhook token is required.'),
})

export type XenditCredentials = z.infer<typeof xenditCredentialsSchema>

export type XenditCredentialsResult =
  { ok: true; credentials: XenditCredentials } | { ok: false; error: string }

/**
 * Read a shop's Xendit credentials out of its stored JSON blobs.
 *
 * A connection stores two JSON strings — `credentials` (the sealed secrets)
 * and `config` (the non-secrets) — so both are merged before validation, with
 * the credentials blob authoritative for any key it carries (see
 * `mergeCredentialBlobs`). Returns `ok: false` with a seller-readable reason
 * when either secret is missing; a half-configured connection must fail
 * loudly, never charge against the wrong account.
 */
export function readXenditCredentials(
  blobs: ReadonlyArray<Record<string, string | undefined> | null | undefined>,
): XenditCredentialsResult {
  const merged = mergeCredentialBlobs(blobs)

  const parsed = xenditCredentialsSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `Xendit credentials are not configured correctly (${problems}).` }
  }

  return { ok: true, credentials: parsed.data }
}

/** The official `xendit-node` client for one shop's secret key. Cheap to build per request. */
export function createXenditClient(credentials: XenditCredentials): Xendit {
  return new Xendit({ secretKey: credentials.secretKey })
}

/**
 * Which side of Xendit a key talks to, from the key prefix alone.
 *
 * Display-only: the API host never changes, but the connection test reports
 * this so the seller can tell a sandbox key from a live one at a glance.
 */
export function xenditKeyEnvironment(secretKey: string): 'sandbox' | 'production' {
  return secretKey.startsWith('xnd_production_') ? 'production' : 'sandbox'
}

/** The one Xendit API host — both key kinds call it. */
export function xenditApiBase(): string {
  return 'https://api.xendit.co'
}

/**
 * Prove the secret key authenticates, through the official SDK.
 *
 * Lists a single invoice: a valid key with the Money-in permission answers,
 * an invalid key answers 401 and an under-permissioned one 403, both wrapped
 * as `XenditApiError`. Deliberately a Money-in read rather than a balance
 * read — the integration only needs the Money-in product, so the key never
 * has to be granted Balance access just to pass a connection test.
 */
export async function verifyXenditSecretKey(credentials: XenditCredentials): Promise<void> {
  try {
    await createXenditClient(credentials).Invoice.getInvoices({ limit: 1 })
  } catch (error) {
    wrapXenditSdkError(error, 'key check')
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

function xenditAuthHeader(secretKey: string): string {
  // Basic auth with the secret key as the username and an empty password —
  // the same scheme `xendit-node` builds for its own requests.
  const basic = globalThis.btoa(`${secretKey}:`)
  return `Basic ${basic}`
}

async function readXenditBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function throwForStatus(action: string, response: Response, body: unknown): never {
  const detail =
    typeof body === 'object' && body !== null
      ? String(
          (body as Record<string, unknown>).message ??
            (body as Record<string, unknown>).error_code ??
            '',
        )
      : typeof body === 'string'
        ? body.slice(0, 200)
        : ''
  throw new XenditApiError(
    response.status,
    `Xendit ${action} failed (${response.status})${detail ? `: ${detail}` : ''}.`,
    body,
  )
}

/* -------------------------------------------------------------------------- */
/* Payment Sessions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The session country PayKit sends.
 *
 * Payment Sessions require an explicit country and PayKit's Xendit
 * catalogue is Indonesian (IDR, Indonesian banks and wallets), so it is a
 * constant here rather than per-shop configuration.
 */
export const XENDIT_SESSION_COUNTRY = 'ID'

/** The currency the session API is asked for — guarded at charge time. */
export const XENDIT_SESSION_CURRENCY = 'IDR'

/** One line of the session `items` basket. */
export interface XenditSessionItem {
  reference_id: string
  type: 'DIGITAL_PRODUCT' | 'PHYSICAL_PRODUCT' | 'DIGITAL_SERVICE' | 'PHYSICAL_SERVICE' | 'FEE'
  name: string
  net_unit_amount: number
  quantity: number
  category: string
  description?: string
}

/** The `POST /sessions` request body, as `./charge` builds it. */
export interface XenditCreateSessionRequest {
  /** The PayKit `orderNumber` — the contract the webhook handler settles on. */
  reference_id: string
  session_type: 'PAY'
  mode: 'PAYMENT_LINK'
  /** Integer minor units — the only amount ever charged is the order's remaining balance. */
  amount: number
  currency: string
  country: string
  description?: string
  locale?: string
  /** ISO 8601 instant the hosted page stops accepting payment. */
  expires_at?: string
  success_return_url?: string
  cancel_return_url?: string
  /** Restrict the hosted page to these channel codes; omitted means every active channel. */
  allowed_payment_channels?: string[]
  items?: XenditSessionItem[]
  /**
   * Free-form merchant data echoed back on the session. PayKit stores the
   * charged channel in `paykit_channel` so the webhook can label the
   * payment without a second lookup.
   */
  metadata?: Record<string, string>
}

export interface XenditPaymentSession {
  payment_session_id: string
  reference_id: string
  status: string
  amount: number | null
  currency: string | null
  payment_link_url: string | null
  expires_at: string | null
  payment_id: string | null
  /** Echoed merchant metadata; PayKit stores the charged channel in it. */
  metadata: Record<string, unknown> | null
}

function toPaymentSession(record: Record<string, unknown>): XenditPaymentSession {
  return {
    payment_session_id:
      typeof record.payment_session_id === 'string' ? record.payment_session_id : '',
    reference_id: typeof record.reference_id === 'string' ? record.reference_id : '',
    status: typeof record.status === 'string' ? record.status : '',
    amount: typeof record.amount === 'number' ? record.amount : null,
    currency: typeof record.currency === 'string' ? record.currency : null,
    payment_link_url: typeof record.payment_link_url === 'string' ? record.payment_link_url : null,
    expires_at: typeof record.expires_at === 'string' ? record.expires_at : null,
    payment_id: typeof record.payment_id === 'string' ? record.payment_id : null,
    metadata:
      typeof record.metadata === 'object' && record.metadata !== null
        ? (record.metadata as Record<string, unknown>)
        : null,
  }
}

/**
 * Create the session the buyer pays.
 *
 * Not yet on `xendit-node` (see the module header): the SDK exposes no
 * Payment Sessions surface, so this is the documented `/sessions` call over
 * the SDK's one host with the shop's secret key — the same Basic auth the SDK
 * uses internally.
 */
export async function createXenditSession(
  credentials: XenditCredentials,
  body: XenditCreateSessionRequest,
): Promise<XenditPaymentSession> {
  const response = await fetch(`${xenditApiBase()}/sessions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: xenditAuthHeader(credentials.secretKey),
    },
    body: JSON.stringify(body),
  })
  const parsed = await readXenditBody(response)
  if (!response.ok) throwForStatus('session creation', response, parsed)
  const session = toPaymentSession(parsed as Record<string, unknown>)
  if (session.payment_session_id === '') {
    throw new XenditApiError(
      response.status,
      'Xendit answered without a payment session id.',
      parsed,
    )
  }
  if (!session.payment_link_url) {
    throw new XenditApiError(response.status, 'Xendit answered without a payment link URL.', parsed)
  }
  return session
}

/**
 * Read a session back — what `refresh` and the webhook reconcile against.
 *
 * Looked up by the session id PayKit stored at charge time. Returns the
 * shaped session; `./transactions` decides what those bytes mean.
 */
export async function getXenditPaymentSession(
  credentials: XenditCredentials,
  sessionId: string,
): Promise<XenditPaymentSession> {
  const response = await fetch(`${xenditApiBase()}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: xenditAuthHeader(credentials.secretKey),
    },
  })
  const parsed = await readXenditBody(response)
  if (!response.ok) throwForStatus(`session ${sessionId}`, response, parsed)
  return toPaymentSession(parsed as Record<string, unknown>)
}

/* -------------------------------------------------------------------------- */
/* Legacy Invoices (read-only)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read a legacy `/v2/invoices` object back through the official SDK.
 *
 * Kept only so a charge created before the Payment Sessions migration can
 * still be reconciled from its callback. New charges never create invoices.
 * The SDK model is mapped onto the snake_case shape `./transactions` parses,
 * so the reconciliation rules stay transport-agnostic.
 */
export async function getXenditInvoice(
  credentials: XenditCredentials,
  invoiceId: string,
): Promise<unknown> {
  try {
    const invoice = await createXenditClient(credentials).Invoice.getInvoiceById({ invoiceId })
    return {
      id: invoice.id,
      external_id: invoice.externalId,
      status: invoice.status,
      amount: invoice.amount,
      payment_channel: invoice.paymentMethod ?? null,
    }
  } catch (error) {
    wrapXenditSdkError(error, `invoice ${invoiceId}`)
  }
}
