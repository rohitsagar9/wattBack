import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wattback.config import RAW_DIR  # noqa: E402

KWH_RE = re.compile(r"^\d+(?:\.\d+)?kWh$")
KW_RE = re.compile(r"^\d+(?:\.\d+)?kW$")
D8_RE = re.compile(r"^\d{8}$")

SOURCES = [
    ("bmt_full_242.json", "bmt"),
    ("bmt_full_1164.json", "manalil"),
    ("bmt_pre2026.json", "bmt"),
    ("gaps_82.json", None),
]

PARTIAL_DATES = {"2026-10-09"}
BMT_LOW_OUTPUT = ("2026-01-01", "2026-01-27")
OUTAGE_CLUSTERS = {
    "manalil": [("2025-04-11", "2025-05-04")],
    "bmt": [("2026-02-17", "2026-02-20")],
}
CORE_WINDOWS = {
    "bmt": ("2026-01-01", "2026-10-09"),
    "manalil": ("2023-06-24", "2026-10-09"),
}


def candidate_dirs():
    return [ROOT / "data" / "source", Path.home() / "Downloads"]


def find_source(name):
    for d in candidate_dirs():
        p = d / name
        if p.exists():
            return p
    return None


def parse_num(value, unit):
    if not isinstance(value, str) or not value.endswith(unit):
        return None
    try:
        return float(value[: -len(unit)])
    except ValueError:
        return None


def iso_date(d8):
    return f"{d8[:4]}-{d8[4:6]}-{d8[6:]}"


def load_rows():
    rows = {}
    dropped = 0
    for fname, forced_site in SOURCES:
        path = find_source(fname)
        if path is None:
            print(f"skip missing: {fname}")
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        kept = 0
        for r in raw:
            site = r.get("site") or forced_site
            gen = parse_num(r.get("generated"), "kWh")
            peak = parse_num(r.get("peak"), "kW")
            d = str(r.get("date", ""))
            if site is None or gen is None or peak is None or not D8_RE.match(d):
                dropped += 1
                continue
            key = (site, iso_date(d))
            if key in rows:
                continue
            rows[key] = {
                "site": site,
                "date": iso_date(d),
                "generated_kwh": gen,
                "peak_kw": peak,
                "peak_time": r.get("time") or "",
                "conditions": r.get("conditions") or "",
                "temp_text": r.get("temp") or "",
                "source": fname,
            }
            kept += 1
        print(f"{fname}: {len(raw)} rows -> {kept} kept")
    print(f"dropped junk/unparsable: {dropped}")
    return list(rows.values())


def flags_for(row):
    flags = []
    site, d = row["site"], row["date"]
    if d in PARTIAL_DATES:
        flags.append("partial")
    if site == "bmt" and BMT_LOW_OUTPUT[0] <= d <= BMT_LOW_OUTPUT[1]:
        flags.append("low_output")
    for lo, hi in OUTAGE_CLUSTERS.get(site, []):
        if lo <= d <= hi:
            flags.append("outage_suspect")
    if row["generated_kwh"] == 0:
        flags.append("zero")
    if row["source"] == "gaps_82.json":
        flags.append("gap_filled")
    return ";".join(flags)


def missing_days(dates, lo, hi):
    have = set(dates)
    out = []
    cur = date.fromisoformat(lo)
    end = date.fromisoformat(hi)
    while cur <= end:
        if cur.isoformat() not in have:
            out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def main():
    rows = load_rows()
    if not rows:
        sys.exit("no rows imported")
    df = pd.DataFrame(rows)
    df["flags"] = df.apply(flags_for, axis=1)
    failed = False
    for site, g in sorted(df.groupby("site")):
        g = g.sort_values("date").reset_index(drop=True)
        lo, hi = g["date"].min(), g["date"].max()
        missing_all = missing_days(g["date"], lo, hi)
        print(
            f"{site}: {len(g)} rows {lo} -> {hi} | "
            f"missing in span: {len(missing_all)}"
            + (f" e.g. {missing_all[:3]}" if missing_all else "")
        )
        core = CORE_WINDOWS.get(site)
        if core:
            core_missing = missing_days(g["date"], *core)
            if core_missing:
                failed = True
                print(f"  CORE WINDOW BROKEN, missing {len(core_missing)}: {core_missing[:5]}")
            else:
                print(f"  core window {core[0]}..{core[1]} contiguous OK")
        out = RAW_DIR / f"{site}_daily.csv"
        g.to_csv(out, index=False)
        flag_counts = g["flags"].value_counts().to_dict()
        print(f"  wrote {out.name} | total {g['generated_kwh'].sum():,.1f} kWh | flags {flag_counts}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
