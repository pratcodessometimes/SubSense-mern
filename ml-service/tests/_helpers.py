"""Small shared helpers. Plain Python so tests run under pytest OR run_tests.py."""

from __future__ import annotations

import contextlib
import unittest
from pathlib import Path

import pandas as pd

from subsense_ml.preprocessing import preprocess_transactions

ML_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ML_ROOT.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def tx(date, merchant="NETFLIX.COM", amount=499, account="HDFC 1111", **extra) -> dict:
    row = {"date": date, "merchant": merchant, "amount": amount, "account": account}
    row.update(extra)
    return row


def prep(rows, **kw):
    """Preprocess a list of row dicts and return the PreprocessResult."""
    return preprocess_transactions(pd.DataFrame(rows), **kw)


def monthly_dates(start_year, start_month, day, n):
    out = []
    y, m = start_year, start_month
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}-{day:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


@contextlib.contextmanager
def raises(exc_type, match: str | None = None):
    try:
        yield
    except exc_type as e:  # noqa: PERF203
        if match and match not in str(e):
            raise AssertionError(f"expected message containing {match!r}, got {e!r}")
        return
    raise AssertionError(f"expected {exc_type.__name__} to be raised")


def skip(reason: str):
    raise unittest.SkipTest(reason)
