"""End-to-end dataset build: raw -> preprocess -> features -> labels -> validate."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

from . import config
from .features import FEATURE_COLUMNS, META_COLUMNS, build_feature_table, FEATURE_DESCRIPTIONS
from .labels import attach_labels, labels_from_columns, labels_from_rule_flag
from .preprocessing import preprocess_transactions
from .synthetic import generate_synthetic_transactions
from .validation import assign_group_split, validate_feature_table

SYNTHETIC_PREDICTION_DATES = ["2024-12-31", "2025-06-30", "2025-12-31", "2026-08-31"]


@dataclass
class DatasetBuild:
    raw: pd.DataFrame
    clean: pd.DataFrame
    excluded: pd.DataFrame
    features: pd.DataFrame
    report: dict


def build_dataset(raw: pd.DataFrame, dataset_source: str,
                  prediction_dates: Optional[Iterable] = None) -> DatasetBuild:
    pre = preprocess_transactions(raw, dataset_source=dataset_source)
    feats = build_feature_table(pre.clean, prediction_dates)

    if "label" in pre.clean.columns:
        labels = labels_from_columns(pre.clean)
    elif "is_recurring" in pre.clean.columns:
        labels = labels_from_rule_flag(pre.clean)
    else:
        labels = None
    feats = attach_labels(feats, labels)

    if "archetype" in pre.clean.columns:
        arche = pre.clean.groupby("group_id")["archetype"].first().rename("archetype").reset_index()
        feats = feats.merge(arche, on="group_id", how="left")

    feats["split"] = assign_group_split(feats) if len(feats) else pd.Series(dtype=object)

    val = validate_feature_table(feats)
    report = {
        "preprocessing": pre.report,
        "validation": val.to_dict(),
        "n_feature_columns": len(FEATURE_COLUMNS),
        "feature_columns": FEATURE_COLUMNS,
        "prediction_dates": sorted({pd.Timestamp(d).strftime("%Y-%m-%d") for d in feats["prediction_date"]})
        if len(feats) else [],
    }
    if "archetype" in feats.columns and len(feats):
        el = feats[feats["is_eligible"] == 1]
        report["eligible_rows_by_archetype"] = {k: int(v) for k, v in el["archetype"].value_counts().sort_index().items()}
        report["groups_by_label"] = {k: int(v) for k, v in
                                     feats.groupby("group_id")["label"].first().value_counts().sort_index().items()}
    if len(feats):
        report["split_rows"] = {k: int(v) for k, v in feats["split"].value_counts().sort_index().items()}
        report["split_groups"] = {k: int(v) for k, v in
                                  feats.groupby("group_id")["split"].first().value_counts().sort_index().items()}
    return DatasetBuild(raw, pre.clean, pre.excluded, feats, report)


def build_synthetic(seed: int = 42, n_users: int = 40) -> DatasetBuild:
    raw = generate_synthetic_transactions(seed=seed, n_users=n_users)
    return build_dataset(raw, "synthetic", SYNTHETIC_PREDICTION_DATES)


def _format_for_csv(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for c in out.columns:
        if pd.api.types.is_datetime64_any_dtype(out[c]):
            out[c] = out[c].dt.strftime("%Y-%m-%d")
        elif pd.api.types.is_float_dtype(out[c]):
            out[c] = out[c].round(6)
    return out


def write_outputs(build: DatasetBuild, out_dir: Path, write_raw: bool = True) -> list:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    if write_raw:
        p = out_dir / "raw_transactions.csv"
        build.raw.to_csv(p, index=False, lineterminator="\n")
        written.append(p)
    p = out_dir / "excluded_rows.csv"
    _format_for_csv(build.excluded).to_csv(p, index=False, lineterminator="\n")
    written.append(p)
    p = out_dir / "features.csv"
    _format_for_csv(build.features).to_csv(p, index=False, lineterminator="\n")
    written.append(p)
    p = out_dir / "dataset_report.json"
    p.write_text(json.dumps(build.report, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    written.append(p)
    p = out_dir / "feature_dictionary.csv"
    pd.DataFrame({"feature": list(FEATURE_DESCRIPTIONS), "description": list(FEATURE_DESCRIPTIONS.values())}) \
        .to_csv(p, index=False, lineterminator="\n")
    written.append(p)
    return written
