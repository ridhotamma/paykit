/**
 * Inbound Mayar webhook verification and event shaping.
 *
 * Mayar delivers callbacks as `POST application/json` with the account's
 * callback token in the `x-callback-token` header. The token is the same
 * value the shop configures in its Mayar dashboard (Integration → Webhook);
 * on PayKit it is stored per shop as the `webhookSecret` credential.
 *
 * Verification is timing-safe (the SDK SHA-256 hashes both sides before
 * comparing), so a wrong token is indistinguishable from a missing one —
 * both are authentication failures and should be answered 401, not retried.
 */

import {
  CALLBACK_TOKEN_HEADER,
  WebhookAuthError as MayarSdkWebhookAuthError,
  extractCallbackToken,
  parseWebhookEvent,
  verifyWebhookRequest,
  type Mayar,
  type MayarWebhookPayload,
} from 'mayar-node-sdk'

import { WebhookAuthError } from '../webhook-auth'

export { CALLBACK_TOKEN_HEADER, parseWebhookEvent, WebhookAuthError }
export type { MayarWebhookPayload }

/** Header shapes `extractCallbackToken` accepts, mirrored from the SDK. */
export type MayarCallbackHeaders =
  | Headers
  | Record<string, string | string[] | null | undefined>
  | ((name: string) => string | null | undefined)

/** Raised when the `x-callback-token` header is missing or does not match. */
export class MayarWebhookAuthError extends WebhookAuthError {
  constructor(message = 'Mayar webhook callback token mismatch.') {
    super(message)
    this.name = 'MayarWebhookAuthError'
  }
}

/** Pull the callback token out of request headers, case-insensitively. */
export function mayarCallbackToken(headers: MayarCallbackHeaders): string | null {
  return extractCallbackToken(headers)
}

/**
 * Authenticate + parse an inbound Mayar callback in one step.
 *
 * @throws `MayarWebhookAuthError` when the token is missing, mismatched, or
 * the shop has no token configured — the transport layer answers 401.
 */
export function verifyMayarCallback(
  headers: MayarCallbackHeaders,
  payload: unknown,
  webhookSecret: string | null | undefined,
): MayarWebhookPayload {
  if (!webhookSecret)
    throw new MayarWebhookAuthError('No Mayar webhook callback token is configured.')
  try {
    return verifyWebhookRequest({ headers, body: payload, callbackToken: webhookSecret })
  } catch (error) {
    if (error instanceof MayarSdkWebhookAuthError) throw new MayarWebhookAuthError(error.message)
    throw error
  }
}

/**
 * A `payment.received` event carrying the transaction id we reconcile
 * against. Everything else (`payment.reminder`, `shipper.status`,
 * `membership.*`) is acknowledged without touching orders.
 */
export function isMayarPaidEvent(payload: MayarWebhookPayload): boolean {
  return (
    payload.event === 'payment.received' &&
    typeof payload.data?.id === 'string' &&
    payload.data.id !== ''
  )
}

/**
 * The Mayar transaction id from a paid event, if shaped as expected.
 *
 * The event's `data.status`/`data.amount` are never trusted on their own —
 * callers reconcile against `transactions.get(id)` before moving money.
 */
export function mayarEventTransactionId(payload: MayarWebhookPayload): string | null {
  const id = payload.data?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Register (or replace) the account's webhook destination URL.
 *
 * Mayar keeps exactly one `urlHook` per account, so the shop's callback URL
 * (`/store/<slug>/mayar`) is what gets registered when credentials are
 * saved — the seller never has to copy it into the dashboard by hand.
 */
export async function registerMayarWebhook(client: Mayar, urlHook: string): Promise<void> {
  await client.webhooks.register(urlHook)
}
