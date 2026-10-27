"""Prebuild a deployment: database from the bundled seed data plus ready-made answers for every
read-only page request, so a small hosted instance never has to import data or run heavy analytics
on a page load.

    python run.py prebuild

The answers are produced by calling the real API, so they are byte-for-byte what a live request
would return. They are tied to a fingerprint of the database and are only served in read-only mode
while that fingerprint still matches.
"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

from .config import Settings
from .data.pipeline import seed_if_empty
from .data.store import Store
from .specs import ALL_SYMBOLS, RESEARCH_SYMBOLS

log = logging.getLogger(__name__)

LOOKBACKS = (20, 40, 60, 120, 250)  # the "What counts as normal?" choices in the UI


def request_key(path: str, query: str) -> str:
    """Canonical key for a GET request: path plus sorted query parameters."""
    params = sorted(parse_qsl(query, keep_blank_values=False))
    return path + ("?" + urlencode(params) if params else "")


def file_name(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest() + ".json"


def fingerprint(store: Store) -> str:
    cov, counts = store.coverage(), store.counts()
    return f"{counts['quotes']}|{cov['first_date']}|{cov['last_date']}|{counts['raw_payloads']}"


def page_requests() -> list[str]:
    """GET requests the frontend makes with default settings (same parameter spelling as api.js)."""
    reqs = ["/api/specs", "/api/overview", "/api/quality", "/api/contracts", "/api/relative-value/matrix"]
    for s in ALL_SYMBOLS:
        reqs.append(f"/api/term-structure?symbol={s}")
    for a in RESEARCH_SYMBOLS:
        for b in RESEARCH_SYMBOLS:
            if a == b:
                continue
            for lb in LOOKBACKS:
                q = {"a": a, "b": b, "lookback": lb, "min_dte": 10, "max_gap": 10, "carry": "true",
                     "min_obs": min(30, lb)}
                reqs.append("/api/relative-value?" + urlencode(q))
    return reqs


def prebuild(settings: Settings) -> dict:
    from fastapi.testclient import TestClient

    from .api import create_app
    from .service import Service

    store = Store(settings.database)
    seeded = seed_if_empty(store, settings)
    out_dir = settings.prebuilt_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.json"):
        old.unlink()

    client = TestClient(create_app(Service(settings, store)))
    index = {}
    for url in page_requests():
        path, _, query = url.partition("?")
        r = client.get(url)
        if r.status_code != 200:
            log.warning("prebuild skipped %s (HTTP %s)", url, r.status_code)
            continue
        key = request_key(path, query)
        name = file_name(key)
        (out_dir / name).write_bytes(r.content)
        index[key] = name
    manifest = {"fingerprint": fingerprint(store), "index": index}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    store.close()
    log.info("prebuilt %d responses into %s", len(index), out_dir)
    return {"seeded_files": [s["file"] for s in seeded], "responses": len(index), "fingerprint": manifest["fingerprint"]}


def load_prebuilt(settings: Settings, store: Store) -> dict[str, Path]:
    """Return {request key: file} when prebuilt answers exist and match the current data, else {}."""
    manifest_path = settings.prebuilt_dir / "manifest.json"
    if not manifest_path.exists():
        return {}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if manifest.get("fingerprint") != fingerprint(store):
        log.warning("prebuilt answers ignored: they were built from different data")
        return {}
    return {k: settings.prebuilt_dir / v for k, v in manifest.get("index", {}).items()}
