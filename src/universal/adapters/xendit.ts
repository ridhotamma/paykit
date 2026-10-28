import {
  buildXenditSessionBody,
  createXenditSession,
  describeXenditError,
  getXenditInvoice,
  getXenditPaymentSession,
  isXenditCheckoutChannel,
  isXenditCompletedSession,
  isXenditPaidInvoice,
  parseXenditInvoice,
  parseXenditSession,
  planXenditPaymentUpdate,
  readXenditCredentials,
  verifyXenditSecretKey,
  xenditChannelFitsAmount,
  xenditChannelLabel,
  xenditChannelLimitFor,
  xenditInvoiceAmount,
  xenditKeyEnvironment,
  xenditRemainingAmountFor,
  xenditSessionAmount,
  xenditSessionChannel,
  XENDIT_CHECKOUT_CHANNELS,
  type XenditCredentials,
} from '../../xendit'
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

/** The one currency PayKit's Xendit catalogue settles in. */
const XENDIT_CURRENCY = 'IDR'

function channelCategory(code: string): PaymentChannelCategory {
  if (code === 'QRIS') return 'qris'
  if (code === 'CARD') return 'card'
  if (['DANA', 'OVO', 'SHOPEEPAY', 'LINKAJA'].includes(code)) return 'ewallet'
  if (['ALFAMART', 'INDOMARET'].includes(code)) return 'retail'
  return 'virtual_account'
}

/**
 * Refuse to charge when the shop's currency is not the one the session
 * settles in.
 *
 * Session amounts are integer IDR; an order stored in another currency's
 * minor unit would be charged at the wrong value (a USD order of 12.50 sent
 * as 1250 rupiah). The adapter's channel catalogue is Indonesian, so a
 * non-IDR shop belongs on a different gateway.
 */
function xenditCurrencyReason(shopCurrency: string | undefined): string | null {
  const shop = shopCurrency?.trim().toUpperCase()
  if (!shop || shop === XENDIT_CURRENCY) return null
  return (
    `Xendit settles ${XENDIT_CURRENCY} orders only, but this shop charges in ${shop}. ` +
    'Connect a gateway that supports the shop currency.'
  )
}

function assertShopCurrency(shopCurrency: string | undefined): void {
  const reason = xenditCurrencyReason(shopCurrency)
  if (reason) throw new Error(reason)
}

/**
 * The order's deadline as a session `expires_at` (ISO 8601), or `undefined`
 * for the provider default (30 minutes) when there is no usable deadline.
 *
 * Clamped to what the provider honours — a minute at the low end and three
 * days at the high end. The sweeper still cancels the order on time
 * regardless, so a stretched provider session can only make a late callback
 * noop instead of settling a cancelled order.
 */
export function toXenditExpiryDate(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): string | undefined {
  const seconds = secondsUntilOrderExpiry(expiresAt, now)
  if (seconds == null) return undefined
  const clamped = Math.min(259200, Math.max(60, Math.ceil(seconds)))
  return new Date(now.getTime() + clamped * 1000).toISOString()
}

/** The reconciled shape both session and legacy reads collapse to. */
interface ReconciledXenditPayment {
  id: string
  amount: number | null
  status: string
  channel: string | null
}

/**
 * Read the payment Xendit stored for the reference PayKit charged with.
 *
 * New charges are Payment Sessions (`ps-…`); charges created before the
 * migration are legacy invoices (24-hex ids). Both are read back through the
 * API with the shop's key before anything moves money.
 */
async function reconcileXenditPayment(
  credentials: XenditCredentials,
  reference: string,
): Promise<ReconciledXenditPayment> {
  if (reference.startsWith('ps-')) {
    const session = parseXenditSession(await getXenditPaymentSession(credentials, reference))
    if (!session) throw new Error('Xendit session response is missing its id or status.')
    return {
      id: session.payment_session_id,
      amount: xenditSessionAmount(session),
      status: session.status,
      channel: xenditSessionChannel(session),
    }
  }

  const invoice = parseXenditInvoice(await getXenditInvoice(credentials, reference))
  if (!invoice) throw new Error('Xendit invoice response is missing its id or status.')
  return {
    id: invoice.id,
    amount: xenditInvoiceAmount(invoice),
    status: invoice.status,
    channel: invoice.payment_channel ?? null,
  }
}

function isReconciledPaid(payment: ReconciledXenditPayment): boolean {
  return payment.id.startsWith('ps-')
    ? isXenditCompletedSession({ status: payment.status })
    : isXenditPaidInvoice({ status: payment.status })
}

/** The seller-readable refusal for a channel the outstanding balance cannot use. */
function describeChannelLimit(channel: string, amount: number): string {
  const limit = xenditChannelLimitFor(channel)
  const label = xenditChannelLabel(channel) ?? channel
  if (!limit) return `Xendit's ${label} cannot take this order's balance.`
  return `${label} accepts ${limit.min.toLocaleString('id-ID')}–${limit.max.toLocaleString('id-ID')} IDR, but this order's outstanding balance is ${amount.toLocaleString('id-ID')} IDR.`
}

export const xenditAdapter: UniversalPaymentAdapter = {
  provider: 'xendit',
  name: 'Xendit',
  capabilities: {
    supportsChannels: true,
    supportsStatusRefresh: true,
    supportsTestConnection: true,
  },

  currencyUnsupportedReason(_credentials, _config, currency) {
    return xenditCurrencyReason(currency)
  },

  async getChannels(
    _credentials?: Record<string, string>,
    _config?: Record<string, string>,
    amount?: number,
  ): Promise<readonly UniversalPaymentChannel[]> {
    // No live channel catalogue: the Session API has no per-channel endpoint
    // the way Tripay/Duitku do. The buyer choices are fixed by the
    // integration itself, so the list is static — no credentials needed, and
    // the storefront renders it without a round trip.
    //
    // With a known order amount, the channels whose documented window the
    // amount misses are hidden: a Rp 5.000 order has no Alfamart option
    // because Xendit refuses the session. Without an amount (a settings
    // preview, say) the full catalogue shows.
    const usableChannels =
      typeof amount === 'number' && Number.isFinite(amount) && amount > 0
        ? XENDIT_CHECKOUT_CHANNELS.filter((channel) =>
            xenditChannelFitsAmount(channel.code, amount),
          )
        : XENDIT_CHECKOUT_CHANNELS

    return usableChannels.map((channel) => ({
      code: channel.code,
      label: channel.label,
      hint: channel.hint,
      category: channelCategory(channel.code),
      logo: digitalChannelLogoPath('xendit', channel.code),
    }))
  },

  async charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult> {
    const parsed = readXenditCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    assertShopCurrency(params.currency)

    // Absent means every active method — the session offers the full list
    // and the stored label stays the provider name. Present but unknown is
    // a seller-facing error, never a silent downgrade to the full list.
    const channel = params.channel?.trim() ? params.channel.trim().toUpperCase() : null
    if (channel && !isXenditCheckoutChannel(channel)) {
      throw new Error(
        `Unknown Xendit channel "${params.channel}". Choose one of the checkout channels.`,
      )
    }

    // A channel picked before the amount changed (or through a stale page)
    // must fail with an explanation, not Xendit's raw validation error.
    if (channel) {
      const remaining = xenditRemainingAmountFor(params.order)
      if (!xenditChannelFitsAmount(channel, remaining)) {
        throw new Error(describeChannelLimit(channel, remaining))
      }
    }

    try {
      const expiresAt = toXenditExpiryDate(params.expiresAt)
      const session = await createXenditSession(
        parsed.credentials,
        buildXenditSessionBody({
          order: params.order,
          channel,
          lines: params.lines,
          totals: params.totals,
          returnUrl: params.returnUrl,
          currency: params.currency ?? XENDIT_CURRENCY,
          // A re-charge gets a fresh `reference_id`; Xendit wants a unique
          // reference for card payment requests. See `chargeAttemptReference`.
          existingPaymentReference: params.existingPaymentReference,
          // The session dies with the order — see `toXenditExpiryDate`.
          // Absent, Xendit's own 30-minute default applies.
          ...(expiresAt ? { expiresAt } : {}),
        }),
      )

      return {
        paymentLink: session.payment_link_url!,
        paymentReference: session.payment_session_id,
        paymentMethodLabel: (channel ? xenditChannelLabel(channel) : null) ?? 'Xendit',
        paymentLogo: channel ? digitalChannelLogoPath('xendit', channel) : null,
        // Hosted-checkout provider: the buyer picks the method on Xendit's
        // own page, so there is no VA number or QR payload to render
        // in-app — the link is the payment.
        vaNumber: null,
        qrString: null,
        qrUrl: null,
      }
    } catch (error) {
      throw new Error(describeXenditError(error))
    }
  },

  async refresh(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalRefreshParams,
  ): Promise<UniversalRefreshResult> {
    const parsed = readXenditCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    if (!params.paymentReference) {
      throw new Error('This order has no Xendit payment to check yet.')
    }

    try {
      const reconciled = await reconcileXenditPayment(parsed.credentials, params.paymentReference)
      if (!isReconciledPaid(reconciled)) {
        return { settled: false }
      }

      const amount = reconciled.amount
      if (amount === null || amount <= 0) {
        throw new Error('Xendit answered with an invalid payment amount.')
      }

      const plan = planXenditPaymentUpdate(
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
          id: reconciled.id,
          amount,
          status: reconciled.status,
          paymentChannel: reconciled.channel,
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
      throw new Error(describeXenditError(error))
    }
  },

  async testConnection(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult> {
    const parsed = readXenditCredentials([credentials, config])
    if (!parsed.ok) return { ok: false, error: parsed.error }

    try {
      // A one-row invoice read proves the key authenticates and carries the
      // Money-in permission: an invalid key answers 401, an under-permissioned
      // one 403.
      await verifyXenditSecretKey(parsed.credentials)
      return { ok: true, environment: xenditKeyEnvironment(parsed.credentials.secretKey) }
    } catch (error) {
      return { ok: false, error: describeXenditError(error) }
    }
  },
}
