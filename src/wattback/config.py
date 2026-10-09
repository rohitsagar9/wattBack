import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "config" / "sites.json"
RAW_DIR = ROOT / "data" / "raw"


def load_sites() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)["sites"]


def site(key: str) -> dict:
    sites = load_sites()
    if key not in sites:
        raise KeyError(f"unknown site {key!r}; known: {sorted(sites)}")
    return sites[key]


def raw_path(name: str) -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    return RAW_DIR / name
