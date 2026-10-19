"""
Phase 3.2 — anomaly detection experiment (separate from classification).

    python scripts/run_anomaly_experiment.py           # seed 42, 40 users, 200 isolation trees
    python scripts/run_anomaly_experiment.py --fast    # 50 isolation trees

Outputs: reports/anomaly/results.json, results.md, flagged_test_payments.csv
Ground truth = anomalies WE injected into SYNTHETIC data.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from subsense_ml.anomaly import run_anomaly_experiment  # noqa: E402
from subsense_ml.pipeline import build_synthetic  # noqa: E402


def render_markdown(res: dict) -> str:
    p = res["protocol"]
    L = ["# Phase 3.2 — Anomaly detection results", "",
         "> ⚠️ **Synthetic data with anomalies injected by us.** This measures whether the detectors find "
         "the anomaly types we planted. It is not evidence about real billing errors or fraud.", "",
         "## Protocol", "",
         f"- Scope: {p['scope']}; {p['n_groups']} groups.",
         f"- A payment is scored only with its previous {p['window']} payments (needs ≥ {p['min_history']}); "
         f"robust deviation flags |z| > {p['robust_z_threshold']}.",
         f"- Isolation Forest: {p['isolation_forest']['n_estimators']} trees, features "
         f"{p['isolation_forest']['features']}, fitted on train-split groups; threshold "
         f"{p['isolation_forest']['threshold']} chosen by max F1 on train.",
         f"- Scored payments: train {p['n_scored_train']}, test {p['n_scored_test']}.",
         f"- Test payment types: {p['test_anomaly_type_counts']}.", "",
         "## Test results", "",
         "| Method | Precision | Recall | F1 | Avg. precision | ROC-AUC | False-flag rate on normal payments | "
         "Price-rise payments flagged |",
         "|---|---|---|---|---|---|---|---|"]
    for name, r in res["test"].items():
        L.append(f"| {name} | {r['precision']:.3f} | {r['recall']:.3f} | {r['f1']:.3f} | "
                 f"{r['average_precision']:.3f} | {r['roc_auc']:.3f} | {r['flag_rate_on_normal_rows']:.4f} | "
                 f"{r['natural_price_change_flagged']}/{r['natural_price_change_rows']} |")
    L += ["", "## Recall by anomaly type", "", "| Type | " + " | ".join(res["test"]) + " |",
          "|---|" + "---|" * len(res["test"])]
    types = sorted({t for r in res["test"].values() for t in r["recall_by_type"]})
    for t in types:
        L.append(f"| {t} | " + " | ".join(f"{r['recall_by_type'].get(t, float('nan')):.3f}"
                                         for r in res["test"].values()) + " |")
    L.append("")
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--n-users", type=int, default=40)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--out-dir", default=str(ROOT / "reports" / "anomaly"))
    args = ap.parse_args(argv)

    t0 = time.time()
    build = build_synthetic(seed=args.seed, n_users=args.n_users)
    exp = run_anomaly_experiment(build, seed=args.seed, if_trees=50 if args.fast else 200)
    res = exp["results"]
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(res, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    (out / "results.md").write_text(render_markdown(res) + "\n", encoding="utf-8")
    t = exp["scored_test"]
    cols = ["group_id", "date", "amount", "ref_median_amount", "interval_days", "ref_median_interval",
            "amount_z", "interval_z", "robust_score", "robust_flag", "robust_reason", "if_score", "if_flag",
            "anomaly_type"]
    flagged = t[(t["robust_flag"] == 1) | (t["if_flag"] == 1) | (t["anomaly_type"] != "")][cols].copy()
    flagged["date"] = flagged["date"].dt.strftime("%Y-%m-%d")
    flagged.round(4).to_csv(out / "flagged_test_payments.csv", index=False, lineterminator="\n")
    print(json.dumps({"out_dir": str(out), "seconds": round(time.time() - t0, 1),
                      "test": {k: {m: v[m] for m in ("precision", "recall", "f1", "average_precision", "roc_auc",
                                                      "recall_by_type", "natural_price_change_flagged")}
                               for k, v in res["test"].items()}}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
