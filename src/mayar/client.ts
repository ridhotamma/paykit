/**
 * Mayar client factory — the one place that turns a shop's stored
 * credentials into a live API client.
 *
 * Server-only by contract: the API key moves money and must never reach a
 * browser bundle. That is why this module lives behind the
 * `@repo/integrations/mayar` subpath and is never re-exported from the main
 * barrel — the admin UI imports the registry from `.`, servers import the
 * logic from `./mayar`.
 *
 * Everything here wraps `mayar-node-sdk` (API V2 — V1 is deprecated on
 * 1 October 2026) and nothing else: no Appwrite, no request/response types,
 * so the webhook app stays a thin I/O shell around these functions.
 */

import { Mayar, MayarError } from 'mayar-node-sdk'

import { z } from 'zod'

import { mergeCredentialBlobs } from '../credentials'

export { MayarError }

export function describeMayarError(error: unknown): string {
  if (error instanceof MayarError) {
    return `Mayar error (${error.status}): ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

/** Which Mayar deployment a key belongs to. */
export type MayarEnvironment = 'production' | 'sandbox'

export const MAYAR_ENVIRONMENTS = ['production', 'sandbox'] as const

/**
 * The secrets and settings one shop's Mayar connection needs.
 *
 * `apiKey` comes from web.mayar.id/api-keys (Read & Write — read-only keys
 * answer 401 to every charge). `webhookSecret` is the account's callback
 * token from Integration → Webhook. `environment` selects the API host and
 * must match the account the keys belong to — a production key verified
 * against `api.mayar.io` fails with 401, so an unset value falls back to
 * `production` rather than to a guess.
 */
export const mayarCredentialsSchema = z.object({
  apiKey: z.string().trim().min(1, 'Mayar API Key is required.'),
  webhookSecret: z.string().trim().min(1, 'Mayar webhook callback token is required.'),
  environment: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value === '' ? 'production' : value))
    .pipe(z.enum(MAYAR_ENVIRONMENTS))
    .default('production'),
})

export type MayarCredentials = z.infer<typeof mayarCredentialsSchema>

export type MayarCredentialsResult =
  { ok: true; credentials: MayarCredentials } | { ok: false; error: string }

/**
 * Read a shop's Mayar credentials out of its stored JSON blobs.
 *
 * A connection stores two JSON strings — `credentials` (the sealed secrets)
 * and `config` (the non-secrets) — so both are merged before validation, with
 * the credentials blob authoritative for any key it carries (see
 * `mergeCredentialBlobs`). Returns `ok: false` with a seller-readable reason
 * when the apiKey or webhookSecret is missing or `environment` is not a known
 * value; a half-configured connection must fail loudly, not silently call the
 * wrong deployment.
 */
export function readMayarCredentials(
  blobs: ReadonlyArray<Record<string, string | undefined> | null | undefined>,
): MayarCredentialsResult {
  const merged = mergeCredentialBlobs(blobs)

  const parsed = mayarCredentialsSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `Mayar credentials are not configured correctly (${problems}).` }
  }

  return { ok: true, credentials: parsed.data }
}

/** The SDK client for one shop's Mayar account. Cheap to build per request. */
export function createMayarClient(credentials: MayarCredentials): Mayar {
  return new Mayar({
    apiKey: credentials.apiKey,
    environment: credentials.environment,
    timeoutMs: 15_000,
    maxRetries: 2,
  })
}
