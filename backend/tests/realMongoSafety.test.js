// Phase 5.1: the safety gate for real-MongoDB tests (tests/support/realMongo.mjs) must fail closed.
// Pure checks — no database connection is ever opened here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { describeMongoUri, resolveRealMongoTarget } from './support/realMongo.mjs'

const LOCAL = 'mongodb://127.0.0.1:27017/subsense_test'
const ATLAS_TEST = 'mongodb+srv://ci-user:Pw0rd@test-cluster.example.mongodb.net/subsense_test_ci?retryWrites=true'
const ATLAS_APP = 'mongodb+srv://app-user:Secr3t@prod-cluster.example.mongodb.net/subsense?retryWrites=true'

test('real-DB tests are disabled unless explicitly opted in', () => {
  assert.equal(resolveRealMongoTarget({}).enabled, false)
  // Even a perfectly valid TEST_MONGO_URI does nothing without the opt-in.
  assert.equal(resolveRealMongoTarget({ TEST_MONGO_URI: LOCAL }).enabled, false)
  assert.equal(resolveRealMongoTarget({ SUBSENSE_REAL_DB_TESTS: 'true', TEST_MONGO_URI: LOCAL }).enabled, false)
})

test('opted in without TEST_MONGO_URI fails closed; MONGO_URI is never used as a fallback', () => {
  assert.throws(() => resolveRealMongoTarget({ SUBSENSE_REAL_DB_TESTS: '1' }), /TEST_MONGO_URI is not set/)
  assert.throws(() => resolveRealMongoTarget({ SUBSENSE_REAL_DB_TESTS: '1', MONGO_URI: LOCAL }), /TEST_MONGO_URI is not set/)
})

test('the database name must be an unmistakable test database', () => {
  for (const uri of [
    'mongodb://127.0.0.1:27017/subsense',
    'mongodb://127.0.0.1:27017/',
    'mongodb://127.0.0.1:27017',
    'mongodb://127.0.0.1:27017/test',
    'mongodb://127.0.0.1:27017/my_subsense_test',
    'mongodb://127.0.0.1:27017/subsense_testing',
    'mongodb://127.0.0.1:27017/Subsense_Test',
    'mongodb://127.0.0.1:27017/subsense_test-prod',
  ]) {
    assert.throws(() => resolveRealMongoTarget({ SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: uri }), /must start with "subsense_test"/, uri)
  }
  const ok = resolveRealMongoTarget({ SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: LOCAL })
  assert.deepEqual({ ...ok, uri: undefined }, { enabled: true, uri: undefined, baseDbName: 'subsense_test', isLocal: true })
})

test('production mode, the application URI and remote hosts are refused', () => {
  const env = { SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: LOCAL }
  assert.throws(() => resolveRealMongoTarget({ ...env, NODE_ENV: 'production' }), /NODE_ENV=production/)
  assert.throws(() => resolveRealMongoTarget({ ...env, MONGO_URI: LOCAL }), /identical to MONGO_URI/)
  // Remote (e.g. Atlas) targets need a second, explicit acknowledgement.
  assert.throws(() => resolveRealMongoTarget({ SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: ATLAS_TEST }), /not a local server/)
  const remote = resolveRealMongoTarget({ SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: ATLAS_TEST, SUBSENSE_REAL_DB_ALLOW_REMOTE: '1', MONGO_URI: ATLAS_APP })
  assert.equal(remote.enabled, true)
  assert.equal(remote.isLocal, false)
  // Same cluster AND same database name as the application is refused even with every flag set.
  assert.throws(() => resolveRealMongoTarget({
    SUBSENSE_REAL_DB_TESTS: '1', SUBSENSE_REAL_DB_ALLOW_REMOTE: '1',
    TEST_MONGO_URI: 'mongodb+srv://x:y@prod-cluster.example.mongodb.net/subsense_test',
    MONGO_URI: 'mongodb+srv://a:b@prod-cluster.example.mongodb.net/subsense_test',
  }), /same host and database/)
})

test('error messages never contain the credentials of either URI', () => {
  const cases = [
    { SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: 'mongodb+srv://ci-user:Pw0rd@test-cluster.example.mongodb.net/subsense' },
    { SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: ATLAS_TEST },
    { SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: ATLAS_APP, MONGO_URI: ATLAS_APP },
    { SUBSENSE_REAL_DB_TESTS: '1', TEST_MONGO_URI: 'https://ci-user:Pw0rd@example.com/subsense_test' },
  ]
  for (const env of cases) {
    assert.throws(() => resolveRealMongoTarget(env), (err) => !/Pw0rd|Secr3t|ci-user|app-user/.test(err.message))
  }
})

test('URI description extracts hosts and database without credentials', () => {
  const info = describeMongoUri(ATLAS_TEST)
  assert.deepEqual(info, { scheme: 'mongodb+srv', hosts: ['test-cluster.example.mongodb.net'], dbName: 'subsense_test_ci', isLocal: false })
  assert.equal(describeMongoUri('mongodb://localhost:27017,127.0.0.1:27018/subsense_test').isLocal, true)
  assert.equal(describeMongoUri('not a uri'), null)
})

test('the real-DB suite is excluded from the unit run and never reads backend/.env', () => {
  const runUnit = readFileSync(new URL('./support/run-unit.mjs', import.meta.url), 'utf8')
  assert.match(runUnit, /readdirSync\(testsDir\)/, 'unit runner only lists top-level test files (tests/realdb is a subfolder)')
  for (const file of ['./support/realMongo.mjs', './support/run-real-mongo.mjs', './support/run-real-mongo-local.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /dotenv/, `${file} must not load .env files`)
  }
})

test('the legacy migration is never imported by application startup', () => {
  for (const file of ['../src/server.js', '../src/app.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /migrations|legacyOwnership|dropIndex|syncIndexes/, file)
  }
})
