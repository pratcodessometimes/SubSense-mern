import pandas as pd

from _helpers import REPO_ROOT, raises, skip
from subsense_ml.features import FEATURE_COLUMNS
from subsense_ml.labels import attach_labels
from subsense_ml.pipeline import build_dataset, build_synthetic
from subsense_ml.preprocessing import load_raw
from subsense_ml.synthetic import ARCHETYPE_LABEL, generate_synthetic_transactions
from subsense_ml.validation import check_group_disjoint

_CACHE = {}


def _synthetic():
    if "b" not in _CACHE:
        _CACHE["b"] = build_synthetic(seed=7, n_users=12)
    return _CACHE["b"]


def test_synthetic_generation_is_reproducible():
    a = generate_synthetic_transactions(seed=3, n_users=5)
    b = generate_synthetic_transactions(seed=3, n_users=5)
    c = generate_synthetic_transactions(seed=4, n_users=5)
    pd.testing.assert_frame_equal(a, b)
    assert not a.equals(c)


def test_synthetic_is_clearly_marked():
    raw = generate_synthetic_transactions(seed=3, n_users=3)
    assert (raw["label_source"] == "synthetic").all()
    assert raw["user_id"].str.startswith("synthetic_user_").all()


def test_synthetic_build_validates_and_covers_all_labels():
    b = _synthetic()
    v = b.report["validation"]
    assert v["ok"], v["errors"]
    assert any("synthetic" in w for w in v["warnings"])
    assert set(b.features["label"]) == {"subscription", "non_subscription", "ambiguous"}
    assert (b.features["label_source"] == "synthetic").all()
    # hard negatives (recurring but not subscriptions) are present
    assert {"utility_bill", "rent"} <= set(b.features["archetype"])
    # every archetype maps to its documented label
    pairs = b.features[["archetype", "label"]].drop_duplicates()
    assert all(ARCHETYPE_LABEL[a] == l for a, l in pairs.itertuples(index=False))


def test_injected_quality_issues_are_handled():
    rep = _synthetic().report["preprocessing"]
    reasons = rep["excluded_by_reason"]
    for r in ["invalid_date", "missing_merchant", "negative_amount_credit_or_refund", "zero_amount",
              "invalid_amount", "non_base_currency", "verified_duplicate_same_reference"]:
        assert reasons.get(r, 0) >= 1, r
    assert rep["n_possible_duplicate_rows"] >= 2
    assert rep["n_clean_rows"] + rep["n_excluded_rows"] == rep["n_input_rows"]


def test_end_to_end_build_is_reproducible():
    a = build_synthetic(seed=7, n_users=12).features
    pd.testing.assert_frame_equal(a, _synthetic().features)


def test_build_has_no_leakage_and_group_disjoint_split():
    f = _synthetic().features
    assert (pd.to_datetime(f["last_tx_date_used"]) <= pd.to_datetime(f["prediction_date"])).all()
    assert check_group_disjoint(f, f["split"]) == []
    assert not (set(FEATURE_COLUMNS) & {"label", "archetype", "isRecurring", "group_id"})


def test_sample_csv_from_repository_with_provisional_labels():
    path = REPO_ROOT / "sample-transactions.csv"
    if not path.exists():
        skip("sample-transactions.csv not found next to ml-service/")
    b = build_dataset(load_raw(path), "real")
    f = b.features.set_index("merchant_key")
    assert b.report["preprocessing"]["n_clean_rows"] == 15
    assert len(f) == 8
    assert set(f["label_source"]) == {"rule_provisional"}
    assert any("rule_provisional" in w for w in b.report["validation"]["warnings"])
    assert f.loc["netflix", "n_transactions"] == 3 and f.loc["netflix", "is_eligible"] == 1
    assert f.loc["adobe", "n_transactions"] == 2  # out-of-order rows in the CSV are sorted
    assert f.loc["starbucks", "is_eligible"] == 0


def test_attach_labels_rejects_unknown_values():
    feats = pd.DataFrame({"group_id": ["g1"]})
    with raises(ValueError):
        attach_labels(feats, pd.DataFrame({"group_id": ["g1"], "label": ["maybe"], "label_source": ["synthetic"]}))
