/**
 * Provider registry — the single source of truth for every integration
 * PayKit supports.
 *
 * Each entry declares the provider's category, the credential fields its API
 * expects, and links to its signup and documentation pages. The admin UI reads
 * this registry to render the integration cards, the T&C dialog and the
 * credential form, so nothing is hardcoded in the app layer.
 */

import type { ProviderDefinition } from '../types'

/* -------------------------------------------------------------------------- */
/* Payment providers                                                          */
/* -------------------------------------------------------------------------- */

const tripay: ProviderDefinition = {
  id: 'tripay',
  category: 'payment',
  name: 'Tripay',
  description: 'One gateway for virtual accounts, e-wallets and retail outlets.',
  logo: '/logos/tripay.png',
  credentialFields: [
    { key: 'merchantCode', label: 'Merchant Code', required: true, placeholder: 'T1234' },
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
    { key: 'privateKey', label: 'Private Key', type: 'password', required: true },
    {
      key: 'environment',
      label: 'Environment',
      type: 'select',
      options: [
        { value: 'sandbox', label: 'Sandbox' },
        { value: 'production', label: 'Production' },
      ],
      hint: 'Must match the Tripay account these keys belong to. Defaults to sandbox.',
    },
    {
      key: 'callbackUrl',
      label: 'Callback URL',
      hint: 'Paste this into your Tripay dashboard.',
      guide: [
        'Open your merchant in the Tripay dashboard and edit its settings.',
        'Paste the URL into the Callback URL field, then save.',
      ],
      placeholder: 'https://pay.example.com/store/{slug}/tripay',
    },
  ],
  signupUrl: 'https://tripay.co.id/daftar',
  docsUrl: 'https://tripay.co.id/developer',
}

const duitku: ProviderDefinition = {
  id: 'duitku',
  category: 'payment',
  name: 'Duitku',
  description: 'Indonesian payment gateway covering banks, e-wallets and QRIS.',
  logo: '/logos/duitku.svg',
  credentialFields: [
    { key: 'merchantCode', label: 'Merchant Code', required: true },
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
    {
      key: 'environment',
      label: 'Environment',
      type: 'select',
      options: [
        { value: 'sandbox', label: 'Sandbox' },
        { value: 'production', label: 'Production' },
      ],
      hint: 'Must match the Duitku project these keys belong to. Defaults to sandbox.',
    },
    {
      key: 'callbackUrl',
      label: 'Callback URL',
      hint: 'Paste this into your Duitku dashboard.',
      placeholder: 'https://pay.example.com/store/{slug}/duitku',
    },
  ],
  signupUrl: 'https://www.duitku.com/daftar',
  docsUrl: 'https://docs.duitku.com',
}

const mayar: ProviderDefinition = {
  id: 'mayar',
  category: 'payment',
  name: 'Mayar',
  description: 'Payment links and checkout with automatic invoicing.',
  logo: '/logos/mayar.png',
  credentialFields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      hint: 'Create a Read & Write key at web.mayar.id/api-keys.',
    },
    {
      key: 'webhookSecret',
      label: 'Webhook Callback Token',
      type: 'password',
      required: true,
      hint: 'From your Mayar dashboard → Integration → Webhook.',
    },
    {
      key: 'environment',
      label: 'Environment',
      type: 'select',
      options: [
        { value: 'production', label: 'Production (web.mayar.id)' },
        { value: 'sandbox', label: 'Sandbox (web.mayar.io)' },
      ],
      hint: 'Must match the Mayar account these keys belong to. Defaults to production.',
    },
    {
      key: 'callbackUrl',
      label: 'Callback URL',
      hint: 'Registered with Mayar automatically when you save these credentials.',
      placeholder: 'https://pay.example.com/store/{slug}/mayar',
    },
  ],
  signupUrl: 'https://web.mayar.id',
  docsUrl: 'https://docs.mayar.id/api-reference-v2/introduction',
}

const midtrans: ProviderDefinition = {
  id: 'midtrans',
  category: 'payment',
  name: 'Midtrans',
  description: 'Snap checkout covering virtual accounts, QRIS, e-wallets and cards.',
  logo: '/logos/midtrans.svg',
  credentialFields: [
    {
      key: 'serverKey',
      label: 'Server Key',
      type: 'password',
      required: true,
      hint: 'From your Midtrans dashboard → Settings → Access Keys.',
    },
    {
      key: 'clientKey',
      label: 'Client Key',
      hint: 'The public key from the same Access Keys page. Needed only to embed the Snap popup.',
    },
    {
      key: 'merchantId',
      label: 'Merchant ID',
      hint: 'Optional. From Settings → Access Keys — it starts with G, M or A.',
      guide: [
        'When set, PayKit rejects a notification whose Merchant ID does not match.',
        'It authenticates nothing on its own — the Server Key does.',
        'Midtrans support asks for it when investigating a case.',
      ],
    },
    {
      key: 'environment',
      label: 'Environment',
      type: 'select',
      options: [
        { value: 'sandbox', label: 'Sandbox' },
        { value: 'production', label: 'Production' },
      ],
      hint: 'Must match the Midtrans account these keys belong to. Defaults to sandbox.',
    },
    {
      key: 'callbackUrl',
      label: 'Notification URL',
      hint: 'Sent with every Snap transaction automatically — nothing to paste.',
      guide: [
        'PayKit attaches it to each transaction as the X-Override-Notification header.',
        'Optional: paste it into Settings → Configuration → Payment Notification URL as a fallback for transactions created outside PayKit.',
      ],
      placeholder: 'https://pay.example.com/store/{slug}/midtrans',
    },
  ],
  signupUrl: 'https://midtrans.com',
  docsUrl: 'https://docs.midtrans.com',
}

const xendit: ProviderDefinition = {
  id: 'xendit',
  category: 'payment',
  name: 'Xendit',
  description:
    'Payment sessions covering virtual accounts, retail outlets, e-wallets, QRIS and cards.',
  logo: '/logos/xendit.svg',
  credentialFields: [
    {
      key: 'secretKey',
      label: 'Secret Key',
      type: 'password',
      required: true,
      hint: 'xnd_development_… to test, xnd_production_… to go live.',
      guide: [
        'Open Settings → Developers → API Keys and click Generate secret key.',
        'Under Money-in products, choose Write (it includes Read).',
        'Leave Money-out and Balance as None.',
        'Test connection uses this same Money-in permission.',
      ],
    },
    {
      key: 'webhookToken',
      label: 'Callback Token',
      type: 'password',
      required: true,
      hint: 'Xendit sends it as the x-callback-token header on every callback.',
      guide: [
        'Open Settings → Developers → Webhooks.',
        'Click View Webhook Verification Token and enter your password.',
      ],
    },
    {
      key: 'callbackUrl',
      label: 'Callback URL',
      hint: 'Paste this into Settings → Developers → Webhooks.',
      guide: [
        'Paste it into both Payment Session – Completed and Payment Session – Expired.',
        'Paste it into Payment Link too if you have charges made before the Payment Sessions migration.',
        'Click Test, then save.',
      ],
      placeholder: 'https://pay.example.com/store/{slug}/xendit',
    },
  ],
  signupUrl: 'https://www.xendit.co',
  docsUrl: 'https://docs.xendit.co',
}

const paypal: ProviderDefinition = {
  id: 'paypal',
  category: 'payment',
  name: 'PayPal',
  description: 'Global wallet, Pay Later and card payments for cross-border buyers.',
  credentialFields: [
    {
      key: 'clientId',
      label: 'Client ID',
      required: true,
      hint: 'From developer.paypal.com → your REST app.',
    },
    { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true },
    {
      key: 'environment',
      label: 'Environment',
      type: 'select',
      options: [
        { value: 'sandbox', label: 'Sandbox' },
        { value: 'live', label: 'Live' },
      ],
      hint: 'Must match the PayPal REST app these keys belong to. Defaults to sandbox.',
    },
    {
      key: 'currency',
      label: 'Charge currency',
      type: 'select',
      options: [
        { value: 'USD', label: 'USD — US Dollar' },
        { value: 'SGD', label: 'SGD — Singapore Dollar' },
        { value: 'EUR', label: 'EUR — Euro' },
        { value: 'AUD', label: 'AUD — Australian Dollar' },
        { value: 'GBP', label: 'GBP — British Pound' },
        { value: 'JPY', label: 'JPY — Japanese Yen' },
      ],
      hint: 'Must equal the shop currency — amounts are never converted.',
      guide: [
        'Only currencies PayPal supports are offered.',
        'IDR is not one of them: a shop charging in rupiah cannot settle through PayPal.',
      ],
    },
    {
      key: 'webhookId',
      label: 'Webhook ID',
      hint: 'From your REST app → Webhooks. Required to verify payment callbacks.',
      placeholder: 'e.g. 1AB23456C7890123D',
    },
    {
      key: 'callbackUrl',
      label: 'Callback URL',
      hint: 'Paste this into your PayPal REST app webhooks.',
      placeholder: 'https://pay.example.com/store/{slug}/paypal',
    },
  ],
  signupUrl: 'https://developer.paypal.com/',
  docsUrl: 'https://developer.paypal.com/docs/api/orders/v2/',
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/** Every provider the platform supports, keyed by id. */
export const PROVIDER_REGISTRY: Record<string, ProviderDefinition> = {
  tripay,
  duitku,
  mayar,
  paypal,
  midtrans,
  xendit,
}

/** Providers grouped by category, for the integrations list page. */
export const PROVIDERS_BY_CATEGORY: Record<string, ProviderDefinition[]> = {
  payment: [mayar, tripay, duitku, paypal, midtrans, xendit],
}

/** Look up a single provider definition. Returns `undefined` for unknown ids. */
export function getProvider(id: string): ProviderDefinition | undefined {
  return PROVIDER_REGISTRY[id]
}

/** All known provider ids. */
export function allProviderIds(): string[] {
  return Object.keys(PROVIDER_REGISTRY)
}
