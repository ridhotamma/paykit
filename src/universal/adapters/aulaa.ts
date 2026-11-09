import {
  AulaaApiError,
  aulaaChannelKind,
  aulaaChannelLabel,
  AULAA_CHECKOUT_CHANNELS,
  aulaaRemainingAmountFor,
  aulaaAmountProblem,
  buildAulaaPaymentBody,
  createAulaaPayment,
  describeAulaaError,
  getAulaaPayment,
  getAulaaPaymentMethods,
  planAulaaPaymentUpdate,
  readAulaaCredentials,
  type AulaaPayment,
} from '../../aulaa'
import { digitalChannelLogoPath } from '../../channel-logos'
import { aulaaEmbeddedCheckout } from '../../embedded'
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

/** The one currency Aulaa settles in. */
const AULAA_CURRENCY = 'IDR'

function channelCategory(code: string, apiType?: string | null): PaymentChannelCategory {
  const kind =
    aulaaChannelKind(code) ??
    (() => {
      const type = apiType?.trim().toLowerCase().replace(/[\s-]+/g, '_') ?? ''
      if (type === 'card' || type === 'credit_card') return 'card' as const
      if (type === 'qr_code' || type === 'qris') return 'qr_code' as const
      if (type === 'virtual_account' || type === 'va') return 'virtual_account' as const
      if (type === 'e_wallet' || type === 'ewallet') return 'ewallet' as const
      if (type === 'retail' || type === 'convenience_store') return 'retail' as const
      return null
    })()

  switch (kind) {
    case 'card':
      return 'card'
    case 'qr_code':
      return 'qris'
    case 'ewallet':
      return 'ewallet'
    case 'retail':
      return 'retail'
    case 'virtual_account':
      return 'virtual_account'
    default:
      return 'other'
  }
}

/**
 * Refuse to charge when the shop's currency is not the one Aulaa settles in.
 *
 * Aulaa amounts are integer rupiah; an order stored in another currency's
 * minor unit would be charged at the wrong value. The channel catalogue is
 * Indonesian, so a non-IDR shop belongs on a different gateway.
 */
function aulaaCurrencyReason(shopCurrency: string | undefined): string | null {
  const shop = shopCurrency?.trim().toUpperCase()
  if (!shop || shop === AULAA_CURRENCY) return null
  return (
    `Aulaa settles ${AULAA_CURRENCY} orders only, but this shop charges in ${shop}. ` +
    'Connect a gateway that supports the shop currency.'
  )
}

function assertShopCurrency(shopCurrency: string | undefined): void {
  const reason = aulaaCurrencyReason(shopCurrency)
  if (reason) throw new Error(reason)
}

/** An ISO 8601 instant as Unix seconds, or `null` when Aulaa did not state one. */
function unixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null
  const millis = Date.parse(iso)
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null
}

export const aulaaAdapter: UniversalPaymentAdapter = {
  provider: 'aulaa',
  name: 'Aulaa',
  capabilities: {
    supportsChannels: true,
    supportsStatusRefresh: true,
    supportsTestConnection: true,
    supportsEmbeddedCheckout: true,
  },

  currencyUnsupportedReason(_credentials, _config, currency) {
    return aulaaCurrencyReason(currency)
  },

  async getChannels(
    credentials?: Record<string, string>,
    config?: Record<string, string>,
  ): Promise<readonly UniversalPaymentChannel[]> {
    if (credentials) {
      const parsed = readAulaaCredentials([credentials, config ?? {}])
      if (parsed.ok) {
        try {
          const methods = await getAulaaPaymentMethods(parsed.credentials)
          return methods
            .filter((method) => method.is_available !== false)
            .map((method) => {
              const known = AULAA_CHECKOUT_CHANNELS.find(
                (channel) => channel.code === method.code.trim().toLowerCase(),
              )
              return {
                code: method.code,
                label: known?.label || method.name,
                hint: known?.hint,
                category: channelCategory(method.code, method.type),
                logo: digitalChannelLogoPath('aulaa', method.code),
                // The methods endpoint names the amount window, not a fee;
                // fee_amount is only known after the payment is created.
                fee: null,
              }
            })
        } catch {
          return []
        }
      }
    }

    return AULAA_CHECKOUT_CHANNELS.map((channel) => ({
      code: channel.code,
      label: channel.label,
      hint: channel.hint,
      category: channelCategory(channel.code),
      logo: digitalChannelLogoPath('aulaa', channel.code),
    }))
  },

  async charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult> {
    const parsed = readAulaaCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    assertShopCurrency(params.currency)

    const remaining = aulaaRemainingAmountFor(params.order)
    const amountProblem = aulaaAmountProblem(remaining)
    if (amountProblem) throw new Error(amountProblem)

    const channel = params.channel?.trim() ? params.channel.trim().toLowerCase() : null
    const body = buildAulaaPaymentBody({
      order: params.order,
      channel,
      returnUrl: params.returnUrl,
      // A re-charge gets a fresh `order_id`; Aulaa refuses a reused one with
      // 409. See `chargeAttemptReference`.
      existingPaymentReference: params.existingPaymentReference,
    })

    try {
      let payment: AulaaPayment
      try {
        payment = await createAulaaPayment(parsed.credentials, body)
      } catch (error) {
        // A 409 carries the payment created by an earlier request with this
        // same order id — most often a retry after a lost response. Read it
        // back so the retry is idempotent instead of surfacing a dead end.
        if (error instanceof AulaaApiError && error.status === 409 && error.paymentId) {
          payment = await getAulaaPayment(parsed.credentials, error.paymentId)
        } else {
          throw error
        }
      }

      const methodCode = payment.payment_method?.trim().toLowerCase() ?? channel
      const methodLabel = methodCode
        ? (aulaaChannelLabel(methodCode) ?? methodCode)
        : 'Aulaa'

      return {
        paymentLink: payment.payment_link,
        paymentReference: payment.id,
        paymentMethodLabel: methodLabel,
        paymentLogo: methodCode ? digitalChannelLogoPath('aulaa', methodCode) : null,
        // Aulaa stopped exposing VA numbers, raw QRIS strings and retail
        // codes through the API — the payment page owns those details now.
        vaNumber: null,
        qrString: null,
        qrUrl: null,
        expiresAt: unixSeconds(payment.expired_at),
        // Aulaa's own overlay library (`embed.js`) opens the payment link on
        // top of the shop and reports success/close to the page.
        embedded: aulaaEmbeddedCheckout(payment.payment_link),
      }
    } catch (error) {
      throw new Error(describeAulaaError(error))
    }
  },

  async refresh(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalRefreshParams,
  ): Promise<UniversalRefreshResult> {
    const parsed = readAulaaCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    if (!params.paymentReference) {
      throw new Error('This order has no Aulaa payment to check yet.')
    }

    try {
      const payment = await getAulaaPayment(parsed.credentials, params.paymentReference)
      if (payment.status.trim().toLowerCase() !== 'paid') {
        return { settled: false }
      }

      const plan = planAulaaPaymentUpdate(
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
          id: payment.id,
          amount: payment.amount,
          status: payment.status,
          payment_method: payment.payment_method,
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
      throw new Error(describeAulaaError(error))
    }
  },

  async testConnection(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult> {
    const parsed = readAulaaCredentials([credentials, config])
    if (!parsed.ok) return { ok: false, error: parsed.error }

    try {
      await getAulaaPaymentMethods(parsed.credentials)
      // Aulaa has no separate sandbox host; the project mode lives in the
      // dashboard and each payment reports `is_test`. Nothing to report here.
      return { ok: true }
    } catch (error) {
      return { ok: false, error: describeAulaaError(error) }
    }
  },
}
