"""
Phase 3.2 — subscription classification experiment.

Protocol (all deterministic):
  1. Rows: eligible snapshots only (>= 2 distinct payment days). Ineligible
     rows have no intervals and the rule engine also rejects them.
  2. Split: the Phase 3.1 hash-based GROUP split (`split` column). Every
     snapshot of a merchant group is on one side only.
  3. Model selection evidence: 5-fold GROUP cross-validation inside the
     training split (assign_group_folds). The test split is touched once.
  4. Preprocessing (median imputation, standardisation) is fitted on the
     training rows of each fit only.
  5. Class imbalance: "balanced" sample weights for every learned model.
  6. The rule baseline is evaluated on exactly the same test rows.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from . import config
from .features import FEATURE_COLUMNS
from .metrics import binary_report, classification_report, group_bootstrap_ci, macro_f1
from .models import (DecisionTreeClassifier, LogisticRegression, MajorityClassifier, MedianImputer,
                     RandomForestClassifier, StandardScaler, balanced_sample_weights)
from .rule_baseline import RuleBaselineUnavailable, run_rule_baseline, snapshot_key
from .validation import assign_group_folds, check_group_disjoint

LABEL_ORDER = list(config.LABELS)              # ["subscription", "non_subscription", "ambiguous"]
POSITIVE = "subscription"
TRUSTED_FOR_REAL_CLAIMS = {"verified", "user_confirmed"}
RECURRING_ARCHETYPES = {"monthly_stable", "monthly_price_increase", "monthly_cancelled", "yearly",
                        "utility_bill", "rent", "emi_installment"}

# Absolute price-level features. Removing them tests whether a model separates
# subscriptions from rent/EMIs only by "how big is the amount".
AMOUNT_LEVEL_FEATURES = ["amount_mean", "amount_median", "amount_std", "amount_min", "amount_max"]
FEATURE_SETS = {
    "all_features": list(FEATURE_COLUMNS),
    "no_amount_level": [c for c in FEATURE_COLUMNS if c not in AMOUNT_LEVEL_FEATURES],
}


@dataclass
class ModelSpec:
    name: str
    factory: Callable[[int], object]
    scale: bool
    weighted: bool = True


def model_specs(seed: int = 42, fast: bool = False) -> list:
    k = len(LABEL_ORDER)
    n_trees = 15 if fast else 100
    return [
        ModelSpec("majority_class", lambda: MajorityClassifier(k), scale=False, weighted=False),
        ModelSpec("logistic_regression", lambda: LogisticRegression(k, l2=1e-2), scale=True),
        ModelSpec("decision_tree", lambda: DecisionTreeClassifier(k, max_depth=5, min_samples_leaf=5),
                  scale=False),
        ModelSpec("random_forest", lambda: RandomForestClassifier(k, n_estimators=n_trees, max_depth=10,
                                                                  min_samples_leaf=2, random_state=seed),
                  scale=False),
    ]


class FittedModel:
    """Imputer (+ scaler) + model, fitted on training rows only."""

    def __init__(self, spec: ModelSpec, columns: list):
        self.spec, self.columns = spec, columns

    def fit(self, df: pd.DataFrame):
        X = df[self.columns].to_numpy(dtype=float)
        y = encode(df["label"])
        self.imputer = MedianImputer().fit(X)
        X = self.imputer.transform(X)
        self.scaler = StandardScaler().fit(X) if self.spec.scale else None
        if self.scaler is not None:
            X = self.scaler.transform(X)
        w = balanced_sample_weights(y, len(LABEL_ORDER)) if self.spec.weighted else None
        self.model = self.spec.factory().fit(X, y, w)
        return self

    def _X(self, df):
        X = self.imputer.transform(df[self.columns].to_numpy(dtype=float))
        return self.scaler.transform(X) if self.scaler is not None else X

    def predict_proba(self, df):
        return self.model.predict_proba(self._X(df))

    def predict(self, df) -> np.ndarray:
        return decode(self.model.predict(self._X(df)))


def encode(labels: pd.Series) -> np.ndarray:
    idx = {l: i for i, l in enumerate(LABEL_ORDER)}
    return labels.map(idx).to_numpy(dtype=int)


def decode(ids: np.ndarray) -> np.ndarray:
    return np.array(LABEL_ORDER, dtype=object)[ids]


def eligible_rows(features: pd.DataFrame) -> pd.DataFrame:
    df = features[features["is_eligible"] == 1].copy()
    if df["label"].isna().any():
        raise ValueError("eligible rows without labels: cannot train/evaluate a classifier")
    unknown = set(df["label"]) - set(LABEL_ORDER)
    if unknown:
        raise ValueError(f"unknown labels {unknown}")
    return df.reset_index(drop=True)


def _evaluate(y_true, y_pred, groups, n_boot, seed) -> dict:
    rep = classification_report(y_true, y_pred, LABEL_ORDER)
    rep["macro_f1_95ci_group_bootstrap"] = group_bootstrap_ci(
        y_true, y_pred, groups, lambda a, b: macro_f1(a, b, LABEL_ORDER), n_boot=n_boot, seed=seed)
    rep["binary_subscription_vs_rest"] = binary_report(np.asarray(y_true) == POSITIVE,
                                                       np.asarray(y_pred) == POSITIVE)
    return rep


def run_classification_experiment(build, seed: int = 42, n_folds: int = 5, fast: bool = False,
                                  with_rules: bool = True, n_boot: int = 1000) -> dict:
    data = eligible_rows(build.features)
    sources = sorted(set(data["label_source"]))
    train = data[data["split"] == "train"].reset_index(drop=True)
    test = data[data["split"] == "test"].reset_index(drop=True)
    overlap = check_group_disjoint(data, data["split"])
    if overlap:
        raise AssertionError(f"group leakage across splits: {overlap[:5]}")
    train["fold"] = assign_group_folds(train, n_folds).to_numpy()

    predictions = test[["group_id", "prediction_date", "label"]].copy()
    if "archetype" in test.columns:
        predictions["archetype"] = test["archetype"]

    results = {
        "protocol": {
            "label_sources": sources,
            "real_world_claim_allowed": bool(set(sources) <= TRUSTED_FOR_REAL_CLAIMS),
            "n_eligible_rows": int(len(data)),
            "n_train_rows": int(len(train)), "n_test_rows": int(len(test)),
            "n_train_groups": int(train["group_id"].nunique()), "n_test_groups": int(test["group_id"].nunique()),
            "train_label_counts": {k: int(v) for k, v in train["label"].value_counts().sort_index().items()},
            "test_label_counts": {k: int(v) for k, v in test["label"].value_counts().sort_index().items()},
            "n_folds": n_folds, "seed": seed, "class_weighting": "balanced", "fast_mode": fast,
            "group_overlap_between_splits": overlap,
        },
        "models": {},
    }
    fitted = {}

    for fs_name, cols in FEATURE_SETS.items():
        for spec in model_specs(seed, fast):
            cv = []
            for f in range(n_folds):
                tr, va = train[train["fold"] != f], train[train["fold"] == f]
                if va.empty or tr["label"].nunique() < 2:
                    continue
                m = FittedModel(spec, cols).fit(tr)
                cv.append(macro_f1(va["label"], m.predict(va), LABEL_ORDER))
            model = FittedModel(spec, cols).fit(train)
            pred = model.predict(test)
            name = f"{spec.name}__{fs_name}"
            predictions[name] = pred
            results["models"][name] = {
                "model": spec.name, "feature_set": fs_name, "n_features": len(cols),
                "cv_macro_f1_mean": round(float(np.mean(cv)), 4), "cv_macro_f1_std": round(float(np.std(cv)), 4),
                "cv_macro_f1_folds": [round(float(c), 4) for c in cv],
                "test": _evaluate(test["label"], pred, test["group_id"], n_boot, seed),
            }
            fitted[name] = model

    if with_rules:
        try:
            rules = run_rule_baseline(build.clean, test)
            keyed = rules.set_index("key")
            keys = [snapshot_key(g, d) for g, d in zip(test["group_id"], test["prediction_date"])]
            rp = keyed.loc[keys, "rule_pred"].to_numpy()
            predictions["rule_baseline"] = rp
            predictions["rule_interval"] = keyed.loc[keys, "rule_interval"].to_numpy()
            predictions["rule_confidence"] = keyed.loc[keys, "rule_confidence"].to_numpy()
            results["models"]["rule_baseline"] = {
                "model": "rule_baseline (backend analyzeMerchantRecurrence, unmodified)",
                "feature_set": "n/a (hand-written rules)", "n_features": None,
                "cv_macro_f1_mean": None, "cv_macro_f1_std": None, "cv_macro_f1_folds": [],
                "note": "Rules output recurring/not-recurring only; they can never predict 'ambiguous'.",
                "test": _evaluate(test["label"], rp, test["group_id"], n_boot, seed),
            }
            # Fairness check: the rules were built to find RECURRING payments, not
            # subscriptions. Score them on their own task too (archetype ground truth).
            if "archetype" in test.columns:
                truth = test["archetype"].isin(RECURRING_ARCHETYPES).to_numpy()
                results["rule_baseline_on_its_own_task"] = {
                    "task": "recurring (subscriptions + rent + utilities + EMIs) vs not recurring",
                    "recurring_archetypes": sorted(RECURRING_ARCHETYPES),
                    **binary_report(truth, rp == POSITIVE),
                }
        except RuleBaselineUnavailable as e:
            results["rule_baseline_unavailable"] = str(e)

    # Per-archetype "predicted subscription" rate on the test split (diagnostic).
    if "archetype" in predictions.columns:
        model_cols = [c for c in predictions.columns if "__" in c or c == "rule_baseline"]
        rates = {}
        for arche, g in predictions.groupby("archetype"):
            rates[arche] = {"n": int(len(g)), "true_label": g["label"].iloc[0],
                            **{c: round(float((g[c] == POSITIVE).mean()), 3) for c in model_cols}}
        results["predicted_subscription_rate_by_archetype"] = rates

    return {"results": results, "predictions": predictions, "fitted": fitted, "train": train, "test": test}


def explain_models(fitted: dict) -> dict:
    """Interpretability outputs for the 'all_features' models."""
    out = {}
    lr = fitted.get("logistic_regression__all_features")
    if lr is not None:
        coef = pd.DataFrame(lr.model.coef_, index=lr.columns, columns=LABEL_ORDER)
        out["logistic_coefficients"] = coef.round(4)
    dt = fitted.get("decision_tree__all_features")
    if dt is not None:
        out["decision_tree_text"] = dt.model.export_text(dt.columns, LABEL_ORDER)
        out["decision_tree_depth"] = dt.model.depth_
    rows = []
    for name, m in fitted.items():
        if hasattr(m.model, "feature_importances_"):
            for c, v in zip(m.columns, m.model.feature_importances_):
                rows.append({"model": name, "feature": c, "importance": round(float(v), 5)})
    if rows:
        out["feature_importance"] = (pd.DataFrame(rows)
                                     .sort_values(["model", "importance", "feature"], ascending=[True, False, True])
                                     .reset_index(drop=True))
    return out
