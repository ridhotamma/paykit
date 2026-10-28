import { describe, expect, test } from 'vitest'

import {
  baseGatewayReference,
  chargeAttemptReference,
  shortReferenceToken,
} from './charge-reference'

describe('chargeAttemptReference', () => {
  test('the first charge keeps the bare order number', () => {
    expect(chargeAttemptReference('INV-1')).toBe('INV-1')
    expect(chargeAttemptReference('INV-1', null)).toBe('INV-1')
    expect(chargeAttemptReference('INV-1', '  ')).toBe('INV-1')
  })

  test('a re-charge appends a deterministic token derived from the previous reference', () => {
    const first = chargeAttemptReference('INV-1', 'ps-abc')
    const retry = chargeAttemptReference('INV-1', 'ps-abc')
    const next = chargeAttemptReference('INV-1', 'ps-def')
    expect(first).toBe(retry)
    expect(first).not.toBe(next)
    expect(first.startsWith('INV-1~')).toBe(true)
  })

  test('the composed reference stays inside Midtrans order_id limits', () => {
    const id = chargeAttemptReference('INV-20260928-ABCDE', 'a'.repeat(120))
    expect(id.length).toBeLessThanOrEqual(50)
  })
})

describe('baseGatewayReference', () => {
  test('strips a trailing attempt token and leaves everything else alone', () => {
    expect(baseGatewayReference('INV-1~abc')).toBe('INV-1')
    expect(baseGatewayReference('INV-1')).toBe('INV-1')
    expect(baseGatewayReference('ps-abc')).toBe('ps-abc')
  })
})

describe('shortReferenceToken', () => {
  test('is deterministic, distinct and url-safe', () => {
    expect(shortReferenceToken('ps-abc')).toBe(shortReferenceToken('ps-abc'))
    expect(shortReferenceToken('ps-abc')).not.toBe(shortReferenceToken('ps-abd'))
    expect(shortReferenceToken('ps-abc')).toMatch(/^[0-9a-z]+$/)
  })
})
