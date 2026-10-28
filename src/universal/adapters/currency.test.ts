import { describe, expect, test } from 'vitest'

import { midtransAdapter } from './midtrans'
import { paypalAdapter } from './paypal'
import { xenditAdapter } from './xendit'

describe('currencyUnsupportedReason', () => {
  test('xendit and midtrans settle IDR only', () => {
    expect(xenditAdapter.currencyUnsupportedReason?.({}, {}, 'IDR')).toBeNull()
    expect(midtransAdapter.currencyUnsupportedReason?.({}, {}, 'IDR')).toBeNull()
    expect(xenditAdapter.currencyUnsupportedReason?.({}, {}, undefined)).toBeNull()
    expect(xenditAdapter.currencyUnsupportedReason?.({}, {}, 'USD')).toContain('IDR')
    expect(midtransAdapter.currencyUnsupportedReason?.({}, {}, 'USD')).toContain('IDR')
  })

  test('paypal must match the connection currency, and an IDR shop can never match', () => {
    const usd = { clientId: 'id', clientSecret: 's', currency: 'USD', environment: 'sandbox' }
    const idr = { ...usd, currency: 'IDR' }

    expect(paypalAdapter.currencyUnsupportedReason?.(usd, {}, 'USD')).toBeNull()
    expect(paypalAdapter.currencyUnsupportedReason?.(usd, {}, 'usd')).toBeNull()
    expect(paypalAdapter.currencyUnsupportedReason?.(usd, {}, 'IDR')).toContain('IDR')
    expect(paypalAdapter.currencyUnsupportedReason?.(usd, {}, 'idr')).toContain('IDR')
    expect(paypalAdapter.currencyUnsupportedReason?.(idr, {}, 'IDR')).toContain('IDR')
  })
})
