# WattBack — submission writeup

**Track 03 · Waste & Energy — "Rooftop solar"** · Team: solo · Oct 8–11, 2026
**Repo:** github.com/rohitsagar9/wattBack · **Video:** (YouTube link) · **Live:** (EB URL)

## The problem

India has **32.59 GW** of rooftop solar (MNRE, Aug 2026) generating ≈ **53.8 TWh/year** —
and almost none of it is monitored. Rooftop systems quietly lose **3–10%** of that to
soiling, multi-day outages, thermal derate, clipping and cable losses. Owners find out
via a disappointing bill, months late. At 3% recoverable that is **1.6 TWh/yr
≈ ₹1,100 cr/yr** of clean energy thrown away — while 2,499 GW of solar (IRENA) spreads
the same blind spot worldwide.

## What WattBack does

1. **Expected vs actual** — an hourly physics chain (pvlib POA irradiance, incidence-angle
   modifier, SAPM cell temperature, HSU soiling from rain + PM2.5/PM10) calibrated with
   just **two** global bias factors per window (clear/cloudy) — never per-day fitting.
   The loss waterfall closes **exactly** (0.000000 kWh drift); unexplained residual is
   **0.09%** on a held-out 56.6 kWp system and 0.72% on a 3.09 kWp home system.
2. **Named losses** — AOI, temperature, soiling, DC/AC cable, inverter conversion,
   clipping → each shown as kWh and % of expected, per day.
3. **Cleaning counterfactual** — "wash today, gain ₹X" vs "wait for rain", using the
   site's own 90-day rain rhythm; soiling ratio from the HSU chain.
4. **Outage alerts** — collapse-vs-trailing-median detector over the raw series,
   duration + kWh + ₹ estimated, published to **Amazon SNS** for email delivery.
5. **LightGBM residual model** — lag-safe features, expanding walk-forward, beats a
   weekly-seasonal naive baseline by **33% RMSE** (3,143 out-of-fold predictions).
6. **Django dashboard + JSON API** — charts, waterfall, alerts, calculator,
   `/api/v1/{sites,daily,loss,outages,cleaning,impact}`.

**Data:** two *real* systems backfilled from PVOutput (BMT Punjab 56.6 kWp, 2021→2026,
2,096 days, 184 MWh; Manalil home 3.09 kWp, 1,203 days) + ERA5 reanalysis + Global Solar
Atlas — all committed with deterministic import (flags, contiguity checks, junk-drop).

**Validation:** 38 automated tests — physics oracles frozen for a 29-day window on both
systems, exact-closure checks, known-outage recall, data-integrity assertions, API/page
end-to-end tests.

## Where AWS fits

| Service | Use |
|---|---|
| **Elastic Beanstalk** (EC2 t3.micro, free tier) | Hosts the Django app + API behind nginx/gunicorn — one `eb deploy` |
| **S3** | Every deploy bundle (application versions) |
| **CloudWatch** | EB log streaming (`eb logs --stream`) |
| **SNS** | Outage alert emails (`manage.py publish_alerts`) |
| **IAM** | Deploy identity, EB service role |

Environment variables carry the secrets; `.ebextensions` runs `load_wattback`
on every deploy; data and engine caches ship in the bundle, so the app
bootstraps offline inside the VPC.

## AI tools used

- **opencode** (AI coding agent) — scaffolding, ingest pipeline, physics engine port,
  tests, templates, docs. All AI-generated code was reviewed and verified locally
  (pytest) before each commit; oracles were produced by running the engine on this
  machine, not by the model.

## What's next

Tier-1 "add your system" (paste a PVOutput link), vendor API sync (Enphase/Growatt),
SNS → CloudWatch alarms dashboard, and county-level extrapolation using Global Solar
Atlas PVOUT for any coordinates.
