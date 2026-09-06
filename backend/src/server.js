import cors from 'cors'
import 'dotenv/config'
import express from 'express'
import { connectDB } from './config/db.js'
import { errorHandler } from './middleware/errorHandler.js'
import { alertRoutes } from './routes/alertRoutes.js'
import { subscriptionRoutes } from './routes/subscriptionRoutes.js'
import { transactionRoutes } from './routes/transactionRoutes.js'

const app = express()

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }))
app.use(express.json())

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))
app.use('/api/transactions', transactionRoutes)
app.use('/api/subscriptions', subscriptionRoutes)
app.use('/api/alerts', alertRoutes)

app.use(errorHandler)

const port = process.env.PORT || 5000

connectDB()
  .then(() => {
    app.listen(port, () => console.log(`SubSense API listening on http://localhost:${port}`))
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message)
    process.exit(1)
  })
