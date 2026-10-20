// Phase 5.1 production-hardening tests: configuration validation (no network), plus HTTP checks
// against the real Express app with the IN-MEMORY fake database (npm run test:unit).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import mongoose from 'mongoose'
import { redactMongoUri, validateMongoUri } from '../src/config/db.js'
import { loadSecurityConfig, parseTrustProxy } from '../src/config/security.js'
import { createRateLimiter } from '../src/middleware/rateLimit.js'
import { Client, startServer } from './support/httpHarness.mjs'

const FAKE = Boolean(mongoose.__isFake)
const skip = !FAKE && 'requires the in-memory fake database (npm run test:unit)'
const PROD = { NODE_ENV: 'production', CLIENT_ORIGIN: 'https://app.example', TRUST_PROXY: '1' }

// ---------------------------------------------------------------- configuration validation
test('config: production requires an explicit https CLIENT_ORIGIN', () => {
  assert.throws(() => loadSecurityConfig({ NODE_ENV: 'production' }), /CLIENT_ORIGIN is required/)
  assert.throws(() => loadSecurityConfig({ ...PROD, CLIENT_ORIGIN: 'http://app.example' }), /https in production/)
  assert.deepEqual(loadSecurityConfig(PROD).trustedOrigins, ['https://app.example'])
  // Development keeps its localhost default.
  assert.deepEqual(loadSecurityConfig({}).trustedOrigins, ['http://localhost:5173'])
})

test('config: wildcard, null and non-origin CLIENT_ORIGIN values are rejected', () => {
  for (const bad of ['*', 'https://*.vercel.app', 'null', 'app.example', 'https://app.example/path', 'ftp://app.example', 'https://a.example,,*']) {
    assert.throws(() => loadSecurityConfig({ CLIENT_ORIGIN: bad }), /CLIENT_ORIGIN/, bad)
  }
  assert.deepEqual(
    loadSecurityConfig({ CLIENT_ORIGIN: 'https://a.example/, http://localhost:5173' }).trustedOrigins,
    ['https://a.example', 'http://localhost:5173'],
  )
})

test('config: invalid rate-limit values fail closed instead of disabling throttling', () => {
  for (const bad of ['abc', '0', '-5', '2.5', '1e3', '100000']) {
    assert.throws(() => loadSecurityConfig({ AUTH_RATE_LIMIT_MAX: bad }), /AUTH_RATE_LIMIT_MAX/, bad)
  }
  for (const bad of ['soon', '0', '999', String(25 * 60 * 60 * 1000)]) {
    assert.throws(() => loadSecurityConfig({ AUTH_RATE_LIMIT_WINDOW_MS: bad }), /AUTH_RATE_LIMIT_WINDOW_MS/, bad)
  }
  const ok = loadSecurityConfig({ AUTH_RATE_LIMIT_MAX: ' 50 ', AUTH_RATE_LIMIT_WINDOW_MS: '60000' })
  assert.deepEqual(ok.authRateLimit, { max: 50, windowMs: 60000 })
  assert.deepEqual(loadSecurityConfig({ AUTH_RATE_LIMIT_MAX: '' }).authRateLimit, { max: 20, windowMs: 900000 })
  // Defence in depth: the limiter itself refuses a NaN limit.
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: NaN }))
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 5 }))
})

test('config: TRUST_PROXY accepts hop counts, presets and subnets but never "trust everything"', () => {
  assert.equal(parseTrustProxy(undefined), false)
  assert.equal(parseTrustProxy('false'), false)
  assert.equal(parseTrustProxy('0'), false)
  assert.equal(parseTrustProxy('1'), 1)
  assert.equal(parseTrustProxy('loopback, 10.0.0.0/8'), 'loopback,10.0.0.0/8')
  assert.equal(parseTrustProxy('::1'), '::1')
  for (const bad of ['true', 'TRUE', 'yes', '11', '-1', '10.0.0.0/33', 'proxy.example', '1.2.3.4/8/9']) {
    assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, bad)
  }
})

test('config: COOKIE_SECURE and SESSION_TTL_HOURS are validated', () => {
  assert.throws(() => loadSecurityConfig({ COOKIE_SECURE: 'maybe' }), /COOKIE_SECURE/)
  assert.throws(() => loadSecurityConfig({ ...PROD, COOKIE_SECURE: 'false' }), /not allowed/)
  assert.equal(loadSecurityConfig({ COOKIE_SECURE: 'true' }).session.cookie.secure, true)
  assert.equal(loadSecurityConfig({}).session.cookie.secure, false)
  for (const bad of ['0', '-1', 'week', String(24 * 91)]) {
    assert.throws(() => loadSecurityConfig({ SESSION_TTL_HOURS: bad }), /SESSION_TTL_HOURS/, bad)
  }
})

test('config: production warnings for a missing proxy setting and cross-site cookies', () => {
  assert.deepEqual(loadSecurityConfig(PROD).warnings, [])
  const noProxy = loadSecurityConfig({ ...PROD, TRUST_PROXY: '' })
  assert.ok(noProxy.warnings.some((w) => /TRUST_PROXY/.test(w)))
  const crossSite = loadSecurityConfig({ ...PROD, COOKIE_SAMESITE: 'none' })
  assert.ok(crossSite.warnings.some((w) => /third-party cookie/.test(w)))
})

test('database URI is validated and never echoed', () => {
  const secret = 'mongodb+srv://alice:S3cretPass@cluster0.example.mongodb.net/subsense'
  assert.throws(() => validateMongoUri(''), /MONGO_URI is not set/)
  assert.throws(() => validateMongoUri('http://alice:S3cretPass@host/db'), (err) => !err.message.includes('S3cretPass'))
  assert.equal(validateMongoUri(` ${secret} `), secret)
  const redacted = redactMongoUri(`failed to connect to ${secret} (timeout)`)
  assert.ok(!redacted.includes('S3cretPass') && !redacted.includes('alice'))
  assert.match(redacted, /mongodb\+srv:\/\/<credentials>@cluster0/)
})

// ---------------------------------------------------------------- HTTP behaviour
let srv
before(async () => {
  if (FAKE) srv = await startServer()
})
after(async () => {
  if (srv) await srv.close()
})

async function freshUser(label) {
  mongoose.__resetAll()
  srv.app.locals.resetRateLimits()
  const c = new Client(srv.base)
  await c.register(label, `${label.toLowerCase().replace(/\W/g, '')}@example.com`)
  return c
}

test('security headers and no-store caching on API responses', { skip }, async () => {
  const res = await fetch(`${srv.base}/health`)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(res.headers.get('x-powered-by'), null)
  assert.equal(res.headers.get('strict-transport-security'), null, 'HSTS only in production')
})

test('readiness endpoint reports the database state without connection details', { skip }, async () => {
  const res = await fetch(`${srv.base}/health/ready`)
  const body = await res.json()
  // The in-memory fake is never "connected", so readiness is 503 here; liveness stays 200.
  assert.equal(res.status, 503)
  assert.deepEqual(body, { status: 'unavailable', database: 'disconnected' })
  assert.equal((await fetch(`${srv.base}/health`)).status, 200)
})

test('JSON bodies above 100 kB are rejected with 413; malformed JSON with 400', { skip }, async () => {
  const c = await freshUser('Body')
  const big = await c.post('/transactions', { date: '2026-01-01', merchant: 'X', amount: 1, notes: 'n'.repeat(120 * 1024) })
  assert.equal(big.status, 413)
  const malformed = await c.request('POST', '/transactions', { form: '{"date":', headers: { 'Content-Type': 'application/json' } })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.data.error, 'Malformed JSON body')
})

test('oversized CSV uploads return 413 (not 500) and store nothing', { skip }, async () => {
  const c = await freshUser('Upload')
  const row = '2026-01-01,SOME MERCHANT WITH A LONG NAME,100,HDFC\n'
  const huge = 'date,merchant,amount,account\n' + row.repeat(Math.ceil((2 * 1024 * 1024 + 10) / row.length))
  const res = await c.importCsv(huge)
  assert.equal(res.status, 413)
  assert.equal(res.data.code, 'UPLOAD_TOO_LARGE')
  assert.equal((await c.get('/transactions')).data.length, 0)
})

test('CSV with more than the maximum number of rows is rejected', { skip }, async () => {
  const c = await freshUser('Rows')
  const huge = 'date,merchant,amount\n' + '2026-01-01,A,1\n'.repeat(10_001)
  const res = await c.importCsv(huge)
  assert.equal(res.status, 413)
  assert.match(res.data.error, /too many rows/)
})

test('unexpected upload fields are a 400, not a server error', { skip }, async () => {
  const c = await freshUser('Field')
  const form = new FormData()
  form.append('other', new Blob(['date,merchant,amount\n2026-01-01,A,1\n'], { type: 'text/csv' }), 'a.csv')
  const res = await c.request('POST', '/transactions/import', { form })
  assert.equal(res.status, 400)
  assert.equal(res.data.code, 'UPLOAD_INVALID')
})

test('invalid ids are not echoed back in error responses', { skip }, async () => {
  const c = await freshUser('Ids')
  const res = await c.put('/subscriptions/%3Cscript%3E', { amount: 'not-a-number' })
  assert.ok([400, 404].includes(res.status))
  assert.ok(!JSON.stringify(res.data).includes('<script>'))
})

test('without TRUST_PROXY a spoofed X-Forwarded-For cannot dodge the login rate limit', { skip }, async () => {
  const limited = await startServer({ rateLimitMax: 2 })
  try {
    const attempt = (ip) => new Client(limited.base).post('/auth/login',
      { email: 'x@example.com', password: 'WrongPass99' }, { headers: { 'X-Forwarded-For': ip } })
    assert.equal((await attempt('1.1.1.1')).status, 401)
    assert.equal((await attempt('2.2.2.2')).status, 401)
    assert.equal((await attempt('3.3.3.3')).status, 429, 'the header is ignored: all attempts share the socket IP')
  } finally {
    await limited.close()
  }
})

test('with TRUST_PROXY=1 the client IP from one proxy hop is used for the per-IP limit', { skip }, async () => {
  const limited = await startServer({ rateLimitMax: 2, env: { TRUST_PROXY: '1' } })
  try {
    const attempt = (ip, email) => new Client(limited.base).post('/auth/login',
      { email, password: 'WrongPass99' }, { headers: { 'X-Forwarded-For': ip } })
    assert.equal((await attempt('1.1.1.1', 'a@example.com')).status, 401)
    assert.equal((await attempt('1.1.1.1', 'b@example.com')).status, 401)
    assert.equal((await attempt('1.1.1.1', 'c@example.com')).status, 429, 'same client IP is throttled')
    assert.equal((await attempt('9.9.9.9', 'd@example.com')).status, 401, 'a different client has its own budget')
    // A client-supplied extra hop is not trusted: only the right-most (proxy-added) entry counts.
    assert.equal((await attempt('8.8.8.8, 1.1.1.1', 'e@example.com')).status, 429)
  } finally {
    await limited.close()
  }
})

test('production: cross-origin credentialed requests from an untrusted site are refused', { skip }, async () => {
  const prod = await startServer({ env: PROD })
  try {
    const good = new Client(prod.base, { origin: PROD.CLIENT_ORIGIN })
    const reg = await good.register('Prod User', 'prod@example.com')
    assert.match(reg.headers.get('set-cookie'), /HttpOnly/i)
    assert.match(reg.headers.get('set-cookie'), /Secure/i)
    assert.match(reg.headers.get('set-cookie'), /SameSite=Lax/i)
    assert.match(reg.headers.get('set-cookie'), /Path=\/api/i)
    assert.ok((await fetch(`${prod.base}/health`)).headers.get('strict-transport-security'))

    const evil = new Client(prod.base, { origin: 'https://evil.example' })
    evil.cookie = good.cookie
    evil.csrfToken = good.csrfToken
    const res = await evil.post('/transactions', { date: '2026-01-01', merchant: 'X', amount: 1 })
    assert.equal(res.status, 403)
    assert.equal(res.data.code, 'ORIGIN_REJECTED')
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  } finally {
    await prod.close()
  }
})
