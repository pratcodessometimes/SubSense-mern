// Phase 5.1 — runs the real-MongoDB test suite (tests/realdb) against TEST_MONGO_URI.
// The safety gate (support/realMongo.mjs) is checked here first and again in every test file.
//
//   SUBSENSE_REAL_DB_TESTS=1 TEST_MONGO_URI=mongodb://127.0.0.1:27017/subsense_test npm run test:mongo
//
// For a throwaway local server started and stopped automatically, use `npm run test:mongo:local`.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRealMongoTarget } from './realMongo.mjs'

let target
try {
  target = resolveRealMongoTarget()
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
if (!target.enabled) {
  console.error(`Not running: ${target.reason}`)
  process.exit(1)
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'realdb')
// SUBSENSE_REAL_DB_FILES (optional): comma-separated file names to run instead of every file.
const only = (process.env.SUBSENSE_REAL_DB_FILES || '').split(',').map((f) => f.trim()).filter(Boolean)
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js') && (only.length === 0 || only.includes(f)))
  .sort()
  .map((f) => join(dir, f))
if (files.length === 0) {
  console.error('No real-MongoDB test files selected')
  process.exit(1)
}
// One file at a time: each creates and drops its own database, but serial runs keep timing simple.
// Extra arguments are passed to node --test, e.g. `-- --test-name-pattern=migration`.
const res = spawnSync(
  process.execPath,
  // --test-force-exit: a file whose tests finished must not idle on a leftover handle (e.g. a socket)
  // until the timeout. A hung test still fails after --test-timeout (5 min per file/test).
  ['--test', '--test-concurrency=1', '--test-timeout=300000', '--test-force-exit', ...process.argv.slice(2), ...files],
  { stdio: 'inherit', env: process.env },
)
process.exit(res.status ?? 1)
