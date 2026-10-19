"""
Phase 3.2 — train and evaluate subscription classifiers vs the rule baseline.

    python scripts/train_evaluate.py                 # full run (seed 42, 40 users)
    python scripts/train_evaluate.py --fast          # quick smoke run (15 trees, 100 bootstraps)
    python scripts/train_evaluate.py --no-rules      # skip the Node rule baseline

Outputs (deterministic): reports/classification/
    results.json  results.md  test_predictions.csv  feature_importance.csv
    logistic_coefficients.csv  decision_tree.txt
Model parameters (synthetic-trained, NOT for deployment): artifacts/ (git-ignored)

All numbers are measured on SYNTHETIC data and are not evidence of real-world accuracy.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from subsense_ml.classification import LABEL_ORDER, explain_models, run_classification_experiment  # noqa: E402
from subsense_ml.pipeline import build_synthetic  # noqa: E402

BANNER = ("> ⚠️ **Synthetic data.** Labels come from our own generator (`label_source = synthetic`). "
          "These numbers show the pipeline and the comparison method work; they do **not** estimate "
          "real-world accuracy.\n")


def _fmt_ci(ci):
    return f"[{ci[0]:.3f}, {ci[1]:.3f}]"


def render_markdown(res: dict, explain: dict) -> str:
    p = res["protocol"]
    L = ["# Phase 3.2 — Classification results", "", BANNER,
         "## Protocol", "",
         f"- Eligible rows: {p['n_eligible_rows']} → train {p['n_train_rows']} rows / {p['n_train_groups']} groups, "
         f"test {p['n_test_rows']} rows / {p['n_test_groups']} groups (hash-based group split, no group in both).",
         f"- Train labels: {p['train_label_counts']}; test labels: {p['test_label_counts']}.",
         f"- {p['n_folds']}-fold group cross-validation inside train; seed {p['seed']}; class weights balanced.",
         f"- Label sources: {p['label_sources']} → real-world claim allowed: **{p['real_world_claim_allowed']}**.",
         "", "## Summary (test split)", "",
         "| Model | Features | CV macro-F1 (mean ± sd) | Test macro-F1 | 95% CI (group bootstrap) | Accuracy | "
         "Binary F1 (subscription vs rest) |",
         "|---|---|---|---|---|---|---|"]
    for name, m in res["models"].items():
        t = m["test"]
        cv = "—" if m["cv_macro_f1_mean"] is None else f"{m['cv_macro_f1_mean']:.3f} ± {m['cv_macro_f1_std']:.3f}"
        L.append(f"| {m['model'].split(' ')[0]} | {m['feature_set'].split(' ')[0]} | {cv} | {t['macro_f1']:.3f} | "
                 f"{_fmt_ci(t['macro_f1_95ci_group_bootstrap'])} | {t['accuracy']:.3f} | "
                 f"{t['binary_subscription_vs_rest']['f1']:.3f} |")
    if "rule_baseline_unavailable" in res:
        L += ["", f"Rule baseline unavailable: {res['rule_baseline_unavailable']}"]
    if "rule_baseline_on_its_own_task" in res:
        r = res["rule_baseline_on_its_own_task"]
        L += ["", f"**Rule baseline on its own task** ({r['task']}): precision {r['precision']:.3f}, "
                  f"recall {r['recall']:.3f}, F1 {r['f1']:.3f} (tp {r['tp']}, fp {r['fp']}, fn {r['fn']}, "
                  f"tn {r['tn']}). The rules were designed to find recurring payments, so the subscription "
                  "metrics above penalise them for rent/EMIs they were never meant to exclude."]

    L += ["", "## Per-class metrics and confusion matrices (test split)", ""]
    for name, m in res["models"].items():
        t = m["test"]
        L += [f"### {name}", "", "| Class | Precision | Recall | F1 | Support |", "|---|---|---|---|---|"]
        for c in LABEL_ORDER:
            pc = t["per_class"][c]
            L.append(f"| {c} | {pc['precision']:.3f} | {pc['recall']:.3f} | {pc['f1']:.3f} | {pc['support']} |")
        if t["undefined_precision"]:
            L.append(f"\nNever predicted (precision undefined, shown as 0): {t['undefined_precision']}")
        cm = t["confusion_matrix"]
        L += ["", "Confusion matrix (rows = true, columns = predicted):", "",
              "| true \\ pred | " + " | ".join(cm["labels"]) + " |", "|---" * (len(cm["labels"]) + 1) + "|"]
        for lab, row in zip(cm["labels"], cm["matrix"]):
            L.append(f"| {lab} | " + " | ".join(str(v) for v in row) + " |")
        L.append("")

    if "predicted_subscription_rate_by_archetype" in res:
        rates = res["predicted_subscription_rate_by_archetype"]
        cols = [c for c in next(iter(rates.values())) if c not in ("n", "true_label") and
                (c.endswith("all_features") or c.endswith("no_amount_level") or c == "rule_baseline")
                and not c.startswith("majority")]
        L += ["## Share of test rows predicted 'subscription', by synthetic archetype", "",
              "| Archetype | True label | n | " + " | ".join(cols) + " |",
              "|---|---|---|" + "---|" * len(cols)]
        for a, r in rates.items():
            L.append(f"| {a} | {r['true_label']} | {r['n']} | " + " | ".join(f"{r[c]:.2f}" for c in cols) + " |")
        L.append("")

    if "decision_tree_text" in explain:
        L += ["## Decision tree (all features)", "", f"Depth {explain['decision_tree_depth']}.", "", "```",
              explain["decision_tree_text"], "```", ""]
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--n-users", type=int, default=40)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--no-rules", action="store_true")
    ap.add_argument("--out-dir", default=str(ROOT / "reports" / "classification"))
    ap.add_argument("--artifacts-dir", default=str(ROOT / "artifacts"))
    args = ap.parse_args(argv)

    t0 = time.time()
    build = build_synthetic(seed=args.seed, n_users=args.n_users)
    if not build.report["validation"]["ok"]:
        print("dataset validation failed:", build.report["validation"]["errors"])
        return 1
    exp = run_classification_experiment(build, seed=args.seed, fast=args.fast, with_rules=not args.no_rules,
                                        n_boot=100 if args.fast else 1000)
    res = exp["results"]
    explain = explain_models(exp["fitted"])

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(res, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    (out / "results.md").write_text(render_markdown(res, explain) + "\n", encoding="utf-8")
    preds = exp["predictions"].copy()
    preds["prediction_date"] = preds["prediction_date"].dt.strftime("%Y-%m-%d")
    preds.to_csv(out / "test_predictions.csv", index=False, lineterminator="\n")
    if "feature_importance" in explain:
        explain["feature_importance"].to_csv(out / "feature_importance.csv", index=False, lineterminator="\n")
    if "logistic_coefficients" in explain:
        explain["logistic_coefficients"].to_csv(out / "logistic_coefficients.csv", index_label="feature",
                                                lineterminator="\n")
    if "decision_tree_text" in explain:
        (out / "decision_tree.txt").write_text(explain["decision_tree_text"] + "\n", encoding="utf-8")

    art = Path(args.artifacts_dir)
    art.mkdir(parents=True, exist_ok=True)
    lr = exp["fitted"].get("logistic_regression__all_features")
    dt = exp["fitted"].get("decision_tree__all_features")
    model_dump = {
        "WARNING": "trained on SYNTHETIC data; not for deployment",
        "labels": LABEL_ORDER,
        "logistic_regression": None if lr is None else {
            "features": lr.columns, "imputer_medians": lr.imputer.medians_.tolist(),
            "scaler_mean": lr.scaler.mean_.tolist(), "scaler_scale": lr.scaler.scale_.tolist(),
            "coef": lr.model.coef_.tolist(), "intercept": lr.model.intercept_.tolist()},
        "decision_tree": None if dt is None else {"features": dt.columns,
                                                  "imputer_medians": dt.imputer.medians_.tolist(),
                                                  **dt.model.to_dict()},
    }
    (art / "synthetic_models.json").write_text(json.dumps(model_dump) + "\n", encoding="utf-8")

    summary = {name: {"test_macro_f1": m["test"]["macro_f1"],
                      "ci95": m["test"]["macro_f1_95ci_group_bootstrap"],
                      "binary_f1": m["test"]["binary_subscription_vs_rest"]["f1"],
                      "cv_macro_f1": m["cv_macro_f1_mean"]} for name, m in res["models"].items()}
    print(json.dumps({"out_dir": str(out), "seconds": round(time.time() - t0, 1),
                      "rule_baseline_unavailable": res.get("rule_baseline_unavailable"),
                      "summary": summary}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
