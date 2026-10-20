// Phase 4.1 test helper: owner ids for tests that write user-owned records directly.
import { randomBytes } from 'node:crypto'

/** A fresh, valid ObjectId-shaped user id (never collides with a real account). */
export function newTestUserId() {
  return randomBytes(12).toString('hex')
}
