"""PVGIS (EU JRC) keyless baseline + terrain horizon.

Independent cross-check for our pvlib physics chain and the raw material for
the onboarding shading view. Both endpoints are cached on disk like ERA5.
"""

from __future__ import annotations

import json
from pathlib import Path

from pvlib.iotools import get_pvgis_hourly, get_pvgis_horizon

CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "raw" / "cache"


def pvgis_baseline(lat: float, lng: float, tilt: float, azimuth: float,
                   kwp: float, year: int = 2023) -> dict:
    """Annual PV energy (kWh) for the point from PVGIS, or {"error": ...}."""
    key = f"pvgisB_{lat:.3f}_{lng:.3f}_{tilt:.0f}_{azimuth:.0f}_{kwp:.1f}.json"
    f = CACHE_DIR / key
    if f.exists():
        return json.loads(f.read_text())
    last: Exception | None = None
    for raddatabase in (None, "PVGIS-ERA5"):
        try:
            kw = dict(latitude=lat, longitude=lng, start=year, end=year,
                      pvcalculation=True, peakpower=kwp, loss=14,
                      surface_tilt=tilt, surface_azimuth=azimuth, timeout=60)
            if raddatabase:
                kw["raddatabase"] = raddatabase
            data, meta = get_pvgis_hourly(**kw)
            out: dict = {
                "annual_kwh": round(float(data["P"].sum()) / 1000.0, 1),
                "year": year,
                "source": "PVGIS (EU JRC)",
            }
            if "G(i)" in data.columns:
                out["gti_kwh_m2"] = round(float(data["G(i)"].sum()) / 1000.0, 1)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(out))
            return out
        except Exception as exc:  # noqa: BLE001
            last = exc
    return {"error": f"PVGIS unavailable: {last}"}


def horizon_profile(lat: float, lng: float) -> dict | None:
    """Terrain horizon (az -> elevation degrees), cached; None on failure."""
    key = f"horizon_{lat:.3f}_{lng:.3f}.json"
    f = CACHE_DIR / key
    if f.exists():
        return json.loads(f.read_text())
    try:
        series, _meta = get_pvgis_horizon(lat, lng, timeout=45)
        pts = [{"az": round(float(az), 1), "el": round(float(el), 2)}
               for az, el in series.items()]
        out = {"points": pts}
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(out))
        return out
    except Exception:  # noqa: BLE001
        return None
