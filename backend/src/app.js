import cors from 'cors'
import express from 'express'
import mongoose from 'mongoose'
import { loadSecurityConfig } from './config/security.js'
import { requireAuth, requireCsrf, verifyOrigin } from './middleware/auth.js'
import { errorHandler } from './middleware/errorHandler.js'
import { alertRoutes } from './routes/alertRoutes.js'
import { analyticsRoutes } from './routes/analyticsRoutes.js'
import { createAuthRoutes } from './routes/authRoutes.js'
import { recommendationRoutes } from './routes/recommendationRoutes.js'
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

  // Phase 5.1: baseline security headers for a JSON-only API (no extra dependency needed).
  // Responses carry private financial data, so they are never stored by browsers or proxies.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-site',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
    })
    if (config.isProduction) res.set('Strict-Transport-Security', 'max-age=15552000')
    next()
  })

  // Credentialed CORS restricted to explicit trusted origins.
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: same-origin or non-browser request; CORS does not apply.
        callback(null, !origin || config.trustedOrigins.includes(origin))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    }),
  )
  // JSON bodies are small records; CSV files go through multer with their own limit.
  app.use(express.json({ limit: '100kb' }))
  app.use('/api', verifyOrigin(config.trustedOrigins))

  // Liveness (use as the hosting health check): the process is up and serving requests.
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }))
  // Readiness: the MongoDB connection is usable. Exposes no host names or connection details.
  app.get('/api/health/ready', (req, res) => {
    const ready = mongoose.connection?.readyState === 1
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', database: ready ? 'connected' : 'disconnected' })
  })

  const authRoutes = createAuthRoutes(config)
  app.use('/api/auth', authRoutes)

  // Every financial API requires a valid session, plus a CSRF token for mutations
  // (including CSV import and manual analysis).
  const protectedApi = [requireAuth(config), requireCsrf]
  app.use('/api/transactions', ...protectedApi, transactionRoutes)
  app.use('/api/subscriptions', ...protectedApi, subscriptionRoutes)
  app.use('/api/alerts', ...protectedApi, alertRoutes)
  app.use('/api/analytics', ...protectedApi, analyticsRoutes)
  app.use('/api/recommendations', ...protectedApi, recommendationRoutes)

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))
  app.use(errorHandler)

  app.locals.resetRateLimits = authRoutes.resetRateLimits
  return app
}
