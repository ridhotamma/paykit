/**
 * Reconciliation shaping — turning the raw status-API response into the
 * fields the payment planner needs.
 *
 * Neither the notification nor the return URL is trusted on its own: the
 * notification authenticates with an HMAC signature over fields Midtrans
 * signs, but its `gross_amount`/`transaction_status` claims are still only a
 * pointer. The handler reads the transaction back through the status API
 * with the shop's own server key and this module decides what those bytes
 * mean.
 */

import { z } from 'zod'

import { baseGatewayReference } from '../charge-reference'

/**
 * The fields a status response always carries when it matters to us.
 *
 * `gross_amount` arrives as an integer string on the real API, but the
 * schema accepts a number too — test fixtures and future shapes stay
 * parseable, and the integer check in `midtransStatusAmount` is what guards
 * the ledger either way.
 */
export const midtransTransactionSchema = z.object({
  order_id: z.string().min(1),
  transaction_id: z.string().min(1).nullish(),
  transaction_status: z.string().min(1),
  fraud_status: z.string().nullish(),
  payment_type: z.string().nullish(),
  gross_amount: z.union([z.string().min(1), z.number()]),
  settlement_time: z.string().nullish(),
  /**
   * The retail outlet for `cstore` payments (`alfamart` | `indomaret`) —
   * the only thing distinguishing the two, since both share `payment_type`.
   */
  store: z.string().nullish(),
  /** The acquiring bank for card payments. */
  bank: z.string().nullish(),
  /**
   * The VA numbers for `bank_transfer` payments — `payment_type` is the
   * same generic value for every bank, so the specific bank reads off the
   * first entry here.
   */
  va_numbers: z
    .array(z.object({ va_number: z.string().nullish(), bank: z.string().nullish() }))
    .nullish(),
})

export type MidtransTransaction = z.infer<typeof midtransTransactionSchema>

/**
 * Parse one status-API response body.
 *
 * Returns `null` for a shape that cannot be reconciled (missing status,
 * missing amount); the caller records that as a failure rather than
 * guessing.
 */
export function parseMidtransTransaction(raw: unknown): MidtransTransaction | null {
  const parsed = midtransTransactionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Whether the reconciled transaction counts as paid.
 *
 * `settlement` is the success verdict for every payment type; `capture` only
 * settles card payments Midtrans explicitly accepted (`fraud_status:
 * accept`). A challenged or denied capture is held for review, and an absent
 * verdict is treated the same way — a missing fraud result is never proof
 * the money is safe to credit.
 */
export function isMidtransPaidTransaction(
  transaction: Pick<MidtransTransaction, 'transaction_status' | 'fraud_status'>,
): boolean {
  const status = transaction.transaction_status.trim().toLowerCase()
  if (status === 'settlement') return true
  if (status === 'capture') {
    return transaction.fraud_status?.trim().toLowerCase() === 'accept'
  }
  return false
}

/**
 * The transaction amount in integer minor units, or `null` when it is not
 * one.
 *
 * Midtrans reports `gross_amount` as a decimal *string* (`"10000.00`) even
 * for IDR, so a zero fraction is accepted and dropped — `"10000.00"` is ten
 * thousand, not a malformed amount. A non-zero fraction, an empty value or
 * a negative is never a payment to apply; it is a logged failure (see
 * `planMidtransPaymentUpdate`).
 */
export function midtransTransactionAmount(
  transaction: Pick<MidtransTransaction, 'gross_amount'>,
): number | null {
  const raw = transaction.gross_amount
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : null
  }
  const match = /^(\d+)(?:\.(0+))?$/.exec(raw.trim())
  if (!match) return null
  const amount = Number.parseInt(match[1]!, 10)
  return Number.isSafeInteger(amount) ? amount : null
}

/**
 * The specific bank behind a generic `bank_transfer` payment (`bca`,
 * `bni`, …), or `null` when the response does not name one.
 *
 * Reads the first `va_numbers` entry, falling back to the top-level `bank`
 * (present on card payments). Either is only a label source — settlement
 * never depends on it.
 */
export function midtransBankCode(
  transaction: Pick<MidtransTransaction, 'bank' | 'va_numbers'>,
): string | null {
  const fromVa = transaction.va_numbers?.[0]?.bank?.trim() ?? ''
  if (fromVa !== '') return fromVa
  const fromTop = transaction.bank?.trim() ?? ''
  return fromTop !== '' ? fromTop : null
}

/**
 * The order number a transaction is about — the `order_id` PayKit sent at
 * charge time, with a re-charge's attempt token stripped. Anything else
 * returns `null` and falls through to a logged failure rather than a guess.
 */
export function midtransOrderNumberFromTransaction(
  transaction: Pick<MidtransTransaction, 'order_id'>,
): string | null {
  const orderId = transaction.order_id?.trim() ?? ''
  return orderId !== '' ? baseGatewayReference(orderId) : null
}
