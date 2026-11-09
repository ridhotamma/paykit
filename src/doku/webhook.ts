/**
 * Inbound DOKU notification verification and event shaping.
 *
 * DOKU signs every HTTP notification with the same Non-SNAP scheme it uses
 * for outbound API calls:
 *
 *   Client-Id:{header}
 *   Request-Id:{header}
 *   Request-Timestamp:{header}
 *   Request-Target:{your notification path}
 *   Digest:{base64 SHA-256 of the raw body}
 *
 * HMAC-SHA256 over that string with the project Secret Key, base64 encoded,
 * sent as `Signature: HMACSHA256=…`.
 *
 * The `Request-Target` is the **path of this endpoint** (e.g.
 * `/store/my-shop/doku`), not the DOKU host: the signature is bound to where
 * the notification is delivered. The verifier therefore requires the caller to
 * pass the path the HTTP framework matched.
 *
 * Verification is only the gate. The callback's `transaction.status` is never
 * trusted as the settlement verdict — read the transaction back through the
 * status API before moving money.
 */

import type { DokuTransaction } from './client'
import { parseDokuTransaction } from './client'
import {
  dokuDigest,
  verifyDokuSignature,
  type DokuRawBody,
  type DokuSignatureComponents,
} from './signature'
import { WebhookAuthError } from '../webhook-auth'

/** A source of request headers: `Headers`, a plain object, or a getter. */
export type DokuHeaderSource =
  | Headers
  | Record<string, string | string[] | null | undefined>
  | ((name: string) => string | null | undefined)

/** The four DOKU headers the signature is built from. */
export interface DokuNotificationHeaders {
  clientId: string | null
  requestId: string | null
  requestTimestamp: string | null
  signature: string | null
}

function readHeader(source: DokuHeaderSource, name: string): string | null {
  if (typeof source === 'function') {
    return source(name) ?? source(name.toLowerCase()) ?? null
  }
  if (typeof (source as Headers).get === 'function') {
    return (source as Headers).get(name)
  }
  const record = source as Record<string, string | string[] | null | undefined>
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    if (Array.isArray(value)) return value[0] ?? null
    return value ?? null
  }
  return null
}

/** Pull the four DOKU signature headers out of any request-header source. */
export function dokuNotificationHeaders(source: DokuHeaderSource): DokuNotificationHeaders {
  return {
    clientId: readHeader(source, 'Client-Id'),
    requestId: readHeader(source, 'Request-Id'),
    requestTimestamp: readHeader(source, 'Request-Timestamp'),
    signature: readHeader(source, 'Signature'),
  }
}

/** Raised when the signature is missing, mismatched, or the body is unreadable. */
export class DokuWebhookAuthError extends WebhookAuthError {
  constructor(message = 'DOKU notification signature mismatch.') {
    super(message)
    this.name = 'DokuWebhookAuthError'
  }
}

export interface VerifyDokuNotificationOptions {
  rawBody: DokuRawBody
  headers: DokuHeaderSource
  /**
   * The path DOKU signed — the same path your HTTP framework matched for this
   * endpoint, including a trailing slash only if that is what it reports.
   */
  requestTarget: string
  clientId: string | null | undefined
  secretKey: string | null | undefined
}

/**
 * Authenticate + parse an inbound DOKU notification.
 *
 * Pass the **raw** request body (not a re-serialised object): the digest is
 * taken over the exact bytes DOKU signed. The returned transaction is the
 * wire shape; callers should still read status from the API before settling.
 *
 * @throws `DokuWebhookAuthError` when a header is missing, the client id does
 * not belong to this connection, the signature does not verify, or the body
 * is not a DOKU transaction — the transport layer answers 401.
 */
export async function verifyDokuNotification({
  rawBody,
  headers,
  requestTarget,
  clientId,
  secretKey,
}: VerifyDokuNotificationOptions): Promise<DokuTransaction> {
  if (!clientId?.trim() || !secretKey?.trim()) {
    throw new DokuWebhookAuthError('DOKU credentials are not configured for notification verification.')
  }

  const delivered = dokuNotificationHeaders(headers)
  if (!delivered.clientId || !delivered.requestId || !delivered.requestTimestamp) {
    throw new DokuWebhookAuthError('DOKU notification is missing a signature header.')
  }
  if (!delivered.signature) {
    throw new DokuWebhookAuthError('DOKU notification signature header is missing.')
  }
  if (delivered.clientId.trim() !== clientId.trim()) {
    throw new DokuWebhookAuthError('DOKU notification client id mismatch.')
  }

  const digest = await dokuDigest(rawBody)
  const components: DokuSignatureComponents = {
    clientId: delivered.clientId,
    requestId: delivered.requestId,
    requestTimestamp: delivered.requestTimestamp,
    requestTarget,
    digest,
  }
  const valid = await verifyDokuSignature(components, secretKey, delivered.signature)
  if (!valid) throw new DokuWebhookAuthError('DOKU notification signature mismatch.')

  let decoded: unknown
  try {
    const text =
      typeof rawBody === 'string'
        ? rawBody
        : new TextDecoder().decode(rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody))
    decoded = JSON.parse(text)
  } catch {
    throw new DokuWebhookAuthError('DOKU notification body is not valid JSON.')
  }

  const transaction = parseDokuTransaction(decoded)
  if (!transaction) {
    throw new DokuWebhookAuthError('DOKU notification body is not a transaction.')
  }
  return transaction
}

/** True when the notification reports a completed payment. */
export function isDokuPaidNotification(transaction: DokuTransaction): boolean {
  return transaction.transaction.status.trim().toUpperCase() === 'SUCCESS'
}

/** The merchant invoice number a notification names — the handler's lookup key. */
export function dokuInvoiceNumberFromNotification(transaction: DokuTransaction): string {
  return transaction.order.invoice_number
}
