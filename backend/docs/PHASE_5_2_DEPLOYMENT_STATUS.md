# Phase 5.2 — Deployment Status

Audience: the repository owner. Status as of 2026-10-21 (overnight run). **Nothing has been deployed.**

## 1. CI (GitHub Actions) on `4d5b18a`

Runs 39510189386 (push) and 39510281665 (pull request) produced identical results:

| Job | Result |
|---|---|
| Backend (unit + schema) | success |
| Frontend (lint + production build) | success |
| ML service tests (Python/Node parity) | success |
| Backend (real MongoDB, disposable local server) | **failure**: the test step ran 604 s, i.e. a test file hung until the 600 s per-file timeout |

Job logs need an authenticated GitHub session, so the exact hung test was **not** identified. Facts gathered:
- The run started the day after `ubuntu-latest` began migrating to Ubuntu 26 (GitHub runner notice).
- No MongoDB 8.0.17 binary exists for Ubuntu 26. `mongodb-memory-server` falls back to the Ubuntu 24.04 build.
- Locally (Windows), a related MongoDB DDL stall was seen in Phase 5.1 (PHASE_5_1 §3.3).

Changes (unstaged) to make the job deterministic and self-diagnosing:
- All CI jobs pinned to `runs-on: ubuntu-24.04`. The real-MongoDB step is capped at 20 minutes.
- `tests/support/run-real-mongo.mjs`: `--test-force-exit` (a finished file can't idle on a leftover handle) and a 5-minute per-file/test timeout.
- `tests/support/run-real-mongo-local.mjs`: on a failed file, prints operations running longer than 5 s on the disposable `mongod` (namespace, command, lock wait).

Verified locally: `npm run test:mongo:local` passes (6 + 11 pass, 1 opt-in TTL test skipped) in 9 s. **Not verified in CI:** that requires your push. If it still fails, the job log now shows which test hung and the stuck MongoDB operation.

## 2. Deployment — blocked (owner action required)

No Render, Vercel, Atlas or GitHub credentials, CLIs or connectors are available in this environment. I inspected only public URLs:
- `subsense-api.onrender.com` does not respond.
- `subsense.vercel.app` belongs to an unrelated site (different page title).

No SubSense deployment exists under the names in `render.yaml`. Creating the services needs your accounts, so **no Atlas, Render or Vercel resource was read, created or modified.**

Steps for you (from PHASE_5_1 §11):
1. Push the CI fix and confirm all four jobs are green.
2. Atlas: production database user with `readWrite` on the app database only; network access; backups; a snapshot. Optionally run the read-only index inspection `npm run migrate:legacy` (no flags).
3. Render: New → Blueprint → this repo/branch (`render.yaml`). Set `MONGO_URI`, `CLIENT_ORIGIN` (the final Vercel https origin) and `TRUST_PROXY` (start with `2` behind the Vercel rewrite; verify in 5.3). Check `https://<api>.onrender.com/api/health`.
4. Vercel: import the repo with Root Directory `frontend` (Vite preset; `vercel.json` sets the commands). Before deploying, add this as the **first** rewrite in `frontend/vercel.json`:
   `{ "source": "/api/:path*", "destination": "https://<api>.onrender.com/api/:path*" }`
   Leave `VITE_API_URL` unset.
5. Set `CLIENT_ORIGIN` on Render to the exact Vercel origin and redeploy the API.

Note: your Atlas values are in `backend/atlas-credentials.env` under `MONGODB_*` names. The app reads only `MONGO_URI` (Render dashboard in production). That file is git-ignored; keep it out of the repository.

## 3. Smoke test (ready to run after deployment)

```bash
cd backend
node scripts/smoke-deployed.mjs https://<app>.vercel.app
```

It checks:
- **Routing:** frontend and SPA deep links, the HTTP→HTTPS redirect, `/api/health` and readiness through the proxy, `no-store`, HSTS.
- **Sessions:** registration; cookie flags (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api`, host-only).
- **Request protection:** CSRF and foreign-Origin rejection, anonymous 401.
- **Data:** CSV import and detection, monthly analytics, recommendations, two-account isolation.
- **Logout:** old-cookie rejection and re-login.

It creates two synthetic accounts (`smoke-a-<tag>@example.test`, `smoke-b-<tag>@example.test`) with six synthetic transactions. There is no account-deletion API, so they remain in the database. It never prints cookies, tokens or passwords.

Validated locally against the production build behind a same-origin `/api` proxy with a disposable MongoDB: **20/20 pass**. The 4 HTTPS-only checks apply only to an `https://` target.

## 4. Remaining for Phase 5.3

- Run the smoke test against the live site (24 checks over HTTPS).
- Verify `TRUST_PROXY` attribution: two networks must not share a rate-limit budget, and a forged `X-Forwarded-For` must not reset it (PHASE_5_1 §6.4).
- Browser checks on the live site: mobile navigation, charts, account switching.
- Decide on the `anomalyKey_1` index migration after a snapshot (PHASE_5_1 §4).
- Optional: real-MongoDB suite against a separate Atlas test cluster.
