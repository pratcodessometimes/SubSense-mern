import mongoose from 'mongoose'

// Phase 4.2: in-app alert visibility preferences. These only control which alert categories
// the UI displays; detection, alert storage and analytics never read them.
export const ALERT_PREFERENCE_KEYS = ['priceIncrease', 'duplicate', 'serviceOverlap', 'inactivity', 'paymentAnomaly']

// Phase 4.3: how the recommendation ranking is weighted (see services/recommendationService.js).
export const RECOMMENDATION_FOCUS_VALUES = ['balanced', 'reduce_costs', 'billing_risks']

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
      recommendationFocus: { type: String, enum: RECOMMENDATION_FOCUS_VALUES, default: 'balanced' },
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
 * Stored preferences merged over the defaults. Users created before Phase 4.2/4.3 (no stored
 * preferences) get every alert category enabled and the 'balanced' recommendation focus.
 */
export function resolvePreferences(user) {
  const stored = user?.preferences?.alerts || {}
  const alerts = Object.fromEntries(
    ALERT_PREFERENCE_KEYS.map((key) => [key, typeof stored[key] === 'boolean' ? stored[key] : true]),
  )
  const focus = user?.preferences?.recommendationFocus
  return { alerts, recommendationFocus: RECOMMENDATION_FOCUS_VALUES.includes(focus) ? focus : 'balanced' }
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
