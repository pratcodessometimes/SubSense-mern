// Phase 5.1: monthly analytics (actual payments, normalized spend, scheduled charges, categories).
// Pure-function tests plus HTTP tests on the real Express app with the IN-MEMORY fake database.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import { summarizeRecurringSpend } from '../src/services/financialImpact.js'
import {
  buildActualMonthlySeries,
  buildCategoryBreakdown,
  buildRecurringProjection,
  monthRange,
} from '../src/services/monthlyAnalytics.js'
import { Client, startServer } from './support/httpHarness.mjs'

const FAKE = Boolean(mongoose.__isFake)
const skip = !FAKE && 'requires the in-memory fake database (npm run test:unit)'
const d = (iso) => new Date(`${iso}T00:00:00.000Z`)
const tx = (date, amount, over = {}) => ({ date: d(date), amount, isRecurring: true, subscriptionId: 'netflix', ...over })
const sub = (over) => ({
  slug: 'netflix', name: 'Netflix', category: 'Streaming', amount: 649, billingInterval: 'monthly',
  status: 'active', reviewStatus: 'unreviewed', nextBillingDate: d('2026-10-25'), ...over,
})

// ---------------------------------------------------------------- actual payments
test('actual series groups by UTC calendar month across a year boundary', () => {
  const r = buildActualMonthlySeries({
    transactions: [tx('2025-11-30', 400), tx('2025-12-31', 400), tx('2026-01-01', 400), tx('2026-01-31', 400), tx('2026-02-28', 400)],
    subscriptions: [sub({})],
  })
  assert.deepEqual(r.months.map((m) => [m.month, m.amount, m.paymentCount]),
    [['2025-11', 400, 1], ['2025-12', 400, 1], ['2026-01', 800, 2], ['2026-02', 400, 1]])
  assert.equal(r.months[2].label, 'Jan 2026')
  assert.equal(r.totalAmount, 2000)
  assert.deepEqual(r.coverage, {
    firstTransactionDate: '2025-11-30', lastTransactionDate: '2026-02-28', firstMonth: '2025-11', lastMonth: '2026-02', monthsWithData: 4,
  })
})

test('an empty account yields no months and no coverage (nothing fabricated)', () => {
  const r = buildActualMonthlySeries({ transactions: [], subscriptions: [] })
  assert.deepEqual(r, { months: [], coverage: null, truncated: false, totalAmount: 0, paymentCount: 0 })
})

test('only months inside the imported data appear; gaps inside it are explicit zero-payment months', () => {
  const r = buildActualMonthlySeries({
    transactions: [tx('2026-01-10', 100), tx('2026-02-15', 50, { isRecurring: false, subscriptionId: null }), tx('2026-04-10', 100)],
    subscriptions: [sub({})],
  })
  assert.deepEqual(r.months.map((m) => [m.month, m.amount, m.paymentCount]),
    [['2026-01', 100, 1], ['2026-02', 0, 0], ['2026-03', 0, 0], ['2026-04', 100, 1]])
})

test('one-off spending and rejected subscriptions are not recurring payments', () => {
  const r = buildActualMonthlySeries({
    transactions: [
      tx('2026-01-10', 649),
      tx('2026-01-11', 300, { isRecurring: false, subscriptionId: null }), // coffee
      tx('2026-01-12', 999, { subscriptionId: 'gym' }), // rejected even if a stale isRecurring flag remains
    ],
    subscriptions: [sub({}), sub({ slug: 'gym', reviewStatus: 'not_subscription' })],
  })
  assert.equal(r.totalAmount, 649)
  assert.equal(r.months[0].subscriptionCount, 1)
})

test('the window keeps the latest N months and flags truncation', () => {
  const transactions = monthRange('2024-01', '2026-06').map((m) => tx(`${m}-05`, 10))
  const r = buildActualMonthlySeries({ transactions, subscriptions: [sub({})], months: 12 })
  assert.equal(r.months.length, 12)
  assert.equal(r.months[0].month, '2025-07')
  assert.equal(r.months.at(-1).month, '2026-06')
  assert.equal(r.truncated, true)
  assert.equal(r.coverage.monthsWithData, 30)
  assert.equal(r.totalAmount, 120, 'totals cover the displayed window only')
})

test('a yearly payment is recorded in the month it was paid, at its full amount', () => {
  const r = buildActualMonthlySeries({
    transactions: [tx('2025-03-02', 9900, { subscriptionId: 'dropbox' }), tx('2025-05-02', 100)],
    subscriptions: [sub({}), sub({ slug: 'dropbox', billingInterval: 'yearly', amount: 9900 })],
  })
  assert.deepEqual(r.months.map((m) => m.amount), [9900, 0, 100], 'actual cash flow is never divided by 12')
})

// ---------------------------------------------------------------- normalized vs categories
test('categories use the KPI definition: active only, yearly / 12, adding up to monthlySpend', () => {
  const subs = [
    sub({}),
    sub({ slug: 'prime', name: 'Prime', amount: 1499, billingInterval: 'yearly' }),
    sub({ slug: 'slack', name: 'Slack', category: 'SaaS', amount: 700, status: 'price_increase' }),
    sub({ slug: 'old', name: 'Old', category: 'SaaS', amount: 500, status: 'confirmed_cancelled' }),
    sub({ slug: 'idle', name: 'Idle', category: 'Fitness', amount: 999, status: 'potentially_inactive' }),
    sub({ slug: 'rej', name: 'Rej', category: 'Fitness', amount: 999, reviewStatus: 'not_subscription' }),
    sub({ slug: 'blank', name: 'Blank', category: '  ', amount: 50 }),
  ]
  const categories = buildCategoryBreakdown(subs)
  assert.deepEqual(categories, [
    { category: 'Streaming', amount: 773.92, subscriptionCount: 2 },
    { category: 'SaaS', amount: 700, subscriptionCount: 1 },
    { category: 'Uncategorized', amount: 50, subscriptionCount: 1 },
  ])
  const total = Math.round(categories.reduce((s, c) => s + c.amount, 0) * 100) / 100
  assert.equal(total, summarizeRecurringSpend(subs).monthlySpend)
  assert.deepEqual(buildCategoryBreakdown([]), [])
})

// ---------------------------------------------------------------- projection
const NOW = new Date('2026-10-20T12:00:00Z')

test('projection schedules monthly and yearly charges by billing date, from today onward', () => {
  const p = buildRecurringProjection({
    now: NOW,
    subscriptions: [
      sub({ nextBillingDate: d('2026-10-25') }), // 649 on 25 Oct, 25 Nov, 25 Dec
      sub({ slug: 'prime', amount: 1499, billingInterval: 'yearly', nextBillingDate: d('2026-11-03') }),
    ],
  })
  assert.deepEqual(p.months.map((m) => [m.month, m.amount, m.chargeCount, m.partial]), [
    ['2026-10', 649, 1, true],
    ['2026-11', 2148, 2, false],
    ['2026-12', 649, 1, false],
  ])
  assert.equal(p.includedSubscriptions, 2)
  assert.equal(p.asOf, '2026-10-20')
  assert.ok(p.assumptions.length > 0)
})

test('projection keeps the billing day across short months (no drift)', () => {
  const p = buildRecurringProjection({ now: d('2027-01-01'), months: 4, subscriptions: [sub({ amount: 100, nextBillingDate: d('2027-01-31') })] })
  assert.deepEqual(p.months.map((m) => m.amount), [100, 100, 100, 100])
  const p2 = buildRecurringProjection({ now: d('2027-01-01'), months: 3, subscriptions: [sub({ amount: 100, nextBillingDate: d('2027-01-31') })] })
  assert.deepEqual(p2.months.map((m) => m.month), ['2027-01', '2027-02', '2027-03'])
})

test('projection excludes rejected, cancelled, inactive and stale subscriptions, and never projects duplicates', () => {
  const p = buildRecurringProjection({
    now: NOW,
    subscriptions: [
      sub({ amount: 119, status: 'duplicate', hasDuplicateCharges: true, duplicateAmount: 119, nextBillingDate: d('2026-11-08') }),
      sub({ slug: 'r', reviewStatus: 'not_subscription' }),
      sub({ slug: 'c', status: 'confirmed_cancelled' }),
      sub({ slug: 'i', status: 'needs_review' }),
      sub({ slug: 's', nextBillingDate: d('2026-08-01') }), // expected 2.5 months ago, no newer payment
      sub({ slug: 'g', nextBillingDate: d('2026-10-15') }), // within the 7-day grace period
    ],
  })
  assert.deepEqual(p.excluded, { rejected: 1, cancelled: 1, missingPayments: 1, stale: 1 })
  assert.equal(p.includedSubscriptions, 2)
  // Duplicate-flagged: one charge of 119 per month (the extra charge is not projected).
  // Grace-period sub: its 15 Oct date has passed, so it counts from 15 Nov.
  assert.deepEqual(p.months.map((m) => m.amount), [0, 119 + 649, 119 + 649])
})

test('projection for an account without subscriptions is all zero, with nothing included', () => {
  const p = buildRecurringProjection({ now: NOW, subscriptions: [] })
  assert.equal(p.includedSubscriptions, 0)
  assert.ok(p.months.every((m) => m.amount === 0 && m.chargeCount === 0))
})

// ---------------------------------------------------------------- HTTP: GET /api/analytics/monthly
let srv
before(async () => {
  if (FAKE) srv = await startServer()
})
after(async () => {
  if (srv) await srv.close()
})
let A
let B
beforeEach(async () => {
  if (!FAKE) return
  mongoose.__resetAll()
  srv.app.locals.resetRateLimits()
  A = new Client(srv.base)
  B = new Client(srv.base)
  await A.register('Monthly A', 'monthly-a@example.com')
  await B.register('Monthly B', 'monthly-b@example.com')
})

const csv = (rows) => ['date,merchant,amount,account', ...rows].join('\n')
const monthly = (merchant, amount, dates) => dates.map((dt) => `${dt},${merchant},${amount},HDFC 1111`)

test('GET /api/analytics/monthly requires a session and validates its parameters', { skip }, async () => {
  assert.equal((await new Client(srv.base).get('/analytics/monthly')).status, 401)
  for (const q of ['months=0', 'months=37', 'months=abc', 'projectionMonths=13', 'months=1.5']) {
    assert.equal((await A.get(`/analytics/monthly?${q}`)).status, 400, q)
  }
  assert.equal((await A.get('/analytics/monthly?months=6&projectionMonths=2')).data.projection.months.length, 2)
})

test('each user receives only their own monthly series', { skip }, async () => {
  await A.importCsv(csv(monthly('NOTION LABS', 400, ['2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28'])))
  await B.importCsv(csv(monthly('POS DEBIT - NETFLIX.COM', 649, ['2025-11-14', '2025-12-14', '2026-01-14', '2026-02-14', '2026-03-14'])))
  await A.post('/transactions/analyze', { referenceDate: '2026-03-05' })
  await B.post('/transactions/analyze', { referenceDate: '2026-03-20' })

  const a = (await A.get('/analytics/monthly')).data
  const b = (await B.get('/analytics/monthly')).data
  assert.equal(a.currency, 'INR')
  assert.deepEqual(a.actual.months.map((m) => m.amount), [400, 400, 400, 400])
  assert.deepEqual(b.actual.months.map((m) => m.amount), [649, 649, 649, 649, 649])
  assert.equal(a.actual.coverage.lastMonth, '2026-02')
  assert.equal(b.actual.coverage.lastMonth, '2026-03')
  // Basis labels keep actual payments, normalized spend and the estimate apart.
  assert.equal(a.actual.basis, 'recorded_recurring_payments')
  assert.equal(a.normalized.basis, 'normalized_monthly_recurring')
  assert.equal(a.projection.basis, 'scheduled_recurring_charges')
  const kpiA = (await A.get('/analytics/kpis')).data
  assert.equal(a.normalized.monthlySpend, kpiA.monthlySpend, 'normalized figure is the KPI definition')
})

test('rejecting a subscription removes its payments from the series but keeps the transactions', { skip }, async () => {
  await A.importCsv(csv([
    ...monthly('POS DEBIT - NETFLIX.COM', 649, ['2026-01-14', '2026-02-14', '2026-03-14', '2026-04-14']),
    ...monthly('UPI/SPOTIFY AB/4028', 119, ['2026-01-08', '2026-02-08', '2026-03-08', '2026-04-08']),
  ]))
  await A.post('/transactions/analyze', { referenceDate: '2026-04-20' })
  const before = (await A.get('/analytics/monthly')).data.actual
  assert.equal(before.totalAmount, 4 * (649 + 119))

  assert.equal((await A.request('PATCH', '/subscriptions/spotify/review', { json: { reviewStatus: 'not_subscription' } })).status, 200)
  const after = (await A.get('/analytics/monthly')).data.actual
  assert.equal(after.totalAmount, 4 * 649)
  assert.equal((await A.get('/transactions')).data.length, 8)
  // B (no data) still sees an honest empty state.
  const empty = (await B.get('/analytics/monthly')).data
  assert.deepEqual(empty.actual.months, [])
  assert.equal(empty.projection.includedSubscriptions, 0)
})
