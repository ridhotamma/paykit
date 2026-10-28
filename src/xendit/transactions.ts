/**
 * Reconciliation shaping — turning the raw `GET /sessions/{id}` (or the
 * legacy `GET /v2/invoices/{id}`) response into the fields the payment
 * planner needs.
 *
 * Callback claims are never trusted on their own: the callback authenticates
 * with a shared token, not with a signature over the body. The handler reads
 * the session back from the Xendit API with the shop's secret key and this
 * module decides what those bytes mean.
 */

import { z } from 'zod'

import { baseGatewayReference } from '../charge-reference'

/* -------------------------------------------------------------------------- */
/* Payment Sessions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The fields a session carries when it matters to us.
 *
 * `amount` is the session total in integer minor units — a decimal value is
 * never a payment to apply. `payment_id` is the underlying Payment the
 * session completed with; PayKit does not read it (the session status is
 * the reconciliation source of truth) but keeps it for the record.
 */
export const xenditSessionSchema = z.object({
  payment_session_id: z.string().min(1),
  reference_id: z.string().nullish(),
  status: z.string().min(1),
  amount: z.number().nullish(),
  currency: z.string().nullish(),
  payment_id: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
})

export type XenditSession = z.infer<typeof xenditSessionSchema>

/**
 * Parse one session response body.
 *
 * Returns `null` for a shape that cannot be reconciled (missing id or
 * status); the caller records that as a failure rather than guessing.
 */
export function parseXenditSession(raw: unknown): XenditSession | null {
  const parsed = xenditSessionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Whether the reconciled session counts as paid. */
export function isXenditCompletedSession(session: Pick<XenditSession, 'status'>): boolean {
  return session.status.trim().toUpperCase() === 'COMPLETED'
}

/**
 * The session amount in integer minor units, or `null` when it is not one.
 *
 * A non-integer, missing or negative value is never a payment to apply; the
 * planner treats it as a logged failure.
 */
export function xenditSessionAmount(session: Pick<XenditSession, 'amount'>): number | null {
  const amount = session.amount
  if (amount === null || amount === undefined) return null
  return Number.isInteger(amount) && amount >= 0 ? amount : null
}

/**
 * The order number a session is about.
 *
 * `metadata.paykit_order` is stamped at creation and wins — it is the base
 * order number even when a re-charge appended an attempt token to
 * `reference_id`. A session created outside PayKit falls back to the
 * reference with any attempt suffix stripped. Anything else returns `null`
 * and falls through to a logged failure rather than a guess.
 */
export function xenditOrderNumberFromSession(
  session: Pick<XenditSession, 'reference_id'> & { metadata?: XenditSession['metadata'] },
): string | null {
  const stamped = session.metadata?.paykit_order
  if (typeof stamped === 'string' && stamped.trim() !== '') return stamped.trim()
  const referenceId = session.reference_id?.trim() ?? ''
  if (referenceId === '') return null
  return baseGatewayReference(referenceId)
}

/**
 * The channel the buyer picked on the hosted page, from the metadata PayKit
 * stamped at creation. `null` when none was recorded (an all-channels
 * session, or a session created outside PayKit) — the planner then falls
 * back to the bare provider name.
 */
export function xenditSessionChannel(session: Pick<XenditSession, 'metadata'>): string | null {
  const channel = session.metadata?.paykit_channel
  if (typeof channel !== 'string') return null
  const trimmed = channel.trim()
  return trimmed !== '' ? trimmed : null
}

/* -------------------------------------------------------------------------- */
/* Legacy Invoices (read-only reconciliation)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The fields a legacy invoice always carries when it matters to us.
 *
 * `amount` is the invoiced total; `paid_amount` is what the buyer actually
 * paid (present once paid, sometimes above `amount` when the buyer
 * overpays a VA). Both are minor-unit integers — a decimal value is never a
 * payment to apply.
 */
export const xenditInvoiceSchema = z.object({
  id: z.string().min(1),
  external_id: z.string().min(1).nullish(),
  status: z.string().min(1),
  // Accepted as any number — `xenditInvoiceAmount` is what guards the
  // ledger, so a decimal amount parses (and is then rejected with a clear
  // reason) instead of failing as an unshaped invoice.
  amount: z.number().nullish(),
  paid_amount: z.number().nullish(),
  payment_channel: z.string().nullish(),
  payment_method: z.string().nullish(),
  paid_at: z.string().nullish(),
})

export type XenditInvoice = z.infer<typeof xenditInvoiceSchema>

/**
 * Parse one invoice response body.
 *
 * Returns `null` for a shape that cannot be reconciled (missing id or
 * status); the caller records that as a failure rather than guessing.
 */
export function parseXenditInvoice(raw: unknown): XenditInvoice | null {
  const parsed = xenditInvoiceSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Whether the reconciled invoice counts as paid (`PAID`, then `SETTLED` once funds clear). */
export function isXenditPaidInvoice(invoice: Pick<XenditInvoice, 'status'>): boolean {
  const status = invoice.status.trim().toUpperCase()
  return status === 'PAID' || status === 'SETTLED'
}

/**
 * The invoice amount in integer minor units, or `null` when it is not one.
 *
 * Prefers `paid_amount` — what the buyer actually paid — and falls back to
 * `amount`. A non-integer, missing or negative value is never a payment to
 * apply; the planner treats it as a logged failure.
 */
export function xenditInvoiceAmount(
  invoice: Pick<XenditInvoice, 'amount' | 'paid_amount'>,
): number | null {
  for (const candidate of [invoice.paid_amount, invoice.amount]) {
    if (candidate === null || candidate === undefined) continue
    if (!Number.isInteger(candidate) || candidate < 0) return null
    return candidate
  }
  return null
}

/**
 * The order number a legacy invoice is about, from its `external_id` echo.
 *
 * Invoices created by PayKit carry `external_id` = the order number;
 * anything else returns `null` and falls through to a logged failure rather
 * than a guess.
 */
export function xenditOrderNumberFromInvoice(
  invoice: Pick<XenditInvoice, 'external_id'>,
): string | null {
  const externalId = invoice.external_id?.trim() ?? ''
  return externalId !== '' ? externalId : null
}
