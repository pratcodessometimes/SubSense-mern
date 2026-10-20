// Phase 5.1 — end-to-end tests against a REAL MongoDB server: the real Express app, the real
// mongoose package, real indexes and two independently authenticated users.
//
// Runs only through `npm run test:mongo` / `npm run test:mongo:local`, after the safety gate in
// support/realMongo.mjs accepts TEST_MONGO_URI. Each run uses its own empty database and drops it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import { Alert } from '../../src/models/Alert.js'
import { Session } from '../../src/models/Session.js'
import { Subscription } from '../../src/models/Subscription.js'
import { Transaction } from '../../src/models/Transaction.js'
import { User } from '../../src/models/User.js'
import { Client, startServer } from '../support/httpHarness.mjs'
import { clearRunDatabase, connectRealTestDatabase, dropRealTestDatabase, resolveRealMongoTarget } from '../support/realMongo.mjs'
import { ANOMALY_SCENARIO_REFERENCE_DATE, anomalyScenarioRows, toCsv } from '../support/scenarios.mjs'

const target = resolveRealMongoTarget() // throws (fails the file) when opted in unsafely
const skip = !target.enabled && target.reason

let run
let srv
let A
let B
before(async () => {
  if (!target.enabled) return
  assert.equal(Boolean(mongoose.__isFake), false, 'the real mongoose package must be loaded')
  run = await connectRealTestDatabase(target)
  srv = await startServer()
})
after(async () => {
  if (srv) await srv.close()
  if (run) await dropRealTestDatabase(run)
})
beforeEach(async () => {
  if (!target.enabled) return
  await clearRunDatabase(run)
  srv.app.locals.resetRateLimits()
  A = new Client(srv.base)
  B = new Client(srv.base)
  await A.register('Real User A', 'real-a@example.test')
  await B.register('Real User B', 'real-b@example.test')
})

const SCENARIO_CSV = toCsv(anomalyScenarioRows())
const analyze = (c) => c.post('/transactions/analyze', { referenceDate: ANOMALY_SCENARIO_REFERENCE_DATE })
const mine = (Model, c, filter = {}) => Model.find({ ...filter, userId: c.user.id }).lean()
const isDuplicateKey = (err) => err?.code === 11000
const indexNames = async (Model) => (await Model.collection.indexes()).map((ix) => ix.name).sort()
const findIndex = async (Model, name) => (await Model.collection.indexes()).find((ix) => ix.name === name)

// ---------------------------------------------------------------- indexes
test('real MongoDB holds the owner-scoped indexes defined by the schemas', { skip }, async () => {
  assert.deepEqual(await indexNames(User), ['_id_', 'email_1'])
  assert.equal((await findIndex(User, 'email_1')).unique, true)

  assert.deepEqual(await indexNames(Session), ['_id_', 'expiresAt_1', 'tokenHash_1', 'userId_1'])
  assert.equal((await findIndex(Session, 'tokenHash_1')).unique, true)
  // TTL DEFINITION only (expireAfterSeconds: 0 = delete at expiresAt). Observed deletion is a separate test.
  assert.equal((await findIndex(Session, 'expiresAt_1')).expireAfterSeconds, 0)

  assert.deepEqual(await indexNames(Transaction), ['_id_', 'userId_1_date_-1', 'userId_1_subscriptionId_1'])
  assert.deepEqual(await indexNames(Subscription), ['_id_', 'userId_1_amount_-1', 'userId_1_slug_1'])
  assert.deepEqual(await indexNames(Alert), ['_id_', 'userId_1_anomalyKey_1', 'userId_1_createdAt_-1'])
  const anomaly = await findIndex(Alert, 'userId_1_anomalyKey_1')
  assert.deepEqual(anomaly.key, { userId: 1, anomalyKey: 1 })
  assert.equal(anomaly.unique, true)
  assert.deepEqual(anomaly.partialFilterExpression, { anomalyKey: { $type: 'string' } })
  assert.equal(anomaly.sparse, undefined)
})

test('emails are unique after normalization, enforced by MongoDB itself', { skip }, async () => {
  const dup = await new Client(srv.base).post('/auth/register', { name: 'Dup', email: '  REAL-A@Example.TEST ', password: 'CorrectHorse9' })
  assert.equal(dup.status, 409)
  // Bypassing the controller check: the schema lowercases and the unique index rejects it.
  await assert.rejects(User.create({ name: 'X', email: 'Real-A@example.test', passwordHash: 'x' }), isDuplicateKey)
  // Bypassing mongoose entirely: the database index still rejects it.
  await assert.rejects(User.collection.insertOne({ name: 'X', email: 'real-a@example.test', passwordHash: 'x' }), isDuplicateKey)
  assert.equal(await User.countDocuments({ email: 'real-a@example.test' }), 1)
})

test('session token hashes are unique in the database', { skip }, async () => {
  const doc = { userId: new mongoose.Types.ObjectId(A.user.id), tokenHash: 'f'.repeat(64), expiresAt: new Date(Date.now() + 60_000) }
  await Session.create(doc)
  await assert.rejects(Session.create(doc), isDuplicateKey)
})

// ---------------------------------------------------------------- authentication
test('registration stores an Argon2id hash; sessions store only the token hash', { skip }, async () => {
  const user = await User.findById(A.user.id).lean()
  assert.match(user.passwordHash, /^\$argon2id\$/)
  assert.ok(!user.passwordHash.includes('CorrectHorse9'))
  assert.equal(user.email, 'real-a@example.test')

  const token = A.cookie.split('=')[1]
  const sessions = await Session.find({ userId: A.user.id }).lean()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].tokenHash, createHash('sha256').update(token).digest('hex'))
  assert.ok(!JSON.stringify(sessions).includes(token), 'the raw token is never stored')
  assert.ok(sessions[0].expiresAt > new Date())
})

test('login, session persistence, logout revocation, and expired/revoked sessions', { skip }, async () => {
  const second = new Client(srv.base)
  const login = await second.post('/auth/login', { email: 'real-a@example.test', password: 'CorrectHorse9' })
  assert.equal(login.status, 200)
  assert.equal(await Session.countDocuments({ userId: A.user.id }), 2, 'each login is its own session')

  // Persisted session authenticates later requests.
  assert.equal((await second.get('/auth/me')).data.user.id, A.user.id)
  assert.equal((await second.get('/transactions')).status, 200)

  // Logout deletes that session in MongoDB; the old cookie no longer works.
  const oldCookie = second.cookie
  assert.equal((await second.post('/auth/logout', {})).status, 200)
  assert.equal(await Session.countDocuments({ userId: A.user.id }), 1)
  const replay = new Client(srv.base)
  replay.cookie = oldCookie
  assert.equal((await replay.get('/auth/me')).status, 401)

  // Expired (TTL monitor not yet run): rejected immediately and removed.
  await Session.updateMany({ userId: A.user.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
  assert.equal((await A.get('/transactions')).status, 401)
  assert.equal(await Session.countDocuments({ userId: A.user.id }), 0)

  // Revoked server-side (e.g. by an administrator): rejected.
  assert.equal((await B.get('/auth/me')).status, 200)
  await Session.deleteMany({ userId: B.user.id })
  assert.equal((await B.get('/auth/me')).status, 401)
})

// ---------------------------------------------------------------- ownership
test('two users with identical data: no cross-user reads, writes, or deletes', { skip }, async () => {
  assert.equal((await A.importCsv(SCENARIO_CSV)).status, 201)
  assert.equal((await B.importCsv(SCENARIO_CSV)).status, 201)
  await analyze(A)
  await analyze(B)

  // Identical slugs are stored independently for each owner.
  const netflix = await Subscription.find({ slug: 'netflix' }).lean()
  assert.equal(netflix.length, 2)
  assert.deepEqual(new Set(netflix.map((s) => String(s.userId))), new Set([A.user.id, B.user.id]))

  const [bTx] = await mine(Transaction, B)
  const bSub = (await mine(Subscription, B, { slug: 'netflix' }))[0]
  const bAlert = (await mine(Alert, B))[0]
  assert.ok(bTx && bSub && bAlert)

  // Transactions
  assert.equal((await A.get(`/transactions/${bTx._id}`)).status, 404)
  assert.equal((await A.put(`/transactions/${bTx._id}`, { amount: 1 })).status, 404)
  assert.equal((await A.del(`/transactions/${bTx._id}`)).status, 404)
  assert.ok(!(await A.get('/transactions')).data.some((t) => t._id === String(bTx._id)))
  // Subscriptions (by id) — and by slug only ever the caller's own record
  assert.equal((await A.get(`/subscriptions/${bSub._id}`)).status, 404)
  assert.equal((await A.put(`/subscriptions/${bSub._id}`, { amount: 1 })).status, 404)
  assert.equal((await A.request('PATCH', `/subscriptions/${bSub._id}/review`, { json: { reviewStatus: 'not_subscription' } })).status, 404)
  assert.equal((await A.del(`/subscriptions/${bSub._id}`)).status, 404)
  assert.equal((await A.request('PATCH', '/subscriptions/netflix/review', { json: { reviewStatus: 'confirmed' } })).status, 200)
  // Alerts
  assert.equal((await A.del(`/alerts/${bAlert._id}`)).status, 404)
  const bAlertIds = new Set((await mine(Alert, B)).map((a) => String(a._id)))
  assert.ok((await A.get('/alerts')).data.every((a) => !bAlertIds.has(a._id)))

  // B's records are exactly as before.
  assert.equal((await Transaction.findById(bTx._id).lean()).amount, bTx.amount)
  const bSubAfter = await Subscription.findById(bSub._id).lean()
  assert.equal(bSubAfter.amount, bSub.amount)
  assert.equal(bSubAfter.reviewStatus, 'unreviewed')
  assert.ok(await Alert.findById(bAlert._id))

  // Recommendations only reference A's own subscriptions and alerts.
  const recs = (await A.get('/recommendations')).data
  const aSlugs = new Set((await mine(Subscription, A)).map((s) => s.slug))
  const aAlertIds = new Set((await mine(Alert, A)).map((a) => String(a._id)))
  assert.ok(recs.recommendations.length > 0)
  for (const r of recs.recommendations) {
    assert.ok(r.subscriptionIds.every((id) => aSlugs.has(id)), r.id)
    assert.ok(r.sourceAlertIds.every((id) => aAlertIds.has(id) && !bAlertIds.has(id)), r.id)
  }
})

test('analytics (KPIs, categories, monthly) are computed from the caller\'s records only', { skip }, async () => {
  await B.importCsv(SCENARIO_CSV)
  await analyze(B)
  const emptyA = (await A.get('/analytics/monthly')).data
  assert.deepEqual(emptyA.actual.months, [])
  assert.equal(emptyA.actual.coverage, null)
  assert.equal(emptyA.normalized.monthlySpend, 0)
  assert.equal(emptyA.projection.months.every((m) => m.amount === 0), true)
  assert.deepEqual((await A.get('/analytics/categories')).data, [])
  assert.equal((await A.get('/analytics/kpis')).data.transactionCount, 0)

  await A.importCsv(toCsv([
    { date: '2025-11-30', merchant: 'NOTION LABS', amount: 400, account: 'HDFC 1111' },
    { date: '2025-12-31', merchant: 'NOTION LABS', amount: 400, account: 'HDFC 1111' },
    { date: '2026-01-31', merchant: 'NOTION LABS', amount: 400, account: 'HDFC 1111' },
    { date: '2026-02-28', merchant: 'NOTION LABS', amount: 400, account: 'HDFC 1111' },
  ]))
  await A.post('/transactions/analyze', { referenceDate: '2026-03-05' })
  const monthlyA = (await A.get('/analytics/monthly')).data
  const monthlyB = (await B.get('/analytics/monthly')).data
  // Dates round-trip through MongoDB as UTC calendar dates, grouped across the year boundary.
  assert.deepEqual(monthlyA.actual.months.map((m) => [m.month, m.amount]),
    [['2025-11', 400], ['2025-12', 400], ['2026-01', 400], ['2026-02', 400]])
  const aRecurring = await mine(Transaction, A, { isRecurring: true })
  assert.equal(monthlyA.actual.totalAmount, aRecurring.reduce((s, t) => s + t.amount, 0))
  const bRecurring = await mine(Transaction, B, { isRecurring: true })
  assert.equal(monthlyB.actual.totalAmount, bRecurring.reduce((s, t) => s + t.amount, 0))
  assert.notEqual(monthlyA.actual.totalAmount, monthlyB.actual.totalAmount)
  assert.equal((await A.get('/analytics/kpis')).data.transactionCount, 4)
})

// ---------------------------------------------------------------- financial workflows
test('CSV import → detection → persisted price-increase and anomaly alerts; re-analysis is idempotent', { skip }, async () => {
  const imported = await A.importCsv(SCENARIO_CSV)
  assert.equal(imported.status, 201)
  assert.equal(imported.data.count, anomalyScenarioRows().length)
  assert.equal((await analyze(A)).status, 200)

  const slugs = (await mine(Subscription, A)).map((s) => s.slug).sort()
  assert.deepEqual(slugs, ['aws', 'cult-fit', 'netflix', 'slack', 'spotify'])
  const alerts = await mine(Alert, A)
  assert.ok(alerts.some((a) => a.type === 'price_increase' && a.subscriptionIds.includes('netflix')))
  const anomalies = alerts.filter((a) => a.type === 'payment_anomaly')
  assert.ok(anomalies.length >= 1, 'payment anomaly alerts are persisted')
  assert.ok(anomalies.every((a) => typeof a.anomalyKey === 'string' && a.anomalyKey.startsWith('payment_anomaly:')))

  const snapshot = async () => ({
    tx: await Transaction.countDocuments({ userId: A.user.id }),
    subs: (await mine(Subscription, A)).map((s) => `${s.slug}:${s.status}:${s.amount}`).sort(),
    alerts: (await mine(Alert, A)).map((a) => `${a.type}:${a.anomalyKey ?? a.subscriptionIds.join('+')}`).sort(),
  })
  const before = await snapshot()
  await analyze(A)
  await analyze(A)
  assert.deepEqual(await snapshot(), before, 'repeated analysis creates no duplicate subscriptions or alerts')

  const again = await A.importCsv(SCENARIO_CSV)
  assert.equal(again.data.count, 0)
  assert.equal(again.data.skippedCount, anomalyScenarioRows().length)
  await analyze(A)
  assert.deepEqual(await snapshot(), before, 'and so does re-importing the same file')
})

test('subscription review decisions persist and are respected by re-analysis, analytics and recommendations', { skip }, async () => {
  await A.importCsv(SCENARIO_CSV)
  await analyze(A)
  const totalBefore = (await A.get('/analytics/monthly')).data.actual.totalAmount

  assert.equal((await A.request('PATCH', '/subscriptions/netflix/review', { json: { reviewStatus: 'confirmed' } })).status, 200)
  assert.equal((await A.request('PATCH', '/subscriptions/spotify/review', { json: { reviewStatus: 'not_subscription' } })).status, 200)
  await analyze(A)

  const netflix = (await mine(Subscription, A, { slug: 'netflix' }))[0]
  const spotify = (await mine(Subscription, A, { slug: 'spotify' }))[0]
  assert.equal(netflix.reviewStatus, 'confirmed')
  assert.ok(netflix.reviewedAt instanceof Date)
  assert.equal(spotify.reviewStatus, 'not_subscription')

  // Spotify's payments stay stored but no longer count as recurring spending.
  const spotifyTx = await mine(Transaction, A, { subscriptionId: 'spotify' })
  assert.equal(spotifyTx.length, 8)
  assert.ok(spotifyTx.every((t) => t.isRecurring === false))
  const totalAfter = (await A.get('/analytics/monthly')).data.actual.totalAmount
  assert.equal(totalAfter, Math.round((totalBefore - spotifyTx.reduce((s, t) => s + t.amount, 0)) * 100) / 100)
  // Categories exclude the rejected subscription and add up to the monthly-spend KPI.
  const categories = (await A.get('/analytics/categories')).data
  const kpis = (await A.get('/analytics/kpis')).data
  assert.equal(Math.round(categories.reduce((s, c) => s + c.amount, 0) * 100) / 100, kpis.monthlySpend)

  const recs = (await A.get('/recommendations')).data
  assert.ok(recs.recommendations.every((r) => !r.subscriptionIds.includes('spotify')))
  assert.equal(recs.summary.rejectedCount, 1)
  assert.equal(recs.summary.confirmedCount, 1)
})

test('preferences persist in MongoDB and drive the recommendation focus', { skip }, async () => {
  await A.importCsv(SCENARIO_CSV)
  await analyze(A)
  const res = await A.request('PATCH', '/auth/preferences', { json: { alerts: { duplicate: false }, recommendationFocus: 'reduce_costs' } })
  assert.equal(res.status, 200)
  const stored = await User.findById(A.user.id).lean()
  assert.equal(stored.preferences.alerts.duplicate, false)
  assert.equal(stored.preferences.recommendationFocus, 'reduce_costs')

  const fresh = new Client(srv.base)
  await fresh.post('/auth/login', { email: 'real-a@example.test', password: 'CorrectHorse9' })
  assert.equal((await fresh.get('/auth/me')).data.user.preferences.recommendationFocus, 'reduce_costs')
  const recs = (await fresh.get('/recommendations')).data
  assert.equal(recs.meta.focus, 'reduce_costs')
  assert.ok(recs.recommendations.every((r) => r.alertCategory !== 'duplicate'), 'hidden category is not shown')
  // B is unaffected.
  assert.equal((await B.get('/auth/me')).data.user.preferences.recommendationFocus, 'balanced')
})

test('identical CSV rows without a reference are kept and stay idempotent on real MongoDB', { skip }, async () => {
  const csv = 'date,merchant,amount,account\n2026-08-14,STARBUCKS COFFEE,350,HDFC\n2026-08-14,STARBUCKS COFFEE,350,HDFC\n'
  assert.equal((await A.importCsv(csv)).data.count, 2)
  assert.equal((await A.importCsv(csv)).data.count, 0)
  assert.equal((await B.importCsv(csv)).data.count, 2, "B's import is independent of A's identical rows")
  assert.equal(await Transaction.countDocuments({ userId: A.user.id }), 2)
})

// ---------------------------------------------------------------- TTL behaviour (optional, slow)
test('OBSERVED TTL deletion of an expired session (MongoDB TTL monitor, ~60 s)',
  { skip: skip || (process.env.SUBSENSE_REAL_DB_TTL_WAIT !== '1' && 'set SUBSENSE_REAL_DB_TTL_WAIT=1 to wait for the TTL monitor'), timeout: 150_000 },
  async () => {
    const { insertedId } = await Session.collection.insertOne({
      userId: new mongoose.Types.ObjectId(A.user.id), tokenHash: 'e'.repeat(64), expiresAt: new Date(Date.now() - 1000),
    })
    const deadline = Date.now() + 140_000
    while (Date.now() < deadline && (await Session.collection.countDocuments({ _id: insertedId })) > 0) {
      await new Promise((r) => setTimeout(r, 5000))
    }
    assert.equal(await Session.collection.countDocuments({ _id: insertedId }), 0, 'expired session removed by the TTL monitor')
  })
