/**
 * Order lifecycle primitives the payment adapters depend on.
 *
 * Gateways do not settle money in the abstract — they move an order through
 * its states and derive a payment status from how much was received. Those two
 * rules are small, pure, and identical for every provider, so they live here
 * rather than in each adapter.
 *
 * This module is intentionally dependency-free: no SDK, no I/O, no clock.
 */

/** The order lifecycle states a payment can move an order between. */
export type OrderStatus =
  | 'draft'
  | 'pending'
  | 'paid'
  | 'processing'
  | 'shipped'
  | 'completed'
  | 'cancelled'
  | 'refunded'

/** How much of an order has been received, derived from the amounts. */
export type OrderPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded'

/**
 * The legal moves between order states.
 *
 * A shop that takes payment on delivery goes `pending -> processing` without
 * ever passing through `paid`, while one that takes payment up front goes
 * `pending -> paid -> processing`. Both are real, so both are edges here.
 *
 * `completed` and `cancelled` are terminal apart from the one step back out
 * that actually happens in a shop: a completed order can be refunded.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ['pending', 'cancelled'],
  pending: ['paid', 'processing', 'cancelled'],
  paid: ['processing', 'shipped', 'completed', 'cancelled', 'refunded'],
  processing: ['shipped', 'completed', 'cancelled'],
  shipped: ['completed', 'refunded'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
}

/** The statuses reachable from `status` in one step. */
export function nextOrderStatuses(status: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[status]
}

/** Whether the lifecycle allows `from -> to` at all. */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * The payment status implied by how much has been received.
 *
 * Derived rather than chosen: a store that records a part payment and then
 * leaves the status on "unpaid" would otherwise produce a row that contradicts
 * its own numbers. A refund is not expressible as an amount here, so it stays
 * the one payment status a caller sets explicitly.
 *
 * An order that costs nothing (a voucher covering everything, say) is paid the
 * moment it exists: there is nothing left to receive.
 */
export function paymentStatusFor(amountPaid: number, grandTotal: number): OrderPaymentStatus {
  if (grandTotal <= 0) return 'paid'
  if (amountPaid <= 0) return 'unpaid'
  if (amountPaid >= grandTotal) return 'paid'
  return 'partial'
}
