/**
 * Outbound HTTP with the destination checked.
 *
 * Every request whose URL is not a compile-time constant should go through
 * here. Plain `fetch` will happily connect to `127.0.0.1`,
 * `169.254.169.254` or an RFC1918 address, so a URL that a user — a WhatsApp
 * sender, a shop admin, a marketplace payload — can influence turns the
 * server into a proxy onto its own network. This module:
 *
 *   - refuses anything that is not `http(s)`;
 *   - resolves the hostname and refuses private, loopback, link-local,
 *     multicast and reserved addresses (IPv4 and IPv6, including
 *     IPv4-mapped and NAT64 forms);
 *   - follows redirects manually, re-checking every hop, so a public URL
 *     cannot 302 the request into the internal network;
 *   - optionally pins the request to an explicit host allowlist.
 *
 * Server-only: it imports `node:dns` and must never reach the browser bundle.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError'
}

/** Refuse the request rather than follow more than this many redirects. */
const DEFAULT_MAX_REDIRECTS = 3

/** The IPv4 ranges that must never be reachable from a user-supplied URL. */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return true
  const a = Number(parts[0])
  const b = Number(parts[1])
  const c = Number(parts[2])
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    a < 0 ||
    a > 255 ||
    b < 0 ||
    b > 255 ||
    c < 0 ||
    c > 255
  ) {
    return true
  }

  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0) return true
  if (a === 192 && b === 88 && c === 99) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  // Multicast, reserved and the limited broadcast address.
  if (a >= 224) return true
  return false
}

/** Expand `::` so each IPv6 address is exactly eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  const bare = address.split('%')[0]!.toLowerCase()
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const groups: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      groups.push(parseInt(group, 16))
    }
    return groups
  }

  const [head = '', tail = ''] = bare.split('::')
  const headGroups = parse(head)
  const tailGroups = parse(tail)
  if (!headGroups || !tailGroups) return null

  if (!bare.includes('::')) {
    return headGroups.length === 8 ? headGroups : null
  }

  const fill = 8 - headGroups.length - tailGroups.length
  if (fill < 0) return null
  return [...headGroups, ...Array<number>(fill).fill(0), ...tailGroups]
}

function isPrivateIpv6(address: string): boolean {
  const bare = address.split('%')[0]!.toLowerCase()

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)
  if (mapped) return isPrivateIpv4(mapped[1]!)

  if (bare === '::1' || bare === '::') return true

  const groups = expandIpv6(bare)
  if (!groups) return true

  const first = groups[0]!
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  if ((first & 0xff00) === 0xff00) return true
  if (first === 0x2001 && groups[1] === 0x0db8) return true

  // NAT64 (`64:ff9b::/96`): the embedded IPv4 decides.
  if (first === 0x0064 && groups[1] === 0xff9b) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`
    return isPrivateIpv4(v4)
  }

  return false
}

/** Whether an IP literal names a network the server must not be asked to reach. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPrivateIpv4(address)
  if (version === 6) return isPrivateIpv6(address)
  return true
}

export interface SafeUrlOptions {
  /**
   * When set, only these hostnames may be fetched. Matching is exact and
   * case-insensitive; a hostname not on the list is refused before DNS runs.
   */
  allowedHosts?: readonly string[]
}

/**
 * Validate one URL, resolving its hostname when it is a name rather than an
 * IP literal. Throws {@link UnsafeUrlError} with a short reason when the URL
 * must not be fetched.
 */
export async function assertPublicHttpUrl(
  input: string | URL,
  options: SafeUrlOptions = {},
): Promise<URL> {
  let url: URL
  try {
    url = input instanceof URL ? input : new URL(input)
  } catch {
    throw new UnsafeUrlError('not a URL')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeUrlError(`unsupported protocol ${url.protocol}`)
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname) throw new UnsafeUrlError('missing host')

  if (
    options.allowedHosts &&
    !options.allowedHosts.some((host) => host.toLowerCase() === hostname)
  ) {
    throw new UnsafeUrlError(`host ${hostname} is not allowed`)
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new UnsafeUrlError(`address ${hostname} is private`)
    return url
  }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new UnsafeUrlError(`could not resolve ${hostname}`)
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`could not resolve ${hostname}`)

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeUrlError(`${hostname} resolves to private address ${address}`)
    }
  }

  return url
}

export interface SafeFetchOptions extends SafeUrlOptions, RequestInit {
  maxRedirects?: number
}

/**
 * `fetch`, but every URL — the first and each redirect target — is validated
 * with {@link assertPublicHttpUrl} before it is requested.
 */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const { allowedHosts, maxRedirects = DEFAULT_MAX_REDIRECTS, ...optionsInit } = options

  // Both the positional `init` and the fetch fields of `options` are honoured:
  // callers pass fetch options either way, and dropping them silently turned a
  // POST with a body into an empty GET.
  const headers = new Headers(optionsInit.headers)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const requestInit: RequestInit = { ...optionsInit, ...init, headers }

  let current = await assertPublicHttpUrl(input, { allowedHosts })
  let method = (requestInit.method ?? 'GET').toUpperCase()
  let body = requestInit.body

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(current, { ...requestInit, method, body, redirect: 'manual' })

    const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
    const location = response.headers.get('location')
    if (!isRedirect || !location) return response

    if (redirects >= maxRedirects) {
      throw new UnsafeUrlError(`too many redirects (last: ${current.hostname})`)
    }

    const next = new URL(location, current)
    current = await assertPublicHttpUrl(next, { allowedHosts })

    // Mirror fetch's method rules: 303 always becomes GET, and a 301/302 on a
    // POST follows the historical browser behaviour of becoming a GET.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET'
      body = undefined
    }
  }
}
