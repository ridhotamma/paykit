/**
 * Outbound charge building — turning a PayKit order into an Aulaa payment.
 *
 * Aulaa has one create call for every method: `POST /v1/payments` accepts the
 * order id and amount, optionally pins a `payment_method`, and returns a
 * hosted `payment_link`. The buyer picks the method on that page when none is
 * pinned, so `channel` only narrows the choice, never the payload shape.
 *
 * Pure module: no I/O, no dates, amounts stay in rupiah exactly as stored on
 * the order.
 */

import { chargeAttemptReference } from '../charge-reference'
import type { AulaaCreatePaymentRequest } from './client'

/** Aulaa accepts full rupiah from Rp1.000 to Rp500.000.000 per payment. */
export const AULAA_MIN_AMOUNT = 1_000
export const AULAA_MAX_AMOUNT = 500_000_000

/** The parts of an order a charge needs. Mirrors the `orders` document. */
export interface AulaaChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
}

/** What is still owed on the order — the only amount ever charged. */
export function aulaaRemainingAmountFor(
  order: Pick<AulaaChargeOrder, 'grandTotal' | 'amountPaid'>,
): number {
  return Math.max(0, order.grandTotal - (order.amountPaid ?? 0))
}

/**
 * Why an amount cannot be charged through Aulaa, or `null` when it fits.
 *
 * The API enforces the same window; checking here turns its 400 into a
 * seller-readable sentence before a network call.
 */
export function aulaaAmountProblem(amount: number): string | null {
  if (!Number.isInteger(amount) || amount <= 0) {
    return 'Aulaa needs a positive integer rupiah amount.'
  }
  if (amount < AULAA_MIN_AMOUNT) {
    return `Aulaa accepts at least Rp${AULAA_MIN_AMOUNT.toLocaleString('id-ID')} per payment.`
  }
  if (amount > AULAA_MAX_AMOUNT) {
    return `Aulaa accepts at most Rp${AULAA_MAX_AMOUNT.toLocaleString('id-ID')} per payment.`
  }
  return null
}

export interface BuildAulaaPaymentInput {
  order: AulaaChargeOrder
  /** One of the project's method codes (`qris`, `bca_va`, …). Omitted lets the buyer choose. */
  channel?: string | null
  /** Where the buyer lands after paying — informational only, never trusted. */
  returnUrl?: string
  /**
   * The gateway reference a previous charge left on the order. A re-charge
   * appends an attempt token — Aulaa refuses a reused `order_id` with 409.
   * See `chargeAttemptReference`.
   */
  existingPaymentReference?: string | null
}

/**
 * Build the `POST /v1/payments` body for the order's remaining balance.
 *
 * `order_id` is the PayKit `orderNumber` — the contract the webhook handler
 * settles on — with an attempt token appended when the order is being
 * re-charged. `redirect_url` rides along only when the caller has one.
 *
 * Aulaa has no expiry parameter on this endpoint: the provider chooses the
 * deadline and reports it back as `expired_at`.
 */
export function buildAulaaPaymentBody({
  order,
  channel,
  returnUrl,
  existingPaymentReference,
}: BuildAulaaPaymentInput): AulaaCreatePaymentRequest {
  const method = channel?.trim().toLowerCase()
  return {
    order_id: chargeAttemptReference(order.orderNumber, existingPaymentReference),
    amount: aulaaRemainingAmountFor(order),
    ...(method ? { payment_method: method } : {}),
    ...(returnUrl?.trim() ? { redirect_url: returnUrl.trim() } : {}),
  }
}
