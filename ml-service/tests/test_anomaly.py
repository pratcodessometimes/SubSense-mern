import numpy as np
import pandas as pd

from _helpers import monthly_dates, prep, tx
from subsense_ml.anomaly import (IsolationForest, deviation_features, inject_anomalies, run_anomaly_experiment)
from subsense_ml.pipeline import build_synthetic


def test_first_payments_are_not_scored():
    f = deviation_features(prep([tx(d) for d in monthly_dates(2026, 1, 5, 3)]).clean)
    assert len(f) == 0


def test_stable_history_raises_no_flags_and_small_changes_are_tolerated():
    amts = [499, 499, 499, 499, 504, 499]          # +1% is inside the 2% floor
    f = deviation_features(prep([tx(d, amount=a) for d, a in zip(monthly_dates(2026, 1, 5, 6), amts)]).clean)
    assert f["robust_flag"].sum() == 0


def test_amount_spike_is_flagged_with_reason():
    amts = [499] * 5 + [1499]
    f = deviation_features(prep([tx(d, amount=a) for d, a in zip(monthly_dates(2026, 1, 5, 6), amts)]).clean)
    last = f.iloc[-1]
    assert last["robust_flag"] == 1 and last["robust_reason"] == "amount_higher_than_usual"


def test_duplicate_and_late_payments_are_flagged():
    dup = [tx(d) for d in monthly_dates(2026, 1, 5, 5)] + [tx("2026-05-06")]
    f = deviation_features(prep(dup).clean)
    assert f.iloc[-1]["robust_reason"] == "paid_earlier_than_usual_or_duplicate"
    late = [tx(d) for d in monthly_dates(2026, 1, 5, 5)] + [tx("2026-06-25")]
    f = deviation_features(prep(late).clean)
    assert f.iloc[-1]["robust_reason"] == "paid_later_than_usual"


def test_scores_never_use_future_payments():
    base = [tx(d, amount=499 + (i % 2)) for i, d in enumerate(monthly_dates(2025, 1, 5, 8))]
    future = [tx("2025-09-05", amount=5000), tx("2025-09-06"), tx("2025-12-30")]
    a = deviation_features(prep(base).clean)
    b = deviation_features(prep(base + future).clean).iloc[: len(a)]
    cols = ["amount_z", "interval_z", "robust_score", "robust_flag"]
    pd.testing.assert_frame_equal(a[cols].reset_index(drop=True), b[cols].reset_index(drop=True))


def test_each_score_equals_score_computed_on_truncated_history():
    # Diverse amounts/intervals so that ANY look-ahead changes the reference median.
    days = ["2026-01-01", "2026-01-29", "2026-03-05", "2026-04-02", "2026-05-10", "2026-06-01", "2026-07-15"]
    amts = [100, 200, 300, 400, 10000, 50, 700]
    rows = [tx(d, amount=a) for d, a in zip(days, amts)]
    full = deviation_features(prep(rows).clean)
    cols = ["ref_median_amount", "ref_median_interval", "amount_z", "interval_z", "robust_score"]
    for k in range(len(full)):
        upto = 3 + k + 1                     # history up to and including the scored payment
        trunc = deviation_features(prep(rows[:upto]).clean).iloc[-1]
        assert np.allclose(full.iloc[k][cols].to_numpy(float), trunc[cols].to_numpy(float)), k


def test_isolation_forest_is_seeded_and_ranks_outliers_higher():
    rng = np.random.default_rng(0)
    X = np.vstack([rng.normal(0, 0.05, size=(300, 2)), [[1.5, 0.0], [0.0, -2.0]]])
    a = IsolationForest(n_estimators=50, random_state=1).fit(X).score_samples(X)
    b = IsolationForest(n_estimators=50, random_state=1).fit(X).score_samples(X)
    assert np.array_equal(a, b)
    assert a[-2:].min() > np.quantile(a[:-2], 0.99)


def test_injection_is_deterministic_and_labelled():
    build = build_synthetic(seed=7, n_users=12)
    subs = build.clean[build.clean["archetype"].str.startswith("monthly")]
    a, b = inject_anomalies(subs, seed=1), inject_anomalies(subs, seed=1)
    pd.testing.assert_frame_equal(a, b)
    kinds = set(a["anomaly_type"])
    assert {"amount_spike", "duplicate_charge"} <= kinds
    assert len(a) >= len(subs)


def test_anomaly_experiment_reports_both_methods():
    r = run_anomaly_experiment(build_synthetic(seed=7, n_users=12), seed=7, if_trees=30)["results"]
    for method in ["robust_deviation", "isolation_forest"]:
        t = r["test"][method]
        for k in ["precision", "recall", "f1", "average_precision", "roc_auc", "recall_by_type",
                  "natural_price_change_flagged"]:
            assert k in t
        assert t["n_positive"] > 0
    assert r["test"]["robust_deviation"]["roc_auc"] > 0.8
