import { createHash, createHmac } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  buildDokuCheckoutBody,
  dokuCustomerPhone,
  dokuExpiryUnixSeconds,
} from './charge'
import {
  createDokuCheckout,
  DokuApiError,
  parseDokuTransaction,
  readDokuCredentials,
} from './client'
import {
  dokuChannelCode,
  dokuChannelKind,
  dokuChannelLabel,
  isDokuCheckoutChannel,
} from './index'
import { planDokuPaymentUpdate } from './payment'
import {
  dokuDigest,
  dokuRequestTimestamp,
  dokuSignatureHeader,
  dokuSignatureString,
  verifyDokuSignature,
} from './signature'
import {
  dokuInvoiceNumberFromNotification,
  isDokuPaidNotification,
  verifyDokuNotification,
} from './webhook'

describe('DOKU signature', () => {
  const secretKey = 'SK-test'
  const body = JSON.stringify({ order: { amount: 20_000 } })
  const digest = createHash('sha256').update(body).digest('base64')
  const components = {
    clientId: 'MCH-0001-test',
    requestId: 'request-1',
    requestTimestamp: '2026-11-09T08:45:42Z',
    requestTarget: '/checkout/v1/payment',
    digest,
  }

  test('digest and signature match the documented algorithm', async () => {
    expect(await dokuDigest(body)).toBe(digest)

    const signedString = dokuSignatureString(components)
    expect(signedString).toBe(
      [
        'Client-Id:MCH-0001-test',
        'Request-Id:request-1',
        'Request-Timestamp:2026-11-09T08:45:42Z',
        'Request-Target:/checkout/v1/payment',
        `Digest:${digest}`,
      ].join('\n'),
    )

    const expected = `HMACSHA256=${createHmac('sha256', secretKey).update(signedString).digest('base64')}`
    await expect(dokuSignatureHeader(components, secretKey)).resolves.toBe(expected)
    await expect(verifyDokuSignature(components, secretKey, expected)).resolves.toBe(true)
    await expect(verifyDokuSignature(components, secretKey, 'HMACSHA256=nope')).resolves.toBe(false)
  })

  test('a GET signature omits the digest line', () => {
    const { digest: _digest, ...getComponents } = components
    expect(dokuSignatureString(getComponents)).not.toContain('Digest:')
  })

  test('timestamps are UTC ISO 8601 without milliseconds', () => {
    expect(dokuRequestTimestamp(new Date('2026-11-09T08:45:42.123Z'))).toBe(
      '2026-11-09T08:45:42Z',
    )
  })
})

describe('buildDokuCheckoutBody', () => {
  const order = {
    tenantId: 'tenant_1',
    orderNumber: 'INV-20261109-001',
    grandTotal: 125_000,
    amountPaid: 0,
    customerName: 'Budi Santoso',
    customerEmail: 'budi@example.com',
    customerPhone: '6281234567890',
  }
  const lines = [
    { description: 'Kopi Susu', quantity: 2, unitPrice: 50_000 },
    { description: 'Ongkir', quantity: 1, unitPrice: 25_000 },
  ]

  test('builds the order, basket, channel and return/notification URLs', () => {
    const body = buildDokuCheckoutBody({
      order,
      channel: 'VIRTUAL_ACCOUNT_BCA',
      lines,
      returnUrl: 'https://shop.test/orders/INV-20261109-001',
      callbackUrl: 'https://api.shop.test/store/test/doku',
      expiresInMinutes: 30,
    })

    expect(body.order.amount).toBe(125_000)
    expect(body.order.invoice_number).toBe('INV-20261109-001')
    expect(body.order.callback_url).toBe('https://shop.test/orders/INV-20261109-001')
    expect(body.order.callback_url_result).toBe('https://shop.test/orders/INV-20261109-001')
    expect(body.order.auto_redirect).toBe(true)
    expect(body.payment?.payment_due_date).toBe(30)
    expect(body.payment?.payment_method_types).toEqual(['VIRTUAL_ACCOUNT_BCA'])
    expect(body.payment?.type).toBe('SALE')
    expect(body.customer?.name).toBe('Budi Santoso')
    expect(body.customer?.phone).toBe('6281234567890')
    expect(body.additional_info?.override_notification_url).toBe(
      'https://api.shop.test/store/test/doku',
    )
    expect(body.order.line_items?.reduce((sum, item) => sum + item.price * item.quantity, 0)).toBe(
      125_000,
    )
  })

  test('a discounted order collapses to one line that still adds up', () => {
    const body = buildDokuCheckoutBody({
      order: { ...order, grandTotal: 115_000 },
      channel: 'QRIS',
      lines,
      totals: { discountTotal: 10_000 },
    })

    expect(body.order.amount).toBe(115_000)
    expect(body.order.line_items).toHaveLength(1)
    expect(body.order.line_items?.[0]?.price).toBe(115_000)
    expect(body.payment?.payment_method_types).toEqual(['QRIS'])
  })

  test('omits the method when the buyer will choose on DOKU', () => {
    const body = buildDokuCheckoutBody({ order, lines })
    expect(body.payment?.payment_method_types).toBeUndefined()
    expect(body.order.callback_url).toBeUndefined()
    expect(body.order.auto_redirect).toBeUndefined()
  })

  test('a re-charge appends an attempt token to the invoice number', () => {
    const first = buildDokuCheckoutBody({ order, lines })
    const again = buildDokuCheckoutBody({ order, lines, existingPaymentReference: 'INV-1' })
    expect(first.order.invoice_number).toBe('INV-20261109-001')
    expect(again.order.invoice_number.startsWith('INV-20261109-001~')).toBe(true)
  })
})

describe('DOKU phone', () => {
  test('normalises a local Indonesian number to country-code form', () => {
    expect(dokuCustomerPhone('0812-3456-7890')).toBe('6281234567890')
    expect(dokuCustomerPhone('+62 812 3456 7890')).toBe('6281234567890')
    expect(dokuCustomerPhone(null)).toBeUndefined()
  })
})

describe('DOKU expiry', () => {
  test('parses yyyyMMddHHmmss in WIB', () => {
    expect(dokuExpiryUnixSeconds('20240712104711')).toBe(
      Math.floor(Date.UTC(2024, 6, 12, 3, 47, 11) / 1000),
    )
    expect(dokuExpiryUnixSeconds('nope')).toBeNull()
    expect(dokuExpiryUnixSeconds(null)).toBeNull()
  })
})

describe('channels', () => {
  test('resolves DOKU codes, labels and families', () => {
    expect(isDokuCheckoutChannel('VIRTUAL_ACCOUNT_BCA')).toBe(true)
    expect(isDokuCheckoutChannel('virtual_account_bca')).toBe(true)
    expect(isDokuCheckoutChannel('nope')).toBe(false)
    expect(dokuChannelLabel('EMONEY_SHOPEE_PAY')).toBe('ShopeePay')
    expect(dokuChannelLabel('VIRTUAL_ACCOUNT_Sinarmas')).toBe('Sinarmas Virtual Account')
    expect(dokuChannelKind('QRIS')).toBe('qris')
    expect(dokuChannelKind('PEER_TO_PEER_KREDIVO')).toBe('paylater')
    expect(dokuChannelKind('nope')).toBeNull()
    expect(dokuChannelCode('virtual_account_sinarmas')).toBe('VIRTUAL_ACCOUNT_Sinarmas')
    expect(dokuChannelCode('nope')).toBeNull()
  })
})

describe('credentials', () => {
  test('requires the client id and secret key', () => {
    expect(readDokuCredentials([{ clientId: 'MCH-1' }]).ok).toBe(false)
    const result = readDokuCredentials([{ clientId: 'MCH-1', secretKey: 'SK-1' }])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.credentials.environment).toBe('sandbox')
  })
})

describe('transaction parsing', () => {
  test('normalises a decimal amount and exposes the channel', () => {
    const transaction = parseDokuTransaction({
      order: { invoice_number: 'INV-1', amount: 20000.0 },
      transaction: { status: 'SUCCESS', date: '2026-11-09T03:15:26Z' },
      channel: { id: 'QRIS' },
    })
    expect(transaction).not.toBeNull()
    expect(transaction?.order.amount).toBe(20000)
    expect(transaction?.channel?.id).toBe('QRIS')
  })
})

describe('payment planner', () => {
  const payable = {
    status: 'pending' as const,
    paymentStatus: 'unpaid' as const,
    amountPaid: 0,
    grandTotal: 125_000,
    paymentReference: 'INV-1',
    paidAt: null,
    paymentMethod: 'DOKU',
  }

  test('settles a SUCCESS transaction and stamps the channel label', () => {
    const plan = planDokuPaymentUpdate(payable, {
      invoiceNumber: 'INV-1',
      amount: 125_000,
      status: 'SUCCESS',
      channel: 'VIRTUAL_ACCOUNT_BCA',
    })

    expect(plan).toMatchObject({
      action: 'apply',
      amountPaid: 125_000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      paymentReference: 'INV-1',
      paymentMethod: 'BCA Virtual Account',
    })
  })

  test('clamps a partial payment and ignores non-success statuses', () => {
    expect(
      planDokuPaymentUpdate(
        { ...payable, grandTotal: 150_000 },
        { invoiceNumber: 'INV-1', amount: 125_000, status: 'SUCCESS' },
      ),
    ).toMatchObject({ action: 'apply', amountPaid: 125_000, paymentStatus: 'partial' })

    expect(
      planDokuPaymentUpdate(payable, {
        invoiceNumber: 'INV-1',
        amount: 125_000,
        status: 'EXPIRED',
      }),
    ).toEqual({ action: 'noop', reason: 'transaction_not_paid' })
  })

  test('is idempotent once the ledger covers the invoice', () => {
    expect(
      planDokuPaymentUpdate(
        { ...payable, amountPaid: 125_000 },
        { invoiceNumber: 'INV-1', amount: 125_000, status: 'SUCCESS' },
      ),
    ).toEqual({ action: 'noop', reason: 'already_recorded' })
  })
})

describe('notification verification', () => {
  const clientId = 'MCH-0001-test'
  const secretKey = 'SK-test'
  const requestTarget = '/store/test/doku'
  const rawBody = JSON.stringify({
    order: { invoice_number: 'INV-1', amount: 125_000 },
    transaction: {
      status: 'SUCCESS',
      date: '2026-11-09T03:15:26Z',
      original_request_id: 'request-1',
    },
    service: { id: 'VIRTUAL_ACCOUNT' },
    acquirer: { id: 'BCA' },
    channel: { id: 'VIRTUAL_ACCOUNT_BCA' },
  })
  const requestId = 'notification-1'
  const requestTimestamp = '2026-11-09T03:15:30Z'

  async function signedHeaders(): Promise<Record<string, string>> {
    const digest = await dokuDigest(rawBody)
    const signature = await dokuSignatureHeader(
      { clientId, requestId, requestTimestamp, requestTarget, digest },
      secretKey,
    )
    return {
      'Client-Id': clientId,
      'Request-Id': requestId,
      'Request-Timestamp': requestTimestamp,
      Signature: signature,
    }
  }

  test('verifies a real notification and exposes the invoice number', async () => {
    const transaction = await verifyDokuNotification({
      rawBody,
      headers: await signedHeaders(),
      requestTarget,
      clientId,
      secretKey,
    })

    expect(isDokuPaidNotification(transaction)).toBe(true)
    expect(dokuInvoiceNumberFromNotification(transaction)).toBe('INV-1')
  })

  test('rejects a tampered body, a wrong client id and a wrong target', async () => {
    const headers = await signedHeaders()

    await expect(
      verifyDokuNotification({
        rawBody: rawBody.replace('125000', '1'),
        headers,
        requestTarget,
        clientId,
        secretKey,
      }),
    ).rejects.toThrow('signature mismatch')

    await expect(
      verifyDokuNotification({
        rawBody,
        headers: { ...headers, 'Client-Id': 'MCH-other' },
        requestTarget,
        clientId,
        secretKey,
      }),
    ).rejects.toThrow('client id mismatch')

    await expect(
      verifyDokuNotification({
        rawBody,
        headers,
        requestTarget: '/store/other/doku',
        clientId,
        secretKey,
      }),
    ).rejects.toThrow('signature mismatch')
  })
})

describe('client', () => {
  test('creates a checkout with headers that verify against the raw body', async () => {
    const originalFetch = globalThis.fetch
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = String(init?.body ?? '')
      return new Response(
        JSON.stringify({
          message: ['SUCCESS'],
          response: {
            order: { amount: '50000', invoice_number: 'INV-1', currency: 'IDR' },
            payment: {
              url: 'https://sandbox.doku.com/checkout-link-v2/abc',
              token_id: 'token-1',
              expired_date: '20261109104711',
              payment_method_types: ['QRIS'],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    try {
      const checkout = await createDokuCheckout(
        { clientId: 'MCH-0001-test', secretKey: 'SK-test', environment: 'sandbox' },
        {
          order: { amount: 50_000, invoice_number: 'INV-1', currency: 'IDR' },
          payment: { payment_method_types: ['QRIS'] },
        },
      )

      expect(capturedUrl).toBe('https://api-sandbox.doku.com/checkout/v1/payment')
      expect(capturedHeaders['Client-Id']).toBe('MCH-0001-test')
      expect(capturedHeaders.Signature?.startsWith('HMACSHA256=')).toBe(true)

      const digest = await dokuDigest(capturedBody)
      const valid = await verifyDokuSignature(
        {
          clientId: capturedHeaders['Client-Id']!,
          requestId: capturedHeaders['Request-Id']!,
          requestTimestamp: capturedHeaders['Request-Timestamp']!,
          requestTarget: '/checkout/v1/payment',
          digest,
        },
        'SK-test',
        capturedHeaders.Signature,
      )
      expect(valid).toBe(true)
      expect(checkout.paymentUrl).toBe('https://sandbox.doku.com/checkout-link-v2/abc')
      expect(checkout.invoiceNumber).toBe('INV-1')
      expect(checkout.expiredAt).toBe('20261109104711')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a failed request is shaped as a DokuApiError', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error_messages: ['order.invoice_number must be filled'] }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch

    try {
      await expect(
        createDokuCheckout(
          { clientId: 'MCH-1', secretKey: 'SK-1', environment: 'sandbox' },
          { order: { amount: 10_000, invoice_number: '' } },
        ),
      ).rejects.toBeInstanceOf(DokuApiError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
