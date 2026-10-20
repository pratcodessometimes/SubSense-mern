// Phase 5.1 — legacy anomaly-index migration verified on a REAL MongoDB server, inside the
// run-owned disposable database only (see support/realMongo.mjs). Never run against Atlas data.
//
// Simulates a Phase 3.3 database that still has the GLOBAL unique sparse index `anomalyKey_1`,
// then exercises the exact functions behind
//   npm run migrate:legacy                                  (read-only inspection)
//   npm run migrate:legacy -- --drop-legacy-anomaly-index --confirm drop-anomalyKey_1
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import {
  assignLegacyData,
  inspectLegacyData,
  LEGACY_ANOMALY_INDEX,
  migrateAnomalyKeyIndex,
  rollbackLegacyAssignment,
} from '../../src/migrations/legacyOwnership.js'
import { Alert } from '../../src/models/Alert.js'
import { Subscription } from '../../src/models/Subscription.js'
import { Transaction } from '../../src/models/Transaction.js'
import { User } from '../../src/models/User.js'
import { clearRunDatabase, connectRealTestDatabase, dropRealTestDatabase, resolveRealMongoTarget } from '../support/realMongo.mjs'

const target = resolveRealMongoTarget()
const skip = !target.enabled && target.reason

let run
before(async () => {
  if (target.enabled) run = await connectRealTestDatabase(target)
})
after(async () => {
  if (run) await dropRealTestDatabase(run)
})

const userA = new mongoose.Types.ObjectId()
const userB = new mongoose.Types.ObjectId()
const alertDoc = (userId, over = {}) => ({
  userId, type: 'payment_anomaly', title: 't', description: 'd', impact: 'i', impactLabel: 'l', ...over,
})
const manualAlert = (userId) => alertDoc(userId, { type: 'duplicate', isManual: true })
const isDuplicateKey = (err) => err?.code === 11000
const names = async () => (await Alert.collection.indexes()).map((ix) => ix.name).sort()

/** Removes the legacy index if a previous test created it (run-owned database only; no collection drop). */
async function removeLegacyIndex() {
  if ((await names()).includes(LEGACY_ANOMALY_INDEX)) await Alert.collection.dropIndex(LEGACY_ANOMALY_INDEX)
}

/** A database as left by Phase 3.3 + a Phase 4.1 deploy: the old global index AND the new compound one. */
async function makeLegacyAlertsCollection() {
  await removeLegacyIndex()
  await Alert.collection.createIndex({ anomalyKey: 1 }, { unique: true, sparse: true, name: LEGACY_ANOMALY_INDEX })
  await Alert.createIndexes() // what mongoose autoIndex does at application startup (additive)
}

beforeEach(async () => {
  if (run) await clearRunDatabase(run)
})

test('inspection is read-only and reports the legacy index', { skip }, async () => {
  await makeLegacyAlertsCollection()
  await Alert.create(alertDoc(userA, { anomalyKey: 'payment_anomaly:netflix:shared' }))
  const before = await names()
  const report = await inspectLegacyData()
  assert.equal(report.legacyAnomalyIndexPresent, true)
  assert.ok(report.alertIndexes.includes('userId_1_anomalyKey_1'))
  assert.deepEqual(await names(), before, 'inspection changed no index')
  assert.equal(await Alert.countDocuments(), 1, 'inspection changed no document')
})

test('legacy global index: a second user cannot store the same anomalyKey (the bug being migrated)', { skip }, async () => {
  await makeLegacyAlertsCollection()
  const key = 'payment_anomaly:netflix:shared'
  await Alert.create(alertDoc(userA, { anomalyKey: key }))
  await assert.rejects(Alert.create(alertDoc(userB, { anomalyKey: key })), isDuplicateKey)
  // Alerts without an anomalyKey (manual, other types) never collide, under either index.
  await Alert.create([manualAlert(userA), manualAlert(userA), manualAlert(userB)])
  assert.equal(await Alert.countDocuments({ anomalyKey: { $exists: false } }), 3)
})

test('migration drops only anomalyKey_1, keeps every document, and enables per-user keys', { skip }, async () => {
  await makeLegacyAlertsCollection()
  const key = 'payment_anomaly:netflix:shared'
  await Alert.create([alertDoc(userA, { anomalyKey: key }), manualAlert(userA), manualAlert(userB)])
  const countBefore = await Alert.countDocuments()

  const result = await migrateAnomalyKeyIndex()
  assert.equal(result.dropped, true)
  assert.deepEqual(await names(), ['_id_', 'userId_1_anomalyKey_1', 'userId_1_createdAt_-1'])
  assert.equal(await Alert.countDocuments(), countBefore, 'no alert was deleted')
  assert.equal((await inspectLegacyData()).legacyAnomalyIndexPresent, false)

  // Now two users may hold the identical key; the same user still cannot hold it twice.
  await Alert.create(alertDoc(userB, { anomalyKey: key }))
  await assert.rejects(Alert.create(alertDoc(userA, { anomalyKey: key })), isDuplicateKey)
  await Alert.create([manualAlert(userA), manualAlert(userA)])

  // Re-running is a no-op.
  const again = await migrateAnomalyKeyIndex()
  assert.equal(again.dropped, false)
})

test('a fresh database never gets the legacy index; the migration has nothing to drop', { skip }, async () => {
  await removeLegacyIndex()
  await Alert.createIndexes()
  assert.ok(!(await names()).includes(LEGACY_ANOMALY_INDEX))
  assert.equal((await migrateAnomalyKeyIndex()).dropped, false)
})

test('legacy ownership assignment and rollback on real MongoDB (explicit, reversible)', { skip }, async () => {
  await Alert.createIndexes()
  const owner = await User.create({ name: 'Owner', email: 'owner@example.test', passwordHash: 'x' })
  // Pre-auth documents have no userId (written without schema validation, as Phase 3 did).
  await Transaction.collection.insertMany([
    { date: new Date('2025-01-01'), merchant: 'Legacy', amount: 1 },
    { date: new Date('2025-02-01'), merchant: 'Legacy', amount: 1 },
  ])
  await Subscription.collection.insertOne({ name: 'Legacy', category: 'C', amount: 1, nextBillingDate: new Date(), slug: 'legacy' })
  const other = await Transaction.create({ userId: userB, date: new Date('2025-01-01'), merchant: 'B own', amount: 5 })

  assert.equal((await inspectLegacyData({ targetEmail: 'owner@example.test' })).totalUnowned, 3)
  const { batchId, assigned } = await assignLegacyData({ targetEmail: 'owner@example.test' })
  assert.deepEqual(assigned, { transactions: 2, subscriptions: 1, alerts: 0 })
  assert.equal(await Transaction.countDocuments({ userId: owner._id }), 2)
  assert.equal(String((await Transaction.findById(other._id)).userId), String(userB), "another user's record is untouched")

  const { reverted } = await rollbackLegacyAssignment({ batchId })
  // Phase 5.1 regression: before the fix, mongoose strictQuery reduced the batch filter to {} and the
  // rollback unset userId on EVERY document, including other users' records.
  assert.deepEqual(reverted, { transactions: 2, subscriptions: 1, alerts: 0 })
  assert.equal(String((await Transaction.findById(other._id)).userId), String(userB), "rollback leaves another user's record owned")
  assert.equal(await Transaction.countDocuments({ userId: null }), 2)
  assert.equal(await Transaction.countDocuments(), 3, 'nothing was deleted')
  // A malformed or empty batch id is refused instead of matching everything.
  for (const bad of ['', undefined, '*', { $ne: null }]) {
    await assert.rejects(rollbackLegacyAssignment({ batchId: bad }), /batchId must be/)
  }
  assert.equal(await Transaction.countDocuments({ userId: userB }), 1)
})

test('documented rollback limitation: shared keys block recreating the global index (read-only pre-check)', { skip }, async () => {
  await makeLegacyAlertsCollection()
  await migrateAnomalyKeyIndex()
  const key = 'payment_anomaly:netflix:shared'
  await Alert.create([alertDoc(userA, { anomalyKey: key }), alertDoc(userB, { anomalyKey: key }), manualAlert(userA)])

  // The pre-check from the runbook: any anomalyKey stored more than once means a global unique
  // index can no longer be built, so the index rollback must not be attempted. (Attempting it is
  // rejected by MongoDB with E11000 and leaves an index-build cleanup running for ~30 s; it is not
  // repeated here — see PHASE_5_1_PRODUCTION_READINESS.md.)
  const shared = await Alert.aggregate([
    { $match: { anomalyKey: { $type: 'string' } } },
    { $group: { _id: '$anomalyKey', owners: { $addToSet: '$userId' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ])
  assert.deepEqual(shared.map((g) => [g._id, g.owners.length]), [[key, 2]])
  assert.ok((await names()).includes('userId_1_anomalyKey_1'))
})
