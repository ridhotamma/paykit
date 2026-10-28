/**
 * What a reconciled PayPal capture does to an order — decided here, applied
 * by the webhook app.
 *
 * The rules mirror the Mayar/Duitku planners and differ only where PayPal's
 * API differs: the verdict is the capture's `status` (`COMPLETED`), the
 * idempotency key is the capture id (stable across re-deliveries, unlike the
 * order id which survives void-and-recreate), and the amount arrives as a
 * decimal string in the charge currency that must parse back into the
 * ledger's minor units.
 *
 * The rules are pure on purpose: they touch no database and no clock they
 * are not handed, so the one code path that moves money can be reasoned
 * about — and replayed against a stored callback — without Appwrite. The
 * webhook app resolves the order, calls this, and writes exactly the patch
 * the plan describes; it never improvises its own arithmetic.
 *
 * Four properties matter more than any single rule:
 *
 *   - **Idempotent.** PayPal re-delivers webhooks until they answer 2xx. A
 *     capture that arrives twice must land on "already recorded" and change
 *     nothing — hence the capture-id comparison *combined with the ledger
 *     check*: the storefront stamps the order id at checkout, so a matching
 *     reference only proves the payment exists. It counts as recorded once
 *     `amountPaid` already covers the capture's amount.
 *   - **Conservative.** A capture that cannot be applied is a no-op with a
 *     reason, never an update: bytes stay in `webhook_logs` for a human,
 *     and no status is invented for an order the state machine does not know.
 *   - **Clamped.** The credited amount never exceeds the order's remaining
 *     balance, so a mis-scoped capture cannot push the ledger past what was
 *     actually invoiced.
 *   - **Status-gated.** Only `COMPLETED` moves money: a `PENDING` or
 *     `DECLINED` capture is a normal callback that leaves the order
 *     untouched.
 */

import {
  canTransitionOrder,
  paymentStatusFor,
  type OrderPaymentStatus,
  type OrderStatus,
} from '../order-status'

/** The order fields the planner reads — the `orders` document supplies these. */
export interface PayablePaypalOrder {
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  amountPaid: number
  grandTotal: number
  /** The PayPal capture id already recorded on this order, if any. */
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** The reconciled capture the planner is asked about, in minor units. */
export interface PaypalPaymentCapture {
  /** The capture id — the idempotency key. */
  id: string
  /** Integer minor units of the charge currency, already parsed. */
  amount: number
  /** `COMPLETED` settles; anything else is a no-op. */
  status: string
  /** The channel label the adapter charged with (`PayPal`, `Credit / Debit Card`, …). */
  paymentMethod?: string | null
}

export type PaypalPaymentSkipReason =
  | 'already_recorded'
  | 'already_settled'
  | 'transaction_not_paid'
  | 'non_positive_amount'
  | 'order_not_payable'

/**
 * The outcome for one capture against one order.
 *
 * `apply` is an absolute patch: `amountPaid` is the new total received (not
 * a delta), `orderStatus` is `null` when the lifecycle status does not move,
 * `paidAt` is set only at the moment the order first completes payment, and
 * `paymentReference` records the capture id for idempotency.
 * `paymentMethod` is the label snapshot, set whenever it differs — the same
 * way a seller's manual recording overwrites the label.
 */
export type PaypalPaymentPlan =
  | { action: 'noop'; reason: PaypalPaymentSkipReason }
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
 * Plan the write one reconciled PayPal capture produces.
 *
 * The capture's `amount` is credited on top of whatever the order had
 * already received, clamped to the remaining balance — because a shop can
 * legitimately record a part payment by hand and let the gateway settle
 * the rest, and because a replayed capture must never push the ledger
 * past what was invoiced.
 */
export function planPaypalPaymentUpdate(
  order: PayablePaypalOrder,
  capture: PaypalPaymentCapture,
  now: Date = new Date(),
): PaypalPaymentPlan {
  // A matching reference alone proves the payment was *created*, not settled:
  // the storefront stamps the order id at checkout so the shopper sees their
  // approval link, and the capture echoes that same order back. It is a
  // replay only when the ledger already reflects this capture's amount.
  if (
    order.paymentReference &&
    order.paymentReference === capture.id &&
    (order.amountPaid || 0) >= capture.amount
  ) {
    return { action: 'noop', reason: 'already_recorded' }
  }
  if (capture.status.trim().toUpperCase() !== 'COMPLETED') {
    return { action: 'noop', reason: 'transaction_not_paid' }
  }
  if (!Number.isInteger(capture.amount) || capture.amount <= 0) {
    return { action: 'noop', reason: 'non_positive_amount' }
  }
  if (UNPAYABLE_ORDER_STATUSES.has(order.status)) {
    return { action: 'noop', reason: 'order_not_payable' }
  }

  const remaining = Math.max(0, order.grandTotal - (order.amountPaid || 0))
  if (remaining <= 0) {
    return { action: 'noop', reason: 'already_settled' }
  }

  const credited = Math.min(capture.amount, remaining)
  const amountPaid = (order.amountPaid || 0) + credited
  const paymentStatus = paymentStatusFor(amountPaid, order.grandTotal)

  // The lifecycle follows the ledger only at the moment payment completes:
  // `pending` moves to `paid` per the transition table. An order already in
  // `processing` (payment on delivery, then a late gateway settlement) or
  // beyond keeps its status — the money columns speak for it.
  const orderStatus: OrderStatus | null =
    order.status === 'pending' &&
    paymentStatus === 'paid' &&
    canTransitionOrder(order.status, 'paid')
      ? 'paid'
      : null

  // Stored without the provider prefix — the order page shows the channel
  // alone. The bare provider name stays the fallback for an unknown channel,
  // where it is the only thing known.
  const methodLabel = capture.paymentMethod || 'PayPal'

  return {
    action: 'apply',
    amountPaid,
    paymentStatus,
    orderStatus,
    paidAt: paymentStatus === 'paid' && !order.paidAt ? now.toISOString() : null,
    paymentReference: capture.id,
    paymentMethod: order.paymentMethod === methodLabel ? null : methodLabel,
  }
}
