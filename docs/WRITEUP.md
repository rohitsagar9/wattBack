# Building a Server-Backed Solar Diagnostic Engine on AWS: Why We Chose Elastic Beanstalk over Lambda for Physics Models

**WattBack** · Track 03 · Waste & Energy (rooftop solar) · Oct 8–11, 2026
**Repo:** github.com/rohitsagar9/wattBack · **Video:** (YouTube link) · **Live:** (EB URL)

---

India has **32.59 GW** of rooftop solar (MNRE, Aug 2026) producing roughly **53.8 TWh a
year**, and almost none of it is monitored. Systems quietly lose **3–10%** to dust,
multi-day grid outages, heat, clipping and cable losses. Owners find out via a
disappointing bill, months later. At the low end of that range — a conservative 3% —
the recoverable energy is **1.6 TWh/year, about ₹1,100 crore**, thrown away annually.
WattBack is a solar diagnostic engine that answers one question per site: *what should
this system have produced today, and exactly where did each missing unit go?*

This post is about the build: the physics, the product surfaces, and the AWS
architecture decision that shaped everything else.

## The engine: expected vs actual, hour by hour

For any coordinates, tilt, azimuth and DC capacity, the engine computes expected
generation hour by hour:

1. **POA irradiance** from ERA5 reanalysis via pvlib (transposition to the panel plane),
2. an **incidence-angle modifier** for off-axis sunlight,
3. **SAPM cell temperature** — the famous γ = **−0.4%/°C** above 25 °C, which on a
   35 °C Punjab afternoon alone costs ~4%,
4. an **HSU soiling chain** accumulating dust from CAMS PM2.5/PM10 deposition, with a
   *tiered rain wash*: drizzle under 1 mm does not clean panels (it smears them), 1–10 mm
   gives a partial ~30% wash, and anything over 10 mm resets the ratio to 1.0.

The chain is calibrated with exactly **two global bias factors per window** (one clear
sky, one cloudy) — never per-day fitting, which would be overfitting dressed as
accuracy. Given that constraint, the loss waterfall closes **exactly**: the seven named
losses (AOI, temperature, soiling, DC cable, inverter conversion, clipping, AC cable)
plus the unexplained residual always sum to expected-minus-actual with zero drift.

On the held-out **BMT Punjab 56.6 kWp** system (2,096 days, 184 MWh of real PVOutput
data) the September window lands at: temperature **6.78%**, inverter conversion
**3.62%**, AOI **1.97%**, soiling **0.73%**, AC cable **0.24%**, DC cable **0.04%** —
and an unexplained residual of **0.09%** of expected energy. A second, much smaller
system (Manalil, 3.09 kWp, 1,203 days) closes at 0.72%. A walk-forward **LightGBM**
residual model, trained lag-safely on expanding windows, beats a weekly-seasonal naive
baseline by **33% RMSE** over 3,143 out-of-fold predictions — the physics gets you
most of the way; the model names what physics still misses.

## Why not Lambda

The instinct on AWS is always Lambda. Three things killed that instinct here:

**Physics needs state.** The engine works on multi-year hourly series. pvlib solar
position calls, the HSU accumulation chain, and LightGBM walk-forward training are not
map-shaped functions you fire per request. They are long-lived, sequential computations
over cached ERA5/CAMS/PVGIS datasets that live on disk next to the app.

**Cold starts lie about latency.** An onboarding request must answer in seconds with
ERA5 stats, a Global Solar Atlas LTA lookup, a PVGIS baseline and a terrain horizon.
Packing pvlib + pandas + lightgbm into a layer means a cold start you pay on every
infrequent diagnostic call. On a single EC2 instance behind Elastic Beanstalk, the
interpreter is already warm and the disk cache is already local.

**The honest unit of scale is a process, not a function.** WattBack is a Django app
with a JSON API, an admin, and server-rendered pages. Gunicorn on a t3.micro handles
every demo and every judge comfortably. When traffic grows, Elastic Beanstalk scales
the instance count and the same monolith runs behind a load balancer — the serverless
rewrite remains a *scale-out path*, not a day-one requirement. In the writeup's own
words: **the monolith is the architecture; serverless is the upgrade lane.**

The deployment cost of that decision: `eb init`, `eb create wattback --single`, and
`eb deploy` pushes the repo as a new application version to **S3** in seconds.
Environment health lives in the EB console; logs stream to **CloudWatch** with
`eb logs --stream`.

## Dual-mode storage: DynamoDB without lock-in

Onboarded systems are mirrored to **Amazon DynamoDB** (`wattback-systems`, partition
key `site_key`, on-demand billing, auto-created on first write) — but onboarding must
never *depend* on cloud access, because the same code runs in judges' clones, on
laptops, and in CI. So storage is a dual-mode adapter that falls back to the Django
database and never raises:

```python
def save_system(payload: dict) -> dict:
    if not (os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("AWS_PROFILE")):
        return {"mode": "db-only", "detail": "no AWS credentials in environment"}
    try:
        import boto3
        region = os.environ.get("AWS_REGION", "ap-south-1")
        table = os.environ.get("DYNAMO_TABLE", "wattback-systems")
        client = boto3.client("dynamodb", region_name=region)
        try:
            client.describe_table(TableName=table)
        except client.exceptions.ResourceNotFoundException:
            client.create_table(...)   # PAY_PER_REQUEST, HASH on site_key
        client.put_item(TableName=table, Item={...})
        return {"mode": "dynamodb", "detail": table}
    except Exception as exc:
        log.warning("DynamoDB mirror skipped: %s", exc)
        return {"mode": "db-only", "detail": f"{type(exc).__name__}: {exc}"}
```

On Elastic Beanstalk the environment carries `AWS_ACCESS_KEY_ID`/role and every save
dual-writes; locally the same call is a no-op against SQLite. Same code, two modes,
zero branches in the views.

## Cross-validation: two engines that never talk

A physics model that closes exactly on itself proves nothing. So WattBack asks an
independent authority: the **European Commission's PVGIS** (keyless API, PVGIS-SARAH3
with an ERA5 fallback) plus the **Global Solar Atlas** for long-term yield. During
onboarding, one request to `/api/v1/extract/` fans out to ERA5 (last 60 days), the
Atlas LTA, PVGIS, and a terrain-horizon profile, then renders a **shading view**: the
terrain silhouette in ink against today's sun path in amber, with a live "now" marker.

For BMT, the physics model scaled from the September window estimates ≈61,800 kWh/yr
against PVGIS's full-year satellite baseline of ≈79,600 kWh/yr — a **22% gap** that is
*seasonal, not systematic* (September is monsoon; the full year is sunnier). That the
sign and rough magnitude of the gap match the meteorology is exactly the sanity check
you want. The analytics page keeps this cross-check visible on every visit.

## Product surfaces

WattBack ships as four surfaces, not a dashboard dump:

- **Story** (`/`) — the ₹1,100-crore dust tax and seventeen named leak vectors, each
  illustrated and tagged `measured` or `flagged` from real model output.
- **Onboard** (`/onboard/`) — a three-step wizard: coordinates (geolocation or ten
  preset Indian systems), system details (kWp, tilt, azimuth, optional PVOutput key),
  then the extract-and-verify step with satellite map, PVGIS cross-check and shading view.
- **Dashboard & analytics** (`/app/`, `/app/analytics/`) — the loss waterfall, a
  year-by-month performance-ratio heatmap (generation ÷ GHI ÷ kWp), generation versus
  GHI, and the PVGIS card.
- **Cleaning intelligence** (`/app/cleaning/`) — the counterfactual ("wash now, worth
  ₹X" vs "wait for rain") plus a five-rung **action ladder** — soiling → shading →
  wiring → inverter → grid — where each rung is computed from the owner's own records
  and the first `ACT` is the job for today. Manual kWh logging and wash history feed
  the loop when PVOutput is not wired up.

Alerts and a daily digest (`manage.py publish_digest`) go to **Amazon SNS** as email —
DLT compliance makes SMS impractical for Indian traffic, so email is the honest channel.

## Where AWS fits

| Service | Use |
|---|---|
| **Elastic Beanstalk** (EC2 t3.micro) | Django + gunicorn + nginx; `eb deploy` from the repo |
| **S3** | Application versions for every deploy |
| **CloudWatch** | EB log streaming (`eb logs --stream`) |
| **SNS** | Outage alerts + daily digest emails |
| **DynamoDB** | Dual-write mirror of onboarded systems (on-demand) |
| **IAM** | Deploy identity and EB service role |

## Honest limitations

- The validation window is **September monsoon** — the hardest month, and the reason
  the PVGIS annual gap is large. A full-year window will shrink it.
- Rain handling is a *median-gap* model for the counterfactual horizon; a real forecast
  feed would replace it cleanly behind the same interface.
- Soiling uses reanalysis aerosols, not site cameras; the cleaning log exists so human
  observations can correct the model.
- Single instance, SQLite behind the dual-mode adapter: fine for a demo and 100
  onboarding calls, not for 100,000. Aurora + read replicas is the obvious next step.
- Vendor webhooks (Enphase/Growatt) are stubbed behind the PVOutput bridge; direct
  integrations are a stretch goal, not a claim.

## What's next

Tier-1 "paste your PVOutput link" import, forecast-aware rain windows, CloudWatch
alarms on the residual metric, and county-level extrapolation of recoverable energy
using Atlas PVOUT for any coordinates in India.

---

**AI tools:** this project was built with **opencode** (AI coding agent) — scaffolding,
the ingest pipeline, the pvlib physics port, tests, templates and docs. Every
AI-generated change was reviewed and verified locally (`pytest`, 50 green tests,
physics oracles frozen from real engine runs on this machine) before each commit.
