import {
  createDuitkuClient,
  describeDuitkuError,
  DUITKU_CHECKOUT_CHANNELS,
  planOrderPaymentUpdate,
  readDuitkuCredentials,
  buildDuitkuInquiryParams,
} from '../../duitku'
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
  if (['NQ', 'SP', 'GQ', 'DQ', 'SQ'].includes(code)) return 'qris'
  if (['OV', 'DA', 'LA', 'SA', 'LF', 'SL', 'OL'].includes(code)) return 'ewallet'
  if (['FT', 'IR'].includes(code)) return 'retail'
  if (['VC', 'T1', 'T2', 'T3', 'DN', 'AT', 'JP'].includes(code)) return 'card'
  return 'virtual_account'
}

/**
 * The order's deadline as Duitku `expiryPeriod` minutes, or `undefined` for
 * the provider default (a day) when there is no usable deadline.
 *
 * Rounded *up* so the invoice never dies before the order (Duitku only speaks
 * whole minutes — a 14m59s remainder is a 15-minute invoice, not 14), and
 * clamped to what the provider honours: a day at most, and an hour at most
 * for QRIS channels. A longer shop window still sends the cap — the sweeper
 * cancels the order on time regardless, and the late provider callback noops
 * instead of settling.
 */
export function toDuitkuExpiryMinutes(
  expiresAt: string | null | undefined,
  channel?: string,
): number | undefined {
  const seconds = secondsUntilOrderExpiry(expiresAt)
  if (seconds == null) return undefined
  const cap = channel && channelCategory(channel) === 'qris' ? 60 : 1440
  return Math.min(cap, Math.max(1, Math.ceil(seconds / 60)))
}

/**
 * The fee value off one `paymentFee` entry of Duitku's payment-method
 * response (`totalFee`, an integer string — `"0"` when the project charges
 * the fee to the merchant, so the buyer pays none).
 *
 * `null` means "unknown": absent or unparseable. An explicit zero is kept
 * as `0` — it is a fact ("free for the buyer"), not a missing value, and
 * the storefront renders it as "gratis" instead of a generic fee hint.
 */
function parseDuitkuTotalFee(totalFee: string | null | undefined): number | null {
  if (totalFee == null || String(totalFee).trim() === '') return null
  const feeNum = Number.parseInt(String(totalFee).trim(), 10)
  if (!Number.isFinite(feeNum) || feeNum < 0) return null
  return feeNum
}

export const duitkuAdapter: UniversalPaymentAdapter = {
  provider: 'duitku',
  name: 'Duitku',
  capabilities: {
    supportsChannels: true,
    supportsStatusRefresh: true,
    supportsTestConnection: true,
  },

  async getChannels(
    credentials?: Record<string, string>,
    config?: Record<string, string>,
    amount?: number,
  ): Promise<readonly UniversalPaymentChannel[]> {
    if (credentials) {
      const parsed = readDuitkuCredentials([credentials, config ?? {}])
      if (parsed.ok) {
        try {
          const client = createDuitkuClient(parsed.credentials)
          // Quoted for the real order value: Duitku prices percentage-based
          // channel fees (e-wallets, QRIS, cards) off this amount, so a flat
          // 10_000 default would understate them. Clamped to Duitku's
          // 10_000 minimum, below which the inquiry itself is rejected.
          const quotedAmount = Math.max(
            10_000,
            typeof amount === 'number' && Number.isFinite(amount) ? Math.floor(amount) : 10_000,
          )
          const methods = await client.v2.getPaymentMethods(quotedAmount)
          if (Array.isArray(methods)) {
            return methods
              .filter((m) => !['SL', 'OL', 'DN', 'AT', 'VC'].includes(m.paymentMethod))
              .map((m) => {
                const known = DUITKU_CHECKOUT_CHANNELS.find((c) => c.code === m.paymentMethod)
                return {
                  code: m.paymentMethod,
                  label: known?.label || m.paymentName,
                  hint: known?.hint,
                  category: channelCategory(m.paymentMethod),
                  logo: digitalChannelLogoPath('duitku', m.paymentMethod) || m.paymentImage || null,
                  fee: parseDuitkuTotalFee(m.totalFee),
                }
              })
          }
        } catch {
          return []
        }
      }
    }

    return DUITKU_CHECKOUT_CHANNELS.map((ch) => ({
      code: ch.code,
      label: ch.label,
      hint: ch.hint,
      category: channelCategory(ch.code),
      logo: digitalChannelLogoPath('duitku', ch.code),
    }))
  },

  async charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult> {
    const parsed = readDuitkuCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    if (!params.channel) {
      throw new Error('Please select a payment channel for Duitku.')
    }

    const client = createDuitkuClient(parsed.credentials)

    const callbackUrl = params.callbackUrl || config.callbackUrl
    if (!callbackUrl) {
      throw new Error('Callback URL is required for Duitku payment.')
    }

    // Duitku's inquiry requires somewhere to send the buyer afterwards, and the
    // storefront's confirmation page is the only sensible answer — so there is
    // no credential field for it to be configured in: whoever charges the order
    // builds it, which is what keeps it right for the shop it belongs to.
    const returnUrl = params.returnUrl
    if (!returnUrl) {
      throw new Error('Return URL is required for Duitku payment.')
    }

    try {
      const expiryMinutes = toDuitkuExpiryMinutes(params.expiresAt, params.channel)
      const payment = await client.v2.createPayment(
        buildDuitkuInquiryParams({
          order: {
            tenantId: params.order.tenantId,
            orderNumber: params.order.orderNumber,
            grandTotal: params.order.grandTotal,
            amountPaid: params.order.amountPaid,
            customerName: params.order.customerName,
            customerEmail: params.order.customerEmail ?? '',
            customerPhone: params.order.customerPhone,
          },
          channel: params.channel,
          lines: params.lines,
          totals: params.totals,
          callbackUrl,
          returnUrl,
          // The invoice dies with the order — see `toDuitkuExpiryMinutes`.
          // Absent, the builder falls back to Duitku's own day-long default.
          ...(expiryMinutes !== undefined ? { expiryMinutes } : {}),
        }),
      )

      if (!payment.paymentUrl || !payment.reference) {
        throw new Error('Duitku answered without a payment URL or reference.')
      }

      const channelObj = DUITKU_CHECKOUT_CHANNELS.find((c) => c.code === params.channel)
      return {
        paymentLink: payment.paymentUrl,
        paymentReference: payment.reference,
        paymentMethodLabel: channelObj?.label || params.channel,
        paymentLogo: digitalChannelLogoPath('duitku', params.channel),
        // The v2 inquiry answers VA numbers and the raw QRIS payload on the
        // response itself, so a UI can render them without opening the hosted
        // page. E-wallet/retail inquiries carry neither and keep the link.
        vaNumber: payment.vaNumber ?? null,
        qrString: payment.qrString ?? null,
        qrUrl: null,
      }
    } catch (error) {
      throw new Error(describeDuitkuError(error))
    }
  },

  async refresh(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalRefreshParams,
  ): Promise<UniversalRefreshResult> {
    const parsed = readDuitkuCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    if (!params.paymentReference) {
      throw new Error('This order has no Duitku payment to check yet.')
    }

    const client = createDuitkuClient(parsed.credentials)

    try {
      const status = await client.v2.getTransactionStatus(params.orderNumber)
      if (status.statusCode !== '00') {
        return { settled: false }
      }

      const amount = Number.parseInt(status.amount, 10)
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error('Duitku answered with an invalid payment amount.')
      }

      const plan = planOrderPaymentUpdate(
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
          reference: status.reference || params.paymentReference,
          amount,
          resultCode: '00',
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
      throw new Error(describeDuitkuError(error))
    }
  },

  async testConnection(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult> {
    const parsed = readDuitkuCredentials([credentials, config])
    if (!parsed.ok) return { ok: false, error: parsed.error }

    try {
      await createDuitkuClient(parsed.credentials).v2.getPaymentMethods(10_000)
      return { ok: true, environment: parsed.credentials.environment }
    } catch (error) {
      return { ok: false, error: describeDuitkuError(error) }
    }
  },
}
