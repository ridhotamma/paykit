import {
  buildMidtransSnapBody,
  createMidtransSnapTransaction,
  describeMidtransError,
  getMidtransTransactionStatus,
  isMidtransCheckoutChannel,
  isMidtransPaidTransaction,
  midtransBankCode,
  midtransChannelLabel,
  midtransTransactionAmount,
  MIDTRANS_CHECKOUT_CHANNELS,
  MidtransApiError,
  parseMidtransTransaction,
  planMidtransPaymentUpdate,
  readMidtransCredentials,
} from '../../midtrans'
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
  if (code === 'QRIS') return 'qris'
  if (code === 'CARD') return 'card'
  if (['GOPAY', 'SHOPEEPAY'].includes(code)) return 'ewallet'
  if (['ALFAMART', 'INDOMARET'].includes(code)) return 'retail'
  return 'virtual_account'
}

/** The one currency PayKit's Midtrans catalogue settles in. */
const MIDTRANS_CURRENCY = 'IDR'

/**
 * Refuse to charge when the shop's currency is not the one Snap settles in.
 *
 * Snap amounts are integer IDR; an order stored in another currency's minor
 * unit would be charged at the wrong value (a USD order of 12.50 sent as
 * 1250 rupiah). The channel catalogue is Indonesian, so a non-IDR shop
 * belongs on a different gateway.
 */
function midtransCurrencyReason(shopCurrency: string | undefined): string | null {
  const shop = shopCurrency?.trim().toUpperCase()
  if (!shop || shop === MIDTRANS_CURRENCY) return null
  return (
    `Midtrans settles ${MIDTRANS_CURRENCY} orders only, but this shop charges in ${shop}. ` +
    'Connect a gateway that supports the shop currency.'
  )
}

function assertShopCurrency(shopCurrency: string | undefined): void {
  const reason = midtransCurrencyReason(shopCurrency)
  if (reason) throw new Error(reason)
}

/**
 * The order's deadline as Snap `expiry.duration` minutes, or `undefined`
 * for the provider default (a day) when there is no usable deadline.
 *
 * Rounded *up* so the Snap transaction never dies before the order (Snap
 * only speaks whole minutes), and clamped to what the provider honours: a
 * minute at the low end (Snap's floor is ~20 seconds) and three days at the
 * high end. A longer shop window still sends the cap — the sweeper cancels
 * the order on time regardless, and the late provider notification noops
 * instead of settling.
 */
export function toMidtransExpiryMinutes(expiresAt: string | null | undefined): number | undefined {
  const seconds = secondsUntilOrderExpiry(expiresAt)
  if (seconds == null) return undefined
  return Math.min(4320, Math.max(1, Math.ceil(seconds / 60)))
}

export const midtransAdapter: UniversalPaymentAdapter = {
  provider: 'midtrans',
  name: 'Midtrans',
  capabilities: {
    supportsChannels: true,
    supportsStatusRefresh: true,
    supportsTestConnection: true,
  },

  currencyUnsupportedReason(_credentials, _config, currency) {
    return midtransCurrencyReason(currency)
  },

  async getChannels(): Promise<readonly UniversalPaymentChannel[]> {
    // No live channel catalogue: Snap has no per-channel endpoint the way
    // Tripay/Duitku do. The buyer choices are fixed by the integration
    // itself, so the list is static — no credentials needed, and the
    // storefront renders it without a round trip.
    return MIDTRANS_CHECKOUT_CHANNELS.map((channel) => ({
      code: channel.code,
      label: channel.label,
      hint: channel.hint,
      category: channelCategory(channel.code),
      logo: digitalChannelLogoPath('midtrans', channel.code),
    }))
  },

  async charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult> {
    const parsed = readMidtransCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    assertShopCurrency(params.currency)

    // Absent means every active type — Snap shows the full payment list and
    // the stored label stays the provider name. Present but unknown is a
    // seller-facing error, never a silent downgrade to the full list.
    const channel = params.channel?.trim() ? params.channel.trim().toUpperCase() : null
    if (channel && !isMidtransCheckoutChannel(channel)) {
      throw new Error(
        `Unknown Midtrans channel "${params.channel}". Choose one of the checkout channels.`,
      )
    }

    try {
      const expiresInMinutes = toMidtransExpiryMinutes(params.expiresAt)
      const body = buildMidtransSnapBody({
        order: params.order,
        channel,
        lines: params.lines,
        totals: params.totals,
        returnUrl: params.returnUrl,
        // A re-charge gets a fresh `order_id`; Midtrans refuses a still-active
        // one. See `chargeAttemptReference`.
        existingPaymentReference: params.existingPaymentReference,
        // The Snap transaction dies with the order — see
        // `toMidtransExpiryMinutes`. Absent, Midtrans' own default applies.
        ...(expiresInMinutes !== undefined ? { expiresInMinutes } : {}),
      })
      const snap = await createMidtransSnapTransaction(parsed.credentials, body, {
        // The webhook URL rides on the create request as
        // `X-Override-Notification`, so Snap reaches `/store/<slug>/midtrans`
        // without the seller configuring the dashboard Notification URL.
        notificationUrl: params.callbackUrl,
      })

      return {
        paymentLink: snap.redirect_url,
        // The status API is keyed by `order_id` (with its attempt suffix),
        // never by the Snap token, so that is what refresh and the webhook
        // correlate on.
        paymentReference: body.transaction_details.order_id,
        paymentMethodLabel: (channel ? midtransChannelLabel(channel) : null) ?? 'Midtrans',
        paymentLogo: channel ? digitalChannelLogoPath('midtrans', channel) : null,
        // Hosted-checkout provider: the buyer picks the method on Midtrans'
        // own page, so there is no VA number or QR payload to render
        // in-app — the link is the payment.
        vaNumber: null,
        qrString: null,
        qrUrl: null,
      }
    } catch (error) {
      throw new Error(describeMidtransError(error))
    }
  },

  async refresh(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalRefreshParams,
  ): Promise<UniversalRefreshResult> {
    const parsed = readMidtransCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    try {
      // The status API takes the `order_id` the charge sent — including a
      // re-charge's attempt suffix — not the Snap token. Legacy orders whose
      // reference is still the token fall back to the plain order number.
      const reference = params.paymentReference?.trim() ?? ''
      const statusOrderId = reference.startsWith(params.orderNumber)
        ? reference
        : params.orderNumber
      const raw = await getMidtransTransactionStatus(parsed.credentials, statusOrderId)
      const transaction = parseMidtransTransaction(raw)
      if (!transaction || !isMidtransPaidTransaction(transaction)) {
        return { settled: false }
      }

      const amount = midtransTransactionAmount(transaction)
      if (amount === null || amount <= 0) {
        throw new Error('Midtrans answered with an invalid payment amount.')
      }

      const plan = planMidtransPaymentUpdate(
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
          id: transaction.transaction_id || params.orderNumber,
          amount,
          status: transaction.transaction_status,
          fraudStatus: transaction.fraud_status,
          paymentType: transaction.payment_type,
          bank: midtransBankCode(transaction),
          store: transaction.store,
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
      // No transaction yet (or an expired one Midtrans pruned) is the normal
      // "check too early" answer, not a failure — the button simply reports
      // nothing settled.
      if (error instanceof MidtransApiError && error.status === 404) {
        return { settled: false }
      }
      throw new Error(describeMidtransError(error))
    }
  },

  async testConnection(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult> {
    const parsed = readMidtransCredentials([credentials, config])
    if (!parsed.ok) return { ok: false, error: parsed.error }

    try {
      // Midtrans has no ping endpoint, so the test reads a transaction that
      // cannot exist: a 404 proves the server key authenticated (an invalid
      // key answers 401 instead).
      await getMidtransTransactionStatus(parsed.credentials, '__paykit-connection-test__')
      return { ok: true, environment: parsed.credentials.environment }
    } catch (error) {
      if (error instanceof MidtransApiError && error.status === 404) {
        return { ok: true, environment: parsed.credentials.environment }
      }
      return { ok: false, error: describeMidtransError(error) }
    }
  },
}
