// Phase 5.1 — runs the real-MongoDB suite against disposable local mongod servers (official
// MongoDB binaries via the mongodb-memory-server dev dependency). Each test file gets its OWN
// fresh server, which is stopped and whose data directory is deleted afterwards. Never reads
// MONGO_URI or backend/.env.
//
//   npm run test:mongo:local
//   npm run test:mongo:local -- --test-name-pattern=migration      (extra args go to node --test)
//
// One server per file, so no state carries over between files.
//
// The test process MUST be started asynchronously (never spawnSync). mongodb-memory-server reads
// mongod's stdout through a pipe on THIS process's event loop. A blocked event loop stops draining
// that pipe; once it fills (64 KB on Linux), mongod blocks on its next log write and the whole
// server freezes: queries, DDL and even new connections hang until the test process is killed.
// That was the CI hang in anomalyIndexMigration.realdb.test.js, whose index builds log heavily.
//
// The binary version is pinned in package.json ("config.mongodbMemoryServer.version") to the
// MongoDB major used by Atlas; the first run downloads it (~75 MB) into node_modules/.cache.
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { printServerDiagnostics } from './realMongo.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const runner = join(here, 'run-real-mongo.mjs')
const files = readdirSync(join(here, '..', 'realdb')).filter((f) => f.endsWith('.test.js')).sort()
const pinnedVersion = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).config?.mongodbMemoryServer?.version

let failed = 0
for (const file of files) {
  const server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } })
  try {
    console.log(`# ${file}: disposable mongod ${process.env.MONGOMS_VERSION || pinnedVersion || ''} on 127.0.0.1:${server.instanceInfo?.port}`)
    const env = {
      ...process.env,
      SUBSENSE_REAL_DB_TESTS: '1',
      TEST_MONGO_URI: server.getUri('subsense_test_local'),
      SUBSENSE_REAL_DB_ALLOW_REMOTE: '',
      // This server and its data directory are destroyed below; test files need not drop their databases.
      SUBSENSE_REAL_DB_DISPOSABLE_SERVER: '1',
      SUBSENSE_REAL_DB_FILES: file,
    }
    delete env.MONGO_URI // never visible to the test processes
    const status = await new Promise((resolve) => {
      const child = spawn(process.execPath, [runner, ...process.argv.slice(2)], { stdio: 'inherit', env })
      child.on('error', () => resolve(1))
      child.on('close', (code) => resolve(code ?? 1))
    })
    if (status !== 0) {
      failed++
      // Server state after the failure (in-test watchdogs print it while a step is stuck).
      await printServerDiagnostics(server.getUri(), `${file} failed`)
    }
  } finally {
    await server.stop({ doCleanup: true, force: true })
  }
}
console.log(`# real-MongoDB files: ${files.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
