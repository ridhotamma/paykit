/**
 * The money rules behind the Duitku, Tripay and Mayar callbacks: given an
 * order and a verified callback, what — if anything — the ledger becomes.
 *
 * The three planners are separate functions with the same contract, so the
 * same table runs against each: a callback replayed, a callback that is not a
 * payment, a payment for an order that cannot take one, a partial payment, an
 * overpayment. Midtrans, Xendit and PayPal have their own suites beside their
 * adapters.
 */

import { describe, expect, test } from 'vitest'

import { planOrderPaymentUpdate } from './duitku/payment'
import { planMayarPaymentUpdate } from './mayar/payment'
import { planTripayPaymentUpdate } from './tripay/payment'

interface Order {
  status: 'draft' | 'pending' | 'paid' | 'processing' | 'cancelled' | 'refunded'
  paymentStatus: 'unpaid' | 'partial' | 'paid'
  amountPaid: number
  grandTotal: number
  paymentReference?: string | null
  paidAt?: string | null
  paymentMethod?: string | null
}

/** One planner, adapted to a common call: (order, reference, amount, paid?) → plan. */
interface Planner {
  name: string
  plan: (
    order: Order,
    input: { reference: string; amount: number; paid?: boolean },
    now: Date,
  ) => ReturnType<typeof planOrderPaymentUpdate>
}

const PLANNERS: Planner[] = [
  {
    name: 'duitku',
    plan: (order, { reference, amount, paid = true }, now) =>
      planOrderPaymentUpdate(
        order as never,
        { reference, amount, resultCode: paid ? '00' : '01', paymentCode: null },
        now,
      ),
  },
  {
    name: 'tripay',
    plan: (order, { reference, amount, paid = true }, now) =>
      planTripayPaymentUpdate(
        order as never,
        {
          reference,
          merchantRef: 'INV-20261005-ABCDE',
          amount,
          status: paid ? 'PAID' : 'EXPIRED',
          paymentMethod: null,
          paidAt: null,
        },
        now,
      ),
  },
  {
    name: 'mayar',
    plan: (order, { reference, amount, paid = true }, now) =>
      planMayarPaymentUpdate(
        order as never,
        { id: reference, amount, status: paid ? 'paid' : 'unpaid', paymentMethod: null },
        now,
      ),
  },
]

const NOW = new Date('2026-10-05T03:00:00.000Z')

function unpaid(overrides: Partial<Order> = {}): Order {
  return {
    status: 'pending',
    paymentStatus: 'unpaid',
    amountPaid: 0,
    grandTotal: 150_000,
    paymentReference: null,
    paidAt: null,
    paymentMethod: null,
    ...overrides,
  }
}

for (const planner of PLANNERS) {
  describe(`${planner.name} payment planner`, () => {
    test('a full payment settles the order and moves pending to paid', () => {
      const plan = planner.plan(unpaid(), { reference: 'REF-1', amount: 150_000 }, NOW)
      expect(plan).toMatchObject({
        action: 'apply',
        amountPaid: 150_000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        paymentReference: 'REF-1',
      })
      if (plan.action === 'apply') expect(plan.paidAt).toBe(NOW.toISOString())
    })

    test('a replayed callback with the recorded reference writes nothing', () => {
      const settled = unpaid({
        status: 'paid',
        paymentStatus: 'paid',
        amountPaid: 150_000,
        paymentReference: 'REF-1',
      })
      expect(planner.plan(settled, { reference: 'REF-1', amount: 150_000 }, NOW)).toEqual({
        action: 'noop',
        reason: 'already_recorded',
      })
    })

    test('a reference stamped at charge time is not mistaken for a settlement', () => {
      // Checkout records the gateway reference before any money moves, so the
      // first real callback carries a reference the order already holds.
      const charged = unpaid({ paymentReference: 'REF-1' })
      expect(planner.plan(charged, { reference: 'REF-1', amount: 150_000 }, NOW)).toMatchObject({
        action: 'apply',
        paymentStatus: 'paid',
      })
    })

    test('an attempt that did not pay changes nothing', () => {
      expect(
        planner.plan(unpaid(), { reference: 'REF-1', amount: 150_000, paid: false }, NOW),
      ).toEqual({ action: 'noop', reason: 'transaction_not_paid' })
    })

    test('a zero or fractional amount is refused', () => {
      expect(planner.plan(unpaid(), { reference: 'REF-1', amount: 0 }, NOW)).toEqual({
        action: 'noop',
        reason: 'non_positive_amount',
      })
      expect(planner.plan(unpaid(), { reference: 'REF-1', amount: 10.5 }, NOW)).toEqual({
        action: 'noop',
        reason: 'non_positive_amount',
      })
    })

    test('a cancelled, refunded or draft order takes no payment', () => {
      for (const status of ['cancelled', 'refunded', 'draft'] as const) {
        expect(
          planner.plan(unpaid({ status }), { reference: 'REF-1', amount: 150_000 }, NOW),
        ).toEqual({ action: 'noop', reason: 'order_not_payable' })
      }
    })

    test('a payment on an order with nothing left to pay is not credited', () => {
      const settled = unpaid({ status: 'paid', paymentStatus: 'paid', amountPaid: 150_000 })
      expect(planner.plan(settled, { reference: 'REF-2', amount: 50_000 }, NOW)).toEqual({
        action: 'noop',
        reason: 'already_settled',
      })
    })

    test('a partial payment leaves the order pending and partial', () => {
      expect(planner.plan(unpaid(), { reference: 'REF-1', amount: 50_000 }, NOW)).toMatchObject({
        action: 'apply',
        amountPaid: 50_000,
        paymentStatus: 'partial',
        orderStatus: null,
        paidAt: null,
      })
    })

    test('an overpayment is clamped to what was owed', () => {
      const half = unpaid({ amountPaid: 100_000, paymentStatus: 'partial' })
      expect(planner.plan(half, { reference: 'REF-2', amount: 999_000 }, NOW)).toMatchObject({
        action: 'apply',
        amountPaid: 150_000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
      })
    })

    test('an order already processing keeps its status when payment lands late', () => {
      const plan = planner.plan(
        unpaid({ status: 'processing' }),
        { reference: 'REF-1', amount: 150_000 },
        NOW,
      )
      expect(plan).toMatchObject({ action: 'apply', paymentStatus: 'paid', orderStatus: null })
    })
  })
}
