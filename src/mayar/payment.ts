/**
 * What a reconciled Mayar payment does to an order — decided here, applied
 * by the webhook app.
 *
 * The rules are pure on purpose: they touch no database and no clock they
 * are not handed, so the one code path that moves money can be reasoned
 * about — and replayed against a stored callback — without Appwrite. The
 * webhook app resolves the order, reconciles the transaction, calls this,
 * and writes exactly the patch the plan describes; it never improvises its
 * own arithmetic.
 *
 * Three properties matter more than any single rule:
 *
 *   - **Idempotent.** Mayar re-delivers webhooks and cannot tell our `200`
 *     from a lost one. A callback that arrives twice must land on
 *     "already recorded" and change nothing — hence the `paymentReference`
 *     comparison combined with the ledger check (the storefront stamps the
 *     invoice id at checkout, so a matching reference alone only proves the
 *     payment exists), which stays correct even for split payments (a first
 *     transaction settles part of the order, a second settles the rest).
 *   - **Conservative.** A transaction that cannot be applied is a no-op
 *     with a reason, never an update: bytes stay in `webhook_logs` for a
 *     human, and no status is invented for an order the state machine does
 *     not know.
 *   - **Clamped.** The credited amount never exceeds the order's remaining
 *     balance, so a mis-scoped payment link cannot push the ledger past
 *     what was actually invoiced.
 */

import {
  canTransitionOrder,
  paymentStatusFor,
  type OrderPaymentStatus,
  type OrderStatus,
} from '../order-status'

/** The order fields the planner reads — the `orders` document supplies these. */
export interface PayableMayarOrder {
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  amountPaid: number
  grandTotal: number
  /** The Mayar transaction/invoice id already recorded on this order, if any. */
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** The reconciled Mayar transaction the planner is asked about. */
export interface MayarPaymentTransaction {
  id: string
  amount: number
  status: string
  paymentMethod?: string | null
}

export type MayarPaymentSkipReason =
  | 'already_recorded'
  | 'already_settled'
  | 'transaction_not_paid'
  | 'non_positive_amount'
  | 'order_not_payable'

/**
 * The outcome for one transaction against one order.
 *
 * `apply` is an absolute patch: `amountPaid` is the new total received (not
 * a delta), `orderStatus` is `null` when the lifecycle status does not move,
 * `paidAt` is set only at the moment the order first completes payment, and
 * `paymentReference` records the Mayar transaction id for idempotency.
 * `paymentMethod` is the label snapshot (`QRIS`), set whenever it
 * differs — the same way a seller's manual recording overwrites the label.
 */
export type MayarPaymentPlan =
  | { action: 'noop'; reason: MayarPaymentSkipReason }
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
 * Plan the write one reconciled Mayar transaction produces.
 *
 * The transaction's `status` must be `paid` — the webhook's own claim is
 * never trusted on its own; callers reconcile via `transactions.get` first.
 * The credited amount is clamped to the remaining balance, because the
 * ledger staying truthful beats arithmetic amplifying someone's mistake.
 */
export function planMayarPaymentUpdate(
  order: PayableMayarOrder,
  transaction: MayarPaymentTransaction,
  now: Date = new Date(),
): MayarPaymentPlan {
  // A matching reference alone proves the payment was *created*, not settled:
  // the storefront stamps the invoice id at checkout, and the reconciled
  // transaction echoes that same id back. It is a replay only when the
  // ledger already reflects this transaction's amount.
  if (
    order.paymentReference &&
    order.paymentReference === transaction.id &&
    (order.amountPaid || 0) >= transaction.amount
  ) {
    return { action: 'noop', reason: 'already_recorded' }
  }
  const normalizedStatus = transaction.status.trim().toLowerCase()
  if (
    normalizedStatus !== 'paid' &&
    normalizedStatus !== 'success' &&
    normalizedStatus !== 'settled'
  ) {
    return { action: 'noop', reason: 'transaction_not_paid' }
  }
  if (!Number.isInteger(transaction.amount) || transaction.amount <= 0) {
    return { action: 'noop', reason: 'non_positive_amount' }
  }
  if (UNPAYABLE_ORDER_STATUSES.has(order.status)) {
    return { action: 'noop', reason: 'order_not_payable' }
  }

  const remaining = Math.max(0, order.grandTotal - (order.amountPaid || 0))
  if (remaining <= 0) {
    return { action: 'noop', reason: 'already_settled' }
  }

  const credited = Math.min(transaction.amount, remaining)
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
  // alone. The bare provider name stays the fallback when no channel is
  // known, where it is the only thing known.
  const methodLabel = transaction.paymentMethod || 'Mayar'

  return {
    action: 'apply',
    amountPaid,
    paymentStatus,
    orderStatus,
    paidAt: paymentStatus === 'paid' && !order.paidAt ? now.toISOString() : null,
    paymentReference: transaction.id,
    paymentMethod: order.paymentMethod === methodLabel ? null : methodLabel,
  }
}
