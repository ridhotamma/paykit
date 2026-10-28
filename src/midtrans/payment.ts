/**
 * What a verified Midtrans transaction does to an order — decided here,
 * applied by the webhook app.
 *
 * The rules mirror the Duitku planner (`planOrderPaymentUpdate`) and differ
 * only where Midtrans' API differs: the verdict is the transaction's
 * `transaction_status` (`settlement`, or `capture` for card payments — never
 * trusted from the notification alone, always reconciled through the status
 * API first), and the idempotency key is the transaction id (stable across
 * re-deliveries, unlike the Snap token which identifies the checkout
 * session).
 *
 * The rules are pure on purpose: they touch no database and no clock they
 * are not handed, so the one code path that moves money can be reasoned
 * about — and replayed against a stored notification — without Appwrite. The
 * webhook app resolves the order, calls this, and writes exactly the patch
 * the plan describes; it never improvises its own arithmetic.
 *
 * Four properties matter more than any single rule:
 *
 *   - **Idempotent.** Midtrans retries a notification until it answers 2xx.
 *     A transaction that arrives twice must land on "already recorded" and
 *     change nothing — hence the transaction-id comparison *combined with the
 *     ledger check*: the storefront stamps the Snap token at checkout, so a
 *     matching reference only proves the payment exists. It counts as
 *     recorded once `amountPaid` already covers the transaction's amount.
 *   - **Conservative.** A transaction that cannot be applied is a no-op
 *     with a reason, never an update: bytes stay in `webhook_logs` for a
 *     human, and no status is invented for an order the state machine does
 *     not know.
 *   - **Clamped.** The credited amount never exceeds the order's remaining
 *     balance, so a mis-scoped transaction cannot push the ledger past what
 *     was actually invoiced.
 *   - **Status-gated.** Only `settlement` — or `capture` with an explicit
 *     `accept` fraud verdict — moves money: a `pending`, `deny`, `cancel`,
 *     `expire`, a challenged capture or a capture missing its verdict is a
 *     normal notification that leaves the order untouched.
 */

import {
  canTransitionOrder,
  paymentStatusFor,
  type OrderPaymentStatus,
  type OrderStatus,
} from '../order-status'

import { midtransChannelLabel } from './index'

/** The order fields the planner reads — the `orders` document supplies these. */
export interface PayableMidtransOrder {
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  amountPaid: number
  grandTotal: number
  /** The Midtrans transaction id (or Snap token) already recorded on this order, if any. */
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** The reconciled transaction the planner is asked about, in minor units. */
export interface MidtransPaymentTransaction {
  /** The Midtrans transaction id — the idempotency key. */
  id: string
  /** Integer minor units, already parsed from the status response. */
  amount: number
  /** Raw `transaction_status` (`settlement`, `capture`, `pending`, …). */
  status: string
  /** Raw `fraud_status` (`accept`, `challenge`, `deny`) — card captures only. */
  fraudStatus?: string | null
  /** Raw `payment_type` (`bank_transfer`, `qris`, `gopay`, …) for the method label. */
  paymentType?: string | null
  /**
   * The specific bank behind a generic `bank_transfer` (`bca`, `bni`, …),
   * from the status response's `va_numbers` — see `midtransBankCode`.
   */
  bank?: string | null
  /** The retail outlet for `cstore` payments (`alfamart` | `indomaret`). */
  store?: string | null
}

export type MidtransPaymentSkipReason =
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
 * `paymentReference` records the transaction id for idempotency.
 * `paymentMethod` is the label snapshot, set whenever it differs — the same
 * way a seller's manual recording overwrites the label.
 */
export type MidtransPaymentPlan =
  | { action: 'noop'; reason: MidtransPaymentSkipReason }
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
 * Plan the write one reconciled Midtrans transaction produces.
 *
 * The transaction's amount is credited on top of whatever the order had
 * already received, clamped to the remaining balance — because a shop can
 * legitimately record a part payment by hand and let the gateway settle
 * the rest, and because a replayed notification must never push the ledger
 * past what was invoiced.
 */
export function planMidtransPaymentUpdate(
  order: PayableMidtransOrder,
  transaction: MidtransPaymentTransaction,
  now: Date = new Date(),
): MidtransPaymentPlan {
  // A matching reference alone proves the payment was *created*, not settled:
  // the storefront stamps the Snap token at checkout so the shopper sees
  // their checkout page, and the reconciled transaction echoes the gateway's
  // own transaction id back. It is a replay only when the ledger already
  // reflects this transaction's amount.
  if (
    order.paymentReference &&
    order.paymentReference === transaction.id &&
    (order.amountPaid || 0) >= transaction.amount
  ) {
    return { action: 'noop', reason: 'already_recorded' }
  }
  const normalizedStatus = transaction.status.trim().toLowerCase()
  const normalizedFraud = transaction.fraudStatus?.trim().toLowerCase() ?? null
  // Card captures settle only with an explicit `accept` fraud verdict — a
  // challenged or denied capture is held, and a missing verdict is never
  // treated as approval.
  const settled =
    normalizedStatus === 'settlement' ||
    (normalizedStatus === 'capture' && normalizedFraud === 'accept')
  if (!settled) {
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

  // `payment_type` alone cannot name the channel: every bank transfer is
  // `bank_transfer` and every outlet is `cstore`. The status response carries
  // the specific bank (`va_numbers`) and outlet (`store`) alongside, so those
  // resolve the label instead — `BCA Virtual Account`, not `bank_transfer`.
  const normalizedPaymentType = transaction.paymentType?.trim().toUpperCase() ?? null
  // A generic type with no specific behind it names nothing — the caller
  // falls back to the bare provider name rather than storing `bank_transfer`.
  const labelSource =
    normalizedPaymentType === 'BANK_TRANSFER'
      ? (transaction.bank ?? null)
      : normalizedPaymentType === 'CSTORE'
        ? (transaction.store ?? null)
        : transaction.paymentType
  const channelLabel = labelSource ? (midtransChannelLabel(labelSource) ?? labelSource) : null
  // Stored without the provider prefix — the order page shows the channel
  // alone. The bare provider name stays the fallback for an unknown channel,
  // where it is the only thing known.
  const methodLabel = channelLabel ?? 'Midtrans'

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
