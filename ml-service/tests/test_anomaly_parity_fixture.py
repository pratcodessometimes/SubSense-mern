import json

from _helpers import REPO_ROOT, skip
from subsense_ml import anomaly

FIXTURE = REPO_ROOT / "backend" / "tests" / "fixtures" / "anomaly_parity.json"


def test_shared_parity_fixture_matches_python_reference():
    """The fixture the Node tests use must still equal the Python reference output."""
    if not FIXTURE.exists():
        skip("backend/tests/fixtures/anomaly_parity.json not found")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "export_fixture", REPO_ROOT / "ml-service" / "scripts" / "export_anomaly_parity_fixture.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    stored = json.loads(FIXTURE.read_text(encoding="utf-8"))
    fresh = json.loads(json.dumps(mod.build_fixture(), sort_keys=True))
    assert stored == fresh, "fixture is stale: run python scripts/export_anomaly_parity_fixture.py"


def test_fixture_covers_required_behaviours():
    if not FIXTURE.exists():
        skip("fixture not found")
    cases = {c["name"]: c for c in json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]}
    assert cases["too_short_3_payments"]["expected"] == []
    assert all(e["robust_flag"] == 0 for e in cases["constant_history_zero_mad"]["expected"])
    assert cases["amount_spike"]["expected"][-1]["robust_reason"] == "amount_higher_than_usual"
    assert cases["amount_drop"]["expected"][-1]["robust_reason"] == "amount_lower_than_usual"
    assert cases["same_day_duplicate"]["expected"][-1]["robust_reason"] == "paid_earlier_than_usual_or_duplicate"
    assert cases["late_payment"]["expected"][-1]["robust_reason"] == "paid_later_than_usual"
    assert sum(len(c["expected"]) for c in cases.values()) > 300
    assert anomaly.Z_THRESHOLD == 3.5
