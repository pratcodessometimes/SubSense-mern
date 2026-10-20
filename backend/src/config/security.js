// Phase 4.1 security configuration, read from the environment once at startup.
// Phase 5.1: every value is validated and invalid or unsafe settings fail closed (throw), so a
// typo can never silently disable a control (e.g. a non-numeric rate limit or "trust all proxies").
import { isIP } from 'node:net'

const SAME_SITE_VALUES = ['lax', 'strict', 'none']
const BOOLEAN_VALUES = { true: true, false: false, 1: true, 0: false, yes: true, no: false }
// Express "trust proxy" presets (https://expressjs.com/en/guide/behind-proxies.html).
const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal'])

const MAX_SESSION_TTL_HOURS = 24 * 90
const MAX_PROXY_HOPS = 10

const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== ''

function parseBoolean(name, value) {
  if (!isSet(value)) return undefined
  const parsed = BOOLEAN_VALUES[String(value).trim().toLowerCase()]
  if (parsed === undefined) throw new Error(`${name} must be true or false`)
  return parsed
}

function parseInteger(name, value, { fallback, min, max }) {
  if (!isSet(value)) return fallback
  const text = String(value).trim()
  const n = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}`)
  }
  return n
}

/** Each trusted origin must be an exact scheme://host[:port] origin. Wildcards are never allowed. */
function parseOrigins(raw, { isProduction }) {
  const values = String(raw)
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean)
  if (values.length === 0) throw new Error('CLIENT_ORIGIN must list at least one origin')

  for (const value of values) {
    if (value.includes('*') || value === 'null') {
      throw new Error('CLIENT_ORIGIN must list exact origins; wildcards and "null" are not allowed with credentialed CORS')
    }
    let url
    try {
      url = new URL(value)
    } catch {
      throw new Error(`CLIENT_ORIGIN contains an invalid origin: ${JSON.stringify(value)}`)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
      throw new Error(`CLIENT_ORIGIN entries must be bare origins like https://app.example.com (got ${JSON.stringify(value)})`)
    }
    if (isProduction && url.protocol !== 'https:') {
      throw new Error(`CLIENT_ORIGIN must use https in production (got ${JSON.stringify(value)})`)
    }
  }
  return values
}

/**
 * TRUST_PROXY → Express "trust proxy" setting. Allowed: unset/false/0 (off), a hop count 1-10,
 * or a comma-separated list of presets (loopback, linklocal, uniquelocal) and IPs/CIDR subnets.
 * "true" is rejected: it trusts every X-Forwarded-For entry, so any client could spoof its IP
 * and evade the per-IP authentication rate limit.
 */
export function parseTrustProxy(value) {
  if (!isSet(value)) return false
  const text = String(value).trim().toLowerCase()
  if (text === 'false' || text === '0') return false
  if (text === 'true') {
    throw new Error('TRUST_PROXY=true trusts every proxy hop and lets clients spoof their IP. Use the number of proxies in front of the app (e.g. 1).')
  }
  if (/^\d+$/.test(text)) return parseInteger('TRUST_PROXY', text, { min: 0, max: MAX_PROXY_HOPS })

  const entries = text.split(',').map((e) => e.trim()).filter(Boolean)
  for (const entry of entries) {
    if (TRUST_PROXY_PRESETS.has(entry)) continue
    const [address, prefix, extra] = entry.split('/')
    const family = isIP(address)
    const prefixOk = prefix === undefined ||
      (/^\d+$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32))
    if (!family || !prefixOk || extra !== undefined) {
      throw new Error(`TRUST_PROXY entry ${JSON.stringify(entry)} is not a hop count, preset, IP address or CIDR subnet`)
    }
  }
  return entries.join(',')
}

export function loadSecurityConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production'
  const warnings = []

  // Production must name its frontend explicitly; the localhost default is for development only.
  if (isProduction && !isSet(env.CLIENT_ORIGIN)) {
    throw new Error('CLIENT_ORIGIN is required when NODE_ENV=production (the exact https origin of the frontend)')
  }
  const trustedOrigins = parseOrigins(isSet(env.CLIENT_ORIGIN) ? env.CLIENT_ORIGIN : 'http://localhost:5173', { isProduction })

  const sameSite = String(env.COOKIE_SAMESITE || 'lax').trim().toLowerCase()
  if (!SAME_SITE_VALUES.includes(sameSite)) {
    throw new Error(`COOKIE_SAMESITE must be one of ${SAME_SITE_VALUES.join(', ')}`)
  }

  // Secure cookies are mandatory in production; COOKIE_SECURE=true also enables them elsewhere.
  const cookieSecureSetting = parseBoolean('COOKIE_SECURE', env.COOKIE_SECURE)
  if (isProduction && cookieSecureSetting === false) {
    throw new Error('COOKIE_SECURE=false is not allowed when NODE_ENV=production')
  }
  const secureCookies = isProduction || cookieSecureSetting === true
  if (sameSite === 'none' && !secureCookies) {
    throw new Error('COOKIE_SAMESITE=none requires Secure cookies (NODE_ENV=production or COOKIE_SECURE=true)')
  }
  if (sameSite === 'none') {
    warnings.push(
      'COOKIE_SAMESITE=none: the session cookie is a third-party cookie when the frontend and API are on different sites; ' +
        'browsers that block third-party cookies will not keep users signed in. Prefer a same-site deployment or a same-origin /api proxy.',
    )
  }

  const ttlHours = isSet(env.SESSION_TTL_HOURS) ? Number(String(env.SESSION_TTL_HOURS).trim()) : 24 * 7
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > MAX_SESSION_TTL_HOURS) {
    throw new Error(`SESSION_TTL_HOURS must be a positive number of hours (at most ${MAX_SESSION_TTL_HOURS})`)
  }

  const trustProxy = parseTrustProxy(env.TRUST_PROXY)
  if (isProduction && trustProxy === false) {
    warnings.push(
      'TRUST_PROXY is not set: behind a hosting proxy (e.g. Render) every client appears to share the proxy IP, ' +
        'so the per-IP authentication rate limit applies to all users together. Set TRUST_PROXY to the number of proxies (usually 1).',
    )
  }

  return {
    isProduction,
    trustedOrigins,
    warnings,
    session: {
      // The __Host- prefix needs Path=/; the cookie is scoped to /api instead, so use a plain name.
      cookieName: 'subsense_session',
      ttlMs: Math.round(ttlHours * 60 * 60 * 1000),
      cookie: {
        httpOnly: true,
        secure: secureCookies,
        sameSite,
        path: '/api',
      },
    },
    authRateLimit: {
      windowMs: parseInteger('AUTH_RATE_LIMIT_WINDOW_MS', env.AUTH_RATE_LIMIT_WINDOW_MS, {
        fallback: 15 * 60 * 1000, min: 1000, max: 24 * 60 * 60 * 1000,
      }),
      max: parseInteger('AUTH_RATE_LIMIT_MAX', env.AUTH_RATE_LIMIT_MAX, { fallback: 20, min: 1, max: 10_000 }),
    },
    trustProxy,
  }
}
