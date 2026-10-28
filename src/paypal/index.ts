/**
 * PayPal integration — server-only business logic.
 *
 * Import from `@repo/integrations/paypal`, never from the main barrel: the
 * main barrel is consumed by browser bundles (the admin integration UI), and
 * this module pulls in the REST client and signature verification, which
 * must not ship to a client.
 */

export * from './client'
export * from './webhook'
export * from './charge'
export * from './payment'
export * from './transactions'

/* -------------------------------------------------------------------------- */
/* Checkout channels                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The `channel` values the storefront lets a buyer pick.
 *
 * One PayPal order serves all three — the server creates the same `CAPTURE`
 * order either way (see `./charge`) and the *frontend* decides how it is
 * approved: the PayPal Buttons component for `paypal`/`paylater`, the hosted
 * Card Fields for `card`. The channel therefore only picks the stored method
 * label, never the API payload.
 */
export interface PaypalCheckoutChannel {
  /** The exact code the charge caller sends. */
  code: string
  /** Short label, e.g. `PayPal`. */
  label: string
  /** One line of guidance shown under the label, or omitted for the obvious. */
  hint?: string
}

export const PAYPAL_CHECKOUT_CHANNELS: readonly PaypalCheckoutChannel[] = [
  { code: 'paypal', label: 'PayPal' },
  { code: 'paylater', label: 'PayPal Pay Later', hint: 'Pay in instalments with PayPal.' },
  {
    code: 'card',
    label: 'Credit / Debit Card',
    hint: 'Visa, Mastercard or Amex, processed by PayPal.',
  },
]

/** True when `code` is one of the checkout channels the storefront offers. */
export function isPaypalCheckoutChannel(code: string): boolean {
  return PAYPAL_CHECKOUT_CHANNELS.some((channel) => channel.code === code)
}

/** The checkout label for a channel code, or `null` for an unknown code. */
export function paypalChannelLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return PAYPAL_CHECKOUT_CHANNELS.find((channel) => channel.code === code)?.label ?? null
}
