"""
Feature engineering: turn one merchant group's history into one feature row.

Unit of prediction ("one example")
    (group_id, prediction_date)
    group_id        = user_id + "::" + normalized merchant key
    prediction_date = the "as-of" day. Only transactions dated ON OR BEFORE
                      this day are visible. This is enforced inside
                      `compute_group_features`, so leakage-safety does not
                      depend on the caller remembering to filter.

Every feature is listed in FEATURE_COLUMNS with a docstring-style description
in FEATURE_DESCRIPTIONS (also rendered in the README).
"""

from __future__ import annotations

from collections import Counter
from typing import Iterable, Optional, Sequence

import numpy as np
import pandas as pd

from . import config

# Metadata columns: identify the row, carry labels, support validation.
# They are NOT model inputs.
META_COLUMNS = [
    "group_id",
    "user_id",
    "merchant_key",
    "merchant_name",
    "prediction_date",
    "first_tx_date_used",
    "last_tx_date_used",
    "dataset_source",
    "is_eligible",
    "data_quality_warnings",
]

FEATURE_DESCRIPTIONS = {
    # --- history size / quality -------------------------------------------
    "n_transactions": "Number of payments seen up to the prediction date (includes same-day repeats).",
    "n_distinct_dates": "Number of distinct payment days.",
    "n_same_day_repeats": "n_transactions - n_distinct_dates (extra charges on an already-seen day).",
    "n_possible_duplicates": "Rows flagged by preprocessing as identical to another row (not removed).",
    "history_span_days": "Days between first and last payment.",
    "n_distinct_months": "Distinct calendar months with a payment (observed monthly billing cycles).",
    "n_distinct_years": "Distinct calendar years with a payment (observed yearly billing cycles).",
    "has_min_history": "1 if at least 2 distinct payment days exist (an interval can be computed).",
    "has_sufficient_history": "1 if at least 3 distinct payment days exist (rule engine's 'strong cadence').",
    # --- temporal ----------------------------------------------------------
    "n_intervals": "Number of gaps between consecutive distinct payment days.",
    "interval_mean": "Mean days between consecutive payments.",
    "interval_median": "Median days between consecutive payments (robust to one odd gap).",
    "interval_std": "Std-dev of intervals (sample, ddof=1). 0 when only one interval exists.",
    "interval_min": "Shortest interval in days.",
    "interval_max": "Longest interval in days.",
    "interval_cv": "interval_std / interval_mean. Low = very regular timing.",
    "monthly_interval_share": "Share of intervals within 24-36 days (backend monthly window).",
    "yearly_interval_share": "Share of intervals within 340-390 days (backend yearly window).",
    "monthly_period_deviation": "|interval_median - 30.44| / 30.44. 0 = perfectly monthly.",
    "yearly_period_deviation": "|interval_median - 365.25| / 365.25. 0 = perfectly yearly.",
    "gap_count": "Intervals longer than 1.5 x the median interval (missed cycles).",
    "days_since_last": "Days from the last visible payment to the prediction date.",
    "recency_ratio": "days_since_last / interval_median. >1 means the next payment is overdue.",
    "is_irregular": "1 if interval_cv > 0.25 (needs >= 2 intervals).",
    # --- amount ------------------------------------------------------------
    "amount_mean": "Mean payment amount (INR).",
    "amount_median": "Median payment amount (INR).",
    "amount_std": "Std-dev of amounts (ddof=1). 0 for a single payment.",
    "amount_min": "Smallest payment (INR).",
    "amount_max": "Largest payment (INR).",
    "amount_cv": "amount_std / amount_mean. Relative amount variability.",
    "amount_range_ratio": "(amount_max - amount_min) / amount_median.",
    "stable_amount_share": "Share of payments within 1% of the median amount.",
    "latest_to_median_amount_ratio": "Latest amount / median amount (>1 suggests a price rise).",
    "n_distinct_amounts": "Distinct amounts after rounding to 2 decimals.",
    # --- merchant / account consistency ------------------------------------
    "n_distinct_descriptions": "Distinct raw bank descriptions that normalized to this merchant.",
    "dominant_description_share": "Share of payments using the most common raw description.",
    "n_distinct_accounts": "Distinct accounts/cards used for this merchant.",
    "dominant_account_share": "Share of payments made from the most common account.",
}

FEATURE_COLUMNS = list(FEATURE_DESCRIPTIONS.keys())

# Features that are undefined (NaN) when fewer than 2 distinct payment days exist.
INTERVAL_FEATURES = [
    "interval_mean", "interval_median", "interval_std", "interval_min", "interval_max",
    "interval_cv", "monthly_interval_share", "yearly_interval_share",
    "monthly_period_deviation", "yearly_period_deviation", "gap_count", "recency_ratio",
]


def _to_day(value) -> pd.Timestamp:
    ts = pd.Timestamp(value)
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts.normalize()


def _share_of_mode(values: Sequence) -> float:
    counts = Counter(values)
    return max(counts.values()) / len(values)


def compute_group_features(group_tx: pd.DataFrame, prediction_date) -> Optional[dict]:
    """Compute one feature dict for ONE group as of `prediction_date`.

    `group_tx` must contain columns produced by preprocessing (date, amount,
    account, description_key, possible_duplicate, row_id). Rows dated after
    `prediction_date` are ignored here — this is the leakage guard.
    Returns None if the group has no visible transactions yet.
    """
    pred = _to_day(prediction_date)
    visible = group_tx[group_tx["date"] <= pred]
    if visible.empty:
        return None
    visible = visible.sort_values(["date", "row_id"], kind="mergesort")

    dates = visible["date"]
    distinct_days = pd.DatetimeIndex(dates.drop_duplicates())
    n_tx = int(len(visible))
    n_dates = int(len(distinct_days))
    amounts = visible["amount"].to_numpy(dtype=float)

    f: dict = {}
    f["n_transactions"] = n_tx
    f["n_distinct_dates"] = n_dates
    f["n_same_day_repeats"] = n_tx - n_dates
    f["n_possible_duplicates"] = int(visible["possible_duplicate"].sum()) if "possible_duplicate" in visible else 0
    f["history_span_days"] = int((distinct_days[-1] - distinct_days[0]).days)
    f["n_distinct_months"] = int(dates.dt.to_period("M").nunique())
    f["n_distinct_years"] = int(dates.dt.year.nunique())
    f["has_min_history"] = int(n_dates >= config.MIN_DATES_FOR_INTERVALS)
    f["has_sufficient_history"] = int(n_dates >= config.SUFFICIENT_HISTORY_DATES)

    days_since_last = int((pred - distinct_days[-1]).days)
    f["days_since_last"] = days_since_last

    # Whole days between consecutive distinct payment days (unit-safe).
    intervals = np.asarray((distinct_days[1:] - distinct_days[:-1]).days, dtype=float)
    f["n_intervals"] = int(len(intervals))
    if len(intervals) >= 1:
        mean = float(intervals.mean())
        median = float(np.median(intervals))
        std = float(intervals.std(ddof=1)) if len(intervals) >= 2 else 0.0
        f["interval_mean"] = mean
        f["interval_median"] = median
        f["interval_std"] = std
        f["interval_min"] = float(intervals.min())
        f["interval_max"] = float(intervals.max())
        f["interval_cv"] = std / mean if mean > 0 else 0.0
        f["monthly_interval_share"] = float(np.mean(
            (intervals >= config.MONTHLY_INTERVAL_MIN) & (intervals <= config.MONTHLY_INTERVAL_MAX)))
        f["yearly_interval_share"] = float(np.mean(
            (intervals >= config.YEARLY_INTERVAL_MIN) & (intervals <= config.YEARLY_INTERVAL_MAX)))
        f["monthly_period_deviation"] = abs(median - config.NOMINAL_MONTH_DAYS) / config.NOMINAL_MONTH_DAYS
        f["yearly_period_deviation"] = abs(median - config.NOMINAL_YEAR_DAYS) / config.NOMINAL_YEAR_DAYS
        f["gap_count"] = int(np.sum(intervals > config.GAP_MULTIPLIER * median)) if median > 0 else 0
        f["recency_ratio"] = days_since_last / median if median > 0 else np.nan
    else:
        for col in INTERVAL_FEATURES:
            f[col] = np.nan
    f["is_irregular"] = int(len(intervals) >= 2 and f["interval_cv"] > config.IRREGULAR_INTERVAL_CV)

    a_mean = float(amounts.mean())
    a_median = float(np.median(amounts))
    a_std = float(amounts.std(ddof=1)) if n_tx >= 2 else 0.0
    f["amount_mean"] = a_mean
    f["amount_median"] = a_median
    f["amount_std"] = a_std
    f["amount_min"] = float(amounts.min())
    f["amount_max"] = float(amounts.max())
    f["amount_cv"] = a_std / a_mean if a_mean > 0 else 0.0
    f["amount_range_ratio"] = (f["amount_max"] - f["amount_min"]) / a_median if a_median > 0 else 0.0
    f["stable_amount_share"] = float(np.mean(
        np.abs(amounts - a_median) <= config.AMOUNT_EQUAL_TOLERANCE * a_median))
    f["latest_to_median_amount_ratio"] = float(amounts[-1] / a_median) if a_median > 0 else np.nan
    f["n_distinct_amounts"] = int(len(np.unique(np.round(amounts, 2))))

    descs = visible["description_key"].tolist()
    accts = visible["account"].tolist()
    f["n_distinct_descriptions"] = int(len(set(descs)))
    f["dominant_description_share"] = float(_share_of_mode(descs))
    f["n_distinct_accounts"] = int(len(set(accts)))
    f["dominant_account_share"] = float(_share_of_mode(accts))

    # Metadata (not features)
    warnings = []
    if n_tx == 1:
        warnings.append("single_transaction")
    if n_dates < config.SUFFICIENT_HISTORY_DATES:
        warnings.append("insufficient_history")
    if f["is_irregular"]:
        warnings.append("irregular_intervals")
    if f["n_intervals"] and f["gap_count"]:
        warnings.append("payment_gaps")
    if f["n_possible_duplicates"]:
        warnings.append("possible_duplicates")
    if f["n_same_day_repeats"]:
        warnings.append("same_day_repeats")
    if f["n_distinct_accounts"] > 1:
        warnings.append("multiple_accounts")
    if f["n_intervals"] and not np.isnan(f["recency_ratio"]) and f["recency_ratio"] > 2:
        warnings.append("stale_group")

    first = visible.iloc[0]
    f["_meta"] = {
        "first_tx_date_used": distinct_days[0],
        "last_tx_date_used": distinct_days[-1],
        "is_eligible": int(n_dates >= config.MIN_DATES_FOR_INTERVALS),
        "data_quality_warnings": ";".join(warnings),
        "merchant_name": first.get("merchant_name", ""),
    }
    return f


def build_feature_table(
    clean_tx: pd.DataFrame,
    prediction_dates: Optional[Iterable] = None,
) -> pd.DataFrame:
    """Build the feature table for every (group, prediction_date) pair.

    prediction_dates: iterable of dates. If None, a single snapshot at the
    latest transaction date in the data is used. A group only produces a row
    for a prediction date if it has at least one transaction on/before it.
    """
    columns = META_COLUMNS + FEATURE_COLUMNS
    if clean_tx is None or len(clean_tx) == 0:
        return pd.DataFrame({c: pd.Series(dtype="object") for c in columns})

    if prediction_dates is None:
        prediction_dates = [clean_tx["date"].max()]
    pred_days = sorted({_to_day(d) for d in prediction_dates})

    rows = []
    for group_id, g in clean_tx.groupby("group_id", sort=True):
        g = g.sort_values(["date", "row_id"], kind="mergesort")
        for pred in pred_days:
            feats = compute_group_features(g, pred)
            if feats is None:
                continue
            meta = feats.pop("_meta")
            row = {
                "group_id": group_id,
                "user_id": g["user_id"].iloc[0],
                "merchant_key": g["merchant_key"].iloc[0],
                "merchant_name": meta["merchant_name"],
                "prediction_date": pred,
                "first_tx_date_used": meta["first_tx_date_used"],
                "last_tx_date_used": meta["last_tx_date_used"],
                "dataset_source": g["dataset_source"].iloc[0] if "dataset_source" in g else "unknown",
                "is_eligible": meta["is_eligible"],
                "data_quality_warnings": meta["data_quality_warnings"],
            }
            row.update(feats)
            rows.append(row)

    table = pd.DataFrame(rows, columns=columns)
    return table.sort_values(["group_id", "prediction_date"], kind="mergesort").reset_index(drop=True)
