// Phase 4.1 authentication primitives: password hashing, opaque session tokens and
// session-bound CSRF tokens. No custom cryptography: Argon2id via the `argon2` package,
// and Node's crypto for randomness, SHA-256 and HMAC.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { Session } from '../models/Session.js'

// OWASP-recommended Argon2id configuration (m = 64 MiB, t = 3, p = 4 — the argon2 package defaults).
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 2 ** 16, timeCost: 3, parallelism: 4 }

export const PASSWORD_MIN_LENGTH = 8
// Upper bound keeps hashing cost predictable (prevents long-password DoS).
export const PASSWORD_MAX_LENGTH = 128
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

/** @returns {string | null} an error message, or null when valid */
export function validateEmail(email) {
  if (!email) return 'Email is required'
  if (email.length > 254 || !EMAIL_RE.test(email)) return 'Enter a valid email address'
  return null
}

/** @returns {string | null} */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required'
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password must contain at least one letter and one number'
  return null
}

/** @returns {string | null} */
export function validateName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) return 'Name is required'
  if (name.trim().length > 80) return 'Name must be at most 80 characters'
  return null
}

export function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

// Verifying against this hash when an email is unknown keeps login timing uniform,
// so response time does not reveal whether an account exists.
let dummyHashPromise = null
export function verifyAgainstDummyHash(password) {
  dummyHashPromise ||= hashPassword(randomBytes(16).toString('hex'))
  return dummyHashPromise.then((hash) => verifyPassword(hash, String(password ?? '')))
}

export function generateSessionToken() {
  return randomBytes(32).toString('base64url') // 256 bits of entropy, 43 chars
}

export function isWellFormedToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token)
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * CSRF token bound to the session (synchronizer-token pattern without extra storage).
 * It is derived from the raw session token, which only the browser's HttpOnly cookie holds;
 * the stored SHA-256 token hash cannot be used to compute it.
 */
export function deriveCsrfToken(sessionToken) {
  return createHmac('sha256', sessionToken).update('subsense-csrf-v1').digest('base64url')
}

export function csrfTokenMatches(sessionToken, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const expected = Buffer.from(deriveCsrfToken(sessionToken))
  const actual = Buffer.from(candidate)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export async function createSession(userId, { ttlMs, userAgent } = {}) {
  const token = generateSessionToken()
  const now = Date.now()
  await Session.create({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now + ttlMs),
    lastUsedAt: new Date(now),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : undefined,
  })
  return { token, expiresAt: new Date(now + ttlMs) }
}

/** Returns the live session for a raw token, or null if unknown, malformed or expired. */
export async function findActiveSession(token) {
  if (!isWellFormedToken(token)) return null
  const session = await Session.findOne({ tokenHash: hashSessionToken(token) })
  if (!session) return null
  if (!(session.expiresAt instanceof Date) || session.expiresAt.getTime() <= Date.now()) {
    await Session.deleteOne({ _id: session._id })
    return null
  }
  return session
}

export async function revokeSession(token) {
  if (!isWellFormedToken(token)) return
  await Session.deleteOne({ tokenHash: hashSessionToken(token) })
}
