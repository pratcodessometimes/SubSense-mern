"""
Dataset validation and leakage checks.

`validate_feature_table` returns errors (dataset must not be used) and
warnings (dataset usable, but read the caveat). It is run by the build script
and by the tests, and Part 2 should call it before any training.

`assign_group_split` is provided now so the dataset FORMAT already supports a
leakage-free split. It is deterministic (hash-based, no RNG state) and keeps
every snapshot of a group on the same side. No model training happens here.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import config
from .features import FEATURE_COLUMNS, INTERVAL_FEATURES, META_COLUMNS


@dataclass
class ValidationReport:
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    summary: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings, "summary": self.summary}


def check_feature_list(feature_columns=FEATURE_COLUMNS) -> list:
    """Return forbidden/label-encoding columns that slipped into the feature list."""
    forbidden = {c.lower() for c in config.FORBIDDEN_FEATURE_COLUMNS}
    return [c for c in feature_columns if c.lower() in forbidden]


def find_future_leakage(features: pd.DataFrame) -> pd.DataFrame:
    """Rows whose features used a transaction dated after the prediction date."""
    if len(features) == 0:
        return features
    last = pd.to_datetime(features["last_tx_date_used"])
    pred = pd.to_datetime(features["prediction_date"])
    return features[last > pred]


def validate_feature_table(features: pd.DataFrame) -> ValidationReport:
    rep = ValidationReport()

    missing = [c for c in META_COLUMNS + FEATURE_COLUMNS if c not in features.columns]
    if missing:
        rep.errors.append(f"missing columns: {missing}")
        return rep

    leaked = check_feature_list()
    if leaked:
        rep.errors.append(f"forbidden columns used as features: {leaked}")

    if len(features) == 0:
        rep.warnings.append("feature table is empty")
        rep.summary = {"n_rows": 0}
        return rep

    future = find_future_leakage(features)
    if len(future):
        rep.errors.append(f"{len(future)} rows use transactions after their prediction_date")

    dup = features.duplicated(subset=["group_id", "prediction_date"])
    if dup.any():
        rep.errors.append(f"{int(dup.sum())} duplicate (group_id, prediction_date) rows")

    eligible = features[features["is_eligible"] == 1]
    non_interval = [c for c in FEATURE_COLUMNS if c not in INTERVAL_FEATURES]
    numeric = features[FEATURE_COLUMNS].apply(pd.to_numeric, errors="coerce")
    if np.isinf(numeric.to_numpy(dtype=float)).any():
        rep.errors.append("infinite values in features")
    if numeric[non_interval].isna().any().any():
        cols = numeric[non_interval].columns[numeric[non_interval].isna().any()].tolist()
        rep.errors.append(f"unexpected missing values in always-defined features: {cols}")
    elig_na = numeric.loc[eligible.index, INTERVAL_FEATURES].isna().sum()
    elig_na = elig_na[elig_na > 0]
    if len(elig_na):
        # recency_ratio can be NaN if median interval is 0, which cannot happen
        # with distinct days; any NaN here indicates a bug.
        rep.errors.append(f"NaN interval features on eligible rows: {elig_na.to_dict()}")

    if "label" in features.columns:
        labels = features["label"].dropna()
        unknown = set(labels) - set(config.LABELS)
        if unknown:
            rep.errors.append(f"unknown label values: {sorted(unknown)}")
        sources = set(features["label_source"].dropna())
        if not sources <= set(config.LABEL_SOURCES):
            rep.errors.append(f"unknown label sources: {sorted(sources - set(config.LABEL_SOURCES))}")
        if "synthetic" in sources and len(sources - {"synthetic", "unlabeled"}):
            rep.errors.append("synthetic and non-synthetic labels are mixed in one table")
        if "rule_provisional" in sources:
            rep.warnings.append("labels are rule_provisional: circular with the rule engine; "
                                "do not report as accuracy")
        if "synthetic" in sources:
            rep.warnings.append("labels are synthetic: results do not represent real-world performance")
        # A group must have one label across all its snapshots.
        per_group = features.dropna(subset=["label"]).groupby("group_id")["label"].nunique()
        if (per_group > 1).any():
            rep.errors.append("a group has different labels across snapshots")

        counts = eligible["label"].value_counts(dropna=False)
        rep.summary["eligible_label_counts"] = {str(k): int(v) for k, v in counts.items()}
        if len(counts) and counts.min() / counts.sum() < 0.10:
            rep.warnings.append("class imbalance: smallest class < 10% of eligible rows")

    sources_ds = set(features["dataset_source"].dropna())
    if len(sources_ds) > 1:
        rep.warnings.append(f"multiple dataset sources in one table: {sorted(sources_ds)}")

    rep.summary.update({
        "n_rows": int(len(features)),
        "n_eligible_rows": int(len(eligible)),
        "n_groups": int(features["group_id"].nunique()),
        "n_prediction_dates": int(features["prediction_date"].nunique()),
        "rows_per_group_max": int(features.groupby("group_id").size().max()),
    })
    return rep


# ---------------------------------------------------------------------------
# Group-aware split helpers (for Part 2)
# ---------------------------------------------------------------------------
def _stable_unit_interval(key: str, salt: str) -> float:
    digest = hashlib.sha256(f"{salt}|{key}".encode("utf-8")).hexdigest()
    return int(digest[:12], 16) / float(16 ** 12)


def assign_group_split(features: pd.DataFrame, group_col: str = "group_id",
                       test_fraction: float = 0.25, salt: str = "subsense-phase3") -> pd.Series:
    """Return a 'train'/'test' Series; all rows of a group get the same value.

    Hashing (not random.shuffle) makes the split identical on every machine
    and every run, and stable when new groups are added.
    """
    if not 0 < test_fraction < 1:
        raise ValueError("test_fraction must be between 0 and 1")
    mapping = {g: ("test" if _stable_unit_interval(str(g), salt) < test_fraction else "train")
               for g in features[group_col].unique()}
    return features[group_col].map(mapping).rename("split")


def assign_group_folds(features: pd.DataFrame, n_folds: int = 5, group_col: str = "group_id",
                       salt: str = "subsense-phase3-cv") -> pd.Series:
    """Deterministic GroupKFold-style fold id (0..n_folds-1) per row; a group never spans folds."""
    if n_folds < 2:
        raise ValueError("n_folds must be >= 2")
    mapping = {g: min(n_folds - 1, int(_stable_unit_interval(str(g), salt) * n_folds))
               for g in features[group_col].unique()}
    return features[group_col].map(mapping).rename("fold")


def check_group_disjoint(features: pd.DataFrame, split: pd.Series, group_col: str = "group_id") -> list:
    """Groups that appear in more than one split (should be empty)."""
    per_group = pd.DataFrame({"g": features[group_col], "s": split}).groupby("g")["s"].nunique()
    return per_group[per_group > 1].index.tolist()
