# PayKit

Provider-agnostic payment gateway adapters for Node.js — **Tripay, Duitku, Mayar, Midtrans, Xendit and PayPal** — with typed credential handling, charge building, status reconciliation and first-class **webhook verification**.

One small interface for every gateway, plus per-gateway subpaths when you need the raw provider details.

```bash
npm install paykit
```

Requires Node.js 18+. Ships ESM and CJS with full TypeScript declarations.

---

## Why

Every Indonesian payment gateway speaks a slightly different dialect: different channel codes, different amount formats, different callback authentication, different expiry units. PayKit normalises the parts that are the same and keeps the parts that differ honest.

- **One contract.** `UniversalPaymentAdapter` — `getChannels`, `charge`, `refresh`, `testConnection` — for all six gateways.
- **Verified callbacks.** Signature/HMAC/token verification that returns a *decision*, not a database write.
- **No hidden state.** Nothing talks to a database, an ORM or a framework. Pure functions over `fetch` and the provider SDK.
- **Escape hatches.** Every gateway subpath re-exports its SDK types and helpers, so you are never boxed in by the abstraction.

## Supported gateways

| Gateway  | Channels | Charge | Status refresh | Webhook verification |
| -------- | :------: | :----: | :------------: | :------------------: |
| Tripay   |    ✅    |   ✅   |       ✅       |    HMAC-SHA256       |
| Duitku   |    ✅    |   ✅   |       ✅       |    MD5 signature     |
| Mayar    |    ✅    |   ✅   |       ✅       |    Callback token    |
| Midtrans |    ✅    |   ✅   |       ✅       |    SHA-512 digest    |
| Xendit   |    ✅    |   ✅   |       ✅       |    Callback token    |
| PayPal   |    ✅    |   ✅   |       ✅       |    Webhook signature |

## Quick start

### The universal adapter

```ts
import { getPaymentAdapter } from 'paykit/universal'

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

console.log(charge.paymentLink) // hosted checkout page
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
} from 'paykit/midtrans'
```

```ts
import { readTripayCredentials, createTripayClient } from 'paykit/tripay'
import { readXenditCredentials, createXenditClient } from 'paykit/xendit'
import { readMayarCredentials, createMayarClient } from 'paykit/mayar'
import { readDuitkuCredentials, createDuitkuClient } from 'paykit/duitku'
import { readPaypalCredentials, createPaypalClients } from 'paykit/paypal'
import { readMidtransCredentials, createMidtransSnapClient } from 'paykit/midtrans'
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
import { verifyMidtransNotification } from 'paykit/midtrans'
import { WebhookAuthError } from 'paykit'

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
import { planMidtransPaymentUpdate } from 'paykit/midtrans'

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
import { readMidtransCredentials } from 'paykit/midtrans'

const result = readMidtransCredentials(storedCredentials, storedConfig)
if (!result.ok) throw new Error(result.error)   // e.g. "Server Key is required."
const { serverKey, merchantId, environment } = result.credentials
```

`paykit` also ships the provider metadata registry that powers a credential form:

```ts
import { PROVIDER_REGISTRY, getProvider } from 'paykit/providers'

getProvider('paypal')?.credentialFields
// [{ key: 'clientId', label: 'Client ID', required: true }, …]
```

### Encrypting credentials at rest

`paykit` includes an optional AES-256-GCM envelope for the credentials blob, so a leaked database dump is not a leaked set of gateway keys. The key is read from `INTEGRATION_CREDENTIALS_KEY` (64 hex characters — 32 bytes):

```bash
export INTEGRATION_CREDENTIALS_KEY=$(openssl rand -hex 32)
```

```ts
import { sealCredentials, openCredentials } from 'paykit'

const sealed = await sealCredentials({ apiKey: '…' })   // → '{"v":1,"iv":"…","data":"…"}'
const plain = await openCredentials(sealed)             // → { apiKey: '…' }
```

It accepts legacy plaintext JSON too, so old rows keep working and seal on their next save.

## Amounts and currency

```ts
import { minorUnitDigits, paymentStatusFor, canTransitionOrder } from 'paykit'

minorUnitDigits('IDR')            // 0
minorUnitDigits('USD')            // 2
paymentStatusFor(500, 1000)       // 'partial'
canTransitionOrder('pending', 'paid') // true
```

Gateways that only settle in one currency (Midtrans, Xendit → IDR) or bind a currency at connection time (PayPal) expose `currencyUnsupportedReason()` on the adapter, so a storefront can hide an option it could never settle instead of failing after checkout.

## Channel logos

Gateway responses carry logos, but fetching them needs live credentials. PayKit resolves a channel code to a stable slug instead:

```ts
import { digitalChannelLogoPath } from 'paykit'

digitalChannelLogoPath('tripay', 'BCAVA')                    // '/payment-logos/bca.svg'
digitalChannelLogoPath('tripay', 'BCAVA', '/assets/logos')   // '/assets/logos/bca.svg'
```

Host the marks wherever you like; `null` means no vendored mark exists.

## Package layout

| Import | Contains |
| ------ | -------- |
| `paykit` | Contracts, provider registry, credentials, envelopes, order/money primitives. **No vendor SDK.** |
| `paykit/universal` | `UniversalPaymentAdapter` registry + all six adapters |
| `paykit/tripay` … `paykit/paypal` | One gateway: SDK client, charge builder, webhook verifier, planner |
| `paykit/providers` | Static provider metadata (credential fields, docs links) |
| `paykit/http` | SSRF-hardened `safeFetch` used by adapters |

## Security notes

- Callbacks are verified with constant-time comparison; secrets never appear in error messages.
- `paykit/http` resolves DNS and refuses private/loopback addresses, so a user-supplied callback URL cannot be used to reach your internal network.
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
