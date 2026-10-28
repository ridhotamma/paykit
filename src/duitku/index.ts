/**
 * Duitku server-side glue: from the JSON blobs stored on a shop's
 * `integrations` document to a verified callback payload.
 *
 * Everything here wraps `duitku-node-sdk` and nothing else — no Appwrite, no
 * request/response types — so the webhook app stays a thin I/O shell around
 * these functions and the admin app can keep importing the metadata-only root
 * entry without pulling `node:crypto` into a browser bundle. That split is why
 * this module lives behind the `paykit/duitku` subpath.
 *
 * The flow this serves:
 *
 *   1. A seller connects Duitku with `merchantCode` + `apiKey` (BYOK, one
 *      project per shop — sandbox and production are separate Duitku projects
 *      with separate keys, hence the `environment` field).
 *   2. Duitku POSTs the payment callback to `/store/:storeId/duitku` as a
 *      `x-www-form-urlencoded` body.
 *   3. `parseDuitkuCallbackBody` turns that body into a plain record,
 *      `duitkuCallbackSchema` checks it has the fields a callback always
 *      carries, and `Duitku.v2.parseCallback` verifies the HMAC-SHA256
 *      signature against *this shop's* key — the only defence against a
 *      forged callback, since the URL carries no secret.
 *
 * Duitku migrated the v2 callback signature from MD5 to HMAC-SHA256 in April
 * 2026; the SDK verifies the new scheme in constant time and treats MD5 as a
 * diagnostic, never as an accepted signature.
 */

import {
  Duitku,
  DuitkuApiError,
  DuitkuConfigError,
  DuitkuSignatureError,
  PaymentMethod,
} from 'duitku-node-sdk'
import type { CallbackPayload, CreatePaymentParams } from 'duitku-node-sdk'
import { z } from 'zod'

import { mergeCredentialBlobs } from '../credentials'

export { Duitku, DuitkuApiError, DuitkuConfigError, DuitkuSignatureError, PaymentMethod }

/** A verified callback: the form fields Duitku sent, plus the derived verdict. */
export type DuitkuCallbackPayload = CallbackPayload & { isPaid: boolean }

/* -------------------------------------------------------------------------- */
/* Checkout channels                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The `paymentMethod` codes the storefront lets a buyer pick, with the
 * labels and hints the checkout channel picker renders.
 *
 * A curated subset of `PaymentMethod` from the SDK, not the whole
 * forty-channel list: these are the channels an Indonesian SMB's buyer
 * actually pays with — the bank VAs, the retail outlets, the e-wallets
 * that need no account linking, and QRIS. Left out on purpose:
 *
 * - `VC` (credit card) — needs a `creditCardDetail` acquirer decision the
 *   shop cannot make per order, plus its own PCI-adjacent surfacing;
 * - `SL` / `OL` (account link) — need a `credentialCode` per buyer from
 *   Duitku's separate account-linking flow, which PayKit does not run;
 * - `DN` / `AT` (paylater) and `T1`/`T2`/`T3` (Tokopedia) — each needs
 *   `customerDetail` + `itemDetails` shaped per channel, so they stay
 *   seller-initiated (via the admin charge flow) rather than buyer-picked.
 */
export interface DuitkuCheckoutChannel {
  /** The exact code the v2 inquiry expects. */
  code: string
  /** Short label, e.g. `BCA Virtual Account`. */
  label: string
  /** One line of guidance shown under the label, or omitted for the obvious. */
  hint?: string
}

export const DUITKU_CHECKOUT_CHANNELS: readonly DuitkuCheckoutChannel[] = [
  { code: PaymentMethod.BCA_VA, label: 'BCA Virtual Account' },
  { code: PaymentMethod.BRI_VA, label: 'BRI Virtual Account' },
  { code: PaymentMethod.MANDIRI_VA, label: 'Mandiri Virtual Account' },
  { code: PaymentMethod.BNI_VA, label: 'BNI Virtual Account' },
  { code: PaymentMethod.PERMATA_VA, label: 'Permata Virtual Account' },
  { code: PaymentMethod.CIMB_VA, label: 'CIMB Niaga Virtual Account' },
  { code: PaymentMethod.BSI_VA, label: 'BSI Virtual Account' },
  { code: PaymentMethod.DANAMON_VA, label: 'Danamon Virtual Account' },
  { code: PaymentMethod.MAYBANK_VA, label: 'Maybank Virtual Account' },
  { code: PaymentMethod.ATM_BERSAMA_VA, label: 'ATM Bersama Virtual Account' },
  { code: PaymentMethod.RETAIL_ALFA, label: 'Alfamart / Pegadaian / Pos' },
  { code: PaymentMethod.RETAIL_INDOMARET, label: 'Indomaret' },
  { code: PaymentMethod.DANA, label: 'DANA' },
  { code: PaymentMethod.SHOPEEPAY_APPS, label: 'ShopeePay' },
  { code: PaymentMethod.OVO, label: 'OVO' },
  {
    code: PaymentMethod.QRIS_SHOPEEPAY,
    label: 'QRIS',
    hint: 'Scan with any e-wallet or mobile banking app.',
  },
]

export { planOrderPaymentUpdate, type DuitkuPaymentPlan, type PayableOrder } from './payment'

/**
 * True when `code` is one of the checkout channels the storefront offers —
 * anything else is a seller-initiated or unknown channel reaching the
 * inquiry path.
 */
export function isDuitkuCheckoutChannel(code: string): boolean {
  return DUITKU_CHECKOUT_CHANNELS.some((channel) => channel.code === code)
}

/** The checkout label for a channel code, or `null` for an unknown code. */
export function duitkuChannelLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return DUITKU_CHECKOUT_CHANNELS.find((channel) => channel.code === code)?.label ?? null
}

/* -------------------------------------------------------------------------- */
/* Creating the payment                                                       */
/* -------------------------------------------------------------------------- */

/** The parts of an order a Duitku inquiry needs. Mirrors the `orders` document. */
export interface DuitkuChargeOrder {
  tenantId: string
  orderNumber: string
  grandTotal: number
  amountPaid: number
  customerName: string
  customerEmail: string
  customerPhone?: string | null
}

/** One order line, as far as the inquiry's `itemDetails` are concerned. */
export interface DuitkuChargeLine {
  description: string
  quantity: number
  unitPrice: number
}

/** Order-level adjustments that must appear as their own `itemDetails` lines. */
export interface DuitkuChargeTotals {
  discountTotal?: number | null
  shippingTotal?: number | null
  taxTotal?: number | null
}

/** What is still owed on the order — the only amount ever charged. */
export function duitkuRemainingAmountFor(
  order: Pick<DuitkuChargeOrder, 'grandTotal'> & { amountPaid?: number | null },
): number {
  return Math.max(0, order.grandTotal - (order.amountPaid ?? 0))
}

export interface BuildDuitkuInquiryInput {
  order: DuitkuChargeOrder
  /** One of `DUITKU_CHECKOUT_CHANNELS` — checked by the charge caller. */
  channel: string
  lines: readonly DuitkuChargeLine[]
  totals?: DuitkuChargeTotals
  /** `POST /store/<slug>/duitku` for this shop. The seller pasted the same URL into Duitku. */
  callbackUrl: string
  /** Where the buyer lands after paying — informational only, never trusted. */
  returnUrl: string
  /** Minutes. VA and retail channels honour up to a day; QRIS caps at an hour. */
  expiryMinutes?: number
}

const DEFAULT_DUITKU_EXPIRY_MINUTES = 1440
const MAX_DUITKU_EXPIRY_MINUTES = 1440

/**
 * Build `v2.createPayment` params for the order's remaining balance.
 *
 * `merchantOrderId` is the PayKit `orderNumber` — the contract the
 * webhook handler settles on. `itemDetails` mirrors the order's own
 * composition (lines, plus discount/shipping/tax as their own lines) so
 * the sum of `price` equals `paymentAmount`, which Duitku requires exactly.
 * `customerVaName` is truncated to Duitku's 20-char ceiling rather than
 * rejected: a long buyer name must not fail a payment.
 */
export function buildDuitkuInquiryParams({
  order,
  channel,
  lines,
  totals,
  callbackUrl,
  returnUrl,
  expiryMinutes = DEFAULT_DUITKU_EXPIRY_MINUTES,
}: BuildDuitkuInquiryInput): CreatePaymentParams {
  const itemDetails: CreatePaymentParams['itemDetails'] = lines
    .filter((line) => line.quantity > 0 && line.unitPrice !== 0)
    .map((line) => ({
      name: line.description,
      quantity: line.quantity,
      price: line.unitPrice * line.quantity,
    }))

  const discountTotal = totals?.discountTotal ?? 0
  if (discountTotal > 0) {
    itemDetails.push({ name: 'Diskon', quantity: 1, price: -discountTotal })
  }

  const shippingTotal = totals?.shippingTotal ?? 0
  if (shippingTotal > 0) {
    itemDetails.push({ name: 'Ongkos kirim', quantity: 1, price: shippingTotal })
  }

  const taxTotal = totals?.taxTotal ?? 0
  if (taxTotal > 0) {
    itemDetails.push({ name: 'Pajak', quantity: 1, price: taxTotal })
  }

  return {
    paymentAmount: duitkuRemainingAmountFor(order),
    merchantOrderId: order.orderNumber,
    paymentMethod: channel,
    productDetails: `Pembayaran pesanan ${order.orderNumber}`,
    email: order.customerEmail,
    customerVaName: order.customerName.trim().slice(0, 20) || order.orderNumber,
    ...(order.customerPhone ? { phoneNumber: order.customerPhone } : {}),
    callbackUrl,
    returnUrl,
    itemDetails,
    expiryPeriod: Math.min(Math.max(1, Math.floor(expiryMinutes)), MAX_DUITKU_EXPIRY_MINUTES),
  }
}

/* -------------------------------------------------------------------------- */
/* Error shaping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One seller-readable line out of any Duitku failure: the API error's own
 * message (a 409 amount mismatch, a 404 dead channel, a 401 wrong key),
 * the config error's reason, or the raw message as a last resort.
 */
export function describeDuitkuError(error: unknown): string {
  if (error instanceof DuitkuApiError) {
    const detail =
      typeof error.body === 'object' && error.body !== null
        ? String(
            (error.body as Record<string, unknown>).statusMessage ??
              (error.body as Record<string, unknown>).message ??
              '',
          )
        : ''
    return `Duitku answered ${error.status}${error.code ? ` (${error.code})` : ''}${detail ? `: ${detail}` : ''}.`
  }
  if (error instanceof DuitkuConfigError) return `Duitku: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

export const DUITKU_ENVIRONMENTS = ['sandbox', 'production'] as const

export type DuitkuEnvironment = (typeof DUITKU_ENVIRONMENTS)[number]

/**
 * The secrets and settings one shop's Duitku connection needs.
 *
 * `merchantCode` and `apiKey` come from passport.duitku.com; `environment`
 * selects the API host and must match the project the keys belong to — a
 * production key verified against the sandbox host fails every signature, so
 * an unset value falls back to `sandbox` rather than to a guess.
 */
export const duitkuCredentialsSchema = z.object({
  merchantCode: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  environment: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value === '' ? 'sandbox' : value))
    .pipe(z.enum(DUITKU_ENVIRONMENTS))
    .default('sandbox'),
})

export type DuitkuCredentials = z.infer<typeof duitkuCredentialsSchema>

export type DuitkuCredentialsResult =
  { ok: true; credentials: DuitkuCredentials } | { ok: false; error: string }

/**
 * Read a shop's Duitku credentials out of its stored JSON blobs.
 *
 * A connection stores two JSON strings — `credentials` (the sealed secrets)
 * and `config` (the non-secrets) — so both are merged before validation, with
 * the credentials blob authoritative for any key it carries (see
 * `mergeCredentialBlobs`). Returns `ok: false` with a seller-readable reason
 * when the merchantCode or apiKey is missing or `environment` is not a known
 * value; a half-configured connection must fail loudly, not silently verify
 * against the wrong host.
 */
export function readDuitkuCredentials(
  blobs: ReadonlyArray<Record<string, string | undefined> | null | undefined>,
): DuitkuCredentialsResult {
  const merged = mergeCredentialBlobs(blobs)

  const parsed = duitkuCredentialsSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `Duitku credentials are not configured correctly (${problems}).` }
  }

  return { ok: true, credentials: parsed.data }
}

/** The SDK client for one shop's Duitku project. Cheap to build per request. */
export function createDuitkuClient(credentials: DuitkuCredentials): Duitku {
  return new Duitku({
    merchantCode: credentials.merchantCode,
    apiKey: credentials.apiKey,
    environment: credentials.environment,
  })
}

/* -------------------------------------------------------------------------- */
/* Callback body                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The fields every Duitku v2 callback carries, regardless of outcome.
 *
 * `resultCode` is accepted as any non-empty string rather than an enum:
 * `00` means paid and `01` means the attempt failed, but treating an
 * unrecognised code as a malformed callback would drop a real (and
 * logged, and replayable) notification on the floor.
 */
export const duitkuCallbackSchema = z.object({
  merchantCode: z.string().min(1),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer'),
  merchantOrderId: z.string().min(1).max(50),
  productDetail: z.string().optional(),
  additionalParam: z.string().optional(),
  paymentCode: z.string().optional(),
  resultCode: z.string().min(1),
  merchantUserId: z.string().optional(),
  reference: z.string().min(1),
  signature: z.string().min(1),
  publisherOrderId: z.string().optional(),
  settlementDate: z.string().optional(),
  issuerCode: z.string().optional(),
  customerName: z.string().optional(),
  // Channel-specific extras Duitku appends per payment method. Optional and
  // never verified — `vaNumber`/`sourceAccount` ride along on VA callbacks,
  // `spUserHash` on ShopeePay ones. Listed so a strict reader never rejects
  // a real notification for carrying them.
  vaNumber: z.string().optional(),
  sourceAccount: z.string().optional(),
  spUserHash: z.string().optional(),
})

/**
 * Parse the body Duitku POSTed, however it was serialised.
 *
 * Duitku sends `x-www-form-urlencoded`, but the bytes were already stored
 * once by the logging pipeline, so being liberal here costs nothing and
 * saves a replay when a body arrives JSON-shaped instead. Returns `null`
 * for an empty or unparseable body — the caller records that as a failure.
 */
export function parseDuitkuCallbackBody(rawBody: string): Record<string, string> | null {
  const trimmed = rawBody.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record: Record<string, string> = {}
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string' || typeof value === 'number') {
            record[key] = String(value)
          }
        }
        return Object.keys(record).length > 0 ? record : null
      }
      if (Array.isArray(parsed)) return null
    } catch {
      // Fall through to the form-encoded parse.
    }
  }

  const record: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(trimmed)) {
    record[key] = value
  }
  return Object.keys(record).length > 0 ? record : null
}

/**
 * The paid amount from a callback, as an integer of the currency's minor
 * unit — or `null` when the field is not a plain integer. Duitku sends it
 * as a form string; a decimal or empty value is never a payment to apply.
 */
export function parseDuitkuAmount(amount: string): number | null {
  if (!/^\d+$/.test(amount)) return null
  return Number.parseInt(amount, 10)
}
