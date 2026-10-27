"""TinyFish web-agent client used to collect MCX bhavcopy data.

MCX's site sits behind bot protection, so plain HTTP clients are refused. TinyFish drives a real
browser session on the official bhavcopy page and returns the table as structured JSON.

Because TinyFish is LLM-driven, its output is *untrusted*: every row goes through the same
validation as any other source, including the turnover-vs-price consistency check that catches
transcription errors (see :mod:`aureon.data.validation`). The full TinyFish response is stored
verbatim in ``raw_payloads`` before parsing.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from datetime import date

import httpx

log = logging.getLogger(__name__)

BHAVCOPY_URL = "https://www.mcxindia.com/market-data/bhavcopy"

ROW_SCHEMA = {
    "type": "object",
    "properties": {
        "date": {"type": "string"},
        "rows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "commodity": {"type": "string"},
                    "expiry": {"type": "string"},
                    "open": {"type": "number", "nullable": True},
                    "high": {"type": "number", "nullable": True},
                    "low": {"type": "number", "nullable": True},
                    "close": {"type": "number", "nullable": True},
                    "prev_close": {"type": "number", "nullable": True},
                    "volume_lots": {"type": "number", "nullable": True},
                    "value_lakhs": {"type": "number", "nullable": True},
                    "open_interest": {"type": "number", "nullable": True},
                },
                "required": ["commodity", "expiry", "close"],
            },
        },
        "no_data_reason": {"type": "string", "nullable": True},
    },
    "required": ["rows"],
}


def date_goal(d: date, symbols: tuple[str, ...]) -> str:
    return (
        "On the MCX Bhav Copy page use the 'Date Wise' tab. Set Instrument to FUTCOM, set the Date to "
        f"{d.strftime('%d %B %Y')} and click Show. The result table is paginated: visit every page. "
        f"Collect every row whose Commodity is exactly one of: {', '.join(symbols)}. "
        "Copy each value exactly as displayed (Open, High, Low, Close, PCP as prev_close, Vol (Lots) as volume_lots, "
        "Value (Lakhs) as value_lakhs, OI (Lots) as open_interest, Expiry Date as expiry in the displayed form "
        "e.g. 30OCT2026). Never round, estimate, infer or invent values; use null for blank cells. "
        f"Set date to {d.isoformat()}. If the exchange shows no data for this date (holiday), return an empty "
        "rows list and explain in no_data_reason."
    )


def contract_goal(symbol: str, expiry: date, start: date, end: date) -> str:
    """Goal for the 'Commodity Wise' tab: one contract over a date range (fewer runs than per-day)."""
    return (
        "On this MCX Bhav Copy page click the 'Commodity Wise' tab. Set Instrument = FUTCOM, "
        f"Commodity = {symbol}, Expiry = {expiry.strftime('%d%b%Y').upper()}, From date = {start.strftime('%d %B %Y')}, "
        f"To date = {end.strftime('%d %B %Y')}, then click Show. Read the resulting table on every page of the "
        "pagination. For each row return: date, commodity, expiry, open, high, low, close, prev_close (PCP), "
        "volume_lots (Vol (Lots)), value_lakhs (Value (Lakhs)), open_interest (OI (Lots)). Copy numbers exactly as "
        "displayed without rounding or inventing; use null for blank cells. If the form cannot be submitted, "
        "explain why in no_data_reason."
    )


CONTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "rows": {"type": "array", "items": {
            "type": "object",
            "properties": {"date": {"type": "string"}, **ROW_SCHEMA["properties"]["rows"]["items"]["properties"]},
            "required": ["date", "commodity", "expiry", "close"]}},
        "no_data_reason": {"type": "string", "nullable": True},
    },
    "required": ["rows"],
}


class TinyFishError(RuntimeError):
    pass


@dataclass
class TinyFishClient:
    api_key: str
    base_url: str = "https://agent.tinyfish.ai"
    timeout_s: int = 600
    browser_profile: str = "stealth"
    proxy_country: str | None = "IN"
    poll_interval_s: float = 10.0

    def _headers(self) -> dict:
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    def start(self, url: str, goal: str, output_schema: dict | None = None) -> str:
        body: dict = {"url": url, "goal": goal, "browser_profile": self.browser_profile,
                      "agent_config": {"max_duration_seconds": self.timeout_s}}
        if output_schema:
            body["output_schema"] = output_schema
        if self.proxy_country:
            body["proxy_config"] = {"enabled": True, "type": "tinyfish", "country_code": self.proxy_country}
        r = httpx.post(f"{self.base_url}/v1/automation/run-async", json=body, headers=self._headers(), timeout=60)
        if r.status_code >= 400:
            raise TinyFishError(f"TinyFish HTTP {r.status_code}: {r.text[:300]}")
        data = r.json()
        if data.get("error") or not data.get("run_id"):
            raise TinyFishError(f"TinyFish refused run: {data.get('error')}")
        return data["run_id"]

    def get(self, run_id: str) -> dict:
        r = httpx.get(f"{self.base_url}/v1/runs/{run_id}", headers=self._headers(), timeout=60)
        if r.status_code >= 400:
            raise TinyFishError(f"TinyFish HTTP {r.status_code}: {r.text[:300]}")
        return r.json()

    def wait(self, run_id: str) -> dict:
        deadline = time.monotonic() + self.timeout_s + 120
        while time.monotonic() < deadline:
            run = self.get(run_id)
            if run.get("status") in ("COMPLETED", "FAILED", "CANCELLED"):
                return run
            time.sleep(self.poll_interval_s)
        raise TinyFishError(f"TinyFish run {run_id} did not finish in time")

    def bhavcopy_for_date(self, d: date, symbols: tuple[str, ...]) -> dict:
        run_id = self.start(BHAVCOPY_URL, date_goal(d, symbols), ROW_SCHEMA)
        log.info("TinyFish run %s started for %s", run_id, d)
        run = self.wait(run_id)
        if run.get("status") != "COMPLETED":
            raise TinyFishError(f"TinyFish run {run_id} {run.get('status')}: {run.get('error')}")
        return run

    def bhavcopy_for_contract(self, symbol: str, expiry: date, start: date, end: date) -> dict:
        run_id = self.start(BHAVCOPY_URL, contract_goal(symbol, expiry, start, end), CONTRACT_SCHEMA)
        log.info("TinyFish run %s started for %s %s", run_id, symbol, expiry)
        run = self.wait(run_id)
        if run.get("status") != "COMPLETED":
            raise TinyFishError(f"TinyFish run {run_id} {run.get('status')}: {run.get('error')}")
        return run


def new_request_id() -> str:
    return str(uuid.uuid4())
