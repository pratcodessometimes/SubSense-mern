import 'dotenv/config'
import mongoose from 'mongoose'

export async function connectDB() {
  const uri = process.env.MONGO_URI

  if (!uri) {
    throw new Error('MONGO_URI is not set. Copy .env.example to .env and fill it in.')
  }

  if (uri.includes('<user>') || uri.includes('<password>') || uri.includes('<cluster>')) {
    throw new Error(
      'MONGO_URI contains placeholder values (<user>, <password>, <cluster>).\n' +
      'Please open backend/.env and replace them with your actual MongoDB connection string.'
    )
  }

  mongoose.set('strictQuery', true)
  await mongoose.connect(uri)
  console.log(`MongoDB connected: ${mongoose.connection.host}`)
}
