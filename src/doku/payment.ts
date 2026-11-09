/**
 * What a reconciled DOKU transaction does to an order — decided here, applied
 * by the webhook app.
 *
 * DOKU notifications and the status API share one transaction shape. The
 * verification proves the callback is real, but settlement still reads the
 * transaction back through `GET /orders/v1/status/{invoice_number}` first, so
 * the planner is handed the API's answer rather than the callback's claims.
 *
 * The rules mirror the other PayKit planners:
 *
 *   - **Idempotent.** A transaction delivered twice lands on "already
 *     recorded" once the ledger already covers its amount.
 *   - **Conservative.** Anything that does not add up is a no-op with a
 *     reason, never an invented status.
 *   - **Clamped.** Credit never exceeds the order's remaining balance.
 *   - **Status-gated.** Only `SUCCESS` moves money; `PENDING`, `FAILED`,
 *     `EXPIRED`, `TIMEOUT`, `REDIRECT` and `REFUNDED` are no-ops.
 */

import {
  canTransitionOrder,
  paymentStatusFor,
  type OrderPaymentStatus,
  type OrderStatus,
} from '../order-status'

import { dokuChannelLabel } from './index'

/** The order fields the planner reads — the `orders` document supplies these. */
export interface PayableDokuOrder {
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  amountPaid: number
  grandTotal: number
  /** The DOKU invoice number already recorded on this order, if any. */
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** The reconciled transaction the planner is asked about, in rupiah. */
export interface DokuReconciledPayment {
  /** The merchant invoice number — the idempotency key DOKU echoes. */
  invoiceNumber: string
  /** Integer rupiah, already parsed from the status response. */
  amount: number
  /** Raw `transaction.status` (`SUCCESS`, `PENDING`, `EXPIRED`, …). */
  status: string
  /** `channel.id` (`VIRTUAL_ACCOUNT_BCA`, `QRIS`, …) for the method label. */
  channel?: string | null
}

export type DokuPaymentSkipReason =
  | 'already_recorded'
  | 'already_settled'
  | 'transaction_not_paid'
  | 'non_positive_amount'
  | 'order_not_payable'

export type DokuPaymentPlan =
  | { action: 'noop'; reason: DokuPaymentSkipReason }
  | {
      action: 'apply'
      amountPaid: number
      paymentStatus: OrderPaymentStatus
      orderStatus: OrderStatus | null
      paidAt: string | null
      paymentReference: string
      paymentMethod: string | null
    }

/**
 * Order statuses a gateway payment can never land on.
 *
 * A `draft` is not an order yet, and a `cancelled`/`refunded` one is closed —
 * money that arrives for these is a real-world problem for the seller, not a
 * state this planner may invent.
 */
const UNPAYABLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'draft',
  'cancelled',
  'refunded',
])

/** Plan the write one reconciled DOKU transaction produces. */
export function planDokuPaymentUpdate(
  order: PayableDokuOrder,
  payment: DokuReconciledPayment,
  now: Date = new Date(),
): DokuPaymentPlan {
  if (
    order.paymentReference &&
    order.paymentReference === payment.invoiceNumber &&
    (order.amountPaid || 0) >= payment.amount
  ) {
    return { action: 'noop', reason: 'already_recorded' }
  }
  if (payment.status.trim().toUpperCase() !== 'SUCCESS') {
    return { action: 'noop', reason: 'transaction_not_paid' }
  }
  if (!Number.isInteger(payment.amount) || payment.amount <= 0) {
    return { action: 'noop', reason: 'non_positive_amount' }
  }
  if (UNPAYABLE_ORDER_STATUSES.has(order.status)) {
    return { action: 'noop', reason: 'order_not_payable' }
  }

  const remaining = Math.max(0, order.grandTotal - (order.amountPaid || 0))
  if (remaining <= 0) {
    return { action: 'noop', reason: 'already_settled' }
  }

  const credited = Math.min(payment.amount, remaining)
  const amountPaid = (order.amountPaid || 0) + credited
  const paymentStatus = paymentStatusFor(amountPaid, order.grandTotal)

  const orderStatus: OrderStatus | null =
    order.status === 'pending' &&
    paymentStatus === 'paid' &&
    canTransitionOrder(order.status, 'paid')
      ? 'paid'
      : null

  const channelLabel = payment.channel
    ? (dokuChannelLabel(payment.channel) ?? payment.channel)
    : null
  const methodLabel = channelLabel ?? 'DOKU'

  return {
    action: 'apply',
    amountPaid,
    paymentStatus,
    orderStatus,
    paidAt: paymentStatus === 'paid' && !order.paidAt ? now.toISOString() : null,
    paymentReference: payment.invoiceNumber,
    paymentMethod: order.paymentMethod === methodLabel ? null : methodLabel,
  }
}
