# SubSense branch integration audit — 2026-10-22

## Scope and preservation

Repository: `pratcodessometimes/SubSense-mern`. Baseline: `origin/main` at
`9d00bf0e6af4e51a492c0baccf26e7260616f11d`. All five remote branches and the sole
pre-existing local branch were inspected after `git fetch --all --prune`.
GitHub's complete PR list contained six PRs, all merged; there was no open PR
before this integration. PR metadata was checked against the local commit graph.

The original checkout was clean, with no staged or unstaged changes. Local `main`
was fast-forwarded from `50b5a9a` to `9d00bf0` with `git merge --ff-only origin/main`.
Ignored environment/credential files, installed dependencies and build outputs
were left in place. No application database was accessed.

Integration uses the separate sibling worktree `SubSense-integration`, on
`integration/phase-5-branch-audit-20261022`, created from the baseline above.
The original `SubSense-mern` checkout remains on clean, synchronized `main`.
Separate npm dependencies were installed in the integration worktree; Python
dependencies and the Node 22 test runtime were installed under the OS temporary
directory. No resets, force pushes, branch deletions or history rewrites were used.

## Branch audit

Ahead/behind counts are relative to the baseline `origin/main`, before integration.
"Unique files" means the three-dot diff from the merge base, not a diff that
mistakes later main changes for missing branch features.

| Ref | Tip | Ahead | Behind | Unique commits | Unique files | Decision |
| --- | --- | ---: | ---: | --- | ---: | --- |
| local `main` (initial) | `50b5a9a` | 0 | 30 | None | 0 | Fast-forward to baseline |
| `origin/main` | `9d00bf0` | 0 | 0 | None | 0 | Integration baseline |
| `origin/feature/ML-intelligence` | `74674b6` | 0 | 19 | None | 0 | Already merged through PRs #1 and #2 |
| `origin/feature/phase-4` | `35b7c10` | 0 | 12 | None | 0 | Already merged through PRs #3 and #4 |
| `origin/feature/phase-5-deployment` | `a358254` | 5 | 2 | `542cb44`, `bf2fc8a`, `f086dce`, `e396217`, `a358254` | 7 | Integrate these five commits |
| `origin/test` | `3733540` | 1 | 46 | `3733540` | 19 | Exclude incompatible prototype |

`origin/HEAD` is a symbolic alias for `origin/main`, not an additional branch.
No other pre-existing local or remote branches were found (`git branch -avv`,
`git for-each-ref`, and `git ls-remote --heads origin`).

| Branch | Merge base with baseline main | PR/history evidence |
| --- | --- | --- |
| initial local `main` | `50b5a9a` | Direct ancestor; fast-forward safe |
| ML | `74674b6` | Branch tip is a direct ancestor; PR #2 head exactly matches tip |
| Phase 4 | `35b7c10` | Branch tip is a direct ancestor; PR #4 head exactly matches tip |
| Phase 5 | `4d5b18a` | PR #5 merged through `29432e0`; PR #6 merged `4d5b18a`; later five commits missing |
| test | `b2be299` | Diverged before the Phase 1/2 implementation; no PR found |

The full branch graph, commit subjects, merge bases, two-dot logs, three-dot file
diffs, and `git cherry origin/main <ref>` were reviewed. ML and Phase 4 need no
squash-equivalence inference: their complete histories are reachable from main.
All five outstanding Phase 5 commits and the test prototype are patch-distinct
(`git cherry` reports `+`); actual code review, rather than patch identity alone,
determines the different integration decisions below.

## Incorporated changes

The Phase 5 branch was merged without conflicts in merge commit `c0501a9`, retaining
the five original commits and both existing main merge commits. No duplicate
cherry-picks were created.

| Commit | Purpose and justification |
| --- | --- |
| `542cb44` | Pin CI runners to Ubuntu 24.04, bound real-MongoDB execution, improve timeout diagnostics |
| `bf2fc8a` | Add explicit, manually invoked same-origin deployment smoke checks |
| `f086dce` | Preserve the historical deployment investigation and owner setup instructions |
| `e396217` | Replace the local MongoDB supervisor's blocking child execution with asynchronous `spawn`, allowing mongod output to drain; add per-step diagnostics |
| `a358254` | Explicit free Render plan and Singapore region; keep deployment-specific values owner-supplied |

Affected files: `.github/workflows/ci.yml`, `render.yaml`,
`backend/scripts/smoke-deployed.mjs`, `backend/tests/support/realMongo.mjs`,
`backend/tests/support/run-real-mongo-local.mjs`,
`backend/tests/support/run-real-mongo.mjs`, and
`backend/docs/PHASE_5_2_DEPLOYMENT_STATUS.md`, plus this audit report.

## Exclusions and compatibility review

- **ML:** main already contains Python preparation, classification, anomaly
  experiments, evaluation, fixtures and tests. Runtime classification remains
  experimental/offline. Express uses rule-based subscription detection plus the
  Node port of the Python anomaly detector, with shared parity fixtures and
  failure isolation. No Python inference server or deployed classifier was added.
- **Phase 4:** keep the newer session/CSRF/Origin checks, owner-scoped controllers
  and services, profile/preferences/review features, explainable recommendations,
  corrected financial impacts and authenticated frontend. Replaying older commits
  would add no missing functionality.
- **Phase 5 already on main:** preserve production security safeguards, safe
  legacy ownership rollback, CSV deduplication and recurrence fixes, actual monthly
  analytics, live charts, mobile navigation and real-database coverage. The Phase 5
  branch is behind only main's two merge commits; that does not make its five
  subsequent fixes obsolete.
- **`test` / `3733540`:** introduces a parallel `detectionEngine.js`, merchant
  normalizer, transient upload results, CSV/PDF/DOCX parsing and an upload modal.
  Its controller calls unscoped `Transaction.find()` and writes records without a
  server-assigned owner. The detector groups globally by merchant, describes lack
  of payment as unused usage, and produces alert types/data that differ from the
  current persisted models. The modal also advertises formats the parser cannot
  handle. Main already provides CSV import, automatic persisted detection, manual
  entry, subscription views, price/timing anomaly evidence and alerts using the
  newer owner-scoped APIs. PDF/DOCX import and the modal are distinct prototype
  features, not falsely claimed as merged; they require separate parser validation,
  ownership integration, dependency review, accessibility and security tests.
  Importing this commit would duplicate engines and regress isolation, so none of
  it was merged.

## Conflict and engineering review

There were **zero textual merge conflicts**. The seven Phase 5 files merged with
Git's normal `ort` strategy; no blanket `ours`/`theirs` resolution was used.
Backend models/controllers/routes, authentication, ownership, analytics, ML parity,
frontend guards/API types, migration safeguards, environment templates, package
scripts/locks and hosting configuration were reviewed. This integration changes
no application schemas, financial calculations, frontend components or dependency
versions, and introduces no migration.

The test prototype's architectural/security incompatibilities were resolved by
excluding it, not by replacing the newer implementation. There are no unresolved
Git conflicts or newly introduced blockers identified by the executed checks.

## Executed validation

Windows; Node **22.23.4**; Python **3.12.10**; MongoDB **8.0.17**. Fresh integration
dependencies installed from both lockfiles. The initial `npm ci` used host Node
24 and emitted engine warnings; all JS checks/builds below ran using the temporary
Node 22 runtime matching the project's declared major. ML requirements plus the
optional scikit-learn cross-check dependency were installed in a temporary venv.

| Check | Passed | Failed | Other / evidence |
| --- | ---: | ---: | --- |
| Backend `node tests/support/run-unit.mjs` | 193 | 0 | 8 schema tests skipped under fake mongoose; 1 existing TODO assertion |
| Real-mongoose `node --test tests/schemaIndexes.test.js` | 8 | 0 | All eight unit-run skips exercised here |
| `node tests/support/run-real-mongo-local.mjs` | 17 | 0 | 6 migration/index + 11 app; 1 opt-in TTL-monitor test skipped |
| Live `node --test tests/api.integration.test.js` | 9 | 0 | Real app + disposable local MongoDB; explicit local `API_BASE` |
| Python `python run_tests.py` | 89 | 0 | 0 skips, including optional scikit-learn checks; 263.77 s |
| Same-origin smoke script through Vite preview proxy | 20 | 0 | Production frontend build; development API cookie settings over local HTTP |
| Frontend lint | 1 command | 0 | Two existing `set-state-in-effect` warnings |
| Frontend TypeScript `tsc -b` | 1 command | 0 | No type errors |
| Frontend Vite production build | 1 command | 0 | JS bundle 730.19 kB; existing >500 kB warning |
| Backend JS/MJS syntax checks | 69 files | 0 | Source, scripts, and tests |
| Whitespace/conflict-marker review | Pass | 0 | `git diff --check`; no unmerged paths |

The smoke check verified frontend HTML and SPA fallback, API health/readiness,
no-store headers, registration, cookie attributes, session restoration, CSRF and
foreign-Origin rejection, anonymous rejection, six-row CSV import/detection,
monthly payment counts, recommendations, two-account isolation and 404 behavior,
logout revocation and login. A temporary harness started the real API and Vite
preview with a disposable server and supplied its exact origin before app creation.
The initial harness mistakenly appended the origin after app initialization and
got 9 passes / 11 failures (registration 403 and dependent checks). Correcting that
harness setup produced the 20/20 result; no application security checks were relaxed.

Real-database tests exercised per-user indexes, authentication, CRUD isolation,
imports, analytics, persisted anomalies, recommendation state, and legacy migration
rollback/index compatibility only on fresh run databases. No Atlas connection or
production migration was executed. The deployed smoke script was never run against
a production host. No browser surface was available in the session, so rendered
browser interactions, mobile navigation and real-browser cookie behavior are
**not verified** by these HTTP checks. HTTPS redirect/HSTS/Secure-cookie deployment
checks remain pending; production-cookie configuration is covered by backend tests.

Raw check logs are retained locally in the OS temporary folder
`subsense-audit-20261022` (outside Git). No logs, venv, binaries, databases, build
outputs, temporary harness or model artifacts are included in the PR.

## Security and remaining review requirements

- Production npm audit: **0 critical, 0 high, 1 moderate** (`csv-parse`,
  [GHSA-8cw4-87c7-c6xx](https://github.com/advisories/GHSA-8cw4-87c7-c6xx)). Main
  already rejects `__proto__`, `constructor` and `prototype` headers before building
  records, with regression coverage. npm's suggested package fix is a semver-major
  upgrade; it was not bundled into this synchronization. Frontend installation
  reported zero dependency vulnerabilities.
- The existing TODO `KNOWN ISSUE 4` in `backend/tests/knownIssues.test.js` exposes
  frequent identical purchases being mistaken for a monthly duplicate-billed
  subscription. It is an expected failing TODO, not a passing correctness claim;
  preserve it for a separately reviewed detection fix.
- A pattern scan of **305 unique tracked blobs across all branch tips** found only
  documented MongoDB placeholders and explicitly synthetic security-test URIs.
  No real credentials were identified by that bounded scan. This is not an
  exhaustive historical secret audit. Original local `.env` and credential files
  remain ignored and were not copied into the integration workspace.
- Review both existing React effect warnings and the bundle-size warning in a
  separate change if desired; no unrelated frontend refactor was introduced.
- GitHub CI must be checked on the final PR commit. Local Windows success does not
  itself establish Linux runner success.

## Manual deployment and migration requirements

No deployments were created or triggered by a deployment command. Render retains
`autoDeploy: false`; main is not pushed or merged. This is a code-integration PR,
not evidence that a production site is ready.

Before an owner-controlled deployment: set Render's `MONGO_URI`, exact HTTPS
`CLIENT_ORIGIN`, and validated `TRUST_PROXY`; add the actual API destination as the
first `/api/:path*` rewrite in `frontend/vercel.json`; configure the frontend root
as `frontend`; leave `VITE_API_URL` unset for same-origin requests. The repository
deliberately has no invented API endpoint. Validate proxy attribution/rate limits,
HTTPS cookies, logout/account switching and mobile/browser behavior afterward.

No new migration is required for these five commits. Existing pre-authentication
data stays invisible until an owner explicitly assigns it using the documented
legacy tool. Snapshot and inspect legacy anomaly indexes before any optional
ownership/index migration; no such migration was run on user data here.

The owner must review and merge the PR manually. Auto-merge and approval are not enabled.
