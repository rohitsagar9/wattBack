"""Load WattBack data into the Django database.

Reads the committed CSVs in data/raw/ (no network needed) and, for the
default demo window, runs the physics loss engine (hourly weather for that
window is also committed under data/raw/cache/).

usage: python manage.py load_wattback
       python manage.py load_wattback --skip-loss
       python manage.py load_wattback --loss-start 2026-09-01 --loss-end 2026-09-29
"""

import json
from datetime import date as _date
from pathlib import Path

import pandas as pd
from django.core.management.base import BaseCommand
from django.db import transaction

from dashboard.models import DailyRecord, LossRecord, OutageAlert, RunMeta, Site
from wattback.config import RAW_DIR, ROOT, load_sites
from wattback.loss.engine import LOSS_COLS, run_engine
from wattback.loss.outage import detect_outages

DEFAULT_LOSS_START = "2026-09-01"
DEFAULT_LOSS_END = "2026-09-29"


class Command(BaseCommand):
    help = "Load WattBack sites/daily/alerts (+ loss window) from data/raw/"

    def add_arguments(self, parser):
        parser.add_argument("--skip-loss", action="store_true")
        parser.add_argument("--loss-start", default=DEFAULT_LOSS_START)
        parser.add_argument("--loss-end", default=DEFAULT_LOSS_END)

    @transaction.atomic
    def handle(self, *args, **opts):
        self._load_sites()
        for key in ("bmt", "manalil"):
            self._load_daily(key)
        for key in ("bmt", "manalil"):
            self._load_alerts(key)
        if not opts["skip_loss"]:
            for key in ("bmt", "manalil"):
                self._load_loss(key, opts["loss_start"], opts["loss_end"])
        self.stdout.write(self.style.SUCCESS("load_wattback: done"))

    def _load_sites(self) -> None:
        for key, cfg in load_sites().items():
            Site.objects.update_or_create(
                key=key,
                defaults={
                    "name": cfg["name"],
                    "lat": cfg.get("lat"),
                    "lng": cfg.get("lng"),
                    "tilt_deg": cfg.get("tilt_deg"),
                    "azimuth_deg": cfg.get("azimuth_deg"),
                    "kwp_dc": cfg.get("kwp_dc", 0),
                    "ac_kw": cfg.get("ac_kw", 0),
                    "role": cfg.get("role", ""),
                    "data_policy": cfg.get("data_policy", ""),
                },
            )
        self.stdout.write(f"sites: {Site.objects.count()}")

    def _load_daily(self, key: str) -> None:
        gen_path = RAW_DIR / f"{key}_daily.csv"
        if not gen_path.exists():
            return
        gen = pd.read_csv(gen_path, parse_dates=["date"])
        wx_path = RAW_DIR / f"era5_{key}.csv"
        if wx_path.exists():
            wx = pd.read_csv(wx_path, parse_dates=["date"])
            gen = gen.merge(wx, on="date", how="left")
        else:
            for c in ("ghi_kwh_m2", "tmean_c", "precip_mm", "cloud_pct"):
                gen[c] = None
        site = Site.objects.get(key=key)
        gen["flags"] = gen["flags"].fillna("")
        gen["conditions"] = gen.get("conditions", pd.Series([""] * len(gen))).fillna("")
        gen["peak_time"] = gen.get("peak_time", pd.Series([""] * len(gen))).fillna("")
        gen["temp_text"] = gen.get("temp_text", pd.Series([""] * len(gen))).fillna("")
        gen["source"] = gen.get("source", pd.Series([""] * len(gen))).fillna("")

        DailyRecord.objects.filter(site=site).delete()
        DailyRecord.objects.bulk_create([
            DailyRecord(
                site=site,
                date=r["date"].date(),
                generated_kwh=float(r["generated_kwh"]),
                peak_kw=None if pd.isna(r.get("peak_kw")) else float(r["peak_kw"]),
                peak_time=str(r.get("peak_time", "")),
                conditions=str(r.get("conditions", "")),
                temp_text=str(r.get("temp_text", "")),
                source=str(r.get("source", "")),
                flags=str(r["flags"]),
                ghi_kwh_m2=None if pd.isna(r.get("ghi_kwh_m2")) else float(r["ghi_kwh_m2"]),
                tmean_c=None if pd.isna(r.get("tmean_c")) else float(r["tmean_c"]),
                precip_mm=None if pd.isna(r.get("precip_mm")) else float(r["precip_mm"]),
                cloud_pct=None if pd.isna(r.get("cloud_pct")) else float(r["cloud_pct"]),
            )
            for _, r in gen.iterrows()
        ], batch_size=500)
        self.stdout.write(f"daily {key}: {len(gen)} rows")

    def _load_alerts(self, key: str) -> None:
        site = Site.objects.get(key=key)
        found = detect_outages(key)
        wanted = {(f["start"], f["end"]) for f in found}
        for a in found:
            OutageAlert.objects.update_or_create(
                site=site, start_date=_date.fromisoformat(a["start"]),
                end_date=_date.fromisoformat(a["end"]),
                defaults={"days": a["days"], "est_lost_kwh": a["est_lost_kwh"]},
            )
        OutageAlert.objects.filter(site=site).exclude(
            start_date__in=[_date.fromisoformat(s) for s, _ in wanted]).delete()
        self.stdout.write(f"alerts {key}: {len(found)}")

    def _load_loss(self, key: str, start: str, end: str) -> None:
        daily, meta = run_engine(key, start, end)
        site = Site.objects.get(key=key)
        LossRecord.objects.filter(site=site).delete()
        rows = []
        for d, r in daily.iterrows():
            rows.append(LossRecord(
                site=site, date=d.date(), segment=str(r.get("segment", "")),
                factor=float(r.get("factor", 1.0)),
                expected=float(r["expected"]),
                **{c: float(r[c]) for c in LOSS_COLS},
                predicted=float(r["predicted"]), actual=float(r["actual"]),
                avail=float(r["avail"]), missing=float(r["missing"]),
                unexplained=float(r["unexplained"]),
            ))
        LossRecord.objects.bulk_create(rows, batch_size=500)
        t = meta["totals"]
        RunMeta.objects.update_or_create(
            site=site,
            defaults={
                "start_date": _date.fromisoformat(meta["start"]),
                "end_date": _date.fromisoformat(meta["end"]),
                "n_days": meta["n_days"],
                "soiling_ratio": meta["soiling_end"],
                "factors_json": meta["factors"],
                "totals_json": t,
            },
        )
        self.stdout.write(
            f"loss {key}: {len(rows)} days | expected {t['expected']:.1f} "
            f"actual {t['actual']:.1f} "
            f"unexplained {100 * abs(t['unexplained']) / t['expected']:.2f}%")
