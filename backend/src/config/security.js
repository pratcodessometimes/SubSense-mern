// Phase 4.1 security configuration, read from the environment once at startup.

const SAME_SITE_VALUES = ['lax', 'strict', 'none']

export function loadSecurityConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production'

  const trustedOrigins = String(env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean)

  const sameSite = String(env.COOKIE_SAMESITE || 'lax').trim().toLowerCase()
  if (!SAME_SITE_VALUES.includes(sameSite)) {
    throw new Error(`COOKIE_SAMESITE must be one of ${SAME_SITE_VALUES.join(', ')}`)
  }

  // Secure cookies are mandatory in production; COOKIE_SECURE=true also enables them elsewhere.
  const secureCookies = isProduction || String(env.COOKIE_SECURE).toLowerCase() === 'true'
  if (sameSite === 'none' && !secureCookies) {
    throw new Error('COOKIE_SAMESITE=none requires Secure cookies (NODE_ENV=production or COOKIE_SECURE=true)')
  }

  const ttlHours = Number(env.SESSION_TTL_HOURS || 24 * 7)
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new Error('SESSION_TTL_HOURS must be a positive number')
  }

  return {
    isProduction,
    trustedOrigins,
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
      windowMs: Number(env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
      max: Number(env.AUTH_RATE_LIMIT_MAX || 20),
    },
    trustProxy: env.TRUST_PROXY ? (Number.isNaN(Number(env.TRUST_PROXY)) ? env.TRUST_PROXY : Number(env.TRUST_PROXY)) : false,
  }
}
