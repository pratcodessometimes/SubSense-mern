// Phase 5.1 — validates the API configuration without starting the server or connecting to MongoDB.
//   npm run check:config                      (reads backend/.env if present, like `npm start`)
//   NODE_ENV=production CLIENT_ORIGIN=... npm run check:config
// Prints only pass/fail, warnings and non-secret settings. The database URI is checked for its
// format but never printed.
import 'dotenv/config'
import { validateMongoUri } from './db.js'
import { loadSecurityConfig } from './security.js'

try {
  const config = loadSecurityConfig()
  validateMongoUri(process.env.MONGO_URI)
  console.log('Configuration OK')
  console.log(JSON.stringify({
    mode: config.isProduction ? 'production' : 'development',
    trustedOrigins: config.trustedOrigins,
    cookie: config.session.cookie,
    sessionTtlHours: config.session.ttlMs / 3_600_000,
    authRateLimit: config.authRateLimit,
    trustProxy: config.trustProxy,
  }, null, 2))
  for (const warning of config.warnings) console.warn(`Warning: ${warning}`)
} catch (err) {
  console.error(`Invalid configuration: ${err.message}`)
  process.exit(1)
}
