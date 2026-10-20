// Phase 4.1 two-user data isolation tests (User A vs User B).
// HTTP-level against the real Express app plus service-level checks, using the IN-MEMORY
// fake database only (npm run test:unit). Skips itself if the real mongoose package is loaded.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import { Alert } from '../src/models/Alert.js'
import { Subscription } from '../src/models/Subscription.js'
import { Transaction } from '../src/models/Transaction.js'
import { assignLegacyData, inspectLegacyData, rollbackLegacyAssignment } from '../src/migrations/legacyOwnership.js'
import { buildAnomalyAlertDoc, runPaymentAnomalyDetection, upsertAnomalyAlert } from '../src/services/anomalyAlertService.js'
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
const csv = (...rowGroups) => ['date,merchant,amount,account', ...rowGroups.flat()].join('\n')

// Netflix with a price rise (price_increase alert) + Spotify (shared slugs for both users)
const SHARED_CSV = csv(
  monthly('POS DEBIT - NETFLIX.COM', (k) => (k < 6 ? 499 : 649), 9, { startMonth: 4 }),
  monthly('UPI/SPOTIFY AB/4028', 119, 7, { day: 8, startMonth: 6 }),
)

const ownedBy = (Model, client) => Model.__all().filter((d) => String(d.userId) === client.user.id)
const snapshot = (client) => JSON.stringify({
  t: ownedBy(Transaction, client),
  s: ownedBy(Subscription, client),
  a: ownedBy(Alert, client),
})

// ---------------------------------------------------------------- CSV import & transactions
test('CSV import of identical rows for two users: no cross-user de-duplication', { skip }, async () => {
  const ra = await A.importCsv(SHARED_CSV)
  const rb = await B.importCsv(SHARED_CSV)
  assert.equal(ra.status, 201)
  assert.equal(rb.status, 201)
  assert.equal(ra.data.count, 16)
  assert.equal(rb.data.count, 16, "B's identical rows are NOT skipped because A has them")
  assert.equal(rb.data.skippedCount, 0)

  // Re-import is still idempotent within one user.
  const again = await A.importCsv(SHARED_CSV)
  assert.equal(again.data.count, 0)
  assert.equal(again.data.skippedCount, 16)

  assert.equal(ownedBy(Transaction, A).length, 16)
  assert.equal(ownedBy(Transaction, B).length, 16)
  assert.equal(Transaction.__all().length, 32)
  for (const t of ra.data.transactions) assert.equal(String(t.userId), A.user.id)
})

test('User A cannot list, read, update or delete User B\'s transactions', { skip }, async () => {
  const tb = (await B.post('/transactions', { date: '2026-01-05', merchant: 'B Private Gym', amount: 999, notes: 'secret' })).data
  await A.post('/transactions', { date: '2026-01-06', merchant: 'A Coffee', amount: 120 })

  const listA = (await A.get('/transactions')).data
  assert.deepEqual(listA.map((t) => t.merchant), ['A Coffee'])
  assert.ok(!JSON.stringify(listA).includes('secret'))
  assert.deepEqual((await A.get('/transactions?recurring=false')).data.map((t) => t.merchant), ['A Coffee'])

  const read = await A.get(`/transactions/${tb._id}`)
  assert.equal(read.status, 404)
  assert.ok(!JSON.stringify(read.data).includes('secret'), 'no content leaks through the error')

  assert.equal((await A.put(`/transactions/${tb._id}`, { amount: 1, merchant: 'pwned' })).status, 404)
  assert.equal((await A.del(`/transactions/${tb._id}`)).status, 404)
  assert.equal((await A.get('/transactions/not-an-object-id')).status, 404)

  const still = (await B.get(`/transactions/${tb._id}`)).data
  assert.equal(still.merchant, 'B Private Gym')
  assert.equal(still.amount, 999)
})

// ---------------------------------------------------------------- subscriptions
test('Same merchant & slug for two users; A cannot reach B\'s subscription by id or slug', { skip }, async () => {
  await A.importCsv(SHARED_CSV)
  await B.importCsv(csv(monthly('POS DEBIT - NETFLIX.COM', 799, 6, { startMonth: 7 })))

  const subsA = (await A.get('/subscriptions')).data
  const subsB = (await B.get('/subscriptions')).data
  assert.deepEqual(subsA.map((s) => s.slug).sort(), ['netflix', 'spotify'])
  assert.deepEqual(subsB.map((s) => s.slug), ['netflix'])
  const netflixA = subsA.find((s) => s.slug === 'netflix')
  const netflixB = subsB[0]
  assert.notEqual(netflixA._id, netflixB._id)

  // Slug lookup resolves to the caller's own record only.
  assert.equal((await A.get('/subscriptions/netflix')).data._id, netflixA._id)
  assert.equal((await B.get('/subscriptions/netflix')).data._id, netflixB._id)
  assert.equal((await B.get('/subscriptions/spotify')).status, 404, "A's slug is invisible to B")
  // Direct MongoDB id of another user's subscription.
  assert.equal((await A.get(`/subscriptions/${netflixB._id}`)).status, 404)
  assert.equal((await A.put(`/subscriptions/${netflixB._id}`, { amount: 1 })).status, 404)
  assert.equal((await A.del(`/subscriptions/${netflixB._id}`)).status, 404)
  assert.equal((await B.get(`/subscriptions/${netflixB._id}`)).data.amount, 799)

  // Updating/deleting by slug only affects the caller's record.
  assert.equal((await A.put('/subscriptions/netflix', { notes: 'mine' })).status, 200)
  assert.equal((await B.get('/subscriptions/netflix')).data.notes, undefined)
  assert.equal((await A.del('/subscriptions/netflix')).status, 204)
  assert.equal((await B.get('/subscriptions/netflix')).status, 200)
})

test('Manual subscriptions with the same name/slug coexist for two users', { skip }, async () => {
  const body = { name: 'Gym Pass', category: 'Fitness', amount: 1500, nextBillingDate: '2026-02-01' }
  const a = await A.post('/subscriptions', body)
  const b = await B.post('/subscriptions', body)
  assert.equal(a.status, 201)
  assert.equal(b.status, 201)
  assert.equal(a.data.slug, 'gym-pass')
  assert.equal(b.data.slug, 'gym-pass')
  assert.equal((await A.get('/subscriptions')).data.length, 1)
  assert.equal((await B.get('/subscriptions')).data.length, 1)
})

// ---------------------------------------------------------------- alerts
test('User A cannot see or delete User B\'s alerts; manual alerts are owner-scoped', { skip }, async () => {
  await B.importCsv(SHARED_CSV) // creates B's automated alerts (price increase, duplicates etc.)
  const manualB = (await B.post('/alerts', {
    type: 'price_increase', title: 'B note', description: 'private', impact: '-', impactLabel: '-', subscriptionIds: ['netflix'],
  })).data
  assert.equal(String(manualB.userId), B.user.id)

  assert.deepEqual((await A.get('/alerts')).data, [])
  assert.equal((await A.del(`/alerts/${manualB._id}`)).status, 404)
  const bAlerts = (await B.get('/alerts')).data
  assert.ok(bAlerts.some((a) => a._id === manualB._id))
  assert.ok(bAlerts.some((a) => a.type === 'price_increase' && !a.isManual))

  const manualA = (await A.post('/alerts', {
    type: 'price_increase', title: 'A note', description: 'mine', impact: '-', impactLabel: '-', subscriptionIds: ['netflix'],
  })).data
  assert.equal((await B.del(`/alerts/${manualA._id}`)).status, 404)
  assert.equal((await A.del(`/alerts/${manualA._id}`)).status, 204)
  assert.equal((await B.get('/alerts')).data.length, bAlerts.length, "deleting A's alert leaves B's alerts")
})

// ---------------------------------------------------------------- analytics
test('Analytics (KPIs and categories) exclude the other user\'s data', { skip }, async () => {
  await B.importCsv(SHARED_CSV)
  await B.post('/subscriptions', { name: 'B Cloud', category: 'Cloud', amount: 5000, nextBillingDate: '2026-02-01' })

  const emptyA = (await A.get('/analytics/kpis')).data
  assert.equal(emptyA.transactionCount, 0)
  assert.equal(emptyA.monthlySpend, 0)
  assert.equal(emptyA.activeSubscriptions, 0)
  assert.equal(emptyA.alertCount, 0)
  // Phase 5.1: an empty account gets no placeholder categories.
  assert.deepEqual((await A.get('/analytics/categories')).data, [])

  await A.importCsv(csv(monthly('SLACK TECHNOLOGIES', 700, 6, { day: 3, startMonth: 7 })))
  await A.post('/subscriptions', { name: 'A Gym', category: 'Fitness', amount: 300, nextBillingDate: '2026-02-01' })
  const kA = (await A.get('/analytics/kpis')).data
  const kB = (await B.get('/analytics/kpis')).data
  assert.equal(kA.transactionCount, 6)
  assert.equal(kB.transactionCount, 16)
  // Only A's active subscriptions count (Slack's 2025 history may read as inactive by today's date).
  const activeA = ownedBy(Subscription, A).filter((s) => ['active', 'price_increase'].includes(s.status))
  assert.equal(kA.monthlySpend, activeA.reduce((sum, s) => sum + s.amount, 0))
  assert.ok(kA.monthlySpend < 5000, "B's ₹5000 Cloud subscription is not included")
  // Phase 5.1: categories use the KPI's definition (active subscriptions only) and add up to monthlySpend.
  const categoryRowsA = (await A.get('/analytics/categories')).data
  const categoriesA = categoryRowsA.map((c) => c.category).sort()
  assert.deepEqual(categoriesA, [...new Set(activeA.map((s) => s.category))].sort())
  assert.equal(Math.round(categoryRowsA.reduce((sum, c) => sum + c.amount, 0) * 100) / 100, kA.monthlySpend)
  assert.ok(categoriesA.includes('Fitness') && !categoriesA.includes('Cloud'), "B's Cloud category is excluded")
})

// ---------------------------------------------------------------- detection pipeline
test('Detection for A never creates, updates, links or deletes B\'s records', { skip }, async () => {
  await B.importCsv(SHARED_CSV)
  // B also has a manual alert and one non-recurring transaction.
  await B.post('/alerts', { type: 'duplicate', title: 'B manual', description: 'd', impact: 'i', impactLabel: 'l' })
  await B.post('/transactions', { date: '2025-12-01', merchant: 'One-off Shop', amount: 50 })
  await B.post('/transactions/analyze', {}) // settle B's background runs
  const before = snapshot(B)

  // A has the SAME merchants (same slugs) plus different behaviour, and runs detection repeatedly.
  await A.importCsv(csv(monthly('POS DEBIT - NETFLIX.COM', 499, 4, { startMonth: 1 })))
  const r = (await A.post('/transactions/analyze', { referenceDate: '2025-05-01' })).data
  assert.deepEqual(r.subscriptions.map((s) => s.slug), ['netflix'])
  for (const s of r.subscriptions) assert.equal(String(s.userId), A.user.id)
  assert.equal(r.alertsCount, ownedBy(Alert, A).length, 'statistics computed from A\'s data only')
  await A.post('/transactions/analyze', {})

  assert.equal(snapshot(B), before, "B's transactions, subscriptions and alerts are byte-for-byte unchanged")
  for (const t of ownedBy(Transaction, A)) assert.equal(t.subscriptionId, 'netflix')
})

test('Background detection after transaction create/update/delete stays within the user', { skip }, async () => {
  await B.importCsv(SHARED_CSV)
  await B.post('/transactions/analyze', {})
  const before = snapshot(B)

  const created = []
  for (const date of ['2025-01-10', '2025-02-10', '2025-03-10', '2025-04-10']) {
    created.push((await A.post('/transactions', { date, merchant: 'SPOTIFY', amount: 119 })).data)
  }
  await A.put(`/transactions/${created[0]._id}`, { amount: 129 })
  await A.del(`/transactions/${created[1]._id}`)
  // Detection runs for one user are serialized, so this waits for the queued background runs.
  await A.post('/transactions/analyze', {})

  assert.equal(snapshot(B), before)
  assert.deepEqual(ownedBy(Subscription, A).map((s) => s.slug), ['spotify'])
})

test('Alert synchronization for A does not modify or delete B\'s alerts with the same slugs', { skip }, async () => {
  const sub = (over) => ({
    slug: 'netflix', name: 'Netflix', category: 'Streaming', serviceDomain: 'video_streaming', amount: 649,
    previousAmount: 499, priceChangePct: 30.1, monthlyDifference: 150, annualImpact: 1800, billingInterval: 'monthly',
    status: 'potentially_inactive', daysOverdue: 40, daysSinceLastPayment: 70, lastActivity: new Date('2025-06-01'),
    nextBillingDate: new Date('2025-07-01'), ...over,
  })
  const prime = { slug: 'prime', name: 'Prime', category: 'Streaming', serviceDomain: 'video_streaming', amount: 299, billingInterval: 'monthly', status: 'active' }
  await syncAlertsForSubscriptions(B.user.id, [sub(), prime])
  await syncAlertsForSubscriptions(A.user.id, [sub(), prime])
  const bBefore = JSON.stringify(ownedBy(Alert, B))
  assert.equal(ownedBy(Alert, B).length, ownedBy(Alert, A).length)

  // A's Netflix is now healthy: A's price/inactivity/overlap alerts become stale and are removed.
  await syncAlertsForSubscriptions(A.user.id, [sub({ previousAmount: undefined, priceChangePct: undefined, status: 'active' })])
  assert.ok(ownedBy(Alert, A).length < ownedBy(Alert, B).length)
  assert.equal(JSON.stringify(ownedBy(Alert, B)), bBefore, "B's identical-slug alerts untouched")

  await assert.rejects(syncAlertsForSubscriptions(undefined, [sub()]), /userId/)
  await assert.rejects(syncAlertsForSubscriptions('not-an-id', [sub()]), /userId/)
})

test('Payment anomaly alerts are user-isolated (same anomalyKey, upserts and stale removal)', { skip }, async () => {
  const flagged = {
    isAnomaly: true, day: 20437, date: '2025-12-16', amount: 700, refMedianAmount: 700, refMedianInterval: 30.5,
    intervalDays: 43, score: 9, historyUsed: 6, reason: 'paid_later_than_usual', transactionId: 'same-tx-ref',
  }
  const doc = buildAnomalyAlertDoc({ slug: 'slack', name: 'Slack' }, flagged)
  assert.equal(await upsertAnomalyAlert(Alert, doc, A.user.id), 'created')
  assert.equal(await upsertAnomalyAlert(Alert, doc, B.user.id), 'created', 'same anomalyKey for B is a separate alert')
  assert.equal(await upsertAnomalyAlert(Alert, { ...doc, title: 'A updated' }, A.user.id), 'updated')
  assert.equal(ownedBy(Alert, A).length, 1)
  assert.equal(ownedBy(Alert, B).length, 1)
  assert.equal(ownedBy(Alert, B)[0].title, doc.title, "A's update did not touch B's alert")

  // A's anomaly run evaluates 'slack' with no anomalies -> removes only A's stale alert.
  const summary = await runPaymentAnomalyDetection({
    userId: A.user.id,
    subscriptions: [{ slug: 'slack', name: 'Slack', billingInterval: 'monthly' }],
    transactionsBySlug: new Map([['slack', []]]),
    referenceDate: '2025-12-20',
    AlertModel: Alert,
  })
  assert.equal(summary.alerts.removed, 1)
  assert.equal(ownedBy(Alert, A).length, 0)
  assert.equal(ownedBy(Alert, B).length, 1)

  const noOwner = await runPaymentAnomalyDetection({ subscriptions: [], transactionsBySlug: new Map(), AlertModel: Alert, logger: { error() {} } })
  assert.equal(noOwner.status, 'failed', 'an anomaly run without an owner fails closed')
})

test('End-to-end anomaly detection: B\'s anomaly alerts survive A\'s detection runs', { skip }, async () => {
  const slackLate = csv(monthly('SLACK TECHNOLOGIES', 700, 11, { day: 3 }), ['2025-12-16,SLACK TECHNOLOGIES,700,HDFC 1111'])
  await B.importCsv(slackLate)
  await B.post('/transactions/analyze', { referenceDate: '2025-12-20' })
  const bAnomalies = ownedBy(Alert, B).filter((a) => a.type === 'payment_anomaly')
  assert.equal(bAnomalies.length, 1)

  // A has the same merchant but a perfectly regular history.
  await A.importCsv(csv(monthly('SLACK TECHNOLOGIES', 700, 12, { day: 3 })))
  const r = (await A.post('/transactions/analyze', { referenceDate: '2025-12-20' })).data
  assert.equal(r.anomalyDetection.status, 'completed')
  assert.equal(ownedBy(Alert, A).filter((a) => a.type === 'payment_anomaly').length, 0)
  assert.deepEqual(ownedBy(Alert, B).filter((a) => a.type === 'payment_anomaly'), bAnomalies)
})

test('Detection requires a valid owner and fails closed instead of running globally', { skip }, async () => {
  await assert.rejects(runSubscriptionDetection(), /userId/)
  await assert.rejects(runSubscriptionDetection('2025-12-20'), /userId/, 'old (referenceDate-only) call style is rejected')
  await assert.rejects(runSubscriptionDetection({ $ne: null }), /userId/)
})

test('Concurrent analysis runs for both users preserve each user\'s data', { skip }, async () => {
  await A.importCsv(SHARED_CSV)
  await B.importCsv(csv(monthly('SLACK TECHNOLOGIES', 700, 8, { day: 3, startMonth: 3 }), monthly('UPI/SPOTIFY AB/4028', 119, 6, { day: 8 })))
  const results = await Promise.all([
    A.post('/transactions/analyze', {}), B.post('/transactions/analyze', {}),
    A.post('/transactions/analyze', {}), B.post('/transactions/analyze', {}),
    runSubscriptionDetection(A.user.id), runSubscriptionDetection(B.user.id),
  ])
  for (const r of results.slice(0, 4)) assert.equal(r.status, 200)

  const slugs = (c) => ownedBy(Subscription, c).map((s) => s.slug).sort()
  assert.deepEqual(slugs(A), ['netflix', 'spotify'])
  assert.deepEqual(slugs(B), ['slack', 'spotify'])
  assert.equal(new Set(ownedBy(Subscription, A).map((s) => s.slug)).size, 2, 'no duplicate subscriptions from racing runs')
  assert.equal(new Set(ownedBy(Subscription, B).map((s) => s.slug)).size, 2)
  for (const t of ownedBy(Transaction, A)) assert.ok(['netflix', 'spotify'].includes(t.subscriptionId))
  for (const t of ownedBy(Transaction, B)) assert.ok(['slack', 'spotify'].includes(t.subscriptionId))
  const automatedKeys = (c) => ownedBy(Alert, c).map((a) => `${a.type}:${a.subscriptionIds.join(',')}`)
  assert.equal(new Set(automatedKeys(A)).size, automatedKeys(A).length, 'idempotent alerts under concurrency')
})

// ---------------------------------------------------------------- forged ownership
test('Forged userId fields in bodies, queries and headers are ignored', { skip }, async () => {
  const forge = { userId: B.user.id }
  const tx = (await A.post('/transactions', { date: '2026-01-01', merchant: 'Forge', amount: 5, ...forge })).data
  assert.equal(String(tx.userId), A.user.id)
  const moved = await A.put(`/transactions/${tx._id}`, { userId: B.user.id, amount: 6 })
  assert.equal(moved.status, 200)
  assert.equal(String(moved.data.userId), A.user.id)

  const sub = (await A.post('/subscriptions', { name: 'Forge Sub', category: 'X', amount: 1, nextBillingDate: '2026-02-01', ...forge })).data
  assert.equal(String(sub.userId), A.user.id)
  const subMoved = await A.put(`/subscriptions/${sub._id}`, { userId: B.user.id, _id: '000000000000000000000abc', createdAt: '2000-01-01', amount: 2 })
  assert.equal(String(subMoved.data.userId), A.user.id)
  assert.equal(subMoved.data._id, sub._id)
  assert.equal(subMoved.data.amount, 2)

  const alert = (await A.post('/alerts', { type: 'duplicate', title: 't', description: 'd', impact: 'i', impactLabel: 'l', ...forge })).data
  assert.equal(String(alert.userId), A.user.id)

  // Query / header identity cannot widen what A sees.
  await B.post('/transactions', { date: '2026-01-02', merchant: 'B only', amount: 7 })
  const viaQuery = (await A.get(`/transactions?userId=${B.user.id}`, { headers: { 'X-User-Id': B.user.id } })).data
  assert.ok(viaQuery.every((t) => String(t.userId) === A.user.id))
  const opQuery = (await A.get('/subscriptions?category[$ne]=zzz&status[$exists]=true')).data
  assert.ok(opQuery.every((s) => String(s.userId) === A.user.id))
  assert.equal(ownedBy(Transaction, B).length, 1)
})

// ---------------------------------------------------------------- legacy data & migration
async function makeLegacy(Model, data) {
  const doc = await Model.create({ ...data, userId: '0000000000000000000000ff' })
  await Model.updateMany({ _id: doc._id }, { $unset: { userId: 1 } })
  return doc
}

test('Legacy (unowned) records are invisible to every user and untouched by their detection', { skip }, async () => {
  const legacyTx = await makeLegacy(Transaction, { date: new Date('2025-01-14'), merchant: 'NETFLIX.COM', amount: 499, account: 'Legacy' })
  const legacySub = await makeLegacy(Subscription, { slug: 'netflix', name: 'Netflix', category: 'Streaming', amount: 499, nextBillingDate: new Date('2025-02-14') })
  const legacyAlert = await makeLegacy(Alert, { type: 'price_increase', title: 'legacy', description: 'd', impact: 'i', impactLabel: 'l', subscriptionIds: ['netflix'] })
  const legacyBefore = JSON.stringify([Transaction, Subscription, Alert].map((M) => M.__all().filter((d) => d.userId === undefined)))

  for (const c of [A, B]) {
    assert.deepEqual((await c.get('/transactions')).data, [])
    assert.deepEqual((await c.get('/subscriptions')).data, [])
    assert.deepEqual((await c.get('/alerts')).data, [])
    assert.equal((await c.get(`/transactions/${legacyTx._id}`)).status, 404)
    assert.equal((await c.get(`/subscriptions/${legacySub._id}`)).status, 404)
    assert.equal((await c.get('/subscriptions/netflix')).status, 404)
    assert.equal((await c.del(`/alerts/${legacyAlert._id}`)).status, 404)
    assert.equal((await c.get('/analytics/kpis')).data.transactionCount, 0)
  }
  await A.importCsv(SHARED_CSV)
  await A.post('/transactions/analyze', {})
  const legacyAfter = JSON.stringify([Transaction, Subscription, Alert].map((M) => M.__all().filter((d) => d.userId === undefined)))
  assert.equal(legacyAfter, legacyBefore, 'legacy records are not linked, modified or deleted')
})

test('Legacy migration: dry run is read-only; apply assigns to one target; rollback restores', { skip }, async () => {
  await makeLegacy(Transaction, { date: new Date('2025-01-14'), merchant: 'NETFLIX.COM', amount: 499 })
  await makeLegacy(Transaction, { date: new Date('2025-02-14'), merchant: 'NETFLIX.COM', amount: 499 })
  await makeLegacy(Alert, { type: 'payment_anomaly', title: 'l', description: 'd', impact: 'i', impactLabel: 'l', anomalyKey: 'k-legacy' })
  const before = JSON.stringify(Transaction.__all())

  const dry = await inspectLegacyData({ targetEmail: 'a@example.com' })
  assert.deepEqual(dry.counts, { transactions: 2, subscriptions: 0, alerts: 1 })
  assert.equal(dry.target.email, 'a@example.com')
  assert.deepEqual(dry.conflicts.anomalyKeys, [])
  assert.equal(JSON.stringify(Transaction.__all()), before, 'dry run changes nothing')
  assert.equal((await inspectLegacyData({ targetEmail: 'ghost@example.com' })).target, null)
  await assert.rejects(assignLegacyData({ targetEmail: 'ghost@example.com' }), /does not exist/)

  // A conflicting anomalyKey for the target blocks the whole assignment.
  await Alert.create({ userId: A.user.id, type: 'payment_anomaly', title: 't', description: 'd', impact: 'i', impactLabel: 'l', anomalyKey: 'k-legacy' })
  await assert.rejects(assignLegacyData({ targetEmail: 'a@example.com' }), /Refusing to assign/)
  assert.equal((await A.get('/transactions')).data.length, 0)
  await Alert.deleteMany({ userId: A.user.id })

  const applied = await assignLegacyData({ targetEmail: 'a@example.com' })
  assert.deepEqual(applied.assigned, { transactions: 2, subscriptions: 0, alerts: 1 })
  assert.equal((await A.get('/transactions')).data.length, 2)
  assert.equal((await B.get('/transactions')).data.length, 0, 'only the selected account receives legacy data')

  const rolledBack = await rollbackLegacyAssignment({ batchId: applied.batchId })
  assert.deepEqual(rolledBack.reverted, { transactions: 2, subscriptions: 0, alerts: 1 })
  assert.equal((await A.get('/transactions')).data.length, 0)
  assert.equal((await inspectLegacyData()).totalUnowned, 3)
})
