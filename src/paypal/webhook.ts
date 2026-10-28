/**
 * Inbound PayPal webhook verification and event shaping.
 *
 * PayPal delivers callbacks as `POST application/json` with the signature in
 * five headers (`paypal-transmission-id`, `paypal-transmission-time`,
 * `paypal-cert-url`, `paypal-auth-algo`, `paypal-transmission-sig`). Unlike
 * Mayar's shared token, these prove nothing by themselves — anyone can POST
 * them — so verification is a server-to-server call:
 * `POST /v1/notifications/verify-webhook-signature` with the shop's own
 * secret answers `SUCCESS` or it did not come from PayPal.
 *
 * Verification needs the REST app's `webhookId`: without one configured the
 * handler must fail closed (401), never accept-and-log. The token for the
 * verify call comes from the same client credentials — no extra secrets.
 */

import { z } from 'zod'

import { WebhookAuthError } from '../webhook-auth'
import {
  getPaypalAccessToken,
  verifyPaypalWebhookSignature,
  type PaypalCredentials,
} from './client'

/** Header shapes the extractor accepts, mirrored from the Mayar module. */
export type PaypalCallbackHeaders =
  | Headers
  | Record<string, string | string[] | null | undefined>
  | ((name: string) => string | null | undefined)

function readHeader(headers: PaypalCallbackHeaders, name: string): string | null {
  if (typeof headers === 'function') return headers(name) ?? null
  if (headers instanceof Headers) return headers.get(name)
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      if (Array.isArray(value)) return value[0] ?? null
      return value ?? null
    }
  }
  return null
}

/** Raised when the signature is missing, mismatched, or unverifiable. */
export class PaypalWebhookAuthError extends WebhookAuthError {
  constructor(message = 'PayPal webhook signature mismatch.') {
    super(message)
    this.name = 'PaypalWebhookAuthError'
  }
}

export interface PaypalSignatureHeaders {
  transmissionId: string
  transmissionTime: string
  certUrl: string
  authAlgo: string
  transmissionSig: string
}

/** Pull the five signature headers out of the request, case-insensitively. */
export function paypalSignatureHeaders(
  headers: PaypalCallbackHeaders,
): PaypalSignatureHeaders | null {
  const transmissionId = readHeader(headers, 'paypal-transmission-id')?.trim() ?? ''
  const transmissionTime = readHeader(headers, 'paypal-transmission-time')?.trim() ?? ''
  const certUrl = readHeader(headers, 'paypal-cert-url')?.trim() ?? ''
  const authAlgo = readHeader(headers, 'paypal-auth-algo')?.trim() ?? ''
  const transmissionSig = readHeader(headers, 'paypal-transmission-sig')?.trim() ?? ''
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return null
  }
  return { transmissionId, transmissionTime, certUrl, authAlgo, transmissionSig }
}

const paypalWebhookEventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.unknown(),
})

export type PaypalWebhookEvent = z.infer<typeof paypalWebhookEventSchema> & {
  resource: unknown
}

/** Parse the envelope. Returns `null` for a shape that is not an event at all. */
export function parsePaypalWebhookEvent(payload: unknown): PaypalWebhookEvent | null {
  const parsed = paypalWebhookEventSchema.safeParse(payload)
  return parsed.success ? { ...parsed.data, resource: parsed.data.resource } : null
}

/**
 * Authenticate an inbound PayPal callback.
 *
 * @throws `PaypalWebhookAuthError` when the headers are incomplete, no
 * `webhookId` is configured, or PayPal does not answer `SUCCESS` — the
 * transport layer answers 401.
 */
export async function verifyPaypalCallback(
  headers: PaypalCallbackHeaders,
  payload: unknown,
  credentials: PaypalCredentials,
): Promise<PaypalWebhookEvent> {
  const signature = paypalSignatureHeaders(headers)
  if (!signature) {
    throw new PaypalWebhookAuthError('PayPal webhook is missing its signature headers.')
  }
  if (!credentials.webhookId) {
    throw new PaypalWebhookAuthError('No PayPal webhook ID is configured.')
  }
  const event = parsePaypalWebhookEvent(payload)
  if (!event) throw new PaypalWebhookAuthError('PayPal webhook body is not an event.')

  const accessToken = await getPaypalAccessToken(credentials)
  const verified = await verifyPaypalWebhookSignature(credentials, accessToken, {
    transmission_id: signature.transmissionId,
    transmission_time: signature.transmissionTime,
    cert_url: signature.certUrl,
    auth_algo: signature.authAlgo,
    transmission_sig: signature.transmissionSig,
    webhook_id: credentials.webhookId,
    webhook_event: payload,
  })
  if (!verified) throw new PaypalWebhookAuthError('PayPal webhook signature mismatch.')
  return event
}

/**
 * A capture-completed event — money already taken.
 *
 * `CHECKOUT.ORDER.APPROVED` is not paid either: approval is not payment.
 * PayPal does not capture by itself, and the buyer's return may never reach
 * us, so the webhook handler captures an approved order itself and settles
 * from the capture the API answers with. Refunds, disputes and billing plans
 * are likewise verified but inert.
 */
export function isPaypalPaidEvent(event: PaypalWebhookEvent): boolean {
  return event.event_type === 'PAYMENT.CAPTURE.COMPLETED'
}

/**
 * The PayPal order id a `CHECKOUT.ORDER.APPROVED` resource names.
 *
 * The approval event's resource is the checkout order itself, so its `id` is
 * what the capture is made against. `null` for any other shape.
 */
export function paypalCheckoutOrderId(raw: unknown): string | null {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(raw)
  return parsed.success ? parsed.data.id : null
}
