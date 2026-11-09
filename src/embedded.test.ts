import { describe, expect, test } from 'vitest'

import {
  aulaaEmbeddedCheckout,
  duitkuEmbeddedCheckout,
  duitkuJsUrl,
  iframeEmbeddedCheckout,
  midtransEmbeddedCheckout,
  midtransSnapUrl,
  paypalEmbeddedCheckout,
  paypalSdkUrl,
  xenditComponentsEmbeddedCheckout,
  xenditIframeCheckout,
} from './embedded'

describe('Duitku embedded checkout', () => {
  test('points at the deployment matching the connection', () => {
    expect(duitkuJsUrl('sandbox')).toBe('https://app-sandbox.duitku.com/lib/js/duitku.js')
    expect(duitkuJsUrl('production')).toBe('https://app-prod.duitku.com/lib/js/duitku.js')
  })

  test('is script-first with the hosted page as a fallback', () => {
    const checkout = duitkuEmbeddedCheckout(
      'D123REF',
      'sandbox',
      'https://app-sandbox.duitku.com/redirect_checkout?reference=D123REF',
    )

    expect(checkout.provider).toBe('duitku')
    expect(checkout.preferred).toBe('script')
    expect(checkout.iframeUrl).toContain('redirect_checkout')
    expect(checkout.script).toEqual({
      sdk: 'duitku-pop',
      source: 'https://app-sandbox.duitku.com/lib/js/duitku.js',
      token: 'D123REF',
    })
  })

  test('omits the fallback when the provider returned no page', () => {
    expect(duitkuEmbeddedCheckout('D123REF', 'production').iframeUrl).toBeUndefined()
  })
})

describe('Midtrans embedded checkout', () => {
  test('points at the deployment matching the connection', () => {
    expect(midtransSnapUrl('sandbox')).toBe('https://app.sandbox.midtrans.com/snap/snap.js')
    expect(midtransSnapUrl('production')).toBe('https://app.midtrans.com/snap/snap.js')
  })

  test('carries the Snap token and the public client key', () => {
    const checkout = midtransEmbeddedCheckout(
      'snap-token',
      'SB-Mid-client-key',
      'sandbox',
      'https://app.sandbox.midtrans.com/snap/v4/redirection/snap-token',
    )

    expect(checkout.preferred).toBe('script')
    expect(checkout.iframeUrl).toContain('/snap/v4/redirection/')
    expect(checkout.script).toEqual({
      sdk: 'midtrans-snap',
      source: 'https://app.sandbox.midtrans.com/snap/snap.js',
      token: 'snap-token',
      clientKey: 'SB-Mid-client-key',
    })
  })
})

describe('Xendit embedded checkout', () => {
  test('a components session has no hosted page', () => {
    const checkout = xenditComponentsEmbeddedCheckout('session-key')

    expect(checkout.provider).toBe('xendit')
    expect(checkout.preferred).toBe('script')
    expect(checkout.iframeUrl).toBeUndefined()
    expect(checkout.script).toEqual({
      sdk: 'xendit-components',
      source: 'xendit-components-web',
      token: 'session-key',
    })
  })

  test('a payment-link session exposes its frameable page', () => {
    const checkout = xenditIframeCheckout('https://checkout.xendit.co/web/ps-123')

    expect(checkout).toEqual({
      provider: 'xendit',
      preferred: 'iframe',
      iframeUrl: 'https://checkout.xendit.co/web/ps-123',
    })
  })
})

describe('PayPal embedded checkout', () => {
  test('builds the JS SDK URL without leaking the secret', () => {
    const url = paypalSdkUrl('client-id', 'usd')

    expect(url).toContain('https://www.paypal.com/sdk/js?')
    expect(url).toContain('client-id=client-id')
    expect(url).toContain('currency=USD')
    expect(url).toContain('intent=capture')
    expect(url).not.toContain('secret')
  })

  test('is script-only because the approval page forbids framing', () => {
    const checkout = paypalEmbeddedCheckout('ORDER-1', 'client-id', 'USD')

    expect(checkout.preferred).toBe('script')
    expect(checkout.iframeUrl).toBeUndefined()
    expect(checkout.script?.sdk).toBe('paypal-js')
    expect(checkout.script?.token).toBe('ORDER-1')
    expect(checkout.script?.clientKey).toBe('client-id')
  })
})

describe('Aulaa embedded checkout', () => {
  test('opens the payment link through the provider overlay script', () => {
    const checkout = aulaaEmbeddedCheckout('https://payment.aulaa.co/pay/f47ac10b')

    expect(checkout).toEqual({
      provider: 'aulaa',
      preferred: 'script',
      iframeUrl: 'https://payment.aulaa.co/pay/f47ac10b',
      script: {
        sdk: 'aulaa-checkout',
        source: 'https://payment.aulaa.co/embed.js',
        token: 'https://payment.aulaa.co/pay/f47ac10b',
      },
    })
  })
})

describe('iframeEmbeddedCheckout', () => {
  test('wraps any hosted page', () => {
    expect(iframeEmbeddedCheckout('tripay', 'https://tripay.co.id/checkout/T0001')).toEqual({
      provider: 'tripay',
      preferred: 'iframe',
      iframeUrl: 'https://tripay.co.id/checkout/T0001',
    })
  })
})
