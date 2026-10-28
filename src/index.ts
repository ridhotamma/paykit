/**
 * PayKit — provider-agnostic payment gateway adapters.
 *
 * The root barrel exports the provider-agnostic surface: contracts, registry,
 * credential handling and the small primitives every adapter shares. Vendor
 * SDKs are deliberately *not* reachable from here — import a gateway through
 * its own subpath (`paykit/midtrans`, `paykit/xendit`, …) so a bundle only
 * pulls the SDK it actually uses.
 */

export * from './types'
export * from './providers/registry'
export * from './credentials'
export * from './credentials-envelope'
export * from './charge-provider'
export * from './webhook-auth'

/* Shared primitives, exported for hosts that write their own adapters. */
export * from './order-status'
export * from './money'
export * from './channel-logos'
export { timingSafeEqual } from './timing-safe'

/**
 * Contracts only — types are erased at build time, so importing the root does
 * not pull a single vendor SDK. Import `paykit/universal` for the registry
 * (which necessarily loads every adapter) or a gateway subpath for one.
 */
export type * from './universal/types'
