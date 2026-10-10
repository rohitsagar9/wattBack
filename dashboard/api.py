"""Machine-readable JSON API under /api/v1/."""

import json
from datetime import date, timedelta
from functools import lru_cache

import pandas as pd
from django.http import JsonResponse
from django.shortcuts import get_object_or_404

from wattback.loss.counterfactual import cleaning_counterfactual
from wattback.loss.engine import (LOSS_COLS, PARTIAL_WASH_FRAC,
                                  RAIN_PARTIAL_MAX_MM, RAIN_PARTIAL_MIN_MM,
                                  run_engine)

from .models import DailyRecord, LossRecord, OutageAlert, RunMeta, Site
from .views import IMPACT, ORACLE_END, ORACLE_START


def _site(request) -> Site:
    key = request.GET.get("site", "bmt")
    return get_object_or_404(Site, key=key)


def sites(request):
    out = []
    for s in Site.objects.order_by("key"):
        recs = DailyRecord.objects.filter(site=s)
        n = recs.count()
        rm = RunMeta.objects.filter(site=s).first()
        out.append({
            "key": s.key, "name": s.name, "kwp_dc": s.kwp_dc, "ac_kw": s.ac_kw,
            "lat": s.lat, "lng": s.lng, "tilt_deg": s.tilt_deg,
            "role": s.role, "n_days": n,
            "total_kwh": round(sum(r.generated_kwh for r in recs), 1)
            if n else 0,
            "first": recs.order_by("date").first().date.isoformat() if n else None,
            "last": recs.order_by("-date").first().date.isoformat() if n else None,
            "soiling_ratio": rm.soiling_ratio if rm else None,
        })
    return JsonResponse({"sites": out})


def daily(request):
    s = _site(request)
    qs = DailyRecord.objects.filter(site=s)
    if start := request.GET.get("start"):
        qs = qs.filter(date__gte=start)
    if end := request.GET.get("end"):
        qs = qs.filter(date__lte=end)
    rows = list(qs.order_by("date").values(
        "date", "generated_kwh", "peak_kw", "flags",
        "ghi_kwh_m2", "tmean_c", "precip_mm"))
    for r in rows:
        r["date"] = r["date"].isoformat()
    return JsonResponse({"site": s.key, "count": len(rows), "days": rows})


@lru_cache(maxsize=16)
def _engine_result(key: str, start: str, end: str):
    daily, meta = run_engine(key, start, end)
    rows = []
    for d, r in daily.iterrows():
        rows.append({
            "date": d.date().isoformat(),
            "segment": str(r.get("segment", "")),
            "expected": round(float(r["expected"]), 3),
            **{c: round(float(r[c]), 3) for c in LOSS_COLS},
            "predicted": round(float(r["predicted"]), 3),
            "actual": round(float(r["actual"]), 3),
            "avail": round(float(r["avail"]), 3),
            "missing": round(float(r["missing"]), 3),
            "unexplained": round(float(r["unexplained"]), 3),
        })
    t = meta["totals"]
    totals = {k: round(v, 3) for k, v in t.items()}
    return rows, totals, meta["factors"], meta["soiling_end"]


def loss(request):
    s = _site(request)
    start = request.GET.get("start", ORACLE_START)
    end = request.GET.get("end", ORACLE_END)
    rm = RunMeta.objects.filter(site=s).first()
    if rm and rm.start_date.isoformat() == start and rm.end_date.isoformat() == end:
        rows = list(LossRecord.objects.filter(site=s).order_by("date").values())
        for r in rows:
            r["date"] = r["date"].isoformat()
            r.pop("id", None)
            r.pop("site_id", None)
        totals = dict(rm.totals_json)
        factors = rm.factors_json
        source = "database"
    else:
        try:
            rows, totals, factors, _ = _engine_result(s.key, start, end)
        except RuntimeError as exc:
            return JsonResponse({"error": str(exc)}, status=502)
        source = "engine-live"
    exp = totals.get("expected") or 0
    pct = {c: round(100 * totals.get(c, 0) / exp, 3) for c in LOSS_COLS} if exp else {}
    return JsonResponse({
        "site": s.key, "start": start, "end": end, "source": source,
        "factors": factors, "totals": totals, "loss_pct_of_expected": pct,
        "unexplained_pct": round(100 * abs(totals.get("unexplained", 0)) / exp, 3)
        if exp else None,
        "days": rows,
    })


def outages(request):
    qs = OutageAlert.objects.select_related("site").order_by("-start_date")
    if key := request.GET.get("site"):
        qs = qs.filter(site__key=key)
    return JsonResponse({"alerts": [{
        "site": a.site.key, "start": a.start_date.isoformat(),
        "end": a.end_date.isoformat(), "days": a.days,
        "est_lost_kwh": a.est_lost_kwh,
        "est_lost_inr": round(a.est_lost_kwh * IMPACT["inr_per_kwh"]),
        "published": a.published_at is not None,
    } for a in qs]})


def cleaning(request):
    s = _site(request)
    rm = RunMeta.objects.filter(site=s).first()
    start = request.GET.get("start")
    end = request.GET.get("end")
    if rm and (start is None or end is None):
        start = start or rm.start_date.isoformat()
        end = end or rm.end_date.isoformat()
        per_day = (rm.totals_json or {}).get("predicted", 0) / max(rm.n_days, 1)
        sr = rm.soiling_ratio
    else:
        start = start or ORACLE_START
        end = end or ORACLE_END
        try:
            rows, totals, _, sr = _engine_result(s.key, start, end)
        except RuntimeError as exc:
            return JsonResponse({"error": str(exc)}, status=502)
        per_day = totals["predicted"] / max(len(rows), 1)
    cf = cleaning_counterfactual(s.key, end, per_day, sr)
    return JsonResponse(cf)


def impact(request):
    return JsonResponse(IMPACT)


def _sunpath(lat: float, lng: float, tzname: str, day=None) -> dict:
    """96-point sun path for `day` (naive date/ISO); today when day is None."""
    try:
        from zoneinfo import ZoneInfo

        from pvlib.solarposition import get_solarposition

        tz = ZoneInfo(tzname or "UTC")
        now = pd.Timestamp.now(tz)
        base = pd.Timestamp(day, tz=tz) if day else now
        times = pd.date_range(base.normalize(), periods=96, freq="15min", tz=tz)
        sp = get_solarposition(times, lat, lng, altitude=0)
        pts = [{"az": round(float(a), 1), "el": round(float(e), 1),
                "hh": round(i * 0.25, 2)}
               for i, (a, e) in enumerate(
                   zip(sp["azimuth"], sp["elevation"]))]
        now_field = None
        if base.date() == now.date():
            now_sp = get_solarposition(pd.DatetimeIndex([now]), lat, lng,
                                       altitude=0)
            now_field = {"az": round(float(now_sp["azimuth"].iloc[0]), 1),
                         "el": round(float(now_sp["elevation"].iloc[0]), 1)}
        return {
            "date": base.date().isoformat(), "tz": tzname or "UTC",
            "points": pts,
            "now": now_field,
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def extract(request):
    """Onboarding extraction: ERA5 recent stats + Atlas LTA + PVGIS baseline
    + terrain horizon + sun path for an arbitrary point."""
    try:
        lat = float(request.GET["lat"])
        lng = float(request.GET["lon"])
    except (KeyError, ValueError, TypeError):
        return JsonResponse({"error": "lat and lon are required"}, status=400)
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return JsonResponse({"error": "lat/lon out of range"}, status=400)
    tilt = float(request.GET.get("tilt") or round(abs(lat)))
    az = float(request.GET.get("az") or 180)
    kwp = float(request.GET.get("kwp") or 1)
    out: dict = {"lat": lat, "lon": lng, "tilt": tilt, "az": az,
                 "kwp": kwp, "timezone": "UTC", "sources": {}}

    try:
        from datetime import date, timedelta

        from wattback.ingest.weather import fetch_era5_daily
        end = date.today() - timedelta(days=1)
        df = fetch_era5_daily(lat, lng, end - timedelta(days=60), end)
        out["timezone"] = df.attrs.get("timezone") or "UTC"
        out["recent60"] = {
            "mean_ghi": round(float(df["ghi_kwh_m2"].mean()), 2),
            "rain_days": int((df["precip_mm"] >= 1).sum()),
            "rain_mm": round(float(df["precip_mm"].sum()), 1),
            "tmean_c": round(float(df["tmean_c"].mean()), 1),
            "tmax_c": round(float(df["tmax_c"].max()), 1),
        }
        out["sources"]["era5"] = "ok"
    except Exception as exc:  # noqa: BLE001
        out["sources"]["era5"] = f"failed: {exc}"

    try:
        from wattback.ingest.atlas import fetch_lta
        lta = fetch_lta(lat, lng)
        out["atlas"] = {k: lta[k] for k in
                        ("ghi_kwh_m2", "pvout_kwh_kwp", "opta_deg", "temp_c")}
        out["sources"]["atlas"] = "ok"
    except Exception as exc:  # noqa: BLE001
        out["sources"]["atlas"] = f"failed: {exc}"

    try:
        from wattback.ingest.pvgis import pvgis_baseline
        out["pvgis"] = pvgis_baseline(lat, lng, tilt, az, kwp)
        out["sources"]["pvgis"] = ("ok" if "error" not in out["pvgis"]
                                   else out["pvgis"]["error"])
    except Exception as exc:  # noqa: BLE001
        out["sources"]["pvgis"] = f"failed: {exc}"
        out["pvgis"] = {"error": str(exc)}

    try:
        from wattback.ingest.pvgis import horizon_profile
        out["horizon"] = horizon_profile(lat, lng)
        out["sources"]["horizon"] = "ok" if out["horizon"] else "unavailable"
    except Exception as exc:  # noqa: BLE001
        out["horizon"] = None
        out["sources"]["horizon"] = f"failed: {exc}"

    out["sunpath"] = _sunpath(lat, lng, out["timezone"])
    return JsonResponse(out)


# ---- Digital Twin -------------------------------------------------------

DRY_DAY_ACCUM = 0.0025   # visual soil deficit added per rain-free day (approx)
SOIL_CAP = 0.25          # visual soil deficit ceiling for scene rendering
SCENE_PR = 0.80          # typical rooftop PR for the no-rain ₹ scenario


def _f(v, nd: int = 1):
    if v is None or pd.isna(v):
        return None
    return round(float(v), nd)


@lru_cache(maxsize=16)
def _weather_frame(lat: float, lng: float, year: int) -> pd.DataFrame:
    """Daily ERA5 covering `year` plus a carry-in for the 7-day state walk."""
    from wattback.ingest.weather import fetch_era5_daily
    df = fetch_era5_daily(lat, lng, date(year - 1, 11, 1), date(year, 12, 31))
    df["date"] = pd.to_datetime(df["date"])
    return df


def _twin_state(df: pd.DataFrame | None, day_iso: str) -> dict | None:
    """Weather-driven state machine for the Twin scene.

    Wash thresholds mirror the engine's tiered rain wash (engine.py RAIN_*);
    visual_soil is a lightweight approximation for rendering only — the
    dashboard counters stay engine-true.
    """
    if df is None or df.empty:
        return None
    day = pd.Timestamp(day_iso)
    past = df[df["date"] <= day]
    if past.empty:
        return None
    cur = past.iloc[-1]
    win = past[past["date"] > day - pd.Timedelta(days=7)]
    rain_7d = float(win["precip_mm"].fillna(0).sum())
    wash = past[past["precip_mm"].fillna(0) >= RAIN_PARTIAL_MIN_MM]
    if len(wash):
        last_rain = wash.iloc[-1]["date"]
        days_since = int((day - last_rain).days)
        last_rain_iso = last_rain.date().isoformat()
    else:
        last_rain_iso, days_since = None, 999
    deficit = 0.0
    dry = past[past["date"] > day - pd.Timedelta(days=60)]
    for p in dry["precip_mm"].fillna(0.0).astype(float):
        if p > RAIN_PARTIAL_MAX_MM:
            deficit = 0.0
        elif p >= RAIN_PARTIAL_MIN_MM:
            deficit *= (1 - PARTIAL_WASH_FRAC)
        else:
            deficit = min(SOIL_CAP, deficit + DRY_DAY_ACCUM)
    tmax = _f(cur["tmax_c"])
    cloud = _f(cur["cloud_pct"], 0)
    precip = _f(cur["precip_mm"]) or 0.0
    derate = round(max(0.0, ((tmax or 0) - 25.0) * 0.4), 1)
    if rain_7d >= RAIN_PARTIAL_MIN_MM:
        mode = "rain_clean"
    elif cloud is not None and cloud >= 70:
        mode = "cloudy"
    elif tmax is not None and tmax >= 38:
        mode = "hot"
    elif days_since >= 10 or deficit >= 0.05:
        mode = "dusty"
    else:
        mode = "normal"
    return {
        "date": str(cur["date"].date()),
        "ghi": _f(cur["ghi_kwh_m2"], 2), "tmax": tmax, "cloud": cloud,
        "precip": precip,
        "rain_7d": round(rain_7d, 1),
        "days_since_rain": days_since,
        "last_rain": last_rain_iso,
        "visual_soil": round(deficit, 3),
        "derate_pct": derate,
        "mode": mode,
        "wash_today": precip >= RAIN_PARTIAL_MIN_MM,
    }


def _sim6m_run(wx: pd.DataFrame, pm: pd.DataFrame, tilt: float,
               kwp: float, end_iso: str) -> dict:
    """6-month no-rain scenario: real HSU deposition + tiered-wash machinery
    with precipitation zeroed — 'what if the monsoon never came'."""
    from wattback.loss.engine import _soiling_series
    a, b = wx.copy(), pm.copy()
    a["time"] = pd.to_datetime(a["time"])
    b["time"] = pd.to_datetime(b["time"])
    m = a.merge(b, on="time", how="left").set_index("time").sort_index()
    m["pm2_5"] = m["pm2_5"].ffill().bfill().fillna(5.0)
    m["pm10"] = m["pm10"].ffill().bfill().fillna(15.0)
    m["precip_mm"] = 0.0                       # the experiment: no rain
    sr = _soiling_series(m, {"tilt_deg": tilt})
    daily = pd.DataFrame({
        "ghi": m["ghi_wm2"].groupby(m.index.normalize()).sum() / 1000.0,
        "sr": sr.groupby(sr.index.normalize()).last(),
    }).dropna()
    if daily.empty:
        return {"scenario": "no rain for 6 months", "months": [],
                "start": None, "end": end_iso, "pr_assumed": SCENE_PR,
                "final_soil": None, "total_kwh": 0, "total_inr": 0}
    daily["lost"] = daily["ghi"] * kwp * SCENE_PR * (1 - daily["sr"])
    daily["cum"] = daily["lost"].cumsum()
    inr = IMPACT["inr_per_kwh"]
    months = []
    for period, grp in daily.groupby(daily.index.to_period("M")):
        cum = float(grp["cum"].iloc[-1])
        months.append({
            "month": str(period),
            "soil": round(float(grp["sr"].iloc[-1]), 4),
            "cum_kwh": round(cum, 1),
            "cum_inr": round(cum * inr, 0),
        })
    total_kwh = float(daily["cum"].iloc[-1])
    return {
        "scenario": "no rain for 6 months (HSU deposition, wash disabled)",
        "start": daily.index.min().date().isoformat(),
        "end": end_iso,
        "pr_assumed": SCENE_PR,
        "months": months,
        "final_soil": round(float(daily["sr"].iloc[-1]), 4),
        "total_kwh": round(total_kwh, 1),
        "total_inr": round(total_kwh * inr, 0),
    }


@lru_cache(maxsize=8)
def _twin_sim6m(lat: float, lng: float, tilt: float, kwp: float,
                end_iso: str) -> dict:
    from wattback.ingest.weather import fetch_cams_pm, fetch_era5_hourly
    end = date.fromisoformat(end_iso)
    start = end - timedelta(days=183)
    wx = fetch_era5_hourly(lat, lng, start, end)
    pm = fetch_cams_pm(lat, lng, start, end)
    return _sim6m_run(wx, pm, tilt, kwp, end_iso)


def twin(request):
    """Digital Twin scene data: sun path for any date, full-year daily
    weather, 7-day state machine, terrain horizon, and a 6-month no-rain
    soiling scenario run through the real engine chain."""
    key = request.GET.get("site")
    if key:
        s = get_object_or_404(Site, key=key)
        lat, lng = float(s.lat), float(s.lng)
        tilt = float(s.tilt_deg or round(abs(s.lat)))
        az = float(s.azimuth_deg or 180)
        kwp = float(s.kwp_dc or 1)
    else:
        try:
            lat = float(request.GET["lat"])
            lng = float(request.GET["lon"])
        except (KeyError, ValueError, TypeError):
            return JsonResponse(
                {"error": "lat and lon are required (or site=key)"},
                status=400)
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return JsonResponse({"error": "lat/lon out of range"}, status=400)
        tilt = float(request.GET.get("tilt") or round(abs(lat)))
        az = float(request.GET.get("az") or 180)
        kwp = float(request.GET.get("kwp") or 1)
    day_iso = request.GET.get("date") or date.today().isoformat()
    try:
        day = date.fromisoformat(day_iso)
    except ValueError:
        return JsonResponse({"error": "date must be YYYY-MM-DD"}, status=400)
    try:
        year = int(request.GET.get("year") or day.year)
    except ValueError:
        return JsonResponse({"error": "year must be an integer"}, status=400)
    out = {"lat": lat, "lon": lng, "tilt": tilt, "az": az, "kwp": kwp,
           "date": day_iso, "year": year, "timezone": "UTC", "sources": {}}
    tzname, frame = "UTC", None
    try:
        frame = _weather_frame(lat, lng, year)
        if frame.attrs.get("timezone"):
            tzname = frame.attrs["timezone"]
        out["timezone"] = tzname
        rows = frame[frame["date"].dt.year == year]
        out["weather_year"] = [
            {"d": str(r["date"].date()), "ghi": _f(r["ghi_kwh_m2"], 2),
             "tmax": _f(r["tmax_c"]), "cloud": _f(r["cloud_pct"], 0),
             "precip": _f(r["precip_mm"]) or 0.0}
            for _, r in rows.iterrows()]
        out["state"] = _twin_state(frame, day_iso)
        out["sources"]["era5"] = "ok"
    except Exception as exc:  # noqa: BLE001
        out["sources"]["era5"] = f"failed: {exc}"
        out["weather_year"] = []
        out["state"] = None
    out["sunpath"] = _sunpath(lat, lng, tzname, day=day_iso)
    try:
        from wattback.ingest.pvgis import horizon_profile
        out["horizon"] = horizon_profile(lat, lng)
        out["sources"]["horizon"] = ("ok" if out["horizon"]
                                     else "unavailable")
    except Exception as exc:  # noqa: BLE001
        out["horizon"] = None
        out["sources"]["horizon"] = f"failed: {exc}"
    try:
        out["sim6m"] = _twin_sim6m(lat, lng, tilt, kwp, day_iso)
        out["sources"]["sim6m"] = "ok"
    except Exception as exc:  # noqa: BLE001
        out["sim6m"] = {"error": f"{type(exc).__name__}: {exc}"}
        out["sources"]["sim6m"] = f"failed: {exc}"
    out["consts"] = {
        "rain_partial_min_mm": RAIN_PARTIAL_MIN_MM,
        "rain_full_mm": RAIN_PARTIAL_MAX_MM,
        "partial_wash_frac": PARTIAL_WASH_FRAC,
        "dry_day_accum": DRY_DAY_ACCUM,
        "soil_cap": SOIL_CAP,
        "gamma_pdc_per_c": -0.4,
        "t_ref_c": 25,
        "hot_tmax_c": 38,
        "cloudy_pct": 70,
        "dusty_days": 10,
        "inr_per_kwh": IMPACT["inr_per_kwh"],
        "pr_scene": SCENE_PR,
    }
    return JsonResponse(out)
