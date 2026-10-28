/**
 * Constant-time comparison for secrets and tokens.
 *
 * Avoids static `node:crypto` imports that break browser bundles when Vite
 * externalizes Node builtins in client-rendered integration pages.
 */
export function timingSafeEqual(
  a: Uint8Array | ArrayBuffer | string,
  b: Uint8Array | ArrayBuffer | string,
): boolean {
  const bufA = typeof a === 'string' ? new TextEncoder().encode(a) : new Uint8Array(a)
  const bufB = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b)

  if (bufA.byteLength !== bufB.byteLength) {
    return false
  }

  let mismatch = 0
  for (let i = 0; i < bufA.byteLength; i++) {
    mismatch |= bufA[i]! ^ bufB[i]!
  }

  return mismatch === 0
}
