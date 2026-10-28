# Contributing

Thanks for taking a look. A few ground rules keep this package useful.

## Setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

Requires Node.js 18+.

## Adding a gateway

1. Create `src/<gateway>/` with `client.ts`, `charge.ts`, `transactions.ts`, `webhook.ts`, `payment.ts` and an `index.ts` barrel — follow an existing gateway closely.
2. Export the barrel from `tsup.config.ts` and add the subpath to `exports` in `package.json`.
3. Add the adapter to `src/universal/registry.ts` and `src/universal/adapters/`.
4. Add the provider to `src/providers/registry.ts` (credential fields + docs links).
5. Add the vendor SDK to `dependencies` — never to the root barrel.

## Design constraints

- **No I/O beyond the gateway.** No database, no framework, no filesystem, no clock other than an injected `now`.
- **The root barrel imports no vendor SDK.** Types only; everything else lives behind a subpath.
- **Amounts are integers in the minor unit.** Never floats.
- **Callbacks are verified, then interpreted, never trusted.** Verification throws `WebhookAuthError`; planners return a value.
- **Fail closed.** A missing key, unknown channel or unverifiable signature must produce an error, never a silent default.
- **Web Crypto, not `node:crypto`.** Keeps modules bundleable outside Node.

## Tests

Vitest. Prefer table-driven tests for signature variants, amount edge cases and channel code mapping. No network in tests — stub the client, not the module.
