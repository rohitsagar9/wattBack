import time
from datetime import date, timedelta
from typing import Union

import pandas as pd
import requests

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
DAILY_VARS = (
    "shortwave_radiation_sum,temperature_2m_mean,temperature_2m_max,"
    "temperature_2m_min,precipitation_sum,cloud_cover_mean,wind_speed_10m_max"
)
MJ_TO_KWH = 3.6


def fetch_era5_daily(
    lat: float,
    lng: float,
    start: Union[date, str],
    end: Union[date, str],
    max_retries: int = 3,
) -> pd.DataFrame:
    start_d = date.fromisoformat(start) if isinstance(start, str) else start
    end_d = date.fromisoformat(end) if isinstance(end, str) else end
    end_d = min(end_d, date.today() - timedelta(days=1))
    params = {
        "latitude": lat,
        "longitude": lng,
        "start_date": start_d.isoformat(),
        "end_date": end_d.isoformat(),
        "daily": DAILY_VARS,
        "timezone": "auto",
    }
    last_err: Exception | None = None
    data = None
    for attempt in range(max_retries):
        try:
            resp = requests.get(ARCHIVE_URL, params=params, timeout=60)
            resp.raise_for_status()
            data = resp.json()["daily"]
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < max_retries - 1:
                time.sleep(2**attempt)
    if data is None:
        raise RuntimeError(f"ERA5 fetch failed for {lat},{lng}: {last_err}")

    df = pd.DataFrame({"date": data["time"]})
    df["ghi_kwh_m2"] = [
        None if v is None else round(v / MJ_TO_KWH, 3)
        for v in data["shortwave_radiation_sum"]
    ]
    df["tmean_c"] = data["temperature_2m_mean"]
    df["tmax_c"] = data["temperature_2m_max"]
    df["tmin_c"] = data["temperature_2m_min"]
    df["precip_mm"] = data["precipitation_sum"]
    df["cloud_pct"] = data.get("cloud_cover_mean")
    df["wind_max_kmh"] = data["wind_speed_10m_max"]
    nulls = int(df["ghi_kwh_m2"].isna().sum())
    if nulls:
        print(f"  era5: dropping {nulls} day(s) with null GHI (latency)")
        df = df.dropna(subset=["ghi_kwh_m2"]).reset_index(drop=True)
    df["ghi_kwh_m2"] = df["ghi_kwh_m2"].astype(float)
    return df
