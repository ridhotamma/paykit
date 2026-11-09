import { describe, expect, test } from 'vitest'

import { dokuAdapter } from './doku'

const credentials = {
  clientId: 'MCH-0001-test',
  secretKey: 'SK-test',
  environment: 'sandbox',
}

const params = {
  order: {
    tenantId: 'tenant_1',
    orderNumber: 'INV-20261109-001',
    grandTotal: 125_000,
    amountPaid: 0,
    customerName: 'Budi Santoso',
    customerEmail: 'budi@example.com',
    customerPhone: '6281234567890',
  },
  lines: [{ description: 'Kopi Susu', quantity: 2, unitPrice: 62_500 }],
  channel: 'VIRTUAL_ACCOUNT_BCA',
  currency: 'IDR',
  returnUrl: 'https://shop.test/orders/INV-20261109-001',
  callbackUrl: 'https://api.shop.test/store/test/doku',
}

describe('dokuAdapter.charge', () => {
  test('returns the hosted page, expiry and the DOKU overlay descriptor', async () => {
    const originalFetch = globalThis.fetch
    let requestBody = ''

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? '')
      return new Response(
        JSON.stringify({
          message: ['SUCCESS'],
          response: {
            order: {
              amount: '125000',
              invoice_number: 'INV-20261109-001',
              currency: 'IDR',
            },
            payment: {
              url: 'https://sandbox.doku.com/checkout-link-v2/abc',
              token_id: 'token-1',
              expired_date: '20261109104711',
              payment_method_types: ['VIRTUAL_ACCOUNT_BCA'],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    try {
      const charge = await dokuAdapter.charge(credentials, {}, params)

      expect(JSON.parse(requestBody)).toMatchObject({
        order: {
          amount: 125_000,
          invoice_number: 'INV-20261109-001',
          callback_url: 'https://shop.test/orders/INV-20261109-001',
        },
        payment: {
          payment_method_types: ['VIRTUAL_ACCOUNT_BCA'],
        },
        additional_info: {
          override_notification_url: 'https://api.shop.test/store/test/doku',
        },
      })
      expect(charge.paymentLink).toBe('https://sandbox.doku.com/checkout-link-v2/abc')
      expect(charge.paymentReference).toBe('INV-20261109-001')
      expect(charge.paymentMethodLabel).toBe('BCA Virtual Account')
      expect(charge.expiresAt).toBe(Math.floor(Date.UTC(2026, 10, 9, 3, 47, 11) / 1000))
      expect(charge.embedded).toEqual({
        provider: 'doku',
        preferred: 'script',
        iframeUrl: 'https://sandbox.doku.com/checkout-link-v2/abc',
        script: {
          sdk: 'doku-checkout',
          source: 'https://sandbox.doku.com/jokul-checkout-js/v1/jokul-checkout-1.0.0.js',
          token: 'https://sandbox.doku.com/checkout-link-v2/abc',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
