# Phase 4.2 — Profile, Alert Preferences & Subscription Review

Builds on Phase 4.1 (see `PHASE_4_1_AUTH_AND_ISOLATION.md`). Every endpoint below requires a session,
and every mutation requires the `X-CSRF-Token` header. The user is always the session user; ids in
the body or query are never used.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| PATCH | `/api/auth/profile` | `{ "name": "Asha Rao" }` | `200 { user }` · `400` invalid name or any other field |
| PATCH | `/api/auth/preferences` | `{ "alerts": { "priceIncrease": false } }` (partial) | `200 { preferences }` · `400` unknown key / non-boolean |
| PATCH | `/api/subscriptions/:id/review` | `{ "reviewStatus": "confirmed" \| "not_subscription" \| "unreviewed" }` | `200 <subscription>` · `400` · `404` (not yours / not found) |

`user` (from register, login, `/auth/me` and profile updates) is now
`{ id, name, email, createdAt, preferences: { alerts: { priceIncrease, duplicate, serviceOverlap, inactivity, paymentAnomaly } } }`.
`/auth/me` still returns `{ user, csrfToken }`.

## Profile

Only `name` is editable. The name is trimmed and internal whitespace is collapsed. It must be 1–80 characters, with
no control or bidi-override characters. Any other field (email, passwordHash, `_id`, timestamps, preferences)
is rejected with 400, not silently ignored. Email stays read-only.

## Alert visibility preferences

Stored on the user document as `preferences.alerts.*` (Booleans, default `true`). Accounts created before
Phase 4.2 have no stored preferences and resolve to all-enabled (`resolvePreferences`). Updates use
per-key `$set`, so two quick toggles cannot overwrite each other.

These are **display-only** preferences:
- `/api/alerts` returns every alert. The Alerts page filters by category (`frontend/src/lib/alertPreferences.ts`).
- Detection, alert storage and analytics never read them, and disabling a category deletes nothing.
- Category mapping: `price_increase` → priceIncrease, `duplicate` → duplicate, `service_overlap` (or
  `subType: service_overlap`) → serviceOverlap, `inactivity_review` and legacy `unused` → inactivity,
  `payment_anomaly` → paymentAnomaly. Manual alerts follow their type's category.

## Subscription review

`Subscription.reviewStatus` (`unreviewed` default, `confirmed`, `not_subscription`) plus `reviewedAt`.
This is separate from the detection `status` (e.g. `price_increase`). Detection never writes either
field, so decisions survive every re-analysis. `PUT /api/subscriptions/:id` cannot change them.

The review endpoint saves the decision inside the user's detection queue, then re-runs that user's
detection to reconcile:

| | `unreviewed` / `confirmed` | `not_subscription` |
|---|---|---|
| Transactions | linked, `isRecurring: true` | **kept and still linked** (evidence), `isRecurring: false` |
| Automated alerts (price, duplicate, inactivity, anomaly) | generated as before | none; existing ones are removed as stale |
| Service overlap | participates | excluded; the overlap is recomputed without it |
| KPIs / category spend / upcoming renewals | included | excluded |
| Manual alerts | untouched | untouched |
| Subscription record | listed | still listed (so the decision can be undone) |

Resetting to `unreviewed` restores normal behaviour on the same reconciliation run. The legacy
`[manual]` note on a subscription still locks its detection `status` as before, independently of review.

No migration is needed: missing `reviewStatus` reads as `unreviewed` and missing preferences read
as enabled. No new indexes.
