import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Always stored normalized (trimmed + lowercased) so the unique index is case-insensitive.
    email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 254 },
    // Argon2id PHC string. Never returned by the API (see toPublicUser and toJSON below).
    passwordHash: { type: String, required: true },
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

/** The only user shape the API ever returns. */
export function toPublicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  }
}

export const User = mongoose.model('User', userSchema)
