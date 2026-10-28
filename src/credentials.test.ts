import { describe, expect, test } from 'vitest'

import {
  mergeCredentialBlobs,
  resolveCredentialsForSave,
  secretKeysFor,
  splitCredentialsAndConfig,
} from './credentials'
import { readXenditCredentials } from './xendit/client'
import { readMidtransCredentials } from './midtrans/client'
import { readPaypalCredentials } from './paypal/client'

describe('mergeCredentialBlobs', () => {
  test('the first blob wins for a key both carry', () => {
    expect(
      mergeCredentialBlobs([
        { environment: 'production', serverKey: 'fresh' },
        { environment: 'sandbox', serverKey: 'stale' },
      ]),
    ).toEqual({ environment: 'production', serverKey: 'fresh' })
  })

  test('the second blob fills keys the first does not carry', () => {
    expect(
      mergeCredentialBlobs([{ secretKey: 'xnd_development_x' }, { webhookToken: 't' }]),
    ).toEqual({ secretKey: 'xnd_development_x', webhookToken: 't' })
  })

  test('empty values never win and null blobs are skipped', () => {
    expect(
      mergeCredentialBlobs([null, { environment: '' }, undefined, { environment: 'live' }]),
    ).toEqual({ environment: 'live' })
  })
})

describe('splitCredentialsAndConfig', () => {
  test('a provider registry decides which side each field lands on', () => {
    const split = splitCredentialsAndConfig('paypal', {
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'live',
      currency: 'USD',
      webhookId: 'wh-1',
    })
    expect(split.credentials).toEqual({ clientSecret: 'secret' })
    expect(split.config).toEqual({
      clientId: 'id',
      environment: 'live',
      currency: 'USD',
      webhookId: 'wh-1',
    })
  })

  test('an unregistered provider keeps everything as credentials', () => {
    expect(splitCredentialsAndConfig('nope', { apiKey: 'k' })).toEqual({
      credentials: { apiKey: 'k' },
      config: {},
    })
  })
})

describe('resolveCredentialsForSave', () => {
  test('a blank secret keeps the stored value; a non-blank one replaces it', () => {
    expect(
      resolveCredentialsForSave(
        'xendit',
        { secretKey: 'stored', webhookToken: 'wh' },
        { secretKey: '' },
      ),
    ).toEqual({ secretKey: 'stored', webhookToken: 'wh' })
    expect(
      resolveCredentialsForSave('xendit', { secretKey: 'stored' }, { secretKey: 'rotated' }),
    ).toEqual({ secretKey: 'rotated' })
  })

  test('a non-secret blank is an intentional clear', () => {
    expect(
      resolveCredentialsForSave('midtrans', { environment: 'production' }, { environment: '' }),
    ).toEqual({ environment: '' })
  })

  test('secretKeysFor reads the registry', () => {
    expect(secretKeysFor('midtrans').has('serverKey')).toBe(true)
    expect(secretKeysFor('midtrans').has('clientKey')).toBe(false)
  })
})

describe('read*Credentials precedence', () => {
  test('xendit merges the buckets and prefers the credentials blob', () => {
    const result = readXenditCredentials([
      { secretKey: 'xnd_development_x' },
      { webhookToken: 't' },
    ])
    expect(result).toMatchObject({ ok: true })
    expect(
      readXenditCredentials([
        { secretKey: 'xnd_development_fresh' },
        { secretKey: 'xnd_development_stale', webhookToken: 't' },
      ]),
    ).toMatchObject({ ok: true, credentials: { secretKey: 'xnd_development_fresh' } })
  })

  test('midtrans prefers the credentials environment over a stale config one', () => {
    const result = readMidtransCredentials([
      { serverKey: 'SB-Mid-server-x', environment: 'production' },
      { environment: 'sandbox' },
    ])
    expect(result).toMatchObject({ ok: true, credentials: { environment: 'production' } })
  })

  test('paypal prefers the credentials environment over a stale config one', () => {
    const result = readPaypalCredentials([
      { clientId: 'id', clientSecret: 's', environment: 'live' },
      { environment: 'sandbox', currency: 'USD' },
    ])
    expect(result).toMatchObject({
      ok: true,
      credentials: { environment: 'live', currency: 'USD' },
    })
  })
})
