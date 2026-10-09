import time
from datetime import datetime, timezone

import requests

LTA_URL = "https://api.globalsolaratlas.info/data/lta"
LAYERS = ("GHI", "PVOUT_csi", "DNI", "DIF", "GTI_opta", "TEMP", "OPTA", "ELE")


def fetch_lta(lat: float, lng: float, max_retries: int = 3) -> dict:
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            resp = requests.get(LTA_URL, params={"loc": f"{lat},{lng}"}, timeout=45)
            resp.raise_for_status()
            payload = resp.json()
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < max_retries - 1:
                time.sleep(2**attempt)
    else:
        raise RuntimeError(f"Atlas LTA fetch failed for {lat},{lng}: {last_err}")

    annual = payload["annual"]["data"]
    monthly = payload["monthly"]["data"]
    layer_meta = payload["annual"]["metadata"]["layers"]
    return {
        "loc": {"lat": lat, "lng": lng},
        "ghi_kwh_m2": annual["GHI"],
        "pvout_kwh_kwp": annual["PVOUT_csi"],
        "dni_kwh_m2": annual["DNI"],
        "dif_kwh_m2": annual["DIF"],
        "gti_kwh_m2": annual["GTI_opta"],
        "temp_c": annual["TEMP"],
        "opta_deg": annual["OPTA"],
        "elevation_m": annual["ELE"],
        "monthly_ghi_kwh_m2": monthly["GHI"],
        "monthly_pvout_kwh_kwp": monthly["PVOUT_csi"],
        "layers": {k: layer_meta.get(k) for k in LAYERS},
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
