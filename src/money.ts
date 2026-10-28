/**
 * Money helpers.
 *
 * Every amount crossing an adapter is an integer in the currency's **minor
 * unit**: 1250 is $12.50, and — because the rupiah has no circulating minor
 * unit — 12500 is Rp 12.500. Gateways that take a decimal string
 * (PayPal's `amount.value`) format at the edge, using the same table.
 */

/**
 * Minor-unit digits per currency.
 *
 * `Intl.NumberFormat` knows this table, but only at format time — adapters
 * need it while building a request payload — so it is spelled out. Anything
 * not here falls back to 2, which is right for most of the world.
 */
const MINOR_UNIT_DIGITS: Readonly<Record<string, number>> = {
  IDR: 0,
  JPY: 0,
  KRW: 0,
  VND: 0,
  USD: 2,
  EUR: 2,
  SGD: 2,
  MYR: 2,
  AUD: 2,
  GBP: 2,
}

/** How many decimal places a currency's minor unit has. Unknown codes → 2. */
export function minorUnitDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency.toUpperCase()] ?? 2
}
