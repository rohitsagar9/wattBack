"""WattBack loss engine: expected vs actual generation, decomposed.

Sequential hourly chain (every step closes exactly):

    expected (clean DC at STC, corrected irradiance)
      - aoi       IAM on beam (pvlib physical model)
      - temp      SAPM cell temperature vs 25 C counterfactual
      - soiling   HSU model, tiered rain wash (drizzle <1mm does not clean,
                  1-10mm partial, >10mm full reset) + PM2.5/PM10 deposition
      - dc_cable  I^2R, temperature-corrected resistivity
      - inv_conv  nominal inverter efficiency
      - clip      hour-level clamp at AC rating
      - ac_cable  I^2R
    = predicted
      - avail     measured downtime (actual collapses, model healthy)
      - missing   no measurement for that day
      - unexplained (residual; fit target < 1% of expected)

Two global calibration parameters (clear/cloudy irradiance bias factors)
are fitted once per window with downtime days excluded -- never per-day.
"""

from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd
from scipy.special import erf

import pvlib
from pvlib.iam import physical as iam_physical
from pvlib.irradiance import aoi as pvlib_aoi, get_extra_radiation, get_total_irradiance
from pvlib.location import Location
from pvlib.temperature import TEMPERATURE_MODEL_PARAMETERS, sapm_cell

from wattback.config import RAW_DIR, site
from wattback.ingest.weather import fetch_cams_pm, fetch_era5_hourly

LOSS_COLS = ["aoi", "temp", "soiling", "dc_cable", "inv_conv", "clip", "ac_cable"]

CLEAR_KT_THRESHOLD = 0.65
AVAIL_RATIO = 0.25
FACTOR_BOUNDS = (0.5, 2.0)
SPIN_UP_DAYS = 45

TEMP_PARAMS = TEMPERATURE_MODEL_PARAMETERS["sapm"]["open_rack_glass_glass"]
RESISTIVITY = {"cu": 0.017241, "al": 0.0282}
TEMP_COEF_R = {"cu": 0.00393, "al": 0.00403}
DEPO_VELOC = {"2_5": 0.002, "10": 0.008}
# Tiered rain wash (field insight): a drizzle (<1 mm) does NOT clean -- it can
# smear dust into mud spots; 1-10 mm gives a partial wash (~30% of the
# accumulated mass removed); >10 mm fully resets the panel.
RAIN_PARTIAL_MIN_MM = 1.0
RAIN_PARTIAL_MAX_MM = 10.0
PARTIAL_WASH_FRAC = 0.30


def _load_actuals(key: str, start: str, end: str) -> pd.DataFrame:
    df = pd.read_csv(RAW_DIR / f"{key}_daily.csv", parse_dates=["date"])
    df = df[(df["date"] >= start) & (df["date"] <= end)]
    return df.set_index("date").sort_index()


def _fetch_hourly(cfg: dict, start: str, end: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    wx_start = (pd.Timestamp(start) - timedelta(days=SPIN_UP_DAYS)).date()
    wx_end = min(pd.Timestamp(end).date(), pd.Timestamp.utcnow().date() - timedelta(days=1))
    wx = fetch_era5_hourly(cfg["lat"], cfg["lng"], wx_start, wx_end)
    pm = fetch_cams_pm(cfg["lat"], cfg["lng"], wx_start, wx_end)
    wx["time"] = pd.to_datetime(wx["time"])
    pm["time"] = pd.to_datetime(pm["time"])
    m = wx.merge(pm, on="time", how="left")
    m = m.set_index("time")
    m["pm2_5"] = m["pm2_5"].ffill().bfill().fillna(5.0)
    m["pm10"] = m["pm10"].ffill().bfill().fillna(15.0)
    return m


def _geometry(wx: pd.DataFrame, cfg: dict) -> dict:
    loc = Location(cfg["lat"], cfg["lng"], tz=cfg.get("tz", "Asia/Kolkata"), altitude=0)
    sp = loc.get_solarposition(wx.index)
    aoi_arr = pvlib_aoi(cfg["tilt_deg"], cfg["azimuth_deg"],
                        sp["apparent_zenith"], sp["azimuth"])
    iam = np.clip(np.asarray(iam_physical(aoi_arr), dtype=float), 0.0, 1.0)
    return {"sp": sp, "iam": iam, "loc": loc,
            "dni_extra": get_extra_radiation(wx.index)}


def _run_chain(wx: pd.DataFrame, sr: pd.Series, cfg: dict, geom: dict,
               day_factor: pd.Series | None) -> pd.DataFrame:
    w = wx.copy()
    if day_factor is not None:
        days = w.index.normalize()
        f = day_factor.reindex(days).fillna(1.0).to_numpy()
        for c in ("ghi_wm2", "dni_wm2", "dhi_wm2"):
            w[c] = w[c].to_numpy() * f

    poa = get_total_irradiance(
        cfg["tilt_deg"], cfg["azimuth_deg"],
        geom["sp"]["apparent_zenith"], geom["sp"]["azimuth"],
        w["dni_wm2"], w["ghi_wm2"], w["dhi_wm2"],
        dni_extra=geom["dni_extra"], model="isotropic")
    poa_dir = poa["poa_direct"].clip(lower=0).to_numpy()
    poa_dif = poa["poa_diffuse"].clip(lower=0).to_numpy()
    poa_tot = poa_dir + poa_dif
    lit = poa_tot > 1e-6

    pdc0 = cfg["kwp_dc"] * 1000.0
    gamma = cfg["gamma_pdc"]
    eta = cfg["eta_inv_nom"]
    pac0 = cfg["ac_kw"] * 1000.0

    # 0. clean expected (DC at STC reference)
    e0 = np.where(lit, poa_tot / 1000.0 * pdc0, 0.0)

    # 1. AOI / optical
    iam_eff = np.where(lit,
                       (poa_dir * geom["iam"] + poa_dif) / np.maximum(poa_tot, 1e-9),
                       1.0)
    e1 = e0 * iam_eff

    # 2. temperature
    tcell = sapm_cell(poa_tot, w["temp_air_c"].ffill().fillna(0).to_numpy(),
                      w["wind_ms"].fillna(0).to_numpy(),
                      TEMP_PARAMS["a"], TEMP_PARAMS["b"], TEMP_PARAMS["deltaT"])
    temp_f = np.where(lit, np.clip(1.0 + gamma * (np.asarray(tcell) - 25.0), 0.0, None), 1.0)
    e2 = e1 * temp_f

    # 3. soiling
    soil_f = sr.reindex(w.index).ffill().fillna(1.0).to_numpy()
    e3 = e2 * soil_f

    # 4. DC cable I^2R
    cab = cfg["dc_cable"]
    rho = (RESISTIVITY[cab["material"]]
           * (1 + TEMP_COEF_R[cab["material"]] * (cab["temp_c"] - 20)))
    r_dc = 2.0 * cab["length_m"] * rho / cab["area_mm2"]
    n_mod = max(1, round(cfg["kwp_dc"] * 1000 / cfg["module_w"]))
    n_str = max(1, int(np.ceil(n_mod / cfg["modules_per_string"])))
    v_str = cfg["modules_per_string"] * cfg["vmp_string"]
    i_str = e3 / (n_str * v_str)
    e4 = np.maximum(e3 - n_str * i_str ** 2 * r_dc, 0.0)

    # 5. inverter conversion
    e5 = e4 * eta

    # 6. clipping
    e6 = np.minimum(e5, pac0)

    # 7. AC cable I^2R
    cab = cfg["ac_cable"]
    rho = (RESISTIVITY[cab["material"]]
           * (1 + TEMP_COEF_R[cab["material"]] * (cab["temp_c"] - 20)))
    r_ac = cab["length_m"] * rho / cab["area_mm2"]
    if cab["phases"] == 3:
        i_ac = e6 / (np.sqrt(3) * cab["v_ll"] * cab["pf"])
        p_ac = 3.0 * i_ac ** 2 * r_ac
    else:
        i_ac = e6 / (cab["v_ll"] * cab["pf"])
        p_ac = 2.0 * i_ac ** 2 * r_ac
    e7 = np.maximum(e6 - p_ac, 0.0)

    k = 1.0 / 1000.0
    days = pd.DatetimeIndex(w.index.normalize())
    daily = pd.DataFrame({
        "expected": e0 * k,
        "aoi": (e0 - e1) * k,
        "temp": (e1 - e2) * k,
        "soiling": (e2 - e3) * k,
        "dc_cable": (e3 - e4) * k,
        "inv_conv": (e4 - e5) * k,
        "clip": (e5 - e6) * k,
        "ac_cable": (e6 - e7) * k,
        "predicted": e7 * k,
    }, index=days)
    return daily.groupby(level=0).sum()


def _daily_kt(wx: pd.DataFrame, geom: dict) -> pd.Series:
    cs = geom["loc"].get_clearsky(wx.index)
    per_hour = pd.DataFrame({
        "day": wx.index.normalize(),
        "ghi": wx["ghi_wm2"].fillna(0),
        "cs": cs["ghi"].fillna(0),
    })
    agg = per_hour.groupby("day").sum()
    kt = (agg["ghi"] / agg["cs"].replace(0, np.nan)).fillna(0.0)
    return kt


def _fit_factors(daily: pd.DataFrame, actual: pd.Series, seg: pd.Series,
                 excluded: set) -> dict:
    factors = {}
    for s in ("clear", "cloudy"):
        sp_ = sa_ = 0.0
        for d in seg[seg == s].index:
            if d in excluded or d not in daily.index:
                continue
            p = daily.loc[d, "predicted"]
            a = actual.get(d, np.nan)
            if p > 0 and not pd.isna(a) and a > 0:
                sp_ += p
                sa_ += a
        if sp_ > 0 and sa_ > 0:
            factors[s] = float(np.clip(sa_ / sp_, *FACTOR_BOUNDS))
        else:
            factors[s] = 1.0
    return factors


def _hsu_tiered(rainfall: pd.Series, surface_tilt: float,
                pm2_5: np.ndarray, pm10: np.ndarray) -> pd.Series:
    """HSU soiling model with tiered rain wash (see RAIN_* constants).

    Same deposition physics as pvlib.soiling.hsu, but rainfall cleans in
    three tiers instead of one binary threshold:
        rain < 1 mm            -> no cleaning (drizzle smears, not washes)
        1 mm <= rain <= 10 mm  -> partial wash: 30% of accumulated mass removed
        rain > 10 mm           -> full reset (panel considered clean)
    """
    dt = rainfall.index
    dt_diff = (dt[1:] - dt[:-1]).total_seconds()
    dt_sec = np.append(dt_diff[0], dt_diff).astype("float64")
    horiz = (pm2_5 * DEPO_VELOC["2_5"]
             + np.maximum(pm10 - pm2_5, 0.0) * DEPO_VELOC["10"]) * dt_sec
    tilted = horiz * pvlib.tools.cosd(surface_tilt)
    mass = np.cumsum(tilted)
    mass_s = pd.Series(mass, index=dt)

    rain = rainfall.fillna(0.0)
    full_ev = rain.index[rain > RAIN_PARTIAL_MAX_MM]
    part_ev = rain.index[(rain >= RAIN_PARTIAL_MIN_MM)
                         & (rain <= RAIN_PARTIAL_MAX_MM)]
    events = sorted([(t, "full") for t in full_ev]
                    + [(t, "part") for t in part_ev])
    removed, marks = 0.0, []
    for t, kind in events:
        m = float(mass_s.loc[t])
        if kind == "full":
            removed = m
        else:
            removed = PARTIAL_WASH_FRAC * m + (1 - PARTIAL_WASH_FRAC) * removed
        marks.append((t, removed))
    if marks:
        rem = pd.Series([m[1] for m in marks], index=[m[0] for m in marks])
        removed_s = rem.reindex(dt).ffill().fillna(0.0)
    else:
        removed_s = pd.Series(0.0, index=dt)
    accum = np.clip(mass_s.to_numpy() - removed_s.to_numpy(), 0.0, None)
    return pd.Series(1 - 0.3437 * erf(0.17 * accum ** 0.8473), index=dt)


def _soiling_series(wx: pd.DataFrame, cfg: dict) -> pd.Series:
    sr = _hsu_tiered(
        rainfall=wx["precip_mm"].fillna(0),
        surface_tilt=cfg["tilt_deg"],
        pm2_5=wx["pm2_5"].to_numpy() * 1e-6,
        pm10=wx["pm10"].to_numpy() * 1e-6,
    )
    return sr.fillna(1.0)


def run_engine(key: str, start: str, end: str) -> tuple[pd.DataFrame, dict]:
    """Run the full chain for `key` over [start, end] (ISO dates).

    Returns (daily frame, meta) where daily has one row per calendar day.
    """
    cfg = site(key)
    wx_all = _fetch_hourly(cfg, start, end)
    sr_all = _soiling_series(wx_all, cfg)

    wx = wx_all[wx_all.index.normalize() >= pd.Timestamp(start)]
    wx = wx[wx.index.normalize() <= pd.Timestamp(end)]
    sr = sr_all.reindex(wx.index)
    geom = _geometry(wx, cfg)

    actual_df = _load_actuals(key, start, end)
    actual = actual_df["generated_kwh"]

    raw_daily = _run_chain(wx, sr, cfg, geom, None)
    kt = _daily_kt(wx, geom)
    seg = pd.Series(np.where(kt.reindex(raw_daily.index).fillna(0)
                             >= CLEAR_KT_THRESHOLD, "clear", "cloudy"),
                    index=raw_daily.index)

    a = actual.reindex(raw_daily.index)
    ratio0 = np.where(raw_daily["predicted"] > 0,
                      a / raw_daily["predicted"].replace(0, np.nan), np.nan)
    excluded = set(a[a.isna()].index) | set(
        raw_daily.index[(ratio0 < AVAIL_RATIO)
                        & (raw_daily["predicted"] > 0.1 * cfg["kwp_dc"])])

    factors = _fit_factors(raw_daily, actual, seg, excluded)
    day_factor = pd.Series({d: factors[s] for d, s in seg.items()})

    daily = _run_chain(wx, sr, cfg, geom, day_factor)
    daily["segment"] = seg
    daily["factor"] = day_factor

    a = actual.reindex(daily.index)
    has = a.notna()
    a0 = a.fillna(0.0)
    pred = daily["predicted"]
    ratio = np.where(pred > 0, a0 / pred.replace(0, np.nan), np.nan)
    down = has.to_numpy() & (ratio < AVAIL_RATIO) & (pred > 0.1 * cfg["kwp_dc"]).to_numpy()
    missing = (~has).to_numpy()

    daily["actual"] = a0
    daily["has_actual"] = has
    daily["avail"] = np.where(down, np.maximum(pred - a0, 0.0), 0.0)
    daily["missing"] = np.where(missing, pred, 0.0)
    daily["unexplained"] = pred - a0 - daily["avail"] - daily["missing"]

    totals = _totals(daily)
    meta = {
        "site": key,
        "name": cfg["name"],
        "start": str(pd.Timestamp(daily.index.min()).date()),
        "end": str(pd.Timestamp(daily.index.max()).date()),
        "n_days": len(daily),
        "factors": factors,
        "n_downtime": int(down.sum()),
        "totals": totals,
        "soiling_end": float(sr.dropna().iloc[-1]) if len(sr.dropna()) else 1.0,
    }
    return daily, meta


def _totals(daily: pd.DataFrame) -> dict:
    t = {c: float(daily[c].sum()) for c in
         ["expected", *LOSS_COLS, "predicted", "actual", "avail",
          "missing", "unexplained"]}
    return t


def report(meta: dict) -> str:
    t = meta["totals"]
    lines = []
    lines.append("=" * 88)
    lines.append(f" WattBack loss report -- {meta['name']}  "
                 f"({meta['start']} .. {meta['end']}, {meta['n_days']} days)")
    lines.append("=" * 88)
    lines.append(f" factors: clear x{meta['factors']['clear']:.3f}  "
                 f"cloudy x{meta['factors']['cloudy']:.3f}  "
                 f"downtime days: {meta['n_downtime']}")
    lines.append(f" {'component':26s} {'kWh':>12s} {'% expected':>11s}")
    lines.append("-" * 88)
    lines.append(f" {'Expected (clean model)':26s} {t['expected']:12.1f} {'100.00':>11s}")
    for c in LOSS_COLS:
        pct = 100 * t[c] / t["expected"] if t["expected"] else 0.0
        lines.append(f"  - {c:23s} {t[c]:12.2f} {pct:11.2f}")
    lines.append("-" * 88)
    lines.append(f" {'Predicted':26s} {t['predicted']:12.1f}")
    for c in ("avail", "missing", "unexplained"):
        pct = 100 * t[c] / t["expected"] if t["expected"] else 0.0
        lines.append(f"  - {c:23s} {t[c]:12.2f} {pct:11.2f}")
    lines.append("-" * 88)
    lines.append(f" {'Actual (measured)':26s} {t['actual']:12.1f}")
    close = (t["predicted"] - t["avail"] - t["missing"] - t["unexplained"]
             - t["actual"])
    ue = 100 * abs(t["unexplained"]) / t["expected"] if t["expected"] else 0.0
    lines.append(f" closure: {close:+.6f} kWh | unexplained: {ue:.2f}% of expected")
    lines.append("=" * 88)
    return "\n".join(lines)
