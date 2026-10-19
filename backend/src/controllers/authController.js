import { toPublicUser, User } from '../models/User.js'
import {
  createSession,
  deriveCsrfToken,
  hashPassword,
  normalizeEmail,
  revokeSession,
  validateEmail,
  validateName,
  validatePassword,
  verifyAgainstDummyHash,
  verifyPassword,
} from '../services/authService.js'
import { readCookie } from '../middleware/auth.js'

const INVALID_CREDENTIALS = 'Invalid email or password'

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
        name: name.trim(),
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

  return { register, login, me, logout }
}
