import numpy as np
import pytest

from wattback.loss.counterfactual import cleaning_counterfactual
from wattback.loss.engine import LOSS_COLS, run_engine
from wattback.loss.outage import detect_outages, overlaps

ORACLE_WINDOW = ("2026-09-01", "2026-09-29")


@pytest.fixture(scope="module")
def bmt():
    return run_engine("bmt", *ORACLE_WINDOW)


@pytest.fixture(scope="module")
def manalil():
    return run_engine("manalil", *ORACLE_WINDOW)


def test_bmt_oracle(bmt):
    daily, meta = bmt
    t = meta["totals"]
    assert meta["n_days"] == 29
    assert t["expected"] == pytest.approx(5670.0, rel=0.03)
    assert t["actual"] == pytest.approx(4917.0, rel=0.001)
    assert t["avail"] == 0 and t["missing"] == 0
    ue_pct = 100 * abs(t["unexplained"]) / t["expected"]
    assert ue_pct < 1.0, ue_pct
    assert 100 * t["temp"] / t["expected"] == pytest.approx(6.78, abs=1.0)
    assert 100 * t["soiling"] / t["expected"] == pytest.approx(0.73, abs=0.5)
    assert 100 * t["inv_conv"] / t["expected"] == pytest.approx(3.62, abs=0.5)
    assert all(t[c] >= 0 for c in LOSS_COLS)


def test_manalil_oracle(manalil):
    daily, meta = manalil
    t = meta["totals"]
    assert meta["n_days"] == 29
    assert t["expected"] == pytest.approx(384.9, rel=0.03)
    assert t["actual"] == pytest.approx(335.8, rel=0.001)
    ue_pct = 100 * abs(t["unexplained"]) / t["expected"]
    assert ue_pct < 1.5, ue_pct
    assert 100 * t["temp"] / t["expected"] == pytest.approx(6.99, abs=1.0)


def test_chain_closes_exactly(bmt, manalil):
    for daily, meta in (bmt, manalil):
        t = meta["totals"]
        lhs = t["predicted"] - t["avail"] - t["missing"] - t["unexplained"]
        assert lhs == pytest.approx(t["actual"], abs=1e-6)
        expected_minus_losses = t["expected"] - sum(t[c] for c in LOSS_COLS)
        assert expected_minus_losses == pytest.approx(t["predicted"], abs=1e-6)


def test_daily_frame_has_every_day(bmt):
    daily, meta = bmt
    assert len(daily) == 29
    assert daily.index.is_monotonic_increasing


def test_outage_manalil_known_cluster():
    alerts = detect_outages("manalil", "2025-03-01", "2025-06-01")
    overlap = sum(overlaps(a, "2025-04-11", "2025-05-04") for a in alerts)
    assert overlap >= 8, alerts
    assert any(a["days"] >= 4 for a in alerts)


def test_outage_bmt_feb_cluster():
    alerts = detect_outages("bmt", "2026-02-01", "2026-03-01")
    overlap = sum(overlaps(a, "2026-02-17", "2026-02-20") for a in alerts)
    assert overlap == 4, alerts


def test_outage_bmt_historical_clusters():
    alerts = detect_outages("bmt", "2024-07-01", "2025-11-01")
    jul24 = sum(overlaps(a, "2024-07-20", "2024-07-28") for a in alerts)
    oct25 = sum(overlaps(a, "2025-10-04", "2025-10-10") for a in alerts)
    assert jul24 >= 7, alerts
    assert oct25 >= 5, alerts


def test_counterfactual_dry_season_recommends_clean():
    cf = cleaning_counterfactual(
        "bmt", "2026-04-15", expected_per_day=150.0, soiling_ratio=0.95)
    assert cf["gain_kwh"] > 0
    assert cf["recommendation"] == "clean now"


def test_counterfactual_clean_panels_wait():
    cf = cleaning_counterfactual(
        "bmt", "2026-04-15", expected_per_day=150.0, soiling_ratio=1.0)
    assert cf["gain_kwh"] == 0
    assert cf["recommendation"] == "wait for rain"
