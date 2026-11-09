/**
 * DOKU server-side glue: credential handling, channel catalogue and charge
 * preparation for PayKit.
 *
 * Import from `@ridhotamma/paykit/doku`, never from the main barrel: the main
 * barrel is consumed by browser bundles (the admin integration UI), and this
 * module pulls in the signed API client and HMAC verification, which must not
 * ship to a client.
 */

export * from './client'
export * from './webhook'
export * from './charge'
export * from './payment'
export {
  dokuCheckoutJsUrl,
  dokuEmbeddedCheckout,
} from '../embedded'

/* -------------------------------------------------------------------------- */
/* Checkout channels                                                          */
/* -------------------------------------------------------------------------- */

/** The channel families DOKU Checkout groups its methods into. */
export type DokuChannelKind =
  | 'virtual_account'
  | 'card'
  | 'retail'
  | 'qris'
  | 'ewallet'
  | 'paylater'
  | 'direct_debit'
  | 'digital_banking'

/**
 * The `payment.payment_method_types` codes DOKU Checkout accepts.
 *
 * The codes are DOKU's own (not a friendly alias) because they are also what
 * the notification/status `channel.id` echoes back, which keeps the method
 * label snapshot honest without a second lookup table. DOKU may enable or
 * disable individual methods per merchant; `charge` still sends a project's
 * code unchanged, and the provider rejects one it has not enabled.
 */
export interface DokuCheckoutChannel {
  /** The exact code the `payment_method_types` array expects. */
  code: string
  /** Short label, e.g. `BCA Virtual Account`. */
  label: string
  /** One line of guidance shown under the label, or omitted for the obvious. */
  hint?: string
  kind: DokuChannelKind
}

export const DOKU_CHECKOUT_CHANNELS: readonly DokuCheckoutChannel[] = [
  { code: 'VIRTUAL_ACCOUNT_BCA', label: 'BCA Virtual Account', kind: 'virtual_account' },
  {
    code: 'VIRTUAL_ACCOUNT_BANK_MANDIRI',
    label: 'Mandiri Virtual Account',
    kind: 'virtual_account',
  },
  {
    code: 'VIRTUAL_ACCOUNT_BANK_SYARIAH_MANDIRI',
    label: 'BSI Virtual Account',
    kind: 'virtual_account',
  },
  { code: 'VIRTUAL_ACCOUNT_BRI', label: 'BRI Virtual Account', kind: 'virtual_account' },
  { code: 'VIRTUAL_ACCOUNT_BNI', label: 'BNI Virtual Account', kind: 'virtual_account' },
  { code: 'VIRTUAL_ACCOUNT_DOKU', label: 'DOKU Virtual Account', kind: 'virtual_account' },
  {
    code: 'VIRTUAL_ACCOUNT_BANK_PERMATA',
    label: 'Permata Virtual Account',
    kind: 'virtual_account',
  },
  { code: 'VIRTUAL_ACCOUNT_BANK_CIMB', label: 'CIMB Niaga Virtual Account', kind: 'virtual_account' },
  { code: 'VIRTUAL_ACCOUNT_BANK_DANAMON', label: 'Danamon Virtual Account', kind: 'virtual_account' },
  { code: 'VIRTUAL_ACCOUNT_BTN', label: 'BTN Virtual Account', kind: 'virtual_account' },
  { code: 'VIRTUAL_ACCOUNT_BNC', label: 'BNC Virtual Account', kind: 'virtual_account' },
  { code: 'VIRTUAL_ACCOUNT_BSS', label: 'BSS Virtual Account', kind: 'virtual_account' },
  { code: 'VIRTUAL_ACCOUNT_BJB', label: 'BJB Virtual Account', kind: 'virtual_account' },
  { code: 'VIRTUAL_ACCOUNT_Sinarmas', label: 'Sinarmas Virtual Account', kind: 'virtual_account' },
  { code: 'CREDIT_CARD', label: 'Credit / Debit Card', kind: 'card' },
  { code: 'GOOGLE_PAY', label: 'Google Pay', kind: 'card' },
  {
    code: 'ONLINE_TO_OFFLINE_ALFA',
    label: 'Alfamart / Alfamidi / Dan+Dan',
    kind: 'retail',
  },
  { code: 'ONLINE_TO_OFFLINE_INDOMARET', label: 'Indomaret', kind: 'retail' },
  {
    code: 'QRIS',
    label: 'QRIS',
    hint: 'Scan with any e-wallet or mobile banking app.',
    kind: 'qris',
  },
  { code: 'EMONEY_OVO', label: 'OVO', kind: 'ewallet' },
  { code: 'EMONEY_SHOPEE_PAY', label: 'ShopeePay', kind: 'ewallet' },
  { code: 'EMONEY_DOKU', label: 'DOKU Wallet', kind: 'ewallet' },
  { code: 'EMONEY_LINKAJA', label: 'LinkAja', kind: 'ewallet' },
  { code: 'EMONEY_DANA', label: 'DANA', kind: 'ewallet' },
  { code: 'PEER_TO_PEER_AKULAKU', label: 'Akulaku', kind: 'paylater' },
  { code: 'PEER_TO_PEER_KREDIVO', label: 'Kredivo', kind: 'paylater' },
  { code: 'PEER_TO_PEER_INDODANA', label: 'Indodana', kind: 'paylater' },
  { code: 'DIRECT_DEBIT_BRI', label: 'BRI Direct Debit', kind: 'direct_debit' },
  { code: 'JENIUS_PAY', label: 'Jenius Pay', kind: 'digital_banking' },
  { code: 'KARTU_KREDIT_INDONESIA', label: 'Kartu Kredit Indonesia', kind: 'card' },
]

/** True when `code` is one of the curated DOKU Checkout channels. */
export function isDokuCheckoutChannel(code: string): boolean {
  const normalized = code.trim().toUpperCase()
  return DOKU_CHECKOUT_CHANNELS.some((channel) => channel.code.toUpperCase() === normalized)
}

/**
 * The exact casing DOKU documents for a channel code, or `null` for an unknown
 * one. DOKU's catalogue is mostly uppercase but includes mixed-case ids such
 * as `VIRTUAL_ACCOUNT_Sinarmas`, so the request must echo the canonical value
 * rather than a caller's uppercased copy.
 */
export function dokuChannelCode(code: string | null | undefined): string | null {
  if (!code) return null
  const normalized = code.trim().toUpperCase()
  return (
    DOKU_CHECKOUT_CHANNELS.find((channel) => channel.code.toUpperCase() === normalized)?.code ??
    null
  )
}

/** The checkout label for a channel code, or `null` for an unknown code. */
export function dokuChannelLabel(code: string | null | undefined): string | null {
  if (!code) return null
  const normalized = code.trim().toUpperCase()
  return (
    DOKU_CHECKOUT_CHANNELS.find((channel) => channel.code.toUpperCase() === normalized)?.label ??
    null
  )
}

/** The channel family for a curated code, or `null` for an unknown one. */
export function dokuChannelKind(code: string | null | undefined): DokuChannelKind | null {
  if (!code) return null
  const normalized = code.trim().toUpperCase()
  return (
    DOKU_CHECKOUT_CHANNELS.find((channel) => channel.code.toUpperCase() === normalized)?.kind ??
    null
  )
}
