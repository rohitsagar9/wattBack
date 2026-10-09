import time
from datetime import date, timedelta
from pathlib import Path
from typing import Union

import pandas as pd
import requests

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
DAILY_VARS = (
    "shortwave_radiation_sum,temperature_2m_mean,temperature_2m_max,"
    "temperature_2m_min,precipitation_sum,cloud_cover_mean,wind_speed_10m_max"
)
HOURLY_VARS = (
    "shortwave_radiation,diffuse_radiation,direct_normal_irradiance,"
    "temperature_2m,wind_speed_10m,precipitation"
)
MJ_TO_KWH = 3.6
CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "raw" / "cache"


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

def _cached(name: str, fetch) -> pd.DataFrame:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / name
    if path.exists():
        return pd.read_csv(path, parse_dates=["time"])
    df = fetch()
    df.to_csv(path, index=False)
    return df


def fetch_era5_hourly(
    lat: float,
    lng: float,
    start: Union[date, str],
    end: Union[date, str],
    max_retries: int = 3,
) -> pd.DataFrame:
    """Hourly GHI/DNI/DHI, temp, wind, precip in local wall time."""
    start_d = date.fromisoformat(start) if isinstance(start, str) else start
    end_d = date.fromisoformat(end) if isinstance(end, str) else end
    end_d = min(end_d, date.today() - timedelta(days=1))

    def _fetch() -> pd.DataFrame:
        params = {
            "latitude": lat,
            "longitude": lng,
            "start_date": start_d.isoformat(),
            "end_date": end_d.isoformat(),
            "hourly": HOURLY_VARS,
            "wind_speed_unit": "ms",
            "timezone": "Asia/Kolkata",
        }
        last_err: Exception | None = None
        for attempt in range(max_retries):
            try:
                resp = requests.get(ARCHIVE_URL, params=params, timeout=90)
                resp.raise_for_status()
                h = resp.json()["hourly"]
                df = pd.DataFrame({
                    "time": h["time"],
                    "ghi_wm2": h["shortwave_radiation"],
                    "dhi_wm2": h["diffuse_radiation"],
                    "dni_wm2": h["direct_normal_irradiance"],
                    "temp_air_c": h["temperature_2m"],
                    "wind_ms": h["wind_speed_10m"],
                    "precip_mm": h["precipitation"],
                })
                df = df.dropna(subset=["ghi_wm2"]).reset_index(drop=True)
                df["ghi_wm2"] = df["ghi_wm2"].astype(float)
                return df
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
        raise RuntimeError(f"ERA5 hourly fetch failed for {lat},{lng}: {last_err}")

    return _cached(f"era5h_{start_d}_{end_d}_{lat:.3f}_{lng:.3f}.csv", _fetch)


def fetch_cams_pm(
    lat: float,
    lng: float,
    start: Union[date, str],
    end: Union[date, str],
    max_retries: int = 3,
) -> pd.DataFrame:
    """Hourly PM2.5 / PM10 (ug/m3) for the HSU soiling model."""
    start_d = date.fromisoformat(start) if isinstance(start, str) else start
    end_d = date.fromisoformat(end) if isinstance(end, str) else end

    def _fetch() -> pd.DataFrame:
        params = {
            "latitude": lat,
            "longitude": lng,
            "start_date": start_d.isoformat(),
            "end_date": end_d.isoformat(),
            "hourly": "pm2_5,pm10",
            "timezone": "Asia/Kolkata",
        }
        last_err: Exception | None = None
        for attempt in range(max_retries):
            try:
                resp = requests.get(AQ_URL, params=params, timeout=90)
                resp.raise_for_status()
                h = resp.json()["hourly"]
                df = pd.DataFrame({
                    "time": h["time"],
                    "pm2_5": h["pm2_5"],
                    "pm10": h["pm10"],
                })
                return df
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
        raise RuntimeError(f"CAMS fetch failed for {lat},{lng}: {last_err}")

    return _cached(f"cams_{start_d}_{end_d}_{lat:.3f}_{lng:.3f}.csv", _fetch)
