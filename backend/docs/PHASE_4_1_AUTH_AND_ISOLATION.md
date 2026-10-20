# Phase 4.1 — Authentication & User Data Isolation

This document covers how SubSense authenticates users, how financial data is isolated per user,
and the **manual, opt-in** steps for legacy data and MongoDB indexes.

## 1. Authentication model

| Concern | Implementation |
|---|---|
| Password hashing | Argon2id (`argon2` package), m = 64 MiB, t = 3, p = 4, random salt per hash |
| Password policy | 8–128 characters, at least one letter and one number |
| Login timing | Unknown emails are verified against a dummy hash, so response time and the message (`Invalid email or password`) are identical for unknown email and wrong password |
| Session token | 256-bit random opaque token (`crypto.randomBytes(32)`, base64url) |
| Session storage | `sessions` collection stores only `SHA-256(token)`, `userId`, `expiresAt`; TTL index removes expired rows; middleware also rejects expired rows immediately |
| Cookie | `subsense_session`, `HttpOnly`, `SameSite=Lax` (configurable), `Path=/api`, `Secure` when `NODE_ENV=production` or `COOKIE_SECURE=true` |
| Session lifetime | `SESSION_TTL_HOURS` (default 168 h = 7 days), absolute |
| Rotation | Login/registration revokes any session cookie the browser already had |
| Logout | Deletes the session row (server-side revocation) and clears the cookie |
| CSRF | Synchronizer token bound to the session: `HMAC-SHA256(key = raw session token, "subsense-csrf-v1")`. Returned by register/login/`GET /auth/me`, held **in memory** by the SPA, and required as `X-CSRF-Token` on every authenticated `POST`/`PUT`/`DELETE` (including CSV import, analysis and logout) |
| Origin check | All state-changing `/api` requests with an `Origin` (or `Referer`) outside `CLIENT_ORIGIN` are rejected (403). This also blocks login CSRF |
| CORS | `credentials: true`, explicit allowlist from `CLIENT_ORIGIN` (comma-separated), allowed headers `Content-Type`, `X-CSRF-Token` |
| Rate limiting | In-memory fixed window: `AUTH_RATE_LIMIT_MAX` (default 20) per `AUTH_RATE_LIMIT_WINDOW_MS` (default 15 min), per IP for login+register, and additionally per account email for login. Returns 429 with `Retry-After` |

### Endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| POST | `/api/auth/register` | public, rate limited | `201 { user, csrfToken }` + cookie; `400 { error, fields }`; `409` duplicate email |
| POST | `/api/auth/login` | public, rate limited | `200 { user, csrfToken }` + cookie; `401 { error: 'Invalid email or password' }` |
| GET | `/api/auth/me` | session | `200 { user, csrfToken }`; `401` |
| POST | `/api/auth/logout` | session + CSRF | `200 { message }`, cookie cleared |

`user` is always `{ id, name, email, createdAt }`; password hashes and tokens are never returned or logged.
`/api/health` stays public. `/api/transactions`, `/api/subscriptions`, `/api/alerts` and `/api/analytics` require a session (401 `UNAUTHENTICATED`), and their mutations also require the CSRF token (403 `CSRF_INVALID`).

### Deployment notes

- Same-site deployments (e.g. `app.example.com` + `api.example.com`, or `localhost:5173` + `localhost:5000`) work with the default `COOKIE_SAMESITE=lax`.
- If the frontend and API are on **different sites**, set `COOKIE_SAMESITE=none` (requires Secure cookies/HTTPS). CSRF protection then relies on the token + Origin check, which remain enforced.
- Behind a reverse proxy, set `TRUST_PROXY` (e.g. `1`) so rate limiting sees the client IP.
- The rate limiter and the per-user detection queue are per process. With multiple API instances, move rate limiting to a shared store (e.g. Redis).

## 2. Data isolation

`Transaction`, `Subscription` and `Alert` have a required `userId` (ObjectId → `User`). Ownership rules:

- `userId` is always taken from the authenticated session (`req.user.id`), never from body, query or headers. Body `userId`/`_id`/timestamps are ignored (explicit field allowlists).
- Every read, update and delete is a single **atomic owner-scoped query** (`{ _id, userId }` or `{ slug, userId }`). Another user's id or slug therefore behaves exactly like a non-existent record (404, no content).
- `utils/ownership.js#requireUserId` throws on a missing or invalid owner, so a missing identity can never degrade into an unscoped (global) query.
- CSV de-duplication compares only against the importing user's transactions.
- Analytics (`/kpis`, `/categories`) aggregate only the caller's records.

### Detection pipeline

`runSubscriptionDetection(userId, referenceDate)` and `syncAlertsForSubscriptions(userId, subscriptions)` now require a validated owner. Every query inside them (transaction fetch, subscription upsert, transaction linking/unlinking `updateMany`, alert find/update/create/stale-delete, alert count) is scoped by `userId`.
`runPaymentAnomalyDetection({ userId, ... })` / `upsertAnomalyAlert(Alert, doc, userId)` scope upserts and stale removal by owner.
The pure algorithms (`analyzeMerchantRecurrence`, `detectPriceIncrease`, `detectDuplicateCharges`, `detectServiceOverlaps`, `evaluateSubscriptionActivity`, anomaly scoring) are unchanged.

Detection runs for the **same** user are serialized per process, so a background run (triggered by create/update/delete of a transaction) cannot interleave with a manual analysis. Runs for different users touch disjoint data.

## 3. Indexes

Created by Mongoose `autoIndex` on startup (additive only; nothing is dropped automatically):

| Collection | Index |
|---|---|
| users | `{ email: 1 }` unique |
| sessions | `{ tokenHash: 1 }` unique, `{ userId: 1 }`, `{ expiresAt: 1 }` TTL (`expireAfterSeconds: 0`) |
| transactions | `{ userId: 1, date: -1 }`, `{ userId: 1, subscriptionId: 1 }` |
| subscriptions | `{ userId: 1, slug: 1 }`, `{ userId: 1, amount: -1 }` |
| alerts | `{ userId: 1, createdAt: -1 }`, `userId_1_anomalyKey_1` = `{ userId: 1, anomalyKey: 1 }` **unique**, `partialFilterExpression: { anomalyKey: { $type: 'string' } }` |

A partial filter is used instead of `sparse` because a compound sparse index still indexes every alert that has a `userId`, which would make all non-anomaly alerts of one user collide on `anomalyKey: null`.

### Required manual index migration: `anomalyKey_1`

Phase 3.3 created a **global** unique sparse index `anomalyKey_1` on `alerts`. Until it is dropped, two users cannot hold the same `anomalyKey`. (Keys embed transaction ids, so collisions only occur for anomalies without a transaction id. A collision is never resolved against the other user: the retry is owner-scoped, so the second user's alert is simply not written.)

To drop it after review:

```bash
# 1. Back up first (Atlas snapshot or mongodump --uri "$MONGO_URI" --collection alerts)
# 2. Inspect: shows whether anomalyKey_1 exists and the current index names
npm run migrate:legacy
# 3. Drop the old global index and build the per-user index
npm run migrate:legacy -- --drop-legacy-anomaly-index --confirm drop-anomalyKey_1
```

Rollback: recreate the old index with `db.alerts.createIndex({ anomalyKey: 1 }, { unique: true, sparse: true, name: 'anomalyKey_1' })`. This only succeeds if no `anomalyKey` value is shared across users.

> **Phase 5.1:** verified on a real MongoDB 8.0 server, including the read-only pre-check to run *before* any index rollback. See `PHASE_5_1_PRODUCTION_READINESS.md` §4.
Never use `Model.syncIndexes()` / `syncIndexes` in production without review; it drops indexes not in the schema.

## 4. Legacy (pre-authentication) records

Records created before Phase 4.1 have no `userId`. They are **not deleted, not assigned automatically and not visible** to any user: every API query requires `userId = <session user>`, which never matches a missing owner. Detection runs never read or modify them.

Assigning them to one account is optional and manual (`src/migrations/legacyOwnership.js`):

```bash
# 0. Back up the database (Atlas snapshot or mongodump). Required before any non-dry-run step.
# 1. The target account must already exist (register it in the app).
# 2. Dry run (default, read-only): counts unowned records, verifies the target, reports conflicts
npm run migrate:legacy -- --target-email owner@example.com
# 3. Apply: --confirm must repeat the email exactly
npm run migrate:legacy -- --apply --target-email owner@example.com --confirm owner@example.com
#    -> prints a batchId; each migrated document is tagged with legacyMigrationBatch=<batchId>
# 4. Rollback (if needed): makes exactly that batch unowned/invisible again
npm run migrate:legacy -- --rollback <batchId> --confirm <batchId>
```

> **Phase 5.1 — critical fix.** Before Phase 5.1 the rollback in step 4 was unsafe on a real database:
> mongoose `strictQuery` removed the non-schema filter `legacyMigrationBatch`, so the rollback matched
> **every** document and unset `userId` on all users' records. It now uses the native driver with a
> validated UUID batch id, and is covered by `tests/realdb/anomalyIndexMigration.realdb.test.js`.
> Never run the rollback from a checkout older than Phase 5.1.

Safety properties:
- The dry run makes no writes. Apply refuses unknown targets and refuses if any legacy anomaly alert shares an `anomalyKey` with an alert the target already owns.
- Only documents with no `userId` (missing or null) are touched; nothing is ever deleted.
- After assignment, the target should run **Analyze** once so detection reconciles the inherited subscriptions/alerts with their transactions. The dry run also reports legacy subscription slugs that the target already owns, which would otherwise end up duplicated.
- Run during a quiet period. The tool is not transactional across the three collections. On partial failure, run the rollback with the printed batch id.

## 5. Seeding

`npm run seed` no longer wipes collections. It seeds one explicitly chosen demo account and only deletes **that account's** records:

```bash
npm run seed -- --email demo@subsense.local --password 'DemoPass123'   # creates the account
npm run seed -- --email demo@subsense.local --reset-existing           # re-seed an existing demo account
```

It refuses to touch an existing account without `--reset-existing`, refuses `NODE_ENV=production` without `--allow-production`, and never touches other users or legacy data.

## 6. Tests

| Command | What runs | Database |
|---|---|---|
| `npm run test:unit` | All backend tests incl. `auth.test.js`, `isolation.test.js` (real Express app on an ephemeral port) | **In-memory fake** (`tests/support/fake-mongoose.mjs`), never Atlas |
| `npm run test:schema` | Index/ownership definitions with the **real** mongoose package | No connection |
| `node --test tests/api.integration.test.js` | Live HTTP test against a running server (`API_BASE`, default `http://localhost:5000/api`) | Whatever that server uses; point it at a disposable database |
| `npm run test:mongo:local` (Phase 5.1) | Real Express app + real mongoose + real indexes, two users | Throwaway local `mongod` per test file; see `PHASE_5_1_PRODUCTION_READINESS.md` |

The fake enforces `required`/`enum`/`min`, unique and partial compound unique indexes and the query operators the app uses. It does not reproduce MongoDB query planning, real TTL deletion or transactions. Run the integration test against a disposable MongoDB (not production Atlas) before deploying.
