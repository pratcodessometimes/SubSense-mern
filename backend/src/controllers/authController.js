import { ALERT_PREFERENCE_KEYS, RECOMMENDATION_FOCUS_VALUES, resolvePreferences, toPublicUser, User } from '../models/User.js'
import {
  createSession,
  deriveCsrfToken,
  hashPassword,
  normalizeEmail,
  normalizeName,
  revokeSession,
  validateEmail,
  validateName,
  validatePassword,
  verifyAgainstDummyHash,
  verifyPassword,
} from '../services/authService.js'
import { readCookie } from '../middleware/auth.js'

const INVALID_CREDENTIALS = 'Invalid email or password'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function createAuthController(config) {
  const { cookieName, cookie, ttlMs } = config.session

  async function startSession(req, res, user) {
    // Rotate: a login/registration never reuses a session the browser already had.
    const previous = readCookie(req, cookieName)
    if (previous) await revokeSession(previous)

    const { token } = await createSession(user._id, { ttlMs, userAgent: req.get('user-agent') })
    res.cookie(cookieName, token, { ...cookie, maxAge: ttlMs })
    return { user: toPublicUser(user), csrfToken: deriveCsrfToken(token) }
  }

  async function register(req, res) {
    // Only these three fields are read from the body (no mass assignment).
    const { name, email, password } = req.body || {}
    const normalizedEmail = normalizeEmail(email)
    const errors = {}
    const nameError = validateName(name)
    const emailError = validateEmail(normalizedEmail)
    const passwordError = validatePassword(password)
    if (nameError) errors.name = nameError
    if (emailError) errors.email = emailError
    if (passwordError) errors.password = passwordError
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: Object.values(errors)[0], fields: errors })
    }

    const conflict = { error: 'An account with this email already exists', fields: { email: 'Email is already registered' } }
    if (await User.findOne({ email: normalizedEmail })) return res.status(409).json(conflict)

    let user
    try {
      user = await User.create({
        name: normalizeName(name),
        email: normalizedEmail,
        passwordHash: await hashPassword(password),
      })
    } catch (err) {
      if (err && err.code === 11000) return res.status(409).json(conflict) // concurrent registration
      throw err
    }

    res.status(201).json(await startSession(req, res, user))
  }

  async function login(req, res) {
    const { email, password } = req.body || {}
    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'Email and password are required' })
    }
    if (password.length > 1024) return res.status(401).json({ error: INVALID_CREDENTIALS })

    const user = await User.findOne({ email: normalizedEmail })
    const valid = user ? await verifyPassword(user.passwordHash, password) : await verifyAgainstDummyHash(password)
    // Same status and message for unknown email and wrong password.
    if (!user || !valid) return res.status(401).json({ error: INVALID_CREDENTIALS })

    res.json(await startSession(req, res, user))
  }

  async function me(req, res) {
    res.json({ user: toPublicUser({ _id: req.user.id, ...req.user }), csrfToken: deriveCsrfToken(req.authSession.token) })
  }

  async function logout(req, res) {
    await revokeSession(req.authSession.token)
    res.clearCookie(cookieName, cookie)
    res.json({ message: 'Logged out' })
  }

  // Phase 4.2 — PATCH /api/auth/profile. Only `name` is editable; the email stays read-only.
  // Any other field (email, passwordHash, _id, timestamps, preferences, ...) is rejected rather
  // than silently ignored, so a client can never believe it changed a protected field.
  async function updateProfile(req, res) {
    const body = req.body
    if (!isPlainObject(body)) return res.status(400).json({ error: 'Expected a JSON object' })
    const unsupported = Object.keys(body).filter((key) => key !== 'name')
    if (unsupported.length > 0) {
      return res.status(400).json({ error: `Field(s) cannot be updated here: ${unsupported.join(', ')}` })
    }
    const nameError = validateName(body.name)
    if (nameError) return res.status(400).json({ error: nameError, fields: { name: nameError } })

    // The filter comes only from the session, so this can only ever touch the caller's account.
    const user = await User.findOneAndUpdate(
      { _id: req.user.id },
      { $set: { name: normalizeName(body.name) } },
      { new: true, runValidators: true },
    )
    if (!user) return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' })
    res.json({ user: toPublicUser(user) })
  }

  // PATCH /api/auth/preferences — partial update of
  //   Phase 4.2  { "alerts": { "priceIncrease": false } }       alert visibility switches
  //   Phase 4.3  { "recommendationFocus": "reduce_costs" }      recommendation ranking focus
  // Either or both may be sent. Unknown keys and invalid values are rejected; nothing is saved then.
  async function updatePreferences(req, res) {
    const body = req.body
    const shape = 'Expected { "alerts"?: { <category>: true | false }, "recommendationFocus"?: "balanced" | "reduce_costs" | "billing_risks" }'
    if (!isPlainObject(body) || Object.keys(body).length === 0 ||
      Object.keys(body).some((key) => key !== 'alerts' && key !== 'recommendationFocus')) {
      return res.status(400).json({ error: shape })
    }

    const update = {}
    if ('alerts' in body) {
      if (!isPlainObject(body.alerts)) return res.status(400).json({ error: shape })
      const entries = Object.entries(body.alerts)
      if (entries.length === 0) return res.status(400).json({ error: 'No preferences provided' })
      const unknown = entries.filter(([key]) => !ALERT_PREFERENCE_KEYS.includes(key)).map(([key]) => key)
      if (unknown.length > 0) return res.status(400).json({ error: `Unknown alert preference(s): ${unknown.join(', ')}` })
      const invalid = entries.filter(([, value]) => typeof value !== 'boolean').map(([key]) => key)
      if (invalid.length > 0) return res.status(400).json({ error: `Preference value(s) must be true or false: ${invalid.join(', ')}` })
      // Per-key $set so two quick toggles cannot overwrite each other.
      for (const [key, value] of entries) update[`preferences.alerts.${key}`] = value
    }
    if ('recommendationFocus' in body) {
      if (!RECOMMENDATION_FOCUS_VALUES.includes(body.recommendationFocus)) {
        return res.status(400).json({ error: `recommendationFocus must be one of: ${RECOMMENDATION_FOCUS_VALUES.join(', ')}` })
      }
      update['preferences.recommendationFocus'] = body.recommendationFocus
    }

    const user = await User.findOneAndUpdate({ _id: req.user.id }, { $set: update }, { new: true, runValidators: true })
    if (!user) return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' })
    res.json({ preferences: resolvePreferences(user) })
  }

  return { register, login, me, logout, updateProfile, updatePreferences }
}
