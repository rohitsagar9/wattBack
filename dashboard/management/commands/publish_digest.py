"""Compose and publish a daily WattBack digest to SNS (AWS).

One email per run covering every site (or a single site with --site):
yesterday's generation, active outages, the cleaning counterfactual,
and the single biggest modelled loss driver.

If SNS_TOPIC_ARN is set, publishes via boto3; otherwise dry-runs locally.

usage: python manage.py publish_digest [--site bmt] [--date 2026-10-09]
"""

import os
from datetime import date, timedelta

from django.core.management.base import BaseCommand, CommandError

from dashboard.models import DailyRecord, LossRecord, OutageAlert, Site
from dashboard.views import _counterfactual, LOSS_COLS

FACTOR_LABELS = {
    "aoi": "angle-of-incidence (tilt/azimuth)",
    "temp": "cell temperature (heat)",
    "soiling": "soiling (dust)",
    "dc_cable": "DC wiring",
    "inv_conv": "inverter conversion",
    "clip": "clipping",
    "ac_cable": "AC wiring / transformer",
    "unexplained": "unexplained residual",
}


class Command(BaseCommand):
    help = "Publish a daily WattBack digest to SNS (or dry-run locally)"

    def add_arguments(self, parser):
        parser.add_argument("--site", default="",
                            help="single site key (default: all sites)")
        parser.add_argument("--date", default="",
                            help="digest date YYYY-MM-DD (default: yesterday)")

    def handle(self, *args, **opts):
        try:
            when = (date.fromisoformat(opts["date"]) if opts["date"]
                    else date.today() - timedelta(days=1))
        except ValueError:
            raise CommandError("--date must be YYYY-MM-DD")

        if opts["site"]:
            sites = list(Site.objects.filter(key=opts["site"]))
            if not sites:
                raise CommandError(f"unknown site: {opts['site']}")
        else:
            sites = list(Site.objects.order_by("key"))
        if not sites:
            raise CommandError("no sites in the database")

        lines = [f"WattBack daily digest · {when.isoformat()}",
                 "=" * 48]
        for site in sites:
            lines.extend(self._site_lines(site, when))
            lines.append("")

        subject = f"WattBack daily: {when.isoformat()}"
        if opts["site"] and sites:
            subject += f" · {sites[0].name[:40]}"
        body = "\n".join(lines)
        topic = os.environ.get("SNS_TOPIC_ARN", "")

        if topic:
            import boto3
            client = boto3.client("sns", region_name=os.environ.get(
                "AWS_REGION", "ap-south-1"))
            client.publish(TopicArn=topic, Subject=subject, Message=body)
            self.stdout.write(f"SNS published to {topic} ({len(sites)} sites)")
        else:
            self.stdout.write("DRY RUN (set SNS_TOPIC_ARN to publish)")
            self.stdout.write(subject)
            self.stdout.write(body)

    def _site_lines(self, site: Site, when: date) -> list:
        out = [f"▸ {site.name} ({site.kwp_dc} kWp)"]

        rec = (DailyRecord.objects.filter(site=site, date=when)
               .order_by("-date").first())
        if rec:
            out.append(f"  yesterday: {rec.generated_kwh:.1f} kWh"
                       + (f" · flags {rec.flags}" if rec.flags else ""))
        else:
            out.append(f"  yesterday: no record for {when}")

        alerts = list(OutageAlert.objects.filter(
            site=site, start_date__gte=when - timedelta(days=14)))
        if alerts:
            lost = sum(a.est_lost_kwh for a in alerts)
            newest = alerts[0]
            out.append(f"  OUTAGES: {len(alerts)} in the last 14d, "
                       f"latest {newest.start_date}→{newest.end_date} "
                       f"({newest.days}d, ~{lost:.0f} kWh lost)")
        else:
            out.append("  outages: none in the last 14d")

        cf = _counterfactual(site)
        if cf:
            if cf["recommendation"] == "clean now":
                out.append(f"  cleaning: WASH NOW, worth ≈ "
                           f"₹{cf['gain_inr']:.0f} ({cf['gain_kwh']:.1f} kWh "
                           f"before the next modelled rain)")
            else:
                out.append(f"  cleaning: wait for rain "
                           f"(~{cf['modelled_rain_interval_days']:.0f}d), "
                           f"wash only worth ≈₹{cf['gain_inr']:.0f}")
        else:
            out.append("  cleaning: engine has not run for this site yet")

        sums = {}
        exp = 0.0
        for row in (LossRecord.objects.filter(site=site)
                    .values(*LOSS_COLS, "expected")):
            for k in LOSS_COLS:
                sums[k] = sums.get(k, 0.0) + (row[k] or 0)
            exp += row["expected"] or 0
        if exp:
            top = max(LOSS_COLS, key=lambda k: abs(sums[k]))
            pct = 100 * abs(sums[top]) / exp
            out.append(f"  top loss driver: {FACTOR_LABELS[top]} "
                       f"({pct:.1f}% of expected energy)")
        else:
            out.append("  loss window: no computed days yet")
        return out
