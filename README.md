# WattBack

**Know what your rooftop solar *should* have produced — and exactly where the missing units went.**

Rooftop PV silently loses 3–10% of its yield to soiling, outages, shading, temperature
derate, clipping and inverter faults. Owners see only the electricity bill, never the loss.
WattBack builds an expected-vs-actual generation baseline for any system from public
generation data + reanalysis weather, decomposes every shortfall into named, actionable
loss buckets, and turns that into cleaning decisions, outage alerts, and a global
extrapolation of the recoverable energy.

> Track 3 — **Environmental Hacks** · WeMakeDevs × AWS · Oct 8–11, 2026

## Impact math

| Anchor | Figure | Source |
|---|---|---|
| India rooftop PV installed | **32.59 GW** (31 Aug 2026) | MNRE / Rooftop Solar Portal |
| Implied annual rooftop generation (× 1,650 kWh/kWp/yr) | **≈ 53.8 TWh/yr** | derived |
| Global solar capacity | **2,499 GW** (2026) | IRENA Renewable Capacity Statistics |
| Soiling loss | **≈ 2.2%** avg (US), **1–2%** monsoon, **≤5%** semi-arid | NREL soiling studies |

Typical combined losses (soiling + outages + thermal + shading) run **3–10%** and are
almost never monitored on residential/commercial rooftops. Recovering just **3%**:

- **≈ 1.6 TWh/yr** of clean energy — 1.6 TWh of headroom simply unclaimed
- **≈ 184 MW** of continuous power (average)
- **≈ ₹1,100 cr/yr** of energy value (at ~₹6.8/kWh self-consumption)
- Powers **> 1 million homes**' worth of annual consumption

The same method applies to any of the world's 2,499 GW wherever a public output API or
CSV export exists.

## What it does

1. **Expected vs actual** — hourly physics chain (pvlib: POA irradiance, physical
   IAM, SAPM cell temperature, HSU soiling) plus two global clear/cloudy irradiance
   bias factors fitted per window (never per-day)
2. **Loss decomposition** — AOI, temperature, soiling, DC/AC cabling, inverter
   conversion, clipping → a waterfall that closes **exactly** (0.000000 kWh drift)
3. **Cleaning counterfactual** — "clean now vs wait for rain" with kWh and ₹ value,
   rain timing modelled from the site's own 90-day rain rhythm
4. **Outage detection** — collapse-vs-trailing-median rule over the raw series →
   alerts with duration and estimated energy lost
5. **Residual model** — LightGBM (log-target, lag-safe features, expanding
   walk-forward) beats a weekly-seasonal naive baseline by **33% RMSE**
   (0.246 vs 0.368 log-RMSE, 3,143 out-of-fold predictions)
6. **Story → onboard → dashboard → cleaning** — a four-surface web app: a story page
   naming all 17 leak vectors, a 3-step onboarding wizard (map, PVGIS baseline,
   terrain-horizon × sun-path shading view), the dashboard + analytics heatmap, and a
   cleaning page with a five-rung **action ladder** (soiling → shading → wiring →
   inverter → grid); JSON API under `/api/v1/` for machines

### Web app & API

| Page | What it shows |
|---|---|
| `/` | Story: the ₹1,100 cr dust tax + 17 leak vectors, each tagged measured/flagged |
| `/onboard/` | Add your roof: coordinates (geolocation or 10 Indian presets), kWp/tilt/az, optional PVOutput key; live extract + shading view; saves via DynamoDB dual-mode adapter |
| `/app/` | Expected vs actual, loss decomposition, soiling gauge, live counterfactual, ₹-impact |
| `/app/site/<key>/` | Full 6-year generation vs GHI + data-quality flag audit |
| `/app/outages/` | Detected outages with duration, kWh and ₹ lost, SNS publish state |
| `/app/cleaning/` | Counterfactual calculator + action ladder + wash log + manual kWh entry |
| `/app/analytics/` | Yearly generation, month×year PR heatmap, gen-vs-GHI, PVGIS cross-check, site map |
| `/admin/` | Django admin over all imported data |

JSON under **`/api/v1/`**: `sites/` · `daily/?site=&start=&end=` ·
`loss/?site=&start=&end=` (physics engine, DB-cached) · `outages/` ·
`cleaning/` · `impact/` · `extract/?lat=&lon=&tilt=&az=&kwp=` (ERA5 + Atlas +
PVGIS + horizon + sun path for any point).

### Where AWS fits

| Service | Role |
|---|---|
| **Elastic Beanstalk** → **EC2** (t3.micro, free tier) | Runs Django behind nginx/gunicorn |
| **S3** | Stores every deploy bundle (application versions) |
| **CloudWatch** | EB logs (`eb logs`, `eb logs --stream`) |
| **SNS** | `publish_alerts` (outage emails) + `publish_digest` (daily email digest) |
| **DynamoDB** | Dual-write mirror of onboarded systems (`wattback-systems`, on-demand; falls back to DB-only when no AWS creds) |
| **IAM** | Deploy credentials + EB service role |

### First results (frozen as oracle tests, 2026-09-01 → 09-29)

| System | Expected | Actual | Temp | Inverter | Soiling | AOI | Unexplained |
|---|---|---|---|---|---|---|---|
| BMT Punjab (56.6 kWp) | 5,670.0 kWh | 4,917.0 kWh | 6.78% | 3.62% | 0.73% | 1.97% | **0.09%** |
| Manalil Veedu (3.09 kWp) | 384.9 kWh | 335.8 kWh | 6.99% | 3.61% | 0.22% | 2.06% | **0.72%** |

The detector also found historical outages in the 6-year record (e.g. BMT
2024-07-20..28 — 9 days, 2025-10-04..10 — 7 days, 2026-07-09..11 — 590 kWh lost).

## Data

| Source | What | Span |
|---|---|---|
| [PVOutput.org](https://pvoutput.org) | Public 30-day window + logged-in-session backfill of two real systems | — |
| BMT Punjab (56.6 kWp, 31.63°N) | daily generation, peak kW, conditions | **2021-01-01 → 2026-10-09** (2,096 days, 184.4 MWh) |
| Manalil Veedu (3.09 kWp, 8.95°N) | daily generation (own system) | **2023-06-24 → 2026-10-09** (1,204 days, 12.3 MWh) |
| ERA5 reanalysis (via [Open-Meteo](https://open-meteo.com)) | daily GHI, temp, precip, cloud, wind | full overlap, ≤ yesterday |
| [Global Solar Atlas](https://globalsolaratlas.info) | long-term GHI / PVOUT per site + modelled-only reference site | LTA |

Data-quality flags are computed at import: `partial`, `gap_filled`, `zero`,
`outage_suspect`, `low_output`.

## Architecture

```
PVOutput (CSV/HTML) ─┐
ERA5 (Open-Meteo)  ─┼─▶ src/wattback/ingest/  ─▶ data/raw/*_daily.csv
Global Solar Atlas ─┘        (validated daily panel: flags, contiguity, junk-dropped)
        │                             │
        │  PVGIS (EU JRC) ───────────┤ baseline + terrain horizon (onboarding extract)
        ▼                             ▼
 loss engine (closes            Django app: story / onboard / dashboard /
 to 0.000000 kWh)               analytics / cleaning + /api/v1/
 + outage detector                     │
 + counterfactual        ┌─────────────┼──────────────┐
        │                ▼             ▼              ▼
        └──────▶ LightGBM       AWS Elastic      DynamoDB mirror
          walk-forward          Beanstalk        (dual-mode adapter,
          33% vs naive          EC2 · S3 ·       DB fallback)
                               CloudWatch · SNS
```

## Quickstart

```bash
pip install -r requirements.txt
python scripts/import_raw.py   # merge + flag source JSONs → data/raw/
python scripts/seed.py         # Atlas + ERA5 (PVOutput window needs a logged-in session)
python manage.py migrate       # web app schema
python manage.py load_wattback # sites + daily + alerts + loss window (offline)
python manage.py runserver     # http://127.0.0.1:8000  (story at /, onboard at /onboard/)
python manage.py publish_digest            # daily SNS digest (dry-run without AWS)
pytest                         # 50 tests: data, parser, loss oracles, web, API, model
```

Deployment: see [DEPLOY.md](DEPLOY.md) (Elastic Beanstalk, free-tier
single-instance, ~3 commands).

## Reproducibility

- Source JSONs are committed under `data/source/`; the importer is deterministic
  (dedupe by site+date, first source wins, anchored kWh/kW parsing drops chart junk).
- Tests assert full-span contiguity (≤15 known logging gaps in 2,099 days), exact
  flag counts, and totals against known account statistics.
- Expected-gen targets for the loss engine are frozen in Day-2 oracle tests
  (held-out unexplained residual ≈ 0.1%/day).

## Roadmap

- **Day 1–2 (done)** — data layer (6-year panels), loss engine + oracle tests,
  cleaning counterfactual, outage detector, LightGBM residual model
- **Day 3 (done)** — Django dashboard + JSON API + SNS alert publisher, 38 tests
- **Day 4 (done)** — RetroUI × OSINT redesign, story page (17 leaks), onboarding
  wizard with map + PVGIS shading view, analytics heatmap, cleaning action ladder,
  DynamoDB dual-mode adapter, SNS daily digest — **50 tests green**
- **Remaining** — Elastic Beanstalk deployment (see [DEPLOY.md](DEPLOY.md)),
  3-min demo video, submission audit; then "Add your system":
  - *Tier 1* — paste a PVOutput system link
  - *Tier 2* — upload a PVOutput/monitor CSV export
  - *Tier 3 (roadmap)* — vendor API / hardware sync (Enphase, Growatt, etc.)

## AI disclosure

Built with **opencode** (AI coding agent), which was used for scaffolding the package,
the ingest/validation pipeline, tests, and documentation. All AI-generated code was
reviewed and verified locally (pytest) before committing.

## References

- [MNRE](https://mnre.gov.in) — Ministry of New & Renewable Energy, rooftop solar capacity
- [IRENA](https://www.irena.org) — Renewable Capacity Statistics 2026
- [PVOutput.org](https://pvoutput.org) — community solar output sharing
- [Open-Meteo](https://open-meteo.com) — free ERA5-based weather archive API
- [Global Solar Atlas](https://globalsolaratlas.info) — World Bank / Solargis LTA data
- [PVGIS](https://re.jrc.ec.europa.eu/pvg_tools/en/) — EU Commission JRC satellite baseline + terrain horizon
- pvlib-python — PVWatts / system modeling + `get_pvgis_hourly` / `get_pvgis_horizon`
