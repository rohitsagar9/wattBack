"""Run the WattBack loss engine for one site/window.

usage: python scripts/run_loss.py --site bmt --start 2026-09-01 --end 2026-09-29
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from wattback.loss.counterfactual import cleaning_counterfactual  # noqa: E402
from wattback.loss.engine import report, run_engine  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, choices=["bmt", "manalil"])
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--json", action="store_true", help="dump totals as JSON")
    args = ap.parse_args()

    daily, meta = run_engine(args.site, args.start, args.end)
    print(report(meta))

    last = daily.iloc[-1]
    cf = cleaning_counterfactual(
        args.site,
        meta["end"],
        expected_per_day=float(daily["predicted"].tail(7).mean()),
        soiling_ratio=meta["soiling_end"],
    )
    print("\ncleaning counterfactual:")
    for k, v in cf.items():
        print(f"  {k}: {v}")

    if args.json:
        print(json.dumps(meta["totals"], indent=1))


if __name__ == "__main__":
    main()
