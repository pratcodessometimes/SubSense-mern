# Phase 5.1 — Production Readiness

Audience: the repository owner and whoever performs Phase 5.2 (deployment) and 5.3 (live verification).
Status as of 2026-10-21. Nothing in this phase was deployed, and no cloud resource or Atlas database was read or modified.

Hosting target: **Vercel** (frontend), **Render** (API), **MongoDB Atlas** (database).

## 1. Release gates

| Gate | Status |
|---|---|
| Backend unit/HTTP suite (in-memory fake) | Passing |
| Schema/index definitions (real mongoose, no DB) | Passing |
| **Real MongoDB suite** (real server, real indexes, two users) | **Passing** against a disposable local MongoDB **8.0.17**. Not yet run against an Atlas *test* cluster. |
| Anomaly-index migration on a real server | Passing (disposable DB). **Not executed against Atlas.** |
| Frontend lint and production build | Passing |
| Browser checks (production bundle, Chrome) | Passing (36 checks) |
| Live HTTPS / cookie / proxy behaviour on Vercel + Render | **Not verified.** Belongs to Phase 5.3 (§6.4). |

## 2. What was hardened

| Area | Change |
|---|---|
| Configuration | `src/config/security.js` validates every setting and fails closed. Production requires an explicit `https` `CLIENT_ORIGIN`. Wildcard, `null` and non-origin values are rejected. `TRUST_PROXY=true` is rejected. Rate-limit values must be whole numbers (previously `AUTH_RATE_LIMIT_MAX=abc` **silently disabled** throttling). `COOKIE_SECURE=false` is rejected in production. Session TTL is capped at 90 days. Non-fatal production warnings cover a missing `TRUST_PROXY` and `SameSite=None`. |
| Startup | `server.js` validates config and `MONGO_URI` before connecting. Connection errors are redacted. Server selection times out after 15 s. It shuts down cleanly on `SIGTERM`. `npm run check:config` validates without starting. |
| HTTP | Security headers (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, a CSP for a JSON API, and HSTS in production). `Cache-Control: no-store` on all API responses. JSON body limit lowered from 1 MB to 100 kB. `/api/health` (liveness) plus `/api/health/ready` (database readiness). |
| Uploads | CSV limit lowered from 10 MB to 2 MB, one file, bounded fields. Multer limit errors now return 413/400 instead of 500. Imports are capped at 10,000 rows. |
| Errors | Invalid ids are no longer echoed back. Duplicate-key errors return 409. Body-parser client errors keep their 4xx status. |
| CSV import | Headers named `__proto__`, `constructor` or `prototype` are rejected (mitigates the csv-parse advisory, see §6.5). Re-imports of rows **with a bank reference** are now idempotent (they were duplicated before). Identical rows without a reference are kept (Known Issue 2). |
| Dependencies | Semver-compatible fixes: express 4.22.3, body-parser 1.20.8, qs 6.16.1, proxy-addr 2.0.8 (critical IP-spoofing advisory), multer 2.4.0. Frontend: vite 8.3.4 and source-map-js. No major upgrades. |
| **Legacy migration rollback** | **Critical fix.** `--rollback` previously unset `userId` on *every* document (see §4.3). |

## 3. Tests

| Command (in `backend/`) | Database | Notes |
|---|---|---|
| `npm run test:unit` | In-memory fake only | Default suite. Never connects anywhere. |
| `npm run test:schema` | None | Index/ownership definitions with the real mongoose package. |
| `npm run test:mongo:local` | **Disposable local `mongod`**, a fresh one per test file | Real server, real indexes. No configuration and no secrets needed. The first run downloads the pinned binary (~75 MB, Windows) into `node_modules/.cache`. |
| `npm run test:mongo` | `TEST_MONGO_URI` (opt-in, §3.1) | Same suite against a server you provide. |
| `npm run check:config` | None | Validates the API configuration and prints only non-secret settings. |

Optional: `SUBSENSE_REAL_DB_TTL_WAIT=1` also waits 60–140 s to observe MongoDB's TTL monitor actually delete an expired session. The default run checks only the TTL **index definition**. Extra arguments go to `node --test`, e.g. `npm run test:mongo:local -- --test-name-pattern=migration`.

Frontend (`frontend/`): `npm run lint`, `npm run build` (includes `tsc -b`). ML: `cd ml-service && python run_tests.py`.

### 3.1 Real-MongoDB safety model

`tests/support/realMongo.mjs` refuses to run unless **all** of these hold. Anything else fails with an error and never falls back to another database:

1. `SUBSENSE_REAL_DB_TESTS=1` (explicit opt-in).
2. `TEST_MONGO_URI` is set. `MONGO_URI` is **never** used and is removed from the environment of the local runner.
3. The database name in `TEST_MONGO_URI` starts with `subsense_test` (e.g. `subsense_test`, `subsense_test_ci`).
4. `NODE_ENV` is not `production`. `TEST_MONGO_URI` differs from `MONGO_URI` and does not point at the same host and database.
5. A non-local host additionally requires `SUBSENSE_REAL_DB_ALLOW_REMOTE=1`.

Each test file then creates its **own** database `<name>_r<8 hex>`. It verifies the database is empty, writes a run marker, and at the end drops **only** that database, after re-checking the marker. Data that existed before the run is never touched. Connection strings are never printed. All test users and transactions are synthetic.

To run against a remote test cluster (optional, before launch):

```bash
# Use a SEPARATE Atlas project/cluster (e.g. a free M0) with its own database user.
# Never the production cluster, never the production database user.
SUBSENSE_REAL_DB_TESTS=1 SUBSENSE_REAL_DB_ALLOW_REMOTE=1 \
TEST_MONGO_URI='mongodb+srv://<test-user>:<pw>@<test-cluster>/subsense_test' npm run test:mongo
```

CI (`.github/workflows/ci.yml`) runs `npm run test:mongo:local` on the runner. It uses no repository secrets and never defines `MONGO_URI`.

### 3.2 What the real-MongoDB suite covers

- **Indexes:** the exact index set on all five collections; unique normalized e-mail (rejected by mongoose *and* by MongoDB on a raw insert); unique session token hash; TTL index definition; the partial compound `userId_1_anomalyKey_1`.
- **Authentication:** Argon2id hash stored; only SHA-256 of the session token stored; login creates a separate session; logout deletes it; replaying the old cookie returns 401; expired and revoked sessions are rejected immediately.
- **Ownership:** two users import identical data. Identical slugs are stored per owner. Cross-user read, update, delete and review return 404 and leave the other user's records byte-for-byte unchanged. Alerts, recommendations and all analytics (KPIs, categories, monthly) are owner-only.
- **Financial workflows:** CSV import, then detection, then persisted price-increase and payment-anomaly alerts. Repeated analysis and re-import create no duplicates. Review decisions persist and survive re-analysis. Rejected subscriptions leave recorded spending, categories and recommendations. Preferences persist and drive the recommendation focus.
- **Migration:** see §4.

### 3.3 Local Windows note

With a local `mongod` on Windows, the server was observed to stall about a minute after the migration tests' index and collection drops. A rejected unique-index build also left an index-build coordinator running for about 30 s. The local runner therefore starts a fresh server per test file and skips the final database drop (the whole server and its data directory are deleted). Reads and writes were unaffected; only DDL stalled. The likely cause is deferred WiredTiger file removal on Windows. This is not expected on Linux (CI, Atlas), but see the caution in §4.2.

## 4. Anomaly-index migration (`anomalyKey_1`)

**Behaviour.** Phase 3.3 created a global unique sparse index `anomalyKey_1` on `alerts`. While it exists, a second user cannot store an `anomalyKey` that another user already has. Phase 4.1 adds `userId_1_anomalyKey_1` (unique per user; partial filter `anomalyKey: { $type: 'string' }`, so alerts without a key never collide). Mongoose builds the new index at startup (additive) and **never** drops the old one. The migration is never imported by `server.js` or `app.js`; a unit test enforces this. Because keys embed transaction ids, real cross-user collisions are rare. The old index is still a correctness hazard and should be removed deliberately.

**Verified on a real server** (disposable DB, `tests/realdb/anomalyIndexMigration.realdb.test.js`):
- Inspection is read-only.
- With the legacy index, user B's identical key is rejected (E11000).
- The migration drops only `anomalyKey_1`, keeps every document, and then allows identical keys for different users while still rejecting duplicates for the same user.
- Manual alerts never collide.
- Re-running the migration is a no-op.
- A fresh database never receives the legacy index.

### 4.1 Procedure (owner approval required; NOT executed in Phase 5.1)

```bash
# 0. Backup: take an Atlas on-demand snapshot (or `mongodump --uri "$MONGO_URI" --collection alerts --out <dir>`).
#    Confirm the snapshot has completed before continuing.
# 1. Read-only inspection: index names and whether anomalyKey_1 is present
npm run migrate:legacy
#    or in mongosh:  db.alerts.getIndexes()
# 2. Drop the legacy index and build the per-user index (idempotent)
npm run migrate:legacy -- --drop-legacy-anomaly-index --confirm drop-anomalyKey_1
# 3. Verify: db.alerts.getIndexes() lists _id_, userId_1_createdAt_-1, userId_1_anomalyKey_1 only
```

Run it from a trusted machine during a quiet period, with `MONGO_URI` for the target database exported only in that shell. The command touches indexes only, never documents.

**Failure handling.** If step 2 fails after the drop, re-run it: `createIndexes` is additive and idempotent. While no per-user index exists, anomaly upserts are still matched per user by the application, so a failure there causes no cross-user writes.

### 4.2 Rollback limitations

Recreating the global index (`db.alerts.createIndex({ anomalyKey: 1 }, { unique: true, sparse: true, name: 'anomalyKey_1' })`) **fails once any key is shared by two users**. Run this read-only pre-check first, and do not attempt the rollback if it returns anything:

```js
db.alerts.aggregate([
  { $match: { anomalyKey: { $type: 'string' } } },
  { $group: { _id: '$anomalyKey', count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } },
])
```

**Caution (observed on MongoDB 8.0.17):** a rejected unique-index build returns E11000 at once, but its build coordinator keeps running for about 30 s. Collection DDL issued meanwhile can wait behind it (§3.3). Do not chain DDL right after a failed build. Check `db.currentOp({ desc: /IndexBuild/ })` first. Restoring a snapshot is the only full rollback.

### 4.3 Legacy ownership rollback — critical fix

`npm run migrate:legacy -- --rollback <batchId>` filtered on `legacyMigrationBatch`, which is not a schema path. With mongoose `strictQuery: true` (set by `connectDB`), that filter was silently reduced to `{}`. The rollback would have **unset `userId` on every transaction, subscription and alert of every user**. The in-memory fake does not model `strictQuery`; the real-MongoDB suite found it. The rollback now uses the native driver with a validated UUID batch id, and the real-DB test asserts that other users' records survive. Assignment (`--apply`) was not affected: its filter is a schema path.

## 5. Analytics definitions (Phase 5.1)

`GET /api/analytics/monthly` returns three explicitly labelled quantities (all INR, all UTC calendar months):

| Field | Meaning | Not |
|---|---|---|
| `actual` | Payments in the user's transactions **linked to a detected subscription** (`isRecurring`), excluding subscriptions marked "not a subscription", summed per calendar month. Covers only the months spanned by imported data (first to last transaction). A month inside that span with no recurring payment is reported as `0` with `paymentCount: 0`. Yearly plans appear at full amount in the month paid. | Not normalized, not projected. Missing months outside the data are never invented. |
| `normalized` | Current monthly cost of active subscriptions (yearly / 12). Identical to the `monthlySpend` KPI. | Not cash flow. |
| `projection` | Charges scheduled from each **active** subscription's `nextBillingDate` and interval for the current month (remaining days) and following months. Excludes rejected, cancelled, missing-payment and stale subscriptions (expected date more than 7 days past). Duplicate charges are not projected. Assumptions are returned with the data. | Not a forecast of other spending. |

`GET /api/analytics/categories` now uses the KPI's subscription set (active statuses only) and rounding, so categories add up to `monthlySpend`. It returns `[]` (previously placeholder categories) for an empty account. This is a documented correctness change: cancelled and inactive subscriptions are no longer counted in the category breakdown.

The Analytics and Dashboard charts both render this endpoint through one shared component. All mock financial series were removed. Mock data remains only for the signed-out login preview, which is labelled "Example preview — sample data".

## 6. Security configuration for production

### 6.1 Preferred architecture: same-origin `/api` proxy

```
Browser ──https──> https://<app>.vercel.app/               (static SPA)
        ──https──> https://<app>.vercel.app/api/*  ──rewrite──> https://<api>.onrender.com/api/*
```

The browser only ever talks to the Vercel origin, so the session cookie is **first-party**: `SameSite=Lax`, `Secure`, `HttpOnly`, `Path=/api`, host-only. This works in browsers that block third-party cookies.

- The frontend uses `/api` by default in production builds (`VITE_API_URL` unset).
- In Phase 5.2, add this rewrite as the **first** entry of `rewrites` in `frontend/vercel.json`, with the real Render host:

  ```json
  { "source": "/api/:path*", "destination": "https://<api>.onrender.com/api/:path*" }
  ```

- `CLIENT_ORIGIN` on the API is the Vercel origin (exact, https). The browser's `Origin` header is forwarded by the rewrite and checked by `verifyOrigin`.

**Not recommended:** calling `https://<api>.onrender.com` directly from `https://<app>.vercel.app`. These are different sites, so the cookie would need `COOKIE_SAMESITE=none` and becomes a third-party cookie. Browsers that block third-party cookies (Safari, and Chrome with that setting) will not keep users signed in. **CORS does not fix this.** The API logs a warning when `SameSite=None` is configured. A custom domain where both are subdomains of one site (e.g. `app.example.com` and `api.example.com`) is the other acceptable layout.

### 6.2 Controls in place

- HttpOnly session cookie holding an opaque 256-bit token; only its SHA-256 hash is stored. Sessions rotate on login and are deleted on logout. Expiry is enforced on every request, and the TTL index removes stale rows.
- CSRF synchronizer token (HMAC of the session token) required in `X-CSRF-Token` on every authenticated mutation.
- Origin/Referer check on all non-GET API requests. Credentialed CORS is limited to the exact `CLIENT_ORIGIN` list.
- Secure cookies are forced in production. HSTS is sent in production.
- Argon2id password hashing, uniform login errors and dummy-hash timing for unknown e-mails.

### 6.3 Rate limiting

The authentication limiter is in-memory and per process: 20 attempts per 15 minutes per client IP, and per account for login. Counters reset on restart and are **not shared between instances**. That is acceptable for **one** Render instance. Running more than one instance, or autoscaling, needs a shared store (e.g. Redis) and is a future architecture requirement, not part of this phase.

### 6.4 `TRUST_PROXY` (verify in Phase 5.3)

The limiter keys on `req.ip`, which is correct only when `TRUST_PROXY` equals the real number of proxies in front of the app:

- Too low: every client appears to share the proxy's IP, so real users lock each other out.
- Too high: clients can spoof their IP and evade the limit.

Direct Render access is expected to be 1 hop. Behind the Vercel `/api` rewrite there is at least one more. **This was not verified in Phase 5.1.** In Phase 5.3, sign in from two networks and confirm they do not share a rate-limit budget, and that a forged `X-Forwarded-For` header does not reset it. Never set `true`.

### 6.5 Dependency advisories

| Package | Advisory | Status |
|---|---|---|
| proxy-addr | GHSA-jqcg-44mw-7w3h (IP spoofing via IPv4-mapped IPv6 trust subnet) | **Fixed** (2.0.8) |
| qs / body-parser / express | GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g | **Fixed** (qs 6.16.1) |
| multer | GHSA-3pph-fpjx-jg34 (orphaned disk writes on aborted uploads) | **Fixed** (2.4.0). SubSense uses memory storage, so it was not exposed. |
| csv-parse 5.6.0 | GHSA-8cw4-87c7-c6xx (prototype replacement via the columns path) | **Mitigated, not remediated.** Header names are produced by our own `columns` function, which rejects `__proto__`, `constructor` and `prototype` before any record is built (unit-tested). The fix requires csv-parse 7.x (major); evaluate that upgrade separately. `npm audit` will keep reporting this until then. |
| frontend source-map-js | GHSA-68fv-2mgg-jv7q (build-time) | **Fixed** |

## 7. Environment variables

**API (Render dashboard; never committed):**

| Variable | Production value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables Secure cookies, HSTS and strict origin validation. |
| `MONGO_URI` | Atlas SRV URI | Least-privilege database user (`readWrite` on the app database only). |
| `CLIENT_ORIGIN` | `https://<app>.vercel.app` | Exact origin; comma-separate if more than one. Required in production. |
| `TRUST_PROXY` | hop count (§6.4) | Never `true`. |
| `COOKIE_SAMESITE` | `lax` | With the same-origin proxy. |
| `SESSION_TTL_HOURS` | `168` | |
| `AUTH_RATE_LIMIT_MAX` / `_WINDOW_MS` | `20` / `900000` | |
| `PORT` | set by Render | |

**Frontend (Vercel):** none required. `VITE_API_URL` stays unset to use `/api`. Every `VITE_` value is public, so never put secrets or Atlas URIs there.

Templates: `backend/.env.example` (development, disposable tests, production) and `frontend/.env.example`.

## 8. Hosting settings (prepared, not applied)

| | Render (API) | Vercel (frontend) |
|---|---|---|
| Config file | `render.yaml` (repo root, Blueprint) | `frontend/vercel.json` |
| Root / working directory | `backend` | `frontend` |
| Node.js | 22 (`engines: 22.x`, `NODE_VERSION=22`) | 22 (`engines: 22.x`) |
| Install / build | `npm ci --omit=dev` | `npm ci` then `npm run build` |
| Start / output | `npm start` | `dist` |
| Health check | `/api/health` (liveness). `/api/health/ready` reports database state; don't use it as the restart check. | — |
| Routing | — | SPA fallback to `index.html` (excluding `/api/` and `/assets/`); `/api` rewrite added in 5.2 (§6.1) |
| Auto-deploy | off in the Blueprint (owner decides) | owner decides |

**Atlas.** Render's standard instances have no fixed egress IPs, so Atlas network access typically needs `0.0.0.0/0` unless Render static outbound IPs are used. If you open it, rely on a strong, unique, least-privilege database user. Enable Atlas backups or snapshots before launch.

**Startup.** On an invalid configuration, a missing or malformed `MONGO_URI`, or an unreachable cluster (15 s), the process exits non-zero with a message that contains no credentials.

## 9. Known issues

| Issue | Status |
|---|---|
| 1c. Confirmed-cancelled subscriptions in service-overlap savings | **Fixed.** The status filter used `cancelled` instead of `confirmed_cancelled`. Regression tests in `knownIssues.test.js`. |
| 2. CSV import collapses identical rows without a reference id | **Fixed** with multiset comparison: N identical rows in a file minus M already stored are inserted, so re-imports and overlapping statements stay idempotent. The response reports `identicalRowsKept`. **Remaining ambiguity:** without a bank reference, a later file containing *fewer* copies of an identical row than are stored cannot add a new copy. SubSense never invents transaction identities. |
| 3. Month-end subscriptions charged on the 1st are missed | **Fixed** narrowly. Only when calendar-month grouping rejects a merchant, it retries with proximity cycles (charges ≤ 5 days apart form one cycle) and accepts only a monthly result. Duplicate detection uses the same cycles, so a month holding two consecutive cycles is not reported as double billing. Already-detected merchants are unaffected. |
| 4. *(new)* Frequent identical purchases read as a monthly, duplicate-flagged subscription | **Open** (TODO test). Found while testing Issue 3, and present unchanged since Phase 2. Calendar-month grouping keeps each month's last purchase, so every-other-day ₹350 coffee looks monthly and "duplicated". Users can mark such items "not a subscription". A fix needs a change to the core recurrence rules and was left out of this phase. |

The ML rule baseline (`ml-service/scripts/rule_baseline`) calls the backend `analyzeMerchantRecurrence`. Re-running Phase 3 experiments may therefore detect a few additional month-end merchants. Existing reports are historical.

## 10. Known limitations

- Real-MongoDB validation ran on a local MongoDB 8.0.17 server, not on Atlas. Atlas-specific behaviour (network access, TLS, user roles, M0 limits) is a Phase 5.2/5.3 check.
- The rate limiter is per process (§6.3). There is no account lockout beyond rate limiting.
- `TRUST_PROXY` for the Vercel → Render chain is unverified (§6.4).
- csv-parse advisory is mitigated, not remediated (§6.5).
- The production JS bundle is about 730 kB (Vite warns above 500 kB); code-splitting is deferred.
- The header greeting always says "Good morning", and search and notifications are placeholders (labelled "coming soon").

## 11. Launch checklist

Items marked **[owner]** need the repository owner's explicit approval.

1. Review, commit and push the Phase 5.1 changes; CI must be green. **[owner]**
2. Optional but recommended: run `npm run test:mongo` against a separate Atlas **test** cluster (§3.1). **[owner]**
3. Atlas: create a least-privilege production database user, set network access, and enable backups. **[owner]**
4. Take an Atlas snapshot. Run the read-only index inspection (§4.1). Then decide whether to drop `anomalyKey_1`. **[owner]**
5. Create the Render service from `render.yaml`. Set `MONGO_URI`, `CLIENT_ORIGIN` and `TRUST_PROXY` in the dashboard. Run `npm run check:config` with the same values. **[owner]**
6. Add the `/api` rewrite to `frontend/vercel.json` and create the Vercel project with root `frontend`. **[owner]**
7. Phase 5.3: verify HTTPS, cookie flags (`Secure; HttpOnly; SameSite=Lax; Path=/api`), CSRF on mutations, logout revocation, the 401 after expiry, rate-limit IP attribution (§6.4), SPA deep links, `/api/health`, and two-account isolation on the live site.

## 12. Rollback considerations

- **Application:** redeploy the previous Render deploy and Vercel deployment (both keep history). Phase 5.1 adds no schema migrations. The new optional `Transaction.reference` field is ignored by older code.
- **Data:** the only Phase 5.1 data-shape addition is `reference` on newly imported transactions (additive).
- **Indexes:** see §4.2. A snapshot restore is the only complete rollback for an index migration.
- **Configuration:** the stricter validation can refuse a configuration an older build accepted (e.g. a wildcard `CLIENT_ORIGIN` or `TRUST_PROXY=true`). Fix the value; don't weaken the check.
