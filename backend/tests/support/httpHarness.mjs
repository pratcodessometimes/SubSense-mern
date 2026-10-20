// Phase 4.1 HTTP test harness: boots the real Express app (createApp) on an ephemeral port.
// Under `npm run test:unit` 'mongoose' is the in-memory fake. Phase 5.1: tests/realdb also uses it
// with the real mongoose package, connected only to a run-owned test database (support/realMongo.mjs).
// Neither path ever reads MONGO_URI or reaches the application database.
import { once } from 'node:events'
import { createApp } from '../../src/app.js'
import { loadSecurityConfig } from '../../src/config/security.js'

export const TRUSTED_ORIGIN = 'http://localhost:5173'

export async function startServer({ env = {}, rateLimitMax = 10_000 } = {}) {
  const config = loadSecurityConfig({ CLIENT_ORIGIN: TRUSTED_ORIGIN, ...env })
  config.authRateLimit.max = rateLimitMax
  const app = createApp({ config })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api`
  return {
    base,
    app,
    config,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Minimal browser-like client: keeps the session cookie and the CSRF token in memory. */
export class Client {
  constructor(base, { origin = TRUSTED_ORIGIN } = {}) {
    this.base = base
    this.origin = origin
    this.cookie = null // "subsense_session=<token>"
    this.csrfToken = null
    this.lastSetCookie = []
  }

  async request(method, path, { json, form, headers = {}, csrf = true, origin = this.origin } = {}) {
    const h = { ...headers }
    if (origin) h.Origin = origin
    if (this.cookie) h.Cookie = this.cookie
    if (csrf && this.csrfToken && !['GET', 'HEAD'].includes(method)) h['X-CSRF-Token'] = this.csrfToken
    let body
    if (json !== undefined) {
      h['Content-Type'] = 'application/json'
      body = JSON.stringify(json)
    } else if (form) {
      body = form
    }
    const res = await fetch(`${this.base}${path}`, { method, headers: h, body })
    this.lastSetCookie = res.headers.getSetCookie()
    for (const c of this.lastSetCookie) {
      const [pair] = c.split(';')
      if (!pair.startsWith('subsense_session=')) continue
      const cleared = /max-age=0/i.test(c) || /expires=Thu, 01 Jan 1970/i.test(c) || pair === 'subsense_session='
      this.cookie = cleared ? null : pair
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (data && typeof data === 'object' && typeof data.csrfToken === 'string') this.csrfToken = data.csrfToken
    return { status: res.status, data, headers: res.headers }
  }

  get(path, opts) {
    return this.request('GET', path, opts)
  }
  post(path, json, opts = {}) {
    return this.request('POST', path, { ...opts, json })
  }
  put(path, json, opts = {}) {
    return this.request('PUT', path, { ...opts, json })
  }
  del(path, opts) {
    return this.request('DELETE', path, opts)
  }

  async register(name, email, password = 'CorrectHorse9') {
    const res = await this.post('/auth/register', { name, email, password })
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.data)}`)
    this.user = res.data.user
    return res
  }

  importCsv(csv, opts = {}) {
    const form = new FormData()
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'import.csv')
    return this.request('POST', '/transactions/import', { ...opts, form })
  }
}
