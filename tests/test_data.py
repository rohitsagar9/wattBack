from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"


def load(site: str) -> pd.DataFrame:
    path = RAW / f"{site}_daily.csv"
    if not path.exists():
        pytest.fail(f"missing {path}; run scripts/import_raw.py first")
    return pd.read_csv(path, dtype={"date": str}, keep_default_na=False)


def assert_contiguous(df: pd.DataFrame, lo: str, hi: str) -> None:
    have = set(df["date"])
    cur = date.fromisoformat(lo)
    end = date.fromisoformat(hi)
    missing = []
    while cur <= end:
        if cur.isoformat() not in have:
            missing.append(cur.isoformat())
        cur += timedelta(days=1)
    assert not missing, f"missing {len(missing)} days, first: {missing[:5]}"


def flag_mask(df: pd.DataFrame, flag: str) -> pd.Series:
    return df["flags"].str.split(";").apply(lambda f: flag in f)


def test_bmt_core_window_contiguous():
    df = load("bmt")
    assert_contiguous(df, "2026-01-01", "2026-10-09")


def test_manalil_core_window_contiguous():
    df = load("manalil")
    assert_contiguous(df, "2023-06-24", "2026-10-09")


def test_no_junk_rows_survived():
    for site in ("bmt", "manalil"):
        df = load(site)
        assert (df["generated_kwh"] >= 0).all()
        assert (df["generated_kwh"] < 5000).all(), f"{site}: junk magnitude"
        assert (df["peak_kw"] >= 0).all()
        assert (df["peak_kw"] < 200).all(), f"{site}: junk magnitude"
        assert df["date"].str.fullmatch(r"\d{4}-\d{2}-\d{2}").all()


def test_flags():
    bmt = load("bmt")
    man = load("manalil")
    assert flag_mask(bmt, "partial").sum() == 1
    assert flag_mask(man, "partial").sum() == 1
    assert flag_mask(bmt, "low_output").sum() == 27
    assert flag_mask(bmt, "gap_filled").sum() == 40
    assert flag_mask(man, "gap_filled").sum() == 40
    assert flag_mask(bmt, "outage_suspect").sum() == 4
    assert flag_mask(man, "outage_suspect").sum() == 24
    assert flag_mask(man, "zero").sum() >= 1
    assert flag_mask(bmt, "zero").sum() >= 1


def test_totals_match_known_accounts():
    bmt = load("bmt")
    man = load("manalil")
    bmt_total = bmt["generated_kwh"].sum()
    man_total = man["generated_kwh"].sum()
    assert 180_000 <= bmt_total <= 300_000, bmt_total
    assert 12_000 <= man_total <= 13_000, man_total


def test_bmt_spans_six_years():
    df = load("bmt")
    years = {d[:4] for d in df["date"]}
    assert {"2021", "2022", "2023", "2024", "2025", "2026"} <= years
    from datetime import date as _date, timedelta as _td

    have = set(df["date"])
    cur = _date(2021, 1, 1)
    missing = 0
    while cur <= _date(2026, 10, 9):
        if cur.isoformat() not in have:
            missing += 1
        cur += _td(days=1)
    assert missing <= 15, f"too many missing days: {missing}"


def test_manalil_spans_three_years():
    df = load("manalil")
    years = {d[:4] for d in df["date"]}
    assert {"2023", "2024", "2025", "2026"} <= years
