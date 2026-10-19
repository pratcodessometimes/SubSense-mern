import json
import shutil

import pandas as pd

from _helpers import monthly_dates, prep, raises, skip, tx
from subsense_ml.classification import FittedModel, eligible_rows, model_specs, run_classification_experiment
from subsense_ml.features import build_feature_table
from subsense_ml.pipeline import build_synthetic
from subsense_ml.rule_baseline import build_rule_inputs, run_rule_baseline
from subsense_ml.validation import check_group_disjoint

_CACHE = {}


def _exp(with_rules=True):
    key = ("exp", with_rules)
    if key not in _CACHE:
        if "build" not in _CACHE:
            _CACHE["build"] = build_synthetic(seed=7, n_users=12)
        _CACHE[key] = run_classification_experiment(_CACHE["build"], seed=7, fast=True,
                                                    with_rules=with_rules, n_boot=50)
    return _CACHE[key]


def test_experiment_keeps_groups_apart_and_uses_same_test_rows():
    e = _exp(with_rules=False)
    assert check_group_disjoint(pd.concat([e["train"], e["test"]]),
                                pd.concat([e["train"]["split"], e["test"]["split"]])) == []
    assert not set(e["train"]["group_id"]) & set(e["test"]["group_id"])
    ns = {m["test"]["n"] for m in e["results"]["models"].values()}
    assert ns == {len(e["test"])}
    # 5 folds never share a group
    per_group = e["train"].groupby("group_id")["fold"].nunique()
    assert (per_group == 1).all()


def test_learned_models_beat_majority_baseline():
    m = _exp(with_rules=False)["results"]["models"]
    base = m["majority_class__all_features"]["test"]["macro_f1"]
    for name in ["logistic_regression__all_features", "decision_tree__all_features",
                 "random_forest__all_features"]:
        assert m[name]["test"]["macro_f1"] > base + 0.3, name


def test_reports_contain_required_metrics_and_synthetic_flag():
    r = _exp(with_rules=False)["results"]
    assert r["protocol"]["real_world_claim_allowed"] is False
    t = r["models"]["random_forest__all_features"]["test"]
    for k in ["per_class", "macro_f1", "confusion_matrix", "macro_f1_95ci_group_bootstrap",
              "binary_subscription_vs_rest", "accuracy"]:
        assert k in t
    assert set(t["per_class"]) == {"subscription", "non_subscription", "ambiguous"}


def test_experiment_is_reproducible():
    b = build_synthetic(seed=7, n_users=12)
    r2 = run_classification_experiment(b, seed=7, fast=True, with_rules=False, n_boot=50)["results"]
    assert json.dumps(r2, sort_keys=True, default=str) == \
        json.dumps(_exp(with_rules=False)["results"], sort_keys=True, default=str)


def test_preprocessing_is_fitted_on_training_rows_only():
    e = _exp(with_rules=False)
    spec = [s for s in model_specs(fast=True) if s.name == "logistic_regression"][0]
    cols = ["interval_median", "amount_cv"]
    m1 = FittedModel(spec, cols).fit(e["train"])
    m2 = FittedModel(spec, cols).fit(e["train"])
    poisoned = e["test"].copy()
    poisoned[cols] = 1e9
    m2.predict(poisoned)                      # predicting must not refit anything
    assert (m1.scaler.mean_ == m2.scaler.mean_).all()
    assert (m1.imputer.medians_ == m2.imputer.medians_).all()


def test_unlabeled_rows_are_refused():
    f = pd.DataFrame({"is_eligible": [1], "label": [None]})
    with raises(ValueError, match="without labels"):
        eligible_rows(f)


def test_rule_inputs_only_contain_visible_transactions():
    clean = prep([tx(d) for d in monthly_dates(2026, 1, 14, 6)]).clean
    snaps = build_feature_table(clean, ["2026-03-31"])
    inp = build_rule_inputs(clean, snaps)
    assert len(inp) == 1 and [t["date"] for t in inp[0]["txs"]] == ["2026-01-14", "2026-02-14", "2026-03-14"]
    assert inp[0]["referenceDate"] == "2026-03-31"


def test_real_rule_engine_bridge():
    if shutil.which("node") is None:
        skip("node not installed")
    rows = [tx(d) for d in monthly_dates(2026, 1, 14, 5)]
    rows += [tx(d, "SWIGGY", a) for d, a in [("2026-01-02", 300), ("2026-01-09", 820), ("2026-03-30", 150)]]
    clean = prep(rows).clean
    snaps = build_feature_table(clean, ["2026-05-20"])
    out = run_rule_baseline(clean, snaps).set_index("key")
    assert out.loc["default_user::netflix|2026-05-20", "rule_pred"] == "subscription"
    assert out.loc["default_user::netflix|2026-05-20", "rule_interval"] == "monthly"
    assert out.loc["default_user::swiggy|2026-05-20", "rule_pred"] == "non_subscription"


def test_rule_baseline_in_experiment_never_predicts_ambiguous():
    if shutil.which("node") is None:
        skip("node not installed")
    e = _exp(with_rules=True)
    assert "rule_baseline" in e["results"]["models"]
    assert "ambiguous" not in set(e["predictions"]["rule_baseline"])
    assert "rule_baseline_on_its_own_task" in e["results"]
