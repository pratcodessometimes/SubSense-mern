// Small fixed-window, in-memory rate limiter for the authentication endpoints.
// Per-process: counters reset on restart and are not shared between instances. Running more than
// one API instance needs a shared store (e.g. Redis) instead — see PHASE_5_1_PRODUCTION_READINESS.md.
// The client key is req.ip, which is only the real client address when "trust proxy" matches the
// actual proxy chain (TRUST_PROXY, validated in config/security.js).

export function createRateLimiter({ windowMs, max, keyFn = (req) => req.ip, message = 'Too many requests' }) {
  // Fail closed: NaN or non-positive limits would otherwise silently disable throttling
  // (`count > NaN` is always false).
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Rate limiter max must be a positive integer')
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('Rate limiter windowMs must be a positive integer')
  const hits = new Map()

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key)
  }, Math.max(windowMs, 1000))
  sweep.unref?.()

  function limiter(req, res, next) {
    const key = keyFn(req)
    if (!key) return next()
    const now = Date.now()
    let entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(key, entry)
    }
    entry.count++
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
      return res.status(429).json({ error: message, code: 'RATE_LIMITED' })
    }
    next()
  }

  limiter.reset = () => hits.clear()
  return limiter
}
