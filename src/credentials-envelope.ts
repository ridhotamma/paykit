/**
 * Envelope encryption for the `credentials` blob on an `integrations` row.
 *
 * What is stored is a JSON string either way, so no schema change was needed:
 *
 *   - **sealed** (new writes): `{"v":1,"iv":"…","data":"…"}` — the record,
 *     JSON-encoded, encrypted with AES-256-GCM under a deployment key;
 *   - **legacy** (rows written before this existed): the record itself as
 *     plain JSON, e.g. `{"apiKey":"…"}`.
 *
 * `openCredentials` accepts both, so old rows keep working with no migration
 * and turn sealed the next time they are saved. There is deliberately no
 * "migrate everything now" step: sealing happens on the write paths that
 * already exist, which is also the only moment the plaintext is in hand.
 *
 * The key lives in `INTEGRATION_CREDENTIALS_KEY` (64 hex characters, 32
 * bytes) and must be identical in every app that touches these rows — admin
 * seals and opens, webhook and web open, developer seals and opens — because
 * a sealed blob is opaque to anything without it. Reads of legacy rows need
 * no key; anything sealed without one fails closed and loud, never silently
 * empty: an adapter handed `{}` would fail against the provider with a
 * confusing error instead of telling the operator the deployment is
 * misconfigured.
 *
 * WebCrypto rather than `node:crypto`, so importing this module never pulls
 * Node builtins into a browser bundle (same reason as `timing-safe.ts` and
 * `marketplace/core.ts`). Base64 is hand-rolled for the same reason — no
 * `Buffer`.
 */

const ENVELOPE_VERSION = 1

/** The environment variable holding the 32-byte deployment key as 64 hex chars. */
export const CREDENTIALS_KEY_ENV = 'INTEGRATION_CREDENTIALS_KEY'

interface SealedEnvelope {
  v: number
  iv: string
  data: string
}

function subtle(): SubtleCrypto {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto
  if (!cryptoObject?.subtle) {
    throw new Error('WebCrypto is not available in this runtime.')
  }
  return cryptoObject.subtle
}

function readEnv(name: string): string | undefined {
  // `process` does not exist in browsers; this module is only ever *called*
  // server-side, but it must still be *importable* anywhere.
  if (typeof process === 'undefined') return undefined
  return process.env?.[name]
}

/** The deployment key, or a throw that says exactly what to set. */
function readKey(): Uint8Array<ArrayBuffer> {
  const hex = readEnv(CREDENTIALS_KEY_ENV)?.trim() ?? ''
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `${CREDENTIALS_KEY_ENV} must hold 64 hex characters (a 32-byte key). ` +
        'Generate one and set the same value in every app.',
    )
  }
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function importKey(): Promise<CryptoKey> {
  return subtle().importKey('raw', readKey(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A legacy plaintext blob, returned as stored — the same tolerance the old
 * `JSON.parse` readers had, so a hand-edited row opens exactly as before.
 */
function asLegacyRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {}
  return { ...(value as Record<string, string>) }
}

/**
 * Seal a credentials record for storage.
 *
 * Fails closed when the deployment key is missing or malformed: writing an
 * empty or plaintext blob "for now" is how secrets end up at rest unsealed.
 */
export async function sealCredentials(record: Record<string, string>): Promise<string> {
  const key = await importKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = textEncoder.encode(JSON.stringify(record))
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext)

  const envelope: SealedEnvelope = {
    v: ENVELOPE_VERSION,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
  }
  return JSON.stringify(envelope)
}

function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  return (
    envelope.v === ENVELOPE_VERSION &&
    typeof envelope.iv === 'string' &&
    typeof envelope.data === 'string'
  )
}

/**
 * Open a stored `credentials` blob, sealed or legacy.
 *
 * Legacy plaintext parses with no key, exactly as before. A sealed blob
 * without a usable key throws rather than returning `{}`: silently empty
 * credentials would fail later inside a provider SDK with no hint that the
 * deployment key is what is actually missing.
 */
export async function openCredentials(
  stored: string | null | undefined,
): Promise<Record<string, string>> {
  if (!stored) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return {}
  }

  if (!isSealedEnvelope(parsed)) return asLegacyRecord(parsed)

  let plaintext: ArrayBuffer
  try {
    const key = await importKey()
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(parsed.iv) },
      key,
      fromBase64(parsed.data),
    )
  } catch (error) {
    throw new Error(
      `Could not open sealed credentials: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    return asLegacyRecord(JSON.parse(textDecoder.decode(plaintext)))
  } catch {
    return {}
  }
}
