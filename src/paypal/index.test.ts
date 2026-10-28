import { describe, expect, test } from 'vitest'

import {
  approveLinkFrom,
  buildPaypalOrderBody,
  minorToPaypalValue,
  paypalRequestId,
  paypalValueToMinor,
} from './charge'
import { readPaypalCredentials } from './client'
import { isPaypalCheckoutChannel, paypalChannelLabel } from './index'
import { planPaypalPaymentUpdate } from './payment'
import {
  parsePaypalCapture,
  paypalCapturesFromOrder,
  paypalOrderNumberFromCapture,
  paypalOrderNumberFromUnits,
  paypalRelatedOrderId,
  toPaypalCaptureAmount,
} from './transactions'
import { paypalCheckoutOrderId } from './webhook'

describe('minorToPaypalValue', () => {
  test('formats minor units exactly, never through a float', () => {
    expect(minorToPaypalValue(12500, 'IDR')).toBe('12500')
    expect(minorToPaypalValue(1250, 'USD')).toBe('12.50')
    expect(minorToPaypalValue(100, 'USD')).toBe('1.00')
    expect(minorToPaypalValue(0, 'USD')).toBe('0.00')
    expect(minorToPaypalValue(1500, 'JPY')).toBe('1500')
  })
})

describe('paypalValueToMinor', () => {
  test('round-trips the formatted value', () => {
    expect(paypalValueToMinor('12.50', 'USD')).toBe(1250)
    expect(paypalValueToMinor('12500', 'IDR')).toBe(12500)
    expect(paypalValueToMinor('1500', 'JPY')).toBe(1500)
  })

  test('rejects more digits than the currency allows', () => {
    expect(paypalValueToMinor('12.500', 'USD')).toBeNull()
    expect(paypalValueToMinor('12.5', 'JPY')).toBeNull()
    expect(paypalValueToMinor('', 'USD')).toBeNull()
    expect(paypalValueToMinor('abc', 'USD')).toBeNull()
  })
})

describe('buildPaypalOrderBody', () => {
  const order = {
    tenantId: 'tenant_1',
    orderNumber: 'INV-20260928-ABCDE',
    grandTotal: 125000,
    amountPaid: 0,
    customerName: 'Budi',
  }

  test('charges the remaining balance with the order as correlation', () => {
    const body = buildPaypalOrderBody({
      order,
      currency: 'IDR',
      returnUrl: 'https://shop.test/order/confirmation',
      brandName: 'Toko ABC',
    })
    expect(body.intent).toBe('CAPTURE')
    expect(body.purchase_units[0]?.reference_id).toBe('INV-20260928-ABCDE')
    expect(body.purchase_units[0]?.custom_id).toBe('tenant_1:INV-20260928-ABCDE')
    expect(body.purchase_units[0]?.invoice_id).toBe('INV-20260928-ABCDE')
    expect(body.purchase_units[0]?.amount).toEqual({ currency_code: 'IDR', value: '125000' })
    const experience = body.payment_source.paypal.experience_context
    expect(experience.shipping_preference).toBe('NO_SHIPPING')
    expect(experience.user_action).toBe('PAY_NOW')
    expect(experience.return_url).toBe('https://shop.test/order/confirmation')
    expect(experience.cancel_url).toBe('https://shop.test/order/confirmation')
    expect(experience.brand_name).toBe('Toko ABC')
    expect(body).not.toHaveProperty('application_context')
  })

  test('a part-paid order only charges what is still owed', () => {
    const body = buildPaypalOrderBody({
      order: { ...order, grandTotal: 10000, amountPaid: 4000 },
      currency: 'USD',
      returnUrl: 'https://shop.test/confirm',
    })
    expect(body.purchase_units[0]?.amount).toEqual({ currency_code: 'USD', value: '60.00' })
  })

  test('a re-charge suffixes the invoice id but keeps the custom id as correlation', () => {
    const body = buildPaypalOrderBody({
      order,
      currency: 'USD',
      returnUrl: 'https://shop.test/confirm',
      existingPaymentReference: 'PAYPAL-ORDER-1',
    })
    expect(body.purchase_units[0]?.custom_id).toBe('tenant_1:INV-20260928-ABCDE')
    expect(body.purchase_units[0]?.invoice_id.startsWith('INV-20260928-ABCDE~')).toBe(true)
  })
})

describe('approveLinkFrom', () => {
  test('reads the approve link, either rel spelling', () => {
    expect(
      approveLinkFrom({ links: [{ href: 'https://paypal.test/approve', rel: 'approve' }] }),
    ).toBe('https://paypal.test/approve')
    expect(
      approveLinkFrom({ links: [{ href: 'https://paypal.test/approve', rel: 'payer-action' }] }),
    ).toBe('https://paypal.test/approve')
    expect(approveLinkFrom({ links: [] })).toBeNull()
    expect(approveLinkFrom({})).toBeNull()
  })
})

describe('paypalRequestId', () => {
  test('the first charge keys on the order number alone', () => {
    expect(paypalRequestId('INV-1')).toBe('paykit-INV-1')
    expect(paypalRequestId('INV-1', null)).toBe('paykit-INV-1')
  })

  test('a re-charge gets a fresh, retry-stable id', () => {
    const first = paypalRequestId('INV-1', 'PAYPAL-ORDER-1')
    expect(first).toBe(paypalRequestId('INV-1', 'PAYPAL-ORDER-1'))
    expect(first).not.toBe(paypalRequestId('INV-1', 'PAYPAL-ORDER-2'))
    expect(first).not.toBe(paypalRequestId('INV-1'))
    expect(first.length).toBeLessThanOrEqual(108)
  })
})

describe('planPaypalPaymentUpdate', () => {
  const order = {
    status: 'pending' as const,
    paymentStatus: 'unpaid' as const,
    amountPaid: 0,
    grandTotal: 125000,
  }

  test('a completed capture settles the order', () => {
    const plan = planPaypalPaymentUpdate(order, {
      id: 'cap_1',
      amount: 125000,
      status: 'COMPLETED',
      paymentMethod: 'PayPal',
    })
    expect(plan).toMatchObject({
      action: 'apply',
      amountPaid: 125000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      paymentReference: 'cap_1',
    })
  })

  test('a replayed capture is a no-op', () => {
    const plan = planPaypalPaymentUpdate(
      { ...order, amountPaid: 125000, paymentReference: 'cap_1' },
      { id: 'cap_1', amount: 125000, status: 'COMPLETED' },
    )
    expect(plan).toEqual({ action: 'noop', reason: 'already_recorded' })
  })

  test('a non-completed capture never moves money', () => {
    for (const status of ['PENDING', 'DECLINED', 'REFUNDED', 'FAILED', 'PARTIALLY_REFUNDED']) {
      expect(planPaypalPaymentUpdate(order, { id: 'cap_1', amount: 125000, status })).toEqual({
        action: 'noop',
        reason: 'transaction_not_paid',
      })
    }
  })

  test('credit is clamped to the remaining balance', () => {
    const plan = planPaypalPaymentUpdate(
      { ...order, amountPaid: 100000 },
      { id: 'cap_2', amount: 125000, status: 'COMPLETED' },
    )
    expect(plan).toMatchObject({ action: 'apply', amountPaid: 125000 })
  })
})

describe('transactions', () => {
  test('capture amount rejects a currency mismatch instead of converting', () => {
    const capture = parsePaypalCapture({
      id: 'cap_1',
      status: 'COMPLETED',
      amount: { currency_code: 'EUR', value: '10.00' },
    })
    expect(capture).not.toBeNull()
    expect(toPaypalCaptureAmount(capture!, 'USD').amount).toBeNull()
    expect(toPaypalCaptureAmount(capture!, 'EUR').amount).toBe(1000)
  })

  test('the order number prefers custom_id, then invoice_id', () => {
    expect(paypalOrderNumberFromCapture({ customId: 'tenant_1:INV-1', invoiceId: 'INV-2' })).toBe(
      'INV-1',
    )
    expect(paypalOrderNumberFromCapture({ customId: null, invoiceId: 'INV-2' })).toBe('INV-2')
    expect(paypalOrderNumberFromCapture({ customId: null, invoiceId: 'INV-2~abc' })).toBe('INV-2')
    expect(paypalOrderNumberFromCapture({ customId: null, invoiceId: null })).toBeNull()
  })

  test('captures and order numbers read off an order response', () => {
    const response = {
      id: 'order_1',
      status: 'COMPLETED',
      purchase_units: [
        {
          reference_id: 'INV-1',
          custom_id: 'tenant_1:INV-1',
          payments: {
            captures: [
              {
                id: 'cap_1',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '60.00' },
              },
            ],
          },
        },
      ],
    }
    expect(paypalCapturesFromOrder(response)).toHaveLength(1)
    expect(paypalOrderNumberFromUnits(response)).toBe('INV-1')
    expect(
      paypalOrderNumberFromUnits({
        id: 'order_2',
        status: 'COMPLETED',
        purchase_units: [{ invoice_id: 'INV-2~abc' }],
      }),
    ).toBe('INV-2')
    expect(paypalCapturesFromOrder({ nonsense: true })).toEqual([])
  })

  test('the related PayPal order id reads off a capture event', () => {
    expect(
      paypalRelatedOrderId({
        supplementary_data: { related_ids: { order_id: 'PAYPAL-ORDER-1' } },
      }),
    ).toBe('PAYPAL-ORDER-1')
    expect(paypalRelatedOrderId({})).toBeNull()
    expect(paypalRelatedOrderId(null)).toBeNull()
  })
})

describe('readPaypalCredentials', () => {
  test('merges the secret and config buckets, sandbox by default', () => {
    const result = readPaypalCredentials([{ clientId: 'id', clientSecret: 'secret' }])
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.credentials.environment).toBe('sandbox')
      expect(result.credentials.currency).toBe('USD')
    }
  })

  test('fails loudly on a half-configured connection', () => {
    expect(readPaypalCredentials([{ clientId: 'id' }]).ok).toBe(false)
    expect(
      readPaypalCredentials([{ clientId: 'id', clientSecret: 's', environment: 'mars' }]).ok,
    ).toBe(false)
    expect(readPaypalCredentials([{ clientId: 'id', clientSecret: 's', currency: 'IDR' }]).ok).toBe(
      false,
    )
  })
})

describe('channels', () => {
  test('the three buyer choices resolve labels', () => {
    expect(isPaypalCheckoutChannel('paypal')).toBe(true)
    expect(isPaypalCheckoutChannel('paylater')).toBe(true)
    expect(isPaypalCheckoutChannel('card')).toBe(true)
    expect(isPaypalCheckoutChannel('VA')).toBe(false)
    expect(paypalChannelLabel('card')).toBe('Credit / Debit Card')
    expect(paypalChannelLabel('nope')).toBeNull()
  })
})

describe('paypalCheckoutOrderId', () => {
  test('reads the order id off an approval resource, and nothing else', () => {
    expect(paypalCheckoutOrderId({ id: '0WA31244TG5992359', status: 'APPROVED' })).toBe(
      '0WA31244TG5992359',
    )
    expect(paypalCheckoutOrderId({ status: 'APPROVED' })).toBeNull()
    expect(paypalCheckoutOrderId({ id: '' })).toBeNull()
    expect(paypalCheckoutOrderId(null)).toBeNull()
  })
})
