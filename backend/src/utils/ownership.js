// Phase 4.1 ownership helpers. Every financial query must be built from the
// authenticated user's id (req.user.id), never from request input.

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/

export function isObjectIdString(value) {
  return typeof value === 'string' && OBJECT_ID_RE.test(value)
}

/**
 * Validates and normalizes a user id for data access. Throws instead of falling back to an
 * unscoped query, so a missing identity can never turn into a global read or write.
 */
export function requireUserId(userId) {
  const id = userId == null ? '' : String(userId)
  if (!OBJECT_ID_RE.test(id)) {
    throw new Error('A valid authenticated userId is required for this operation')
  }
  return id
}

/** Merges an owner constraint into a filter. The owner always wins over any userId in `filter`. */
export function ownedBy(userId, filter = {}) {
  return { ...filter, userId: requireUserId(userId) }
}

/** Escapes a string for literal use inside a RegExp. */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
