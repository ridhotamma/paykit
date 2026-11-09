# PayKit

Provider-agnostic payment gateway adapters for Node.js — **Tripay, Duitku, Mayar, Midtrans, Xendit and PayPal** — with typed credential handling, charge building, status reconciliation and first-class **webhook verification**.

One small interface for every gateway, plus per-gateway subpaths when you need the raw provider details.

```bash
npm install @ridhotamma/paykit
```

Requires Node.js 20+ (Web Crypto is assumed to be global). Ships ESM and CJS with full TypeScript declarations.

---

## Why

Every Indonesian payment gateway speaks a slightly different dialect: different channel codes, different amount formats, different callback authentication, different expiry units. PayKit normalises the parts that are the same and keeps the parts that differ honest.

- **One contract.** `UniversalPaymentAdapter` — `getChannels`, `charge`, `refresh`, `testConnection` — for all six gateways.
- **Verified callbacks.** Signature/HMAC/token verification that returns a *decision*, not a database write.
- **No hidden state.** Nothing talks to a database, an ORM or a framework. Pure functions over `fetch` and the provider SDK.
- **Escape hatches.** Every gateway subpath re-exports its SDK types and helpers, so you are never boxed in by the abstraction.

## Supported gateways

| Gateway  | Channels | Charge | Status refresh | Webhook verification | Embedded checkout |
| -------- | :------: | :----: | :------------: | :------------------: | :---------------: |
| Tripay   |    ✅    |   ✅   |       ✅       |    HMAC-SHA256       | iframe            |
| Duitku   |    ✅    |   ✅   |       ✅       |    MD5 signature     | Pop JS            |
| Mayar    |    ✅    |   ✅   |       ✅       |    Callback token    | iframe            |
| Midtrans |    ✅    |   ✅   |       ✅       |    SHA-512 digest    | Snap JS           |
| Xendit   |    ✅    |   ✅   |       ✅       |    Callback token    | Components / iframe |
| PayPal   |    ✅    |   ✅   |       ✅       |    Webhook signature | JS SDK            |

## Quick start

### The universal adapter

```ts
import { getPaymentAdapter } from '@ridhotamma/paykit/universal'

const adapter = getPaymentAdapter('midtrans')
if (!adapter) throw new Error('Unknown gateway')

// 1. List the channels this shop can offer (no credentials needed).
const channels = await adapter.getChannels(credentials, config)
// [{ code: 'BCA_VA', label: 'BCA Virtual Account', category: 'virtual_account' }, …]

// 2. Create a charge.
const charge = await adapter.charge(credentials, config, {
  order: {
    tenantId: 'shop_123',
    orderNumber: 'INV-2026-0001',
    grandTotal: 150_000,
    amountPaid: 0,
    customerName: 'Budi',
    customerEmail: 'budi@example.com',
  },
  lines: [{ description: 'Kopi Arabica 250g', quantity: 2, unitPrice: 75_000 }],
  channel: 'BCA_VA',
  callbackUrl: 'https://api.example.com/webhooks/midtrans',
  returnUrl: 'https://example.com/orders/INV-2026-0001',
  currency: 'IDR',
})

console.log(charge.paymentLink) // hosted checkout page (null when embedded-only)
console.log(charge.vaNumber)    // …or the number to render yourself
```

Amounts are **integers in the currency's minor unit** — `150_000` is Rp 150.000, `1250` is $12.50. No floats, ever.

### A single gateway

If you know which gateway you need, import only its subpath — you get the same abstraction plus the provider-specific helpers:

```ts
import {
  buildMidtransSnapBody,
  readMidtransCredentials,
  verifyMidtransNotification,
} from '@ridhotamma/paykit/midtrans'
```

```ts
import { readTripayCredentials, createTripayClient } from '@ridhotamma/paykit/tripay'
import { readXenditCredentials, createXenditClient } from '@ridhotamma/paykit/xendit'
import { readMayarCredentials, createMayarClient } from '@ridhotamma/paykit/mayar'
import { readDuitkuCredentials, createDuitkuClient } from '@ridhotamma/paykit/duitku'
import { readPaypalCredentials, createPaypalClients } from '@ridhotamma/paykit/paypal'
import { readMidtransCredentials, createMidtransSnapClient } from '@ridhotamma/paykit/midtrans'
```

## Embedded checkout

Every charge also returns an `embedded` descriptor when the gateway has an in-page UI. It is plain, serialisable data — PayKit does not render anything or load a browser SDK itself — so a storefront can send it to the browser and decide whether to frame the hosted page or drive the provider's SDK:

```ts
const charge = await adapter.charge(credentials, config, {
  // …the usual order, lines, channel and URLs
  // Ask for the provider's native embedded flow where one exists.
  checkout: 'embedded',
  // Xendit Components only: the origins allowed to mount the session.
  embedOrigins: ['https://shop.example.com'],
})

charge.paymentLink // still the hosted page — null for Xendit Components
charge.embedded
// {
//   provider: 'duitku',
//   preferred: 'script',
//   iframeUrl: 'https://app-sandbox.duitku.com/redirect_checkout?reference=…',
//   script: {
//     sdk: 'duitku-pop',
//     source: 'https://app-sandbox.duitku.com/lib/js/duitku.js',
//     token: '…duitku reference…'
//   }
// }
```

Two presentations exist:

| `preferred` | Frontend behaviour |
| ----------- | ------------------ |
| `iframe` | Render `embedded.iframeUrl` in an `<iframe>`. |
| `script` | Load `embedded.script.source` and drive that SDK with `embedded.script.token` (plus `clientKey` when present). |

Provider specifics:

| Gateway | `checkout: 'embedded'` | Frontend |
| ------- | ---------------------- | -------- |
| Duitku | No API change; still returns the hosted `paymentUrl` as fallback. | Load `duitku.js`, call `checkout.process(reference, options)`. |
| Xendit | Creates a `COMPONENTS` Payment Session and returns `components_sdk_key`. Requires `embedOrigins`. | Use `xendit-components-web`; mount the channel components into your own containers and submit from your button. |
| Midtrans | No API change; the Snap token is returned. | Load `snap.js` with `data-client-key`, then `snap.embed(token, { embedId })` or `snap.pay(token)`. |
| Tripay | No API change. | Iframe the `checkout_url`; keep the redirect as fallback. |
| Mayar | No API change. | Iframe the invoice/payment link; keep the redirect as fallback. |
| PayPal | No API change. | Load the PayPal JS SDK (`components=buttons`) and render `paypal.Buttons` around the returned order id. |

`paymentLink` remains the safe fallback everywhere except Xendit's `COMPONENTS` mode, which has no hosted page (it is `null` there). Some payment methods — bank pages, 3DS, wallet app-switches — can still demand a top-level window even when the hosted page loads in a frame, so treat the descriptor as a hint, not a guarantee.

Embedded callbacks are UI feedback only. Settlement always comes from the HTTP webhook, exactly as it does for a redirect flow.

The static capability is also on the adapter:

```ts
adapter.capabilities.supportsEmbeddedCheckout // true
```

## Webhooks

PayKit owns the **verification and interpretation** of a callback. It deliberately does **not** own the HTTP endpoint, the database write or the order state machine's side effects — those are yours.

```
provider ──POST──▶ your endpoint
                     │
                     ├─ 1. verify signature/token   ← paykit
                     ├─ 2. parse & normalise event  ← paykit
                     ├─ 3. read status back from API ← paykit (optional but recommended)
                     └─ 4. mutate your data         ← you
```

### 1. Verify

Each gateway exposes a verifier that throws a `WebhookAuthError` (status `401`) on an unauthenticated sender, so a misconfiguration surfaces in the provider's dashboard instead of being silently accepted.

```ts
import { verifyMidtransNotification } from '@ridhotamma/paykit/midtrans'
import { WebhookAuthError } from '@ridhotamma/paykit'

try {
  const notification = await verifyMidtransNotification(
    await request.json(),
    credentials.serverKey,
    credentials.merchantId, // optional second check
  )
  // notification.order_id, .transaction_status, .gross_amount …
} catch (error) {
  if (error instanceof WebhookAuthError) return new Response('Unauthorized', { status: 401 })
  throw error
}
```

Equivalent entry points per gateway:

| Gateway  | Verifier |
| -------- | -------- |
| Tripay   | `tripay-node-sdk` callback parsing (throws `TripaySignatureError`) |
| Duitku   | `parseDuitkuCallbackBody` + `duitkuCallbackSchema` |
| Mayar    | `verifyMayarCallback` |
| Midtrans | `verifyMidtransNotification` |
| Xendit   | `verifyXenditCallback` |
| PayPal   | `verifyPaypalCallback` (needs your webhook id) |

### 2. Interpret

Verification answers *"is this real?"*. The payment planners answer *"what should change?"* — as a value you can inspect, log and replay, never as a write:

```ts
import { planMidtransPaymentUpdate } from '@ridhotamma/paykit/midtrans'

// `transaction` is the status API's answer, not the callback's claims.
const plan = planMidtransPaymentUpdate(order, transaction)
if (plan.action === 'apply') {
  order.status = plan.orderStatus ?? order.status
  order.paymentStatus = plan.paymentStatus
  order.amountPaid = plan.amountPaid
  order.paymentReference = plan.paymentReference
  order.paidAt = plan.paidAt
} else {
  // plan.reason: 'already_recorded' | 'order_not_payable' | 'already_settled' | …
}
```

Planners are conservative by design: a callback that cannot be applied is a no-op with a reason. They never credit more than the order's remaining balance, and they never invent a state the lifecycle does not allow.

### 3. Then do what your app needs

PayKit gives you no `settleOrder()` because settling an order is app-specific (inventory, notifications, subscriptions, ledgers). Write it once in your app, call it from every gateway handler.

## Credentials

Providers differ on which fields are secret, which environment names they use, and what a missing key means. PayKit standardises the read:

```ts
import { readMidtransCredentials } from '@ridhotamma/paykit/midtrans'

const result = readMidtransCredentials(storedCredentials, storedConfig)
if (!result.ok) throw new Error(result.error)   // e.g. "Server Key is required."
const { serverKey, merchantId, environment } = result.credentials
```

`@ridhotamma/paykit` also ships the provider metadata registry that powers a credential form:

```ts
import { PROVIDER_REGISTRY, getProvider } from '@ridhotamma/paykit/providers'

getProvider('paypal')?.credentialFields
// [{ key: 'clientId', label: 'Client ID', required: true }, …]
```

### Encrypting credentials at rest

`@ridhotamma/paykit` includes an optional AES-256-GCM envelope for the credentials blob, so a leaked database dump is not a leaked set of gateway keys. The key is read from `INTEGRATION_CREDENTIALS_KEY` (64 hex characters — 32 bytes):

```bash
export INTEGRATION_CREDENTIALS_KEY=$(openssl rand -hex 32)
```

```ts
import { sealCredentials, openCredentials } from '@ridhotamma/paykit'

const sealed = await sealCredentials({ apiKey: '…' })   // → '{"v":1,"iv":"…","data":"…"}'
const plain = await openCredentials(sealed)             // → { apiKey: '…' }
```

It accepts legacy plaintext JSON too, so old rows keep working and seal on their next save.

## Amounts and currency

```ts
import { minorUnitDigits, paymentStatusFor, canTransitionOrder } from '@ridhotamma/paykit'

minorUnitDigits('IDR')            // 0
minorUnitDigits('USD')            // 2
paymentStatusFor(500, 1000)       // 'partial'
canTransitionOrder('pending', 'paid') // true
```

Gateways that only settle in one currency (Midtrans, Xendit → IDR) or bind a currency at connection time (PayPal) expose `currencyUnsupportedReason()` on the adapter, so a storefront can hide an option it could never settle instead of failing after checkout.

## Channel logos

Gateway responses carry logos, but fetching them needs live credentials. PayKit resolves a channel code to a stable slug instead:

```ts
import { digitalChannelLogoPath } from '@ridhotamma/paykit'

digitalChannelLogoPath('tripay', 'BCAVA')                    // '/payment-logos/bca.svg'
digitalChannelLogoPath('tripay', 'BCAVA', '/assets/logos')   // '/assets/logos/bca.svg'
```

Host the marks wherever you like; `null` means no vendored mark exists.

## Package layout

| Import | Contains |
| ------ | -------- |
| `@ridhotamma/paykit` | Contracts, provider registry, credentials, envelopes, order/money primitives. **No vendor SDK.** |
| `@ridhotamma/paykit/universal` | `UniversalPaymentAdapter` registry + all six adapters |
| `@ridhotamma/paykit/tripay` … `@ridhotamma/paykit/paypal` | One gateway: SDK client, charge builder, webhook verifier, planner |
| `@ridhotamma/paykit/providers` | Static provider metadata (credential fields, docs links) |
| `@ridhotamma/paykit/http` | SSRF-hardened `safeFetch` used by adapters |

## Security notes

- Callbacks are verified with constant-time comparison; secrets never appear in error messages.
- `@ridhotamma/paykit/http` resolves DNS and refuses private/loopback addresses, so a user-supplied callback URL cannot be used to reach your internal network.
- Never trust the amounts in a callback. PayKit's planners are built around reading the transaction back from the provider's API before moving money.
- Credential envelopes fail closed: a sealed blob handed `{}` or the wrong key throws rather than degrading to an empty credential set.

## Contributing

Issues and pull requests are welcome. Please run the full check before opening a PR:

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT © Ridho Tamma
