"""Parsers for the payload formats Aureon accepts. Parsers only *reshape* data; they never invent
values. Anything that cannot be parsed is returned as a rejection with a reason.

Supported formats
-----------------
* ``mcx_json``      – JSON returned by the MCX bhavcopy page (``{"IsSuccess":..,"Data":[...]}``).
* ``aureon_bundle`` – a bundle produced by the in-browser collector: ``{"aureon_bundle":1,"items":[{request,response}]}``.
* ``mcx_csv``       – CSV exported with the MCX bhavcopy page's own "CSV" button (or the legacy bhavcopy CSV).
* ``tinyfish``      – structured output returned by the TinyFish web agent (``{"date":..,"rows":[..]}``).
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
from datetime import date, datetime
from typing import Any

from ..specs import ALL_SYMBOLS

MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], start=1)}


class ParseResult:
    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.rejections: list[dict] = []
        self.skipped_out_of_universe = 0
        self.format: str | None = None

    def reject(self, reason: str, row: Any, detail: str = "", **keys) -> None:
        self.rejections.append({"reason": reason, "detail": detail, "row": row, **keys})

    def summary(self) -> dict:
        return {"format": self.format, "parsed": len(self.rows), "rejected": len(self.rejections),
                "skipped_out_of_universe": self.skipped_out_of_universe}


# ------------------------------------------------------------------ primitives
def parse_number(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    s = str(v).strip().replace(",", "").replace("₹", "")
    if s in ("", "-", "--", "NA", "N/A", "null", "None"):
        return None
    m = re.match(r"^-?\d+(\.\d+)?", s)
    if not m:
        raise ValueError(f"not a number: {v!r}")
    return float(m.group(0))


def parse_expiry(v: Any) -> date:
    s = str(v).strip().upper()
    m = re.match(r"^(\d{1,2})[-\s]?([A-Z]{3})[-\s]?(\d{4})$", s)
    if m and m.group(2) in MONTHS:
        return date(int(m.group(3)), MONTHS[m.group(2)], int(m.group(1)))
    return parse_trade_date(v)


def parse_trade_date(v: Any, numeric_order: str = "DMY") -> date:
    """Parse a trading date. Textual months are unambiguous; for purely numeric dates the caller must
    state the order (MCX JSON uses MM/DD/YYYY, MCX CSV exports use DD/MM/YYYY)."""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    for fmt in ("%d %b %Y", "%d-%b-%Y", "%d%b%Y", "%Y-%m-%d", "%d %B %Y", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(s.title() if "%b" in fmt or "%B" in fmt else s, fmt).date()
        except ValueError:
            pass
    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", s)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        d, mo = (a, b) if numeric_order == "DMY" else (b, a)
        return date(y, mo, d)
    raise ValueError(f"unrecognised date: {v!r}")


def _canon_row(trade_date: date, symbol: str, expiry: date, values: dict) -> dict:
    return {"trade_date": trade_date.isoformat(), "symbol": symbol, "expiry": expiry.isoformat(), **values}


# ------------------------------------------------------------------ MCX JSON
def parse_mcx_json(payload: dict | list, result: ParseResult | None = None) -> ParseResult:
    res = result or ParseResult()
    res.format = res.format or "mcx_json"
    data = payload.get("Data") if isinstance(payload, dict) else payload
    if isinstance(payload, dict) and payload.get("IsSuccess") is False:
        res.reject("source_error", payload, str(payload.get("Message")))
        return res
    for item in data or []:
        try:
            symbol = str(item.get("Symbol", "")).strip().upper()
            instrument = str(item.get("InstrumentName", "FUTCOM")).strip().upper()
            if instrument != "FUTCOM" or symbol not in ALL_SYMBOLS:
                res.skipped_out_of_universe += 1
                continue
            if item.get("DateDisplay"):
                td = parse_trade_date(item["DateDisplay"])
            else:
                td = parse_trade_date(item.get("Date"), numeric_order="MDY")
            ex = parse_expiry(item.get("ExpiryDate"))
            values = {
                "open": parse_number(item.get("Open")),
                "high": parse_number(item.get("High")),
                "low": parse_number(item.get("Low")),
                "close": parse_number(item.get("Close")),
                "prev_close": parse_number(item.get("PreviousClose")),
                "volume_lots": parse_number(item.get("Volume")),
                "value_lakhs": parse_number(item.get("Value")),
                "open_interest": parse_number(item.get("OpenInterest")),
            }
            res.rows.append(_canon_row(td, symbol, ex, values))
        except (ValueError, TypeError, AttributeError) as exc:
            res.reject("parse_error", item, str(exc))
    return res


def parse_bundle(payload: dict) -> ParseResult:
    res = ParseResult()
    res.format = "aureon_bundle"
    for it in payload.get("items", []):
        resp = it.get("response")
        if isinstance(resp, str):
            try:
                resp = json.loads(resp)
            except json.JSONDecodeError:
                res.reject("parse_error", it.get("request"), "bundle item response is not JSON")
                continue
        if resp is None:
            res.reject("source_error", it.get("request"), str(it.get("error") or "empty response"))
            continue
        parse_mcx_json(resp, res)
    return res


# ------------------------------------------------------------------ MCX CSV
CSV_ALIASES = {
    "date": "date", "trade date": "date", "tradedate": "date",
    "instrument": "instrument", "instrument name": "instrument", "instrumentname": "instrument",
    "commodity": "symbol", "symbol": "symbol",
    "expiry date": "expiry", "expirydate": "expiry", "expiry": "expiry",
    "open": "open", "high": "high", "low": "low", "close": "close",
    "pcp": "prev_close", "previous close": "prev_close", "prev close": "prev_close", "previousclose": "prev_close",
    "vol (lots)": "volume_lots", "volume(lots)": "volume_lots", "volume (lots)": "volume_lots", "volume": "volume_lots",
    "value (lakhs)": "value_lakhs", "value(lakhs)": "value_lakhs", "value": "value_lakhs",
    "oi (lots)": "open_interest", "open interest(lots)": "open_interest", "open interest (lots)": "open_interest",
    "openinterest": "open_interest", "open interest": "open_interest",
}


def parse_mcx_csv(text: str, numeric_date_order: str = "DMY") -> ParseResult:
    res = ParseResult()
    res.format = "mcx_csv"
    text = text.lstrip("﻿")
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        return res
    cols = [CSV_ALIASES.get(re.sub(r"\s+", " ", h.strip().strip('"').lower()), None) for h in header]
    if "symbol" not in cols or "close" not in cols or "expiry" not in cols or "date" not in cols:
        res.reject("parse_error", header, "CSV header not recognised as an MCX bhavcopy export")
        return res
    for raw in reader:
        if not any(x.strip() for x in raw):
            continue
        rec = {c: v.strip() for c, v in zip(cols, raw) if c}
        try:
            symbol = rec.get("symbol", "").upper()
            instrument = rec.get("instrument", "FUTCOM").upper() or "FUTCOM"
            if instrument != "FUTCOM" or symbol not in ALL_SYMBOLS:
                res.skipped_out_of_universe += 1
                continue
            td = parse_trade_date(rec["date"], numeric_order=numeric_date_order)
            ex = parse_expiry(rec["expiry"])
            values = {k: parse_number(rec.get(k)) for k in
                      ("open", "high", "low", "close", "prev_close", "volume_lots", "value_lakhs", "open_interest")}
            res.rows.append(_canon_row(td, symbol, ex, values))
        except (ValueError, KeyError) as exc:
            res.reject("parse_error", raw, str(exc))
    return res


# ------------------------------------------------------------------ TinyFish
def parse_tinyfish(payload: dict) -> ParseResult:
    """TinyFish rows come from an LLM-driven browser agent. They are parsed like any other source but
    validation (value/volume consistency, OHLC sanity) is what makes them trustworthy — or not."""
    res = ParseResult()
    res.format = "tinyfish"
    body = payload.get("result", payload) if isinstance(payload, dict) else {}
    if isinstance(body, dict) and "result" in body and isinstance(body["result"], dict):
        body = body["result"]
    default_date = body.get("date") if isinstance(body, dict) else None
    for item in (body.get("rows") if isinstance(body, dict) else None) or []:
        try:
            symbol = str(item.get("commodity") or item.get("symbol") or "").strip().upper()
            if symbol not in ALL_SYMBOLS:
                res.skipped_out_of_universe += 1
                continue
            td = parse_trade_date(item.get("date") or default_date)
            ex = parse_expiry(item.get("expiry"))
            values = {k: parse_number(item.get(k)) for k in
                      ("open", "high", "low", "close", "prev_close", "volume_lots", "value_lakhs", "open_interest")}
            res.rows.append(_canon_row(td, symbol, ex, values))
        except (ValueError, TypeError, AttributeError) as exc:
            res.reject("parse_error", item, str(exc))
    return res


# ------------------------------------------------------------------ dispatch
def detect_and_parse(text: str, filename: str = "") -> ParseResult:
    stripped = text.lstrip("﻿").lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        payload = json.loads(stripped)
        if isinstance(payload, dict) and payload.get("aureon_bundle"):
            return parse_bundle(payload)
        if isinstance(payload, dict) and ("rows" in payload or "result" in payload):
            return parse_tinyfish(payload)
        return parse_mcx_json(payload)
    return parse_mcx_csv(stripped)
