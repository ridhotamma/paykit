/**
 * Core types for the integrations package.
 *
 * These types describe the provider metadata, credential fields and
 * configuration shapes shared across all apps. They intentionally mirror the
 * Appwrite document types but are decoupled from the SDK — no `Models.Document`
 * inheritance here, because the package is consumed on both server and client.
 */

/**
 * Every integration this package ships is a payment gateway, so the category
 * is a single-member union — it keeps `ProviderDefinition` shape-compatible
 * with hosts that model several categories without widening what it may hold.
 */
export type IntegrationCategory = 'payment'

/** The payment gateways this package supports. */
export type IntegrationProvider =
  | 'tripay'
  | 'duitku'
  | 'mayar'
  | 'midtrans'
  | 'xendit'
  | 'paypal'

/** The lifecycle state of a connection — not the provider itself. */
export type ConnectionStatus = 'connected' | 'disconnected' | 'error'

/**
 * One field on the credential form.
 *
 * Each provider declares which fields it needs; the admin UI renders them
 * dynamically. `secret` fields are masked in the UI and sealed at rest with
 * the AES-GCM envelope in `./credentials-envelope`.
 */
export interface CredentialField {
  /** Machine key — also the JSON property name stored in `credentials`. */
  key: string
  /** Human-readable label shown above the input. */
  label: string
  /** Placeholder text inside the input. */
  placeholder?: string
  /** One short line shown below the input — what the value is. */
  hint?: string
  /**
   * Setup guidance shown below the hint as a bulleted list, one step or note
   * per entry — where to find the value, what to paste where. Kept as a list
   * rather than one long hint so a multi-step instruction stays readable.
   */
  guide?: readonly string[]
  /** `password` renders a masked input with a show/hide toggle. `select` renders a native select. */
  type?: 'text' | 'password' | 'select'
  /** Options for `type: 'select'` fields. */
  options?: { value: string; label: string }[]
  /** Whether this field must be filled before saving. */
  required?: boolean
}

/**
 * Static metadata about a provider — does not change per tenant.
 *
 * An admin integrations page reads this to render cards; the package itself
 * uses it to build credential schemas from the declared fields.
 */
export interface ProviderDefinition {
  id: IntegrationProvider
  category: IntegrationCategory
  /** Human-readable name, also the i18n key under `integrations.providers.*`. */
  name: string
  /** One-line description, also the i18n key. */
  description: string
  /** Path to the logo served from `public/logos`, or `undefined` for icon-font. */
  logo?: string
  /** Brand colour for the icon-font fallback. */
  brandColor?: string
  /**
   * Which fields the credential form shows.
   *
   * Empty for a marketplace, and that is the design: Shopee and TikTok Shop
   * only answer requests signed by a registered app, but that app is the
   * platform's — held in environment variables, never typed into a form — so a
   * seller has nothing to enter and authorises over OAuth instead.
   */
  credentialFields: CredentialField[]
  /** External URL where the user can sign up or get API keys. */
  signupUrl?: string
  /** External URL to the provider's API documentation. */
  docsUrl?: string
}

/**
 * The shape of a stored connection — what the `integrations` collection holds,
 * but with `credentials` and `config` parsed from JSON strings.
 */
export interface IntegrationConnection {
  id: string
  tenantId: string
  provider: IntegrationProvider
  category: IntegrationCategory
  status: ConnectionStatus
  credentials: Record<string, string>
  config: Record<string, string>
  isDefault: boolean
  acceptedTermsAt: string | null
  connectedAt: string | null
  lastSyncAt: string | null
}

/** The summary shape shown in lists and cards. */
export interface IntegrationSummary {
  id: string
  provider: IntegrationProvider
  category: IntegrationCategory
  status: ConnectionStatus
  isDefault: boolean
  connectedAt: string | null
}
