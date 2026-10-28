/**
 * Reconciliation shaping — turning raw PayPal responses into the fields the
 * payment planner needs.
 *
 * Neither the webhook event nor the return URL is trusted on its own: the
 * event authenticates with a signature over headers PayPal verifies for us,
 * but its `amount`/`status` claims are still only a pointer. The handler
 * reads the order back through the PayPal API with the shop's own secret
 * and this module decides what those bytes mean.
 */

import { z } from 'zod'

import { baseGatewayReference } from '../charge-reference'
import { paypalValueToMinor } from './charge'

/** One capture as PayPal reports it — on webhooks, show and capture answers alike. */
export const paypalCaptureSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: z.object({
    currency_code: z.string().min(1),
    value: z.string().min(1),
  }),
  custom_id: z.string().nullish(),
  invoice_id: z.string().nullish(),
})

export type PaypalCapture = z.infer<typeof paypalCaptureSchema>

/** Parse one capture-shaped payload. `null` means "cannot be reconciled". */
export function parsePaypalCapture(raw: unknown): PaypalCapture | null {
  const parsed = paypalCaptureSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export interface ParsedPaypalCapture {
  id: string
  status: string
  /** Integer minor units of the charge currency, or `null` when unparseable. */
  amount: number | null
  currency: string
  customId: string | null
  invoiceId: string | null
}

/**
 * A capture plus its amount in ledger units.
 *
 * `currency` is the connection's charge currency — the caller knows it, the
 * payload only echoes it. A currency mismatch (payload answers EUR for a USD
 * charge) is a failure, not a conversion: silently converting at no rate
 * would invent money.
 */
export function toPaypalCaptureAmount(
  capture: PaypalCapture,
  currency: string,
): ParsedPaypalCapture {
  const code = currency.trim().toUpperCase()
  const echo = capture.amount.currency_code.trim().toUpperCase()
  return {
    id: capture.id,
    status: capture.status,
    amount: echo === code ? paypalValueToMinor(capture.amount.value, code) : null,
    currency: echo,
    customId: capture.custom_id ?? null,
    invoiceId: capture.invoice_id ?? null,
  }
}

/**
 * The order number a capture is about.
 *
 * `custom_id` (`tenantId:orderNumber`, set at creation) wins — it survives
 * shop renames and invoice edits. `invoice_id` (the bare order number, with a
 * re-charge's attempt token stripped) is the fallback for captures created
 * before `custom_id` existed or by hand in the PayPal dashboard. Anything
 * else returns `null` and falls through to a logged failure rather than a
 * guess.
 */
export function paypalOrderNumberFromCapture(capture: {
  customId: string | null
  invoiceId: string | null
}): string | null {
  const customId = capture.customId?.trim() ?? ''
  if (customId.includes(':')) {
    const orderNumber = customId.slice(customId.lastIndexOf(':') + 1).trim()
    if (orderNumber !== '') return orderNumber
  }
  const invoiceId = capture.invoiceId?.trim() ?? ''
  return invoiceId !== '' ? baseGatewayReference(invoiceId) : null
}

const purchaseUnitSchema = z.object({
  reference_id: z.string().nullish(),
  custom_id: z.string().nullish(),
  invoice_id: z.string().nullish(),
  payments: z
    .object({
      captures: z.array(paypalCaptureSchema).nullish(),
      authorizations: z.array(z.object({ id: z.string().min(1) }).describe('ignored')).nullish(),
    })
    .nullish(),
})

const paypalOrderSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  purchase_units: z.array(purchaseUnitSchema).nullish(),
})

/**
 * Every capture on a show/capture order response, in document order.
 *
 * An order carries at most one purchase unit from PayKit, but the walk
 * covers all of them: a hand-edited PayPal order with two units must still
 * reconcile every completed capture rather than crediting only the first.
 */
export function paypalCapturesFromOrder(raw: unknown): PaypalCapture[] {
  const parsed = paypalOrderSchema.safeParse(raw)
  if (!parsed.success) return []
  return (parsed.data.purchase_units ?? []).flatMap((unit) => unit.payments?.captures ?? [])
}

/**
 * The PayPal order id related to a capture webhook resource, when present.
 *
 * Some capture shapes carry it at
 * `resource.supplementary_data.related_ids.order_id` — which is how the
 * handler reads the order back for confirmation. The Orders v2 schema does
 * not document the path on captures, so it is strictly opportunistic:
 * absent (or never on show/capture answers), the caller falls back to the
 * signature-verified event itself, correlated via `custom_id`/`invoice_id`.
 */
export function paypalRelatedOrderId(raw: unknown): string | null {
  const parsed = z
    .object({
      supplementary_data: z
        .object({ related_ids: z.object({ order_id: z.string().min(1) }).nullish() })
        .nullish(),
    })
    .safeParse(raw)
  const orderId = parsed.success
    ? (parsed.data.supplementary_data?.related_ids?.order_id ?? null)
    : null
  return orderId && orderId.trim() !== '' ? orderId : null
}

/**
 * The order number an order response is about, from its purchase units.
 *
 * Mirrors `paypalOrderNumberFromCapture`: `custom_id` first, then
 * `invoice_id`, then `reference_id` (always the order number from
 * `buildPaypalOrderBody`, kept as the last resort for orders created by
 * older payloads).
 */
export function paypalOrderNumberFromUnits(raw: unknown): string | null {
  const parsed = paypalOrderSchema.safeParse(raw)
  if (!parsed.success) return null
  for (const unit of parsed.data.purchase_units ?? []) {
    const fromCustom = unit.custom_id?.trim() ?? ''
    if (fromCustom.includes(':')) {
      const orderNumber = fromCustom.slice(fromCustom.lastIndexOf(':') + 1).trim()
      if (orderNumber !== '') return orderNumber
    }
    const invoiceId = unit.invoice_id?.trim() ?? ''
    if (invoiceId !== '') return baseGatewayReference(invoiceId)
  }
  for (const unit of parsed.data.purchase_units ?? []) {
    const referenceId = unit.reference_id?.trim() ?? ''
    if (referenceId !== '') return baseGatewayReference(referenceId)
  }
  return null
}
