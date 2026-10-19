"""
Build a feature dataset.

Synthetic development dataset (default; output is committed-safe):
    python scripts/build_dataset.py
CSV in the SubSense import format (e.g. the repo's sample CSV):
    python scripts/build_dataset.py --input ../sample-transactions.csv --output-dir data/local/sample

Real/private CSVs must go to data/local/ (git-ignored). This script never
connects to MongoDB.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from subsense_ml.pipeline import build_dataset, build_synthetic, write_outputs  # noqa: E402
from subsense_ml.preprocessing import load_raw  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", help="CSV in SubSense import format. Omit for synthetic data.")
    ap.add_argument("--output-dir", help="Where to write outputs.")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--n-users", type=int, default=40)
    ap.add_argument("--prediction-dates", help="Comma-separated YYYY-MM-DD (CSV mode). "
                                               "Default: latest transaction date.")
    args = ap.parse_args(argv)

    if args.input:
        out = Path(args.output_dir or ROOT / "data" / "local" / Path(args.input).stem)
        dates = args.prediction_dates.split(",") if args.prediction_dates else None
        build = build_dataset(load_raw(args.input), "real", dates)
        files = write_outputs(build, out, write_raw=False)
    else:
        out = Path(args.output_dir or ROOT / "data" / "synthetic")
        build = build_synthetic(seed=args.seed, n_users=args.n_users)
        files = write_outputs(build, out, write_raw=True)

    val = build.report["validation"]
    print(json.dumps({
        "output_dir": str(out),
        "files": [p.name for p in files],
        "preprocessing": {k: build.report["preprocessing"][k] for k in
                          ("n_input_rows", "n_clean_rows", "n_excluded_rows", "excluded_by_reason", "n_groups")},
        "validation_ok": val["ok"],
        "validation_errors": val["errors"],
        "validation_warnings": val["warnings"],
        "summary": val["summary"],
    }, indent=2, default=str))
    return 0 if val["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
