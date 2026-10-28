/**
 * Inbound Midtrans notification verification and event shaping.
 *
 * Midtrans POSTs the outcome of a transaction as `application/json`, signed
 * with a plain SHA-512 digest: `signature_key` is
 * `hex(SHA512(order_id + status_code + gross_amount + serverKey))`. The
 * digest is recomputed with the *shop's own* server key and compared in
 * constant time — the URL carries no secret, so this signature is the
 * primary proof the notification is real.
 *
 * The digest runs on Web Crypto rather than `node:crypto` so this module
 * never pulls a Node builtin into a bundle: `crypto.subtle` is available in
 * every runtime the server code runs on.
 */

import { z } from 'zod'

import { timingSafeEqual } from '../timing-safe'
import { WebhookAuthError } from '../webhook-auth'

/**
 * The fields every Midtrans payment notification carries, regardless of
 * outcome. `gross_amount` and `status_code` stay strings here — they are
 * signature inputs first, amounts second, and any normalisation would break
 * the digest before it is checked.
 */
export const midtransNotificationSchema = z.object({
  order_id: z.string().min(1),
  status_code: z.string().min(1),
  gross_amount: z.string().min(1),
  signature_key: z.string().min(1),
  transaction_status: z.string().min(1),
  transaction_id: z.string().min(1).nullish(),
  payment_type: z.string().nullish(),
  fraud_status: z.string().nullish(),
  /**
   * The account the transaction belongs to. Authenticates nothing — the
   * signature does — but when the shop stored its Merchant ID it is a second
   * check that the notification is for this connection's account.
   */
  merchant_id: z.string().nullish(),
})

export type MidtransNotification = z.infer<typeof midtransNotificationSchema>

/** Parse the notification body. Returns `null` for a shape that is not a notification at all. */
export function parseMidtransNotification(payload: unknown): MidtransNotification | null {
  const parsed = midtransNotificationSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/** Raised when the signature is missing, mismatched, or unverifiable. */
export class MidtransWebhookAuthError extends WebhookAuthError {
  constructor(message = 'Midtrans notification signature mismatch.') {
    super(message)
    this.name = 'MidtransWebhookAuthError'
  }
}

async function sha512Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-512', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Recompute the notification digest with the shop's server key and compare
 * it against the delivered `signature_key` in constant time.
 *
 * Pure function of the notification and the key — no network, so the
 * caller verifies first and only then reconciles against the status API.
 */
export async function verifyMidtransSignature(
  notification: Pick<
    MidtransNotification,
    'order_id' | 'status_code' | 'gross_amount' | 'signature_key'
  >,
  serverKey: string | null | undefined,
): Promise<boolean> {
  if (!serverKey) return false
  const expected = await sha512Hex(
    `${notification.order_id}${notification.status_code}${notification.gross_amount}${serverKey}`,
  )
  return timingSafeEqual(expected, notification.signature_key.trim().toLowerCase())
}

/**
 * Authenticate an inbound Midtrans notification's shape and signature.
 *
 * When `merchantId` is configured, a notification that names a *different*
 * Merchant ID is rejected too: the signature already proves the Server Key,
 * and the id proves the delivery belongs to the account the shop stored. A
 * notification that carries no `merchant_id` is still accepted — the
 * signature is the gate, and an unfamiliar shape must not drop a real
 * payment.
 *
 * @throws `MidtransWebhookAuthError` when the body is not a notification,
 * the signature does not verify, or the Merchant ID does not match — the
 * transport layer answers 401.
 */
export async function verifyMidtransNotification(
  payload: unknown,
  serverKey: string | null | undefined,
  merchantId?: string | null,
): Promise<MidtransNotification> {
  const notification = parseMidtransNotification(payload)
  if (!notification) {
    throw new MidtransWebhookAuthError('Midtrans notification body is not a payment notification.')
  }
  if (!serverKey) {
    throw new MidtransWebhookAuthError('No Midtrans server key is configured.')
  }
  const valid = await verifyMidtransSignature(notification, serverKey)
  if (!valid) throw new MidtransWebhookAuthError('Midtrans notification signature mismatch.')
  const configured = merchantId?.trim() ?? ''
  const delivered = notification.merchant_id?.trim() ?? ''
  if (configured !== '' && delivered !== '' && configured !== delivered) {
    throw new MidtransWebhookAuthError('Midtrans notification merchant ID mismatch.')
  }
  return notification
}
