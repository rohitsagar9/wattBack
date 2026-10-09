import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wattback.config import RAW_DIR, load_sites  # noqa: E402
from wattback.ingest.atlas import fetch_lta  # noqa: E402
from wattback.ingest.pvoutput import fetch_public_window  # noqa: E402
from wattback.ingest.weather import fetch_era5_daily  # noqa: E402

ERA5_DEFAULT_START = {
    "bmt": "2026-01-01",
    "manalil": "2023-06-13",
    "maha_ref": "2024-01-01",
}


def era5_start_for(key: str) -> str:
    csv = RAW_DIR / f"{key}_daily.csv"
    if csv.exists():
        df = pd.read_csv(csv, usecols=["date"], dtype={"date": str})
        if len(df):
            return df["date"].min()
    return ERA5_DEFAULT_START.get(key, "2023-01-01")


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    sites = load_sites()
    yesterday = date.today() - timedelta(days=1)
    for key, cfg in sites.items():
        atlas = fetch_lta(cfg["lat"], cfg["lng"])
        atlas_path = RAW_DIR / f"atlas_{key}.json"
        atlas_path.write_text(json.dumps(atlas, indent=1), encoding="utf-8")
        print(
            f"atlas {key}: GHI {atlas['ghi_kwh_m2']} kWh/m2 | "
            f"PVOUT {atlas['pvout_kwh_kwp']} kWh/kWp -> {atlas_path.name}"
        )
        start = era5_start_for(key)
        era5 = fetch_era5_daily(cfg["lat"], cfg["lng"], start, yesterday)
        era5_path = RAW_DIR / f"era5_{key}.csv"
        era5.to_csv(era5_path, index=False)
        print(
            f"era5 {key}: {len(era5)} days {era5['date'].min()} -> "
            f"{era5['date'].max()} -> {era5_path.name}"
        )
    for key in ("bmt", "manalil"):
        path = RAW_DIR / f"pvoutput_window_{key}.json"
        try:
            rows = fetch_public_window(key)
        except RuntimeError as exc:
            print(f"pvoutput window {key}: SKIPPED ({exc})")
            print(
                "  -> pvoutput.org requires a logged-in browser session; "
                "refresh via console snippet, CSVs remain authoritative"
            )
            continue
        path.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        dates = sorted(r["date"] for r in rows)
        print(f"pvoutput window {key}: {len(rows)} rows {dates[0]}..{dates[-1]}")


if __name__ == "__main__":
    main()
