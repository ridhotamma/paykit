/**
 * Shared authentication failure for inbound provider webhooks.
 *
 * Providers that authenticate callbacks with a shared secret rather than a
 * signature over the body (Mayar's `x-callback-token` header, KiriminAja's
 * `token` field) cannot distinguish "wrong secret" from "no secret" — both
 * are authentication failures that the transport layer answers `401` so the
 * seller sees the misconfiguration in the provider's own dashboard test,
 * instead of a false success the provider will never retry.
 *
 * Every integration's auth error extends this class so `apps/webhook` can
 * catch one type; the payload shaping and secret location stay per provider.
 */
export class WebhookAuthError extends Error {
  readonly status = 401

  constructor(message = 'Webhook callback authentication failed.') {
    super(message)
    this.name = 'WebhookAuthError'
  }
}
