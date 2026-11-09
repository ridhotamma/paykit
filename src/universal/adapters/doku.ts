import {
  buildDokuCheckoutBody,
  createDokuCheckout,
  describeDokuError,
  DOKU_CHECKOUT_CHANNELS,
  DokuApiError,
  dokuChannelCode,
  dokuChannelKind,
  dokuChannelLabel,
  dokuEmbeddedCheckout,
  dokuExpiryUnixSeconds,
  getDokuTransactionStatus,
  isDokuCheckoutChannel,
  planDokuPaymentUpdate,
  readDokuCredentials,
} from '../../doku'
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

/** The one currency DOKU Checkout settles in. */
const DOKU_CURRENCY = 'IDR'

function channelCategory(code: string): PaymentChannelCategory {
  switch (dokuChannelKind(code)) {
    case 'virtual_account':
      return 'virtual_account'
    case 'card':
      return 'card'
    case 'retail':
      return 'retail'
    case 'qris':
      return 'qris'
    case 'ewallet':
    case 'digital_banking':
      return 'ewallet'
    default:
      return 'other'
  }
}

/**
 * The order's deadline as DOKU `payment_due_date` minutes, or `undefined` for
 * the provider default (60 minutes) when there is no usable deadline.
 *
 * Rounded up so the checkout never dies before the order, and kept inside
 * DOKU's documented six-digit field. The sweeper still cancels the order on
 * time regardless, so a late provider callback noops rather than settling a
 * cancelled order.
 */
export function toDokuExpiryMinutes(
  expiresAt: string | null | undefined,
): number | undefined {
  const seconds = secondsUntilOrderExpiry(expiresAt)
  if (seconds == null) return undefined
  return Math.min(999_999, Math.max(1, Math.ceil(seconds / 60)))
}

/**
 * Refuse to charge when the shop's currency is not the one DOKU settles in.
 *
 * DOKU Checkout amounts are integer rupiah; an order stored in another
 * currency's minor unit would be charged at the wrong value. The channel
 * catalogue is Indonesian, so a non-IDR shop belongs on a different gateway.
 */
function dokuCurrencyReason(shopCurrency: string | undefined): string | null {
  const shop = shopCurrency?.trim().toUpperCase()
  if (!shop || shop === DOKU_CURRENCY) return null
  return (
    `DOKU settles ${DOKU_CURRENCY} orders only, but this shop charges in ${shop}. ` +
    'Connect a gateway that supports the shop currency.'
  )
}

function assertShopCurrency(shopCurrency: string | undefined): void {
  const reason = dokuCurrencyReason(shopCurrency)
  if (reason) throw new Error(reason)
}

export const dokuAdapter: UniversalPaymentAdapter = {
  provider: 'doku',
  name: 'DOKU',
  capabilities: {
    supportsChannels: true,
    supportsStatusRefresh: true,
    supportsTestConnection: true,
    supportsEmbeddedCheckout: true,
  },

  currencyUnsupportedReason(_credentials, _config, currency) {
    return dokuCurrencyReason(currency)
  },

  async getChannels(): Promise<readonly UniversalPaymentChannel[]> {
    // DOKU Checkout has no documented per-project channel endpoint; the
    // supported methods are fixed by the integration, and the merchant
    // enables them in the DOKU Back Office. The static catalogue is enough
    // for the storefront picker without a network round trip.
    return DOKU_CHECKOUT_CHANNELS.map((channel) => ({
      code: channel.code,
      label: channel.label,
      hint: channel.hint,
      category: channelCategory(channel.code),
      logo: digitalChannelLogoPath('doku', channel.code),
    }))
  },

  async charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult> {
    const parsed = readDokuCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    assertShopCurrency(params.currency)

    // Absent means every method enabled on the project — DOKU shows its own
    // picker and the stored label stays the provider name. Present but
    // unknown is a seller-facing error, never a silent downgrade.
    const requestedChannel = params.channel?.trim() ? params.channel.trim() : null
    if (requestedChannel && !isDokuCheckoutChannel(requestedChannel)) {
      throw new Error(
        `Unknown DOKU channel "${params.channel}". Choose one of the checkout channels.`,
      )
    }
    const channel = requestedChannel ? (dokuChannelCode(requestedChannel) ?? requestedChannel) : null

    try {
      const expiresInMinutes = toDokuExpiryMinutes(params.expiresAt)
      const checkout = await createDokuCheckout(
        parsed.credentials,
        buildDokuCheckoutBody({
          order: params.order,
          channel,
          lines: params.lines,
          totals: params.totals,
          returnUrl: params.returnUrl,
          callbackUrl: params.callbackUrl,
          // The checkout dies with the order — see `toDokuExpiryMinutes`.
          // Absent, DOKU's own 60-minute default applies.
          ...(expiresInMinutes !== undefined ? { expiresInMinutes } : {}),
          // A re-charge gets a fresh `invoice_number`; DOKU treats it as
          // unique. See `chargeAttemptReference`.
          existingPaymentReference: params.existingPaymentReference,
        }),
      )

      return {
        paymentLink: checkout.paymentUrl,
        // The status API and notifications both speak the merchant invoice
        // number, which is what this stores.
        paymentReference: checkout.invoiceNumber,
        paymentMethodLabel: (channel ? dokuChannelLabel(channel) : null) ?? 'DOKU',
        paymentLogo: channel ? digitalChannelLogoPath('doku', channel) : null,
        // DOKU Checkout owns the payment details on its hosted page; the
        // create response does not expose a VA number or QR string.
        vaNumber: null,
        qrString: null,
        qrUrl: null,
        expiresAt: dokuExpiryUnixSeconds(checkout.expiredAt),
        // DOKU's own overlay library opens the checkout URL as a modal.
        embedded: dokuEmbeddedCheckout(checkout.paymentUrl, parsed.credentials.environment),
      }
    } catch (error) {
      throw new Error(describeDokuError(error))
    }
  },

  async refresh(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalRefreshParams,
  ): Promise<UniversalRefreshResult> {
    const parsed = readDokuCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    if (!params.paymentReference) {
      throw new Error('This order has no DOKU payment to check yet.')
    }

    try {
      const transaction = await getDokuTransactionStatus(
        parsed.credentials,
        params.paymentReference,
      )

      const plan = planDokuPaymentUpdate(
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
          invoiceNumber: transaction.order.invoice_number,
          amount: transaction.order.amount,
          status: transaction.transaction.status,
          channel: transaction.channel?.id,
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
      // DOKU can answer 404 before the channel has published a transaction —
      // that is "not settled yet", not a failed refresh.
      if (error instanceof DokuApiError && error.status === 404) {
        return { settled: false }
      }
      throw new Error(describeDokuError(error))
    }
  },

  async testConnection(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult> {
    const parsed = readDokuCredentials([credentials, config])
    if (!parsed.ok) return { ok: false, error: parsed.error }

    try {
      // A status read for a fictitious invoice proves the signature and key:
      // an invalid key/signature answers 401, while 400/404 means DOKU
      // processed the request and simply found no such invoice.
      await getDokuTransactionStatus(parsed.credentials, 'PAYKIT-CONNECTION-TEST')
      return { ok: true, environment: parsed.credentials.environment }
    } catch (error) {
      if (error instanceof DokuApiError && (error.status === 400 || error.status === 404)) {
        return { ok: true, environment: parsed.credentials.environment }
      }
      return { ok: false, error: describeDokuError(error) }
    }
  },
}
