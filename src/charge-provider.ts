/**
 * Which gateway issued an order's current charge.
 *
 * The payment-method label cannot say — Tripay and Duitku store the channel
 * name ("BRI Virtual Account") there — so the checkout link's host is the
 * reliable signal, with the label kept as a fallback for Mayar-style labels.
 * Shared by the dashboard (manual status checks) and the storefront (the
 * PayPal return confirmation), so the two can never disagree about it.
 */

/** Checkout hosts each gateway issues links on, matched by hostname suffix. */
export const GATEWAY_LINK_HOSTS: ReadonlyArray<
  readonly [provider: string, hosts: readonly string[]]
> = [
  ['tripay', ['tripay.co.id']],
  ['duitku', ['duitku.com']],
  ['mayar', ['mayar.id', 'mayar.link', 'mayar.club', 'myr.id']],
  ['midtrans', ['midtrans.com']],
  ['xendit', ['xendit.co', 'xen.link']],
  ['paypal', ['paypal.com']],
]

/** The provider id, or `null` when neither the link nor the label names a known gateway. */
export function orderChargeProvider(order: {
  paymentLink?: string | null
  paymentMethod?: string | null
}): string | null {
  if (order.paymentLink) {
    try {
      const host = new URL(order.paymentLink).hostname.toLowerCase()
      const match = GATEWAY_LINK_HOSTS.find(([, hosts]) =>
        hosts.some((h) => host === h || host.endsWith(`.${h}`)),
      )
      if (match) return match[0]
    } catch {
      // Not a URL — fall through to the label.
    }
  }
  const label = order.paymentMethod?.toLowerCase() ?? ''
  return GATEWAY_LINK_HOSTS.find(([provider]) => label.startsWith(provider))?.[0] ?? null
}
