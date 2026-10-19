import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

from _helpers import prep, raises, tx
from subsense_ml.preprocessing import parse_amount, parse_date_utc, preprocess_transactions


# --- valid parsing ----------------------------------------------------------
def test_parses_valid_transactions():
    res = prep([
        tx("2026-06-14", "POS DEBIT - NETFLIX.COM* 1234", "499"),
        tx("2026-07-14", "POS DEBIT - NETFLIX.COM* 1234", "₹499.00"),
        tx("2026-07-20", "SWIGGY BANGALORE", "1,250"),
    ])
    c = res.clean
    assert len(c) == 3 and len(res.excluded) == 0
    assert str(c["date"].dtype).startswith("datetime64")
    assert sorted(c["amount"].tolist()) == [499.0, 499.0, 1250.0]
    assert set(c["merchant_key"]) == {"netflix", "swiggy"}
    assert set(c["group_id"]) == {"default_user::netflix", "default_user::swiggy"}
    assert (c["currency"] == "INR").all()


def test_accepted_date_formats_and_utc_policy():
    expected = pd.Timestamp("2026-06-14")
    for text in ["2026-06-14", "2026/06/14", "14-06-2026", "14/06/2026", "14 Jun 2026",
                 "14 June 2026", "2026-06-14T10:00:00Z", "2026-06-14T10:00:00"]:
        ts, err = parse_date_utc(text)
        assert err is None and ts == expected, text


def test_date_boundary_converts_offset_to_utc_day():
    # 01:00 IST on 1 Feb == 19:30 UTC on 31 Jan -> UTC calendar day is 31 Jan.
    ts, _ = parse_date_utc("2026-02-01T01:00:00+05:30")
    assert ts == pd.Timestamp("2026-01-31")
    ts, _ = parse_date_utc("2026-01-31T23:30:00+05:30")
    assert ts == pd.Timestamp("2026-01-31")
    ts, _ = parse_date_utc("2026-12-31T23:59:59Z")
    assert ts == pd.Timestamp("2026-12-31")
    ts, _ = parse_date_utc(pd.Timestamp("2026-03-01T02:00:00", tz="Asia/Kolkata"))
    assert ts == pd.Timestamp("2026-02-28")


def test_day_first_is_used_for_ambiguous_slash_dates():
    ts, _ = parse_date_utc("03/04/2026")
    assert ts == pd.Timestamp("2026-04-03")  # 3 April (Indian DD/MM), documented policy


# --- invalid dates / amounts / merchants ---------------------------------------
def test_invalid_dates_are_excluded_with_reason_not_dropped():
    res = prep([
        tx("2026-06-14"), tx("31/02/2026"), tx("not-a-date"), tx(""), tx("1850-01-01"),
    ])
    assert len(res.clean) == 1
    reasons = res.excluded.set_index("row_id")["exclusion_reason"].to_dict()
    assert reasons == {1: "invalid_date", 2: "invalid_date", 3: "missing_date", 4: "implausible_date"}
    assert res.report["n_clean_rows"] + res.report["n_excluded_rows"] == res.report["n_input_rows"] == 5
    assert res.excluded.loc[0, "raw_date"] == "31/02/2026"  # original text kept for audit


def test_invalid_and_non_positive_amounts():
    assert parse_amount("₹1,499.00") == (1499.0, None)
    assert parse_amount("INR 99") == (99.0, None)
    assert parse_amount(649) == (649.0, None)
    assert parse_amount("abc") == (None, "invalid_amount")
    assert parse_amount("") == (None, "missing_amount")
    assert parse_amount(np.nan) == (None, "missing_amount")
    assert parse_amount("inf") == (None, "non_finite_amount")
    assert parse_amount("nan") == (None, "non_finite_amount")
    assert parse_amount("-499") == (None, "negative_amount_credit_or_refund")
    assert parse_amount("0") == (None, "zero_amount")


def test_missing_merchant_is_excluded():
    res = prep([tx("2026-06-14", merchant=""), tx("2026-06-15", merchant="   "),
                tx("2026-06-16", merchant=None), tx("2026-06-17")])
    assert len(res.clean) == 1
    assert res.report["excluded_by_reason"] == {"missing_merchant": 3}


def test_first_failing_reason_wins_and_each_row_counted_once():
    res = prep([tx("bad-date", merchant="", amount="-5")])
    assert len(res.excluded) == 1
    assert res.excluded.loc[0, "exclusion_reason"] == "invalid_date"


# --- empty / schema ------------------------------------------------------------
def test_empty_dataset_from_header_only_csv():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "empty.csv"
        p.write_text("date,merchant,amount\n", encoding="utf-8")
        res = preprocess_transactions(p)
    assert len(res.clean) == 0 and len(res.excluded) == 0
    assert res.report["n_input_rows"] == 0
    assert "empty_input" in res.report["warnings"]


def test_missing_required_column_raises():
    with raises(ValueError, match="amount"):
        preprocess_transactions(pd.DataFrame([{"date": "2026-06-14", "merchant": "X"}]))


def test_headers_are_case_insensitive_like_backend():
    df = pd.DataFrame([{"Date": "2026-06-14", "MERCHANT": "Netflix", "Amount": "499", "isRecurring": "true"}])
    res = preprocess_transactions(df)
    assert len(res.clean) == 1 and bool(res.clean.loc[0, "is_recurring"]) is True


# --- currency --------------------------------------------------------------------
def test_non_base_currency_excluded_and_assumption_reported():
    res = prep([tx("2026-06-14", currency="INR"), tx("2026-06-15", currency="USD"),
                tx("2026-06-16", currency="")])
    assert len(res.clean) == 2
    assert res.report["excluded_by_reason"] == {"non_base_currency": 1}
    assert any("blank_currency_assumed" in w for w in res.report["warnings"])
    res2 = prep([tx("2026-06-14")])
    assert any("no_currency_column" in w for w in res2.report["warnings"])


# --- duplicates ------------------------------------------------------------------
def test_verified_duplicate_with_same_reference_is_removed():
    res = prep([tx("2026-06-14", reference="TXN1"), tx("2026-06-14", reference="TXN1")])
    assert len(res.clean) == 1
    assert res.excluded.loc[0, "exclusion_reason"] == "verified_duplicate_same_reference"


def test_identical_rows_without_reference_are_kept_and_flagged():
    # Two coffees at the same price on the same day are legitimate.
    rows = [tx("2026-06-14", "STARBUCKS COFFEE", 350), tx("2026-06-14", "STARBUCKS COFFEE", 350)]
    res = prep(rows)
    assert len(res.clean) == 2 and len(res.excluded) == 0
    assert res.clean["possible_duplicate"].all()


def test_same_content_different_references_kept_and_flagged():
    # Two distinct bank records = a genuine double charge, which Phase 2 wants to see.
    res = prep([tx("2026-06-14", reference="A1"), tx("2026-06-14", reference="A2")])
    assert len(res.clean) == 2 and res.clean["possible_duplicate"].all()


def test_same_reference_different_content_is_conflict_not_deleted():
    res = prep([tx("2026-06-14", amount=499, reference="R9"), tx("2026-06-14", amount=649, reference="R9")])
    assert len(res.clean) == 2
    assert res.clean["reference_conflict"].all()
    assert any(w.startswith("reference_conflicts") for w in res.report["warnings"])


def test_output_is_sorted_and_deterministic():
    rows = [tx("2026-08-14"), tx("2026-06-14"), tx("2026-07-14", "SPOTIFY", 119)]
    a, b = prep(rows).clean, prep(list(reversed(rows))).clean
    cols = ["group_id", "date", "amount"]
    pd.testing.assert_frame_equal(a[cols], b[cols])
