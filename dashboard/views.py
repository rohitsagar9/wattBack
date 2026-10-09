import json

from django.shortcuts import get_object_or_404, render

from wattback.loss.counterfactual import cleaning_counterfactual

from .models import DailyRecord, LossRecord, OutageAlert, RunMeta, Site

ORACLE_START = "2026-09-01"
ORACLE_END = "2026-09-29"
LOSS_COLS = ["aoi", "temp", "soiling", "dc_cable", "inv_conv", "clip", "ac_cable"]

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
