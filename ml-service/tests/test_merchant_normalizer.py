import json

from _helpers import FIXTURES
from subsense_ml.merchant_normalizer import normalize_merchant


def test_python_port_matches_javascript_normalizer():
    data = json.loads((FIXTURES / "normalizer_parity.json").read_text(encoding="utf-8"))
    mismatches = []
    for case in data["cases"]:
        got = normalize_merchant(case["input"]).to_dict()
        if got != case["expected"]:
            mismatches.append((case["input"], case["expected"], got))
    assert not mismatches, mismatches[:5]
    assert len(data["cases"]) >= 60


def test_variants_of_one_merchant_share_a_key():
    variants = ["POS DEBIT - NETFLIX.COM* 1234", "NETFLIX.COM", "netflix", "UPI/NETFLIX/9988"]
    assert {normalize_merchant(v).canonicalKey for v in variants} == {"netflix"}
    generic = ["UPI/KINDLEVERSE READS/1111", "UPI/KINDLEVERSE READS/2222", "UPI/KINDLEVERSE READS/3333"]
    assert {normalize_merchant(v).canonicalKey for v in generic} == {"kindleverse-reads"}


def test_distinct_merchants_stay_distinct_and_output_is_deterministic():
    assert normalize_merchant("SWIGGY").canonicalKey != normalize_merchant("STARBUCKS").canonicalKey
    assert normalize_merchant("ACME GYM PVT LTD") == normalize_merchant("ACME GYM PVT LTD")


def test_missing_merchant_maps_to_unknown():
    assert normalize_merchant(None).canonicalKey == "unknown"
    assert normalize_merchant("").canonicalKey == "unknown"
