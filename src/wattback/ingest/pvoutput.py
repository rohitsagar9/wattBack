import re
from typing import Any

import requests

from ..config import site as site_config

LIST_URL = "https://pvoutput.org/list.jsp"
KWH_RE = re.compile(r"^\d+(?:\.\d+)?kWh$")
DT_RE = re.compile(r"intraday\.jsp\?[^'\"]*?dt=(\d{8})")
TAG_RE = re.compile(r"<[^>]+>")
TD_RE = re.compile(r"<td[^>]*>([\s\S]*?)</td>")
TR_SPLIT_RE = re.compile(r"<tr[^>]*>")
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "WattBack/0.1 (+rohitsagar9/wattBack; data pipeline)"
    )
}


def parse_list_html(html: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for chunk in TR_SPLIT_RE.split(html):
        m = DT_RE.search(chunk)
        if not m:
            continue
        cells = [TAG_RE.sub("", c).strip() for c in TD_RE.findall(chunk)]
        c = cells[1:]
        if len(c) < 8:
            continue
        if not KWH_RE.fullmatch(c[1]):
            continue
        rows.append(
            {
                "date": m.group(1),
                "generated": c[1],
                "peak": c[4],
                "time": c[5],
                "conditions": c[6],
                "temp": c[7],
            }
        )
    return rows


def fetch_public_window(key: str, max_retries: int = 3) -> list[dict[str, Any]]:
    cfg = site_config(key)
    params = {"id": cfg["pvoutput_uid"], "sid": cfg["pvoutput_sid"], "o": "date"}
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            resp = requests.get(
                LIST_URL, params=params, headers=HEADERS, timeout=30
            )
            resp.raise_for_status()
            rows = parse_list_html(resp.text)
            if rows:
                return [{"site": key, **r} for r in rows]
            last_err = RuntimeError(f"parsed 0 rows from {resp.url}")
        except Exception as exc:  # noqa: BLE001
            last_err = exc
        if attempt < max_retries - 1:
            import time

            time.sleep(2**attempt)
    raise RuntimeError(f"pvoutput fetch failed for {key}: {last_err}")
