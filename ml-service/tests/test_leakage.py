import pandas as pd

from _helpers import monthly_dates, prep, tx
from subsense_ml.features import FEATURE_COLUMNS, build_feature_table, compute_group_features
from subsense_ml.validation import (assign_group_split, check_feature_list, check_group_disjoint,
                                    find_future_leakage, validate_feature_table)


def _strip(f):
    f = dict(f)
    f.pop("_meta")
    return f


def test_future_transactions_do_not_change_past_features():
    past = [tx(d) for d in monthly_dates(2026, 1, 14, 4)]          # Jan..Apr
    future = [tx("2026-05-14", amount=999), tx("2026-05-15", amount=999),
              tx("2026-06-14", amount=1), tx("2027-01-01")]
    pred = "2026-04-30"
    a = compute_group_features(prep(past).clean, pred)
    b = compute_group_features(prep(past + future).clean, pred)
    assert _strip(a) == _strip(b)
    assert a["_meta"] == b["_meta"]


def test_feature_table_with_future_data_is_identical_at_same_prediction_date():
    past = [tx(d) for d in monthly_dates(2025, 6, 1, 6)]
    future = [tx(d, amount=799) for d in monthly_dates(2025, 12, 1, 6)]
    a = build_feature_table(prep(past).clean, ["2025-11-15"])
    b = build_feature_table(prep(past + future).clean, ["2025-11-15"])
    pd.testing.assert_frame_equal(a, b)


def test_prediction_date_is_inclusive_and_earlier_dates_give_no_row():
    clean = prep([tx("2026-06-14"), tx("2026-07-14")]).clean
    assert compute_group_features(clean, "2026-06-13") is None
    assert compute_group_features(clean, "2026-06-14")["n_transactions"] == 1
    assert compute_group_features(clean, "2026-07-14")["n_transactions"] == 2


def test_rule_flag_never_influences_features():
    rows = [tx(d) for d in monthly_dates(2026, 1, 14, 4)]
    with_true = [dict(r, isRecurring="true", subscriptionId="netflix", category="Streaming") for r in rows]
    with_false = [dict(r, isRecurring="false", subscriptionId="", category="Food") for r in rows]
    a = build_feature_table(prep(with_true).clean)
    b = build_feature_table(prep(with_false).clean)
    pd.testing.assert_frame_equal(a[FEATURE_COLUMNS], b[FEATURE_COLUMNS])


def test_forbidden_columns_are_not_features():
    assert check_feature_list() == []
    assert check_feature_list(FEATURE_COLUMNS + ["isRecurring", "confidence", "label"]) == \
        ["isRecurring", "confidence", "label"]


def test_validator_detects_tampered_future_leakage():
    t = build_feature_table(prep([tx(d) for d in monthly_dates(2026, 1, 14, 3)]).clean)
    assert len(find_future_leakage(t)) == 0
    t.loc[0, "last_tx_date_used"] = pd.Timestamp("2030-01-01")
    assert len(find_future_leakage(t)) == 1
    assert any("after their prediction_date" in e for e in validate_feature_table(t).errors)


def test_group_split_keeps_all_snapshots_of_a_group_together_and_is_deterministic():
    rows = []
    for k in range(30):
        rows += [tx(d, f"MERCHANT{k} SHOP", 100 + k) for d in monthly_dates(2025, 1, 5, 12)]
    t = build_feature_table(prep(rows).clean, ["2025-04-30", "2025-08-31", "2025-12-31"])
    s1 = assign_group_split(t)
    s2 = assign_group_split(t.sample(frac=1.0, random_state=0)).sort_index()
    assert check_group_disjoint(t, s1) == []
    assert s1.equals(s2)
    assert set(s1) == {"train", "test"}


def test_group_overlap_is_detected():
    t = pd.DataFrame({"group_id": ["g1", "g1", "g2"]})
    assert check_group_disjoint(t, pd.Series(["train", "test", "test"])) == ["g1"]
