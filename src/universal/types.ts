/**
 * Universal payment adapter contracts and types.
 *
 * Provides a provider-agnostic abstraction over disparate 3rd-party payment
 * gateways (Tripay, Duitku, Mayar, etc.). Standardizes channels, charge
 * requests, status checks, and lifecycle events across the platform.
 */

import type { EmbeddedCheckout } from '../embedded'
import type { OrderPaymentStatus, OrderStatus } from '../order-status'

export type PaymentChannelCategory =
  'virtual_account' | 'ewallet' | 'qris' | 'retail' | 'card' | 'other'

export interface UniversalPaymentChannel {
  code: string
  label: string
  category: PaymentChannelCategory
  hint?: string
  /**
   * Path under the apps' `public/` folder (see `digitalChannelLogoPath` in
   * the host's asset root), or `null` when no vendored mark exists.
   * Static on purpose: the live gateway responses do carry logos (Tripay
   * `icon_url`, Duitku `paymentImage`) but need per-shop credentials.
   */
  logo?: string | null
  /** Transaction or handling fee charged for this channel, if known. */
  fee?: number | null
}

export interface UniversalGatewayCapabilities {
  supportsChannels: boolean
  supportsStatusRefresh: boolean
  supportsTestConnection: boolean
  /**
   * Whether a charge can carry an {@link EmbeddedCheckout} descriptor — an
   * iframe URL, a provider browser SDK, or both.
   *
   * Not every provider supports the same presentation: Tripay and Mayar have
   * a hosted page only, Duitku has Duitku Pop, Xendit has Components, and
   * PayPal only exposes its JS SDK because its approval page forbids framing.
   */
  supportsEmbeddedCheckout: boolean
}

export interface UniversalTestResult {
  ok: boolean
  environment?: string
  error?: string
}

export interface UniversalGatewayInfo {
  provider: string
  name: string
  capabilities: UniversalGatewayCapabilities
  channels: readonly UniversalPaymentChannel[]
}

export interface UniversalChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
}

export interface UniversalChargeLine {
  description: string
  quantity: number
  unitPrice: number
}

export interface UniversalChargeTotals {
  discountTotal?: number | null
  shippingTotal?: number | null
  taxTotal?: number | null
}

export interface UniversalChargeParams {
  order: UniversalChargeOrder
  lines: readonly UniversalChargeLine[]
  totals?: UniversalChargeTotals
  channel?: string
  callbackUrl?: string
  returnUrl?: string
  shopName?: string
  /**
   * The shop's own currency (`tenants.currency`).
   *
   * Adapters that only settle in one currency (Xendit and Midtrans are
   * IDR-only) or bind a currency at connection time (PayPal) use this to
   * refuse a charge whose ledger amount would be interpreted as a different
   * currency — the stored amount is in this currency's minor unit and is
   * never converted. Absent (an older caller), the adapter falls back to the
   * provider's own default rather than failing.
   */
  currency?: string
  /**
   * The gateway reference the order/invoice already carries from a previous
   * charge, when this is a re-charge (`orders.paymentReference`,
   * `subscription_payments.reference`). Absent on a first charge.
   *
   * Providers that require a unique reference per attempt (Midtrans'
   * `order_id`, Xendit's card reference, PayPal's `PayPal-Request-Id`) derive
   * a fresh one from it, so a re-charged order never collides with the
   * still-active previous charge while a retry of *this* attempt stays
   * idempotent.
   */
  existingPaymentReference?: string | null
  /**
   * The order's payment deadline (`orders.expiresAt`), when known.
   *
   * Each adapter translates it into the provider's own expiry unit so the
   * gateway invoice dies with the order — payment expired = order expired.
   * Absent (a re-charge of an order placed before deadlines existed, say),
   * the adapter falls back to the provider's default. The sweeper enforces
   * the order side regardless, so a late provider callback noops instead of
   * settling a cancelled order.
   */
  expiresAt?: string | null
  /**
   * Ask for an embedded checkout where the provider has a distinct embedded
   * API.
   *
   * `redirect` (the default) keeps the hosted payment page. `embedded` creates
   * a native embedded session when one exists — currently Xendit Components —
   * and leaves the other providers on their normal hosted charge while still
   * returning an {@link UniversalChargeResult.embedded} descriptor.
   */
  checkout?: 'redirect' | 'embedded'
  /**
   * Browser origins allowed to mount the embedded checkout.
   *
   * Required by Xendit Components (`components_configuration.origins`) and
   * ignored by the other adapters. The origin is the storefront's own URL,
   * e.g. `https://shop.example.com`.
   */
  embedOrigins?: readonly string[]
}

export interface UniversalChargeResult {
  /**
   * The provider-hosted checkout page, or `null` when the charge only exists
   * as an embedded session (Xendit Components has no payment link URL).
   */
  paymentLink: string | null
  paymentReference: string
  paymentMethodLabel: string
  /**
   * The charged channel's mark, resolved the same way as
   * {@link UniversalPaymentChannel.logo}, so the order can keep it once the
   * channel list is out of reach. `null` for a hosted checkout (Mayar) where
   * the buyer picks the channel on the gateway's own page.
   */
  paymentLogo?: string | null
  /**
   * In-app payment details, so a UI can render the number itself instead of
   * sending the payer to the hosted checkout page.
   *
   * Tripay returns `pay_code` for VA/retail channels and `qr_string`/`qr_url`
   * for QRIS on the closed transaction; Duitku returns `vaNumber` / `qrString`
   * on the v2 inquiry. Absent for hosted-checkout providers (Mayar) and for
   * channels that have no direct code (e-wallets) — those keep using
   * `paymentLink`.
   */
  vaNumber?: string | null
  qrString?: string | null
  qrUrl?: string | null
  /** Gateway-reported expiry as unix seconds, when the provider states one. */
  expiresAt?: number | null
  /**
   * How to present this payment inside the storefront instead of redirecting
   * to `paymentLink`. Present whenever the provider has an embeddable UI; the
   * storefront may still choose `paymentLink` (or both, as a fallback).
   *
   * See `EmbeddedCheckout` for the two presentations and the browser SDK each
   * `script.sdk` value requires.
   */
  embedded?: EmbeddedCheckout | null
}

export interface UniversalRefreshParams {
  orderNumber: string
  paymentReference: string
  grandTotal: number
  amountPaid: number
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  paidAt?: string | null
  paymentMethod?: string | null
}

export interface UniversalRefreshResult {
  settled: boolean
  amountPaid?: number
  paymentStatus?: OrderPaymentStatus
  paymentReference?: string
  paidAt?: string | null
  paymentMethod?: string | null
  orderStatus?: OrderStatus | null
}

export interface UniversalPaymentAdapter {
  readonly provider: string
  readonly name: string
  readonly capabilities: UniversalGatewayCapabilities
  /**
   * Why this provider cannot charge `currency` with the connection as
   * stored, or `null` when it can.
   *
   * The storefront and the admin use this to keep a gateway the shop's
   * currency cannot settle out of the buyer's options — a PayPal connection
   * on an IDR shop, say — instead of letting the charge fail after the order
   * is placed and leaving it without a payment link. Absent → the adapter
   * places no currency constraint.
   */
  currencyUnsupportedReason?(
    credentials: Record<string, string>,
    config: Record<string, string>,
    currency: string | undefined,
  ): string | null
  getChannels(
    credentials?: Record<string, string>,
    config?: Record<string, string>,
    amount?: number,
  ): Promise<readonly UniversalPaymentChannel[]>
  charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult>
  refresh?(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalRefreshParams,
  ): Promise<UniversalRefreshResult>
  testConnection?(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult>
}
