"""
Export shared Python -> Node parity fixtures for the robust payment-anomaly detector.

    python scripts/export_anomaly_parity_fixture.py            # writes ../backend/tests/fixtures/anomaly_parity.json
    python scripts/export_anomaly_parity_fixture.py --check    # exit 1 if the committed fixture is stale

Python (subsense_ml.anomaly.score_sequence) is the reference implementation;
backend/tests/paymentAnomaly.test.js asserts the Node port reproduces every number.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402

from subsense_ml import anomaly  # noqa: E402
from subsense_ml.pipeline import build_synthetic  # noqa: E402

DEFAULT_OUT = ROOT.parent / "backend" / "tests" / "fixtures" / "anomaly_parity.json"


def _monthly(start: str, n: int, amount: float = 499.0, jitter=None):
    d0 = pd.Timestamp(start)
    out = []
    for k in range(n):
        d = d0 + pd.DateOffset(months=k)
        if jitter:
            d = d + pd.Timedelta(days=jitter[k % len(jitter)])
        out.append((d.strftime("%Y-%m-%d"), amount))
    return out


def hand_cases() -> list:
    m = _monthly
    cases = {
        "too_short_3_payments": m("2026-01-05", 3),
        "exactly_min_history_plus_one": m("2026-01-05", 4),
        "constant_history_zero_mad": m("2025-01-05", 8),
        "constant_history_tiny_increase_1pct": m("2025-01-05", 6) + [("2025-07-05", 504.0)],
        "amount_spike": m("2025-01-05", 6) + [("2025-07-05", 1499.0)],
        "amount_drop": m("2025-01-05", 6) + [("2025-07-05", 99.0)],
        "same_day_duplicate": m("2025-01-05", 6) + [("2025-06-05", 499.0)],
        "early_payment": m("2025-01-05", 6) + [("2025-06-22", 499.0)],
        "late_payment": m("2025-01-05", 6) + [("2025-07-28", 499.0)],
        "price_step_and_adaptation": m("2025-01-05", 6) + m("2025-07-05", 6, amount=649.0),
        "jittery_month_end": m("2025-01-28", 10, jitter=[0, 2, 1, 3, 0, 1]),
        "yearly": [("2021-03-10", 1499.0), ("2022-03-11", 1499.0), ("2023-03-10", 1499.0),
                   ("2024-03-12", 1499.0), ("2025-03-10", 1999.0)],
        "varying_amounts_utility": list(zip([d for d, _ in m("2025-01-05", 9)],
                                            [1800.0, 2300.0, 1500.0, 2100.0, 1650.0, 1900.0, 2600.0, 1750.0, 5200.0])),
        "fractional_amounts": list(zip([d for d, _ in m("2025-01-05", 7)],
                                       [119.99, 119.99, 120.49, 119.99, 119.5, 119.99, 129.99])),
    }
    return [{"name": k, "payments": [{"date": d, "amount": float(a)} for d, a in v]} for k, v in cases.items()]


def synthetic_cases(limit: int = 40) -> list:
    build = build_synthetic(seed=42, n_users=40)
    labels = build.features.groupby("group_id")["label"].first()
    subs = build.clean[build.clean["group_id"].isin(labels[labels == "subscription"].index)]
    injected = anomaly.inject_anomalies(subs, seed=42)
    out = []
    for gid in sorted(injected["group_id"].unique())[:limit]:
        g = injected[injected["group_id"] == gid].sort_values(["date", "row_id"], kind="mergesort")
        out.append({"name": f"synthetic::{gid}",
                    "payments": [{"date": d.strftime("%Y-%m-%d"), "amount": float(a)}
                                 for d, a in zip(g["date"], g["amount"])]})
    return out


def build_fixture() -> dict:
    cases = []
    for c in hand_cases() + synthetic_cases():
        days = anomaly._day_numbers(pd.Series([p["date"] for p in c["payments"]]))
        expected = anomaly.score_sequence(days, [p["amount"] for p in c["payments"]])
        cases.append({**c, "expected": expected})
    return {
        "generatedBy": "ml-service/scripts/export_anomaly_parity_fixture.py",
        "reference": "ml-service/subsense_ml/anomaly.py::score_sequence",
        "config": {"window": anomaly.WINDOW, "minHistory": anomaly.MIN_HISTORY,
                   "zThreshold": anomaly.Z_THRESHOLD, "madToStd": anomaly.MAD_TO_STD,
                   "amountFloorRel": anomaly.AMOUNT_FLOOR_REL, "intervalFloorDays": anomaly.INTERVAL_FLOOR_DAYS,
                   "intervalFloorRel": anomaly.INTERVAL_FLOOR_REL},
        "cases": cases,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    text = json.dumps(build_fixture(), indent=1, sort_keys=True) + "\n"
    out = Path(args.out)
    if args.check:
        ok = out.exists() and out.read_text(encoding="utf-8") == text
        print("fixture up to date" if ok else f"fixture STALE or missing: {out}")
        return 0 if ok else 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    n = sum(len(c["expected"]) for c in json.loads(text)["cases"])
    print(f"wrote {out} ({n} scored payments)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
