/**
 * Gateway references that stay unique across re-charges.
 *
 * Every provider is handed the PayKit `orderNumber` as its correlation key,
 * but some refuse that key twice: Midtrans rejects an `order_id` that is
 * still active or already paid (406), and Xendit ties card payment requests
 * to a unique `reference_id`. A re-charge therefore uses
 * `<orderNumber>~<token>`, where the token is derived from the gateway
 * reference the order already carries. That keeps retrying the *same* charge
 * idempotent (the stored reference does not change until the charge
 * succeeds) while every fresh attempt — each success stores a new reference
 * — gets a distinct id.
 *
 * `~` never appears in `generateOrderNumber` or `formatInvoiceNumber`, so the
 * base order number is always recoverable, and it is an allowed character in
 * a Midtrans `order_id`.
 */

/** The character between a base order number and its attempt token. */
export const GATEWAY_REFERENCE_SEPARATOR = '~'

/**
 * A short, deterministic token for one previous gateway reference.
 *
 * FNV-1a rendered in base36: stable across runtimes (no crypto import), safe
 * in every provider's id charset, and short enough to keep the composed
 * reference inside Midtrans' 50-character `order_id` limit.
 */
export function shortReferenceToken(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/**
 * The gateway reference for a charge attempt.
 *
 * No previous reference means this is the order's first charge, and the base
 * order number is used unchanged — the shape every webhook and status lookup
 * already knows. A previous reference appends a token derived from it.
 */
export function chargeAttemptReference(
  orderNumber: string,
  existingPaymentReference?: string | null,
): string {
  const previous = existingPaymentReference?.trim()
  if (!previous) return orderNumber
  return `${orderNumber}${GATEWAY_REFERENCE_SEPARATOR}${shortReferenceToken(previous)}`
}

/**
 * The order number behind a gateway reference, attempt suffix stripped.
 *
 * Unknown references (a hand-made id, a legacy provider value) pass through
 * untouched; only a trailing `~token` is removed.
 */
export function baseGatewayReference(reference: string): string {
  const separator = reference.lastIndexOf(GATEWAY_REFERENCE_SEPARATOR)
  return separator === -1 ? reference : reference.slice(0, separator)
}
