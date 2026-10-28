import { afterEach, describe, expect, test } from 'vitest'

import { CREDENTIALS_KEY_ENV, openCredentials, sealCredentials } from './credentials-envelope'

const TEST_KEY = '0123456789abcdef'.repeat(4)

describe('credentials envelope', () => {
  const previous = process.env[CREDENTIALS_KEY_ENV]

  afterEach(() => {
    if (previous === undefined) delete process.env[CREDENTIALS_KEY_ENV]
    else process.env[CREDENTIALS_KEY_ENV] = previous
  })

  test('round-trips a record', async () => {
    process.env[CREDENTIALS_KEY_ENV] = TEST_KEY
    const record = { apiKey: 'secret-1', merchantCode: 'M-2', empty: '' }
    const sealed = await sealCredentials(record)
    expect(sealed).not.toContain('secret-1')
    expect(await openCredentials(sealed)).toEqual(record)
  })

  test('every seal uses a fresh IV', async () => {
    process.env[CREDENTIALS_KEY_ENV] = TEST_KEY
    const first = await sealCredentials({ a: '1' })
    const second = await sealCredentials({ a: '1' })
    expect(first).not.toBe(second)
  })

  test('legacy plaintext still opens with no key set', async () => {
    delete process.env[CREDENTIALS_KEY_ENV]
    expect(await openCredentials('{"apiKey":"abc"}')).toEqual({ apiKey: 'abc' })
    expect(await openCredentials('{}')).toEqual({})
    expect(await openCredentials(null)).toEqual({})
    expect(await openCredentials('not json')).toEqual({})
  })

  test('sealing fails closed without a key', async () => {
    delete process.env[CREDENTIALS_KEY_ENV]
    await expect(sealCredentials({ a: '1' })).rejects.toThrow(CREDENTIALS_KEY_ENV)
  })

  test('opening sealed data fails closed without a key', async () => {
    process.env[CREDENTIALS_KEY_ENV] = TEST_KEY
    const sealed = await sealCredentials({ a: '1' })
    delete process.env[CREDENTIALS_KEY_ENV]
    await expect(openCredentials(sealed)).rejects.toThrow()
  })

  test('tampered blobs do not open', async () => {
    process.env[CREDENTIALS_KEY_ENV] = TEST_KEY
    const sealed = await sealCredentials({ a: '1' })
    const tampered = JSON.parse(sealed) as { data: string }
    tampered.data = `${tampered.data.slice(0, -4)}AAAA`
    await expect(openCredentials(JSON.stringify(tampered))).rejects.toThrow()
  })

  test('a wrong key does not open', async () => {
    process.env[CREDENTIALS_KEY_ENV] = TEST_KEY
    const sealed = await sealCredentials({ a: '1' })
    process.env[CREDENTIALS_KEY_ENV] = 'fedcba9876543210'.repeat(4)
    await expect(openCredentials(sealed)).rejects.toThrow()
  })
})
