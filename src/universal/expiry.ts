/**
 * Syncing a gateway invoice's expiry with the order's payment deadline.
 *
 * Every unpaid storefront order carries an `expiresAt` (Shop settings →
 * Orders, 60 minutes unless the seller changed it), and the sweeper cancels
 * whatever is still unpaid past it. A gateway invoice created with the
 * provider's own default (24 hours) would outlive that: the buyer could pay a
 * dead order at hour 23, the callback would noop against the cancelled row,
 * and the money would need a manual refund. So every `charge` carries the
 * order's deadline and each adapter translates it into the provider's own
 * expiry unit — payment expired = order expired.
 *
 * The order deadline always wins ties: when a provider cannot express it
 * (TriPay's per-channel minimum/maximum, Duitku's minute granularity and
 * per-channel caps), the adapter sends the closest the provider allows and
 * the sweeper still cancels on time — a late provider callback then noops
 * instead of settling.
 */

/**
 * Seconds from `now` until the order's deadline, or `null` when there is no
 * usable deadline (absent, unparseable, or already past). `null` means the
 * adapter falls back to the provider's own default — the pre-sync behaviour.
 */
export function secondsUntilOrderExpiry(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!expiresAt) return null
  const deadline = new Date(expiresAt).getTime()
  const base = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(deadline) || !Number.isFinite(base)) return null
  const seconds = Math.floor((deadline - base) / 1000)
  return seconds > 0 ? seconds : null
}
