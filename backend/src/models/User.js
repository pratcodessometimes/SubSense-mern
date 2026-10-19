import mongoose from 'mongoose'

// Phase 4.2: in-app alert visibility preferences. These only control which alert categories
// the UI displays; detection, alert storage and analytics never read them.
export const ALERT_PREFERENCE_KEYS = ['priceIncrease', 'duplicate', 'serviceOverlap', 'inactivity', 'paymentAnomaly']

const alertPreferenceFields = Object.fromEntries(
  ALERT_PREFERENCE_KEYS.map((key) => [key, { type: Boolean, default: true }]),
)

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Always stored normalized (trimmed + lowercased) so the unique index is case-insensitive.
    email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 254 },
    // Argon2id PHC string. Never returned by the API (see toPublicUser and toJSON below).
    passwordHash: { type: String, required: true },
    preferences: {
      alerts: alertPreferenceFields,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash
        return ret
      },
    },
  },
)

/**
 * Stored preferences merged over the defaults. Users created before Phase 4.2 (no
 * `preferences` in MongoDB) get every category enabled; only real booleans are trusted.
 */
export function resolvePreferences(user) {
  const stored = user?.preferences?.alerts || {}
  const alerts = Object.fromEntries(
    ALERT_PREFERENCE_KEYS.map((key) => [key, typeof stored[key] === 'boolean' ? stored[key] : true]),
  )
  return { alerts }
}

/** The only user shape the API ever returns. */
export function toPublicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    preferences: resolvePreferences(user),
  }
}

export const User = mongoose.model('User', userSchema)
