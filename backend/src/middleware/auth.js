import { resolvePreferences, User } from '../models/User.js'
import { csrfTokenMatches, findActiveSession } from '../services/authService.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Minimal Cookie header parser (avoids a cookie-parser dependency for one cookie). */
export function readCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

/**
 * Authenticates the request from the HttpOnly session cookie only. Identity is never taken
 * from the body, query string or custom headers. On success sets:
 *   req.user        = { id, name, email }
 *   req.authSession = { id, token }   (token stays server-side; used for CSRF and logout)
 */
export function requireAuth(config) {
  const { cookieName, cookie } = config.session

  return async function authenticate(req, res, next) {
    try {
      const token = readCookie(req, cookieName)
      const session = token ? await findActiveSession(token) : null
      const user = session ? await User.findById(session.userId) : null

      if (!session || !user) {
        // Clear a stale/expired/revoked cookie so the browser stops sending it.
        if (token) res.clearCookie(cookieName, cookie)
        return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' })
      }

      req.user = {
        id: String(user._id),
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        preferences: resolvePreferences(user),
      }
      req.authSession = { id: String(session._id), token }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * CSRF protection for authenticated state-changing requests (synchronizer token):
 * the client must echo the session-bound token in the X-CSRF-Token header. A cross-site
 * page can neither read that token nor send the custom header without passing CORS.
 * Must run after requireAuth.
 */
export function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next()
  const candidate = req.get('x-csrf-token')
  if (!req.authSession || !csrfTokenMatches(req.authSession.token, candidate)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token', code: 'CSRF_INVALID' })
  }
  next()
}

/**
 * Defense in depth: rejects state-changing requests whose Origin (or Referer) is not a
 * trusted frontend origin. Requests with neither header (non-browser clients) pass here and
 * still need a valid session cookie + CSRF token for any authenticated mutation.
 */
export function verifyOrigin(trustedOrigins) {
  const trusted = new Set(trustedOrigins)
  return function originCheck(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next()
    let origin = req.get('origin')
    if (!origin) {
      const referer = req.get('referer')
      if (referer) {
        try {
          origin = new URL(referer).origin
        } catch {
          origin = 'invalid'
        }
      }
    }
    if (origin && !trusted.has(origin)) {
      return res.status(403).json({ error: 'Request origin is not allowed', code: 'ORIGIN_REJECTED' })
    }
    next()
  }
}
