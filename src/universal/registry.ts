import { duitkuAdapter } from './adapters/duitku'
import { mayarAdapter } from './adapters/mayar'
import { midtransAdapter } from './adapters/midtrans'
import { paypalAdapter } from './adapters/paypal'
import { tripayAdapter } from './adapters/tripay'
import { xenditAdapter } from './adapters/xendit'
import type {
  UniversalGatewayInfo,
  UniversalPaymentAdapter,
  UniversalPaymentChannel,
} from './types'

/**
 * The gateway registry — one entry per provider this package implements.
 *
 * Adding a gateway is appending to this object (and its subpath export);
 * nothing downstream hardcodes a provider name. Lookups are case-insensitive
 * because provider ids arrive from stored config and URL segments alike.
 */
const ADAPTERS: Readonly<Record<string, UniversalPaymentAdapter>> = {
  tripay: tripayAdapter,
  duitku: duitkuAdapter,
  mayar: mayarAdapter,
  paypal: paypalAdapter,
  midtrans: midtransAdapter,
  xendit: xenditAdapter,
}

/** The adapter for `provider`, or `undefined` when it is not implemented. */
export function getPaymentAdapter(provider: string): UniversalPaymentAdapter | undefined {
  return ADAPTERS[provider.toLowerCase()]
}

/** Every implemented adapter. */
export function listPaymentAdapters(): readonly UniversalPaymentAdapter[] {
  return Object.values(ADAPTERS)
}

/** Static info about a gateway, without its live channel list. */
export function getPaymentGatewayInfo(provider: string): UniversalGatewayInfo | undefined {
  const adapter = getPaymentAdapter(provider)
  if (!adapter) return undefined
  return {
    provider: adapter.provider,
    name: adapter.name,
    capabilities: adapter.capabilities,
    channels: [],
  }
}

/**
 * Ask one gateway for its channels.
 *
 * `credentials`/`config` are optional because most adapters serve a static
 * catalog; the ones that need an authenticated call (Duitku) return `[]`
 * without them rather than throwing.
 */
export async function getAvailablePaymentChannels(
  provider: string,
  credentials?: Record<string, string>,
  config?: Record<string, string>,
  amount?: number,
): Promise<readonly UniversalPaymentChannel[]> {
  const adapter = getPaymentAdapter(provider)
  if (!adapter) return []
  return await adapter.getChannels(credentials, config, amount)
}
