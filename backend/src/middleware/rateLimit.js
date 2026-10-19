// Small fixed-window, in-memory rate limiter for the authentication endpoints.
// Per-process: behind multiple instances use a shared store (e.g. Redis) instead.

export function createRateLimiter({ windowMs, max, keyFn = (req) => req.ip, message = 'Too many requests' }) {
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
