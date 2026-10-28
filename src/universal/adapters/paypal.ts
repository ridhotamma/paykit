import {
  approveLinkFrom,
  buildPaypalOrderBody,
  capturePaypalOrder,
  createPaypalOrder,
  describePaypalError,
  getPaypalAccessToken,
  isPaypalCheckoutChannel,
  paypalChannelLabel,
  paypalCapturesFromOrder,
  paypalRequestId,
  PAYPAL_CHECKOUT_CHANNELS,
  planPaypalPaymentUpdate,
  readPaypalCredentials,
  showPaypalOrder,
  toPaypalCaptureAmount,
  type PaypalCredentials,
} from '../../paypal'
import type {
  UniversalChargeParams,
  UniversalChargeResult,
  UniversalPaymentAdapter,
  UniversalPaymentChannel,
  UniversalRefreshParams,
  UniversalRefreshResult,
  UniversalTestResult,
} from '../types'

function channelCategory(code: string): UniversalPaymentChannel['category'] {
  if (code === 'card') return 'card'
  if (code === 'paypal') return 'ewallet'
  return 'other'
}

/**
 * Refuse to charge when the connection's currency and the shop's own
 * currency disagree.
 *
 * The stored order amount is in the shop currency's minor unit and is
 * formatted with the *connection's* currency — a mismatch silently charges a
 * different amount (an IDR order rendered as USD is off by 100x). The
 * registry already warns, but a warning is not a guard: this is the money
 * path and a mis-configured shop must fail loudly instead.
 */
function paypalCurrencyReason(
  credentials: PaypalCredentials,
  shopCurrency: string | undefined,
): string | null {
  const shop = shopCurrency?.trim().toUpperCase()
  if (!shop) return null
  if (shop !== credentials.currency) {
    return (
      `This PayPal connection charges in ${credentials.currency}, but the shop's currency is ${shop}. ` +
      'Set the connection currency to the shop currency or connect a different gateway.'
    )
  }
  return null
}

function assertShopCurrency(
  credentials: PaypalCredentials,
  shopCurrency: string | undefined,
): void {
  const reason = paypalCurrencyReason(credentials, shopCurrency)
  if (reason) throw new Error(reason)
}

export const paypalAdapter: UniversalPaymentAdapter = {
  provider: 'paypal',
  name: 'PayPal',
  capabilities: {
    supportsChannels: true,
    supportsStatusRefresh: true,
    supportsTestConnection: true,
  },

  currencyUnsupportedReason(credentials, config, currency) {
    const parsed = readPaypalCredentials([credentials, config])
    if (!parsed.ok) return parsed.error
    return paypalCurrencyReason(parsed.credentials, currency)
  },

  async getChannels(): Promise<readonly UniversalPaymentChannel[]> {
    // No live channel catalogue: a PayPal REST app has no per-channel
    // endpoint the way Tripay/Duitku do. The three buyer choices are fixed
    // by the integration itself, so the list is static — no credentials
    // needed, and the storefront renders it without a round trip.
    return PAYPAL_CHECKOUT_CHANNELS.map((channel) => ({
      code: channel.code,
      label: channel.label,
      hint: channel.hint,
      category: channelCategory(channel.code),
      logo: null,
    }))
  },

  async charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult> {
    const parsed = readPaypalCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    assertShopCurrency(parsed.credentials, params.currency)

    const channel = params.channel?.trim() || 'paypal'
    if (!isPaypalCheckoutChannel(channel)) {
      throw new Error(
        `Unknown PayPal channel "${params.channel}". Choose PayPal, Pay Later or Card.`,
      )
    }

    if (!params.returnUrl) {
      throw new Error('Return URL is required for PayPal payment.')
    }

    try {
      const body = buildPaypalOrderBody({
        order: params.order,
        currency: parsed.credentials.currency,
        returnUrl: params.returnUrl,
        brandName: params.shopName,
        // A re-charge suffixes `invoice_id` (duplicate-invoice blocking) and
        // uses a fresh `PayPal-Request-Id`.
        existingPaymentReference: params.existingPaymentReference,
      })
      const created = await createPaypalOrder(
        parsed.credentials,
        body,
        paypalRequestId(params.order.orderNumber, params.existingPaymentReference),
      )
      const paymentLink = approveLinkFrom(created)
      if (!paymentLink) {
        throw new Error('PayPal answered without an approval link.')
      }

      return {
        paymentLink,
        paymentReference: created.id,
        paymentMethodLabel: paypalChannelLabel(channel) ?? 'PayPal',
        paymentLogo: null,
        // Hosted-approval provider: the buyer picks the funding source on
        // PayPal's own page (or in the embedded Buttons / Card Fields the
        // frontend renders around this same order id), so there is no VA
        // number or QR payload to render in-app — the link is the payment.
        vaNumber: null,
        qrString: null,
        qrUrl: null,
      }
    } catch (error) {
      throw new Error(describePaypalError(error))
    }
  },

  async refresh(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalRefreshParams,
  ): Promise<UniversalRefreshResult> {
    const parsed = readPaypalCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    if (!params.paymentReference) {
      throw new Error('This order has no PayPal payment to check yet.')
    }

    const currency = parsed.credentials.currency

    try {
      let shown = await showPaypalOrder(parsed.credentials, params.paymentReference)

      // The buyer approved on PayPal's page (or in Card Fields) but nothing
      // captured yet: capture now, so a return-URL visit settles the order
      // even when the webhook is still in flight. The capture is
      // idempotent per order (`invoice_id`), so racing the webhook credits
      // once — the planner noops the loser.
      if (shown.status.toUpperCase() === 'APPROVED') {
        try {
          shown = await capturePaypalOrder(parsed.credentials, params.paymentReference)
        } catch {
          // A lost race (the webhook captured first) or a transient capture
          // failure both land here. Re-read before giving up: an order the
          // webhook already captured is COMPLETED, and reporting it as
          // unsettled would hide a real payment from the buyer.
          try {
            shown = await showPaypalOrder(parsed.credentials, params.paymentReference)
          } catch {
            return { settled: false }
          }
        }
      }

      if (shown.status.toUpperCase() !== 'COMPLETED') {
        return { settled: false }
      }

      const captures = paypalCapturesFromOrder(shown)
      // The first completed capture settles; a second unit on a hand-edited
      // order settles via the webhook, which reconciles every capture.
      const completed = captures.find((capture) => capture.status.toUpperCase() === 'COMPLETED')
      if (!completed) return { settled: false }

      const reconciled = toPaypalCaptureAmount(completed, currency)
      if (reconciled.amount === null) {
        throw new Error(
          `PayPal answered in ${reconciled.currency}, but this connection charges in ${currency}.`,
        )
      }

      const plan = planPaypalPaymentUpdate(
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
          amount: reconciled.amount,
          status: reconciled.status,
          // A capture never names its funding source, so the label the
          // charge stamped (PayPal / Pay Later / Card) is kept as-is.
          paymentMethod: params.paymentMethod ?? 'PayPal',
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
      throw new Error(describePaypalError(error))
    }
  },

  async testConnection(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult> {
    const parsed = readPaypalCredentials([credentials, config])
    if (!parsed.ok) return { ok: false, error: parsed.error }

    try {
      await getPaypalAccessToken(parsed.credentials)
      return { ok: true, environment: parsed.credentials.environment }
    } catch (error) {
      return { ok: false, error: describePaypalError(error) }
    }
  },
}
