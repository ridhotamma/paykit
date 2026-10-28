import { describe, expect, test } from 'vitest'

import {
  buildMidtransSnapBody,
  midtransCustomerPhone,
  midtransEnabledPaymentsFor,
  midtransRemainingAmountFor,
  midtransStartTime,
} from './charge'
import {
  createMidtransSnapClient,
  MIDTRANS_NOTIFICATION_HEADER,
  readMidtransCredentials,
} from './client'
import { isMidtransCheckoutChannel, midtransChannelLabel } from './index'
import { planMidtransPaymentUpdate } from './payment'
import {
  isMidtransPaidTransaction,
  midtransBankCode,
  midtransOrderNumberFromTransaction,
  midtransTransactionAmount,
  parseMidtransTransaction,
} from './transactions'
import {
  parseMidtransNotification,
  verifyMidtransNotification,
  verifyMidtransSignature,
  MidtransWebhookAuthError,
} from './webhook'

describe('midtransRemainingAmountFor', () => {
  test('charges only what is still owed', () => {
    expect(midtransRemainingAmountFor({ grandTotal: 100000, amountPaid: 40000 })).toBe(60000)
    expect(midtransRemainingAmountFor({ grandTotal: 100000, amountPaid: 100000 })).toBe(0)
    expect(midtransRemainingAmountFor({ grandTotal: 100000, amountPaid: 120000 })).toBe(0)
  })
})

describe('buildMidtransSnapBody', () => {
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

  test('mirrors clean lines and narrows the Snap list to the picked channel', () => {
    const body = buildMidtransSnapBody({
      order,
      channel: 'BCA_VA',
      lines: [...lines, { description: 'Ongkir', quantity: 1, unitPrice: 25000 }],
      totals: {},
      returnUrl: 'https://shop.test/order/confirmation',
      expiresInMinutes: 60,
      now: new Date('2026-09-28T10:00:00Z'),
    })
    expect(body.transaction_details).toEqual({
      order_id: 'INV-20260928-ABCDE',
      gross_amount: 125000,
    })
    expect(body.enabled_payments).toEqual(['bca_va'])
    expect(body.item_details?.reduce((acc, item) => acc + item.price * item.quantity, 0)).toBe(
      125000,
    )
    expect(body.callbacks).toEqual({
      finish: 'https://shop.test/order/confirmation',
      error: 'https://shop.test/order/confirmation',
    })
    expect(body.expiry).toMatchObject({ unit: 'minute', duration: 60 })
    expect(body.expiry?.start_time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+0700$/)
  })

  test('a discounted order collapses to a single line that still adds up', () => {
    const body = buildMidtransSnapBody({
      order: { ...order, grandTotal: 115000 },
      channel: 'QRIS',
      lines,
      totals: { discountTotal: 10000, shippingTotal: 25000 },
    })
    expect(body.transaction_details.gross_amount).toBe(115000)
    expect(body.item_details).toHaveLength(1)
    expect(body.item_details?.[0]?.price).toBe(115000)
    expect(body.enabled_payments).toEqual(['other_qris'])
  })

  test('an unknown channel shows every active type instead of failing', () => {
    const body = buildMidtransSnapBody({ order, channel: 'LoadsaMoney', lines })
    expect(body.enabled_payments).toBeUndefined()
  })

  test('a re-charge appends an attempt token to the order id', () => {
    const first = buildMidtransSnapBody({ order, channel: 'BCA_VA', lines })
    const again = buildMidtransSnapBody({
      order,
      channel: 'BCA_VA',
      lines,
      existingPaymentReference: 'snap-token-1',
    })
    expect(first.transaction_details.order_id).toBe('INV-20260928-ABCDE')
    expect(again.transaction_details.order_id.startsWith('INV-20260928-ABCDE~')).toBe(true)
    expect(
      midtransOrderNumberFromTransaction({ order_id: again.transaction_details.order_id }),
    ).toBe('INV-20260928-ABCDE')
  })
})

describe('midtransEnabledPaymentsFor', () => {
  test('maps checkout channels to granular Snap values', () => {
    expect(midtransEnabledPaymentsFor('BCA_VA')).toEqual(['bca_va'])
    expect(midtransEnabledPaymentsFor('MANDIRI_VA')).toEqual(['echannel'])
    expect(midtransEnabledPaymentsFor('DANAMON_VA')).toEqual(['danamon_va'])
    expect(midtransEnabledPaymentsFor('BSI_VA')).toEqual(['bsi_va'])
    expect(midtransEnabledPaymentsFor('QRIS')).toEqual(['other_qris'])
    expect(midtransEnabledPaymentsFor('CARD')).toEqual(['credit_card'])
    expect(midtransEnabledPaymentsFor(null)).toBeUndefined()
    expect(midtransEnabledPaymentsFor('nope')).toBeUndefined()
  })
})

describe('midtransCustomerPhone', () => {
  test('keeps BNI-acceptable shapes, drops the rest instead of failing the charge', () => {
    expect(midtransCustomerPhone('081234567890')).toBe('081234567890')
    expect(midtransCustomerPhone('+6281234567890')).toBe('+6281234567890')
    expect(midtransCustomerPhone('6281234567890')).toBe('+6281234567890')
    expect(midtransCustomerPhone('0812-3456-7890')).toBe('081234567890')
    expect(midtransCustomerPhone('0211234567')).toBe('0211234567')
    expect(midtransCustomerPhone('+1-415-555-1234')).toBeUndefined()
    expect(midtransCustomerPhone('not a phone')).toBeUndefined()
    expect(midtransCustomerPhone(null)).toBeUndefined()
  })
})

describe('midtransStartTime', () => {
  test('renders WIB regardless of the runtime timezone', () => {
    expect(midtransStartTime(new Date('2026-09-28T10:00:00Z'))).toBe('2026-09-28 17:00:00 +0700')
  })
})

describe('planMidtransPaymentUpdate', () => {
  const order = {
    status: 'pending' as const,
    paymentStatus: 'unpaid' as const,
    amountPaid: 0,
    grandTotal: 125000,
  }

  test('a settlement settles the order', () => {
    const plan = planMidtransPaymentUpdate(order, {
      id: 'trx-1',
      amount: 125000,
      status: 'settlement',
      paymentType: 'bank_transfer',
    })
    expect(plan).toMatchObject({
      action: 'apply',
      amountPaid: 125000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      paymentReference: 'trx-1',
    })
  })

  test('an accepted card capture settles, a challenged or unverdicted one does not', () => {
    const accepted = planMidtransPaymentUpdate(order, {
      id: 'trx-1',
      amount: 125000,
      status: 'capture',
      fraudStatus: 'accept',
    })
    expect(accepted.action).toBe('apply')
    for (const fraudStatus of ['challenge', 'deny', null]) {
      expect(
        planMidtransPaymentUpdate(order, {
          id: 'trx-1',
          amount: 125000,
          status: 'capture',
          fraudStatus,
        }),
      ).toEqual({ action: 'noop', reason: 'transaction_not_paid' })
    }
  })

  test('pending, denied and expired transactions never move money', () => {
    for (const status of ['pending', 'authorize', 'deny', 'cancel', 'expire', 'refund']) {
      expect(planMidtransPaymentUpdate(order, { id: 'trx-1', amount: 125000, status })).toEqual({
        action: 'noop',
        reason: 'transaction_not_paid',
      })
    }
  })

  test('the label resolves the specific bank and outlet, not the generic type', () => {
    const va = planMidtransPaymentUpdate(order, {
      id: 'trx-1',
      amount: 125000,
      status: 'settlement',
      paymentType: 'bank_transfer',
      bank: 'bni',
    })
    expect(va).toMatchObject({ action: 'apply', paymentMethod: 'BNI Virtual Account' })

    const outlet = planMidtransPaymentUpdate(order, {
      id: 'trx-1',
      amount: 125000,
      status: 'settlement',
      paymentType: 'cstore',
      store: 'indomaret',
    })
    expect(outlet).toMatchObject({ action: 'apply', paymentMethod: 'Indomaret' })

    const generic = planMidtransPaymentUpdate(order, {
      id: 'trx-1',
      amount: 125000,
      status: 'settlement',
      paymentType: 'bank_transfer',
    })
    expect(generic).toMatchObject({ action: 'apply', paymentMethod: 'Midtrans' })
  })

  test('a replayed transaction is a no-op', () => {
    const plan = planMidtransPaymentUpdate(
      { ...order, amountPaid: 125000, paymentReference: 'trx-1' },
      { id: 'trx-1', amount: 125000, status: 'settlement' },
    )
    expect(plan).toEqual({ action: 'noop', reason: 'already_recorded' })
  })

  test('credit is clamped to the remaining balance', () => {
    const plan = planMidtransPaymentUpdate(
      { ...order, amountPaid: 100000 },
      { id: 'trx-2', amount: 125000, status: 'settlement' },
    )
    expect(plan).toMatchObject({ action: 'apply', amountPaid: 125000 })
  })
})

describe('transactions', () => {
  test('a status response parses and settles', () => {
    const parsed = parseMidtransTransaction({
      order_id: 'INV-1',
      transaction_id: 'trx-1',
      transaction_status: 'settlement',
      payment_type: 'qris',
      gross_amount: '125000.00',
      status_code: '200',
    })
    expect(parsed).not.toBeNull()
    expect(isMidtransPaidTransaction(parsed!)).toBe(true)
    expect(midtransTransactionAmount(parsed!)).toBe(125000)
  })

  test('a zero fraction is dropped, a non-zero one is never a payment to apply', () => {
    const zeroFraction = parseMidtransTransaction({
      order_id: 'INV-1',
      transaction_status: 'settlement',
      gross_amount: '125000.00',
    })
    expect(midtransTransactionAmount(zeroFraction!)).toBe(125000)
    const nonZeroFraction = parseMidtransTransaction({
      order_id: 'INV-1',
      transaction_status: 'settlement',
      gross_amount: '125000.50',
    })
    expect(nonZeroFraction).not.toBeNull()
    expect(midtransTransactionAmount(nonZeroFraction!)).toBeNull()
  })

  test('the bank reads off the VA numbers', () => {
    expect(midtransBankCode({ bank: null, va_numbers: [{ va_number: '333', bank: 'bca' }] })).toBe(
      'bca',
    )
    expect(midtransBankCode({ bank: 'bni', va_numbers: [] })).toBe('bni')
    expect(midtransBankCode({ bank: null, va_numbers: null })).toBeNull()
  })

  test('a capture without an accept verdict is held for review', () => {
    expect(
      isMidtransPaidTransaction({ transaction_status: 'capture', fraud_status: 'challenge' }),
    ).toBe(false)
    expect(
      isMidtransPaidTransaction({ transaction_status: 'capture', fraud_status: 'accept' }),
    ).toBe(true)
    expect(isMidtransPaidTransaction({ transaction_status: 'capture', fraud_status: null })).toBe(
      false,
    )
  })

  test('an unshaped body is not a transaction', () => {
    expect(parseMidtransTransaction({ nonsense: true })).toBeNull()
  })
})

describe('webhook', () => {
  const notification = {
    order_id: 'INV-1',
    status_code: '200',
    gross_amount: '125000.00',
    transaction_status: 'settlement',
    signature_key: '',
  }

  async function signedKey(): Promise<string> {
    const input = `INV-1200125000.00SB-Mid-server-test`
    const digest = await globalThis.crypto.subtle.digest('SHA-512', new TextEncoder().encode(input))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  test('the digest verifies with the right server key only', async () => {
    const signatureKey = await signedKey()
    const shaped = parseMidtransNotification({ ...notification, signature_key: signatureKey })
    expect(shaped).not.toBeNull()
    expect(await verifyMidtransSignature(shaped!, 'SB-Mid-server-test')).toBe(true)
    expect(await verifyMidtransSignature(shaped!, 'SB-Mid-server-wrong')).toBe(false)
    expect(await verifyMidtransSignature(shaped!, null)).toBe(false)
  })

  test('the merchant-id guard rejects a different account and allows a missing id', async () => {
    const signatureKey = await signedKey()
    const signed = { ...notification, merchant_id: 'G123', signature_key: signatureKey }
    await expect(
      verifyMidtransNotification(signed, 'SB-Mid-server-test', 'G123'),
    ).resolves.toMatchObject({ order_id: 'INV-1' })
    await expect(verifyMidtransNotification(signed, 'SB-Mid-server-test', 'G999')).rejects.toThrow(
      MidtransWebhookAuthError,
    )
    await expect(
      verifyMidtransNotification({ ...signed, merchant_id: null }, 'SB-Mid-server-test', 'G999'),
    ).resolves.toMatchObject({ order_id: 'INV-1' })
  })

  test('an unshaped body is not a notification', () => {
    expect(parseMidtransNotification({ nonsense: true })).toBeNull()
  })
})

describe('readMidtransCredentials', () => {
  test('merges the secret and config buckets, sandbox by default', () => {
    const result = readMidtransCredentials([{ serverKey: 'SB-Mid-server-x' }])
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.credentials.environment).toBe('sandbox')
      expect(result.credentials.clientKey).toBe('')
      expect(result.credentials.merchantId).toBe('')
    }
  })

  test('a non-secret merchant id rides in from either bucket', () => {
    expect(
      readMidtransCredentials([{ serverKey: 'SB-Mid-server-x' }, { merchantId: 'G123' }]),
    ).toMatchObject({ ok: true, credentials: { merchantId: 'G123' } })
  })

  test('fails loudly on a half-configured connection', () => {
    expect(readMidtransCredentials([{}]).ok).toBe(false)
    expect(readMidtransCredentials([{ serverKey: 'x', environment: 'mars' }]).ok).toBe(false)
  })
})

describe('midtrans SDK client', () => {
  test('the per-transaction notification header is settable on the Snap client', () => {
    const snap = createMidtransSnapClient({
      serverKey: 'SB-Mid-server-x',
      clientKey: '',
      merchantId: '',
      environment: 'sandbox',
    })
    snap.httpClient.http_client.defaults.headers.common[MIDTRANS_NOTIFICATION_HEADER] =
      'https://hook.test/midtrans'
    expect(snap.httpClient.http_client.defaults.headers.common[MIDTRANS_NOTIFICATION_HEADER]).toBe(
      'https://hook.test/midtrans',
    )
  })
})

describe('channels', () => {
  test('checkout channels resolve labels, payment types too', () => {
    expect(isMidtransCheckoutChannel('BCA_VA')).toBe(true)
    expect(isMidtransCheckoutChannel('DANAMON_VA')).toBe(true)
    expect(isMidtransCheckoutChannel('BSI_VA')).toBe(true)
    expect(isMidtransCheckoutChannel('qris')).toBe(true)
    expect(isMidtransCheckoutChannel('bank_transfer')).toBe(false)
    expect(midtransChannelLabel('BCA_VA')).toBe('BCA Virtual Account')
    expect(midtransChannelLabel('bni')).toBe('BNI Virtual Account')
    expect(midtransChannelLabel('bank_transfer')).toBeNull()
    expect(midtransChannelLabel('other_qris')).toBe('QRIS')
    expect(midtransChannelLabel('credit_card')).toBe('Credit / Debit Card')
    expect(midtransChannelLabel('nope')).toBeNull()
  })
})
