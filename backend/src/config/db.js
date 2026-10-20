import 'dotenv/config'
import mongoose from 'mongoose'

/**
 * Validates a MongoDB connection string without ever echoing it (it usually embeds a password).
 * @returns {string} the trimmed URI
 */
export function validateMongoUri(uri, name = 'MONGO_URI') {
  const value = typeof uri === 'string' ? uri.trim() : ''
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`)
  }
  if (!/^mongodb(\+srv)?:\/\//.test(value)) {
    throw new Error(`${name} must start with mongodb:// or mongodb+srv:// (value not shown)`)
  }
  return value
}

/** Removes credentials from any string that might contain a connection URI (for logs/errors). */
export function redactMongoUri(text) {
  return String(text).replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1<credentials>@')
}

export async function connectDB(uri = process.env.MONGO_URI) {
  const value = validateMongoUri(uri)

  mongoose.set('strictQuery', true)
  try {
    // Fail fast (instead of hanging the deploy) when the cluster is unreachable, e.g. the
    // hosting provider's egress IPs are not in the Atlas network access list.
    await mongoose.connect(value, { serverSelectionTimeoutMS: 15_000 })
  } catch (err) {
    throw new Error(redactMongoUri(err.message))
  }
  // Host and database name only — never the URI, user name or password.
  console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`)
}
