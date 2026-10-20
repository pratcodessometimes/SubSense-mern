# Phase 4.3 — Personalized Recommendations & Corrected Savings

Builds on Phase 4.1 (auth and isolation) and Phase 4.2 (preferences and review). Recommendations are a
**transparent rules layer** over data detection already stored. They involve no machine-learning inference,
no external AI and no probabilities. They are computed on every request and never persisted.

## Endpoint

`GET /api/recommendations` (session required; read-only). Takes no parameters: the user, focus and
alert visibility all come from the session user's saved preferences. Any `?userId`/`?focus` is ignored.

```jsonc
{
  "recommendations": [Recommendation],          // visible, ranked
  "hidden": { "count": 2, "byCategory": { "price_increase": 2 } },
  "summary": { "transactionCount", "subscriptionCount", "rejectedCount", "unreviewedCount", "confirmedCount",
               "activeSubscriptions", "monthlyRecurringSpend", "potentialSavings", "savingsBreakdown", "byPriority" },
  "meta": { "focus", "rankingPolicyVersion": "4.3.0", "method", "generatedAt" }
}
```

A `Recommendation` has: `id` (stable, `<category>:<key>`), `category`, `alertCategory`, `title`,
`description`, `explanation`, `evidence[]`, `action {label, detail}`, `impact`, `evidenceLevel`
(`strong|moderate|limited`), `evidenceLabel`, `priority {score, level, factors[]}`, `subscriptionIds`,
`primarySubscriptionId`, `reviewStatus`, `sourceAlertIds`, and (for anomalies) `anomalyReason`.

## Categories and impact types

| Category | Source | Impact type | Notes |
|---|---|---|---|
| `duplicate_billing` | `hasDuplicateCharges` on a cost-eligible subscription | `potential_duplicate_exposure` (`basis: strong\|suspected`) | Never "proven" or "fraud"; suspected = "unverified" |
| `price_increase` | `previousAmount < amount` | `additional_cost` (monthly + yearly, prev/current/%) | A cost, never a saving |
| `service_overlap` | overlap groups among cost-eligible subscriptions | `conditional_savings` + `assumption` | "may overlap"; keeps the most expensive service |
| `inactivity_review` | status `potentially_inactive` / `needs_review` / `unused` | `billing_amount_under_review` ("not a saving") | Never claims non-use or savings |
| `payment_anomaly` | automated `payment_anomaly` alerts | one-off `billing_amount_under_review` (`oneTimeDifference`) or `unquantified` for timing | Keeps `anomalyReason`; the deviation score is labelled "not a probability" |
| `unreviewed_subscription` | `reviewStatus: unreviewed` with confidence < 0.85 or ≥ ₹500/month | `unquantified` | Max 3 prompts, lowest confidence first |

Amounts the evidence does not support (missing, zero or non-numeric) are **omitted**. The impact becomes
`{ type: "unquantified" }`; no value is ever set to 0 or estimated. Monthly and yearly equivalents use
`yearly / 12` and `monthly × 12`.

*Cost-eligible* means not rejected, not in an inactivity status, and not `confirmed_cancelled`.

## Ranking policy (v4.3.0)

```
score = round((base + impactPoints) × focusWeight[category] + urgencyPoints)
level = high (≥ 55) | medium (≥ 30) | low
order = score desc, then category order, then id asc   (fully deterministic)
```

- **base** (evidence strength): strong duplicate 50, suspected 35; anomaly 26–38 by reason; price increase 30
  (36 if ≥ 20%); overlap 25; inactivity 15–20; unreviewed 12.
- **impactPoints**: 1 per ₹100/month of the relevant amount, capped at 20 (30 under `reduce_costs`). Inactivity
  amounts count at half weight because they are not savings.
- **urgency**: evidence ≤ 45 days old +10; older than 180 days −10; renewal within 14 days +5.
- **focusWeight**:

| | duplicate | anomaly | price | overlap | inactivity | unreviewed |
|---|---|---|---|---|---|---|
| balanced | 1 | 1 | 1 | 1 | 1 | 1 |
| reduce_costs | 1.3 | 0.8 | 1.2 | 1.5 | 0.9 | 0.8 |
| billing_risks | 1.4 | 1.6 | 1 | 0.6 | 1.1 | 0.8 |

Focus only reorders. It never changes which recommendations exist, their amounts, or the savings totals.
Each card exposes its `factors`, so the ranking can be explained in the UI.

## Personalization rules

- `not_subscription`: excluded everywhere (cards, overlaps, savings, anomaly cards for that slug).
- `confirmed`: still receives genuine duplicate, price, anomaly and inactivity findings; never a "please review" prompt.
- Alert visibility (Phase 4.2): cards whose category maps to a hidden alert category are left out of
  `recommendations` and counted in `hidden`. The server mapping (`alertPreferenceKey`) is checked against
  `frontend/src/lib/alertPreferences.ts` by a test. Underlying alerts and analytics are unaffected.
- Saved focus: `PATCH /api/auth/preferences { "recommendationFocus": "balanced" | "reduce_costs" | "billing_risks" }`,
  defaulting to `balanced`.

## Savings correction (`GET /api/analytics/kpis`)

Shared formulas live in `services/financialImpact.js`, which both the KPIs and recommendations use.

```
potentialSavings = duplicateExposure + conditionalSavings          (monthly equivalents, INR)
```

| Field | Meaning | In total? |
|---|---|---|
| `duplicateExposure` (alias `confirmedSavings`) | extra charges with strong duplicate evidence, normalized (₹9,900/yr → ₹825/mo) | yes |
| `conditionalSavings` | overlap secondaries, **excluding** subscriptions already in `duplicateExposure` | yes |
| `suspectedDuplicateExposure` (alias `suspectedDuplicateSavings`) | suspected-only duplicates | no |
| `inactivityReviewAmount` (deprecated alias `inactivitySavings`) | billing of subscriptions with missing payments | **no** (previously added — the corrected bug) |
| `priceIncreaseImpact` | extra monthly cost of price increases | no |

Inactive and cancelled subscriptions no longer feed the overlap estimate. This fixes the former
KNOWN ISSUE 1a (yearly duplicates were not divided by 12) and 1b (inactive subscriptions were counted twice).
`savingsBreakdown.formula`, `includedInTotal` and `excludedFromTotal` describe this in the response itself.
`monthlySpend` and `activeSubscriptions` are unchanged.
