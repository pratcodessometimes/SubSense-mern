// Phase 5.1 — safety gate and lifecycle for tests that use a REAL MongoDB server.
//
// These tests must never touch an application database. They run only when ALL of these hold
// (anything else fails closed with an error, never a silent fallback):
//   SUBSENSE_REAL_DB_TESTS=1                      explicit opt-in for this run
//   TEST_MONGO_URI=mongodb://.../subsense_test    separate variable; MONGO_URI is NEVER used
//   database name starts with "subsense_test"     unmistakably a test database
//   NODE_ENV is not "production"
//   TEST_MONGO_URI differs from MONGO_URI
//   a non-local host also needs SUBSENSE_REAL_DB_ALLOW_REMOTE=1
//
// Each test file then works in its OWN database "<name>_r<random>", which it verifies is empty,
// marks with a run id, and drops at the end (only after re-checking that marker). Nothing that
// existed before the run is ever modified or dropped. Connection strings are never printed.
import { randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import { Alert } from '../../src/models/Alert.js'
import { Session } from '../../src/models/Session.js'
import { Subscription } from '../../src/models/Subscription.js'
import { Transaction } from '../../src/models/Transaction.js'
import { User } from '../../src/models/User.js'

export const TEST_DB_NAME = /^subsense_test(?:_[a-z0-9]+)*$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const MARKER_COLLECTION = '_subsense_test_run'
export const MODELS = [User, Session, Transaction, Subscription, Alert]

/** Splits a mongodb:// or mongodb+srv:// URI without ever returning the credentials. */
export function describeMongoUri(uri) {
  const m = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]*)(?:\/([^?]*))?(?:\?(.*))?$/.exec(String(uri || '').trim())
  if (!m) return null
  const hosts = m[2].split(',').map((h) => h.replace(/:\d+$/, '').toLowerCase()).filter(Boolean)
  let dbName = ''
  try {
    dbName = decodeURIComponent(m[3] || '')
  } catch {
    dbName = m[3] || ''
  }
  return { scheme: m[1], hosts, dbName, isLocal: m[1] === 'mongodb' && hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.has(h)) }
}

/**
 * Decides whether real-database tests may run.
 * @returns {{ enabled: false, reason: string } | { enabled: true, uri: string, baseDbName: string, isLocal: boolean }}
 * @throws when the run is opted in but a safety condition is not met (fail closed)
 */
export function resolveRealMongoTarget(env = process.env) {
  if (env.SUBSENSE_REAL_DB_TESTS !== '1') {
    return { enabled: false, reason: 'real-MongoDB tests are opt-in: set SUBSENSE_REAL_DB_TESTS=1 and TEST_MONGO_URI (see backend/docs/PHASE_5_1_PRODUCTION_READINESS.md)' }
  }
  const fail = (msg) => { throw new Error(`Refusing to run real-MongoDB tests: ${msg}`) }
  const uri = String(env.TEST_MONGO_URI || '').trim()
  if (!uri) fail('TEST_MONGO_URI is not set (MONGO_URI is never used as a fallback)')
  if (env.NODE_ENV === 'production') fail('NODE_ENV=production')
  if (env.MONGO_URI && uri === String(env.MONGO_URI).trim()) fail('TEST_MONGO_URI is identical to MONGO_URI')

  const info = describeMongoUri(uri)
  if (!info) fail('TEST_MONGO_URI is not a mongodb:// or mongodb+srv:// URI (value not shown)')
  if (!TEST_DB_NAME.test(info.dbName)) {
    fail(`the database name in TEST_MONGO_URI must start with "subsense_test" (lowercase letters, digits, "_"); got ${JSON.stringify(info.dbName)}`)
  }
  if (info.dbName.length > 40) fail('the test database name must be at most 40 characters')
  const appDb = env.MONGO_URI ? describeMongoUri(env.MONGO_URI) : null
  if (appDb && appDb.dbName === info.dbName && appDb.hosts.join(',') === info.hosts.join(',')) {
    fail('TEST_MONGO_URI points at the same host and database as MONGO_URI')
  }
  if (!info.isLocal && env.SUBSENSE_REAL_DB_ALLOW_REMOTE !== '1') {
    fail('TEST_MONGO_URI is not a local server; set SUBSENSE_REAL_DB_ALLOW_REMOTE=1 only for a dedicated, disposable test cluster')
  }
  return { enabled: true, uri, baseDbName: info.dbName, isLocal: info.isLocal }
}

/**
 * Connects mongoose to a fresh, empty, run-owned database and builds the schema indexes exactly
 * as application startup does (Model.createIndexes: additive only, never drops).
 */
export async function connectRealTestDatabase(target) {
  const runId = randomBytes(4).toString('hex')
  const dbName = `${target.baseDbName}_r${runId}`
  mongoose.set('strictQuery', true)
  // autoIndex is off so index creation is explicit and awaited below (same calls as autoIndex).
  await mongoose.connect(target.uri, { dbName, autoIndex: false, serverSelectionTimeoutMS: 15_000 })
  const db = mongoose.connection.db
  const existing = await db.listCollections({}, { nameOnly: true }).toArray()
  if (existing.length > 0) {
    await mongoose.disconnect()
    throw new Error(`Refusing to use test database ${dbName}: it already contains collections`)
  }
  await db.collection(MARKER_COLLECTION).insertOne({ runId, startedAt: new Date() })
  for (const Model of MODELS) await Model.createIndexes()
  console.log(`# real MongoDB: ${target.isLocal ? 'local' : 'remote'} server, run database ${dbName}`)
  return { runId, dbName }
}

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms).unref())])

/**
 * Drops ONLY the run database, after confirming it is the one this run created. Bounded in time:
 * if MongoDB cannot drop it, the name is printed for manual cleanup instead of hanging the run.
 */
export async function dropRealTestDatabase({ runId, dbName }) {
  if (mongoose.connection.readyState !== 1) return
  const db = mongoose.connection.db
  // The auto-started local server (npm run test:mongo:local) is destroyed together with its data
  // directory, so there is nothing to drop. Skipping DDL here also avoids WiredTiger file-removal
  // stalls observed with a local mongod on Windows.
  if (process.env.SUBSENSE_REAL_DB_DISPOSABLE_SERVER === '1') {
    await withTimeout(mongoose.disconnect(), 10_000, 'disconnect').catch(() => {})
    return
  }
  try {
    await waitForIndexBuilds({ timeoutMs: 60_000 }).catch(() => {})
    const marker = await withTimeout(db.collection(MARKER_COLLECTION).findOne({ runId }), 10_000, 'marker check')
    if (db.databaseName === dbName && TEST_DB_NAME.test(dbName) && marker) {
      await withTimeout(db.dropDatabase(), 30_000, 'dropDatabase')
    } else {
      console.warn(`# real MongoDB: run marker not found; database ${db.databaseName} was NOT dropped`)
    }
  } catch (err) {
    console.warn(`# real MongoDB: could not drop run database ${dbName} (${err.message}); remove it manually`)
  } finally {
    await withTimeout(mongoose.disconnect(), 10_000, 'disconnect').catch(() => {})
  }
}

/** Removes every document in the run database (between tests). Only valid inside a run database. */
export async function clearRunDatabase({ dbName }) {
  if (mongoose.connection.db.databaseName !== dbName) throw new Error('not connected to the run database')
  for (const Model of MODELS) await Model.deleteMany({})
}

/**
 * Waits until MongoDB has no index build in progress. Observed on MongoDB 8.0: a unique index build
 * rejected for duplicate keys returns its error at once, but its build coordinator lingers for about
 * 30 s, and collection DDL (drop, dropIndexes) waits behind it. Reads and writes are unaffected.
 */
export async function waitForIndexBuilds({ timeoutMs = 90_000 } = {}) {
  const admin = mongoose.connection.db.admin()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { inprog } = await admin.command({ currentOp: 1, $all: true })
    if (!inprog.some((op) => /IndexBuild/.test(op.desc || ''))) return
    if (Date.now() > deadline) throw new Error('index build still in progress')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
