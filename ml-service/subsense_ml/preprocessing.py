"""
Transaction preprocessing for the SubSense ML pipeline.

Input : a CSV path or a pandas DataFrame shaped like the SubSense CSV import
        (required: date, merchant, amount; optional: account, currency,
        reference/ref/transaction_id/txnid/id, user_id, isRecurring, category).
Output: PreprocessResult with
          - clean    : rows that are safe to build features from
          - excluded : rows that were NOT used, each with an explicit reason
          - report   : a JSON-serialisable data-quality summary

Design rules (see README "Preprocessing policy"):
  * Nothing is silently deleted. Every dropped row lands in `excluded`.
  * Dates are parsed from an explicit list of formats and converted to UTC
    calendar days. Unknown formats are rejected, never guessed.
  * Only debit amounts > 0 in the base currency (INR) are used.
  * A duplicate is only REMOVED when it is *verified*: same bank reference id
    and same content. Identical rows WITHOUT a reference are kept and flagged
    `possible_duplicate`, because two coffees at the same price on the same
    day are legitimate, and a real double-charge is exactly what Phase 2's
    duplicate detector wants to see.
  * This module never touches MongoDB.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Union

import numpy as np
import pandas as pd

from . import config
from .merchant_normalizer import normalize_merchant

REQUIRED_COLUMNS = ("date", "merchant", "amount")

# Lower-cased input header -> canonical column name.
_HEADER_ALIASES = {
    "date": "date",
    "merchant": "merchant",
    "description": "merchant",
    "amount": "amount",
    "account": "account",
    "currency": "currency",
    "reference": "reference",
    "ref": "reference",
    "transaction_id": "reference",
    "txnid": "reference",
    "id": "reference",
    "user_id": "user_id",
    "userid": "user_id",
    "isrecurring": "is_recurring",
    "is_recurring": "is_recurring",
    "category": "category",
    # synthetic ground-truth columns are passed through untouched
    "archetype": "archetype",
    "label": "label",
    "label_source": "label_source",
}

DEFAULT_USER_ID = "default_user"
DEFAULT_ACCOUNT = "Unknown Account"

_ISO_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
_AMOUNT_NOISE = re.compile(r"(₹|inr|rs\.?|,|\s)", re.IGNORECASE)


@dataclass
class PreprocessResult:
    clean: pd.DataFrame
    excluded: pd.DataFrame
    report: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Field parsers (pure functions -> easy to unit test)
# ---------------------------------------------------------------------------
def parse_date_utc(value):
    """Parse one date value into a tz-naive pandas Timestamp at UTC midnight.

    Returns (timestamp_or_None, error_reason_or_None).
    """
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None, "missing_date"
    if isinstance(value, (pd.Timestamp, datetime)):
        ts = pd.Timestamp(value)
        if ts is pd.NaT:
            return None, "missing_date"
        if ts.tzinfo is not None:
            ts = ts.tz_convert("UTC").tz_localize(None)
        return _check_plausible(ts.normalize())

    text = str(value).strip()
    if not text:
        return None, "missing_date"

    if _ISO_TIMESTAMP.match(text):
        try:
            ts = pd.Timestamp(text)
        except (ValueError, TypeError):
            return None, "invalid_date"
        if ts.tzinfo is not None:
            ts = ts.tz_convert("UTC").tz_localize(None)
        return _check_plausible(ts.normalize())

    for fmt in config.ACCEPTED_DATE_FORMATS:
        try:
            dt = datetime.strptime(text, fmt)
        except ValueError:
            continue
        return _check_plausible(pd.Timestamp(dt).normalize())
    return None, "invalid_date"


def _check_plausible(ts: pd.Timestamp):
    if ts.year < 1990 or ts.year > 2100:
        return None, "implausible_date"
    return ts, None


def parse_amount(value):
    """Parse one amount. Returns (float_or_None, error_reason_or_None).

    Accepts '₹1,499.00', 'INR 499', 'Rs. 99', 649, '649.5'.
    Negative values are credits/refunds and zero values are typically card
    verifications or free trials: both are excluded from debit features.
    """
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None, "missing_amount"
    if isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, bool):
        amount = float(value)
    else:
        text = _AMOUNT_NOISE.sub("", str(value))
        if text == "":
            return None, "missing_amount"
        try:
            amount = float(text)
        except ValueError:
            return None, "invalid_amount"
    if not math.isfinite(amount):
        return None, "non_finite_amount"
    if amount < 0:
        return None, "negative_amount_credit_or_refund"
    if amount == 0:
        return None, "zero_amount"
    return amount, None


def _clean_text(value) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def load_raw(source: Union[str, Path, pd.DataFrame]) -> pd.DataFrame:
    """Read a CSV (everything as text, so we control parsing) or copy a DataFrame."""
    if isinstance(source, pd.DataFrame):
        return source.copy()
    return pd.read_csv(source, dtype=str, keep_default_na=False, encoding="utf-8")


def preprocess_transactions(
    source: Union[str, Path, pd.DataFrame],
    dataset_source: str = "real",
) -> PreprocessResult:
    """Validate, clean and normalise transactions. See module docstring."""
    raw = load_raw(source)

    rename = {}
    for col in raw.columns:
        key = str(col).strip().lower()
        if key in _HEADER_ALIASES and _HEADER_ALIASES[key] not in rename.values():
            rename[col] = _HEADER_ALIASES[key]
    df = raw.rename(columns=rename)
    df = df[[c for c in df.columns if c in set(_HEADER_ALIASES.values())]].copy()

    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Input is missing required columns: {', '.join(missing)}")

    df.insert(0, "row_id", np.arange(len(df), dtype=int))
    # Keep the original text so excluded rows can be traced back and inspected.
    df["raw_date"] = df["date"].astype(str)
    df["raw_amount"] = df["amount"].astype(str)
    warnings: list[str] = []

    if len(df) == 0:
        empty = _empty_clean_frame()
        report = _build_report(raw_len=0, clean=empty, excluded=_empty_excluded(), warnings=["empty_input"],
                               dataset_source=dataset_source)
        return PreprocessResult(empty, _empty_excluded(), report)

    reasons = pd.Series([None] * len(df), index=df.index, dtype=object)

    # Dates ----------------------------------------------------------------
    parsed_dates = []
    for i, v in df["date"].items():
        ts, err = parse_date_utc(v)
        parsed_dates.append(ts)
        if err and reasons[i] is None:
            reasons[i] = err
    df["date"] = pd.to_datetime(pd.Series(parsed_dates, index=df.index, dtype="object"))

    # Merchants -------------------------------------------------------------
    df["merchant"] = df["merchant"].map(_clean_text)
    reasons[(df["merchant"] == "") & reasons.isna()] = "missing_merchant"

    # Amounts ---------------------------------------------------------------
    amounts = []
    for i, v in df["amount"].items():
        amt, err = parse_amount(v)
        amounts.append(amt)
        if err and reasons[i] is None:
            reasons[i] = err
    df["amount"] = pd.Series(amounts, index=df.index, dtype="float64")

    # Currency --------------------------------------------------------------
    if "currency" in df.columns:
        cur = df["currency"].map(_clean_text).str.upper()
        if (cur == "").any():
            warnings.append(f"blank_currency_assumed_{config.BASE_CURRENCY}")
        cur = cur.replace("", config.BASE_CURRENCY)
        cur = cur.replace({"₹": "INR", "RS": "INR", "RS.": "INR"})
        df["currency"] = cur
        reasons[(cur != config.BASE_CURRENCY) & reasons.isna()] = "non_base_currency"
    else:
        df["currency"] = config.BASE_CURRENCY
        warnings.append(f"no_currency_column_assumed_{config.BASE_CURRENCY}")

    # Optional text columns ---------------------------------------------------
    df["account"] = df["account"].map(_clean_text).replace("", DEFAULT_ACCOUNT) if "account" in df else DEFAULT_ACCOUNT
    df["user_id"] = df["user_id"].map(_clean_text).replace("", DEFAULT_USER_ID) if "user_id" in df else DEFAULT_USER_ID
    df["reference"] = df["reference"].map(_clean_text) if "reference" in df else ""
    if "is_recurring" in df.columns:
        df["is_recurring"] = df["is_recurring"].map(
            lambda v: _clean_text(v).lower() in ("true", "1", "yes")
        )

    excluded = df[reasons.notna()].copy()
    excluded["exclusion_reason"] = reasons[reasons.notna()]
    clean = df[reasons.isna()].drop(columns=["raw_date", "raw_amount"]).copy()

    # Merchant normalisation & grouping -------------------------------------
    norm = clean["merchant"].map(normalize_merchant)
    clean["merchant_key"] = norm.map(lambda n: n.canonicalKey)
    clean["merchant_name"] = norm.map(lambda n: n.cleanName)
    clean["group_id"] = clean["user_id"] + "::" + clean["merchant_key"]
    clean["description_key"] = clean["merchant"].str.lower()

    # Duplicates ------------------------------------------------------------
    clean, verified_dups, conflicts = _handle_duplicates(clean)
    if len(verified_dups):
        excluded = pd.concat([excluded, verified_dups], ignore_index=False)
    if conflicts:
        warnings.append(f"reference_conflicts:{conflicts}")

    clean["dataset_source"] = dataset_source
    clean = clean.sort_values(["group_id", "date", "row_id"], kind="mergesort").reset_index(drop=True)
    excluded = excluded.sort_values("row_id", kind="mergesort").reset_index(drop=True)
    if "date" in excluded.columns:
        excluded["date"] = excluded["date"].astype("object")

    report = _build_report(len(raw), clean, excluded, warnings, dataset_source)
    return PreprocessResult(clean, excluded, report)


def _handle_duplicates(clean: pd.DataFrame):
    """Remove verified duplicates; flag possible ones. Returns (clean, removed, n_conflicts)."""
    content_cols = ["date", "description_key", "amount", "account"]
    clean = clean.copy()
    clean["possible_duplicate"] = False
    clean["reference_conflict"] = False

    has_ref = clean["reference"] != ""
    removed = clean.iloc[0:0].copy()
    conflicts = 0

    if has_ref.any():
        with_ref = clean[has_ref]
        # Same reference AND same content -> the same bank record imported twice.
        dup_mask = with_ref.duplicated(subset=["reference"] + content_cols, keep="first")
        removed = with_ref[dup_mask].copy()
        removed["exclusion_reason"] = "verified_duplicate_same_reference"
        clean = clean.drop(index=removed.index)

        # Same reference but DIFFERENT content -> conflict; keep both, flag.
        with_ref = clean[clean["reference"] != ""]
        ref_counts = with_ref.groupby("reference")["row_id"].transform("count")
        conflict_idx = ref_counts[ref_counts > 1].index
        clean.loc[conflict_idx, "reference_conflict"] = True
        conflicts = int(with_ref.loc[conflict_idx, "reference"].nunique())

    # Identical content. If both rows carry DIFFERENT references they are two
    # distinct bank records (e.g. a genuine double charge) -> flag, keep.
    # If neither has a reference we cannot tell -> flag, keep.
    dup_any = clean.duplicated(subset=["group_id"] + content_cols, keep=False)
    clean.loc[dup_any, "possible_duplicate"] = True

    return clean, removed, conflicts


def _empty_clean_frame() -> pd.DataFrame:
    cols = ["row_id", "date", "merchant", "amount", "account", "currency", "user_id", "reference",
            "merchant_key", "merchant_name", "group_id", "description_key", "possible_duplicate",
            "reference_conflict", "dataset_source"]
    df = pd.DataFrame({c: pd.Series(dtype="object") for c in cols})
    df["date"] = pd.Series(dtype="datetime64[ns]")
    df["amount"] = pd.Series(dtype="float64")
    return df


def _empty_excluded() -> pd.DataFrame:
    return pd.DataFrame({"row_id": pd.Series(dtype=int), "exclusion_reason": pd.Series(dtype=object)})


def _build_report(raw_len, clean, excluded, warnings, dataset_source) -> dict:
    by_reason = (
        excluded["exclusion_reason"].value_counts().sort_index().to_dict()
        if len(excluded) and "exclusion_reason" in excluded else {}
    )
    return {
        "dataset_source": dataset_source,
        "generated_at_utc": None,  # left None so reports are byte-reproducible
        "date_policy": "UTC calendar day (tz-naive timestamps represent UTC midnight)",
        "currency_policy": f"Only {config.BASE_CURRENCY} rows used; other currencies excluded",
        "n_input_rows": int(raw_len),
        "n_clean_rows": int(len(clean)),
        "n_excluded_rows": int(len(excluded)),
        "excluded_by_reason": {str(k): int(v) for k, v in by_reason.items()},
        "n_possible_duplicate_rows": int(clean["possible_duplicate"].sum()) if len(clean) else 0,
        "n_reference_conflict_rows": int(clean["reference_conflict"].sum()) if len(clean) else 0,
        "n_groups": int(clean["group_id"].nunique()) if len(clean) else 0,
        "n_users": int(clean["user_id"].nunique()) if len(clean) else 0,
        "date_min": clean["date"].min().strftime("%Y-%m-%d") if len(clean) else None,
        "date_max": clean["date"].max().strftime("%Y-%m-%d") if len(clean) else None,
        "warnings": sorted(set(warnings)),
    }
