/**
 * DOKU's Non-SNAP signature — the scheme used by DOKU Checkout requests and
 * the callbacks it sends back.
 *
 * The signed string is one component per line, in this order:
 *
 *   Client-Id:{clientId}
 *   Request-Id:{requestId}
 *   Request-Timestamp:{timestamp}
 *   Request-Target:{path}
 *   Digest:{base64(SHA-256(rawBody))}   ← POST only
 *
 * `HMAC-SHA256` over those bytes with the project's Secret Key, base64
 * encoded, and prefixed with `HMACSHA256=` in the header. There is no JSON
 * canonicalisation to get wrong: the digest is computed over the exact body
 * bytes and everything else is the header values themselves.
 *
 * Web Crypto is used instead of `node:crypto` so this module never pulls a
 * Node builtin into a bundle; the server runtimes PayKit targets all expose
 * `crypto.subtle` and `btoa`.
 */

import { timingSafeEqual } from '../timing-safe'

/** The header DOKU puts the signature in, for both requests and callbacks. */
export const DOKU_SIGNATURE_HEADER = 'signature'

/** The headers that make up a signed request/notification. */
export interface DokuSignatureComponents {
  clientId: string
  requestId: string
  requestTimestamp: string
  /** The endpoint path, e.g. `/checkout/v1/payment` or your notification path. */
  requestTarget: string
  /** Base64 SHA-256 of the raw body; omitted for GET requests. */
  digest?: string
}

/** The raw body shapes a host may hand over. */
export type DokuRawBody = string | Uint8Array | ArrayBuffer

function rawBodyBytes(rawBody: DokuRawBody): Uint8Array<ArrayBuffer> {
  if (typeof rawBody === 'string') return new TextEncoder().encode(rawBody)
  // Copy into a fresh ArrayBuffer-backed view: Web Crypto's BufferSource type
  // rejects a view whose buffer could be a SharedArrayBuffer.
  if (rawBody instanceof Uint8Array) return new Uint8Array(rawBody)
  return new Uint8Array(rawBody)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return globalThis.btoa(binary)
}

/** Base64 SHA-256 of the raw body — the `Digest` component for POST requests. */
export async function dokuDigest(rawBody: DokuRawBody): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', rawBodyBytes(rawBody))
  return bytesToBase64(new Uint8Array(hash))
}

/** The newline-separated string DOKU signs, without a trailing newline. */
export function dokuSignatureString(components: DokuSignatureComponents): string {
  const lines = [
    `Client-Id:${components.clientId}`,
    `Request-Id:${components.requestId}`,
    `Request-Timestamp:${components.requestTimestamp}`,
    `Request-Target:${components.requestTarget}`,
  ]
  if (components.digest !== undefined) lines.push(`Digest:${components.digest}`)
  return lines.join('\n')
}

async function hmacSha256Base64(secretKey: string, input: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(input),
  )
  return bytesToBase64(new Uint8Array(signature))
}

/** The complete `Signature` header value, e.g. `HMACSHA256=…=`. */
export async function dokuSignatureHeader(
  components: DokuSignatureComponents,
  secretKey: string,
): Promise<string> {
  const encoded = await hmacSha256Base64(secretKey, dokuSignatureString(components))
  return `HMACSHA256=${encoded}`
}

function normalizeSignature(value: string): string {
  return value
    .trim()
    .replace(/^hmacsha256=/i, '')
}

/**
 * Verify a delivered `Signature` header against the components DOKU signed.
 *
 * The comparison is constant-time and ignores case/whitespace in the
 * `HMACSHA256=` prefix. A missing key or a mismatched signature returns
 * `false`; callers turn that into a 401.
 */
export async function verifyDokuSignature(
  components: DokuSignatureComponents,
  secretKey: string | null | undefined,
  deliveredSignature: string | null | undefined,
): Promise<boolean> {
  if (!secretKey || !deliveredSignature?.trim()) return false
  const expected = await hmacSha256Base64(secretKey, dokuSignatureString(components))
  return timingSafeEqual(expected, normalizeSignature(deliveredSignature))
}

/**
 * The `Request-Timestamp` DOKU wants: UTC ISO 8601 without milliseconds.
 * DOKU rejects a stale-looking timestamp, so this is generated per request.
 */
export function dokuRequestTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
