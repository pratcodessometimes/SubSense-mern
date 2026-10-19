import math

import pandas as pd

from _helpers import monthly_dates, prep, tx
from subsense_ml.features import (FEATURE_COLUMNS, INTERVAL_FEATURES, build_feature_table,
                                  compute_group_features)


def feats(rows, prediction_date):
    clean = prep(rows).clean
    out = compute_group_features(clean, prediction_date)
    return out


def test_empty_input_gives_empty_table_with_schema():
    t = build_feature_table(prep([tx("bad")]).clean)
    assert len(t) == 0
    assert set(FEATURE_COLUMNS) <= set(t.columns)


def test_single_transaction_group():
    f = feats([tx("2026-06-14")], "2026-07-01")
    assert f["n_transactions"] == 1 and f["n_intervals"] == 0
    assert f["has_min_history"] == 0 and f["_meta"]["is_eligible"] == 0
    for c in INTERVAL_FEATURES:
        assert math.isnan(f[c]), c
    assert f["amount_std"] == 0.0 and f["days_since_last"] == 17
    assert "single_transaction" in f["_meta"]["data_quality_warnings"]


def test_insufficient_history_two_payments():
    f = feats([tx("2026-06-14"), tx("2026-07-14")], "2026-07-20")
    assert f["_meta"]["is_eligible"] == 1
    assert f["has_min_history"] == 1 and f["has_sufficient_history"] == 0
    assert f["n_intervals"] == 1 and f["interval_std"] == 0.0
    assert "insufficient_history" in f["_meta"]["data_quality_warnings"]


def test_monthly_pattern():
    rows = [tx(d) for d in monthly_dates(2025, 9, 14, 8)]
    f = feats(rows, "2026-04-20")
    assert f["monthly_interval_share"] == 1.0 and f["yearly_interval_share"] == 0.0
    assert f["monthly_period_deviation"] < 0.03
    assert f["interval_cv"] < 0.05 and f["is_irregular"] == 0
    assert f["n_distinct_months"] == 8 and f["gap_count"] == 0
    assert f["has_sufficient_history"] == 1


def test_month_end_billing_still_monthly():
    rows = [tx(d) for d in ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]]
    f = feats(rows, "2026-05-01")
    assert f["interval_min"] == 28 and f["interval_max"] == 31
    assert f["monthly_interval_share"] == 1.0


def test_yearly_pattern():
    rows = [tx(d, "AMAZON PRIME", 1499) for d in ["2023-03-10", "2024-03-11", "2025-03-10"]]
    f = feats(rows, "2025-06-01")
    assert f["yearly_interval_share"] == 1.0 and f["monthly_interval_share"] == 0.0
    assert f["yearly_period_deviation"] < 0.01
    assert f["n_distinct_years"] == 3


def test_irregular_intervals():
    days = ["2026-01-01", "2026-01-04", "2026-02-13", "2026-02-24", "2026-05-25", "2026-05-30"]
    f = feats([tx(d, "SWIGGY", 300 + i * 37) for i, d in enumerate(days)], "2026-06-01")
    assert f["is_irregular"] == 1 and f["interval_cv"] > 0.25
    assert f["monthly_interval_share"] < 0.5
    assert f["gap_count"] >= 1
    assert "irregular_intervals" in f["_meta"]["data_quality_warnings"]


def test_stable_versus_varying_amounts():
    stable = feats([tx(d, amount=499) for d in monthly_dates(2026, 1, 5, 5)], "2026-06-01")
    assert stable["amount_cv"] == 0.0 and stable["stable_amount_share"] == 1.0
    assert stable["n_distinct_amounts"] == 1 and stable["amount_range_ratio"] == 0.0

    amts = [1800, 2300, 1500, 2100, 1650]
    varying = feats([tx(d, "TATA POWER", a) for d, a in zip(monthly_dates(2026, 1, 5, 5), amts)], "2026-06-01")
    assert varying["amount_cv"] > 0.1 and varying["stable_amount_share"] < 0.5
    assert varying["amount_min"] == 1500 and varying["amount_max"] == 2300
    assert varying["amount_median"] == 1800


def test_price_increase_signal():
    amts = [499, 499, 499, 649, 649]
    f = feats([tx(d, amount=a) for d, a in zip(monthly_dates(2026, 1, 14, 5), amts)], "2026-06-01")
    assert f["latest_to_median_amount_ratio"] > 1.2


def test_same_day_repeats_and_possible_duplicates_counted():
    rows = [tx("2026-06-14"), tx("2026-06-14"), tx("2026-07-14")]
    f = feats(rows, "2026-07-20")
    assert f["n_transactions"] == 3 and f["n_distinct_dates"] == 2
    assert f["n_same_day_repeats"] == 1 and f["n_possible_duplicates"] == 2
    assert f["interval_median"] == 30  # repeats collapsed for interval calculation


def test_recency_and_overdue():
    rows = [tx(d) for d in monthly_dates(2026, 1, 1, 3)]  # last payment 2026-03-01
    f = feats(rows, "2026-05-01")
    assert f["days_since_last"] == 61
    assert f["recency_ratio"] > 2
    assert "stale_group" in f["_meta"]["data_quality_warnings"]


def test_account_and_description_consistency():
    rows = [tx("2026-01-14", "POS NETFLIX.COM 1111", account="A"),
            tx("2026-02-14", "POS NETFLIX.COM 2222", account="A"),
            tx("2026-03-14", "POS NETFLIX.COM 2222", account="B")]
    f = feats(rows, "2026-03-20")
    assert f["n_distinct_accounts"] == 2 and abs(f["dominant_account_share"] - 2 / 3) < 1e-9
    assert f["n_distinct_descriptions"] == 2


def test_build_table_one_row_per_group_and_date():
    rows = [tx(d) for d in monthly_dates(2026, 1, 14, 4)] + [tx("2026-03-02", "UBER TRIP", 210)]
    t = build_feature_table(prep(rows).clean, ["2026-02-01", "2026-05-01"])
    keys = list(zip(t["group_id"], t["prediction_date"].dt.strftime("%Y-%m-%d")))
    # Uber has no transactions before 2026-02-01 -> no row for that date.
    assert keys == [("default_user::netflix", "2026-02-01"), ("default_user::netflix", "2026-05-01"),
                    ("default_user::uber", "2026-05-01")]
    assert t.loc[0, "n_transactions"] == 1 and t.loc[1, "n_transactions"] == 4


def test_feature_extraction_is_reproducible():
    rows = [tx(d, amount=499 + i) for i, d in enumerate(monthly_dates(2025, 1, 3, 14))]
    a = build_feature_table(prep(rows).clean, ["2025-06-30", "2026-03-01"])
    b = build_feature_table(prep(list(reversed(rows))).clean, ["2026-03-01", "2025-06-30"])
    pd.testing.assert_frame_equal(a, b)
