import mongoose from 'mongoose'

// Database-backed login session. Only a SHA-256 hash of the opaque session token is
// stored, so a database leak does not reveal usable session cookies.
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date },
    userAgent: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
)

// MongoDB removes expired sessions automatically; the auth middleware also rejects them
// immediately, since the TTL monitor only runs about once a minute.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const Session = mongoose.model('Session', sessionSchema)
