// Phase 4.2 profile editing and in-app alert preferences.
// HTTP-level against the real Express app with the IN-MEMORY fake database (npm run test:unit).
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import { Alert } from '../src/models/Alert.js'
import { User } from '../src/models/User.js'
import { Client, startServer } from './support/httpHarness.mjs'

const FAKE = Boolean(mongoose.__isFake)
const skip = !FAKE && 'requires the in-memory fake database (npm run test:unit)'
const DEFAULTS = { priceIncrease: true, duplicate: true, serviceOverlap: true, inactivity: true, paymentAnomaly: true }

let srv
let A
let B
before(async () => {
  if (FAKE) srv = await startServer()
})
after(async () => {
  if (srv) await srv.close()
})
beforeEach(async () => {
  if (!FAKE) return
  mongoose.__resetAll()
  srv.app.locals.resetRateLimits()
  A = new Client(srv.base)
  B = new Client(srv.base)
  await A.register('User A', 'a@example.com')
  await B.register('User B', 'b@example.com')
})

const stored = (client) => User.__all().find((u) => u._id === client.user.id)
const patch = (client, path, json, opts) => client.request('PATCH', path, { ...opts, json })

// ---------------------------------------------------------------- profile
test('profile: user can update their display name; /me reflects it', { skip }, async () => {
  const res = await patch(A, '/auth/profile', { name: '  Asha    Rao  ' })
  assert.equal(res.status, 200)
  assert.equal(res.data.user.name, 'Asha Rao', 'trimmed and whitespace-collapsed')
  assert.equal(res.data.user.email, 'a@example.com')
  assert.deepEqual(Object.keys(res.data.user).sort(), ['createdAt', 'email', 'id', 'name', 'preferences'])
  assert.ok(!JSON.stringify(res.data).includes('passwordHash'))

  const me = await A.get('/auth/me')
  assert.equal(me.data.user.name, 'Asha Rao')
  assert.equal(typeof me.data.csrfToken, 'string', '/me response structure preserved')
  assert.equal(stored(A).name, 'Asha Rao')
  assert.equal((await A.get('/transactions')).status, 200, 'session still valid after the update')
})

test('profile: empty, whitespace, too long, control-character and non-string names are rejected', { skip }, async () => {
  const before = stored(A).name
  for (const name of ['', '   ', 'x'.repeat(81), 'Bad\nName', 'Tab\tName', `RTL${String.fromCharCode(0x202e)}x`, 42, null, { $ne: '' }, ['A']]) {
    const res = await patch(A, '/auth/profile', { name })
    assert.equal(res.status, 400, JSON.stringify(name))
    assert.ok(res.data.error)
  }
  assert.equal((await patch(A, '/auth/profile', {})).status, 400, 'missing name')
  assert.equal((await A.request('PATCH', '/auth/profile', { json: [] })).status, 400, 'array body')
  assert.equal(stored(A).name, before)
  assert.equal((await patch(A, '/auth/profile', { name: 'x'.repeat(80) })).status, 200, '80 characters is allowed')
})

test('profile: protected fields cannot be written (request is rejected, nothing changes)', { skip }, async () => {
  const before = stored(A)
  const attempts = [
    { name: 'New', email: 'evil@example.com' },
    { name: 'New', passwordHash: 'plain' },
    { name: 'New', _id: '000000000000000000000abc' },
    { name: 'New', userId: B.user.id },
    { name: 'New', createdAt: '2000-01-01' },
    { name: 'New', preferences: { alerts: { duplicate: false } } },
    { name: 'New', tokenHash: 'x' },
  ]
  for (const body of attempts) {
    const res = await patch(A, '/auth/profile', body)
    assert.equal(res.status, 400, Object.keys(body).join(','))
    assert.match(res.data.error, /cannot be updated/)
  }
  assert.deepEqual(stored(A), before)
})

test('profile: one user cannot modify another user\'s profile', { skip }, async () => {
  const bBefore = stored(B)
  await patch(A, '/auth/profile', { name: 'Changed A' })
  assert.deepEqual(stored(B), bBefore)
  assert.equal((await B.get('/auth/me')).data.user.name, 'User B')
  // There is no id parameter to target: identity comes only from the session.
  assert.equal((await patch(A, `/auth/profile?userId=${B.user.id}`, { name: 'Pwned' }, { headers: { 'X-User-Id': B.user.id } })).status, 200)
  assert.equal(stored(B).name, 'User B')
  assert.equal(stored(A).name, 'Pwned')
})

test('profile & preferences: require a session and a CSRF token', { skip }, async () => {
  const anon = new Client(srv.base)
  assert.equal((await patch(anon, '/auth/profile', { name: 'X' })).status, 401)
  assert.equal((await patch(anon, '/auth/preferences', { alerts: { duplicate: false } })).status, 401)
  assert.equal((await patch(A, '/auth/profile', { name: 'X' }, { csrf: false })).status, 403)
  assert.equal((await patch(A, '/auth/preferences', { alerts: { duplicate: false } }, { csrf: false })).status, 403)
  assert.equal((await patch(A, '/auth/profile', { name: 'X' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal(stored(A).name, 'User A')
})

// ---------------------------------------------------------------- preferences
test('preferences: new and pre-4.2 users get every category enabled', { skip }, async () => {
  assert.deepEqual((await A.get('/auth/me')).data.user.preferences, { alerts: DEFAULTS })
  // Simulate an account created before Phase 4.2 (no preferences stored at all).
  await User.updateMany({ _id: A.user.id }, { $unset: { preferences: 1 } })
  assert.equal(stored(A).preferences, undefined)
  assert.deepEqual((await A.get('/auth/me')).data.user.preferences, { alerts: DEFAULTS })
  // A partial update on such an account keeps the other defaults.
  const res = await patch(A, '/auth/preferences', { alerts: { paymentAnomaly: false } })
  assert.deepEqual(res.data.preferences.alerts, { ...DEFAULTS, paymentAnomaly: false })
})

test('preferences: partial updates persist across logout/login', { skip }, async () => {
  const res = await patch(A, '/auth/preferences', { alerts: { priceIncrease: false, inactivity: false } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.data.preferences.alerts, { ...DEFAULTS, priceIncrease: false, inactivity: false })
  await patch(A, '/auth/preferences', { alerts: { inactivity: true } })

  await A.post('/auth/logout', {})
  const again = new Client(srv.base)
  const login = await again.post('/auth/login', { email: 'a@example.com', password: 'CorrectHorse9' })
  assert.deepEqual(login.data.user.preferences.alerts, { ...DEFAULTS, priceIncrease: false })
  assert.deepEqual((await again.get('/auth/me')).data.user.preferences.alerts, { ...DEFAULTS, priceIncrease: false })
  assert.equal(stored(A).preferences.alerts.priceIncrease, false, 'stored in the user document')
})

test('preferences: invalid values, unknown keys and malformed bodies are rejected without changes', { skip }, async () => {
  const before = JSON.stringify(stored(A))
  const bad = [
    { alerts: { priceIncrease: 'false' } },
    { alerts: { priceIncrease: 0 } },
    { alerts: { priceIncrease: null } },
    { alerts: { priceIncrease: false, emailDigest: true } },
    { alerts: { weeklyInsights: false } },
    { alerts: {} },
    { alerts: [false] },
    { alerts: { duplicate: false }, name: 'x' },
    { priceIncrease: false },
    { alerts: { 'priceIncrease.$': false } },
    {},
  ]
  for (const body of bad) {
    const res = await patch(A, '/auth/preferences', body)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  assert.equal(JSON.stringify(stored(A)), before)
})

test('preferences: one user cannot change another user\'s settings', { skip }, async () => {
  await patch(A, '/auth/preferences', { alerts: { duplicate: false, serviceOverlap: false } }, { headers: { 'X-User-Id': B.user.id } })
  assert.deepEqual((await B.get('/auth/me')).data.user.preferences.alerts, DEFAULTS)
  assert.deepEqual((await A.get('/auth/me')).data.user.preferences.alerts, { ...DEFAULTS, duplicate: false, serviceOverlap: false })
})

// ---------------------------------------------------------------- display-only semantics
const monthly = (merchant, amount, months, { day = 14, year = 2025, startMonth = 1, account = 'HDFC 1111' } = {}) =>
  Array.from({ length: months }, (_, k) => {
    const dt = new Date(Date.UTC(year, startMonth - 1 + k, day)).toISOString().slice(0, 10)
    return `${dt},${merchant},${typeof amount === 'function' ? amount(k) : amount},${account}`
  })
const CSV = ['date,merchant,amount,account',
  ...monthly('POS DEBIT - NETFLIX.COM', (k) => (k < 6 ? 499 : 649), 9, { startMonth: 4 }),
  ...monthly('UPI/SPOTIFY AB/4028', 119, 7, { day: 8, startMonth: 6 }),
  '2025-12-09,UPI/SPOTIFY AB/4028,119,ICICI 2222',
].join('\n')

test('preferences: disabling categories hides nothing server-side — alerts, detection and analytics are unchanged', { skip }, async () => {
  await A.importCsv(CSV)
  await A.post('/alerts', { type: 'price_increase', title: 'My note', description: 'd', impact: 'i', impactLabel: 'l' })
  const alertsBefore = (await A.get('/alerts')).data
  const kpisBefore = (await A.get('/analytics/kpis')).data
  const types = new Set(alertsBefore.map((a) => a.type))
  assert.ok(types.has('price_increase') && types.has('duplicate'), [...types].join(','))

  const allOff = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, false]))
  assert.equal((await patch(A, '/auth/preferences', { alerts: allOff })).status, 200)

  // Stored alerts are untouched and still returned by the API (filtering is a UI concern).
  const alertsHidden = (await A.get('/alerts')).data
  assert.deepEqual(alertsHidden.map((a) => a._id).sort(), alertsBefore.map((a) => a._id).sort())
  assert.equal(Alert.__all().filter((a) => a.userId === A.user.id).length, alertsBefore.length)
  // Detection still generates/keeps every alert type while categories are hidden.
  const run = (await A.post('/transactions/analyze', {})).data
  assert.equal(run.alertsCount, alertsBefore.length)
  assert.deepEqual((await A.get('/analytics/kpis')).data, kpisBefore, 'analytics ignore display preferences')

  // Re-enabling restores visibility of exactly the same alerts.
  assert.deepEqual((await patch(A, '/auth/preferences', { alerts: DEFAULTS })).data.preferences.alerts, DEFAULTS)
  assert.deepEqual((await A.get('/alerts')).data.map((a) => a._id).sort(), alertsBefore.map((a) => a._id).sort())
})
