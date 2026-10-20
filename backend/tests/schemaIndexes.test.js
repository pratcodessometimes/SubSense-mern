// Phase 4.1: verifies the index/ownership definitions with the REAL mongoose package
// (no database connection is opened). Under `npm run test:unit` (fake mongoose) it skips.
// Run directly:  node --test tests/schemaIndexes.test.js
import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { Alert } from '../src/models/Alert.js'
import { Session } from '../src/models/Session.js'
import { Subscription } from '../src/models/Subscription.js'
import { Transaction } from '../src/models/Transaction.js'
import { User } from '../src/models/User.js'

const REAL = !mongoose.__isFake
const skip = !REAL && 'needs the real mongoose package (run with node --test directly)'
const indexes = (Model) => Model.schema.indexes()
const find = (Model, fields) => indexes(Model).find(([f]) => JSON.stringify(f) === JSON.stringify(fields))

test('anomalyKey is unique per user via a partial compound index, not globally', { skip }, () => {
  assert.equal(Alert.schema.path('anomalyKey').options.index, undefined, 'no field-level (global) anomalyKey index')
  assert.equal(Alert.schema.path('anomalyKey').options.unique, undefined)
  const ix = find(Alert, { userId: 1, anomalyKey: 1 })
  assert.ok(ix, 'compound { userId, anomalyKey } index exists')
  assert.equal(ix[1].unique, true)
  assert.deepEqual(ix[1].partialFilterExpression, { anomalyKey: { $type: 'string' } })
  assert.equal(ix[1].sparse, undefined, 'sparse would make keyless alerts collide on { userId, null }')
})

test('financial models require an ObjectId owner and have user-scoped indexes', { skip }, () => {
  for (const Model of [Transaction, Subscription, Alert]) {
    const path = Model.schema.path('userId')
    assert.ok(path, `${Model.modelName}.userId`)
    assert.equal(path.instance, 'ObjectId')
    assert.equal(path.isRequired, true)
  }
  assert.ok(find(Transaction, { userId: 1, date: -1 }))
  assert.ok(find(Transaction, { userId: 1, subscriptionId: 1 }))
  assert.ok(find(Subscription, { userId: 1, slug: 1 }))
  assert.ok(find(Alert, { userId: 1, createdAt: -1 }))
})

test('documents without an owner fail validation (no accidental unowned writes)', { skip }, () => {
  const tx = new Transaction({ date: new Date(), merchant: 'X', amount: 1 })
  assert.ok(tx.validateSync()?.errors.userId)
  const alert = new Alert({ type: 'duplicate', title: 't', description: 'd', impact: 'i', impactLabel: 'l' })
  assert.ok(alert.validateSync()?.errors.userId)
})

test('users: unique normalized email; password hash hidden from JSON', { skip }, () => {
  assert.equal(User.schema.path('email').options.unique, true)
  assert.equal(User.schema.path('email').options.lowercase, true)
  const user = new User({ name: 'A', email: '  A@B.CO ', passwordHash: '$argon2id$x' })
  assert.equal(user.email, 'a@b.co')
  assert.equal(JSON.parse(JSON.stringify(user)).passwordHash, undefined)
})

test('sessions: unique token hash and TTL expiry index', { skip }, () => {
  assert.equal(Session.schema.path('tokenHash').options.unique, true)
  const ttl = find(Session, { expiresAt: 1 })
  assert.equal(ttl[1].expireAfterSeconds, 0)
})

test('real mongoose casts the string ids used by ownedBy() filters', { skip }, () => {
  const id = new mongoose.Types.ObjectId().toString()
  const q = Transaction.find({ userId: id, _id: id })
  q.cast(Transaction)
  assert.ok(q.getFilter().userId instanceof mongoose.Types.ObjectId)
})

test('Phase 4.2: preference defaults and reviewStatus enum with real mongoose', { skip }, () => {
  const user = new User({ name: 'A', email: 'a@b.co', passwordHash: 'x' })
  assert.deepEqual(user.toObject().preferences.alerts, {
    priceIncrease: true, duplicate: true, serviceOverlap: true, inactivity: true, paymentAnomaly: true,
  })
  const bad = new User({ name: 'A', email: 'a@b.co', passwordHash: 'x', preferences: { alerts: { duplicate: 'maybe' } } })
  assert.ok(bad.validateSync()?.errors['preferences.alerts.duplicate'], 'non-boolean preference fails validation')

  const sub = new Subscription({ userId: new mongoose.Types.ObjectId(), name: 'N', category: 'C', amount: 1, nextBillingDate: new Date() })
  assert.equal(sub.reviewStatus, 'unreviewed')
  sub.reviewStatus = 'maybe'
  assert.ok(sub.validateSync()?.errors.reviewStatus)
})

test('Phase 4.3: recommendationFocus defaults to balanced and is enum-validated with real mongoose', { skip }, () => {
  const user = new User({ name: 'A', email: 'a@b.co', passwordHash: 'x' })
  assert.equal(user.preferences.recommendationFocus, 'balanced')
  const bad = new User({ name: 'A', email: 'a@b.co', passwordHash: 'x', preferences: { recommendationFocus: 'yolo' } })
  assert.ok(bad.validateSync()?.errors['preferences.recommendationFocus'])
  assert.equal(mongoose.modelNames().includes('Recommendation'), false, 'recommendations are computed, not persisted')
})
