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

1. **Expected vs actual** — physics baseline (pvlib PVWatts, ERA5 GHI, Global Solar
   Atlas LTA) blended with a leakage-safe LightGBM trained walk-forward on real output
2. **Loss decomposition** — temperature, inverter clipping, AOI, soiling, outage →
   a daily waterfall that closes to ~0.1% on held-out systems
3. **Cleaning counterfactual** — "how many days until the next rain, and what is a
   clean worth in ₹?"
4. **Outage detection** — rules over residual + raw output → alerts for multi-day
   generation collapses
5. **Global extrapolation** — headline recoverable energy at India / world scale
6. **Dashboard on AWS** — Day 3

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
                                     │
                    ┌────────────────┴─────────────────┐
                    ▼                                  ▼
        [Day 2] loss engine + oracle tests    [Day 3] dashboard on AWS
                    └─▶ LightGBM (walk-forward, leakage-safe)
```

## Quickstart

```bash
pip install -r requirements.txt
python scripts/import_raw.py   # merge + flag source JSONs → data/raw/
python scripts/seed.py         # Atlas + ERA5 (PVOutput window needs a logged-in session)
pytest                         # data-integrity + parser tests
```

## Reproducibility

- Source JSONs are committed under `data/source/`; the importer is deterministic
  (dedupe by site+date, first source wins, anchored kWh/kW parsing drops chart junk).
- Tests assert full-span contiguity (≤15 known logging gaps in 2,099 days), exact
  flag counts, and totals against known account statistics.
- Expected-gen targets for the loss engine are frozen in Day-2 oracle tests
  (held-out unexplained residual ≈ 0.1%/day).

## Roadmap

- **Day 2 (in progress)** — loss engine → oracle tests → cleaning counterfactual →
  outage detector → LightGBM residual model
- **Day 3** — AWS deployment (Lambda/API + static dashboard), "Add your system":
  - *Tier 1* — paste a PVOutput system link
  - *Tier 2* — upload a PVOutput/monitor CSV export
  - *Tier 3 (roadmap)* — vendor API / hardware sync (Enphase, Growatt, etc.)
- **Day 4** — 3-min demo video, writeup, submission audit

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
- pvlib-python — PVWatts / system modeling
