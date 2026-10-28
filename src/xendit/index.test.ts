import { describe, expect, test } from 'vitest'

import {
  buildXenditSessionBody,
  xenditChannelFitsAmount,
  xenditChannelLimitFor,
  xenditPaymentChannelsFor,
  xenditRemainingAmountFor,
} from './charge'
import {
  getXenditInvoice,
  readXenditCredentials,
  verifyXenditSecretKey,
  XenditApiError,
  xenditKeyEnvironment,
} from './client'
import { isXenditCheckoutChannel, xenditChannelLabel } from './index'
import { planXenditPaymentUpdate } from './payment'
import {
  isXenditCompletedSession,
  isXenditPaidInvoice,
  parseXenditInvoice,
  parseXenditSession,
  xenditInvoiceAmount,
  xenditOrderNumberFromInvoice,
  xenditOrderNumberFromSession,
  xenditSessionAmount,
  xenditSessionChannel,
} from './transactions'
import {
  isXenditPaidWebhook,
  parseXenditWebhook,
  verifyXenditCallback,
  XenditWebhookAuthError,
} from './webhook'

describe('xenditRemainingAmountFor', () => {
  test('charges only what is still owed', () => {
    expect(xenditRemainingAmountFor({ grandTotal: 100000, amountPaid: 40000 })).toBe(60000)
    expect(xenditRemainingAmountFor({ grandTotal: 100000, amountPaid: 100000 })).toBe(0)
    expect(xenditRemainingAmountFor({ grandTotal: 100000, amountPaid: 120000 })).toBe(0)
  })
})

describe('buildXenditSessionBody', () => {
  const order = {
    tenantId: 'tenant_1',
    orderNumber: 'INV-20260928-ABCDE',
    grandTotal: 125000,
    amountPaid: 0,
    customerName: 'Budi Santoso',
    customerEmail: 'budi@example.com',
    customerPhone: '081234567890',
  }
  const lines = [{ description: 'Kopi Susu', quantity: 2, unitPrice: 50000 }]

  test('mirrors clean lines and narrows the session to the picked channel', () => {
    const body = buildXenditSessionBody({
      order,
      channel: 'BCA',
      lines: [...lines, { description: 'Ongkir', quantity: 1, unitPrice: 25000 }],
      totals: {},
      returnUrl: 'https://shop.test/order/confirmation',
      expiresAt: '2026-09-28T11:00:00.000Z',
    })
    expect(body.reference_id).toBe('INV-20260928-ABCDE')
    expect(body.session_type).toBe('PAY')
    expect(body.mode).toBe('PAYMENT_LINK')
    expect(body.currency).toBe('IDR')
    expect(body.country).toBe('ID')
    expect(body.amount).toBe(125000)
    expect(body.allowed_payment_channels).toEqual(['BCA_VIRTUAL_ACCOUNT'])
    expect(body.items?.reduce((acc, item) => acc + item.net_unit_amount * item.quantity, 0)).toBe(
      125000,
    )
    expect(body.success_return_url).toBe('https://shop.test/order/confirmation')
    expect(body.cancel_return_url).toBe('https://shop.test/order/confirmation')
    expect(body.expires_at).toBe('2026-09-28T11:00:00.000Z')
    expect(body.metadata?.paykit_channel).toBe('BCA')
  })

  test('a discounted order collapses to a single line that still adds up', () => {
    const body = buildXenditSessionBody({
      order: { ...order, grandTotal: 115000 },
      channel: 'QRIS',
      lines,
      totals: { discountTotal: 10000, shippingTotal: 25000 },
    })
    expect(body.amount).toBe(115000)
    expect(body.items).toHaveLength(1)
    expect(body.items?.[0]?.net_unit_amount).toBe(115000)
    expect(body.allowed_payment_channels).toEqual(['QRIS'])
  })

  test('an unknown channel offers every active method instead of failing', () => {
    const body = buildXenditSessionBody({ order, channel: 'LoadsaMoney', lines })
    expect(body.allowed_payment_channels).toBeUndefined()
  })

  test('a re-charge appends an attempt token to the reference id', () => {
    const first = buildXenditSessionBody({ order, channel: 'QRIS', lines })
    const again = buildXenditSessionBody({
      order,
      channel: 'QRIS',
      lines,
      existingPaymentReference: 'ps-abc',
    })
    expect(first.reference_id).toBe('INV-20260928-ABCDE')
    expect(again.reference_id.startsWith('INV-20260928-ABCDE~')).toBe(true)
    expect(again.metadata?.paykit_order).toBe('INV-20260928-ABCDE')
  })
})

describe('xenditChannelFitsAmount', () => {
  test('applies the documented per-channel windows', () => {
    expect(xenditChannelFitsAmount('ALFAMART', 9_999)).toBe(false)
    expect(xenditChannelFitsAmount('ALFAMART', 10_000)).toBe(true)
    expect(xenditChannelFitsAmount('ALFAMART', 5_000_001)).toBe(false)
    expect(xenditChannelFitsAmount('CARD', 4_999)).toBe(false)
    expect(xenditChannelFitsAmount('CARD', 5_000)).toBe(true)
    expect(xenditChannelFitsAmount('BCA', 1)).toBe(false)
    expect(xenditChannelFitsAmount('QRIS', 1)).toBe(true)
    expect(xenditChannelFitsAmount('QRIS', 20_000_001)).toBe(false)
    // An unknown channel is never hidden by a stale table.
    expect(xenditChannelFitsAmount('NEW_CHANNEL', 1)).toBe(true)
    expect(xenditChannelLimitFor('ALFAMART')).toEqual({ min: 10_000, max: 5_000_000 })
    expect(xenditChannelLimitFor('nope')).toBeNull()
  })
})

describe('xenditPaymentChannelsFor', () => {
  test('maps checkout channels to session channel codes', () => {
    expect(xenditPaymentChannelsFor('BCA')).toEqual(['BCA_VIRTUAL_ACCOUNT'])
    expect(xenditPaymentChannelsFor('MANDIRI')).toEqual(['MANDIRI_VIRTUAL_ACCOUNT'])
    expect(xenditPaymentChannelsFor('QRIS')).toEqual(['QRIS'])
    expect(xenditPaymentChannelsFor('CARD')).toEqual(['CARDS'])
    expect(xenditPaymentChannelsFor(null)).toBeUndefined()
    expect(xenditPaymentChannelsFor('nope')).toBeUndefined()
  })
})

describe('planXenditPaymentUpdate', () => {
  const order = {
    status: 'pending' as const,
    paymentStatus: 'unpaid' as const,
    amountPaid: 0,
    grandTotal: 125000,
  }

  test('a completed session settles the order', () => {
    const plan = planXenditPaymentUpdate(order, {
      id: 'ps-1',
      amount: 125000,
      status: 'COMPLETED',
      paymentChannel: 'BCA_VIRTUAL_ACCOUNT',
    })
    expect(plan).toMatchObject({
      action: 'apply',
      amountPaid: 125000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      paymentReference: 'ps-1',
      paymentMethod: 'BCA Virtual Account',
    })
  })

  test('a legacy settled invoice settles too', () => {
    for (const status of ['PAID', 'SETTLED']) {
      expect(planXenditPaymentUpdate(order, { id: 'inv-1', amount: 125000, status }).action).toBe(
        'apply',
      )
    }
  })

  test('an active or expired session never moves money', () => {
    for (const status of ['ACTIVE', 'EXPIRED', 'CANCELED']) {
      expect(planXenditPaymentUpdate(order, { id: 'ps-1', amount: 125000, status })).toEqual({
        action: 'noop',
        reason: 'transaction_not_paid',
      })
    }
  })

  test('a replayed payment is a no-op', () => {
    const plan = planXenditPaymentUpdate(
      { ...order, amountPaid: 125000, paymentReference: 'ps-1' },
      { id: 'ps-1', amount: 125000, status: 'COMPLETED' },
    )
    expect(plan).toEqual({ action: 'noop', reason: 'already_recorded' })
  })

  test('credit is clamped to the remaining balance', () => {
    const plan = planXenditPaymentUpdate(
      { ...order, amountPaid: 100000 },
      { id: 'ps-2', amount: 125000, status: 'COMPLETED' },
    )
    expect(plan).toMatchObject({ action: 'apply', amountPaid: 125000 })
  })
})

describe('transactions', () => {
  test('a session response parses, settles and names its order', () => {
    const parsed = parseXenditSession({
      payment_session_id: 'ps-1',
      reference_id: 'INV-1',
      status: 'COMPLETED',
      amount: 125000,
      currency: 'IDR',
      payment_id: 'py-1',
      metadata: { paykit_channel: 'BCA_VIRTUAL_ACCOUNT' },
    })
    expect(parsed).not.toBeNull()
    expect(isXenditCompletedSession(parsed!)).toBe(true)
    expect(xenditSessionAmount(parsed!)).toBe(125000)
    expect(xenditOrderNumberFromSession(parsed!)).toBe('INV-1')
    expect(xenditSessionChannel(parsed!)).toBe('BCA_VIRTUAL_ACCOUNT')
  })

  test('a decimal session amount is never a payment to apply', () => {
    const parsed = parseXenditSession({
      payment_session_id: 'ps-1',
      status: 'COMPLETED',
      amount: 125000.5,
    })
    expect(parsed).not.toBeNull()
    expect(xenditSessionAmount(parsed!)).toBeNull()
    expect(xenditSessionChannel(parsed!)).toBeNull()
  })

  test('the order number prefers the stamped metadata and strips an attempt token', () => {
    expect(
      xenditOrderNumberFromSession({
        reference_id: 'INV-1~abc',
        metadata: { paykit_order: 'INV-1' },
      }),
    ).toBe('INV-1')
    expect(xenditOrderNumberFromSession({ reference_id: 'INV-1~abc' })).toBe('INV-1')
    expect(xenditOrderNumberFromSession({ reference_id: 'INV-1' })).toBe('INV-1')
  })

  test('an unshaped body is not a session', () => {
    expect(parseXenditSession({ nonsense: true })).toBeNull()
    expect(xenditOrderNumberFromSession({ reference_id: null })).toBeNull()
  })

  test('a legacy invoice still parses, settles and names its order', () => {
    const parsed = parseXenditInvoice({
      id: 'inv-1',
      external_id: 'INV-1',
      status: 'PAID',
      amount: 125000,
      paid_amount: 130000,
      payment_channel: 'QRIS',
    })
    expect(parsed).not.toBeNull()
    expect(isXenditPaidInvoice(parsed!)).toBe(true)
    expect(xenditInvoiceAmount(parsed!)).toBe(130000)
    expect(xenditOrderNumberFromInvoice(parsed!)).toBe('INV-1')
  })
})

describe('webhook', () => {
  const sessionEvent = {
    event: 'payment_session.completed',
    business_id: 'biz-1',
    created: '2026-09-28T10:00:00Z',
    data: {
      payment_session_id: 'ps-1',
      reference_id: 'INV-1',
      status: 'COMPLETED',
      amount: 125000,
      currency: 'IDR',
      payment_id: 'py-1',
      metadata: { paykit_channel: 'BCA_VIRTUAL_ACCOUNT' },
    },
  }

  const legacyCallback = {
    id: 'inv-1',
    external_id: 'INV-1',
    status: 'PAID',
    amount: 125000,
    paid_amount: 125000,
    payment_channel: 'BCA',
  }

  test('a session event verifies and parses', () => {
    const webhook = verifyXenditCallback({ 'X-Callback-Token': 'secret' }, sessionEvent, 'secret')
    expect(webhook.kind).toBe('session')
    if (webhook.kind === 'session') {
      expect(webhook.event).toBe('payment_session.completed')
      expect(webhook.session.payment_session_id).toBe('ps-1')
    }
    expect(isXenditPaidWebhook(webhook)).toBe(true)
    expect(parseXenditSession(webhook.kind === 'session' ? webhook.session : {})).not.toBeNull()
  })

  test('a legacy invoice callback verifies and parses', () => {
    const webhook = verifyXenditCallback({ 'X-Callback-Token': 'secret' }, legacyCallback, 'secret')
    expect(webhook.kind).toBe('invoice')
    expect(isXenditPaidWebhook(webhook)).toBe(true)
  })

  test('an expired session is a normal, non-paying callback', () => {
    const webhook = parseXenditWebhook({
      ...sessionEvent,
      event: 'payment_session.expired',
      data: { ...sessionEvent.data, status: 'EXPIRED' },
    })
    expect(webhook).not.toBeNull()
    expect(isXenditPaidWebhook(webhook!)).toBe(false)
  })

  test('a wrong, missing or unconfigured token fails closed', () => {
    expect(() =>
      verifyXenditCallback({ 'x-callback-token': 'wrong' }, sessionEvent, 'secret'),
    ).toThrow(XenditWebhookAuthError)
    expect(() => verifyXenditCallback({}, sessionEvent, 'secret')).toThrow(XenditWebhookAuthError)
    expect(() =>
      verifyXenditCallback({ 'x-callback-token': 'secret' }, sessionEvent, null),
    ).toThrow(XenditWebhookAuthError)
  })

  test('an unshaped body is not a callback', () => {
    expect(parseXenditWebhook({ nonsense: true })).toBeNull()
  })
})

describe('readXenditCredentials', () => {
  test('merges the secret and config buckets', () => {
    const result = readXenditCredentials([{ secretKey: 'xnd_development_x', webhookToken: 't' }])
    expect(result).toMatchObject({ ok: true })
  })

  test('fails loudly on a half-configured connection', () => {
    expect(readXenditCredentials([{ secretKey: 'x' }]).ok).toBe(false)
    expect(readXenditCredentials([{}]).ok).toBe(false)
  })

  test('the key prefix names the environment for display', () => {
    expect(xenditKeyEnvironment('xnd_production_abc')).toBe('production')
    expect(xenditKeyEnvironment('xnd_development_abc')).toBe('sandbox')
  })
})

describe('sdk invoice read', () => {
  test('the official SDK response maps onto the snake_case reconciliation shape', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(
        JSON.stringify({
          id: 'inv-1',
          external_id: 'INV-1',
          user_id: 'user-1',
          status: 'PAID',
          amount: 125000,
          payment_method: 'QRIS',
          merchant_name: 'Toko Test',
          merchant_profile_picture_url: '',
          expiry_date: '2026-09-28T11:00:00.000Z',
          invoice_url: 'https://checkout.xendit.co/web/inv-1',
          available_banks: [],
          available_retail_outlets: [],
          available_ewallets: [],
          available_qr_codes: [],
          available_direct_debits: [],
          available_paylaters: [],
          should_send_email: true,
          created: '2026-09-28T10:00:00.000Z',
          updated: '2026-09-28T10:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const invoice = (await getXenditInvoice(
        { secretKey: 'xnd_development_x', webhookToken: 't' },
        'inv-1',
      )) as Record<string, unknown>
      expect(requestedUrl).toBe('https://api.xendit.co/v2/invoices/inv-1')
      expect(invoice).toMatchObject({
        id: 'inv-1',
        external_id: 'INV-1',
        status: 'PAID',
        amount: 125000,
        payment_channel: 'QRIS',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('sdk key check', () => {
  test('a valid key resolves; an invalid one wraps as XenditApiError', async () => {
    const originalFetch = globalThis.fetch
    const credentials = { secretKey: 'xnd_development_x', webhookToken: 't' }

    globalThis.fetch = (async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    try {
      await verifyXenditSecretKey(credentials)
    } finally {
      globalThis.fetch = originalFetch
    }

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error_code: 'INVALID_API_KEY', message: 'Invalid API key' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    try {
      await expect(verifyXenditSecretKey(credentials)).rejects.toBeInstanceOf(XenditApiError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('channels', () => {
  test('checkout channels resolve labels, session spellings too', () => {
    expect(isXenditCheckoutChannel('BCA')).toBe(true)
    expect(isXenditCheckoutChannel('card')).toBe(true)
    expect(isXenditCheckoutChannel('VA')).toBe(false)
    expect(xenditChannelLabel('QRIS')).toBe('QRIS')
    expect(xenditChannelLabel('CARD')).toBe('Credit / Debit Card')
    expect(xenditChannelLabel('BCA_VIRTUAL_ACCOUNT')).toBe('BCA Virtual Account')
    expect(xenditChannelLabel('CARDS')).toBe('Credit / Debit Card')
    expect(xenditChannelLabel('nope')).toBeNull()
  })
})
