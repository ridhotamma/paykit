/**
 * Outbound charge building — turning a PayKit order into a DOKU Checkout
 * request.
 *
 * DOKU Checkout has one create call for every method: the body carries the
 * order, an optional `payment_method_types` array (omitted means the buyer
 * picks on DOKU's page), and optional customer/return details. The response's
 * `response.payment.url` is the hosted page the buyer opens.
 *
 * Pure module: no I/O, no clock beyond the caller's expiry minutes, amounts
 * stay in full rupiah exactly as stored on the order.
 */

import { chargeAttemptReference } from '../charge-reference'
import type { DokuCreateCheckoutRequest, DokuLineItem } from './client'

/** The parts of an order a charge needs. Mirrors the `orders` document. */
export interface DokuChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
}

/** One order line, as far as the checkout basket is concerned. */
export interface DokuChargeLine {
  description: string
  quantity: number
  unitPrice: number
}

/** Order-level adjustments that must appear on the basket as their own lines. */
export interface DokuChargeTotals {
  discountTotal?: number | null
  shippingTotal?: number | null
  taxTotal?: number | null
}

/** What is still owed on the order — the only amount ever charged. */
export function dokuRemainingAmountFor(
  order: Pick<DokuChargeOrder, 'grandTotal' | 'amountPaid'>,
): number {
  return Math.max(0, order.grandTotal - (order.amountPaid ?? 0))
}

/**
 * DOKU's customer phone format: country code + number, no leading plus.
 *
 * Several channels (paylater, direct debit) reject a local `08…` number, so a
 * leading zero is rewritten to Indonesia's `62`; a `+62` is accepted and
 * stripped. Anything else is passed through as digits, or omitted when there
 * is nothing usable — an omitted phone never fails a charge, a malformed one
 * can.
 */
export function dokuCustomerPhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined
  const compact = phone.trim().replace(/[\s\-().]/g, '')
  if (!compact) return undefined
  const digits = compact.replace(/\D/g, '')
  if (!digits) return undefined
  if (digits.startsWith('0')) return `62${digits.slice(1)}`.slice(0, 16)
  if (digits.startsWith('62')) return digits.slice(0, 16)
  return digits.slice(0, 16)
}

export interface BuildDokuCheckoutInput {
  order: DokuChargeOrder
  /** One of `DOKU_CHECKOUT_CHANNELS`; omitted lets the buyer choose on DOKU. */
  channel?: string | null
  lines: readonly DokuChargeLine[]
  totals?: DokuChargeTotals
  /** Where DOKU sends the buyer after paying — informational only, never trusted. */
  returnUrl?: string
  /**
   * The webhook endpoint. DOKU's `override_notification_url` only changes the
   * host: its path must match the Notification URL configured in the DOKU
   * dashboard, or the override is ignored.
   */
  callbackUrl?: string
  /** Checkout page lifetime in minutes; DOKU defaults to 60 when omitted. */
  expiresInMinutes?: number
  /**
   * The gateway reference a previous charge left on the order. A re-charge
   * appends an attempt token — DOKU treats `invoice_number` as unique.
   * See `chargeAttemptReference`.
   */
  existingPaymentReference?: string | null
}

/**
 * Build the `POST /checkout/v1/payment` body for the order's remaining
 * balance.
 *
 * `invoice_number` is the PayKit `orderNumber` — the contract the webhook and
 * status API settle on — with an attempt token appended when the order is
 * being re-charged. `line_items` mirrors the order's own composition only when
 * it adds up exactly; any discount or part-payment collapses the basket to one
 * `Pembayaran pesanan …` line, since DOKU requires the sum to equal
 * `order.amount`.
 */
export function buildDokuCheckoutBody({
  order,
  channel,
  lines,
  totals,
  returnUrl,
  callbackUrl,
  expiresInMinutes,
  existingPaymentReference,
}: BuildDokuCheckoutInput): DokuCreateCheckoutRequest {
  const remaining = dokuRemainingAmountFor(order)

  const hasAdjustments = (totals?.discountTotal ?? 0) > 0 || (order.amountPaid ?? 0) > 0
  const linesSum =
    lines.reduce((acc, line) => acc + line.unitPrice * line.quantity, 0) +
    (totals?.shippingTotal ?? 0) +
    (totals?.taxTotal ?? 0)

  let lineItems: DokuLineItem[] | undefined
  if (!hasAdjustments && linesSum === remaining && lines.length > 0) {
    const detailed: DokuLineItem[] = lines
      .filter((line) => line.quantity > 0 && line.unitPrice > 0)
      .map((line, index) => ({
        id: `item-${index + 1}`,
        name: line.description.trim().slice(0, 255) || `Item ${index + 1}`,
        quantity: line.quantity,
        price: line.unitPrice,
      }))
    if ((totals?.shippingTotal ?? 0) > 0) {
      detailed.push({
        id: 'shipping',
        name: 'Ongkos kirim',
        quantity: 1,
        price: totals!.shippingTotal!,
      })
    }
    if ((totals?.taxTotal ?? 0) > 0) {
      detailed.push({ id: 'tax', name: 'Pajak', quantity: 1, price: totals!.taxTotal! })
    }
    if (detailed.reduce((acc, item) => acc + item.price * item.quantity, 0) === remaining) {
      lineItems = detailed
    }
  }

  lineItems ??= [
    {
      id: 'order',
      name: `Pembayaran pesanan ${order.orderNumber}`.slice(0, 255),
      quantity: 1,
      price: remaining,
    },
  ]

  const paymentMethod = channel?.trim()
  const callback = returnUrl?.trim()

  return {
    order: {
      amount: remaining,
      invoice_number: chargeAttemptReference(order.orderNumber, existingPaymentReference),
      currency: 'IDR',
      language: 'ID',
      ...(callback
        ? {
            callback_url: callback,
            callback_url_result: callback,
            auto_redirect: true,
          }
        : {}),
      line_items: lineItems,
    },
    payment: {
      type: 'SALE',
      ...(typeof expiresInMinutes === 'number' && Number.isFinite(expiresInMinutes)
        ? { payment_due_date: Math.max(1, Math.floor(expiresInMinutes)) }
        : {}),
      ...(paymentMethod ? { payment_method_types: [paymentMethod] } : {}),
    },
    customer: {
      // DOKU documents the name as alphabetic for some channels; keep it
      // short and let the provider validate the rest.
      name: order.customerName.trim().slice(0, 255) || order.orderNumber,
      ...(order.customerEmail ? { email: order.customerEmail } : {}),
      ...(() => {
        const phone = dokuCustomerPhone(order.customerPhone)
        return phone ? { phone } : {}
      })(),
      country: 'ID',
    },
    ...(callbackUrl?.trim()
      ? { additional_info: { override_notification_url: callbackUrl.trim() } }
      : {}),
  }
}

/**
 * DOKU's `response.payment.expired_date` (`yyyyMMddHHmmss`, UTC+7) as Unix
 * seconds, or `null` when the value is not in that shape.
 */
export function dokuExpiryUnixSeconds(value: string | null | undefined): number | null {
  if (!value || !/^\d{14}$/.test(value.trim())) return null
  const compact = value.trim()
  const year = Number(compact.slice(0, 4))
  const month = Number(compact.slice(4, 6))
  const day = Number(compact.slice(6, 8))
  const hour = Number(compact.slice(8, 10))
  const minute = Number(compact.slice(10, 12))
  const second = Number(compact.slice(12, 14))
  // DOKU states the wall clock in WIB (UTC+7); shift back to UTC before
  // converting to an epoch.
  const millis = Date.UTC(year, month - 1, day, hour, minute, second) - 7 * 3_600_000
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null
}
