import { describe, expect, test } from 'vitest'

import { aulaaAdapter } from './aulaa'

const credentials = { apiKey: 'pgw_id_test', webhookSecret: 'whsec_test' }

const params = {
  order: {
    tenantId: 'tenant_1',
    orderNumber: 'INV-20261109-001',
    grandTotal: 125_000,
    amountPaid: 0,
    customerName: 'Budi Santoso',
    customerEmail: 'budi@example.com',
  },
  lines: [],
  channel: 'QRIS',
  returnUrl: 'https://shop.test/orders/INV-20261109-001',
}

describe('aulaaAdapter.charge', () => {
  test('a duplicate order id resolves to the payment it created earlier', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)

      if (url === 'https://api.aulaa.co/v1/payments' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            error: 'Pesanan dengan order_id INV-20261109-001 sudah pernah dibuat',
            payment_id: 'pay-existing',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }

      if (url === 'https://api.aulaa.co/v1/payments/pay-existing') {
        return new Response(
          JSON.stringify({
            id: 'pay-existing',
            order_id: 'INV-20261109-001',
            status: 'pending',
            amount: 125_000,
            fee_amount: 875,
            charged_amount: 125_000,
            currency: 'IDR',
            country_code: 'ID',
            payment_method: 'qris',
            payment_link: 'https://payment.aulaa.co/pay/pay-existing',
            redirect_url: 'https://shop.test/orders/INV-20261109-001',
            is_test: true,
            expired_at: '2026-11-09T08:00:00Z',
            paid_at: null,
            created_at: '2026-11-09T07:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
    }) as unknown as typeof fetch

    try {
      const charge = await aulaaAdapter.charge(credentials, {}, params)

      expect(calls).toEqual([
        'POST https://api.aulaa.co/v1/payments',
        'GET https://api.aulaa.co/v1/payments/pay-existing',
      ])
      expect(charge.paymentReference).toBe('pay-existing')
      expect(charge.paymentLink).toBe('https://payment.aulaa.co/pay/pay-existing')
      expect(charge.paymentMethodLabel).toBe('QRIS')
      expect(charge.expiresAt).toBe(Math.floor(Date.parse('2026-11-09T08:00:00Z') / 1000))
      expect(charge.embedded).toEqual({
        provider: 'aulaa',
        preferred: 'script',
        iframeUrl: 'https://payment.aulaa.co/pay/pay-existing',
        script: {
          sdk: 'aulaa-checkout',
          source: 'https://payment.aulaa.co/embed.js',
          token: 'https://payment.aulaa.co/pay/pay-existing',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
