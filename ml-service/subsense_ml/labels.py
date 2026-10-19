"""
Label handling.

A label answers: "Is this merchant group, as a whole, a recurring
SUBSCRIPTION?" — not merely "is it recurring". Rent, utility bills and loan
EMIs are recurring but are labelled `non_subscription`.

Labels are attached at GROUP level and copied to every snapshot row of that
group. Every label carries a `label_source` so that, in Part 2, we can never
accidentally report performance measured against synthetic or rule-generated
labels as if it were real-world accuracy.
"""

from __future__ import annotations

import pandas as pd

from . import config


def labels_from_columns(clean_tx: pd.DataFrame, label_col: str = "label",
                        source_col: str = "label_source") -> pd.DataFrame:
    """Group-level labels from per-row label columns (used by synthetic data).

    Raises ValueError if one group carries more than one label — that would
    mean two different things were merged into one merchant group.
    """
    if label_col not in clean_tx.columns:
        raise ValueError(f"column '{label_col}' not present")
    agg = clean_tx.groupby("group_id").agg(
        n_labels=(label_col, "nunique"),
        label=(label_col, "first"),
        label_source=(source_col, "first") if source_col in clean_tx else (label_col, lambda s: "unlabeled"),
    )
    conflicting = agg[agg["n_labels"] > 1]
    if len(conflicting):
        raise ValueError(f"groups with conflicting labels: {list(conflicting.index)[:5]}")
    return agg[["label", "label_source"]].reset_index()


def labels_from_rule_flag(clean_tx: pd.DataFrame) -> pd.DataFrame:
    """PROVISIONAL labels from the CSV/DB `isRecurring` flag.

    WARNING — circularity: in the running app this flag is overwritten by the
    rule engine (detectionService.runSubscriptionDetection). Training on it
    teaches a model to imitate the rules, and evaluating on it can only measure
    agreement with the rules, never real accuracy. It is also "recurring", not
    "subscription". Use only for pipeline demos and rule-vs-ML agreement.
    """
    if "is_recurring" not in clean_tx.columns:
        return pd.DataFrame(columns=["group_id", "label", "label_source"])
    share = clean_tx.groupby("group_id")["is_recurring"].mean()

    def _map(v: float) -> str:
        if v == 1.0:
            return "subscription"
        if v == 0.0:
            return "non_subscription"
        return "ambiguous"

    out = share.map(_map).rename("label").reset_index()
    out["label_source"] = "rule_provisional"
    return out


def attach_labels(features: pd.DataFrame, labels: pd.DataFrame | None) -> pd.DataFrame:
    """Left-join group labels onto the feature table; missing -> 'unlabeled'."""
    out = features.copy()
    if labels is None or len(labels) == 0:
        out["label"] = pd.NA
        out["label_source"] = "unlabeled"
        return out
    bad_labels = set(labels["label"].dropna()) - set(config.LABELS)
    bad_sources = set(labels["label_source"].dropna()) - set(config.LABEL_SOURCES)
    if bad_labels or bad_sources:
        raise ValueError(f"unknown labels {bad_labels} or label sources {bad_sources}")
    out = out.merge(labels[["group_id", "label", "label_source"]], on="group_id", how="left")
    out["label_source"] = out["label_source"].fillna("unlabeled")
    return out
