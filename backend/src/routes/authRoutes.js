import { Router } from 'express'
import { createAuthController } from '../controllers/authController.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAuth, requireCsrf } from '../middleware/auth.js'
import { createRateLimiter } from '../middleware/rateLimit.js'
import { normalizeEmail } from '../services/authService.js'

export function createAuthRoutes(config) {
  const controller = createAuthController(config)
  const authenticate = requireAuth(config)
  const { windowMs, max } = config.authRateLimit

  const ipLimiter = createRateLimiter({
    windowMs,
    max,
    message: 'Too many authentication attempts. Please try again later.',
  })
  // Slows credential stuffing against a single account from many IPs.
  const accountLimiter = createRateLimiter({
    windowMs,
    max,
    keyFn: (req) => {
      const email = normalizeEmail(req.body?.email)
      return email ? `login:${email}` : null
    },
    message: 'Too many login attempts for this account. Please try again later.',
  })

  const router = Router()
  router.post('/register', ipLimiter, asyncHandler(controller.register))
  router.post('/login', ipLimiter, accountLimiter, asyncHandler(controller.login))
  router.get('/me', authenticate, asyncHandler(controller.me))
  router.post('/logout', authenticate, requireCsrf, asyncHandler(controller.logout))

  router.resetRateLimits = () => {
    ipLimiter.reset()
    accountLimiter.reset()
  }
  return router
}
