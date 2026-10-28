/**
 * Outbound charge building — turning a PayKit order into a Midtrans Snap
 * transaction.
 *
 * One shape for every channel: Snap has a single create call the way
 * Tripay/Duitku have per-channel ones, and the *buyer* picks the method on
 * Midtrans' hosted page. `channel` therefore only narrows the hosted list
 * (via `enabled_payments`) and picks the stored method label, never the
 * payload shape.
 *
 * Pure module: no I/O, no dates beyond the injected `now`, amounts stay in
 * the currency's minor unit exactly as stored on the order.
 */

import { chargeAttemptReference } from '../charge-reference'
import type { MidtransSnapRequest } from './client'

/** The parts of an order a charge needs. Mirrors the `orders` document. */
export interface MidtransChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
}

/** One order line, as far as charging is concerned. */
export interface MidtransChargeLine {
  description: string
  quantity: number
  unitPrice: number
}

/** Order-level adjustments that must appear on the Snap breakdown as their own lines. */
export interface MidtransChargeTotals {
  discountTotal?: number | null
  shippingTotal?: number | null
  taxTotal?: number | null
}

/** What is still owed on the order — the only amount ever charged. */
export function midtransRemainingAmountFor(
  order: Pick<MidtransChargeOrder, 'grandTotal' | 'amountPaid'>,
): number {
  return Math.max(0, order.grandTotal - (order.amountPaid ?? 0))
}

/**
 * The `enabled_payments` value for one checkout channel.
 *
 * Granular per-bank values (`bca_va`, `bri_va`, …) from Midtrans' request-body
 * reference — not the `bank_transfer` alias, so the buyer lands on exactly
 * the channel the seller's checkout offered. QRIS rides as `other_qris`
 * (the generic QRIS acquirer), retail as the outlet's own value, cards as
 * `credit_card`. An unknown channel sends nothing and Snap shows every
 * active type instead of failing the charge.
 */
const MIDTRANS_CHANNEL_PAYMENTS: Readonly<Record<string, readonly string[]>> = {
  BCA_VA: ['bca_va'],
  BRI_VA: ['bri_va'],
  MANDIRI_VA: ['echannel'],
  BNI_VA: ['bni_va'],
  PERMATA_VA: ['permata_va'],
  CIMB_VA: ['cimb_va'],
  DANAMON_VA: ['danamon_va'],
  BSI_VA: ['bsi_va'],
  QRIS: ['other_qris'],
  GOPAY: ['gopay'],
  SHOPEEPAY: ['shopeepay'],
  ALFAMART: ['alfamart'],
  INDOMARET: ['indomaret'],
  CARD: ['credit_card'],
}

/**
 * The buyer phone Snap accepts without rejecting the transaction.
 *
 * BNI VA rejects the whole transaction when the phone does not start with
 * `+62` or `0` (+area code), max 30 chars — so a phone in any other shape
 * is omitted rather than sent. An omitted phone never fails a charge; a
 * malformed one does.
 */
export function midtransCustomerPhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined
  const compact = phone.trim().replace(/[\s\-().]/g, '')
  if (/^\+62\d+$/.test(compact)) return compact.slice(0, 30)
  const digits = compact.replace(/\D/g, '')
  if (/^0\d+$/.test(digits)) return digits.slice(0, 30)
  if (/^62\d+$/.test(digits)) return `+${digits}`.slice(0, 30)
  return undefined
}

/** The Snap payment-type filter for a checkout channel, or `undefined` for every active type. */
export function midtransEnabledPaymentsFor(
  channel: string | null | undefined,
): string[] | undefined {
  if (!channel) return undefined
  const payments = MIDTRANS_CHANNEL_PAYMENTS[channel.trim().toUpperCase()]
  return payments ? [...payments] : undefined
}

/**
 * `YYYY-MM-DD HH:mm:ss +0700` — the `start_time` Snap counts its expiry
 * from. Rendered off UTC+7 arithmetically rather than via `Intl`, so the
 * value is identical in every runtime the server code runs on.
 */
export function midtransStartTime(now: Date = new Date()): string {
  const wib = new Date(now.getTime() + 7 * 3_600_000)
  const iso = wib.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0700`
}

export interface BuildMidtransSnapInput {
  order: MidtransChargeOrder
  /** One of `MIDTRANS_CHECKOUT_CHANNELS` — checked by the charge caller. */
  channel?: string | null
  lines: readonly MidtransChargeLine[]
  totals?: MidtransChargeTotals
  /** Where Snap sends the buyer after the payment attempt — informational only, never trusted. */
  returnUrl?: string
  /** Minutes. Snap honours ~20 seconds at the low end; the adapter clamps to days at the high end. */
  expiresInMinutes?: number
  /**
   * The gateway reference a previous charge left on the order. Midtrans
   * refuses an `order_id` that is still active or paid, so a re-charge
   * appends an attempt token — see `chargeAttemptReference`.
   */
  existingPaymentReference?: string | null
  now?: Date
}

/**
 * Build the Snap `POST /snap/v1/transactions` body for the order's remaining
 * balance.
 *
 * - `order_id` is the PayKit `orderNumber` — the contract the webhook
 *   handler settles on — with an attempt token appended when the order is
 *   being re-charged (Midtrans refuses a still-active `order_id`).
 * - `item_details` mirrors the order's own composition only when it adds up
 *   exactly: Snap rejects a breakdown whose sum differs from `gross_amount`,
 *   and a negative discount line is not a shape worth gambling the charge
 *   on — so any discount or part-payment collapses the breakdown to a single
 *   `Pembayaran pesanan …` line (the Tripay builder's rule).
 */
export function buildMidtransSnapBody({
  order,
  channel,
  lines,
  totals,
  returnUrl,
  expiresInMinutes,
  existingPaymentReference,
  now = new Date(),
}: BuildMidtransSnapInput): MidtransSnapRequest {
  const remaining = midtransRemainingAmountFor(order)

  const hasAdjustments = (totals?.discountTotal ?? 0) > 0 || (order.amountPaid ?? 0) > 0
  const linesSum =
    lines.reduce((acc, line) => acc + line.unitPrice * line.quantity, 0) +
    (totals?.shippingTotal ?? 0) +
    (totals?.taxTotal ?? 0)

  let itemDetails: MidtransSnapRequest['item_details']
  if (!hasAdjustments && linesSum === remaining && lines.length > 0) {
    const items: NonNullable<MidtransSnapRequest['item_details']> = lines
      .filter((line) => line.quantity > 0 && line.unitPrice > 0)
      .map((line, index) => ({
        id: `item-${index + 1}`,
        price: line.unitPrice,
        quantity: line.quantity,
        name: line.description.trim().slice(0, 50) || `Item ${index + 1}`,
      }))
    if ((totals?.shippingTotal ?? 0) > 0) {
      items.push({
        id: 'shipping',
        price: totals!.shippingTotal!,
        quantity: 1,
        name: 'Ongkos kirim',
      })
    }
    if ((totals?.taxTotal ?? 0) > 0) {
      items.push({ id: 'tax', price: totals!.taxTotal!, quantity: 1, name: 'Pajak' })
    }
    if (items.reduce((acc, item) => acc + item.price * item.quantity, 0) === remaining) {
      itemDetails = items
    }
  }

  itemDetails ??= [
    {
      id: 'order',
      price: remaining,
      quantity: 1,
      name: `Pembayaran pesanan ${order.orderNumber}`.slice(0, 50),
    },
  ]

  const enabledPayments = midtransEnabledPaymentsFor(channel ?? null)

  return {
    transaction_details: {
      order_id: chargeAttemptReference(order.orderNumber, existingPaymentReference),
      gross_amount: remaining,
    },
    item_details: itemDetails,
    customer_details: {
      // BCA VA caps the buyer name at 30 characters.
      first_name: order.customerName.trim().slice(0, 30) || order.orderNumber,
      ...(order.customerEmail ? { email: order.customerEmail } : {}),
      ...(() => {
        const phone = midtransCustomerPhone(order.customerPhone)
        return phone ? { phone } : {}
      })(),
    },
    ...(enabledPayments ? { enabled_payments: enabledPayments } : {}),
    ...(typeof expiresInMinutes === 'number' && Number.isFinite(expiresInMinutes)
      ? {
          expiry: {
            start_time: midtransStartTime(now),
            unit: 'minute' as const,
            duration: Math.max(1, Math.floor(expiresInMinutes)),
          },
        }
      : {}),
    ...(returnUrl ? { callbacks: { finish: returnUrl, error: returnUrl } } : {}),
  }
}
