/**
 * Outbound charge building — turning a PayKit order into a Xendit Payment
 * Session.
 *
 * One shape for every channel: a session has a single create call and the
 * *buyer* picks the method on Xendit's hosted checkout. `channel` therefore
 * only narrows the hosted list (via `allowed_payment_channels`) and picks
 * the stored method label, never the payload shape.
 *
 * Pure module: no I/O, no dates beyond the injected `now`, amounts stay in
 * the currency's minor unit exactly as stored on the order.
 */

import { chargeAttemptReference } from '../charge-reference'
import {
  XENDIT_SESSION_COUNTRY,
  XENDIT_SESSION_CURRENCY,
  type XenditCreateSessionRequest,
  type XenditSessionItem,
} from './client'

/** The parts of an order a charge needs. Mirrors the `orders` document. */
export interface XenditChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
}

/** One order line, as far as charging is concerned. */
export interface XenditChargeLine {
  description: string
  quantity: number
  unitPrice: number
}

/** Order-level adjustments that must appear on the session basket as their own lines. */
export interface XenditChargeTotals {
  discountTotal?: number | null
  shippingTotal?: number | null
  taxTotal?: number | null
}

/** What is still owed on the order — the only amount ever charged. */
export function xenditRemainingAmountFor(
  order: Pick<XenditChargeOrder, 'grandTotal' | 'amountPaid'>,
): number {
  return Math.max(0, order.grandTotal - (order.amountPaid ?? 0))
}

/**
 * The `allowed_payment_channels` value for one checkout channel.
 *
 * Payment Sessions name bank transfers `<BANK>_VIRTUAL_ACCOUNT` and cards
 * `CARDS` — the codes the hosted page and its callbacks speak. The checkout
 * codes stay short and stable in PayKit; this is the one translation. An
 * unknown channel sends nothing and the session offers every active channel
 * instead of failing the charge.
 */
const XENDIT_CHANNEL_PAYMENT_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  BCA: ['BCA_VIRTUAL_ACCOUNT'],
  BRI: ['BRI_VIRTUAL_ACCOUNT'],
  MANDIRI: ['MANDIRI_VIRTUAL_ACCOUNT'],
  BNI: ['BNI_VIRTUAL_ACCOUNT'],
  PERMATA: ['PERMATA_VIRTUAL_ACCOUNT'],
  BSI: ['BSI_VIRTUAL_ACCOUNT'],
  QRIS: ['QRIS'],
  DANA: ['DANA'],
  OVO: ['OVO'],
  SHOPEEPAY: ['SHOPEEPAY'],
  LINKAJA: ['LINKAJA'],
  ALFAMART: ['ALFAMART'],
  INDOMARET: ['INDOMARET'],
  CARD: ['CARDS'],
}

/** The session channel filter for a checkout channel, or `undefined` for every active channel. */
export function xenditPaymentChannelsFor(channel: string | null | undefined): string[] | undefined {
  if (!channel) return undefined
  const channels = XENDIT_CHANNEL_PAYMENT_CHANNELS[channel.trim().toUpperCase()]
  return channels ? [...channels] : undefined
}

/**
 * The amount window each checkout channel accepts, from Xendit's available
 * payment channels table (IDR, September 2026).
 *
 * Xendit rejects a session restricted to a channel the amount does not fit
 * (an Alfamart payment under Rp 10.000 cannot exist), so the storefront
 * hides unfitting channels and the charge refuses one picked earlier.
 */
export const XENDIT_CHANNEL_LIMITS: Readonly<Record<string, { min: number; max: number }>> = {
  BCA: { min: 10_000, max: 50_000_000 },
  BRI: { min: 1, max: 50_000_000_000 },
  MANDIRI: { min: 1, max: 50_000_000_000 },
  BNI: { min: 1, max: 50_000_000 },
  PERMATA: { min: 1, max: 9_999_999_999 },
  BSI: { min: 1, max: 50_000_000_000 },
  QRIS: { min: 1, max: 20_000_000 },
  DANA: { min: 100, max: 20_000_000 },
  OVO: { min: 100, max: 20_000_000 },
  SHOPEEPAY: { min: 1, max: 20_000_000 },
  LINKAJA: { min: 1, max: 20_000_000 },
  ALFAMART: { min: 10_000, max: 5_000_000 },
  INDOMARET: { min: 10_000, max: 2_500_000 },
  CARD: { min: 5_000, max: 200_000_000 },
}

/** The documented limits for a checkout channel, or `null` for an unknown one. */
export function xenditChannelLimitFor(
  channel: string | null | undefined,
): { min: number; max: number } | null {
  if (!channel) return null
  return XENDIT_CHANNEL_LIMITS[channel.trim().toUpperCase()] ?? null
}

/**
 * Whether an amount can be charged through a channel. An unknown channel
 * answers `true` — the catalogue is curated, and failing open here keeps a
 * future channel from being hidden by a stale table.
 */
export function xenditChannelFitsAmount(
  channel: string | null | undefined,
  amount: number,
): boolean {
  const limit = xenditChannelLimitFor(channel)
  if (!limit) return true
  return amount >= limit.min && amount <= limit.max
}

export interface BuildXenditSessionInput {
  order: XenditChargeOrder
  /** One of `XENDIT_CHECKOUT_CHANNELS` — checked by the charge caller. */
  channel?: string | null
  lines: readonly XenditChargeLine[]
  totals?: XenditChargeTotals
  /**
   * Where the buyer lands afterwards — success page after payment,
   * expiry page when the session lapses. Informational only, never
   * trusted: settlement always comes through the webhook.
   */
  returnUrl?: string
  /** The shop's currency. Guarded to IDR by the adapter; defaults to IDR. */
  currency?: string | null
  /**
   * The gateway reference a previous charge left on the order. A re-charge
   * appends an attempt token — Xendit's card payment requests require a
   * unique reference. See `chargeAttemptReference`.
   */
  existingPaymentReference?: string | null
  /** ISO 8601 instant the order's payment deadline lands on. */
  expiresAt?: string | null
}

/**
 * Build the `POST /sessions` body for the order's remaining balance.
 *
 * - `reference_id` is the PayKit `orderNumber` — the contract the webhook
 *   handler settles on — with an attempt token appended when the order is
 *   being re-charged (Xendit wants a unique reference for cards).
 * - `items` mirrors the order's own composition only when it adds up
 *   exactly — so any discount or part-payment collapses the basket to a
 *   single `Pembayaran pesanan …` line (the Tripay/Midtrans builders' rule).
 * - `metadata.paykit_channel` echoes the channel the buyer picked, so the
 *   webhook can label the settled payment without reading the underlying
 *   Payment object.
 */
export function buildXenditSessionBody({
  order,
  channel,
  lines,
  totals,
  returnUrl,
  currency,
  existingPaymentReference,
  expiresAt,
}: BuildXenditSessionInput): XenditCreateSessionRequest {
  const remaining = xenditRemainingAmountFor(order)
  const currencyCode = (currency ?? XENDIT_SESSION_CURRENCY).trim().toUpperCase()

  const hasAdjustments = (totals?.discountTotal ?? 0) > 0 || (order.amountPaid ?? 0) > 0
  const linesSum =
    lines.reduce((acc, line) => acc + line.unitPrice * line.quantity, 0) +
    (totals?.shippingTotal ?? 0) +
    (totals?.taxTotal ?? 0)

  let items: XenditSessionItem[] | undefined
  if (!hasAdjustments && linesSum === remaining && lines.length > 0) {
    const detailed: XenditSessionItem[] = lines
      .filter((line) => line.quantity > 0 && line.unitPrice > 0)
      .map((line, index) => ({
        reference_id: `item-${index + 1}`,
        type: 'PHYSICAL_PRODUCT',
        name: line.description.trim().slice(0, 255) || 'Item',
        net_unit_amount: line.unitPrice,
        quantity: line.quantity,
        category: 'Item',
      }))
    if ((totals?.shippingTotal ?? 0) > 0) {
      detailed.push({
        reference_id: 'shipping',
        type: 'PHYSICAL_SERVICE',
        name: 'Ongkos kirim',
        net_unit_amount: totals!.shippingTotal!,
        quantity: 1,
        category: 'Shipping',
      })
    }
    if ((totals?.taxTotal ?? 0) > 0) {
      detailed.push({
        reference_id: 'tax',
        type: 'FEE',
        name: 'Pajak',
        net_unit_amount: totals!.taxTotal!,
        quantity: 1,
        category: 'Tax',
      })
    }
    if (
      detailed.reduce((acc, item) => acc + item.net_unit_amount * item.quantity, 0) === remaining
    ) {
      items = detailed
    }
  }

  items ??= [
    {
      reference_id: 'order',
      type: 'PHYSICAL_PRODUCT',
      name: `Pembayaran pesanan ${order.orderNumber}`.slice(0, 255),
      net_unit_amount: remaining,
      quantity: 1,
      category: 'Order',
    },
  ]

  const channels = xenditPaymentChannelsFor(channel ?? null)

  return {
    reference_id: chargeAttemptReference(order.orderNumber, existingPaymentReference),
    session_type: 'PAY',
    mode: 'PAYMENT_LINK',
    amount: remaining,
    currency: currencyCode,
    country: XENDIT_SESSION_COUNTRY,
    description: `Pembayaran pesanan ${order.orderNumber}`.slice(0, 1000),
    locale: 'id',
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(returnUrl ? { success_return_url: returnUrl, cancel_return_url: returnUrl } : {}),
    ...(channels ? { allowed_payment_channels: channels } : {}),
    items,
    metadata: {
      paykit_channel: channel?.trim().toUpperCase() ?? '',
      paykit_order: order.orderNumber,
    },
  }
}
