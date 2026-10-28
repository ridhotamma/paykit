/**
 * Inbound Xendit callback verification and event shaping.
 *
 * Xendit delivers both Payment Session webhooks (`payment_session.completed`
 * / `payment_session.expired`) and, for charges made before the Payment
 * Sessions migration, legacy invoice callbacks as `POST application/json`.
 * Either carries the account's webhook token in the `x-callback-token`
 * header — the same value the shop configures in its Xendit dashboard
 * (Settings → Webhooks); on PayKit it is stored per shop as the
 * `webhookToken` credential.
 *
 * Verification is timing-safe, so a wrong token is indistinguishable from a
 * missing one — both are authentication failures and should be answered
 * 401, not retried.
 */

import { z } from 'zod'

import { timingSafeEqual } from '../timing-safe'
import { WebhookAuthError } from '../webhook-auth'
import { xenditSessionSchema, type XenditSession } from './transactions'

/** The callback token header, lowercased — matched case-insensitively. */
export const XENDIT_CALLBACK_TOKEN_HEADER = 'x-callback-token'

/**
 * The fields every legacy invoice callback carries, regardless of outcome.
 *
 * `status` is accepted as any non-empty string rather than an enum:
 * `PAID`/`SETTLED` mean paid and `PENDING`/`EXPIRED` mean they do not, but
 * treating an unrecognised status as a malformed callback would drop a real
 * (and logged, and replayable) notification on the floor.
 */
export const xenditCallbackSchema = z.object({
  id: z.string().min(1),
  external_id: z.string().min(1).nullish(),
  status: z.string().min(1),
  amount: z.number().nullish(),
  paid_amount: z.number().nullish(),
  payment_channel: z.string().nullish(),
  payment_method: z.string().nullish(),
  paid_at: z.string().nullish(),
})

export type XenditCallback = z.infer<typeof xenditCallbackSchema>

/** Parse the legacy callback body. Returns `null` for a shape that is not an invoice callback. */
export function parseXenditCallback(payload: unknown): XenditCallback | null {
  const parsed = xenditCallbackSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/**
 * The Payment Session status webhook envelope.
 *
 * `data` is the same session shape `GET /sessions/{id}` answers, so one
 * schema reconciles both the delivered event and the read-back.
 */
export const xenditSessionWebhookSchema = z.object({
  event: z.enum(['payment_session.completed', 'payment_session.expired']),
  business_id: z.string().nullish(),
  created: z.string().nullish(),
  data: xenditSessionSchema,
})

export type XenditSessionWebhook = z.infer<typeof xenditSessionWebhookSchema>

/** The two callback generations PayKit understands. */
export type XenditWebhook =
  | { kind: 'session'; event: XenditSessionWebhook['event']; session: XenditSession }
  | { kind: 'invoice'; callback: XenditCallback }

/** Parse either callback generation. Returns `null` for a shape that is not a callback. */
export function parseXenditWebhook(payload: unknown): XenditWebhook | null {
  const session = xenditSessionWebhookSchema.safeParse(payload)
  if (session.success) {
    return { kind: 'session', event: session.data.event, session: session.data.data }
  }
  const callback = parseXenditCallback(payload)
  return callback ? { kind: 'invoice', callback } : null
}

/** Raised when the `x-callback-token` header is missing or does not match. */
export class XenditWebhookAuthError extends WebhookAuthError {
  constructor(message = 'Xendit callback token mismatch.') {
    super(message)
    this.name = 'XenditWebhookAuthError'
  }
}

/** Header shapes the extractor accepts, mirrored from the Mayar module. */
export type XenditCallbackHeaders =
  | Headers
  | Record<string, string | string[] | null | undefined>
  | ((name: string) => string | null | undefined)

/** Pull the callback token out of request headers, case-insensitively. */
export function xenditCallbackToken(headers: XenditCallbackHeaders): string | null {
  if (typeof headers === 'function') return headers(XENDIT_CALLBACK_TOKEN_HEADER) ?? null
  if (headers instanceof Headers) return headers.get(XENDIT_CALLBACK_TOKEN_HEADER)
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === XENDIT_CALLBACK_TOKEN_HEADER) {
      if (Array.isArray(value)) return value[0] ?? null
      return value ?? null
    }
  }
  return null
}

/**
 * Authenticate + parse an inbound Xendit callback in one step.
 *
 * @throws `XenditWebhookAuthError` when the token is missing or mismatched —
 * the transport layer answers 401. A body that is not a payment callback
 * after the token verified is a plain error: the bytes are ours to inspect,
 * not the sender's credential failure.
 */
export function verifyXenditCallback(
  headers: XenditCallbackHeaders,
  payload: unknown,
  webhookToken: string | null | undefined,
): XenditWebhook {
  if (!webhookToken) {
    throw new XenditWebhookAuthError('No Xendit webhook token is configured.')
  }
  const token = xenditCallbackToken(headers)
  if (!token || !timingSafeEqual(token, webhookToken)) {
    throw new XenditWebhookAuthError('Xendit callback token mismatch.')
  }
  const webhook = parseXenditWebhook(payload)
  if (!webhook) {
    throw new Error('Xendit callback body is not a payment callback.')
  }
  return webhook
}

/**
 * A paid callback — the only kind that moves money.
 *
 * Session events settle on `payment_session.completed`; legacy invoice
 * callbacks settle on `PAID`/`SETTLED`. Everything else is acknowledged
 * without touching orders: only the reconciled session/invoice (read back
 * through the API) settles.
 */
export function isXenditPaidWebhook(webhook: XenditWebhook): boolean {
  if (webhook.kind === 'session') return webhook.event === 'payment_session.completed'
  const status = webhook.callback.status.trim().toUpperCase()
  return status === 'PAID' || status === 'SETTLED'
}
