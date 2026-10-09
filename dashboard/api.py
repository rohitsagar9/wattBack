"""Machine-readable JSON API under /api/v1/."""

import json
from functools import lru_cache

from django.http import JsonResponse
from django.shortcuts import get_object_or_404

from wattback.loss.counterfactual import cleaning_counterfactual
from wattback.loss.engine import LOSS_COLS, run_engine

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
