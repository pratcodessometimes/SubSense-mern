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
  diagnosticsUri = target.uri
  mongoose.set('strictQuery', true)
  // autoIndex is off so index creation is explicit and awaited below (same calls as autoIndex).
  await traced(`setup ${dbName}: connect`, () => mongoose.connect(target.uri, { dbName, autoIndex: false, serverSelectionTimeoutMS: 15_000 }))
  const db = mongoose.connection.db
  const existing = await traced(`setup ${dbName}: listCollections`, () => db.listCollections({}, { nameOnly: true }).toArray())
  if (existing.length > 0) {
    await mongoose.disconnect()
    throw new Error(`Refusing to use test database ${dbName}: it already contains collections`)
  }
  await traced(`setup ${dbName}: insert run marker`, () => db.collection(MARKER_COLLECTION).insertOne({ runId, startedAt: new Date() }))
  for (const Model of MODELS) await traced(`setup ${dbName}: ${Model.modelName}.createIndexes`, () => Model.createIndexes())
  console.log(`# real MongoDB: ${target.isLocal ? 'local' : 'remote'} server, run database ${dbName}`)
  return { runId, dbName }
}

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms).unref())])

// Set by connectRealTestDatabase; diagnostics open their OWN connection, so a wedged pool or a
// blocked operation on the test connection cannot also block the diagnostics.
let diagnosticsUri = null

/**
 * Runs one MongoDB step with a start marker and a short watchdog. A step that does not finish in
 * `timeoutMs` prints what the server is doing WHILE it is stuck (see printServerDiagnostics) and
 * fails with the step name, instead of idling until the 5-minute test timeout. The step's own
 * result or error (e.g. an expected E11000) is passed through unchanged.
 */
export async function traced(label, fn, { timeoutMs = 30_000 } = {}) {
  console.log(`# step: ${label}`)
  const started = Date.now()
  let timer
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      printServerDiagnostics(diagnosticsUri, `step "${label}" still running after ${timeoutMs} ms`)
        .finally(() => reject(new Error(`MongoDB step "${label}" did not finish within ${timeoutMs} ms (diagnostics above)`)))
    }, timeoutMs)
  })
  try {
    return await Promise.race([fn(), watchdog])
  } finally {
    clearTimeout(timer)
    const ms = Date.now() - started
    if (ms >= 2000) console.log(`# step slow: ${label} took ${ms} ms`)
  }
}

/**
 * Prints, over a separate short-lived connection: in-progress operations (lock waits, index
 * builds, DDL), the global lock queue, whether a WiredTiger checkpoint is running, and recent
 * warning / slow-operation lines from the server's in-memory log. Never prints the URI.
 */
export async function printServerDiagnostics(uri, title) {
  console.log(`# diagnostics: ${title}; test connection readyState=${mongoose.connection.readyState}`)
  if (!uri) return console.log('#   no server URI recorded; nothing to inspect')
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 })
  try {
    await withTimeout(conn.asPromise(), 10_000, 'diagnostics connect')
    const admin = conn.db.admin()
    const { inprog } = await withTimeout(admin.command({ currentOp: 1, $all: true }), 10_000, 'currentOp')
    const busy = inprog.filter((op) => op.command?.currentOp === undefined &&
      ((op.active && op.op !== 'none') || op.waitingForLock || /IndexBuild|Drop|Reaper|Checkpoint/i.test(op.desc || '')))
    console.log(`#   ${busy.length} busy operation(s):`)
    for (const op of busy) {
      console.log(`#   ${JSON.stringify({ desc: op.desc, op: op.op, ns: op.ns, cmd: Object.keys(op.command || {})[0], secs: op.secs_running, waitingForLock: op.waitingForLock, msg: op.msg, locks: op.locks, flowControl: op.flowControlStats })}`)
    }
    const status = await withTimeout(admin.command({ serverStatus: 1 }), 10_000, 'serverStatus')
    const checkpoint = status.wiredTiger?.checkpoint || {} // MongoDB 8.0 layout
    console.log(`#   globalLock.currentQueue=${JSON.stringify(status.globalLock?.currentQueue)} checkpointProgressState=${checkpoint['progress state']} lastCheckpointMs=${checkpoint['most recent time (msecs)']}`)
    const { log = [] } = await withTimeout(admin.command({ getLog: 'global' }), 10_000, 'getLog')
    const notable = log.filter((line) => /"s":"(W|E|F)"|Slow query|"c":"(STORAGE|INDEX|WT\w*)"/.test(line)).slice(-25)
    console.log(`#   last ${notable.length} warning/slow/storage log line(s):`)
    for (const line of notable) console.log(`#   ${line.trim().slice(0, 1500)}`)
  } catch (err) {
    console.log(`#   server did not answer diagnostics (${err.message})`)
  } finally {
    await withTimeout(conn.close(true), 5000, 'diagnostics close').catch(() => {})
  }
}

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
    console.log(`# step: teardown ${dbName}: disconnect (disposable server, no drop)`)
    await withTimeout(mongoose.disconnect(), 10_000, 'disconnect').catch(() => {})
    return
  }
  console.log(`# step: teardown ${dbName}: drop run database`)
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
