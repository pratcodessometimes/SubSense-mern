// Phase 4.1 authentication & session security tests.
// HTTP-level tests against the real Express app with the IN-MEMORY fake database
// (npm run test:unit). They skip themselves if the real mongoose package is loaded.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import { loadSecurityConfig } from '../src/config/security.js'
import { Session } from '../src/models/Session.js'
import { User } from '../src/models/User.js'
import {
  csrfTokenMatches,
  deriveCsrfToken,
  hashPassword,
  hashSessionToken,
  validatePassword,
  verifyPassword,
} from '../src/services/authService.js'
import { Client, startServer } from './support/httpHarness.mjs'

const FAKE = Boolean(mongoose.__isFake)
const skip = !FAKE && 'requires the in-memory fake database (npm run test:unit)'

let srv
before(async () => {
  if (FAKE) srv = await startServer()
})
after(async () => {
  if (srv) await srv.close()
})
beforeEach(() => {
  if (!FAKE) return
  mongoose.__resetAll()
  srv.app.locals.resetRateLimits()
})

const client = () => new Client(srv.base)

// ---------------------------------------------------------------- registration
test('register: creates the account, hashes the password and starts a secure session', { skip }, async () => {
  const c = client()
  const res = await c.post('/auth/register', { name: '  Asha  ', email: '  Asha@Example.COM ', password: 'CorrectHorse9' })
  assert.equal(res.status, 201)
  assert.deepEqual(Object.keys(res.data.user).sort(), ['createdAt', 'email', 'id', 'name', 'preferences'])
  assert.deepEqual(res.data.user.preferences, {
    alerts: { priceIncrease: true, duplicate: true, serviceOverlap: true, inactivity: true, paymentAnomaly: true },
  }, 'Phase 4.2: every alert category defaults to visible')
  assert.equal(res.data.user.email, 'asha@example.com', 'email is normalized')
  assert.equal(res.data.user.name, 'Asha')
  assert.ok(!JSON.stringify(res.data).includes('passwordHash'))
  assert.ok(!JSON.stringify(res.data).includes('$argon2'))
  assert.equal(typeof res.data.csrfToken, 'string')

  const [cookie] = c.lastSetCookie
  assert.match(cookie, /^subsense_session=[A-Za-z0-9_-]{43};/)
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Lax/i)
  assert.match(cookie, /Path=\/api/i)
  assert.doesNotMatch(cookie, /Secure/i, 'not Secure outside production by default')

  const [user] = User.__all()
  assert.match(user.passwordHash, /^\$argon2id\$/)
  assert.ok(!user.passwordHash.includes('CorrectHorse9'))

  // Only the token hash is stored server-side.
  const token = c.cookie.split('=')[1]
  const [session] = Session.__all()
  assert.equal(session.tokenHash, hashSessionToken(token))
  assert.notEqual(session.tokenHash, token)
  assert.equal(String(session.userId), res.data.user.id)
})

test('register: rejects a duplicate email (case-insensitive) with 409', { skip }, async () => {
  await client().register('A', 'dup@example.com')
  const res = await client().post('/auth/register', { name: 'B', email: 'DUP@example.com', password: 'AnotherPass9' })
  assert.equal(res.status, 409)
  assert.equal(res.data.fields.email, 'Email is already registered')
  assert.equal(User.__all().length, 1)
})

test('register: validates name, email and password', { skip }, async () => {
  const cases = [
    [{ name: '', email: 'a@b.co', password: 'GoodPass99' }, 'name'],
    [{ name: 'X', email: 'not-an-email', password: 'GoodPass99' }, 'email'],
    [{ name: 'X', email: 'a@b.co', password: 'short1' }, 'password'],
    [{ name: 'X', email: 'a@b.co', password: 'lettersonly' }, 'password'],
    [{ name: 'X', email: 'a@b.co', password: '1234567890' }, 'password'],
    [{ name: 'X', email: 'a@b.co', password: `A1${'x'.repeat(200)}` }, 'password'],
    [{ name: 'X', email: { $ne: null }, password: 'GoodPass99' }, 'email'],
  ]
  for (const [body, field] of cases) {
    const res = await client().post('/auth/register', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.ok(res.data.fields[field], `expected a ${field} error for ${JSON.stringify(body).slice(0, 60)}`)
  }
  assert.equal(User.__all().length, 0)
})

test('register: ignores mass-assigned fields such as _id and passwordHash', { skip }, async () => {
  const res = await client().post('/auth/register', {
    name: 'M', email: 'mass@example.com', password: 'CorrectHorse9', passwordHash: 'plain', _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', role: 'admin',
  })
  assert.equal(res.status, 201)
  const [user] = User.__all()
  assert.notEqual(user._id, 'aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.match(user.passwordHash, /^\$argon2id\$/)
  assert.equal(user.role, undefined)
})

test('password hashing: Argon2id hashes are salted and verify correctly', { skip }, async () => {
  const h1 = await hashPassword('CorrectHorse9')
  const h2 = await hashPassword('CorrectHorse9')
  assert.match(h1, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)
  assert.notEqual(h1, h2, 'random salt per hash')
  assert.equal(await verifyPassword(h1, 'CorrectHorse9'), true)
  assert.equal(await verifyPassword(h1, 'correcthorse9'), false)
  assert.equal(await verifyPassword('not-a-hash', 'x'), false)
  assert.equal(validatePassword('CorrectHorse9'), null)
})

// ---------------------------------------------------------------- login
test('login: valid credentials start a new session; the session works across requests', { skip }, async () => {
  await client().register('Asha', 'asha@example.com')
  const c = client()
  const res = await c.post('/auth/login', { email: ' ASHA@example.com ', password: 'CorrectHorse9' })
  assert.equal(res.status, 200)
  assert.equal(res.data.user.email, 'asha@example.com')
  assert.ok(c.cookie)

  for (let i = 0; i < 3; i++) {
    const me = await c.get('/auth/me')
    assert.equal(me.status, 200)
    assert.equal(me.data.user.email, 'asha@example.com')
    assert.equal(me.data.csrfToken, res.data.csrfToken, 'CSRF token is stable for the session')
  }
  assert.equal((await c.get('/transactions')).status, 200)
  assert.equal((await c.post('/transactions', { date: '2026-01-01', merchant: 'X', amount: 1 })).status, 201)
})

test('login: wrong password and unknown email get the same generic 401', { skip }, async () => {
  await client().register('Asha', 'asha@example.com')
  const wrong = await client().post('/auth/login', { email: 'asha@example.com', password: 'WrongPass99' })
  const unknown = await client().post('/auth/login', { email: 'nobody@example.com', password: 'WrongPass99' })
  assert.equal(wrong.status, 401)
  assert.equal(unknown.status, 401)
  assert.deepEqual(wrong.data, unknown.data)
  assert.deepEqual(wrong.data, { error: 'Invalid email or password' })
  assert.equal(Session.__all().length, 1, 'only the registration session exists')
  const missing = await client().post('/auth/login', { email: 'asha@example.com' })
  assert.equal(missing.status, 400)
})

test('login: rotates the session (an existing session cookie is revoked)', { skip }, async () => {
  const c = client()
  await c.register('Asha', 'asha@example.com')
  const firstCookie = c.cookie
  await c.post('/auth/login', { email: 'asha@example.com', password: 'CorrectHorse9' })
  assert.notEqual(c.cookie, firstCookie)
  assert.equal(Session.__all().length, 1)
  const stale = new Client(srv.base)
  stale.cookie = firstCookie
  assert.equal((await stale.get('/auth/me')).status, 401)
})

// ---------------------------------------------------------------- authorization
test('unauthenticated requests to every private API return 401; /api/health stays public', { skip }, async () => {
  const c = client()
  assert.equal((await c.get('/health')).status, 200)
  const calls = [
    ['GET', '/auth/me'], ['POST', '/auth/logout'],
    ['GET', '/transactions'], ['POST', '/transactions'], ['GET', '/transactions/000000000000000000000001'],
    ['PUT', '/transactions/000000000000000000000001'], ['DELETE', '/transactions/000000000000000000000001'],
    ['POST', '/transactions/import'], ['POST', '/transactions/analyze'],
    ['GET', '/subscriptions'], ['POST', '/subscriptions'], ['GET', '/subscriptions/netflix'],
    ['PUT', '/subscriptions/netflix'], ['DELETE', '/subscriptions/netflix'],
    ['GET', '/alerts'], ['POST', '/alerts'], ['DELETE', '/alerts/000000000000000000000001'],
    ['GET', '/analytics/kpis'], ['GET', '/analytics/categories'],
  ]
  for (const [method, path] of calls) {
    const res = await c.request(method, path, { json: method === 'GET' ? undefined : {} })
    assert.equal(res.status, 401, `${method} ${path}`)
    assert.equal(res.data.code, 'UNAUTHENTICATED')
  }
})

test('identity is never taken from headers, query or body without a session', { skip }, async () => {
  const c = client()
  await c.register('Asha', 'asha@example.com')
  const anon = client()
  const forged = await anon.get(`/transactions?userId=${c.user.id}`, { headers: { 'X-User-Id': c.user.id, Authorization: `Bearer ${c.user.id}` } })
  assert.equal(forged.status, 401)
})

test('malformed and unknown session cookies are rejected and cleared', { skip }, async () => {
  for (const value of ['garbage', 'a'.repeat(43), '%E0%A4%A', '']) {
    const c = client()
    c.cookie = `subsense_session=${value}`
    const res = await c.get('/transactions')
    assert.equal(res.status, 401, value)
  }
})

test('session expiration: an expired session is rejected and removed', { skip }, async () => {
  const c = client()
  await c.register('Asha', 'asha@example.com')
  assert.equal((await c.get('/auth/me')).status, 200)
  await Session.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })
  const res = await c.get('/transactions')
  assert.equal(res.status, 401)
  assert.equal(c.cookie, null, 'expired cookie is cleared')
  assert.equal(Session.__all().length, 0, 'expired session is deleted')
})

test('session TTL comes from SESSION_TTL_HOURS', () => {
  const config = loadSecurityConfig({ SESSION_TTL_HOURS: '2' })
  assert.equal(config.session.ttlMs, 2 * 60 * 60 * 1000)
  assert.throws(() => loadSecurityConfig({ SESSION_TTL_HOURS: '-1' }))
})

test('logout revokes the session server-side and clears the cookie', { skip }, async () => {
  const c = client()
  await c.register('Asha', 'asha@example.com')
  const stolenCookie = c.cookie
  const res = await c.post('/auth/logout', {})
  assert.equal(res.status, 200)
  assert.equal(c.cookie, null)
  assert.equal(Session.__all().length, 0)

  // A copy of the old cookie (e.g. stolen) no longer works anywhere.
  const replay = client()
  replay.cookie = stolenCookie
  assert.equal((await replay.get('/auth/me')).status, 401)
  assert.equal((await replay.get('/transactions')).status, 401)
  assert.equal((await replay.post('/transactions', { date: '2026-01-01', merchant: 'X', amount: 1 })).status, 401)
})

test('logout of one session leaves the user\'s other sessions intact', { skip }, async () => {
  const laptop = client()
  await laptop.register('Asha', 'asha@example.com')
  const phone = client()
  await phone.post('/auth/login', { email: 'asha@example.com', password: 'CorrectHorse9' })
  await laptop.post('/auth/logout', {})
  assert.equal((await laptop.get('/auth/me')).status, 401)
  assert.equal((await phone.get('/auth/me')).status, 200)
})

// ---------------------------------------------------------------- CSRF / origin
test('CSRF: authenticated mutations require the session-bound token', { skip }, async () => {
  const c = client()
  await c.register('Asha', 'asha@example.com')
  const tx = { date: '2026-01-01', merchant: 'Netflix', amount: 649 }

  assert.equal((await c.post('/transactions', tx, { csrf: false })).status, 403)
  const wrong = await c.post('/transactions', tx, { csrf: false, headers: { 'X-CSRF-Token': 'forged' } })
  assert.equal(wrong.status, 403)
  assert.equal(wrong.data.code, 'CSRF_INVALID')

  // Another user's valid token does not work with this session.
  const other = client()
  await other.register('Bo', 'bo@example.com')
  const crossed = await c.post('/transactions', tx, { csrf: false, headers: { 'X-CSRF-Token': other.csrfToken } })
  assert.equal(crossed.status, 403)

  for (const [method, path] of [['POST', '/transactions/analyze'], ['POST', '/alerts'], ['POST', '/subscriptions'], ['POST', '/auth/logout']]) {
    assert.equal((await c.request(method, path, { json: {}, csrf: false })).status, 403, `${method} ${path}`)
  }
  const form = new FormData()
  form.append('file', new Blob(['date,merchant,amount\n2026-01-01,X,1\n']), 'x.csv')
  assert.equal((await c.request('POST', '/transactions/import', { form, csrf: false })).status, 403, 'CSV import')

  assert.equal((await c.post('/transactions', tx)).status, 201, 'valid token succeeds')
  assert.equal((await c.get('/transactions', { csrf: false })).status, 200, 'safe methods need no token')
  assert.equal(c.csrfToken, deriveCsrfToken(c.cookie.split('=')[1]))
  assert.equal(csrfTokenMatches(c.cookie.split('=')[1], c.csrfToken), true)
})

test('Origin check: cross-site mutations are rejected even with a valid session and token', { skip }, async () => {
  const c = client()
  await c.register('Asha', 'asha@example.com')
  const res = await c.post('/transactions', { date: '2026-01-01', merchant: 'X', amount: 1 }, { origin: 'https://evil.example' })
  assert.equal(res.status, 403)
  assert.equal(res.data.code, 'ORIGIN_REJECTED')
  const viaReferer = await c.post('/transactions', { date: '2026-01-01', merchant: 'X', amount: 1 }, {
    origin: null, headers: { Referer: 'https://evil.example/page' },
  })
  assert.equal(viaReferer.status, 403)
  // Login CSRF: a hostile page cannot log the victim into an attacker account.
  const login = await client().post('/auth/login', { email: 'asha@example.com', password: 'CorrectHorse9' }, { origin: 'https://evil.example' })
  assert.equal(login.status, 403)
})

test('CORS: credentials are allowed only for trusted origins', { skip }, async () => {
  const preflight = (origin) => fetch(`${srv.base}/transactions`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' },
  })
  const good = await preflight('http://localhost:5173')
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  assert.equal(good.headers.get('access-control-allow-credentials'), 'true')
  assert.match(good.headers.get('access-control-allow-headers'), /X-CSRF-Token/i)
  const bad = await preflight('https://evil.example')
  assert.equal(bad.headers.get('access-control-allow-origin'), null)
})

test('cookie flags: Secure in production; SameSite=None requires Secure', () => {
  const prod = loadSecurityConfig({ NODE_ENV: 'production' })
  assert.equal(prod.session.cookie.secure, true)
  assert.equal(prod.session.cookie.httpOnly, true)
  assert.equal(loadSecurityConfig({ NODE_ENV: 'production', COOKIE_SAMESITE: 'none' }).session.cookie.sameSite, 'none')
  assert.throws(() => loadSecurityConfig({ COOKIE_SAMESITE: 'none' }), /requires Secure/)
  assert.throws(() => loadSecurityConfig({ COOKIE_SAMESITE: 'bogus' }))
  assert.deepEqual(loadSecurityConfig({ CLIENT_ORIGIN: 'https://a.example/, https://b.example' }).trustedOrigins, ['https://a.example', 'https://b.example'])
})

test('production cookie is emitted with the Secure flag', { skip }, async () => {
  const prod = await startServer({ env: { NODE_ENV: 'production' } })
  try {
    const c = new Client(prod.base)
    await c.register('Asha', 'secure@example.com')
    assert.match(c.lastSetCookie[0], /;\s*Secure/i)
  } finally {
    await prod.close()
  }
})

// ---------------------------------------------------------------- rate limiting
test('rate limiting: repeated login attempts are throttled with 429', { skip }, async () => {
  const limited = await startServer({ rateLimitMax: 3 })
  try {
    const attempt = () => new Client(limited.base).post('/auth/login', { email: 'x@example.com', password: 'WrongPass99' })
    for (let i = 0; i < 3; i++) assert.equal((await attempt()).status, 401)
    const blocked = await attempt()
    assert.equal(blocked.status, 429)
    assert.equal(blocked.data.code, 'RATE_LIMITED')
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    // Registration shares the per-IP budget.
    const reg = await new Client(limited.base).post('/auth/register', { name: 'N', email: 'n@example.com', password: 'CorrectHorse9' })
    assert.equal(reg.status, 429)
  } finally {
    await limited.close()
  }
})

test('responses never expose session tokens or password hashes', { skip }, async () => {
  const c = client()
  const reg = await c.register('Asha', 'asha@example.com')
  const token = c.cookie.split('=')[1]
  const me = await c.get('/auth/me')
  for (const body of [reg.data, me.data]) {
    const text = JSON.stringify(body)
    assert.ok(!text.includes(token), 'raw session token not in body')
    assert.ok(!text.includes('tokenHash') && !text.includes('passwordHash'))
  }
})
