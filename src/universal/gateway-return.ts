/**
 * The universal gateway-return contract — what a payment provider appends to
 * the return URL when it sends the buyer/seller back, normalised once.
 *
 * Each provider speaks its own dialect on the way back, and only Duitku's is
 * a real verdict:
 *
 * - **Duitku** appends `merchantOrderId` (our order/invoice number),
 *   `resultCode` (`00` paid, `01` pending, `02` cancelled) and `reference`.
 * - **Tripay** accepts `return_url` on the transaction but documents no
 *   appended verdict params — the buyer simply lands back on the URL.
 * - **Mayar** accepts `redirectUrl` on invoices and payment links but likewise
 *   documents no appended verdict params.
 * - **Midtrans** sends the buyer to the Snap `callbacks.finish` URL with
 *   `order_id`, `status_code` and `transaction_status` appended, and
 *   **Xendit** to the invoice `success_redirect_url` — but neither is
 *   trusted for state either.
 *
 * So the pages never trust provider params for state — the webhook is what
 * settles money — and only use the parsed return for copy (which dialog, if
 * any) plus URL cleanup. Anything a page needs to correlate (our order
 * number, the provider) travels in params *we* embed at charge time via
 * `buildReturnUrl`, which every provider echoes back untouched as part of the
 * URL.
 */

export type GatewayReturnVerdict = 'paid' | 'pending' | 'failed'

export interface GatewayReturn {
  /** The provider, from our embedded `provider` param or inferred; `null` when unknown. */
  provider: string | null
  /** Our order/invoice number: our `order` param first, then Duitku's `merchantOrderId`. */
  orderRef: string | null
  /** Duitku's `resultCode` normalised. Tripay/Mayar append no verdict, so `null` for them. */
  verdict: GatewayReturnVerdict | null
  /** Duitku's `reference`, or `null`. */
  reference: string | null
}

/**
 * Query keys that belong to a gateway return and are never ours to keep.
 *
 * `merchantOrderId` / `resultCode` / `reference` are provider-appended
 * (Duitku); `provider` is embedded by `buildReturnUrl` at charge time so the
 * landing page can attribute the return. `order` is the one param that stays,
 * because the storefront confirmation loader reads it.
 */
export const GATEWAY_APPENDED_PARAMS = [
  'merchantOrderId',
  'resultCode',
  'reference',
  'provider',
] as const

export type GatewayQuery = Record<string, string | string[] | undefined | null>

function first(value: string | string[] | undefined | null): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** Read a gateway return out of a parsed query (router search, `Object.fromEntries`, …). */
export function parseGatewayReturn(query: GatewayQuery): GatewayReturn {
  const embeddedProvider = first(query.provider)
  const merchantOrderId = first(query.merchantOrderId)
  const resultCode = first(query.resultCode)

  const provider =
    embeddedProvider ?? (merchantOrderId !== null || resultCode !== null ? 'duitku' : null)

  return {
    provider,
    orderRef: first(query.order) ?? merchantOrderId,
    verdict:
      provider === 'duitku'
        ? resultCode === '00'
          ? 'paid'
          : resultCode === '01'
            ? 'pending'
            : resultCode === '02'
              ? 'failed'
              : null
        : null,
    reference: first(query.reference),
  }
}

/** Whether the query carries any provider-appended return params at all. */
export function hasGatewayReturn(query: GatewayQuery): boolean {
  return GATEWAY_APPENDED_PARAMS.some((key) => first(query[key]) !== null)
}

/**
 * Strip provider-appended params from a raw search string, keeping everything
 * else (`order`, `provider`, `tab`, …) untouched.
 *
 * Takes the `?…` string (with or without the leading `?`) and hands back the
 * cleaned one, `''` when nothing remains — ready for `history.replaceState`.
 */
export function stripGatewayReturnParams(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  let touched = false
  for (const key of GATEWAY_APPENDED_PARAMS) {
    if (params.has(key)) {
      params.delete(key)
      touched = true
    }
  }
  if (!touched) return search
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}

/**
 * Build the return URL handed to a gateway at charge time.
 *
 * Embeds our own stable params so the landing page can correlate the return
 * no matter which provider sent the buyer back — including Tripay and Mayar,
 * which append nothing of their own.
 */
export function buildReturnUrl(
  base: string,
  params: {
    provider?: string | null
    order?: string | null
    /** The order's access token (`t`): the order page reads the order with it. */
    token?: string | null
  },
): string {
  try {
    const url = new URL(base)
    if (params.provider) url.searchParams.set('provider', params.provider)
    if (params.order) url.searchParams.set('order', params.order)
    if (params.token) url.searchParams.set('t', params.token)
    return url.toString()
  } catch {
    // Relative base — append by hand rather than refuse.
    const extra = new URLSearchParams()
    if (params.provider) extra.set('provider', params.provider)
    if (params.order) extra.set('order', params.order)
    if (params.token) extra.set('t', params.token)
    const query = extra.toString()
    if (!query) return base
    return `${base}${base.includes('?') ? '&' : '?'}${query}`
  }
}
