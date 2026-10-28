import {
  createTripayClient,
  describeTripayError,
  planTripayPaymentUpdate,
  readTripayCredentials,
  TRIPAY_CHECKOUT_CHANNELS,
  buildTripayTransactionParams,
} from '../../tripay'
import { digitalChannelLogoPath } from '../../channel-logos'
import type {
  PaymentChannelCategory,
  UniversalChargeParams,
  UniversalChargeResult,
  UniversalPaymentAdapter,
  UniversalPaymentChannel,
  UniversalRefreshParams,
  UniversalRefreshResult,
  UniversalTestResult,
} from '../types'
import { secondsUntilOrderExpiry } from '../expiry'

function channelCategory(code: string): PaymentChannelCategory {
  if (code.endsWith('VA')) return 'virtual_account'
  if (code === 'QRIS') return 'qris'
  if (['DANA', 'SHOPEEPAY', 'OVO'].includes(code)) return 'ewallet'
  if (['ALFAMART', 'INDOMARET', 'ALFAMIDI'].includes(code)) return 'retail'
  return 'other'
}

/**
 * Per-channel expiry bounds in minutes, from TriPay's developer docs
 * (`tripay.co.id/developer`, channel table: `Min Expired` / `Max Expired`).
 *
 * There is no global one-hour minimum — it is 60 min on some channels
 * (BRIVA, MANDIRIVA, PERMATAVA, MUAMALATVA, BSIVA, ALFAMART, ALFAMIDI),
 * 15 min on most others (BNIVA, BCAVA, CIMBVA, INDOMARET, OVO, DANA,
 * SHOPEEPAY, …) and 10 min on QRIS. TriPay clamps an out-of-range
 * `expired_time` to the channel's bounds, so the adapter sends the closest
 * the channel allows instead of letting the provider silently stretch it.
 */
const TRIPAY_EXPIRY_BOUNDS_MINUTES: Readonly<Record<string, { min: number; max: number }>> = {
  BCAVA: { min: 15, max: 4320 },
  BNIVA: { min: 15, max: 1440 },
  BRIVA: { min: 60, max: 4320 },
  MANDIRIVA: { min: 60, max: 4320 },
  PERMATAVA: { min: 60, max: 4320 },
  CIMBVA: { min: 15, max: 4320 },
  BSIVA: { min: 60, max: 180 },
  MUAMALATVA: { min: 60, max: 180 },
  OCBCVA: { min: 15, max: 4320 },
  DANAMONVA: { min: 15, max: 4320 },
  OTHERBANKVA: { min: 15, max: 1440 },
  ALFAMART: { min: 60, max: 1440 },
  INDOMARET: { min: 15, max: 4320 },
  ALFAMIDI: { min: 60, max: 1440 },
  QRIS: { min: 10, max: 60 },
  QRISC: { min: 10, max: 1440 },
  QRIS2: { min: 10, max: 1440 },
  QRIS_SHOPEEPAY: { min: 10, max: 60 },
  DANA: { min: 15, max: 60 },
  SHOPEEPAY: { min: 15, max: 60 },
  OVO: { min: 15, max: 4320 },
}

/** Bounds for a channel code TriPay's table does not name. */
const TRIPAY_EXPIRY_FALLBACK_MINUTES = { min: 15, max: 1440 }

/**
 * The order's deadline as Tripay seconds, or `undefined` for the provider
 * default (24 h) when there is no usable deadline.
 *
 * Sent as close to the order's deadline as the channel allows: exact for a
 * 15-minute shop window on a 15-minute-minimum channel (BNI, BCA, CIMB, …),
 * clamped to the channel's own minimum/maximum otherwise (a 15-minute order
 * on BRIVA is a 60-minute invoice — TriPay would stretch it there anyway).
 * The sweeper still cancels the order on time regardless, so a stretched
 * provider invoice can only make a late provider callback noop instead of
 * settling a cancelled order.
 */
export function toTripayExpirySeconds(
  expiresAt: string | null | undefined,
  channel?: string,
): number | undefined {
  const seconds = secondsUntilOrderExpiry(expiresAt)
  if (seconds == null) return undefined
  const bounds =
    (channel ? TRIPAY_EXPIRY_BOUNDS_MINUTES[channel] : undefined) ?? TRIPAY_EXPIRY_FALLBACK_MINUTES
  return Math.min(bounds.max * 60, Math.max(bounds.min * 60, Math.round(seconds)))
}

export const tripayAdapter: UniversalPaymentAdapter = {
  provider: 'tripay',
  name: 'Tripay',
  capabilities: {
    supportsChannels: true,
    supportsStatusRefresh: true,
    supportsTestConnection: true,
  },

  async getChannels(
    credentials?: Record<string, string>,
    config?: Record<string, string>,
  ): Promise<readonly UniversalPaymentChannel[]> {
    if (credentials) {
      const parsed = readTripayCredentials([credentials, config ?? {}])
      if (parsed.ok) {
        try {
          const client = createTripayClient(parsed.credentials)
          const channels = await client.getActiveChannels()
          if (Array.isArray(channels)) {
            return channels.map((ch) => {
              const known = TRIPAY_CHECKOUT_CHANNELS.find((c) => c.code === ch.code)
              // An explicit zero is kept as `0` — the buyer pays no fee
              // ("gratis"), which is a fact, not a missing value. `null`
              // means the channel carried no usable fee at all.
              const flatCandidates = [
                (ch as Record<string, any>).total_fee?.flat,
                (ch as Record<string, any>).fee_customer?.flat,
              ]
              const flat = flatCandidates.find(
                (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0,
              )
              const totalFee = flat ?? null
              return {
                code: ch.code,
                label: known?.label || ch.name,
                hint: known?.hint,
                category: channelCategory(ch.code),
                logo: digitalChannelLogoPath('tripay', ch.code) || ch.icon_url || null,
                fee: totalFee,
              }
            })
          }
        } catch {
          return []
        }
      }
    }

    return TRIPAY_CHECKOUT_CHANNELS.map((ch) => ({
      code: ch.code,
      label: ch.label,
      hint: ch.hint,
      category: channelCategory(ch.code),
      logo: digitalChannelLogoPath('tripay', ch.code),
    }))
  },

  async charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult> {
    const parsed = readTripayCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    if (!params.channel) {
      throw new Error('Please select a payment channel for Tripay.')
    }

    const client = createTripayClient(parsed.credentials)
    const expiresInSeconds = toTripayExpirySeconds(params.expiresAt, params.channel)

    try {
      const tx = await client.createTransaction(
        buildTripayTransactionParams({
          order: params.order,
          channel: params.channel,
          lines: params.lines,
          totals: params.totals,
          callbackUrl: params.callbackUrl,
          returnUrl: params.returnUrl,
          // The invoice dies with the order — see `toTripayExpirySeconds`.
          // Absent, the builder falls back to Tripay's own 24-hour default.
          ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
        }),
      )

      if (!tx.checkout_url) {
        throw new Error('Tripay answered without a checkout URL.')
      }

      return {
        paymentLink: tx.checkout_url,
        paymentReference: tx.reference,
        paymentMethodLabel: tx.payment_name || params.channel,
        paymentLogo: digitalChannelLogoPath('tripay', params.channel),
        // The closed transaction carries the payer-facing code itself:
        // `pay_code` is the VA number (retail outlets get a payment code the
        // same way), QRIS answers with `qr_string`/`qr_url`. A UI that wants
        // to render the number itself reads these instead of the hosted page.
        vaNumber: tx.pay_code ?? null,
        qrString: tx.qr_string ?? null,
        qrUrl: tx.qr_url ?? null,
        expiresAt: typeof tx.expired_time === 'number' ? tx.expired_time : null,
      }
    } catch (error) {
      throw new Error(describeTripayError(error))
    }
  },

  async refresh(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalRefreshParams,
  ): Promise<UniversalRefreshResult> {
    const parsed = readTripayCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    if (!params.paymentReference) {
      throw new Error('This order has no payment reference to check.')
    }

    const client = createTripayClient(parsed.credentials)

    try {
      const tx = await client.getTransaction(params.paymentReference)
      const status = (tx.status ?? '').toUpperCase()
      if (status !== 'PAID') {
        return { settled: false }
      }

      const amount = tx.amount_received ? Number(tx.amount_received) : tx.amount
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error('Tripay answered with an invalid payment amount.')
      }

      const plan = planTripayPaymentUpdate(
        {
          status: params.status,
          paymentStatus: params.paymentStatus,
          amountPaid: params.amountPaid,
          grandTotal: params.grandTotal,
          paymentReference: params.paymentReference,
          paidAt: params.paidAt,
          paymentMethod: params.paymentMethod,
        },
        {
          reference: tx.reference || params.paymentReference,
          merchantRef: tx.merchant_ref || params.orderNumber,
          paymentMethod: tx.payment_method,
          amount,
          status: 'PAID',
          paidAt:
            typeof tx.paid_at === 'number' ? tx.paid_at : tx.paid_at ? Number(tx.paid_at) : null,
        },
      )

      if (plan.action === 'noop') {
        return { settled: false }
      }

      return {
        settled: true,
        amountPaid: plan.amountPaid,
        paymentStatus: plan.paymentStatus,
        paymentReference: plan.paymentReference,
        paidAt: plan.paidAt,
        paymentMethod: plan.paymentMethod,
        orderStatus: plan.orderStatus,
      }
    } catch (error) {
      throw new Error(describeTripayError(error))
    }
  },

  async testConnection(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult> {
    const parsed = readTripayCredentials([credentials, config])
    if (!parsed.ok) return { ok: false, error: parsed.error }

    try {
      await createTripayClient(parsed.credentials).getChannels()
      return { ok: true, environment: parsed.credentials.environment }
    } catch (error) {
      return { ok: false, error: describeTripayError(error) }
    }
  },
}
