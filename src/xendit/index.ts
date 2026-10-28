/**
 * Xendit server-side glue: credential handling, channel catalogue and
 * charge preparation for PayKit.
 *
 * Import from `@ridhotamma/paykit/xendit`, never from the main barrel: the
 * main barrel is consumed by browser bundles (the admin integration UI), and
 * this module pulls in the API client and callback verification, which must
 * not ship to a client.
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
 * The `channel` values the storefront lets a buyer pick, with the labels
 * the checkout channel picker renders.
 *
 * The codes are Xendit's own `payment_methods`/`payment_channel` vocabulary
 * (`BCA`, `QRIS`, `ALFAMART`, …) — with `CARD` as the one alias, since the
 * invoice API spells it `CREDIT_CARD`. A curated subset of what an invoice
 * can offer: the bank VAs, the retail outlets, the e-wallets that need no
 * account linking, QRIS and cards.
 */
export interface XenditCheckoutChannel {
  /** The exact code the charge caller sends. */
  code: string
  /** Short label, e.g. `BCA Virtual Account`. */
  label: string
  /** One line of guidance shown under the label, or omitted for the obvious. */
  hint?: string
}

export const XENDIT_CHECKOUT_CHANNELS: readonly XenditCheckoutChannel[] = [
  { code: 'BCA', label: 'BCA Virtual Account' },
  { code: 'BRI', label: 'BRI Virtual Account' },
  { code: 'MANDIRI', label: 'Mandiri Virtual Account' },
  { code: 'BNI', label: 'BNI Virtual Account' },
  { code: 'PERMATA', label: 'Permata Virtual Account' },
  { code: 'BSI', label: 'BSI Virtual Account' },
  { code: 'ALFAMART', label: 'Alfamart' },
  { code: 'INDOMARET', label: 'Indomaret' },
  {
    code: 'QRIS',
    label: 'QRIS',
    hint: 'Scan with any e-wallet or mobile banking app.',
  },
  { code: 'DANA', label: 'DANA' },
  { code: 'OVO', label: 'OVO' },
  { code: 'SHOPEEPAY', label: 'ShopeePay' },
  { code: 'LINKAJA', label: 'LinkAja' },
  {
    code: 'CARD',
    label: 'Credit / Debit Card',
    hint: 'Visa, Mastercard, JCB or Amex, processed by Xendit.',
  },
]

/** True when `code` is one of the checkout channels the storefront offers. */
export function isXenditCheckoutChannel(code: string): boolean {
  const normalized = code.trim().toUpperCase()
  return (
    normalized === 'CARD' || XENDIT_CHECKOUT_CHANNELS.some((channel) => channel.code === normalized)
  )
}

/**
 * The checkout label for a channel code, or `null` for an unknown code.
 *
 * Accepts the Payment Sessions spellings too (`BCA_VIRTUAL_ACCOUNT`,
 * `CARDS`, …) alongside the legacy invoice callback values — the webhook
 * planner resolves the stored snapshot from what the payment page recorded,
 * and both generations must land on the same label.
 */
export function xenditChannelLabel(code: string | null | undefined): string | null {
  if (!code) return null
  const normalized = code.trim().toUpperCase()
  const direct = XENDIT_CHECKOUT_CHANNELS.find((channel) => channel.code === normalized)
  if (direct) return direct.label
  switch (normalized) {
    case 'BCA':
    case 'BCA_VIRTUAL_ACCOUNT':
      return 'BCA Virtual Account'
    case 'BRI':
    case 'BRI_VIRTUAL_ACCOUNT':
      return 'BRI Virtual Account'
    case 'MANDIRI':
    case 'MANDIRI_VIRTUAL_ACCOUNT':
      return 'Mandiri Virtual Account'
    case 'BNI':
    case 'BNI_VIRTUAL_ACCOUNT':
      return 'BNI Virtual Account'
    case 'PERMATA':
    case 'PERMATA_VIRTUAL_ACCOUNT':
      return 'Permata Virtual Account'
    case 'BSI':
    case 'BSI_VIRTUAL_ACCOUNT':
      return 'BSI Virtual Account'
    case 'CARD':
    case 'CARDS':
    case 'CREDIT_CARD':
      return 'Credit / Debit Card'
    default:
      return null
  }
}
