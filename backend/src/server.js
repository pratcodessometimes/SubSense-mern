import 'dotenv/config'
import { createApp } from './app.js'
import { connectDB } from './config/db.js'

const app = createApp()
const port = process.env.PORT || 5000

connectDB()
  .then(() => {
    app.listen(port, () => console.log(`SubSense API listening on http://localhost:${port}`))
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message)
    process.exit(1)
  })
