import { describe, expect, test } from 'vitest'

import { getMidtransTransactionStatus, midtransErrorStatus, MidtransApiError } from './client'

/**
 * A stand-in for the SDK's Core API that fails exactly the way
 * `midtrans-client` does for a status read of an unknown order: a
 * `MidtransError` whose `httpStatusCode` is the API body's *string*
 * `status_code`.
 *
 * Injected through `getMidtransTransactionStatus`'s third parameter rather
 * than by mocking the `midtrans-client` module: Bun shares module mocks across
 * every test file in a run, and the whole-module mock this file used to carry
 * leaked into `index.test.ts`, making its Snap-client test depend on file
 * execution order. Nothing here needs the real SDK.
 */
function fakeCoreApi(): {
  transaction: { status: (orderId: string) => Promise<unknown> }
} {
  return {
    transaction: {
      status: async (_orderId: string): Promise<unknown> => {
        const error = new Error(
          'Midtrans API is returning API error. HTTP status code: 404. API response: {...}',
        )
        Object.assign(error, {
          httpStatusCode: '404',
          ApiResponse: { status_code: '404', status_message: "Transaction doesn't exist." },
        })
        throw error
      },
    },
  }
}

describe('midtransErrorStatus', () => {
  test('normalizes both SDK spellings to a number', () => {
    expect(midtransErrorStatus('404')).toBe(404)
    expect(midtransErrorStatus(404)).toBe(404)
    expect(midtransErrorStatus(null)).toBeNull()
    expect(midtransErrorStatus(undefined)).toBeNull()
    expect(midtransErrorStatus('nope')).toBeNull()
  })
})

describe('getMidtransTransactionStatus', () => {
  test('a string 404 wraps as a MidtransApiError(404) the connection test can trust', async () => {
    const credentials = {
      serverKey: 'SB-Mid-server-x',
      clientKey: '',
      merchantId: '',
      environment: 'sandbox' as const,
    }
    const error = await getMidtransTransactionStatus(
      credentials,
      '__paykit-connection-test__',
      fakeCoreApi,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MidtransApiError)
    expect((error as InstanceType<typeof MidtransApiError>).status).toBe(404)
  })
})
