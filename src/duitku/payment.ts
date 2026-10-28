/**
 * What a verified Duitku callback does to an order — decided here, applied
 * by the webhook app.
 *
 * The rules mirror the Mayar planner (`planMayarPaymentUpdate`) and differ
 * only where Duitku's callback differs from Mayar's reconcile-then-apply
 * flow: the HMAC-SHA256 signature *is* the verification (there is no
 * transaction lookup to do first), the callback's `resultCode` is the paid
 * verdict, and `reference` is the idempotency key. Success (`00`) settles
 * against the order's remaining balance; anything else is a no-op.
 *
 * The rules are pure on purpose: they touch no database and no clock they
 * are not handed, so the one code path that moves money can be reasoned
 * about — and replayed against a stored callback — without Appwrite. The
 * webhook app resolves the order, calls this, and writes exactly the patch
 * the plan describes; it never improvises its own arithmetic.
 *
 * Four properties matter more than any single rule:
 *
 *   - **Idempotent.** Duitku retries a callback up to five times and cannot
 *     tell our `200` from a lost one. A callback that arrives twice must land
 *     on "already recorded" and change nothing — hence the `paymentReference`
 *     comparison *combined with the ledger check*: the storefront stamps the
 *     inquiry reference at checkout, so a matching reference only proves the
 *     payment exists. It counts as recorded once `amountPaid` already covers
 *     the callback's amount, which also covers split payments (a first
 *     callback settles part of the order, a second settles the rest) and a
 *     Duitku-side reference reuse that would otherwise double-credit.
 *   - **Conservative.** A callback that cannot be applied is a no-op
 *     with a reason, never an update: bytes stay in `webhook_logs` for a
 *     human, and no status is invented for an order the state machine does
 *     not know.
 *   - **Clamped.** The credited amount never exceeds the order's remaining
 *     balance, so a mis-scoped or replayed callback cannot push the ledger
 *     past what was actually invoiced.
 *   - **Status-gated.** Only `resultCode == '00'` moves money: a failed or
 *     expired attempt (`01`) is a normal callback that leaves the order
 *     untouched.
 */

import {
  canTransitionOrder,
  paymentStatusFor,
  type OrderPaymentStatus,
  type OrderStatus,
} from '../order-status'

import { duitkuChannelLabel } from './index'

/** The order fields the planner reads — the `orders` document supplies these. */
export interface PayableOrder {
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  amountPaid: number
  grandTotal: number
  /** The Duitku `reference` already recorded on this order, if any. */
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** The verified callback the planner is asked about. */
export interface DuitkuPaymentCallback {
  /** Duitku's transaction reference — the idempotency key. */
  reference: string
  /** Integer minor units, already parsed from the callback's `amount` string. */
  amount: number
  /** `00` success; anything else is a failed or expired attempt. */
  resultCode: string
  /** The channel code used, echoed back as `paymentCode`. */
  paymentCode?: string | null
}

export type DuitkuPaymentSkipReason =
  | 'already_recorded'
  | 'already_settled'
  | 'transaction_not_paid'
  | 'non_positive_amount'
  | 'order_not_payable'

/**
 * The outcome for one callback against one order.
 *
 * `apply` is an absolute patch: `amountPaid` is the new total received (not
 * a delta), `orderStatus` is `null` when the lifecycle status does not move,
 * `paidAt` is set only at the moment the order first completes payment, and
 * `paymentReference` records the callback's reference for idempotency.
 * `paymentMethod` is the label snapshot (`BCA Virtual Account`), set
 * whenever it differs — the same way a seller's manual recording overwrites
 * the label.
 */
export type DuitkuPaymentPlan =
  | { action: 'noop'; reason: DuitkuPaymentSkipReason }
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
 * Plan the write one verified callback produces.
 *
 * The callback's `amount` is credited on top of whatever the order had
 * already received, clamped to the remaining balance — because a shop can
 * legitimately record a part payment by hand and let the gateway settle
 * the rest, and because a replayed callback must never push the ledger
 * past what was invoiced.
 */
export function planOrderPaymentUpdate(
  order: PayableOrder,
  callback: DuitkuPaymentCallback,
  now: Date = new Date(),
): DuitkuPaymentPlan {
  // A matching reference alone proves the payment was *created*, not settled:
  // the storefront stamps the inquiry reference at checkout so the shopper
  // sees their pay code, and the gateway echoes that same reference back on
  // the callback. It is a replay only when the ledger already reflects this
  // callback's amount.
  if (
    order.paymentReference &&
    order.paymentReference === callback.reference &&
    (order.amountPaid || 0) >= callback.amount
  ) {
    return { action: 'noop', reason: 'already_recorded' }
  }
  if (callback.resultCode !== '00') {
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

  const channelLabel = callback.paymentCode
    ? (duitkuChannelLabel(callback.paymentCode) ?? callback.paymentCode)
    : null
  // Stored without the provider prefix — the order page shows the channel
  // alone. The bare provider name stays the fallback for an unknown channel,
  // where it is the only thing known.
  const methodLabel = channelLabel ?? 'Duitku'

  return {
    action: 'apply',
    amountPaid,
    paymentStatus,
    orderStatus,
    paidAt: paymentStatus === 'paid' && !order.paidAt ? now.toISOString() : null,
    paymentReference: callback.reference,
    paymentMethod: order.paymentMethod === methodLabel ? null : methodLabel,
  }
}
