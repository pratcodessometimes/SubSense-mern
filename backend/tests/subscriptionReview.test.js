// Phase 4.2 subscription review (confirm / not a subscription / reset) and its integration with
// detection, alerts and analytics. IN-MEMORY fake database only (npm run test:unit).
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import { Alert } from '../src/models/Alert.js'
import { Subscription } from '../src/models/Subscription.js'
import { Transaction } from '../src/models/Transaction.js'
import { runSubscriptionDetection, syncAlertsForSubscriptions } from '../src/services/detectionService.js'
import { Client, startServer } from './support/httpHarness.mjs'

const FAKE = Boolean(mongoose.__isFake)
const skip = !FAKE && 'requires the in-memory fake database (npm run test:unit)'

let srv
let A
let B
before(async () => {
  if (FAKE) srv = await startServer()
})
after(async () => {
  if (srv) await srv.close()
})
beforeEach(async () => {
  if (!FAKE) return
  mongoose.__resetAll()
  srv.app.locals.resetRateLimits()
  A = new Client(srv.base)
  B = new Client(srv.base)
  await A.register('User A', 'a@example.com')
  await B.register('User B', 'b@example.com')
})

const monthly = (merchant, amount, months, { day = 14, year = 2025, startMonth = 1, account = 'HDFC 1111' } = {}) =>
  Array.from({ length: months }, (_, k) => {
    const dt = new Date(Date.UTC(year, startMonth - 1 + k, day)).toISOString().slice(0, 10)
    return `${dt},${merchant},${typeof amount === 'function' ? amount(k) : amount},${account}`
  })
const csv = (...rows) => ['date,merchant,amount,account', ...rows.flat()].join('\n')
// Netflix: genuine price rise 499 -> 649 (price_increase alert). Spotify: steady.
const CSV = csv(
  monthly('POS DEBIT - NETFLIX.COM', (k) => (k < 6 ? 499 : 649), 9, { startMonth: 4 }),
  monthly('UPI/SPOTIFY AB/4028', 119, 7, { day: 8, startMonth: 6 }),
)

const review = (client, id, reviewStatus, opts) => client.request('PATCH', `/subscriptions/${id}/review`, { ...opts, json: { reviewStatus } })
const mine = (Model, client) => Model.__all().filter((d) => String(d.userId) === client.user.id)
const alertsFor = (client, slug, type) => mine(Alert, client).filter((a) => a.subscriptionIds.includes(slug) && (!type || a.type === type))

test('confirm: stores the decision separately from the detection status and survives re-analysis', { skip }, async () => {
  await A.importCsv(CSV)
  const before = (await A.get('/subscriptions/netflix')).data
  assert.equal(before.reviewStatus, 'unreviewed', 'detected subscriptions start unreviewed')

  const res = await review(A, 'netflix', 'confirmed')
  assert.equal(res.status, 200)
  assert.equal(res.data.reviewStatus, 'confirmed')
  assert.ok(res.data.reviewedAt)
  assert.equal(res.data.status, before.status, 'detection status is not overwritten by the review')
  assert.equal(res.data.previousAmount, 499)

  for (let i = 0; i < 2; i++) await A.post('/transactions/analyze', {})
  const after = (await A.get('/subscriptions/netflix')).data
  assert.equal(after.reviewStatus, 'confirmed', 'repeated analysis keeps the decision')
  assert.equal(after.reviewedAt, res.data.reviewedAt)
  assert.equal(alertsFor(A, 'netflix', 'price_increase').length, 1, 'price-increase intelligence keeps working')
})

test('not a subscription: keeps transactions, drops it from totals and automated alerts, and sticks across runs', { skip }, async () => {
  await A.importCsv(CSV)
  const manual = (await A.post('/alerts', {
    type: 'price_increase', title: 'My own Netflix note', description: 'keep me', impact: '-', impactLabel: '-', subscriptionIds: ['netflix'],
  })).data
  const txBefore = mine(Transaction, A)
  const kpisBefore = (await A.get('/analytics/kpis')).data
  const catsBefore = (await A.get('/analytics/categories')).data
  assert.equal(alertsFor(A, 'netflix', 'price_increase').filter((a) => !a.isManual).length, 1)

  const res = await review(A, 'netflix', 'not_subscription')
  assert.equal(res.status, 200)
  assert.equal(res.data.reviewStatus, 'not_subscription')

  // Financial history is preserved: same transactions, still linked as evidence, not recurring.
  const txAfter = mine(Transaction, A)
  assert.equal(txAfter.length, txBefore.length)
  const netflixTx = txAfter.filter((t) => t.subscriptionId === 'netflix')
  assert.equal(netflixTx.length, 9)
  assert.ok(netflixTx.every((t) => t.isRecurring === false))
  assert.ok(txAfter.filter((t) => t.subscriptionId === 'spotify').every((t) => t.isRecurring === true))

  // Automated alerts that contradict the decision are reconciled away; the manual alert stays.
  assert.equal(alertsFor(A, 'netflix').filter((a) => !a.isManual).length, 0)
  assert.ok(mine(Alert, A).some((a) => a._id === manual._id), 'manual alert preserved')

  // Still listed (so it can be undone), but excluded from recurring totals.
  assert.ok((await A.get('/subscriptions')).data.some((s) => s.slug === 'netflix' && s.reviewStatus === 'not_subscription'))
  const kpis = (await A.get('/analytics/kpis')).data
  // Whether Netflix counts as "active" depends on today's date vs. its 2025 history, so derive
  // the expected change from its detected status instead of hard-coding it.
  const netflixCountedActive = ['active', 'price_increase', 'duplicate'].includes(res.data.status)
  assert.equal(kpis.activeSubscriptions, kpisBefore.activeSubscriptions - (netflixCountedActive ? 1 : 0))
  assert.equal(kpis.monthlySpend, Math.round((kpisBefore.monthlySpend - (netflixCountedActive ? 649 : 0)) * 100) / 100)
  assert.equal(kpis.priceIncreaseAlerts, 1, 'only the manual price note remains')
  assert.equal(kpis.transactionCount, kpisBefore.transactionCount, 'transactions are never removed')
  const streaming = (cats) => cats.find((c) => c.category === 'Streaming')?.amount ?? 0
  assert.ok(streaming(await (await A.get('/analytics/categories')).data) < streaming(catsBefore))

  // Re-analysis (manual and background) must not silently restore it or its alerts.
  await A.post('/transactions/analyze', {})
  await A.post('/transactions', { date: '2025-12-14', merchant: 'POS DEBIT - NETFLIX.COM', amount: 649, account: 'HDFC 1111' })
  await A.post('/transactions/analyze', {})
  const after = (await A.get('/subscriptions/netflix')).data
  assert.equal(after.reviewStatus, 'not_subscription')
  assert.equal(alertsFor(A, 'netflix').filter((a) => !a.isManual).length, 0)
  assert.ok(mine(Transaction, A).filter((t) => t.subscriptionId === 'netflix').every((t) => !t.isRecurring))
})

test('reset: restores automatic detection behaviour (alerts and recurring links come back)', { skip }, async () => {
  await A.importCsv(CSV)
  await review(A, 'netflix', 'not_subscription')
  assert.equal(alertsFor(A, 'netflix', 'price_increase').length, 0)

  const res = await review(A, 'netflix', 'unreviewed')
  assert.equal(res.status, 200)
  assert.equal(res.data.reviewStatus, 'unreviewed')
  assert.equal(res.data.reviewedAt ?? null, null)
  assert.equal(alertsFor(A, 'netflix', 'price_increase').length, 1)
  assert.ok(mine(Transaction, A).filter((t) => t.subscriptionId === 'netflix').every((t) => t.isRecurring))

  // Every transition is reversible.
  assert.equal((await review(A, 'netflix', 'confirmed')).data.reviewStatus, 'confirmed')
  assert.equal((await review(A, 'netflix', 'not_subscription')).data.reviewStatus, 'not_subscription')
  assert.equal((await review(A, 'netflix', 'confirmed')).data.reviewStatus, 'confirmed')
  assert.equal(alertsFor(A, 'netflix', 'price_increase').length, 1)
})

test('review by MongoDB id works the same as by slug', { skip }, async () => {
  await A.importCsv(CSV)
  const sub = (await A.get('/subscriptions/spotify')).data
  const res = await review(A, sub._id, 'confirmed')
  assert.equal(res.status, 200)
  assert.equal(res.data._id, sub._id)
  assert.equal(res.data.reviewStatus, 'confirmed')
})

test('validation: only the three review values are accepted', { skip }, async () => {
  await A.importCsv(CSV)
  for (const body of [{ reviewStatus: 'active' }, { reviewStatus: '' }, { reviewStatus: null }, { reviewStatus: ['confirmed'] }, {},
    { reviewStatus: 'confirmed', status: 'active' }, { reviewStatus: 'confirmed', userId: B.user.id }]) {
    const res = await A.request('PATCH', '/subscriptions/netflix/review', { json: body })
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  assert.equal((await A.get('/subscriptions/netflix')).data.reviewStatus, 'unreviewed')
  assert.equal((await review(A, 'no-such-sub', 'confirmed')).status, 404)
})

test('review state can only be changed through the review endpoint (not via PUT)', { skip }, async () => {
  await A.importCsv(CSV)
  const res = await A.put('/subscriptions/netflix', { reviewStatus: 'not_subscription', reviewedAt: '2000-01-01', notes: 'n' })
  assert.equal(res.status, 200)
  assert.equal(res.data.reviewStatus, 'unreviewed')
  assert.equal(res.data.reviewedAt, undefined)
})

test('isolation: a user cannot review another user\'s subscription (id or slug); same slugs stay independent', { skip }, async () => {
  await A.importCsv(CSV)
  await B.importCsv(CSV)
  const bNetflix = (await B.get('/subscriptions/netflix')).data
  const bAlerts = JSON.stringify(mine(Alert, B))

  assert.equal((await review(A, bNetflix._id, 'not_subscription')).status, 404)
  assert.equal((await B.get('/subscriptions/netflix')).data.reviewStatus, 'unreviewed')

  // A rejecting its own "netflix" does not touch B's "netflix", B's alerts or B's transactions.
  assert.equal((await review(A, 'netflix', 'not_subscription')).status, 200)
  assert.equal((await B.get('/subscriptions/netflix')).data.reviewStatus, 'unreviewed')
  assert.equal(JSON.stringify(mine(Alert, B)), bAlerts)
  assert.ok(mine(Transaction, B).filter((t) => t.subscriptionId === 'netflix').every((t) => t.isRecurring))
})

test('security: review requires a session and a CSRF token', { skip }, async () => {
  await A.importCsv(CSV)
  assert.equal((await review(new Client(srv.base), 'netflix', 'confirmed')).status, 401)
  assert.equal((await review(A, 'netflix', 'confirmed', { csrf: false })).status, 403)
  assert.equal((await A.get('/subscriptions/netflix')).data.reviewStatus, 'unreviewed')
})

test('legacy [manual] status lock keeps working alongside review state', { skip }, async () => {
  await A.importCsv(CSV)
  await A.put('/subscriptions/spotify', { status: 'confirmed_cancelled', notes: '[manual] cancelled by phone' })
  await review(A, 'spotify', 'confirmed')
  await A.post('/transactions/analyze', {})
  const s = (await A.get('/subscriptions/spotify')).data
  assert.equal(s.status, 'confirmed_cancelled', '[manual] note still locks the detection status')
  assert.equal(s.reviewStatus, 'confirmed')
})

// ---------------------------------------------------------------- service level (deterministic dates)
test('payment anomalies: a rejected subscription raises none and its anomaly alerts are removed; reset restores', { skip }, async () => {
  const USER = A.user.id
  const rows = []
  for (let k = 0; k < 11; k++) {
    rows.push({ userId: USER, date: new Date(Date.UTC(2025, k, 3)), merchant: 'SLACK TECHNOLOGIES', amount: 700, account: 'HDFC 1111' })
  }
  rows.push({ userId: USER, date: new Date(Date.UTC(2025, 11, 16)), merchant: 'SLACK TECHNOLOGIES', amount: 700, account: 'HDFC 1111' })
  await Transaction.insertMany(rows)

  const r1 = await runSubscriptionDetection(USER, '2025-12-20')
  assert.equal(r1.anomalyDetection.alerts.created, 1)
  assert.equal(alertsFor(A, 'slack', 'payment_anomaly').length, 1)

  await Subscription.updateMany({ userId: USER, slug: 'slack' }, { $set: { reviewStatus: 'not_subscription' } })
  const r2 = await runSubscriptionDetection(USER, '2025-12-20')
  assert.equal(r2.anomalyDetection.excludedByReview, 1)
  assert.equal(r2.anomalyDetection.alerts.removed, 1)
  assert.equal(alertsFor(A, 'slack', 'payment_anomaly').length, 0)
  assert.equal(mine(Subscription, A).find((s) => s.slug === 'slack').reviewStatus, 'not_subscription')

  await Subscription.updateMany({ userId: USER, slug: 'slack' }, { $set: { reviewStatus: 'confirmed' } })
  const r3 = await runSubscriptionDetection(USER, '2025-12-20')
  assert.equal(r3.anomalyDetection.alerts.created, 1, 'confirmed subscriptions keep anomaly detection')
})

test('alert sync: rejected subscriptions leave service overlaps and generate no alerts; manual alerts survive', { skip }, async () => {
  const USER = A.user.id
  const sub = (over) => ({ category: 'Streaming', serviceDomain: 'video_streaming', billingInterval: 'monthly', status: 'active', ...over })
  const netflix = sub({ slug: 'netflix', name: 'Netflix', amount: 649, previousAmount: 499, priceChangePct: 30.1, monthlyDifference: 150, annualImpact: 1800 })
  const prime = sub({ slug: 'prime', name: 'Prime', amount: 299 })
  const hotstar = sub({ slug: 'hotstar', name: 'Hotstar', amount: 299, hasDuplicateCharges: true, duplicateAmount: 299, duplicateAccounts: ['A', 'B'] })
  await Alert.create({ userId: USER, type: 'duplicate', title: 'manual', description: 'd', impact: 'i', impactLabel: 'l', subscriptionIds: ['hotstar'], isManual: true })

  await syncAlertsForSubscriptions(USER, [netflix, prime, hotstar])
  const overlap = () => mine(Alert, A).filter((a) => a.type === 'service_overlap')
  assert.deepEqual(overlap()[0].subscriptionIds.sort(), ['hotstar', 'netflix', 'prime'])
  assert.equal(alertsFor(A, 'hotstar', 'duplicate').filter((a) => !a.isManual).length, 1)

  await syncAlertsForSubscriptions(USER, [netflix, prime, { ...hotstar, reviewStatus: 'not_subscription' }])
  assert.deepEqual(overlap()[0].subscriptionIds.sort(), ['netflix', 'prime'], 'overlap recomputed without the rejected one')
  assert.equal(alertsFor(A, 'hotstar', 'duplicate').filter((a) => !a.isManual).length, 0)
  assert.equal(alertsFor(A, 'hotstar').filter((a) => a.isManual).length, 1, 'manual alert untouched')
  assert.equal(alertsFor(A, 'netflix', 'price_increase').length, 1, 'other subscriptions unaffected')

  await syncAlertsForSubscriptions(USER, [netflix, { ...prime, reviewStatus: 'not_subscription' }, { ...hotstar, reviewStatus: 'not_subscription' }])
  assert.equal(overlap().length, 0, 'a single remaining service is not an overlap')
})
