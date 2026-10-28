/**
 * PayPal client factory — the one place that turns a shop's stored
 * credentials into live PayPal REST calls.
 *
 * Server-only by contract: the client secret moves money and must never
 * reach a browser bundle. That is why this module lives behind the
 * `@repo/integrations/paypal` subpath and is never re-exported from the main
 * barrel — the admin UI imports the registry from `.`, servers import the
 * logic from `./paypal`.
 *
 * The official `@paypal/paypal-server-sdk` owns Orders v2 (create / show /
 * capture) and the client-credentials token; its generated models are mapped
 * onto the snake_case shapes `./charge` and `./transactions` already speak,
 * so the pure builders and the money planner stay transport-agnostic. The SDK
 * has no webhook-signature controller, so that one call stays a direct `POST
 * /v1/notifications/verify-webhook-signature` authenticated with the SDK's
 * own token — verified server-to-server, never from the headers alone.
 */

import {
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type LinkDescription,
  type Order as PaypalSdkOrder,
  type OrderRequest,
} from '@paypal/paypal-server-sdk'
import { z } from 'zod'

import { mergeCredentialBlobs } from '../credentials'

export class PaypalApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'PaypalApiError'
    this.status = status
    this.body = body
  }
}

export class PaypalConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaypalConfigError'
  }
}

/** The seller-readable line inside a PayPal error body, if it carries one. */
function paypalBodyDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return typeof body === 'string' ? body.slice(0, 200) : ''
  }
  const record = body as Record<string, unknown>
  return String(record.message ?? record.error_description ?? record.error ?? record.name ?? '')
}

/** Wrap an SDK failure into the local error type, passing our own through. */
function wrapPaypalSdkError(error: unknown, action: string): never {
  if (error instanceof PaypalApiError || error instanceof PaypalConfigError) throw error
  if (error && typeof error === 'object') {
    const candidate = error as {
      statusCode?: unknown
      body?: unknown
      result?: unknown
    }
    if (typeof candidate.statusCode === 'number') {
      const body = candidate.result ?? candidate.body
      const detail = paypalBodyDetail(body)
      throw new PaypalApiError(
        candidate.statusCode,
        `PayPal ${action} failed (${candidate.statusCode})${detail ? `: ${detail}` : ''}.`,
        body,
      )
    }
  }
  throw error instanceof Error ? error : new Error(String(error))
}

export function describePaypalError(error: unknown): string {
  if (error instanceof PaypalApiError) {
    const detail = paypalBodyDetail(error.body)
    return `PayPal answered ${error.status}${detail ? `: ${detail}` : ''}.`
  }
  if (error instanceof PaypalConfigError) return `PayPal: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which PayPal deployment a REST app belongs to.
 *
 * PayPal names them `sandbox` and `live` (not `production`); the SDK spells
 * the live deployment `Environment.Production`, so the one translation lives
 * in `createPaypalClients`. A live secret verified against the sandbox host
 * fails with 401, so an unset value falls back to `sandbox` rather than to a
 * guess.
 */
export const PAYPAL_ENVIRONMENTS = ['sandbox', 'live'] as const

export type PaypalEnvironment = (typeof PAYPAL_ENVIRONMENTS)[number]

/**
 * The transaction currencies PayPal settles in.
 *
 * PayPal only moves money in this list — IDR is notably absent, so a shop
 * charging in rupiah cannot use PayPal at all. Validating here means a
 * half-configured connection fails at read time with a seller-readable
 * error instead of being accepted and later rejected by the PayPal API
 * (or worse, formatted as a different currency — see `./charge`).
 */
export const PAYPAL_SUPPORTED_CURRENCIES = [
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'RUB',
  'SEK',
  'SGD',
  'THB',
  'TWD',
  'USD',
] as const

export type PaypalSupportedCurrency = (typeof PAYPAL_SUPPORTED_CURRENCIES)[number]

/**
 * The secrets and settings one shop's PayPal connection needs.
 *
 * `clientId` + `clientSecret` come from developer.paypal.com → the shop's
 * REST app (one app per shop — sandbox and live are separate apps with
 * separate pairs, hence `environment`). `currency` is the ISO code the
 * PayPal order is created in and **must equal the shop's own currency**:
 * the adapter formats the stored minor-unit amount with that currency's
 * decimals, so a mismatch silently charges the wrong amount (see
 * `./charge`). `webhookId` is the REST app's webhook id — required only
 * for verifying inbound callbacks, never for charging.
 */
export const paypalCredentialsSchema = z.object({
  clientId: z.string().trim().min(1, 'PayPal Client ID is required.'),
  clientSecret: z.string().trim().min(1, 'PayPal Client Secret is required.'),
  environment: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value === '' ? 'sandbox' : value))
    .pipe(z.enum(PAYPAL_ENVIRONMENTS))
    .default('sandbox'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code.')
    .refine(
      (value): value is PaypalSupportedCurrency =>
        (PAYPAL_SUPPORTED_CURRENCIES as readonly string[]).includes(value),
      'PayPal does not support this currency (IDR is not a PayPal currency).',
    )
    .default('USD'),
  webhookId: z.string().trim().default(''),
})

export type PaypalCredentials = z.infer<typeof paypalCredentialsSchema>

export type PaypalCredentialsResult =
  { ok: true; credentials: PaypalCredentials } | { ok: false; error: string }

/**
 * Read a shop's PayPal credentials out of its stored JSON blobs.
 *
 * A connection stores two JSON strings — `credentials` (the sealed secrets)
 * and `config` (the non-secrets) — so both are merged before validation, with
 * the credentials blob authoritative for any key it carries (see
 * `mergeCredentialBlobs`). Returns `ok: false` with a seller-readable reason
 * when the pair is missing or `environment` is not a known value; a
 * half-configured connection must fail loudly, not silently call the wrong
 * deployment.
 */
export function readPaypalCredentials(
  blobs: ReadonlyArray<Record<string, string | undefined> | null | undefined>,
): PaypalCredentialsResult {
  const merged = mergeCredentialBlobs(blobs)

  const parsed = paypalCredentialsSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `PayPal credentials are not configured correctly (${problems}).` }
  }

  return { ok: true, credentials: parsed.data }
}

/** The REST host for one shop's PayPal deployment. */
export function paypalApiBase(environment: PaypalEnvironment): string {
  return environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
}

/* -------------------------------------------------------------------------- */
/* SDK clients                                                                */
/* -------------------------------------------------------------------------- */

export interface PaypalClients {
  client: Client
  orders: OrdersController
}

/**
 * The official SDK clients for one shop's REST app.
 *
 * Cheap to build per request and never shared across shops: the SDK holds
 * the client-credentials auth per instance, so one tenant's token can never
 * ride another tenant's charge.
 */
export function createPaypalClients(credentials: PaypalCredentials): PaypalClients {
  const client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: credentials.clientId,
      oAuthClientSecret: credentials.clientSecret,
    },
    environment: credentials.environment === 'live' ? Environment.Production : Environment.Sandbox,
  })
  return { client, orders: new OrdersController(client) }
}

/**
 * A bearer token for the REST app, via the SDK's client-credentials manager.
 *
 * Fetched per call on purpose: caching it here would mean a cache (and its
 * invalidation) shared across the webhook app, the admin charge flow and the
 * storefront — a stale-token retry is cheaper than that coordination. The
 * only raw caller left is webhook signature verification, which the SDK has
 * no controller for.
 */
export async function getPaypalAccessToken(credentials: PaypalCredentials): Promise<string> {
  try {
    const token =
      await createPaypalClients(credentials).client.clientCredentialsAuthManager.fetchToken()
    if (!token.accessToken) {
      throw new PaypalApiError(200, 'PayPal answered without an access token.')
    }
    return token.accessToken
  } catch (error) {
    wrapPaypalSdkError(error, 'token request')
  }
}

/* -------------------------------------------------------------------------- */
/* Orders v2                                                                  */
/* -------------------------------------------------------------------------- */

/** One link of PayPal's HATEOAS envelope — the approve URL lives here. */
export interface PaypalLink {
  href: string
  rel: string
  method?: string
}

export interface PaypalOrderResponse {
  id: string
  status: string
  links?: PaypalLink[]
  [key: string]: unknown
}

export interface CreatePaypalOrderBody {
  intent: 'CAPTURE'
  purchase_units: Array<{
    reference_id: string
    custom_id: string
    description: string
    invoice_id: string
    amount: { currency_code: string; value: string }
  }>
  /**
   * The PayPal Wallet experience. Orders v2 deprecated the top-level
   * `application_context`; the redirect URLs, brand and shipping rules now
   * live in `payment_source.paypal.experience_context`.
   */
  payment_source: {
    paypal: {
      experience_context: {
        brand_name?: string
        return_url: string
        cancel_url: string
        shipping_preference: 'NO_SHIPPING'
        user_action: 'PAY_NOW'
      }
    }
  }
}

/** The snake_case request body as the SDK's camelCase `OrderRequest`. */
function toOrderRequest(body: CreatePaypalOrderBody): OrderRequest {
  return {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: body.purchase_units.map((unit) => ({
      referenceId: unit.reference_id,
      customId: unit.custom_id,
      description: unit.description,
      invoiceId: unit.invoice_id,
      amount: { currencyCode: unit.amount.currency_code, value: unit.amount.value },
    })),
    paymentSource: {
      paypal: {
        experienceContext: {
          ...(body.payment_source.paypal.experience_context.brand_name
            ? { brandName: body.payment_source.paypal.experience_context.brand_name }
            : {}),
          returnUrl: body.payment_source.paypal.experience_context.return_url,
          cancelUrl: body.payment_source.paypal.experience_context.cancel_url,
          shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
          userAction: PaypalExperienceUserAction.PayNow,
        },
      },
    },
  }
}

function toPaypalLink(link: LinkDescription): PaypalLink {
  return { href: link.href, rel: link.rel, method: link.method }
}

/**
 * The SDK order mapped onto the raw snake_case shape the pure readers parse:
 * `./transactions` walks `purchase_units[].payments.captures[]`, so the wire
 * spelling is kept deliberately.
 */
function toPaypalOrderResponse(order: PaypalSdkOrder): PaypalOrderResponse {
  return {
    id: order.id ?? '',
    status: order.status ?? '',
    links: (order.links ?? []).map(toPaypalLink),
    purchase_units: (order.purchaseUnits ?? []).map((unit) => ({
      reference_id: unit.referenceId ?? null,
      custom_id: unit.customId ?? null,
      invoice_id: unit.invoiceId ?? null,
      payments: {
        captures: (unit.payments?.captures ?? []).map((capture) => ({
          id: capture.id ?? '',
          status: capture.status ?? '',
          amount: {
            currency_code: capture.amount?.currencyCode ?? '',
            value: capture.amount?.value ?? '',
          },
          custom_id: capture.customId ?? null,
          invoice_id: capture.invoiceId ?? null,
        })),
      },
    })),
  }
}

/**
 * Create the order the buyer approves — the custom-UI equivalent of an
 * invoice.
 *
 * `prefer: return=representation` is sent because the caller reads the
 * approval link (and later the captures) straight off this answer.
 */
export async function createPaypalOrder(
  credentials: PaypalCredentials,
  body: CreatePaypalOrderBody,
  requestId?: string,
): Promise<PaypalOrderResponse> {
  try {
    const response = await createPaypalClients(credentials).orders.createOrder({
      body: toOrderRequest(body),
      // The idempotency key for this charge attempt: a retried create (double
      // tap, a lost response) returns the same order, while a re-charge uses a
      // fresh one — see `paypalRequestId` in `./charge`.
      paypalRequestId:
        requestId?.trim() || `paykit-${body.purchase_units[0]?.reference_id ?? 'order'}`,
      prefer: 'return=representation',
    })
    const order = response.result
    if (!order.id) {
      throw new PaypalApiError(response.statusCode, 'PayPal answered without an order id.', order)
    }
    return toPaypalOrderResponse(order)
  } catch (error) {
    wrapPaypalSdkError(error, 'order creation')
  }
}

/** Read an order back — what `refresh` and the webhook reconcile against. */
export async function showPaypalOrder(
  credentials: PaypalCredentials,
  orderId: string,
): Promise<PaypalOrderResponse> {
  try {
    const response = await createPaypalClients(credentials).orders.getOrder({ id: orderId })
    return toPaypalOrderResponse(response.result)
  } catch (error) {
    wrapPaypalSdkError(error, `order ${orderId}`)
  }
}

/**
 * Capture an approved order — moves `APPROVED` to `COMPLETED`.
 *
 * Called from `refresh` (the buyer approved on PayPal and landed back) and
 * from the Card Fields submit flow after `cardSession.submit()` succeeds.
 * Empty body: the amount was fixed at creation, so there is nothing to pass.
 */
export async function capturePaypalOrder(
  credentials: PaypalCredentials,
  orderId: string,
): Promise<PaypalOrderResponse> {
  try {
    const response = await createPaypalClients(credentials).orders.captureOrder({
      id: orderId,
      prefer: 'return=representation',
    })
    return toPaypalOrderResponse(response.result)
  } catch (error) {
    wrapPaypalSdkError(error, `capture for ${orderId}`)
  }
}

/* -------------------------------------------------------------------------- */
/* Webhook signature verification                                             */
/* -------------------------------------------------------------------------- */

export interface PaypalVerifySignatureBody {
  transmission_id: string
  transmission_time: string
  cert_url: string
  auth_algo: string
  transmission_sig: string
  webhook_id: string
  webhook_event: unknown
}

/**
 * Ask PayPal whether the callback really came from PayPal.
 *
 * The SDK ships no webhook-signature controller, so this stays the documented
 * server-to-server `POST /v1/notifications/verify-webhook-signature`; the
 * token comes from the SDK's client-credentials manager, so no extra secret
 * is needed. The delivery is only trusted when `verification_status` answers
 * `SUCCESS` — the headers alone prove nothing, since anyone can POST them.
 * Needs the REST app's `webhookId`: without it there is nothing to verify
 * against, so the caller must fail closed (401), never accept-and-log.
 */
export async function verifyPaypalWebhookSignature(
  credentials: PaypalCredentials,
  accessToken: string,
  body: PaypalVerifySignatureBody,
): Promise<boolean> {
  const response = await fetch(
    `${paypalApiBase(credentials.environment)}/v1/notifications/verify-webhook-signature`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
  const text = await response.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      parsed = text
    }
  }
  if (!response.ok) {
    throw new PaypalApiError(
      response.status,
      `PayPal webhook verification failed (${response.status})${paypalBodyDetail(parsed) ? `: ${paypalBodyDetail(parsed)}` : ''}.`,
      parsed,
    )
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as Record<string, unknown>).verification_status === 'SUCCESS'
  )
}
