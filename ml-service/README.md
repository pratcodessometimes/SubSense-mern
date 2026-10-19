# SubSense ML Service — Phases 3.1 & 3.2

- Phase 3.1: dataset preparation and feature engineering for detecting recurring **subscription** patterns.
- Phase 3.2: offline classifiers compared against the existing rule engine, plus a separate
  payment-anomaly experiment.
- Phase 3.3: the robust anomaly detector is **ported to Node.js** and runs inside the Express app
  (`backend/src/services/paymentAnomalyService.js`). This package remains the reference implementation:
  `python scripts/export_anomaly_parity_fixture.py` regenerates the shared parity fixture.
  The classifier stays experimental and is not used by the app.

This module is separate from the Node.js backend. It never connects to
MongoDB, and the existing rule-based detection engine is unchanged.

| Doc | What it covers |
|---|---|
| [`docs/PROBLEM_DEFINITION.md`](docs/PROBLEM_DEFINITION.md) | Prediction unit, labels, label sources, leakage rules |
| [`docs/DATASET_CARD.md`](docs/DATASET_CARD.md) | The synthetic development dataset: contents and limitations |
| [`docs/REPOSITORY_ASSESSMENT.md`](docs/REPOSITORY_ASSESSMENT.md) | What exists in the repo, the rule baseline, the Phase 2 savings issues |
| [`docs/PHASE_3_1_CHECKPOINT.md`](docs/PHASE_3_1_CHECKPOINT.md) | Phase 3.1 checkpoint report and viva preparation |
| [`docs/PHASE_3_2_RESULTS.md`](docs/PHASE_3_2_RESULTS.md) | Phase 3.2 models, protocol, results vs the rule baseline, anomaly detection, viva |
| [`docs/PHASE_3_3_INTEGRATION.md`](docs/PHASE_3_3_INTEGRATION.md) | Phase 3.3: the robust anomaly detector ported into the Express app, safeguards, known issues, deployment checklist |

## 1. Setup

Requires Python ≥ 3.10.

```bash
cd ml-service
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt       # pandas, numpy, pytest
```

## 2. Commands

```bash
python -m pytest -q                   # full test suite (needs pytest)
python run_tests.py                   # same tests, no pytest needed (stdlib runner)

python scripts/build_dataset.py       # synthetic dataset -> data/synthetic/
python scripts/build_dataset.py --input ../sample-transactions.csv
                                      # any SubSense-format CSV -> data/local/<name>/ (git-ignored)

node scripts/generate_normalizer_fixture.mjs
                                      # re-run after changing backend merchantNormalizer.js
```

`build_dataset.py` exits with code 1 if validation finds an error.

Phase 3.2 experiments (deterministic, seed 42; all results are on **synthetic** data):

```bash
python scripts/train_evaluate.py           # classifiers + rule baseline -> reports/classification/  (~20 s)
python scripts/train_evaluate.py --fast    # quick smoke run
python scripts/train_evaluate.py --no-rules  # if Node.js is not available
python scripts/run_anomaly_experiment.py   # robust deviation vs Isolation Forest -> reports/anomaly/ (~5 s)
```

- The rule baseline runs the unmodified `backend/src/services/detectionService.js` through
  `scripts/rule_baseline/run.mjs`. Only the `mongoose` import is swapped for a stub that refuses any
  database access, so you don't need `node_modules` or MongoDB.
- The models are NumPy implementations (`subsense_ml/models.py`) because scikit-learn wasn't available.
  `pip install scikit-learn` enables `tests/test_sklearn_crosscheck.py`.

## 3. Module structure

```
ml-service/
├── subsense_ml/
│   ├── config.py               all thresholds, date/currency policy, forbidden feature columns
│   ├── merchant_normalizer.py  Python port of backend merchantNormalizer.js (parity-tested)
│   ├── preprocessing.py        parse/validate/clean rows; nothing dropped without a reason
│   ├── features.py             one feature row per (group, prediction_date); leakage guard
│   ├── labels.py               label sources; synthetic labels; provisional rule labels
│   ├── validation.py           dataset checks, leakage checks, deterministic group split
│   ├── synthetic.py            SYNTHETIC data generator (seeded, reproducible)
│   ├── pipeline.py             raw -> clean -> features -> labels -> validate -> files
│   ├── models.py               (3.2) NumPy LR / decision tree / random forest / imputer / scaler
│   ├── metrics.py              (3.2) per-class P/R/F1, macro-F1, confusion matrix, group bootstrap CI, AUC/AP
│   ├── rule_baseline.py        (3.2) runs the backend rule engine on the same snapshots
│   ├── classification.py       (3.2) group-split + group-CV experiment, ablation, archetype breakdown
│   └── anomaly.py              (3.2) median/MAD deviation detector, Isolation Forest, anomaly injection
├── scripts/
│   ├── build_dataset.py
│   ├── train_evaluate.py       (3.2)
│   ├── run_anomaly_experiment.py (3.2)
│   ├── rule_baseline/          (3.2) Node bridge: run.mjs, register.mjs, loader.mjs, mongoose-stub.mjs
│   └── generate_normalizer_fixture.mjs
├── reports/                    (3.2) generated metrics, confusion matrices, tree, importances
├── artifacts/                  (3.2) synthetic-trained model params (git-ignored, not for deployment)
├── tests/                      pytest-style tests + fixtures/normalizer_parity.json
├── data/synthetic/             generated synthetic dataset (safe to commit)
├── data/local/                 your own CSV outputs (git-ignored)
└── run_tests.py
```

Flow: `CSV → preprocess_transactions → build_feature_table(prediction_dates)
→ attach_labels → validate_feature_table → features.csv + dataset_report.json`.

## 4. Preprocessing policy

| Situation | What happens |
|---|---|
| Headers | Case-insensitive, like the backend. `reference/ref/transaction_id/txnid/id` are all treated as the bank reference. |
| Dates | Accepted formats: `YYYY-MM-DD`, `YYYY/MM/DD`, `DD-MM-YYYY`, `DD/MM/YYYY` (**day-first**, Indian convention), `14 Jun 2026`, and ISO timestamps with offset. Everything is converted to a **UTC calendar day**. Unknown formats → `invalid_date`. Years outside 1990–2100 → `implausible_date`. |
| Amounts | `₹`, `INR`, `Rs.`, commas and spaces are stripped. Non-numeric → `invalid_amount`. `inf/nan` → `non_finite_amount`. Negative → `negative_amount_credit_or_refund`. Zero → `zero_amount`. Only positive debits are used. |
| Currency | Assumed **INR** (the schema has no currency field and the app shows ₹). Rows with another currency → `non_base_currency`. They are never converted. |
| Missing merchant | `missing_merchant`, because the row can't be grouped. (A shared "unknown" group would create fake recurrence.) |
| Same reference + same content | Verified duplicate (the same bank record imported twice). The extra copy is excluded. |
| Same content, no reference, or different references | **Kept**, flagged `possible_duplicate`. This could be two genuine purchases or a genuine double charge, so it's not ours to delete. |
| Same reference, different content | **Kept**, flagged `reference_conflict`, plus a report warning. |
| Account missing | `Unknown Account` |

Every excluded row is written to `excluded_rows.csv` with its original text
(`raw_date`, `raw_amount`) and its `exclusion_reason`. The report checks that
`n_clean + n_excluded == n_input`.

## 5. Features

One row per `(group_id, prediction_date)`. Only transactions with
`date <= prediction_date` are used. Interval features are `NaN` when a group has fewer
than 2 distinct payment days (`is_eligible = 0`). Same-day repeats are collapsed
when computing intervals, but they count toward the amount statistics.

| Feature | Meaning |
|---|---|
| `n_transactions` | Payments seen up to the prediction date |
| `n_distinct_dates` | Distinct payment days |
| `n_same_day_repeats` | Extra payments on an already-seen day |
| `n_possible_duplicates` | Rows flagged `possible_duplicate` |
| `history_span_days` | First → last payment, in days |
| `n_distinct_months` / `n_distinct_years` | Observed monthly / yearly billing cycles |
| `has_min_history` | ≥ 2 distinct days (an interval exists) |
| `has_sufficient_history` | ≥ 3 distinct days (the rule engine's "strong cadence") |
| `n_intervals` | Number of gaps between payment days |
| `interval_mean` / `interval_median` | Average / median days between payments |
| `interval_std` | Std-dev of intervals (0 if only one interval) |
| `interval_min` / `interval_max` | Shortest / longest gap |
| `interval_cv` | std / mean: timing regularity |
| `monthly_interval_share` | Share of gaps within 24–36 days (same window as the backend) |
| `yearly_interval_share` | Share of gaps within 340–390 days |
| `monthly_period_deviation` | \|median − 30.44\| / 30.44 |
| `yearly_period_deviation` | \|median − 365.25\| / 365.25 |
| `gap_count` | Gaps > 1.5 × median (missed cycles) |
| `days_since_last` | Last payment → prediction date |
| `recency_ratio` | days_since_last / median gap (> 1 means overdue) |
| `is_irregular` | interval_cv > 0.25 |
| `amount_mean` / `amount_median` / `amount_std` / `amount_min` / `amount_max` | Amount statistics (INR) |
| `amount_cv` | Relative amount variability |
| `amount_range_ratio` | (max − min) / median |
| `stable_amount_share` | Share of payments within 1% of the median |
| `latest_to_median_amount_ratio` | > 1 suggests a recent price rise |
| `n_distinct_amounts` | Distinct prices |
| `n_distinct_descriptions` / `dominant_description_share` | How consistent the raw bank description is |
| `n_distinct_accounts` / `dominant_account_share` | How consistent the paying account is |

Metadata columns (**not** model inputs): `group_id, user_id, merchant_key,
merchant_name, prediction_date, first_tx_date_used, last_tx_date_used,
dataset_source, is_eligible, data_quality_warnings, label, label_source,
archetype` (synthetic only), and `split` (a suggested group-aware split).

Deliberately **excluded** from features: `isRecurring`, `subscriptionId`,
subscription `status`, rule `confidence`, `category`, the label, and raw identifiers.
See `config.FORBIDDEN_FEATURE_COLUMNS`.

## 6. Labels

`subscription` / `non_subscription` / `ambiguous`, each with a `label_source`
of `verified`, `user_confirmed`, `rule_provisional`, `synthetic` or `unlabeled`.
Rent, utilities and EMIs are **recurring but `non_subscription`**. The
`isRecurring` flag is only ever used as a `rule_provisional` label, because the rule engine
writes it. See `docs/PROBLEM_DEFINITION.md`.

## 7. Limitations

- **No real labelled data exists yet.** The synthetic data proves the pipeline works, not
  that a model is accurate.
- Timing and amount features alone can't separate rent or EMIs from subscriptions,
  except by amount magnitude.
- Single user, single currency (INR), Indian day-first date convention.
- An ISO timestamp near midnight IST shifts to the previous UTC day. This is intentional, and it
  matches how the backend stores dates.
- The merchant normalizer is a regex port. If `backend/src/services/merchantNormalizer.js`
  changes, regenerate the parity fixture, or the parity test will fail (by design).
