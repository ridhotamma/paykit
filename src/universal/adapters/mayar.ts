import {
  buildMayarInvoiceParams,
  buildMayarPaymentLinkParams,
  createMayarClient,
  describeMayarError,
  readMayarCredentials,
} from '../../mayar'
import type {
  UniversalChargeParams,
  UniversalChargeResult,
  UniversalPaymentAdapter,
  UniversalPaymentChannel,
  UniversalTestResult,
} from '../types'
import { secondsUntilOrderExpiry } from '../expiry'

/**
 * The order's deadline as Mayar `expiresInHours`, or `undefined` for the
 * provider default (a day) when there is no usable deadline.
 *
 * Mayar takes an absolute `expiredAt`, so any precision survives — a
 * 15-minute shop window is a 0.25-hour invoice. Floored at a minute so a
 * deadline seconds away never sends an already-past instant.
 */
export function toMayarExpiryHours(expiresAt: string | null | undefined): number | undefined {
  const seconds = secondsUntilOrderExpiry(expiresAt)
  if (seconds == null) return undefined
  return Math.max(1 / 60, seconds / 3600)
}

export const mayarAdapter: UniversalPaymentAdapter = {
  provider: 'mayar',
  name: 'Mayar',
  capabilities: {
    supportsChannels: false,
    supportsStatusRefresh: false,
    supportsTestConnection: true,
  },

  async getChannels(): Promise<readonly UniversalPaymentChannel[]> {
    return []
  },

  async charge(
    credentials: Record<string, string>,
    config: Record<string, string>,
    params: UniversalChargeParams,
  ): Promise<UniversalChargeResult> {
    const parsed = readMayarCredentials([credentials, config])
    if (!parsed.ok) throw new Error(parsed.error)

    const client = createMayarClient(parsed.credentials)

    try {
      // The invoice dies with the order — see `toMayarExpiryHours`. Absent,
      // the builders fall back to Mayar's own day-long default.
      const expiresInHours = toMayarExpiryHours(params.expiresAt)
      if (params.order.customerEmail && params.order.customerPhone) {
        const invoice = await client.invoices.create(
          buildMayarInvoiceParams({
            order: params.order,
            email: params.order.customerEmail,
            mobile: params.order.customerPhone,
            lines: params.lines,
            totals: params.totals,
            redirectUrl: params.returnUrl,
            ...(expiresInHours !== undefined ? { expiresInHours } : {}),
          }),
        )
        return {
          paymentLink: invoice.link,
          paymentReference: invoice.id,
          paymentMethodLabel: 'Mayar',
          paymentLogo: null,
        }
      }

      const paymentLink = await client.products.createPaymentLink(
        buildMayarPaymentLinkParams({
          order: params.order,
          shopName: params.shopName || params.order.tenantId,
          redirectUrl: params.returnUrl,
          ...(expiresInHours !== undefined ? { expiresInHours } : {}),
        }),
      )
      return {
        paymentLink: paymentLink.link,
        paymentReference: paymentLink.id,
        paymentMethodLabel: 'Mayar',
        paymentLogo: null,
      }
    } catch (error) {
      throw new Error(describeMayarError(error))
    }
  },

  async testConnection(
    credentials: Record<string, string>,
    config: Record<string, string>,
  ): Promise<UniversalTestResult> {
    const parsed = readMayarCredentials([credentials, config])
    if (!parsed.ok) return { ok: false, error: parsed.error }

    try {
      await createMayarClient(parsed.credentials).transactions.getBalance()
      return { ok: true, environment: parsed.credentials.environment }
    } catch (error) {
      return { ok: false, error: describeMayarError(error) }
    }
  },
}
