"""
Bridge to the EXISTING rule-based detector (backend/src/services/detectionService.js).

For every (group_id, prediction_date) snapshot we pass the rule engine exactly
the transactions the ML features saw (date <= prediction_date) and use
prediction_date as its `referenceDate`. The backend code is not modified; the
Node script replaces only the `mongoose` import with a stub.

Mapping to our labels:
    analyzeMerchantRecurrence(...) returns an object -> "subscription"
    returns null                                     -> "non_subscription"
The rules have no notion of "ambiguous", so they can never predict it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pandas as pd

ML_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ML_ROOT / "scripts" / "rule_baseline"
DEFAULT_SERVICE = ML_ROOT.parent / "backend" / "src" / "services" / "detectionService.js"


class RuleBaselineUnavailable(RuntimeError):
    pass


def build_rule_inputs(clean_tx: pd.DataFrame, snapshots: pd.DataFrame) -> list:
    by_group = {g: df.sort_values(["date", "row_id"], kind="mergesort") for g, df in clean_tx.groupby("group_id")}
    out = []
    for row in snapshots.itertuples(index=False):
        pred = pd.Timestamp(row.prediction_date)
        g = by_group[row.group_id]
        vis = g[g["date"] <= pred]
        out.append({
            "key": snapshot_key(row.group_id, pred),
            "merchantName": str(row.merchant_name),
            "referenceDate": pred.strftime("%Y-%m-%d"),
            "txs": [{"date": d.strftime("%Y-%m-%d"), "amount": float(a), "account": str(ac)}
                    for d, a, ac in zip(vis["date"], vis["amount"], vis["account"])],
        })
    return out


def snapshot_key(group_id: str, prediction_date) -> str:
    return f"{group_id}|{pd.Timestamp(prediction_date).strftime('%Y-%m-%d')}"


def run_rule_baseline(clean_tx: pd.DataFrame, snapshots: pd.DataFrame,
                      service_path: Path = DEFAULT_SERVICE) -> pd.DataFrame:
    """Return one row per snapshot: key, rule_pred, rule_interval, rule_confidence."""
    node = shutil.which("node")
    if node is None:
        raise RuleBaselineUnavailable("Node.js is not on PATH")
    if not Path(service_path).exists():
        raise RuleBaselineUnavailable(f"detection service not found at {service_path}")

    inputs = build_rule_inputs(clean_tx, snapshots)
    with tempfile.TemporaryDirectory() as d:
        inp, outp = Path(d) / "in.json", Path(d) / "out.json"
        inp.write_text(json.dumps(inputs), encoding="utf-8")
        proc = subprocess.run(
            [node, "--import", (SCRIPT_DIR / "register.mjs").as_uri(), str(SCRIPT_DIR / "run.mjs"),
             str(inp), str(outp)],
            capture_output=True, text=True, timeout=600,
            env={**__import__("os").environ, "SUBSENSE_DETECTION_SERVICE": str(service_path)},
        )
        if proc.returncode != 0:
            raise RuleBaselineUnavailable(f"rule baseline failed: {proc.stderr.strip()[:500]}")
        results = json.loads(outp.read_text(encoding="utf-8"))["results"]

    df = pd.DataFrame(results)
    df["rule_pred"] = df["recurring"].map({True: "subscription", False: "non_subscription"})
    return df.rename(columns={"billingInterval": "rule_interval", "confidence": "rule_confidence",
                              "status": "rule_status"})[["key", "rule_pred", "rule_interval",
                                                          "rule_confidence", "rule_status"]]
