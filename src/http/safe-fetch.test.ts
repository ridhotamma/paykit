/**
 * Destination checks for `safeFetch`. Only IP literals are used so the tests
 * never touch DNS; the allowlist check also short-circuits before lookup.
 */

import { describe, expect, test } from 'vitest'

import { assertPublicHttpUrl, isPrivateAddress, safeFetch, UnsafeUrlError } from './safe-fetch'

describe('isPrivateAddress', () => {
  test('blocks loopback, link-local, private and metadata ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '192.0.0.1',
      '198.18.0.1',
      '203.0.113.9',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateAddress(address)).toBe(true)
    }
  })

  test('allows public IPv4 addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '104.18.0.1', '172.32.0.1']) {
      expect(isPrivateAddress(address)).toBe(false)
    }
  })

  test('blocks IPv6 loopback, ULA, link-local, multicast and mapped IPv4', () => {
    for (const address of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
    ]) {
      expect(isPrivateAddress(address)).toBe(true)
    }
  })

  test('allows public IPv6 addresses', () => {
    for (const address of ['2001:4860:4860::8888', '2606:4700::1111']) {
      expect(isPrivateAddress(address)).toBe(false)
    }
  })
})

describe('assertPublicHttpUrl', () => {
  test('refuses non-http(s) protocols', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(assertPublicHttpUrl('ftp://example.com/x')).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  test('refuses private IP literals without DNS', async () => {
    await expect(
      assertPublicHttpUrl('http://169.254.169.254/latest/meta-data'),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(assertPublicHttpUrl('http://127.0.0.1:8080/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    )
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  test('enforces the host allowlist before any lookup', async () => {
    await expect(
      assertPublicHttpUrl('https://evil.example/x', { allowedHosts: ['good.example'] }),
    ).rejects.toBeInstanceOf(UnsafeUrlError)

    const allowed = await assertPublicHttpUrl('https://8.8.8.8/x', { allowedHosts: ['8.8.8.8'] })
    expect(allowed.hostname).toBe('8.8.8.8')
  })
})

describe('safeFetch', () => {
  test('forwards the request init (method, headers, body) to fetch', async () => {
    const seen: RequestInit[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    try {
      // An IP literal keeps the destination check off DNS and the stub keeps
      // the test off the network.
      const response = await safeFetch('https://8.8.8.8/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      })
      expect(response.status).toBe(200)
    } finally {
      globalThis.fetch = original
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.body).toBe('{"hello":"world"}')
    expect(new Headers(seen[0]?.headers).get('content-type')).toBe('application/json')
    expect(seen[0]?.redirect).toBe('manual')
  })
})
