import cors from 'cors'
import express from 'express'
import { loadSecurityConfig } from './config/security.js'
import { requireAuth, requireCsrf, verifyOrigin } from './middleware/auth.js'
import { errorHandler } from './middleware/errorHandler.js'
import { alertRoutes } from './routes/alertRoutes.js'
import { analyticsRoutes } from './routes/analyticsRoutes.js'
import { createAuthRoutes } from './routes/authRoutes.js'
import { subscriptionRoutes } from './routes/subscriptionRoutes.js'
import { transactionRoutes } from './routes/transactionRoutes.js'

/**
 * Builds the Express application without connecting to MongoDB or listening,
 * so tests can mount it on an ephemeral port.
 */
export function createApp({ config = loadSecurityConfig() } = {}) {
  const app = express()

  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', config.trustProxy)

  // Credentialed CORS restricted to explicit trusted origins.
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: same-origin or non-browser request; CORS does not apply.
        callback(null, !origin || config.trustedOrigins.includes(origin))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    }),
  )
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', verifyOrigin(config.trustedOrigins))

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

  const authRoutes = createAuthRoutes(config)
  app.use('/api/auth', authRoutes)

  // Every financial API requires a valid session, plus a CSRF token for mutations
  // (including CSV import and manual analysis).
  const protectedApi = [requireAuth(config), requireCsrf]
  app.use('/api/transactions', ...protectedApi, transactionRoutes)
  app.use('/api/subscriptions', ...protectedApi, subscriptionRoutes)
  app.use('/api/alerts', ...protectedApi, alertRoutes)
  app.use('/api/analytics', ...protectedApi, analyticsRoutes)

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))
  app.use(errorHandler)

  app.locals.resetRateLimits = authRoutes.resetRateLimits
  return app
}
