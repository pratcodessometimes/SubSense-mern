"""
Minimal test runner for environments where pytest is not installed.

    python run_tests.py

It discovers tests/test_*.py and runs every function named test_*. The test
files are ordinary pytest tests, so `python -m pytest` runs the same suite.
"""

from __future__ import annotations

import importlib
import sys
import time
import traceback
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "tests"))


def main() -> int:
    passed, failed, skipped = 0, [], 0
    start = time.time()
    for path in sorted((HERE / "tests").glob("test_*.py")):
        mod = importlib.import_module(path.stem)
        for name in sorted(n for n in dir(mod) if n.startswith("test_")):
            fn = getattr(mod, name)
            if not callable(fn):
                continue
            label = f"{path.name}::{name}"
            try:
                fn()
            except unittest.SkipTest as e:
                skipped += 1
                print(f"SKIP  {label}  ({e})")
            except Exception:  # noqa: BLE001
                failed.append(label)
                print(f"FAIL  {label}\n{traceback.format_exc()}")
            else:
                passed += 1
                print(f"PASS  {label}")
    print(f"\n{passed} passed, {len(failed)} failed, {skipped} skipped in {time.time() - start:.2f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
