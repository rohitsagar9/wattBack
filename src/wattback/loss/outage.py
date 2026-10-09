"""Outage detection from daily generation alone (no network needed).

Rule: a day is an outage candidate when its actual output collapses below
5% of the trailing-14-day median (model-independent, works on raw series).
Runs of >= min_days candidates become alerts with an estimated energy loss
(trailing median x days).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from wattback.config import RAW_DIR

MIN_RUN_DAYS = 2
COLLAPSE_FRACTION = 0.05


def load_daily(key: str) -> pd.DataFrame:
    df = pd.read_csv(RAW_DIR / f"{key}_daily.csv", parse_dates=["date"])
    return df.sort_values("date").reset_index(drop=True)


def detect_outages(key: str, start: str | None = None,
                   end: str | None = None) -> list[dict]:
    df = load_daily(key)
    if start:
        df = df[df["date"] >= start]
    if end:
        df = df[df["date"] <= end]
    df = df.copy()

    ref = (df["generated_kwh"].where(df["generated_kwh"] > 0)
           .rolling(14, min_periods=3, center=True).median())
    floor = ref * COLLAPSE_FRACTION
    is_out = (df["generated_kwh"] <= floor) & (ref > 0)

    alerts: list[dict] = []
    run_start = None
    run_idx: list[int] = []
    for i, out in enumerate(list(is_out) + [False]):
        if out:
            if run_start is None:
                run_start = i
            run_idx.append(i)
        else:
            if run_start is not None and len(run_idx) >= MIN_RUN_DAYS:
                chunk = df.iloc[run_idx]
                lost = float((ref.iloc[run_idx]
                              - chunk["generated_kwh"]).clip(lower=0).sum())
                alerts.append({
                    "site": key,
                    "start": str(chunk["date"].iloc[0].date()),
                    "end": str(chunk["date"].iloc[-1].date()),
                    "days": len(run_idx),
                    "est_lost_kwh": round(lost, 1),
                })
            run_start = None
            run_idx = []
    return alerts


def overlaps(alert: dict, start: str, end: str, min_days: int = 1) -> int:
    """Number of alert days inside [start, end]."""
    a0 = max(pd.Timestamp(alert["start"]), pd.Timestamp(start))
    a1 = min(pd.Timestamp(alert["end"]), pd.Timestamp(end))
    return max(0, (a1 - a0).days + 1)
