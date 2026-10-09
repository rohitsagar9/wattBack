import json
from datetime import date as date_cls, timedelta

from django.db.models import Sum
from django.shortcuts import get_object_or_404, render
from django.utils.text import slugify

from wattback.loss.counterfactual import cleaning_counterfactual

from . import storage
from .models import CleaningEvent, DailyRecord, LossRecord, OutageAlert, RunMeta, Site

ORACLE_START = "2026-09-01"
ORACLE_END = "2026-09-29"
LOSS_COLS = ["aoi", "temp", "soiling", "dc_cable", "inv_conv", "clip", "ac_cable"]

PARKS = [
    {"key": "bmt", "name": "BMT Punjab · 56.6 kWp demo system",
     "lat": 31.63, "lng": 74.82, "tilt": 5, "az": 180, "kwp": 56.6, "ac": 55.0,
     "seeded": True},
    {"key": "manalil", "name": "Manalil Veedu · 3.09 kWp home demo",
     "lat": 8.95, "lng": 76.92, "tilt": 17, "az": 0, "kwp": 3.09, "ac": 3.0,
     "seeded": True},
    {"key": "bhadla", "name": "Bhadla Solar Park, Rajasthan",
     "lat": 27.54, "lng": 71.91, "tilt": 27, "az": 180, "kwp": 1000, "ac": 1000},
    {"key": "pavagada", "name": "Pavagada Solar Park, Karnataka",
     "lat": 14.27, "lng": 77.35, "tilt": 14, "az": 180, "kwp": 1000, "ac": 1000},
    {"key": "charanka", "name": "Charanka Solar Park, Gujarat",
     "lat": 23.75, "lng": 71.10, "tilt": 24, "az": 180, "kwp": 1000, "ac": 1000},
    {"key": "rewa", "name": "Rewa Solar, Madhya Pradesh",
     "lat": 24.53, "lng": 81.30, "tilt": 25, "az": 180, "kwp": 1000, "ac": 1000},
    {"key": "kurnool", "name": "Kurnool Solar, Andhra Pradesh",
     "lat": 15.68, "lng": 78.28, "tilt": 16, "az": 180, "kwp": 1000, "ac": 1000},
    {"key": "ananthapur", "name": "Ananthapur Solar, Andhra Pradesh",
     "lat": 14.62, "lng": 77.60, "tilt": 15, "az": 180, "kwp": 1000, "ac": 1000},
    {"key": "mandsaur", "name": "Mandsaur Solar, Madhya Pradesh",
     "lat": 24.08, "lng": 74.68, "tilt": 24, "az": 180, "kwp": 1000, "ac": 1000},
    {"key": "neyveli", "name": "Neyveli Solar, Tamil Nadu",
     "lat": 11.61, "lng": 79.49, "tilt": 12, "az": 180, "kwp": 1000, "ac": 1000},
]

IMPACT = {
    "india_rooftop_gw": 32.59,
    "annual_yield_kwh_per_kw": 1650,
    "annual_twh": 53.8,
    "recoverable_pct": 3,
    "recoverable_twh": 1.61,
    "avg_mw": 184,
    "inr_cr_per_year": 1100,
    "homes_million": 1.5,
    "global_solar_gw": 2499,
    "soiling_nrel_pct": 2.2,
    "inr_per_kwh": 8,
}


def _counterfactual(site: Site) -> dict | None:
    try:
        rm = site.runmeta
    except RunMeta.DoesNotExist:
        return None
    t = rm.totals_json or {}
    per_day = (t.get("predicted", 0) / rm.n_days) if rm.n_days else 0.0
    return cleaning_counterfactual(
        site.key, rm.end_date.isoformat(),
        expected_per_day=per_day, soiling_ratio=rm.soiling_ratio)


def story(request):
    return render(request, "dashboard/story.html", {"active": "story"})


def onboard(request):
    error = ""
    if request.method == "POST" and request.POST.get("save") == "1":
        try:
            lat = float(request.POST.get("lat", ""))
            lng = float(request.POST.get("lon", ""))
            kwp = float(request.POST.get("kwp") or 0)
        except ValueError:
            lat = lng = kwp = 0.0
            error = "Latitude, longitude and capacity are required."
        if not error and not (-90 <= lat <= 90 and -180 <= lng <= 180 and kwp > 0):
            error = "Check your coordinates and system capacity (kWp > 0)."
        if not error:
            name = (request.POST.get("name") or "").strip() or \
                f"My rooftop ({lat:.2f}, {lng:.2f})"
            base = slugify(name)[:44] or "rooftop"
            key, i = base, 2
            while Site.objects.filter(key=key).exists():
                key, i = f"{base}-{i}", i + 1
            tilt = float(request.POST.get("tilt") or round(abs(lat)))
            az = float(request.POST.get("az") or 180)
            ac = float(request.POST.get("ac") or round(kwp * 0.8, 1))
            site = Site.objects.create(
                key=key, name=name, lat=lat, lng=lng, tilt_deg=tilt,
                azimuth_deg=az, kwp_dc=kwp, ac_kw=ac,
                role="onboarded via /onboard wizard",
                data_policy="owner-entered specs; ERA5 + Atlas + PVGIS extract at onboarding",
                pvoutput_api_key=(request.POST.get("pvkey") or "").strip()[:200],
                pvoutput_system_id=(request.POST.get("pvsid") or "").strip()[:50],
            )
            res = storage.save_system({
                "key": site.key, "name": site.name, "lat": lat, "lng": lng,
                "tilt_deg": tilt, "azimuth_deg": az, "kwp_dc": kwp,
                "ac_kw": ac, "pvoutput_api_key": site.pvoutput_api_key,
                "pvoutput_system_id": site.pvoutput_system_id,
                "source": "onboard",
            })
            return render(request, "dashboard/onboard.html", {
                "active": "onboard", "parks": PARKS,
                "saved": site, "storage": res, "error": "",
            })
    return render(request, "dashboard/onboard.html", {
        "active": "onboard", "parks": PARKS, "saved": None, "error": error,
    })


def overview(request):
    key = request.GET.get("site", "bmt")
    site = get_object_or_404(Site, key=key)
    loss = list(LossRecord.objects.filter(site=site).order_by("date").values())
    for r in loss:
        r["date"] = r["date"].isoformat()
    runmeta = RunMeta.objects.filter(site=site).first()
    alerts = list(OutageAlert.objects.filter(site=site)[:5].values(
        "start_date", "end_date", "days", "est_lost_kwh"))
    for a in alerts:
        a["start_date"] = a["start_date"].isoformat()
        a["end_date"] = a["end_date"].isoformat()
    cf = _counterfactual(site)
    total_gen = sum(r["generated_kwh"] for r in
                    DailyRecord.objects.filter(site=site).values("generated_kwh"))
    unexplained_pct = None
    if runmeta and (runmeta.totals_json or {}).get("expected"):
        exp = runmeta.totals_json["expected"]
        unexplained_pct = 100 * abs(runmeta.totals_json.get("unexplained", 0)) / exp
    ctx = {
        "sites": Site.objects.order_by("key"),
        "site": site,
        "loss_json": json.dumps(loss),
        "runmeta": runmeta,
        "unexplained_pct": unexplained_pct,
        "cf": cf,
        "impact": IMPACT,
        "alerts_json": json.dumps(alerts),
        "loss_cols": LOSS_COLS,
        "total_gen": round(total_gen, 1),
        "active": "overview",
    }
    return render(request, "dashboard/overview.html", ctx)


def site_detail(request, key):
    site = get_object_or_404(Site, key=key)
    recs = list(DailyRecord.objects.filter(site=site)
                .order_by("date").values(
                    "date", "generated_kwh", "ghi_kwh_m2",
                    "tmean_c", "flags", "peak_kw"))
    for r in recs:
        r["date"] = r["date"].isoformat()
    flagged = [r for r in recs if r["flags"]]
    totals = {
        "days": len(recs),
        "total": round(sum(r["generated_kwh"] for r in recs), 1),
        "best": round(max((r["generated_kwh"] for r in recs), default=0), 1),
        "flagged": len(flagged),
    }
    ctx = {
        "sites": Site.objects.order_by("key"),
        "site": site,
        "daily_json": json.dumps(recs),
        "totals": totals,
        "recent_flagged": list(reversed(flagged[-12:])),
        "active": "site",
    }
    return render(request, "dashboard/site_detail.html", ctx)


def analytics(request):
    key = request.GET.get("site", "bmt")
    site = get_object_or_404(Site, key=key)
    kwp = site.kwp_dc or 1.0
    recs = list(DailyRecord.objects.filter(site=site)
                .order_by("date").values("date", "generated_kwh", "ghi_kwh_m2"))
    yearly: dict = {}
    pr: dict = {}
    for r in recs:
        y, m = r["date"].year, r["date"].month - 1
        d = yearly.setdefault(y, {"gen": 0.0, "days": 0, "ghi": 0.0})
        d["gen"] += r["generated_kwh"]
        d["days"] += 1
        if r["ghi_kwh_m2"]:
            d["ghi"] += r["ghi_kwh_m2"]
            if r["ghi_kwh_m2"] > 0.5:
                pratio = r["generated_kwh"] / (r["ghi_kwh_m2"] * kwp)
                if 0 <= pratio <= 1.2:
                    cell = pr.setdefault(y, {}).setdefault(m, [0.0, 0])
                    cell[0] += pratio
                    cell[1] += 1
    years_json = [{"year": y, **yearly[y]} for y in sorted(yearly)]
    heatmap = [{"year": y,
                "cells": [round(pr.get(y, {}).get(m, [0, 0])[0]
                                / pr[y][m][1], 2)
                          if m in pr.get(y, {}) and pr[y][m][1] else None
                          for m in range(12)]}
               for y in sorted(yearly)]
    recent = [{"date": r["date"].isoformat(), "gen": r["generated_kwh"],
               "ghi": r["ghi_kwh_m2"] or 0}
              for r in recs[-90:]]
    runmeta = RunMeta.objects.filter(site=site).first()
    annual_est = None
    if runmeta and runmeta.n_days and (runmeta.totals_json or {}).get("predicted"):
        annual_est = round(runmeta.totals_json["predicted"] * 365 / runmeta.n_days)
    pvgis, pvgis_err = None, ""
    if site.lat is not None and site.lng is not None:
        try:
            from wattback.ingest.pvgis import pvgis_baseline
            pvgis = pvgis_baseline(site.lat, site.lng,
                                   site.tilt_deg or 28, site.azimuth_deg or 180,
                                   kwp)
            if "error" in pvgis:
                pvgis_err = pvgis.pop("error")
        except Exception as exc:  # noqa: BLE001
            pvgis_err = f"{type(exc).__name__}: {exc}"
    gap_pct = None
    if pvgis and pvgis.get("annual_kwh") and annual_est:
        gap_pct = round(100 * (pvgis["annual_kwh"] - annual_est)
                        / pvgis["annual_kwh"], 1)
    ctx = {
        "sites": Site.objects.order_by("key"),
        "site": site,
        "years_json": json.dumps(years_json),
        "heatmap": heatmap,
        "recent_json": json.dumps(recent),
        "years": years_json,
        "y0": years_json[0]["year"] if years_json else "—",
        "y1": years_json[-1]["year"] if years_json else "—",
        "lifetime": round(sum(y["gen"] for y in years_json), 1),
        "runmeta": runmeta,
        "annual_est": annual_est,
        "pvgis": pvgis,
        "pvgis_err": pvgis_err,
        "gap_pct": gap_pct,
        "gap_abs": abs(gap_pct) if gap_pct is not None else None,
        "active": "analytics",
    }
    return render(request, "dashboard/analytics.html", ctx)


def outages(request):
    alerts = OutageAlert.objects.select_related("site").order_by("-start_date")
    total_lost = sum(a.est_lost_kwh for a in alerts)
    published = sum(1 for a in alerts if a.published_at)
    ctx = {
        "sites": Site.objects.order_by("key"),
        "alerts": alerts,
        "total_lost": round(total_lost, 1),
        "published": published,
        "active": "outages",
        "inr": IMPACT["inr_per_kwh"],
    }
    return render(request, "dashboard/outages.html", ctx)


def _ladder(site: Site, sr, recent_flags, dc_pct, inv_pct, grid_alert) -> list:
    steps = []

    def add(key, title, status, detail):
        steps.append({"key": key, "title": title, "status": status,
                      "detail": detail})

    if sr is None:
        add("soiling", "Soiling / wash", "watch",
            "soiling ratio unknown; run the engine (load_wattback) first")
    elif sr < 0.97:
        add("soiling", "Soiling / wash", "act",
            f"ratio {sr:.3f}: panels are losing {100 * (1 - sr):.1f}% every "
            "sunny day, wash while dry")
    elif sr < 0.995:
        add("soiling", "Soiling / wash", "watch",
            f"ratio {sr:.3f}: dust is accumulating, schedule a wash")
    else:
        add("soiling", "Soiling / wash", "ok",
            f"ratio {sr:.3f}: rain or washes have kept panels clean")

    if recent_flags >= 4:
        add("shading", "Shading / strings", "act",
            f"{recent_flags} of the last 30 days flagged low or partial "
            "output: walk the array at midday, look for trees, poles and "
            "shaded strings")
    elif recent_flags:
        add("shading", "Shading / strings", "watch",
            f"{recent_flags} low-output day(s) in the last 30: verify at "
            "noon, one string down looks like this")
    else:
        add("shading", "Shading / strings", "ok",
            "no low-output flags in the last 30 days")

    if dc_pct is None:
        add("wiring", "DC wiring", "watch",
            "loss window not computed yet")
    elif dc_pct > 2:
        add("wiring", "DC wiring", "act",
            f"DC cable losses at {dc_pct:.1f}% of expected: inspect MC4 "
            "connectors, fuse holders and combiner joints")
    elif dc_pct > 1:
        add("wiring", "DC wiring", "watch",
            f"DC cable losses at {dc_pct:.1f}%: watch connectors through "
            "the season")
    else:
        add("wiring", "DC wiring", "ok",
            f"DC cable losses at {dc_pct:.1f}%: within spec")

    if inv_pct is None:
        add("inverter", "Inverter", "watch",
            "loss window not computed yet")
    elif inv_pct > 3.5:
        add("inverter", "Inverter", "act",
            f"conversion losses at {inv_pct:.1f}%: check fans, filters and "
            "MPPT tracking against the datasheet curve")
    elif inv_pct > 2.5:
        add("inverter", "Inverter", "watch",
            f"conversion losses at {inv_pct:.1f}%: slightly high, recheck "
            "after the next service")
    else:
        add("inverter", "Inverter", "ok",
            f"conversion losses at {inv_pct:.1f}%: healthy")

    if grid_alert:
        add("grid", "Grid / DISCOM", "act",
            f"outage detected {grid_alert[0]}..{grid_alert[1]} "
            f"({grid_alert[2]} days, {grid_alert[3]:.0f} kWh lost): raise a "
            "DISCOM complaint, this is not your plant's fault")
    else:
        add("grid", "Grid / DISCOM", "ok",
            "no outage alerts in the current window")
    return steps


def cleaning(request):
    key = request.GET.get("site", "bmt")
    site = get_object_or_404(Site, key=key)
    cf = _counterfactual(site)
    runmeta = RunMeta.objects.filter(site=site).first()
    msg, err = "", ""

    if request.method == "POST":
        action = request.POST.get("action", "")
        raw_date = (request.POST.get("date") or "").strip() or \
            date_cls.today().isoformat()
        try:
            d = date_cls.fromisoformat(raw_date)
        except ValueError:
            d = None
            err = "Invalid date (use YYYY-MM-DD)."
        if action == "cleaned" and d is not None:
            method = (request.POST.get("method") or "wash")[:40]
            note = (request.POST.get("note") or "")[:200]
            CleaningEvent.objects.update_or_create(
                site=site, date=d,
                defaults={"method": method, "note": note})
            msg = f"Cleaning recorded for {d} ({method})."
        elif action == "kwh" and d is not None:
            try:
                kwh = float(request.POST.get("kwh") or "")
            except ValueError:
                kwh = None
            if kwh is None or kwh < 0:
                err = "Enter today's generation in kWh (0 or more)."
            else:
                rec, created = DailyRecord.objects.get_or_create(
                    site=site, date=d,
                    defaults={"generated_kwh": kwh,
                              "source": "manual entry",
                              "conditions": "logged via cleaning page"})
                if not created:
                    rec.generated_kwh = kwh
                    rec.source = "manual entry"
                    rec.save(update_fields=["generated_kwh", "source"])
                msg = (f"Logged {kwh:g} kWh for {d}"
                       + (" (new record)." if created else " (record updated)."))
        elif not err:
            err = "Unknown action."

    sr_value = (request.GET.get("sr") or "").strip()
    if request.GET.get("recalc") and sr_value:
        per_day = 0.0
        if runmeta and runmeta.n_days:
            per_day = (runmeta.totals_json or {}).get("predicted", 0) / runmeta.n_days
        end = request.GET.get("end") or (
            runmeta.end_date.isoformat() if runmeta else ORACLE_END)
        try:
            sr = float(sr_value)
        except ValueError:
            sr = None
        if sr is not None:
            cf = cleaning_counterfactual(site.key, end, per_day, sr)

    loss_agg = LossRecord.objects.filter(site=site).aggregate(
        exp=Sum("expected"), dc=Sum("dc_cable"), inv=Sum("inv_conv"))
    exp = loss_agg["exp"] or 0
    dc_pct = (100 * abs(loss_agg["dc"] or 0) / exp) if exp else None
    inv_pct = (100 * abs(loss_agg["inv"] or 0) / exp) if exp else None

    recent = list(DailyRecord.objects.filter(site=site)
                  .order_by("-date")[:90])
    low_days = sum(
        1 for r in recent[:30]
        if "low_output" in r.flags or "partial" in r.flags)
    bake_days = sum(1 for r in recent
                    if (r.ghi_kwh_m2 or 0) >= 7 and (r.tmean_c or 0) >= 30)
    rain_days = sum(1 for r in recent if (r.precip_mm or 0) >= 1)
    suspect_days = sum(1 for r in recent if "outage_suspect" in r.flags)

    grid_alert = None
    cutoff = date_cls.today() - timedelta(days=45)
    last_alert = (OutageAlert.objects
                  .filter(site=site, start_date__gte=cutoff)
                  .order_by("-start_date").first())
    if last_alert:
        grid_alert = (last_alert.start_date.isoformat(),
                      last_alert.end_date.isoformat(),
                      last_alert.days, last_alert.est_lost_kwh)

    sr = None
    if cf:
        sr = cf.get("soiling_ratio")
    elif runmeta:
        sr = runmeta.soiling_ratio
    ladder = _ladder(site, sr, low_days, dc_pct, inv_pct, grid_alert)
    events = list(CleaningEvent.objects.filter(site=site)[:6])

    ctx = {
        "sites": Site.objects.order_by("key"),
        "site": site,
        "cf": cf,
        "runmeta": runmeta,
        "sr_value": sr_value,
        "inr": IMPACT["inr_per_kwh"],
        "ladder": ladder,
        "events": events,
        "tags": {"bake_days": bake_days, "rain_days": rain_days,
                 "suspect_days": suspect_days, "low_days": low_days},
        "msg": msg, "err": err,
        "today": date_cls.today().isoformat(),
        "active": "cleaning",
    }
    return render(request, "dashboard/cleaning.html", ctx)
