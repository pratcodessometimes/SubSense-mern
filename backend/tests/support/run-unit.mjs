// Runs every backend test except the live-server API test, with the in-memory
// database fake. Never connects to MongoDB.   Usage: npm run test:unit
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js') && f !== 'api.integration.test.js')
  .sort()
  .map((f) => join(testsDir, f))

const register = pathToFileURL(join(testsDir, 'support', 'register.mjs')).href
const res = spawnSync(process.execPath, ['--import', register, '--test', ...files], { stdio: 'inherit' })
process.exit(res.status ?? 1)
