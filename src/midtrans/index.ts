/**
 * Midtrans server-side glue: credential handling, channel catalogue and
 * charge preparation for PayKit.
 *
 * Import from `@repo/integrations/midtrans`, never from the main barrel: the
 * main barrel is consumed by browser bundles (the admin integration UI), and
 * this module pulls in the API client and signature verification, which must
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
 * The codes are PayKit's own (not Midtrans' `enabled_payments` values) so
 * the universal adapter and the logo map stay readable; `./charge` translates
 * each one to the granular `enabled_payments` value Snap expects. A curated
 * subset of what Snap can show — the bank VAs, the retail outlets, the
 * e-wallets that need no account linking, QRIS and cards.
 */
export interface MidtransCheckoutChannel {
  /** The exact code the charge caller sends. */
  code: string
  /** Short label, e.g. `BCA Virtual Account`. */
  label: string
  /** One line of guidance shown under the label, or omitted for the obvious. */
  hint?: string
}

export const MIDTRANS_CHECKOUT_CHANNELS: readonly MidtransCheckoutChannel[] = [
  { code: 'BCA_VA', label: 'BCA Virtual Account' },
  { code: 'BRI_VA', label: 'BRI Virtual Account' },
  { code: 'MANDIRI_VA', label: 'Mandiri Virtual Account' },
  { code: 'BNI_VA', label: 'BNI Virtual Account' },
  { code: 'PERMATA_VA', label: 'Permata Virtual Account' },
  { code: 'CIMB_VA', label: 'CIMB Niaga Virtual Account' },
  { code: 'DANAMON_VA', label: 'Danamon Virtual Account' },
  { code: 'BSI_VA', label: 'BSI Virtual Account' },
  { code: 'ALFAMART', label: 'Alfamart' },
  { code: 'INDOMARET', label: 'Indomaret' },
  {
    code: 'QRIS',
    label: 'QRIS',
    hint: 'Scan with any e-wallet or mobile banking app.',
  },
  { code: 'GOPAY', label: 'GoPay' },
  { code: 'SHOPEEPAY', label: 'ShopeePay' },
  {
    code: 'CARD',
    label: 'Credit / Debit Card',
    hint: 'Visa, Mastercard, JCB or Amex, processed by Midtrans.',
  },
]

/** True when `code` is one of the checkout channels the storefront offers. */
export function isMidtransCheckoutChannel(code: string): boolean {
  return MIDTRANS_CHECKOUT_CHANNELS.some((channel) => channel.code === code.trim().toUpperCase())
}

/**
 * The checkout label for a channel code, or `null` for an unknown code.
 *
 * Accepts Midtrans' own `payment_type` values too (`bank_transfer`, `qris`,
 * `gopay`, `cstore`, `credit_card`, …) — the webhook planner resolves the
 * stored snapshot from those, and they must land on the same labels.
 */
export function midtransChannelLabel(code: string | null | undefined): string | null {
  if (!code) return null
  const normalized = code.trim().toUpperCase()
  const direct = MIDTRANS_CHECKOUT_CHANNELS.find((channel) => channel.code === normalized)
  if (direct) return direct.label
  switch (normalized) {
    // Generic types name no bank — they stay `null` so the caller falls back
    // to the bare provider name rather than a wrong one.
    case 'BCA':
    case 'BCA_VA':
      return 'BCA Virtual Account'
    case 'BRI':
    case 'BRI_VA':
      return 'BRI Virtual Account'
    case 'MANDIRI':
    case 'ECHANNEL':
      return 'Mandiri Virtual Account'
    case 'BNI':
    case 'BNI_VA':
      return 'BNI Virtual Account'
    case 'PERMATA':
    case 'PERMATA_VA':
      return 'Permata Virtual Account'
    case 'CIMB':
    case 'CIMB_VA':
      return 'CIMB Niaga Virtual Account'
    case 'DANAMON':
    case 'DANAMON_VA':
      return 'Danamon Virtual Account'
    case 'BSI':
    case 'BSI_VA':
      return 'BSI Virtual Account'
    case 'QRIS':
    case 'OTHER_QRIS':
      return 'QRIS'
    case 'GOPAY':
      return 'GoPay'
    case 'SHOPEEPAY':
      return 'ShopeePay'
    case 'ALFAMART':
    case 'CSTORE':
      return 'Alfamart'
    case 'INDOMARET':
      return 'Indomaret'
    case 'CREDIT_CARD':
      return 'Credit / Debit Card'
    default:
      return null
  }
}
