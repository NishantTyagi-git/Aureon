"""Ingestion pipeline: raw payload → archive → parse → validate → store."""
from __future__ import annotations

import json
import logging
import shutil
from datetime import date, timedelta
from pathlib import Path

from ..config import Settings
from ..specs import ALL_SYMBOLS
from .parsers import ParseResult, detect_and_parse, parse_tinyfish
from .store import Store
from .tinyfish import TinyFishClient, TinyFishError
from .validation import validate_rows

log = logging.getLogger(__name__)


def _archive(settings: Settings, source: str, raw_id: int, text: str, suffix: str) -> None:
    folder = settings.raw_dir / source
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{raw_id:06d}{suffix}"
    if not target.exists():
        target.write_text(text, encoding="utf-8")


def ingest_parsed(store: Store, parsed: ParseResult, source: str, raw_id: int | None) -> dict:
    good, bad = validate_rows(parsed.rows)
    bad = parsed.rejections + bad
    stats = store.upsert_quotes(good, source=source, raw_id=raw_id)
    store.add_rejections(bad, raw_id=raw_id)
    out = {**parsed.summary(), **stats, "validated": len(good), "rejected": len(bad), "raw_id": raw_id}
    reasons: dict[str, int] = {}
    for b in bad:
        reasons[b["reason"]] = reasons.get(b["reason"], 0) + 1
    out["rejection_reasons"] = reasons
    return out


def ingest_text(store: Store, settings: Settings, text: str, source: str, request: dict | None = None,
                filename: str = "") -> dict:
    content_type = "text/csv" if not text.lstrip("﻿").lstrip().startswith(("{", "[")) else "application/json"
    raw_id, created = store.add_raw(source, text, request, content_type)
    _archive(settings, source, raw_id, text, ".csv" if content_type == "text/csv" else ".json")
    try:
        parsed = detect_and_parse(text, filename)
    except (json.JSONDecodeError, ValueError) as exc:
        store.add_rejections([{"reason": "parse_error", "detail": str(exc), "row": filename}], raw_id)
        return {"raw_id": raw_id, "error": f"could not parse payload: {exc}"}
    result = ingest_parsed(store, parsed, source, raw_id)
    result["new_raw_payload"] = created
    log.info("ingested %s (%s): %s", filename or source, parsed.format, result)
    return result


def ingest_import_dir(store: Store, settings: Settings) -> list[dict]:
    """Ingest every *.json / *.csv dropped into data/import, then move it to data/import/processed."""
    processed = settings.import_dir / "processed"
    processed.mkdir(exist_ok=True)
    results = []
    for path in sorted(settings.import_dir.glob("*")):
        if path.suffix.lower() not in (".json", ".csv") or not path.is_file():
            continue
        run_id = store.start_run("file_import", {"file": path.name})
        try:
            text = path.read_text(encoding="utf-8-sig")
            res = ingest_text(store, settings, text, source="file_import", request={"file": path.name},
                              filename=path.name)
            store.finish_run(run_id, "error" if "error" in res else "ok", res)
            shutil.move(str(path), processed / path.name)
            results.append({"file": path.name, **res})
        except Exception as exc:  # keep going with other files
            log.exception("import failed for %s", path)
            store.finish_run(run_id, "error", {"error": str(exc)})
            results.append({"file": path.name, "error": str(exc)})
    return results


def _client(settings: Settings) -> TinyFishClient:
    if not settings.tinyfish_api_key:
        raise TinyFishError("TINYFISH_API_KEY is not set (see .env.example)")
    return TinyFishClient(settings.tinyfish_api_key, settings.tinyfish_base_url, settings.tinyfish_timeout_s,
                          settings.tinyfish_browser_profile, settings.tinyfish_proxy_country)


def collect_tinyfish_contract(store: Store, settings: Settings, symbol: str, expiry: date, start: date, end: date,
                              client: TinyFishClient | None = None) -> dict:
    """Collect one contract over a date range via the bhavcopy 'Commodity Wise' tab."""
    client = client or _client(settings)
    req = {"symbol": symbol, "expiry": expiry.isoformat(), "start": start.isoformat(), "end": end.isoformat()}
    run_id = store.start_run("tinyfish", req)
    try:
        run = client.bhavcopy_for_contract(symbol, expiry, start, end)
        text = json.dumps(run, default=str)
        raw_id, _ = store.add_raw("tinyfish", text, {**req, "run_id": run.get("run_id")})
        _archive(settings, "tinyfish", raw_id, text, ".json")
        res = ingest_parsed(store, parse_tinyfish(run), "tinyfish", raw_id)
        store.finish_run(run_id, "ok", res)
        return res
    except Exception as exc:  # noqa: BLE001
        store.finish_run(run_id, "error", {"error": str(exc)})
        raise


def collect_tinyfish(store: Store, settings: Settings, start: date, end: date,
                     symbols: tuple[str, ...] = ALL_SYMBOLS, skip_existing: bool = True,
                     client: TinyFishClient | None = None) -> dict:
    """Collect daily bhavcopy rows through TinyFish for each weekday in [start, end]."""
    client = client or _client(settings)
    have = set()
    if skip_existing:
        df = store.quotes_frame()
        if not df.empty:
            have = set(df["trade_date"].dt.date.unique())
    run_id = store.start_run("tinyfish", {"start": start.isoformat(), "end": end.isoformat()})
    days, summary = [], {"requested": 0, "skipped_existing": 0, "ok": 0, "failed": 0}
    d = start
    while d <= end:
        if d.weekday() < 5:
            if d in have:
                summary["skipped_existing"] += 1
            else:
                summary["requested"] += 1
                try:
                    run = client.bhavcopy_for_date(d, symbols)
                    text = json.dumps(run, default=str)
                    raw_id, _ = store.add_raw("tinyfish", text, {"date": d.isoformat(), "run_id": run.get("run_id")})
                    _archive(settings, "tinyfish", raw_id, text, ".json")
                    res = ingest_parsed(store, parse_tinyfish(run), "tinyfish", raw_id)
                    summary["ok"] += 1
                    days.append({"date": d.isoformat(), **res})
                except (TinyFishError, Exception) as exc:  # noqa: BLE001 - record and continue
                    log.warning("TinyFish collection failed for %s: %s", d, exc)
                    summary["failed"] += 1
                    days.append({"date": d.isoformat(), "error": str(exc)})
        d += timedelta(days=1)
    store.finish_run(run_id, "ok" if summary["failed"] == 0 else "partial", {**summary, "days": days})
    return {**summary, "days": days}
