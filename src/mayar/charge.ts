/**
 * Outbound charge building — turning a PayKit order into a Mayar invoice or
 * payment link.
 *
 * Two shapes, chosen by what the order knows about its buyer:
 *
 * - **Invoice** (`invoices.create`) — needs the buyer's name, email and phone;
 *   accepts `extraData`, which Mayar echoes on every transaction. That echo is
 *   the correlation key when the callback comes back.
 * - **Payment link** (`products.createPaymentLink`) — no buyer details needed,
 *   but no `extraData` either, so the order number is embedded in the link's
 *   product name and matched from the callback's `data.productName`.
 *
 * Pure module: no I/O, no dates beyond the injected `now`, amounts stay in the
 * currency's minor unit exactly as stored on the order.
 */

import type { CreateInvoiceParams, CreatePaymentLinkParams } from 'mayar-node-sdk'

/** The parts of an order a charge needs. Mirrors the `orders` document. */
export interface MayarChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
}

/** One order line, as far as charging is concerned. */
export interface MayarChargeLine {
  description: string
  quantity: number
  unitPrice: number
}

/** Order-level adjustments that must appear on the invoice as their own lines. */
export interface MayarChargeTotals {
  discountTotal?: number | null
  shippingTotal?: number | null
  taxTotal?: number | null
}

/** What is still owed on the order — the only amount ever charged. */
export function remainingAmountFor(
  order: Pick<MayarChargeOrder, 'grandTotal' | 'amountPaid'>,
): number {
  return Math.max(0, order.grandTotal - (order.amountPaid ?? 0))
}

const DEFAULT_CHARGE_WINDOW_HOURS = 24

function expiryIso(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 3_600_000).toISOString()
}

export interface BuildMayarInvoiceInput {
  order: MayarChargeOrder
  /** Required by Mayar invoices — the caller falls back to a payment link without them. */
  email: string
  mobile: string
  lines: readonly MayarChargeLine[]
  totals?: MayarChargeTotals
  /** Where the buyer lands after paying. Mayar invoices accept it like payment links do. */
  redirectUrl?: string
  expiresInHours?: number
  now?: Date
}

/**
 * Build `invoices.create` params for the order's remaining balance.
 *
 * Discounts ride in as a negative line (Mayar accepts them as long as the
 * total stays positive), shipping as a plain line, and tax through the
 * invoice-level `tax` field — mirroring how the order's own totals compose.
 */
export function buildMayarInvoiceParams({
  order,
  email,
  mobile,
  lines,
  totals,
  redirectUrl,
  expiresInHours = DEFAULT_CHARGE_WINDOW_HOURS,
  now = new Date(),
}: BuildMayarInvoiceInput): CreateInvoiceParams {
  const items: CreateInvoiceParams['items'] = lines
    .filter((line) => line.quantity > 0 && line.unitPrice !== 0)
    .map((line) => ({
      description: line.description,
      quantity: line.quantity,
      rate: line.unitPrice,
    }))

  const discountTotal = totals?.discountTotal ?? 0
  if (discountTotal > 0) {
    items.push({ description: 'Diskon', quantity: 1, rate: -discountTotal })
  }

  const shippingTotal = totals?.shippingTotal ?? 0
  if (shippingTotal > 0) {
    items.push({ description: 'Ongkos kirim', quantity: 1, rate: shippingTotal })
  }

  const taxTotal = totals?.taxTotal ?? 0
  if (taxTotal > 0) {
    items.push({ description: 'Pajak', quantity: 1, rate: taxTotal })
  }

  return {
    name: order.customerName || 'Pelanggan',
    email,
    mobile,
    items,
    description: `Pembayaran pesanan ${order.orderNumber}`,
    expiredAt: expiryIso(now, expiresInHours),
    ...(redirectUrl ? { redirectUrl } : {}),
    extraData: { orderNumber: order.orderNumber, tenantId: order.tenantId },
  }
}

export interface BuildMayarPaymentLinkInput {
  order: Pick<MayarChargeOrder, 'orderNumber' | 'grandTotal' | 'amountPaid'>
  shopName?: string | null
  /** Where the buyer lands after paying (the shop's order confirmation page). */
  redirectUrl?: string
  expiresInHours?: number
  now?: Date
}

/**
 * Build `products.createPaymentLink` params for the remaining balance.
 *
 * The order number leads the product name: the callback cannot carry
 * `extraData` for links, so the name is the correlation key (see
 * `mayarOrderNumberFromProductName` in `./transactions`).
 */
export function buildMayarPaymentLinkParams({
  order,
  shopName,
  redirectUrl,
  expiresInHours = DEFAULT_CHARGE_WINDOW_HOURS,
  now = new Date(),
}: BuildMayarPaymentLinkInput): CreatePaymentLinkParams {
  return {
    name: `${order.orderNumber}${shopName ? ` — ${shopName}` : ''}`,
    amount: remainingAmountFor(order),
    description: `Pembayaran pesanan ${order.orderNumber}`,
    ...(redirectUrl ? { redirectUrl } : {}),
    expiredAt: expiryIso(now, expiresInHours),
  }
}
