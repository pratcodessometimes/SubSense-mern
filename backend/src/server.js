// SubSense Express Server
import cors from 'cors'
import 'dotenv/config'
import express from 'express'
import { connectDB } from './config/db.js'
import { errorHandler } from './middleware/errorHandler.js'
import { alertRoutes } from './routes/alertRoutes.js'
import { analyticsRoutes } from './routes/analyticsRoutes.js'
import { subscriptionRoutes } from './routes/subscriptionRoutes.js'
import { transactionRoutes } from './routes/transactionRoutes.js'

const app = express()

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }))
app.use(express.json())

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))
app.use('/api/transactions', transactionRoutes)
app.use('/api/subscriptions', subscriptionRoutes)
app.use('/api/alerts', alertRoutes)
app.use('/api/analytics', analyticsRoutes)

app.use(errorHandler)

const cliPortArg =
  process.argv.slice(2).find((arg) => /^\d{2,5}$/.test(arg)) ||
  (process.argv.indexOf('--port') !== -1 ? process.argv[process.argv.indexOf('--port') + 1] : undefined)

const port = cliPortArg || process.env.PORT || 5000

connectDB()
  .then(() => {
    const server = app.listen(port, () => console.log(`SubSense API listening on http://localhost:${port}`))
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Error: Port ${port} is already in use by another process.`)
        console.error(`To release port ${port} on PowerShell, run:`)
        console.error(`  Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port}).OwningProcess -Force\n`)
      } else {
        console.error('Server error:', err)
      }
      process.exit(1)
    })
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message)
    process.exit(1)
  })
