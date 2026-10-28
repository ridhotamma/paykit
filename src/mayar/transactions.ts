/**
 * Reconciliation shaping — turning the raw `transactions.get` response into
 * the fields the payment planner needs.
 *
 * The webhook's `payment.received` event is authenticated only by a shared
 * callback token, not by a signature over the body — so the event's own
 * `amount`/`status` claims are never trusted. The handler reads the
 * transaction back from the Mayar API with the shop's API key and this
 * module decides what those bytes mean.
 */

import { z } from 'zod'

/**
 * The fields a transaction detail always carries when it matters to us.
 *
 * `amount` is accepted as an integer only — Mayar amounts are minor-unit
 * integers, and a decimal or string value is never a payment to apply.
 * `extraData` is whatever the invoice creation echoed back (our
 * correlation payload) or absent for payment links.
 */
export const mayarExtraDataSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.string().transform((str) => {
    try {
      const parsed = JSON.parse(str)
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }),
])

export const mayarTransactionSchema = z.object({
  id: z.string().min(1),
  amount: z.number().int(),
  status: z.string().min(1),
  paymentMethod: z.string().min(1).nullish(),
  extraData: mayarExtraDataSchema.nullish(),
})

export type MayarTransaction = z.infer<typeof mayarTransactionSchema>

/**
 * Parse one `transactions.get` response body.
 *
 * The SDK types it as `Record<string, unknown>` on purpose — the V2
 * envelope's `data` is open-ended — so the fields are re-validated here.
 * Returns `null` for a shape that cannot be reconciled (missing amount,
 * non-integer amount); the caller records that as a failure rather than
 * guessing.
 */
export function parseMayarTransaction(raw: unknown): MayarTransaction | null {
  const parsed = mayarTransactionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * The order number a transaction is about, from its `extraData` echo.
 *
 * Invoices created by PayKit carry `extraData: { orderNumber, tenantId }`;
 * anything else (a hand-made invoice, a different integration) returns
 * `null` and falls through to name matching.
 */
export function mayarOrderNumberFromExtraData(
  transaction: Pick<MayarTransaction, 'extraData'>,
): string | null {
  let extraData = transaction.extraData
  if (typeof extraData === 'string') {
    try {
      extraData = JSON.parse(extraData)
    } catch {
      extraData = null
    }
  }
  const orderNumber = (extraData as Record<string, unknown> | null | undefined)?.orderNumber
  return typeof orderNumber === 'string' && orderNumber !== '' ? orderNumber : null
}

/**
 * The order number embedded in a payment-link product name or description.
 *
 * Payment links carry no `extraData`, so PayKit names the link with the
 * order number (`INV-20260919-ABCDE — Toko ABC`) or description. Matches
 * any standard PayKit order number pattern.
 */
export function mayarOrderNumberFromProductName(productName: unknown): string | null {
  if (typeof productName !== 'string') return null
  const match = /(INV-\d{8}-[A-Z0-9]{5})/.exec(productName.trim())
  return match ? (match[1] ?? null) : null
}
