/**
 * Payment-channel marks.
 *
 * Both Tripay and Duitku ship a logo with every channel (`icon_url`,
 * `paymentImage`), but both require a live, authenticated call with the
 * *shop's own* credentials. The storefront channel list is static
 * (`adapter.getChannels()` with no credentials), so resolving the mark from a
 * table keeps rendering free and avoids hotlinking a provider CDN.
 *
 * This module resolves a channel code to a **slug** (`bca`, `qris`, …) and
 * leaves the asset path to the caller: `digitalChannelLogoPath` takes a
 * `basePath` so a host can serve the marks from wherever it keeps them.
 * `null` means no vendored mark exists — retail outlets (Alfamart,
 * Indomaret) and ATM Bersama are not in the `idn-finlogos` set — and the
 * caller should render a fallback icon instead of a broken image.
 */

/** Default folder the host serves channel marks from. */
export const DEFAULT_PAYMENT_LOGO_BASE_PATH = '/payment-logos'

const CHANNEL_SLUGS: Readonly<Record<string, string>> = {
  // Tripay virtual accounts.
  BCAVA: 'bca',
  BNIVA: 'bni',
  BRIVA: 'bri',
  MANDIRIVA: 'mandiri',
  PERMATAVA: 'permata',
  CIMBVA: 'cimb-niaga',
  BSIVA: 'bsi',
  MUAMALATVA: 'muamalat',
  DANAMONVA: 'danamon',
  // Tripay QRIS + e-wallets.
  QRIS: 'qris',
  DANA: 'dana',
  SHOPEEPAY: 'shopee-pay',
  OVO: 'ovo',
  // Duitku virtual accounts.
  BC: 'bca',
  BR: 'bri',
  M2: 'mandiri',
  I1: 'bni',
  BT: 'permata',
  B1: 'cimb-niaga',
  BV: 'bsi',
  DM: 'danamon',
  VA: 'maybank',
  // Duitku QRIS + e-wallets.
  SP: 'qris',
  NQ: 'qris',
  DA: 'dana',
  SA: 'shopee-pay',
  OV: 'ovo',
  // Midtrans virtual accounts + e-wallets (shared codes with the gateways above).
  BCA_VA: 'bca',
  BRI_VA: 'bri',
  MANDIRI_VA: 'mandiri',
  BNI_VA: 'bni',
  PERMATA_VA: 'permata',
  CIMB_VA: 'cimb-niaga',
  DANAMON_VA: 'danamon',
  BSI_VA: 'bsi',
  GOPAY: 'gopay',
  // Xendit virtual accounts + e-wallets.
  BCA: 'bca',
  BRI: 'bri',
  MANDIRI: 'mandiri',
  BNI: 'bni',
  PERMATA: 'permata',
  BSI: 'bsi',
  LINKAJA: 'linkaja',
}

/**
 * The vendor-neutral slug for a provider channel code, or `null` when the
 * channel has no vendored mark.
 */
export function paymentChannelSlug(channelCode: string | null | undefined): string | null {
  if (!channelCode) return null
  return CHANNEL_SLUGS[channelCode.toUpperCase()] ?? null
}

/**
 * The path to a channel's mark under the host's asset root.
 *
 * `_gatewayProvider` is accepted for signature stability across adapters and
 * because a host may one day need gateway-specific art — today the slug is
 * unambiguous across providers.
 */
export function digitalChannelLogoPath(
  _gatewayProvider: string | null | undefined,
  channelCode: string | null | undefined,
  basePath: string = DEFAULT_PAYMENT_LOGO_BASE_PATH,
): string | null {
  const slug = paymentChannelSlug(channelCode)
  if (!slug) return null
  return `${basePath.replace(/\/+$/, '')}/${slug}.svg`
}
