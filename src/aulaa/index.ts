/**
 * Aulaa server-side glue: credential handling, channel catalogue and charge
 * preparation for PayKit.
 *
 * Import from `@ridhotamma/paykit/aulaa`, never from the main barrel: the
 * main barrel is consumed by browser bundles (the admin integration UI), and
 * this module pulls in the API client and HMAC verification, which must not
 * ship to a client.
 */

export * from './client'
export * from './webhook'
export * from './charge'
export * from './payment'
export { aulaaEmbeddedCheckout, AULAA_EMBED_SCRIPT_URL } from '../embedded'

/* -------------------------------------------------------------------------- */
/* Checkout channels                                                          */
/* -------------------------------------------------------------------------- */

/** The channel families Aulaa groups its methods into. */
export type AulaaChannelKind = 'card' | 'qr_code' | 'virtual_account' | 'ewallet' | 'retail'

/**
 * The `payment_method` codes the storefront lets a buyer pick.
 *
 * Aulaa serves the authoritative, project-specific list from
 * `GET /v1/payments/methods`; this static catalogue is the fallback used when
 * no credentials are available (a settings preview, say) and the source of
 * the labels. New methods can still be charged by sending their code — the
 * adapter does not reject an unknown code, because a project may enable one
 * before PayKit's table learns about it.
 */
export interface AulaaCheckoutChannel {
  /** The exact code the `payment_method` field expects. */
  code: string
  /** Short label, e.g. `BCA Virtual Account`. */
  label: string
  /** One line of guidance shown under the label, or omitted for the obvious. */
  hint?: string
  kind: AulaaChannelKind
}

export const AULAA_CHECKOUT_CHANNELS: readonly AulaaCheckoutChannel[] = [
  { code: 'credit_card', label: 'Credit / Debit Card', kind: 'card' },
  {
    code: 'qris',
    label: 'QRIS',
    hint: 'Scan with any e-wallet or mobile banking app.',
    kind: 'qr_code',
  },
  { code: 'bca_va', label: 'BCA Virtual Account', kind: 'virtual_account' },
  { code: 'bri_va', label: 'BRI Virtual Account', kind: 'virtual_account' },
  { code: 'bni_va', label: 'BNI Virtual Account', kind: 'virtual_account' },
  { code: 'mandiri_va', label: 'Mandiri Virtual Account', kind: 'virtual_account' },
  { code: 'permata_va', label: 'Permata Virtual Account', kind: 'virtual_account' },
  { code: 'cimb_niaga_va', label: 'CIMB Niaga Virtual Account', kind: 'virtual_account' },
  { code: 'maybank_va', label: 'Maybank Virtual Account', kind: 'virtual_account' },
  { code: 'bnc_va', label: 'Bank Neo Commerce Virtual Account', kind: 'virtual_account' },
  { code: 'sampoerna_va', label: 'Bank Sahabat Sampoerna Virtual Account', kind: 'virtual_account' },
  { code: 'atm_bersama_va', label: 'ATM Bersama Virtual Account', kind: 'virtual_account' },
  { code: 'artha_graha_va', label: 'Artha Graha Virtual Account', kind: 'virtual_account' },
  { code: 'gopay', label: 'GoPay', kind: 'ewallet' },
  { code: 'shopee_pay', label: 'ShopeePay', kind: 'ewallet' },
  { code: 'ovo', label: 'OVO', kind: 'ewallet' },
  { code: 'dana', label: 'DANA', kind: 'ewallet' },
  { code: 'linkaja', label: 'LinkAja', kind: 'ewallet' },
  { code: 'alfamart', label: 'Alfamart', kind: 'retail' },
  { code: 'indomaret', label: 'Indomaret', kind: 'retail' },
]

/** True when `code` is one of the curated static channels. */
export function isAulaaCheckoutChannel(code: string): boolean {
  const normalized = code.trim().toLowerCase()
  return AULAA_CHECKOUT_CHANNELS.some((channel) => channel.code === normalized)
}

/** The checkout label for a method code, or `null` for an unknown code. */
export function aulaaChannelLabel(code: string | null | undefined): string | null {
  if (!code) return null
  const normalized = code.trim().toLowerCase()
  return AULAA_CHECKOUT_CHANNELS.find((channel) => channel.code === normalized)?.label ?? null
}

/** The channel family for a curated method code, or `null` for an unknown one. */
export function aulaaChannelKind(code: string | null | undefined): AulaaChannelKind | null {
  if (!code) return null
  const normalized = code.trim().toLowerCase()
  return AULAA_CHECKOUT_CHANNELS.find((channel) => channel.code === normalized)?.kind ?? null
}
