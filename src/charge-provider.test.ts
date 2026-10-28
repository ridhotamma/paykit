import { describe, expect, test } from 'vitest'

import { orderChargeProvider } from './charge-provider'

describe('orderChargeProvider', () => {
  test('the checkout link names the gateway', () => {
    expect(
      orderChargeProvider({
        paymentLink: 'https://www.sandbox.paypal.com/checkoutnow?token=5O1',
        paymentMethod: 'Credit / Debit Card',
      }),
    ).toBe('paypal')
    expect(orderChargeProvider({ paymentLink: 'https://app.midtrans.com/snap/v4/x' })).toBe(
      'midtrans',
    )
  })

  test('a look-alike host is not the gateway', () => {
    expect(orderChargeProvider({ paymentLink: 'https://paypal.com.evil.example/pay' })).toBeNull()
  })

  test('the label is the fallback when there is no usable link', () => {
    expect(orderChargeProvider({ paymentLink: 'not a url', paymentMethod: 'Mayar QRIS' })).toBe(
      'mayar',
    )
    expect(orderChargeProvider({ paymentMethod: 'BCA Virtual Account' })).toBeNull()
  })
})
