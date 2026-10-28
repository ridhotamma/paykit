/**
 * Credential field handling — the single place every provider's stored
 * credentials are merged, split and resolved.
 *
 * Each provider gets a Zod schema built from its `credentialFields` entry in
 * the registry. The admin config form validates against this before sending
 * the payload to the server, and the server function validates again before
 * writing.
 *
 * Credentials are stored as a JSON string in the `credentials` attribute of
 * the `integrations` collection. The `config` attribute holds non-secret
 * settings (callback URLs, environment, currency, …) as a separate JSON
 * string. The registry's `type: 'password'` marker decides which side a field
 * belongs on, so the split is one rule shared by every reader and writer.
 */

import { z } from 'zod'

import { PROVIDER_REGISTRY } from './providers/registry'

/** One stored JSON blob — the sealed `credentials` or the plaintext `config`. */
export type CredentialBlob = Record<string, string | undefined | null> | null | undefined

/**
 * Build a Zod schema for a provider's credentials from its declared fields.
 *
 * Every field is optional at the schema level (the form marks `required` fields
 * with its own validation), so a partial save is possible — the server
 * function can reject if it wants stricter enforcement.
 */
function buildCredentialSchema(providerId: string) {
  const provider = PROVIDER_REGISTRY[providerId]
  if (!provider) return z.record(z.string(), z.string())

  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of provider.credentialFields) {
    shape[field.key] = z.string().trim()
  }
  return z.object(shape)
}

/** The schema for a connection create/update request. */
export const connectIntegrationSchema = z.object({
  provider: z.string().min(1),
  credentials: z.record(z.string(), z.string()),
  config: z.record(z.string(), z.string()).optional().default({}),
  acceptedTerms: z.literal(true, {
    message: 'You must accept the terms and conditions.',
  }),
})

export type ConnectIntegrationValues = z.infer<typeof connectIntegrationSchema>

/**
 * Validate credentials for a specific provider.
 *
 * Returns a flat record of field key → error message, or an empty object if
 * valid. The admin form uses this for per-field feedback.
 */
export function validateCredentials(
  providerId: string,
  credentials: Record<string, string>,
): Record<string, string> {
  const schema = buildCredentialSchema(providerId)
  const result = schema.safeParse(credentials)
  if (result.success) return {}

  const errors: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const key = issue.path[0]
    if (typeof key === 'string') {
      errors[key] = issue.message
    }
  }
  return errors
}

/**
 * Merge stored blobs into one flat field map.
 *
 * **First hit wins.** Callers pass the sealed `credentials` blob first and the
 * plaintext `config` second, so a value the seller typed into the credential
 * form can never be shadowed by a stale copy left in `config` by an older
 * save. `config` still fills every key the credentials blob does not carry,
 * which keeps rows written under the old "everything in credentials" (or
 * "non-secrets in config") layouts readable either way.
 *
 * Empty strings are skipped: a cleared secret falls through to the other blob
 * instead of winning with `''`.
 */
export function mergeCredentialBlobs(blobs: ReadonlyArray<CredentialBlob>): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const blob of blobs) {
    if (!blob) continue
    for (const [key, value] of Object.entries(blob)) {
      if (typeof value !== 'string' || value === '') continue
      if (key in merged) continue
      merged[key] = value
    }
  }
  return merged
}

/**
 * Separate credentials (secrets) from config (non-secrets).
 *
 * The provider registry marks fields with `type: 'password'` as secrets.
 * Everything else goes into config. This split decides what the server seals
 * with the AES-GCM envelope (`./credentials-envelope`) and what stays
 * readable for debugging.
 */
export function splitCredentialsAndConfig(
  providerId: string,
  values: Record<string, string>,
): { credentials: Record<string, string>; config: Record<string, string> } {
  const provider = PROVIDER_REGISTRY[providerId]
  if (!provider) return { credentials: values, config: {} }

  const secretKeys = secretKeysFor(providerId)

  const credentials: Record<string, string> = {}
  const config: Record<string, string> = {}

  for (const [key, value] of Object.entries(values)) {
    if (secretKeys.has(key)) {
      credentials[key] = value
    } else {
      config[key] = value
    }
  }

  return { credentials, config }
}

/** Keys the registry marks `type: 'password'` for this provider. */
export function secretKeysFor(providerId: string): Set<string> {
  const provider = PROVIDER_REGISTRY[providerId]
  if (!provider) return new Set()
  return new Set(provider.credentialFields.filter((f) => f.type === 'password').map((f) => f.key))
}

/**
 * Merge write-only form input over stored fields.
 *
 * Rule: a blank secret means "keep the stored value" (the browser never saw
 * it, so it cannot send it back). A non-blank secret replaces it.
 * Non-secret fields are taken from the form as-is — the form always renders
 * their real values, so blank there is an intentional clear.
 *
 * `stored` is the merged view of both blobs (see `mergeCredentialBlobs`);
 * `incoming` is the flat form input. Pass the result through
 * `splitCredentialsAndConfig` before writing.
 */
export function resolveCredentialsForSave(
  providerId: string,
  stored: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const secrets = secretKeysFor(providerId)
  const merged: Record<string, string> = { ...stored }
  for (const [key, value] of Object.entries(incoming)) {
    if (secrets.has(key)) {
      const next = value.trim()
      if (next !== '') merged[key] = next
      else if (!(key in merged)) merged[key] = ''
    } else {
      merged[key] = value
    }
  }
  return merged
}
