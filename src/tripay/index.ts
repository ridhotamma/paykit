/**
 * TriPay server-side glue: wraps tripay-node-sdk for PayKit.
 */

import {
  Tripay,
  TripayError,
  TripayValidationError,
  TripayAuthError,
  TripaySignatureError,
  type CallbackPayload,
  type ClosedTransaction,
  type CreateTransactionInput,
  type OrderItemInput,
} from 'tripay-node-sdk'
import { z } from 'zod'

import { mergeCredentialBlobs } from '../credentials'
import { planTripayPaymentUpdate, type TripayPaymentPlan, type PayableOrder } from './payment'

export {
  Tripay,
  TripayError,
  TripayValidationError,
  TripayAuthError,
  TripaySignatureError,
  planTripayPaymentUpdate,
  type TripayPaymentPlan,
  type PayableOrder,
  type CallbackPayload,
  type ClosedTransaction,
}

/* -------------------------------------------------------------------------- */
/* Checkout channels                                                          */
/* -------------------------------------------------------------------------- */

export interface TripayCheckoutChannel {
  code: string
  label: string
  hint?: string
}

export const TRIPAY_CHECKOUT_CHANNELS: readonly TripayCheckoutChannel[] = [
  { code: 'BCAVA', label: 'BCA Virtual Account' },
  { code: 'BNIVA', label: 'BNI Virtual Account' },
  { code: 'BRIVA', label: 'BRI Virtual Account' },
  { code: 'MANDIRIVA', label: 'Mandiri Virtual Account' },
  { code: 'PERMATAVA', label: 'Permata Virtual Account' },
  { code: 'CIMBVA', label: 'CIMB Niaga Virtual Account' },
  { code: 'BSIVA', label: 'BSI Virtual Account' },
  { code: 'MUAMALATVA', label: 'Muamalat Virtual Account' },
  { code: 'DANAMONVA', label: 'Danamon Virtual Account' },
  { code: 'ALFAMART', label: 'Alfamart' },
  { code: 'INDOMARET', label: 'Indomaret' },
  { code: 'ALFAMIDI', label: 'Alfamidi' },
  {
    code: 'QRIS',
    label: 'QRIS',
    hint: 'Scan with any e-wallet or mobile banking app.',
  },
  { code: 'DANA', label: 'DANA' },
  { code: 'SHOPEEPAY', label: 'ShopeePay' },
  { code: 'OVO', label: 'OVO' },
]

export function isTripayCheckoutChannel(code: string): boolean {
  return TRIPAY_CHECKOUT_CHANNELS.some((channel) => channel.code === code)
}

export function tripayChannelLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return TRIPAY_CHECKOUT_CHANNELS.find((channel) => channel.code === code)?.label ?? null
}

/* -------------------------------------------------------------------------- */
/* Error shaping                                                              */
/* -------------------------------------------------------------------------- */

export function describeTripayError(error: unknown): string {
  if (error instanceof TripayError) {
    return `Tripay error (${error.status}): ${error.message}`
  }
  if (error instanceof TripayValidationError) {
    return `Tripay validation: ${error.message}`
  }
  if (error instanceof TripayAuthError) {
    return `Tripay authentication failed: ${error.message}`
  }
  if (error instanceof TripaySignatureError) {
    return `Tripay signature error: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

export const TRIPAY_ENVIRONMENTS = ['sandbox', 'production'] as const

export type TripayEnvironment = (typeof TRIPAY_ENVIRONMENTS)[number]

export const tripayCredentialsSchema = z.object({
  merchantCode: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  privateKey: z.string().trim().min(1),
  environment: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value === '' ? 'sandbox' : value))
    .pipe(z.enum(TRIPAY_ENVIRONMENTS))
    .default('sandbox'),
})

export type TripayCredentials = z.infer<typeof tripayCredentialsSchema>

export type TripayCredentialsResult =
  { ok: true; credentials: TripayCredentials } | { ok: false; error: string }

export function readTripayCredentials(
  blobs: ReadonlyArray<Record<string, string | undefined> | null | undefined>,
): TripayCredentialsResult {
  const merged = mergeCredentialBlobs(blobs)

  const parsed = tripayCredentialsSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `Tripay credentials are not configured correctly (${problems}).` }
  }

  return { ok: true, credentials: parsed.data }
}

export function createTripayClient(credentials: TripayCredentials): Tripay {
  return new Tripay({
    apiKey: credentials.apiKey,
    privateKey: credentials.privateKey,
    merchantCode: credentials.merchantCode,
    mode: credentials.environment,
  })
}

/* -------------------------------------------------------------------------- */
/* Payment charge preparation                                                 */
/* -------------------------------------------------------------------------- */

export interface TripayChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
}

export interface TripayChargeLine {
  description: string
  quantity: number
  unitPrice: number
}

export interface TripayChargeTotals {
  discountTotal?: number | null
  shippingTotal?: number | null
  taxTotal?: number | null
}

export function tripayRemainingAmountFor(
  order: Pick<TripayChargeOrder, 'grandTotal'> & { amountPaid?: number | null },
): number {
  return Math.max(0, order.grandTotal - (order.amountPaid ?? 0))
}

export interface BuildTripayTransactionInput {
  order: TripayChargeOrder
  channel: string
  lines: readonly TripayChargeLine[]
  totals?: TripayChargeTotals
  callbackUrl?: string
  returnUrl?: string
  expiresInSeconds?: number
  /**
   * Tripay requires a well-formed customer email, but a guest checkout may not
   * collect one. This domain is used to synthesise a compliant placeholder
   * (`<order-number>@example.com`) so the charge still goes through.
   */
  placeholderEmailDomain?: string
}

export function buildTripayTransactionParams({
  order,
  channel,
  lines,
  totals,
  callbackUrl,
  returnUrl,
  expiresInSeconds = 24 * 3600,
  placeholderEmailDomain = 'example.com',
}: BuildTripayTransactionInput): CreateTransactionInput {
  const remaining = tripayRemainingAmountFor(order)

  const hasAdjustments = (totals?.discountTotal ?? 0) > 0 || (order.amountPaid ?? 0) > 0
  const linesSum =
    lines.reduce((acc, l) => acc + l.unitPrice * l.quantity, 0) +
    (totals?.shippingTotal ?? 0) +
    (totals?.taxTotal ?? 0)

  let orderItems: OrderItemInput[] = []
  if (!hasAdjustments && linesSum === remaining && lines.length > 0) {
    orderItems = lines
      .filter((line) => line.quantity > 0 && line.unitPrice > 0)
      .map((line) => ({
        name: line.description,
        price: line.unitPrice,
        quantity: line.quantity,
      }))
    if ((totals?.shippingTotal ?? 0) > 0) {
      orderItems.push({ name: 'Ongkos kirim', price: totals!.shippingTotal!, quantity: 1 })
    }
    if ((totals?.taxTotal ?? 0) > 0) {
      orderItems.push({ name: 'Pajak', price: totals!.taxTotal!, quantity: 1 })
    }
  }

  if (
    orderItems.length === 0 ||
    orderItems.reduce((acc, it) => acc + it.price * it.quantity, 0) !== remaining
  ) {
    orderItems = [
      {
        name: `Pembayaran pesanan ${order.orderNumber}`,
        price: remaining,
        quantity: 1,
      },
    ]
  }

  return {
    method: channel,
    merchantRef: order.orderNumber,
    amount: remaining,
    customerName: order.customerName.trim().slice(0, 50) || order.orderNumber,
    customerEmail: order.customerEmail || `${order.orderNumber.toLowerCase()}@${placeholderEmailDomain}`,
    ...(order.customerPhone ? { customerPhone: order.customerPhone } : {}),
    orderItems,
    ...(callbackUrl ? { callbackUrl } : {}),
    ...(returnUrl ? { returnUrl } : {}),
    expiresIn: expiresInSeconds,
  }
}
