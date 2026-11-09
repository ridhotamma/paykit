import { createHmac } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  aulaaAmountProblem,
  AULAA_MAX_AMOUNT,
  AULAA_MIN_AMOUNT,
  aulaaRemainingAmountFor,
  buildAulaaPaymentBody,
} from './charge'
import {
  AulaaApiError,
  createAulaaPayment,
  readAulaaCredentials,
} from './client'
import {
  aulaaChannelKind,
  aulaaChannelLabel,
  isAulaaCheckoutChannel,
} from './index'
import { planAulaaPaymentUpdate } from './payment'
import {
  aulaaOrderIdFromWebhook,
  aulaaWebhookSignature,
  isAulaaPaidWebhook,
  parseAulaaWebhookPayload,
  verifyAulaaCallback,
} from './webhook'

const order = {
  tenantId: 'tenant_1',
  orderNumber: 'INV-20261109-001',
  grandTotal: 125_000,
  amountPaid: 0,
  customerName: 'Budi Santoso',
  customerEmail: 'budi@example.com',
  customerPhone: '081234567890',
}

describe('buildAulaaPaymentBody', () => {
  test('charges the remaining balance and pins the method in lowercase', () => {
    const body = buildAulaaPaymentBody({
      order: { ...order, amountPaid: 25_000 },
      channel: 'BCA_VA',
      returnUrl: 'https://shop.test/orders/INV-20261109-001',
    })

    expect(body).toEqual({
      order_id: 'INV-20261109-001',
      amount: 100_000,
      payment_method: 'bca_va',
      redirect_url: 'https://shop.test/orders/INV-20261109-001',
    })
  })

  test('omits the method when the buyer will choose on Aulaa', () => {
    const body = buildAulaaPaymentBody({ order })
    expect(body.payment_method).toBeUndefined()
    expect(body.redirect_url).toBeUndefined()
  })

  test('a re-charge appends an attempt token to the order id', () => {
    const first = buildAulaaPaymentBody({ order })
    const again = buildAulaaPaymentBody({ order, existingPaymentReference: 'pay-1' })

    expect(first.order_id).toBe('INV-20261109-001')
    expect(again.order_id.startsWith('INV-20261109-001~')).toBe(true)
  })
})

describe('amounts', () => {
  test('charges only what is still owed', () => {
    expect(aulaaRemainingAmountFor({ grandTotal: 100_000, amountPaid: 40_000 })).toBe(60_000)
    expect(aulaaRemainingAmountFor({ grandTotal: 100_000, amountPaid: 100_000 })).toBe(0)
  })

  test('matches Aulaa’s documented window', () => {
    expect(aulaaAmountProblem(AULAA_MIN_AMOUNT - 1)).toContain('at least')
    expect(aulaaAmountProblem(AULAA_MAX_AMOUNT + 1)).toContain('at most')
    expect(aulaaAmountProblem(AULAA_MIN_AMOUNT)).toBeNull()
    expect(aulaaAmountProblem(AULAA_MAX_AMOUNT)).toBeNull()
    expect(aulaaAmountProblem(0)).toContain('positive')
  })
})

describe('channels', () => {
  test('resolves labels and families from Aulaa codes', () => {
    expect(isAulaaCheckoutChannel('BCA_VA')).toBe(true)
    expect(isAulaaCheckoutChannel('nope')).toBe(false)
    expect(aulaaChannelLabel('bca_va')).toBe('BCA Virtual Account')
    expect(aulaaChannelLabel('shopee_pay')).toBe('ShopeePay')
    expect(aulaaChannelKind('qris')).toBe('qr_code')
    expect(aulaaChannelKind('alfamart')).toBe('retail')
    expect(aulaaChannelLabel('nope')).toBeNull()
  })
})

describe('credentials', () => {
  test('requires both the API key and the webhook secret', () => {
    expect(readAulaaCredentials([{ apiKey: 'pgw_id_x' }]).ok).toBe(false)
    const result = readAulaaCredentials([
      { apiKey: 'pgw_id_x', webhookSecret: 'whsec_x' },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.credentials.apiKey).toBe('pgw_id_x')
  })
})

describe('webhook', () => {
  const secret = 'whsec_test'
  const payload = {
    order_id: 'INV-20261109-001',
    amount: 125_000,
    currency: 'IDR',
    country_code: 'ID',
    status: 'paid',
    payment_method: 'qris',
    formatted_amount: 'Rp 125.000',
    paid_at: '2026-11-09T07:15:32Z',
  }
  const rawBody = JSON.stringify(payload)
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex')

  test('computes the same hex HMAC as Aulaa', async () => {
    await expect(aulaaWebhookSignature(rawBody, secret)).resolves.toBe(signature)
  })

  test('verifies the raw body and exposes the order id', async () => {
    const verified = await verifyAulaaCallback(rawBody, signature, secret)
    expect(isAulaaPaidWebhook(verified)).toBe(true)
    expect(aulaaOrderIdFromWebhook(verified)).toBe('INV-20261109-001')
  })

  test('rejects a tampered body, a missing signature and a missing secret', async () => {
    await expect(verifyAulaaCallback(rawBody.replace('125000', '1'), signature, secret)).rejects.toThrow(
      'signature mismatch',
    )
    await expect(verifyAulaaCallback(rawBody, '', secret)).rejects.toThrow('signature header')
    await expect(verifyAulaaCallback(rawBody, signature, '')).rejects.toThrow('secret is configured')
  })

  test('parses an already-decoded body and rejects an unrelated shape', () => {
    expect(parseAulaaWebhookPayload(payload)?.status).toBe('paid')
    expect(parseAulaaWebhookPayload({ status: 'paid' })).toBeNull()
  })
})

describe('payment planner', () => {
  const payable = {
    status: 'pending' as const,
    paymentStatus: 'unpaid' as const,
    amountPaid: 0,
    grandTotal: 125_000,
    paymentReference: 'pay-1',
    paidAt: null,
    paymentMethod: 'Aulaa',
  }

  test('settles a paid payment and stamps the reference and method', () => {
    const plan = planAulaaPaymentUpdate(payable, {
      id: 'pay-1',
      amount: 125_000,
      status: 'paid',
      payment_method: 'qris',
    })

    expect(plan).toMatchObject({
      action: 'apply',
      amountPaid: 125_000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      paymentReference: 'pay-1',
      paymentMethod: 'QRIS',
    })
  })

  test('credits the nominal amount, not the fee-inclusive charge', () => {
    const plan = planAulaaPaymentUpdate(
      { ...payable, grandTotal: 130_000 },
      { id: 'pay-2', amount: 125_000, status: 'paid', payment_method: 'qris' },
    )

    expect(plan).toMatchObject({ action: 'apply', amountPaid: 125_000, paymentStatus: 'partial' })
  })

  test('is idempotent once the ledger already covers the payment', () => {
    const plan = planAulaaPaymentUpdate(
      { ...payable, amountPaid: 125_000 },
      { id: 'pay-1', amount: 125_000, status: 'paid' },
    )
    expect(plan).toEqual({ action: 'noop', reason: 'already_recorded' })
  })

  test('ignores a payment that is not paid, and refuses a closed order', () => {
    expect(
      planAulaaPaymentUpdate(payable, { id: 'pay-1', amount: 125_000, status: 'expired' }),
    ).toEqual({ action: 'noop', reason: 'transaction_not_paid' })
    expect(
      planAulaaPaymentUpdate(
        { ...payable, status: 'cancelled' },
        { id: 'pay-1', amount: 125_000, status: 'paid' },
      ),
    ).toEqual({ action: 'noop', reason: 'order_not_payable' })
  })
})

describe('client', () => {
  test('a duplicate order id carries the existing payment id', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'Pesanan dengan order_id INV-1 sudah pernah dibuat',
          payment_id: 'pay-existing',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch

    try {
      await expect(
        createAulaaPayment(
          { apiKey: 'pgw_id_x', webhookSecret: 'whsec_x' },
          { order_id: 'INV-1', amount: 50_000 },
        ),
      ).rejects.toMatchObject({
        name: 'AulaaApiError',
        status: 409,
        paymentId: 'pay-existing',
      } satisfies Partial<AulaaApiError>)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
