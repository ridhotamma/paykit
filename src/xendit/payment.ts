/**
 * What a verified Xendit invoice does to an order — decided here, applied
 * by the webhook app.
 *
 * The rules mirror the Duitku planner (`planOrderPaymentUpdate`) and differ
 * only where Xendit's API differs: the verdict is the session's `status`
 * (`COMPLETED` for Payment Sessions; `PAID`/`SETTLED` for a legacy invoice
 * once the funds clear — all settle, since the money is the buyer's either
 * way), and the idempotency key is the session/invoice id (stable across
 * re-deliveries, unlike the order reference which names the order on every
 * payment for it).
 *
 * The rules are pure on purpose: they touch no database and no clock they
 * are not handed, so the one code path that moves money can be reasoned
 * about — and replayed against a stored callback — without Appwrite. The
 * webhook app resolves the order, calls this, and writes exactly the patch
 * the plan describes; it never improvises its own arithmetic.
 *
 * Four properties matter more than any single rule:
 *
 *   - **Idempotent.** Xendit retries a callback until it answers 2xx. An
 *     invoice that arrives twice must land on "already recorded" and change
 *     nothing — hence the invoice-id comparison *combined with the ledger
 *     check*: the storefront stamps the invoice id at checkout, so a
 *     matching reference only proves the payment exists. It counts as
 *     recorded once `amountPaid` already covers the invoice's amount.
 *   - **Conservative.** An invoice that cannot be applied is a no-op with a
 *     reason, never an update: bytes stay in `webhook_logs` for a human,
 *     and no status is invented for an order the state machine does not
 *     know.
 *   - **Clamped.** The credited amount never exceeds the order's remaining
 *     balance, so a mis-scoped invoice cannot push the ledger past what was
 *     actually invoiced.
 *   - **Status-gated.** Only `COMPLETED` (Payment Sessions) or
 *     `PAID`/`SETTLED` (a legacy invoice) moves money: a `PENDING`,
 *     `ACTIVE`, `CANCELED` or `EXPIRED` payment is a normal callback that
 *     leaves the order untouched.
 */

import {
  canTransitionOrder,
  paymentStatusFor,
  type OrderPaymentStatus,
  type OrderStatus,
} from '../order-status'

import { xenditChannelLabel } from './index'

/** The order fields the planner reads — the `orders` document supplies these. */
export interface PayableXenditOrder {
  status: OrderStatus
  paymentStatus: OrderPaymentStatus
  amountPaid: number
  grandTotal: number
  /** The Xendit invoice id already recorded on this order, if any. */
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** The reconciled payment the planner is asked about, in minor units. */
export interface XenditPaymentInvoice {
  /** The session (or legacy invoice) id — the idempotency key. */
  id: string
  /** Integer minor units, already parsed from the payment. */
  amount: number
  /** `COMPLETED` (session) or `PAID`/`SETTLED` (legacy) settle; anything else is a no-op. */
  status: string
  /** The channel echo (`BCA`, `QRIS`, `ALFAMART`, …) for the method label. */
  paymentChannel?: string | null
}

export type XenditPaymentSkipReason =
  | 'already_recorded'
  | 'already_settled'
  | 'transaction_not_paid'
  | 'non_positive_amount'
  | 'order_not_payable'

/**
 * The outcome for one invoice against one order.
 *
 * `apply` is an absolute patch: `amountPaid` is the new total received (not
 * a delta), `orderStatus` is `null` when the lifecycle status does not move,
 * `paidAt` is set only at the moment the order first completes payment, and
 * `paymentReference` records the invoice id for idempotency.
 * `paymentMethod` is the label snapshot, set whenever it differs — the same
 * way a seller's manual recording overwrites the label.
 */
export type XenditPaymentPlan =
  | { action: 'noop'; reason: XenditPaymentSkipReason }
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
 * Plan the write one reconciled Xendit invoice produces.
 *
 * The invoice's amount is credited on top of whatever the order had already
 * received, clamped to the remaining balance — because a shop can
 * legitimately record a part payment by hand and let the gateway settle
 * the rest, and because a replayed callback must never push the ledger
 * past what was invoiced.
 */
export function planXenditPaymentUpdate(
  order: PayableXenditOrder,
  invoice: XenditPaymentInvoice,
  now: Date = new Date(),
): XenditPaymentPlan {
  // A matching reference alone proves the payment was *created*, not settled:
  // the storefront stamps the invoice id at checkout so the shopper sees
  // their checkout page, and the reconciled invoice echoes that same id
  // back. It is a replay only when the ledger already reflects this
  // invoice's amount.
  if (
    order.paymentReference &&
    order.paymentReference === invoice.id &&
    (order.amountPaid || 0) >= invoice.amount
  ) {
    return { action: 'noop', reason: 'already_recorded' }
  }
  const normalizedStatus = invoice.status.trim().toUpperCase()
  if (
    normalizedStatus !== 'COMPLETED' &&
    normalizedStatus !== 'PAID' &&
    normalizedStatus !== 'SETTLED'
  ) {
    return { action: 'noop', reason: 'transaction_not_paid' }
  }
  if (!Number.isInteger(invoice.amount) || invoice.amount <= 0) {
    return { action: 'noop', reason: 'non_positive_amount' }
  }
  if (UNPAYABLE_ORDER_STATUSES.has(order.status)) {
    return { action: 'noop', reason: 'order_not_payable' }
  }

  const remaining = Math.max(0, order.grandTotal - (order.amountPaid || 0))
  if (remaining <= 0) {
    return { action: 'noop', reason: 'already_settled' }
  }

  const credited = Math.min(invoice.amount, remaining)
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

  const channelLabel = invoice.paymentChannel
    ? (xenditChannelLabel(invoice.paymentChannel) ?? invoice.paymentChannel)
    : null
  // Stored without the provider prefix — the order page shows the channel
  // alone. The bare provider name stays the fallback for an unknown channel,
  // where it is the only thing known.
  const methodLabel = channelLabel ?? 'Xendit'

  return {
    action: 'apply',
    amountPaid,
    paymentStatus,
    orderStatus,
    paidAt: paymentStatus === 'paid' && !order.paidAt ? now.toISOString() : null,
    paymentReference: invoice.id,
    paymentMethod: order.paymentMethod === methodLabel ? null : methodLabel,
  }
}
