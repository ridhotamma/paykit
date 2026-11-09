/**
 * What a reconciled Aulaa payment does to an order — decided here, applied by
 * the webhook app.
 *
 * Aulaa's webhook names the merchant `order_id` but not Aulaa's invoice id, so
 * the safe flow is: verify the signature, resolve the order, read the payment
 * back through `GET /v1/payments/{id}` with the stored reference, then plan
 * from that answer. The callback's own `status`/`amount` are never trusted as
 * the settlement verdict.
 *
 * The rules mirror the other PayKit planners:
 *
 *   - **Idempotent.** A payment delivered twice lands on "already recorded"
 *     once the ledger already covers its amount.
 *   - **Conservative.** Anything that does not add up is a no-op with a
 *     reason, never an invented status.
 *   - **Clamped.** Credit never exceeds the order's remaining balance.
 *   - **Status-gated.** Only `paid` moves money; `pending`, `expired`,
 *     `cancelled`, `failed` and `refunded` are no-ops.
 */

import {
  canTransitionOrder,
  paymentStatusFor,
  type OrderPaymentStatus,
  type OrderStatus,
} from '../order-status'

import { aulaaChannelLabel } from './index'

/** The order fields the planner reads — the `orders` document supplies these. */
export interface PayableAulaaOrder {
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  amountPaid: number
  grandTotal: number
  /** The Aulaa invoice id already recorded on this order, if any. */
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** The reconciled payment the planner is asked about, in rupiah. */
export interface AulaaReconciledPayment {
  /** Aulaa's invoice id — the idempotency key. */
  id: string
  /** The order's nominal amount; `charged_amount` includes any buyer fee. */
  amount: number
  /** Raw status from the API (`pending`, `paid`, `expired`, …). */
  status: string
  /** The method code Aulaa recorded (`qris`, `bca_va`, …). */
  payment_method?: string | null
}

export type AulaaPaymentSkipReason =
  | 'already_recorded'
  | 'already_settled'
  | 'transaction_not_paid'
  | 'non_positive_amount'
  | 'order_not_payable'

export type AulaaPaymentPlan =
  | { action: 'noop'; reason: AulaaPaymentSkipReason }
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

/**
 * Plan the write one reconciled Aulaa payment produces.
 *
 * `payment.amount` is credited, not `charged_amount`: the latter includes the
 * service fee when Aulaa passes it to the buyer, and the order ledger must
 * only ever receive what the order was actually billed for.
 */
export function planAulaaPaymentUpdate(
  order: PayableAulaaOrder,
  payment: AulaaReconciledPayment,
  now: Date = new Date(),
): AulaaPaymentPlan {
  if (
    order.paymentReference &&
    order.paymentReference === payment.id &&
    (order.amountPaid || 0) >= payment.amount
  ) {
    return { action: 'noop', reason: 'already_recorded' }
  }
  if (payment.status.trim().toLowerCase() !== 'paid') {
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

  const channelLabel = payment.payment_method
    ? (aulaaChannelLabel(payment.payment_method) ?? payment.payment_method)
    : null
  const methodLabel = channelLabel ?? 'Aulaa'

  return {
    action: 'apply',
    amountPaid,
    paymentStatus,
    orderStatus,
    paidAt: paymentStatus === 'paid' && !order.paidAt ? now.toISOString() : null,
    paymentReference: payment.id,
    paymentMethod: order.paymentMethod === methodLabel ? null : methodLabel,
  }
}
