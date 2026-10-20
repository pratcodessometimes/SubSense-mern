import 'dotenv/config'
import mongoose from 'mongoose'
import { createApp } from './app.js'
import { connectDB, validateMongoUri } from './config/db.js'
import { loadSecurityConfig } from './config/security.js'

// Phase 5.1: validate every security/database setting before connecting, and exit with a clear
// message (never the secret values) when something is missing or unsafe.
let config
try {
  config = loadSecurityConfig()
  validateMongoUri(process.env.MONGO_URI)
} catch (err) {
  console.error(`Invalid configuration: ${err.message}`)
  process.exit(1)
}
for (const warning of config.warnings) console.warn(`Configuration warning: ${warning}`)

const app = createApp({ config })
const port = Number(process.env.PORT) || 5000

connectDB()
  .then(() => {
    const server = app.listen(port, () => console.log(`SubSense API listening on port ${port}`))

    // Hosting platforms (e.g. Render) send SIGTERM before replacing an instance: stop accepting
    // connections, let in-flight requests finish, then close the MongoDB connection.
    let shuttingDown = false
    const shutdown = (signal) => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`${signal} received, shutting down`)
      const force = setTimeout(() => process.exit(1), 10_000)
      force.unref()
      server.close(async () => {
        await mongoose.disconnect().catch(() => {})
        process.exit(0)
      })
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message)
    process.exit(1)
  })
