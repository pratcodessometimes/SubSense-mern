// Phase 5.2 — smoke test for a DEPLOYED SubSense site (or a local `vite preview` of the build).
//
//   node scripts/smoke-deployed.mjs https://<app>.vercel.app
//
// Talks to <site>/api exactly like the browser does (same-origin /api proxy). It creates TWO
// synthetic accounts (smoke-<random>@example.test) with a few synthetic transactions; there is no
// account-deletion API, so these records stay in the target database. Never prints cookies,
// tokens or passwords. Read-only toward every other account. Exits non-zero on any failure.
import { randomBytes } from 'node:crypto'

const site = String(process.argv[2] || '').replace(/\/$/, '')
if (!/^https?:\/\/[^/]+$/.test(site)) {
  console.error('Usage: node scripts/smoke-deployed.mjs https://<frontend-origin>')
  process.exit(2)
}
const API = `${site}/api`
const isHttps = site.startsWith('https://')
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

class Session {
  constructor() { this.cookie = null; this.csrf = null; this.setCookie = '' }
  async req(method, path, { json, form, csrf = true, origin = site } = {}) {
    const headers = { Origin: origin }
    if (this.cookie) headers.Cookie = this.cookie
    if (csrf && this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    let body
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json) }
    if (form) body = form
    const res = await fetch(`${API}${path}`, { method, headers, body, redirect: 'manual' })
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('subsense_session='))
    if (sc) {
      this.setCookie = sc
      const pair = sc.split(';')[0]
      this.cookie = /max-age=0|expires=Thu, 01 Jan 1970/i.test(sc) || pair === 'subsense_session=' ? null : pair
    }
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = text.slice(0, 120) }
    if (data && typeof data.csrfToken === 'string') this.csrf = data.csrfToken
    return { status: res.status, data, headers: res.headers }
  }
}

const tag = randomBytes(4).toString('hex')
const password = `Smoke${randomBytes(6).toString('hex')}9`
const csvFor = () => {
  const rows = ['date,merchant,amount,account']
  const now = new Date()
  for (let k = 5; k >= 0; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 7)).toISOString().slice(0, 10)
    rows.push(`${d},SMOKE TEST STREAMING,299,SMOKE 0000`)
  }
  return rows.join('\n')
}

try {
  // ---- frontend + routing
  const home = await fetch(`${site}/`)
  check('frontend serves the app', home.status === 200 && (await home.text()).includes('<div id="root">'))
  const deep = await fetch(`${site}/analytics`)
  check('SPA deep link falls back to index.html', deep.status === 200 && (await deep.text()).includes('<div id="root">'))
  if (isHttps) {
    const plain = await fetch(site.replace('https://', 'http://'), { redirect: 'manual' })
    check('plain HTTP redirects to HTTPS', [301, 302, 307, 308].includes(plain.status), String(plain.status))
  }

  // ---- API through the proxy
  const health = await fetch(`${API}/health`)
  const hb = await health.json().catch(() => null)
  check('GET /api/health through the proxy', health.status === 200 && hb?.status === 'ok')
  check('API responses are no-store', health.headers.get('cache-control') === 'no-store')
  if (isHttps) check('HSTS header present', Boolean(health.headers.get('strict-transport-security')))
  const ready = await fetch(`${API}/health/ready`)
  check('database readiness', ready.status === 200, String(ready.status))

  // ---- registration, cookie flags, session
  const A = new Session()
  const reg = await A.req('POST', '/auth/register', { json: { name: 'Smoke A', email: `smoke-a-${tag}@example.test`, password } })
  check('registration', reg.status === 201, String(reg.status))
  const flags = A.setCookie
  check('session cookie HttpOnly + SameSite=Lax + Path=/api', /HttpOnly/i.test(flags) && /SameSite=Lax/i.test(flags) && /Path=\/api/i.test(flags))
  if (isHttps) check('session cookie Secure', /;\s*Secure/i.test(flags))
  check('cookie is host-only (no Domain attribute)', !/;\s*Domain=/i.test(flags))
  check('authenticated /auth/me', (await A.req('GET', '/auth/me')).status === 200)

  // ---- CSRF + origin
  const noCsrf = await A.req('POST', '/transactions', { json: { date: '2026-01-01', merchant: 'X', amount: 1 }, csrf: false })
  check('mutation without CSRF token is rejected', noCsrf.status === 403 && noCsrf.data?.code === 'CSRF_INVALID', String(noCsrf.status))
  const evil = await A.req('POST', '/transactions', { json: { date: '2026-01-01', merchant: 'X', amount: 1 }, origin: 'https://evil.example' })
  check('mutation from a foreign Origin is rejected', evil.status === 403, String(evil.status))
  check('anonymous financial API is rejected', (await new Session().req('GET', '/transactions')).status === 401)

  // ---- basic financial flow
  const form = new FormData()
  form.append('file', new Blob([csvFor()], { type: 'text/csv' }), 'smoke.csv')
  const imp = await A.req('POST', '/transactions/import', { form })
  check('CSV import + detection', imp.status === 201 && imp.data?.count === 6, `${imp.status} count=${imp.data?.count}`)
  const monthly = await A.req('GET', '/analytics/monthly')
  check('monthly analytics returns the imported payments', monthly.status === 200 && monthly.data?.actual?.paymentCount === 6,
    `paymentCount=${monthly.data?.actual?.paymentCount}`)
  check('recommendations endpoint', (await A.req('GET', '/recommendations')).status === 200)

  // ---- isolation
  const B = new Session()
  await B.req('POST', '/auth/register', { json: { name: 'Smoke B', email: `smoke-b-${tag}@example.test`, password } })
  const bTx = await B.req('GET', '/transactions')
  const bMonthly = await B.req('GET', '/analytics/monthly')
  check('second account sees none of the first account’s data',
    Array.isArray(bTx.data) && bTx.data.length === 0 && bMonthly.data?.actual?.paymentCount === 0)
  const aTxId = (await A.req('GET', '/transactions')).data?.[0]?._id
  check('cross-account read by id is 404', (await B.req('GET', `/transactions/${aTxId}`)).status === 404)

  // ---- logout
  const oldCookie = A.cookie
  check('logout', (await A.req('POST', '/auth/logout', { json: {} })).status === 200)
  const replay = new Session()
  replay.cookie = oldCookie
  check('old session cookie rejected after logout', (await replay.req('GET', '/auth/me')).status === 401)
  const login = new Session()
  const li = await login.req('POST', '/auth/login', { json: { email: `smoke-a-${tag}@example.test`, password } })
  check('login with the same account', li.status === 200)
  await login.req('POST', '/auth/logout', { json: {} })
  await B.req('POST', '/auth/logout', { json: {} })
} catch (err) {
  check('smoke run completed', false, err.message)
}

const failed = results.filter((ok) => !ok).length
console.log(`\nSMOKE: ${results.length - failed} passed, ${failed} failed (synthetic accounts smoke-*-${tag}@example.test)`)
process.exit(failed ? 1 : 0)
