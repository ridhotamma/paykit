import { describe, expect, test } from 'vitest'

import { duitkuAdapter } from './duitku'
import { mayarAdapter } from './mayar'
import { midtransAdapter } from './midtrans'
import { paypalAdapter } from './paypal'
import { tripayAdapter } from './tripay'
import { xenditAdapter } from './xendit'

describe('embedded checkout capability', () => {
  test('every adapter advertises an in-page presentation', () => {
    for (const adapter of [
      tripayAdapter,
      duitkuAdapter,
      mayarAdapter,
      midtransAdapter,
      xenditAdapter,
      paypalAdapter,
    ]) {
      expect(adapter.capabilities.supportsEmbeddedCheckout).toBe(true)
    }
  })
})
