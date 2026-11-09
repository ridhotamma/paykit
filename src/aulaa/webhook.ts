/**
 * Inbound Aulaa webhook verification and event shaping.
 *
 * Aulaa POSTs a flat JSON body when a payment changes state and signs the
 * **raw body** with the project's Webhook Secret:
 *
 *   `X-Webhook-Signature: hex(HMAC-SHA256(rawBody, webhookSecret))`
 *
 * There is no `sha256=` prefix. The signature is recomputed on Web Crypto and
 * compared in constant time — the URL carries no secret, so this is the
 * primary proof that the callback is real.
 *
 * The payload names the merchant `order_id` rather than Aulaa's invoice id.
 * Webhook handlers resolve the order on that, then reconcile through
 * `getAulaaPayment` with the stored invoice id before moving money.
 */

import { z } from 'zod'

import { timingSafeEqual } from '../timing-safe'
import { WebhookAuthError } from '../webhook-auth'

/** The header carrying the hex HMAC-SHA256 of the raw body. */
export const AULAA_WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature'

export const aulaaWebhookPayloadSchema = z.object({
  order_id: z.string().min(1),
  /** Full rupiah — the order's nominal amount, not the fee-inclusive charge. */
  amount: z.number().int(),
  currency: z.string().min(1).optional(),
  country_code: z.string().min(1).optional(),
  /** `paid` or `expired` in normal use; other terminal states are possible. */
  status: z.string().min(1),
  payment_method: z.string().nullish(),
  formatted_amount: z.string().optional(),
  paid_at: z.string().nullish(),
})

export type AulaaWebhookPayload = z.infer<typeof aulaaWebhookPayloadSchema>

/** Parse an already-decoded callback body. Returns `null` for an unrelated shape. */
export function parseAulaaWebhookPayload(payload: unknown): AulaaWebhookPayload | null {
  const parsed = aulaaWebhookPayloadSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/** Raised when the signature is missing, mismatched, or the body is unreadable. */
export class AulaaWebhookAuthError extends WebhookAuthError {
  constructor(message = 'Aulaa webhook signature mismatch.') {
    super(message)
    this.name = 'AulaaWebhookAuthError'
  }
}

/** The raw body shapes an HTTP layer may hand over. */
export type AulaaRawWebhookBody = string | Uint8Array | ArrayBuffer

function rawBodyBytes(rawBody: AulaaRawWebhookBody): Uint8Array<ArrayBuffer> {
  if (typeof rawBody === 'string') return new TextEncoder().encode(rawBody)
  // Copy into a fresh ArrayBuffer-backed view: Web Crypto's BufferSource type
  // rejects a view whose buffer could be a SharedArrayBuffer.
  if (rawBody instanceof Uint8Array) return new Uint8Array(rawBody)
  return new Uint8Array(rawBody)
}

async function hmacSha256Hex(secret: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, bytes)
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The exact signature Aulaa sends for this raw body, as lowercase hex.
 *
 * Exported for tests and for hosts that log the expected value while
 * debugging; production code should normally call `verifyAulaaCallback`.
 */
export async function aulaaWebhookSignature(
  rawBody: AulaaRawWebhookBody,
  webhookSecret: string | null | undefined,
): Promise<string> {
  if (!webhookSecret) throw new AulaaWebhookAuthError('No Aulaa webhook secret is configured.')
  return hmacSha256Hex(webhookSecret, rawBodyBytes(rawBody))
}

/**
 * Authenticate + parse an inbound Aulaa callback in one step.
 *
 * The signature is computed over the bytes the provider sent, so pass the raw
 * request body — not a re-serialised object. A body that cannot be parsed as
 * an Aulaa payment notification is rejected as well.
 *
 * @throws `AulaaWebhookAuthError` when the secret, header, signature or body
 * shape is unusable — the transport layer answers 401.
 */
export async function verifyAulaaCallback(
  rawBody: AulaaRawWebhookBody,
  signature: string | null | undefined,
  webhookSecret: string | null | undefined,
): Promise<AulaaWebhookPayload> {
  if (!webhookSecret) {
    throw new AulaaWebhookAuthError('No Aulaa webhook secret is configured.')
  }
  const delivered = signature?.trim().toLowerCase() ?? ''
  if (!delivered) {
    throw new AulaaWebhookAuthError('Aulaa webhook signature header is missing.')
  }

  const expected = await hmacSha256Hex(webhookSecret, rawBodyBytes(rawBody))
  if (!timingSafeEqual(expected, delivered)) {
    throw new AulaaWebhookAuthError('Aulaa webhook signature mismatch.')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(rawBodyBytes(rawBody)))
  } catch {
    throw new AulaaWebhookAuthError('Aulaa webhook body is not valid JSON.')
  }

  const payload = parseAulaaWebhookPayload(decoded)
  if (!payload) {
    throw new AulaaWebhookAuthError('Aulaa webhook body is not a payment notification.')
  }
  return payload
}

/** True when the notification reports a completed payment. */
export function isAulaaPaidWebhook(payload: AulaaWebhookPayload): boolean {
  return payload.status.trim().toLowerCase() === 'paid'
}

/** The merchant order id a callback names — the key a handler resolves on. */
export function aulaaOrderIdFromWebhook(payload: AulaaWebhookPayload): string {
  return payload.order_id
}
