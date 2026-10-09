import json

from django.shortcuts import get_object_or_404, render
from django.utils.text import slugify

from wattback.loss.counterfactual import cleaning_counterfactual

from . import storage
from .models import DailyRecord, LossRecord, OutageAlert, RunMeta, Site

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


def cleaning(request):
    key = request.GET.get("site", "bmt")
    site = get_object_or_404(Site, key=key)
    cf = _counterfactual(site)
    runmeta = RunMeta.objects.filter(site=site).first()
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
    ctx = {
        "sites": Site.objects.order_by("key"),
        "site": site,
        "cf": cf,
        "runmeta": runmeta,
        "sr_value": sr_value,
        "inr": IMPACT["inr_per_kwh"],
        "active": "cleaning",
    }
    return render(request, "dashboard/cleaning.html", ctx)
