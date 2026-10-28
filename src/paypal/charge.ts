/**
 * Outbound charge building — turning a PayKit order into a PayPal order.
 *
 * One shape for every channel: PayPal's Orders v2 has no per-channel create
 * call the way Tripay/Duitku do. Whether the buyer pays with the wallet,
 * Pay Later or a card, the server creates the same `CAPTURE` order and the
 * *frontend* decides how it is approved — the PayPal Buttons component for
 * wallet/Pay Later, the hosted Card Fields for cards (see the adapter).
 * `channel` therefore only picks the stored method label, never the payload.
 *
 * The order carries an explicit `payment_source.paypal`: the redirect URLs,
 * brand and shipping rules live in its `experience_context`, which is where
 * Orders v2 moved them after deprecating the top-level `application_context`.
 * The hosted PayPal page still lets the buyer fund with a card or Pay Later,
 * so the one payment source serves every channel.
 *
 * Pure module: no I/O, no dates beyond the injected `now`, amounts stay in
 * the currency's minor unit exactly as stored on the order until the final
 * formatting step PayPal's string-valued `amount.value` requires.
 */

import { minorUnitDigits } from '../money'

import { chargeAttemptReference, shortReferenceToken } from '../charge-reference'
import type { CreatePaypalOrderBody } from './client'

/** The parts of an order a charge needs. Mirrors the `orders` document. */
export interface PaypalChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
}

/** What is still owed on the order — the only amount ever charged. */
export function paypalRemainingAmountFor(
  order: Pick<PaypalChargeOrder, 'grandTotal' | 'amountPaid'>,
): number {
  return Math.max(0, order.grandTotal - (order.amountPaid ?? 0))
}

/**
 * PayPal's zero-decimal currencies — no fraction digits, ever.
 *
 * `minorUnitDigits` already answers 0 for JPY (and IDR/KRW/VND), but HUF
 * and TWD are not in its table and would fall back to 2, which PayPal
 * rejects with `AMOUNT_MISMATCH`. The override keeps both tables honest.
 */
const PAYPAL_ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD'])

function paypalFractionDigits(currency: string): number {
  if (PAYPAL_ZERO_DECIMAL.has(currency.toUpperCase())) return 0
  return minorUnitDigits(currency)
}

/**
 * A minor-unit amount as PayPal's `amount.value` string.
 *
 * Exact — never through a float: `12500` IDR is `"12500"`, `1250` USD is
 * `"12.50"`. The currency is the *charge* currency (the connection's
 * `currency`), which must equal the shop's own currency: reformatting an
 * IDR ledger as USD would silently charge dollars for rupiah.
 */
export function minorToPaypalValue(minorUnits: number, currency: string): string {
  const digits = paypalFractionDigits(currency)
  const divisor = 10 ** digits
  const rounded = Math.round(minorUnits)
  if (digits === 0) return String(rounded)
  const whole = Math.trunc(rounded / divisor)
  const fraction = Math.abs(rounded - whole * divisor)
    .toString()
    .padStart(digits, '0')
  return `${whole}.${fraction}`
}

/**
 * A PayPal `amount.value` string back into minor units, or `null` when it
 * is not a plain decimal in the currency's shape.
 *
 * Rejects more digits than the currency allows (`"12.500"` USD) rather than
 * rounding: a capture amount that does not parse is never a payment to
 * apply, it is a logged failure (see `planPaypalPaymentUpdate`).
 */
export function paypalValueToMinor(value: string, currency: string): number | null {
  const digits = paypalFractionDigits(currency)
  const pattern = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`)
  if (!pattern.test(value.trim())) return null
  const [whole, fraction = ''] = value.trim().split('.')
  const minor =
    Number(whole) * 10 ** digits + Number((fraction + '0'.repeat(digits)).slice(0, digits))
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null
}

export interface BuildPaypalOrderInput {
  order: PaypalChargeOrder
  /** ISO code from the connection — must equal the shop's own currency. */
  currency: string
  /** Where the buyer lands after approving (and after cancelling). */
  returnUrl: string
  /** The shop name, shown on PayPal's approval page as the brand. */
  brandName?: string | null
  /**
   * The gateway reference a previous charge left on the order. A re-charge
   * appends an attempt token to `invoice_id` so a merchant who blocks
   * duplicate invoice IDs does not refuse the new payment.
   */
  existingPaymentReference?: string | null
}

/**
 * Build the Orders v2 `create` body for the order's remaining balance.
 *
 * - `reference_id` is the PayKit `orderNumber` — the contract the webhook
 *   handler settles on.
 * - `custom_id` carries `tenantId:orderNumber`: the capture webhook echoes
 *   it back, which is how a `PAYMENT.CAPTURE.COMPLETED` event names its
 *   order without a lookup (see `./transactions`).
 * - `invoice_id` repeats the order number so PayPal's own duplicate
 *   detection rejects a double capture of the same order — with an attempt
 *   token when the order is re-charged, so a merchant who blocks duplicate
 *   invoice IDs does not block the new payment.
 * - `shipping_preference: NO_SHIPPING`: delivery is quoted and booked by
 *   PayKit itself (Biteship/KiriminAja), so PayPal must not demand an
 *   address the buyer already gave the shop.
 */
export function buildPaypalOrderBody({
  order,
  currency,
  returnUrl,
  brandName,
  existingPaymentReference,
}: BuildPaypalOrderInput): CreatePaypalOrderBody {
  const currencyCode = currency.trim().toUpperCase()
  const remaining = paypalRemainingAmountFor(order)
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: order.orderNumber,
        custom_id: `${order.tenantId}:${order.orderNumber}`,
        description: `Pembayaran pesanan ${order.orderNumber}`,
        invoice_id: chargeAttemptReference(order.orderNumber, existingPaymentReference),
        amount: {
          currency_code: currencyCode,
          value: minorToPaypalValue(remaining, currencyCode),
        },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          ...(brandName?.trim() ? { brand_name: brandName.trim().slice(0, 127) } : {}),
          return_url: returnUrl,
          cancel_url: returnUrl,
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
        },
      },
    },
  }
}

/**
 * The buyer-facing approval URL out of a create/show response, or `null`.
 *
 * PayPal answers it as the HATEOAS link with `rel: "approve"` (older docs
 * and some SDK surfaces call it `"payer-action"` — both are accepted). A
 * missing link means the order cannot be approved and the charge must fail
 * loudly rather than store a dead reference.
 */
export function approveLinkFrom(order: {
  links?: Array<{ href: string; rel: string }> | undefined
}): string | null {
  const link = (order.links ?? []).find(
    (entry) => entry.rel === 'approve' || entry.rel === 'payer-action',
  )
  const href = link?.href?.trim()
  return href ? href : null
}

/**
 * The `PayPal-Request-Id` for one charge attempt — the header that makes a
 * retried create idempotent for as long as PayPal remembers the id.
 *
 * Keying on the order number alone would make a genuine re-charge return the
 * *previous* order (still inside PayPal's idempotency window) instead of
 * creating a new one. A re-charge therefore appends a token derived from the
 * reference the order already carries: retrying this attempt replays the
 * same id, and the next attempt (the stored reference changes on success)
 * gets a different one.
 */
export function paypalRequestId(
  orderNumber: string,
  existingPaymentReference?: string | null,
): string {
  const previous = existingPaymentReference?.trim()
  if (!previous) return `paykit-${orderNumber}`
  return `paykit-${orderNumber}-${shortReferenceToken(previous)}`
}
