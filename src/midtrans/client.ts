/**
 * Midtrans client factory — the one place that turns a shop's stored
 * credentials into live Midtrans Snap calls.
 *
 * Server-only by contract: the server key moves money and must never reach
 * a browser bundle. That is why this module lives behind the
 * `paykit/midtrans` subpath and is never re-exported from the
 * main barrel — the admin UI imports the registry from `.`, servers import
 * the logic from `./midtrans`.
 *
 * The official `midtrans-client` SDK owns the two surfaces PayKit needs — a
 * Snap transaction create and a Core API transaction status read — so the
 * environment switch, Basic auth and hosts are the SDK's business. The
 * credential shape is mapped onto the SDK constructor here and nowhere else:
 * the registry's `environment` (`sandbox` | `production`) becomes the SDK's
 * `isProduction` boolean, and `clientKey` rides along so an embedded Snap
 * popup needs no second configuration.
 */

import midtransClient from 'midtrans-client'
import { z } from 'zod'

import { mergeCredentialBlobs } from '../credentials'

export class MidtransApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'MidtransApiError'
    this.status = status
    this.body = body
  }
}

/** The seller-readable line inside a Midtrans response body, if it carries one. */
function midtransBodyDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return typeof body === 'string' ? body.slice(0, 200) : ''
  }
  const record = body as Record<string, unknown>
  const messages = Array.isArray(record.error_messages) ? record.error_messages.join('; ') : ''
  return [record.status_message, messages]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' — ')
}

/**
 * A status code out of a raw `MidtransError`, as a number.
 *
 * The SDK copies whatever the API answered into `httpStatusCode`: the HTTP
 * transport's numeric status for a failed request, but the body's *string*
 * `status_code` when the API answered `200` with an error body (`"404"` for
 * "Transaction doesn't exist"). Both must normalize, or the adapter's
 * `instanceof MidtransApiError && status === 404` check never matches.
 */
export function midtransErrorStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * The SDK throws a `MidtransError` carrying `httpStatusCode` and the parsed
 * `ApiResponse`; wrap it in the local error type so callers can keep
 * branching on `instanceof MidtransApiError` (a 404 is "not created yet",
 * not a failure).
 */
function wrapMidtransSdkError(error: unknown, action: string): never {
  if (error && typeof error === 'object') {
    const candidate = error as {
      httpStatusCode?: unknown
      ApiResponse?: unknown
      message?: unknown
    }
    const status = midtransErrorStatus(candidate.httpStatusCode)
    if (status !== null) {
      const detail = midtransBodyDetail(candidate.ApiResponse)
      throw new MidtransApiError(
        status,
        `Midtrans ${action} failed (${status})${detail ? `: ${detail}` : ''}.`,
        candidate.ApiResponse,
      )
    }
  }
  throw error instanceof Error ? error : new Error(String(error))
}

export function describeMidtransError(error: unknown): string {
  if (error instanceof MidtransApiError) {
    const detail = midtransBodyDetail(error.body)
    return `Midtrans answered ${error.status}${detail ? `: ${detail}` : ''}.`
  }
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/** Which Midtrans deployment a key belongs to. */
export type MidtransEnvironment = 'sandbox' | 'production'

export const MIDTRANS_ENVIRONMENTS = ['sandbox', 'production'] as const

/**
 * The secrets and settings one shop's Midtrans connection needs.
 *
 * `serverKey` comes from the Midtrans dashboard → Settings → Access Keys
 * (one key per environment — sandbox and production are separate keys, hence
 * `environment`). `clientKey` is the public key from the same page: the
 * charge itself never sends it, but it is stored alongside so a storefront
 * can embed the Snap popup without a second round of configuration.
 * `merchantId` (the `G…`/`M…`/`A…` id on the same page) authenticates
 * nothing — the Server Key does — but when configured it double-checks that
 * an inbound notification belongs to this account. `environment` maps to the
 * SDK's `isProduction` flag and must match the account the keys belong to —
 * a production key verified against the sandbox host fails with 401, so an
 * unset value falls back to `sandbox` rather than to a guess.
 */
export const midtransCredentialsSchema = z.object({
  serverKey: z.string().trim().min(1, 'Midtrans Server Key is required.'),
  clientKey: z.string().trim().default(''),
  merchantId: z.string().trim().default(''),
  environment: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value === '' ? 'sandbox' : value))
    .pipe(z.enum(MIDTRANS_ENVIRONMENTS))
    .default('sandbox'),
})

export type MidtransCredentials = z.infer<typeof midtransCredentialsSchema>

export type MidtransCredentialsResult =
  { ok: true; credentials: MidtransCredentials } | { ok: false; error: string }

/**
 * Read a shop's Midtrans credentials out of its stored JSON blobs.
 *
 * A connection stores two JSON strings — `credentials` (the sealed secrets)
 * and `config` (the non-secrets) — so both are merged before validation, with
 * the credentials blob authoritative for any key it carries (see
 * `mergeCredentialBlobs`). Returns `ok: false` with a seller-readable reason
 * when the server key is missing or `environment` is not a known value; a
 * half-configured connection must fail loudly, not silently call the wrong
 * deployment.
 */
export function readMidtransCredentials(
  blobs: ReadonlyArray<Record<string, string | undefined> | null | undefined>,
): MidtransCredentialsResult {
  const merged = mergeCredentialBlobs(blobs)

  const parsed = midtransCredentialsSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `Midtrans credentials are not configured correctly (${problems}).` }
  }

  return { ok: true, credentials: parsed.data }
}

/* -------------------------------------------------------------------------- */
/* SDK clients                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The per-transaction notification URL header Midtrans documents. Snap
 * otherwise reads the Notification URL from the dashboard, which every
 * PayKit shop would have to configure by hand — the header lets the charge
 * point Midtrans straight at `/store/<slug>/midtrans` instead.
 * See docs.midtrans.com/reference/override-notification-url.
 */
export const MIDTRANS_NOTIFICATION_HEADER = 'X-Override-Notification'

/** The SDK surfaces PayKit uses, typed locally.
 *
 * `@types/midtrans-client` only declares `createTransaction` and the Core
 * `charge`, while the runtime objects also carry the shared `transaction`
 * helper and the Axios wrapper. Declaring the slice we call keeps both the
 * SDK and the local builders strongly typed without forking the SDK's types.
 */
interface MidtransTransactionApi {
  status(orderId: string): Promise<unknown>
}

interface MidtransHttpClient {
  http_client: {
    defaults: {
      headers: {
        common: Record<string, string>
      }
    }
  }
}

export interface MidtransSnapClient {
  createTransaction(
    parameter: MidtransSnapRequest,
  ): Promise<{ token?: unknown; redirect_url?: unknown }>
  transaction: MidtransTransactionApi
  httpClient: MidtransHttpClient
}

export interface MidtransCoreClient {
  transaction: MidtransTransactionApi
}

/** The Snap client for one shop's deployment — hosts and auth are the SDK's. */
export function createMidtransSnapClient(credentials: MidtransCredentials): MidtransSnapClient {
  return new midtransClient.Snap({
    isProduction: credentials.environment === 'production',
    serverKey: credentials.serverKey,
    clientKey: credentials.clientKey,
  }) as unknown as MidtransSnapClient
}

/** The Core API client for the status read — same credentials, same deployment. */
export function createMidtransCoreClient(credentials: MidtransCredentials): MidtransCoreClient {
  return new midtransClient.CoreApi({
    isProduction: credentials.environment === 'production',
    serverKey: credentials.serverKey,
    clientKey: credentials.clientKey,
  }) as unknown as MidtransCoreClient
}

/* -------------------------------------------------------------------------- */
/* Snap                                                                       */
/* -------------------------------------------------------------------------- */

/** One line of the Snap `item_details` breakdown. */
export interface MidtransItemDetail {
  id: string
  price: number
  quantity: number
  name: string
}

/** The Snap `POST /snap/v1/transactions` request body, as `./charge` builds it. */
export interface MidtransSnapRequest {
  transaction_details: {
    /** The PayKit `orderNumber` — the contract the webhook handler settles on. */
    order_id: string
    /** Integer IDR — the only amount ever charged is the order's remaining balance. */
    gross_amount: number
  }
  item_details?: MidtransItemDetail[]
  customer_details?: {
    first_name: string
    email?: string
    phone?: string
  }
  /** Restrict the Snap payment list to these types; omitted means every active type. */
  enabled_payments?: string[]
  expiry?: {
    /** `YYYY-MM-DD HH:mm:ss +0700` — Midtrans counts from this instant. */
    start_time: string
    unit: 'minute'
    duration: number
  }
  callbacks?: {
    /** Where Snap sends the buyer after a successful payment. */
    finish?: string
    /** Where Snap sends the buyer after a failed payment attempt. */
    error?: string
  }
}

export interface MidtransSnapResponse {
  token: string
  redirect_url: string
}

export interface CreateMidtransSnapOptions {
  /**
   * The shop's callback URL, attached as `X-Override-Notification` so Snap
   * sends the HTTP notification to PayKit regardless of the dashboard's
   * Notification URL setting.
   */
  notificationUrl?: string | null
}

/**
 * Create the Snap transaction the buyer pays — the hosted-checkout equivalent
 * of an invoice.
 *
 * When a `notificationUrl` is given it rides along as the documented
 * `X-Override-Notification` header, so the seller never has to paste the URL
 * into their dashboard for the webhook to arrive (the registry hint keeps the
 * dashboard entry as a fallback for transactions created outside PayKit).
 */
export async function createMidtransSnapTransaction(
  credentials: MidtransCredentials,
  body: MidtransSnapRequest,
  options: CreateMidtransSnapOptions = {},
): Promise<MidtransSnapResponse> {
  let parsed: Record<string, unknown>
  try {
    const snap = createMidtransSnapClient(credentials)
    const notificationUrl = options.notificationUrl?.trim()
    if (notificationUrl) {
      snap.httpClient.http_client.defaults.headers.common[MIDTRANS_NOTIFICATION_HEADER] =
        notificationUrl
    }
    parsed = (await snap.createTransaction(body)) as Record<string, unknown>
  } catch (error) {
    wrapMidtransSdkError(error, 'Snap transaction')
  }
  if (typeof parsed.token !== 'string' || parsed.token === '') {
    throw new MidtransApiError(200, 'Midtrans answered without a Snap token.', parsed)
  }
  if (typeof parsed.redirect_url !== 'string' || parsed.redirect_url === '') {
    throw new MidtransApiError(200, 'Midtrans answered without a Snap redirect URL.', parsed)
  }
  return { token: parsed.token, redirect_url: parsed.redirect_url }
}

/* -------------------------------------------------------------------------- */
/* Transaction status                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Read a transaction back — what `refresh` and the webhook reconcile against.
 *
 * Looked up by `order_id` (our order number), not by the Snap token: the
 * token identifies the checkout session, the order id identifies the money.
 * Returns the raw body; `./transactions` decides what those bytes mean.
 */
export async function getMidtransTransactionStatus(
  credentials: MidtransCredentials,
  orderId: string,
  /**
   * Injected in tests only.
   *
   * The alternative was mocking the whole `midtrans-client` module, which Bun
   * shares across every test file in a run — the mock leaked into other files
   * and made them depend on execution order. A seam costs one default
   * parameter and keeps the SDK out of the test process entirely.
   */
  createClient: (credentials: MidtransCredentials) => MidtransCoreClient = createMidtransCoreClient,
): Promise<unknown> {
  try {
    return await createClient(credentials).transaction.status(orderId)
  } catch (error) {
    wrapMidtransSdkError(error, `status for ${orderId}`)
  }
}
