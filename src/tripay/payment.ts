/**
 * What a verified TriPay callback does to an order — decided here, applied
 * by the webhook app.
 *
 * TriPay sends HMAC-SHA256 signature in X-Callback-Signature header over the
 * raw JSON body using the merchant's privateKey.
 */

import {
  canTransitionOrder,
  paymentStatusFor,
  type OrderPaymentStatus,
  type OrderStatus,
} from '../order-status'

import { tripayChannelLabel } from './index'

/** The order fields the planner reads — the `orders` document supplies these. */
export interface PayableOrder {
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  amountPaid: number
  grandTotal: number
  /** The TriPay `reference` already recorded on this order, if any. */
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** The verified callback the planner is asked about. */
export interface TripayPaymentCallback {
  /** TriPay's transaction reference — the idempotency key. */
  reference: string
  /** The merchant reference (order number). */
  merchantRef: string
  /** Payment method code (e.g. BRIVA, QRIS). */
  paymentMethod?: string | null
  /** Total amount paid in integer IDR. */
  amount: number
  /** Status string: 'PAID' | 'EXPIRED' | 'FAILED' | 'REFUND' etc. */
  status: string
  /** Paid timestamp in unix seconds, if available. */
  paidAt?: number | null
}

export type TripayPaymentSkipReason =
  | 'already_recorded'
  | 'already_settled'
  | 'transaction_not_paid'
  | 'non_positive_amount'
  | 'order_not_payable'

/**
 * The outcome for one callback against one order.
 */
export type TripayPaymentPlan =
  | { action: 'noop'; reason: TripayPaymentSkipReason }
  | {
      action: 'apply'
      amountPaid: number
      paymentStatus: OrderPaymentStatus
      orderStatus: OrderStatus | null
      paidAt: string | null
      paymentReference: string
      paymentMethod: string | null
    }

const UNPAYABLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'draft',
  'cancelled',
  'refunded',
])

/**
 * Plan the write one verified callback produces.
 */
export function planTripayPaymentUpdate(
  order: PayableOrder,
  callback: TripayPaymentCallback,
  now: Date = new Date(),
): TripayPaymentPlan {
  // A matching reference alone proves the payment was *created*, not settled:
  // the storefront stamps the inquiry reference at checkout so the shopper
  // sees their pay code, and the gateway echoes that same reference back.
  // It is a replay only when the ledger already reflects this callback's amount.
  if (
    order.paymentReference &&
    order.paymentReference === callback.reference &&
    (order.amountPaid || 0) >= callback.amount
  ) {
    return { action: 'noop', reason: 'already_recorded' }
  }
  if (callback.status.toUpperCase() !== 'PAID') {
    return { action: 'noop', reason: 'transaction_not_paid' }
  }
  if (!Number.isInteger(callback.amount) || callback.amount <= 0) {
    return { action: 'noop', reason: 'non_positive_amount' }
  }
  if (UNPAYABLE_ORDER_STATUSES.has(order.status)) {
    return { action: 'noop', reason: 'order_not_payable' }
  }

  const remaining = Math.max(0, order.grandTotal - (order.amountPaid || 0))
  if (remaining <= 0) {
    return { action: 'noop', reason: 'already_settled' }
  }

  const credited = Math.min(callback.amount, remaining)
  const amountPaid = (order.amountPaid || 0) + credited
  const paymentStatus = paymentStatusFor(amountPaid, order.grandTotal)

  const orderStatus: OrderStatus | null =
    order.status === 'pending' &&
    paymentStatus === 'paid' &&
    canTransitionOrder(order.status, 'paid')
      ? 'paid'
      : null

  const channelLabel = callback.paymentMethod
    ? (tripayChannelLabel(callback.paymentMethod) ?? callback.paymentMethod)
    : null
  // Stored without the provider prefix — the order page shows the channel
  // alone. The bare provider name stays the fallback for an unknown channel,
  // where it is the only thing known.
  const methodLabel = channelLabel ?? 'Tripay'

  let paidAtString: string | null = null
  if (paymentStatus === 'paid') {
    if (callback.paidAt && Number.isFinite(callback.paidAt) && callback.paidAt > 0) {
      paidAtString = new Date(callback.paidAt * 1000).toISOString()
    } else if (!order.paidAt) {
      paidAtString = now.toISOString()
    } else {
      paidAtString = order.paidAt
    }
  }

  return {
    action: 'apply',
    amountPaid,
    paymentStatus,
    orderStatus,
    paidAt: paidAtString,
    paymentReference: callback.reference,
    paymentMethod: order.paymentMethod === methodLabel ? null : methodLabel,
  }
}
