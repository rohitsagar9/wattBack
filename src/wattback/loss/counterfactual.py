"""Cleaning counterfactual: what is a panel wash worth today?

Physics kept deliberately simple and auditable:

    gain per day while panels stay dirty = expected_kwh x (1 - soiling_ratio)
    cleaning benefit stops at the next natural wash (rain event)

Rain timing is estimated from the site's own recent rhythm: the median gap
between rain days over the trailing 90 days of ERA5 precipitation.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from wattback.config import RAW_DIR

RAIN_MM = 1.0
DEFAULT_HORIZON = 14
INR_PER_KWH = 8.0  # rooftop self-consumption value, rounded


def _trailing_precip(key: str, end: str) -> pd.Series:
    df = pd.read_csv(RAW_DIR / f"era5_{key}.csv", parse_dates=["date"])
    df = df[df["date"] <= end].tail(90)
    return df.set_index("date")["precip_mm"]


def _modelled_rain_interval(precip: pd.Series) -> int:
    rain_days = precip.index[precip >= RAIN_MM]
    if len(rain_days) < 2:
        return DEFAULT_HORIZON
    gaps = np.diff(rain_days.asi8) / 86_400_000_000_000
    return int(max(1, round(float(np.median(gaps)))))


def cleaning_counterfactual(
    key: str,
    end: str,
    expected_per_day: float,
    soiling_ratio: float,
    horizon: int = DEFAULT_HORIZON,
    inr_per_kwh: float = INR_PER_KWH,
) -> dict:
    """Value of cleaning now vs staying dirty until the modelled rain wash."""
    precip = _trailing_precip(key, end)
    days_since_rain = 0
    if len(precip):
        past = precip[precip >= RAIN_MM]
        if len(past):
            days_since_rain = int((pd.Timestamp(end) - past.index[-1]).days)

    rain_interval = _modelled_rain_interval(precip)
    benefit_days = int(min(horizon, max(0, rain_interval - 1)))

    sr = float(np.clip(soiling_ratio, 0.0, 1.0))
    gain_kwh = benefit_days * max(0.0, expected_per_day) * (1.0 - sr)
    return {
        "site": key,
        "as_of": end,
        "soiling_ratio": round(sr, 4),
        "days_since_rain": days_since_rain,
        "modelled_rain_interval_days": rain_interval,
        "cleaning_worth_days": benefit_days,
        "gain_kwh": round(gain_kwh, 2),
        "gain_inr": round(gain_kwh * inr_per_kwh, 0),
        "recommendation": "clean now" if gain_kwh >= 1.0 else "wait for rain",
    }
