import { defineConfig } from 'tsup'

/**
 * Every gateway is its own entry so a consumer bundling the subpath
 * (`paykit/midtrans`) never pulls another gateway's vendor SDK. `splitting`
 * is off for the same reason: shared chunks would reintroduce the coupling
 * the entry split exists to avoid.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'universal/index': 'src/universal/index.ts',
    'tripay/index': 'src/tripay/index.ts',
    'duitku/index': 'src/duitku/index.ts',
    'mayar/index': 'src/mayar/index.ts',
    'midtrans/index': 'src/midtrans/index.ts',
    'xendit/index': 'src/xendit/index.ts',
    'paypal/index': 'src/paypal/index.ts',
    'providers/registry': 'src/providers/registry.ts',
    'http/index': 'src/http/index.ts',
  },
  format: ['esm', 'cjs'],
  target: 'node18',
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Vendor SDKs stay external: they are optional peers the consumer installs.
  external: [
    '@paypal/paypal-server-sdk',
    'duitku-node-sdk',
    'mayar-node-sdk',
    'midtrans-client',
    'tripay-node-sdk',
    'xendit-node',
  ],
})
