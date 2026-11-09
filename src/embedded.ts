/**
 * Embedded-checkout descriptors — the data a storefront needs to present a
 * gateway's payment UI inside its own page instead of redirecting the buyer.
 *
 * PayKit is a server-side library: it does not render iframes, load scripts or
 * own a DOM. A charge therefore carries an {@link EmbeddedCheckout} *value*
 * describing what the frontend can do, and the storefront decides whether to
 * frame the hosted page, drive the provider's browser SDK, or ignore the
 * descriptor and open `paymentLink` as usual.
 *
 * Two presentations exist:
 *
 * - **iframe** — the provider's hosted checkout page is rendered in an
 *   `<iframe>`. This is the lowest-effort embed: no SDK, no extra client
 *   state. It works best for page builders and simple storefronts, but some
 *   payment methods (bank pages, 3DS, wallet app-switches) may still demand a
 *   top-level window, and a provider is free to add `X-Frame-Options` later.
 * - **script** — the provider's own browser SDK is loaded and driven with the
 *   `token` PayKit returns. This is the provider-supported in-page flow and
 *   handles redirect-heavy methods itself. It needs a tiny amount of
 *   provider-specific frontend code (see each `sdk` value below).
 *
 * The descriptor is deliberately provider-agnostic and serialisable: it can
 * travel as JSON from the charge endpoint to the browser without importing a
 * vendor SDK into the server bundle or the page.
 */

/** The browser SDKs a storefront may need to drive. */
export type EmbeddedCheckoutSdk =
  | 'duitku-pop'
  | 'midtrans-snap'
  | 'xendit-components'
  | 'paypal-js'

/**
 * How to drive one provider's browser SDK.
 *
 * `source` is a script URL for every SDK except `xendit-components`, which is
 * an npm package imported by the storefront's bundler. `token` is whatever the
 * SDK's entry call needs: Duitku's invoice reference, Midtrans' Snap token,
 * Xendit's `components_sdk_key`, or PayPal's order id.
 */
export interface EmbeddedCheckoutScript {
  sdk: EmbeddedCheckoutSdk
  /** Script URL to load, or the npm package to import for `xendit-components`. */
  source: string
  /** Reference, Snap token, components SDK key, or PayPal order id. */
  token: string
  /** Public client key some SDKs need at load time (Midtrans, PayPal). */
  clientKey?: string
}

/**
 * Everything the storefront needs for one charge.
 *
 * At least one of `iframeUrl` and `script` is present; most providers carry
 * both so a storefront can fall back from the SDK to the hosted page. The
 * `preferred` field is only a hint — a builder may choose the iframe anyway.
 */
export interface EmbeddedCheckout {
  /** The provider this descriptor belongs to (`duitku`, `xendit`, …). */
  provider: string
  /** Which presentation the provider supports best. */
  preferred: 'iframe' | 'script'
  /** The hosted checkout page, suitable for an iframe. */
  iframeUrl?: string
  /** The provider's browser SDK, when it has one. */
  script?: EmbeddedCheckoutScript
}

/* -------------------------------------------------------------------------- */
/* Descriptor builders                                                        */
/* -------------------------------------------------------------------------- */

/** A hosted checkout page rendered in an iframe, for providers without an SDK. */
export function iframeEmbeddedCheckout(provider: string, url: string): EmbeddedCheckout {
  return { provider, preferred: 'iframe', iframeUrl: url }
}

/** Duitku Pop's browser library URL for one Duitku deployment. */
export function duitkuJsUrl(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'https://app-prod.duitku.com/lib/js/duitku.js'
    : 'https://app-sandbox.duitku.com/lib/js/duitku.js'
}

/**
 * Duitku Pop — the provider's supported in-page checkout.
 *
 * The frontend loads {@link duitkuJsUrl} and calls
 * `checkout.process(reference, options)`; Duitku renders a full-screen
 * overlay containing its own iframe and reports success/pending/error through
 * the JS callbacks. The hosted `paymentUrl` stays available as a fallback.
 */
export function duitkuEmbeddedCheckout(
  reference: string,
  environment: 'sandbox' | 'production',
  paymentUrl?: string | null,
): EmbeddedCheckout {
  return {
    provider: 'duitku',
    preferred: 'script',
    ...(paymentUrl ? { iframeUrl: paymentUrl } : {}),
    script: {
      sdk: 'duitku-pop',
      source: duitkuJsUrl(environment),
      token: reference,
    },
  }
}

/** Midtrans Snap's browser library URL for one Midtrans deployment. */
export function midtransSnapUrl(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'https://app.midtrans.com/snap/snap.js'
    : 'https://app.sandbox.midtrans.com/snap/snap.js'
}

/**
 * Midtrans Snap — `snap.pay(token, …)` opens the popup, `snap.embed(token,
 * { embedId })` renders the same checkout inside a container. The script tag
 * needs `data-client-key`, which is why the public key rides along.
 *
 * The Snap token is short-lived and identifies the checkout session; the
 * webhook still names the transaction by `order_id`.
 */
export function midtransEmbeddedCheckout(
  token: string,
  clientKey: string,
  environment: 'sandbox' | 'production',
  redirectUrl?: string | null,
): EmbeddedCheckout {
  return {
    provider: 'midtrans',
    preferred: 'script',
    ...(redirectUrl ? { iframeUrl: redirectUrl } : {}),
    script: {
      sdk: 'midtrans-snap',
      source: midtransSnapUrl(environment),
      token,
      clientKey,
    },
  }
}

/**
 * Xendit Components — the provider's embedded checkout.
 *
 * The frontend installs the `xendit-components-web` package, initialises it
 * with the short-lived `components_sdk_key`, mounts the payment-method
 * components into containers the storefront owns, and submits from its own
 * button. There is no hosted page in this mode, hence no `iframeUrl`.
 */
export function xenditComponentsEmbeddedCheckout(componentsSdkKey: string): EmbeddedCheckout {
  return {
    provider: 'xendit',
    preferred: 'script',
    script: {
      sdk: 'xendit-components',
      source: 'xendit-components-web',
      token: componentsSdkKey,
    },
  }
}

/** Xendit's hosted payment page, framed verbatim. */
export function xenditIframeCheckout(paymentLinkUrl: string): EmbeddedCheckout {
  return iframeEmbeddedCheckout('xendit', paymentLinkUrl)
}

/** PayPal's JS SDK URL for one client id and currency. */
export function paypalSdkUrl(clientId: string, currency: string): string {
  const params = new URLSearchParams({
    'client-id': clientId,
    currency: currency.trim().toUpperCase(),
    intent: 'capture',
    components: 'buttons',
  })
  return `https://www.paypal.com/sdk/js?${params.toString()}`
}

/**
 * PayPal's JS SDK — the storefront renders `paypal.Buttons` with the order id
 * as `createOrder`, then approves on PayPal's own UI. The approval URL is not
 * frameable (`X-Frame-Options: SAMEORIGIN`), so the SDK is the only in-page
 * option.
 */
export function paypalEmbeddedCheckout(
  orderId: string,
  clientId: string,
  currency: string,
): EmbeddedCheckout {
  return {
    provider: 'paypal',
    preferred: 'script',
    script: {
      sdk: 'paypal-js',
      source: paypalSdkUrl(clientId, currency),
      token: orderId,
      clientKey: clientId,
    },
  }
}
