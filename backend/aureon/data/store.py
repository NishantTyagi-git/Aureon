"""SQLite persistence.

Three layers are kept strictly apart:

* ``raw_payloads`` – every payload exactly as received (never modified, content-hashed).
* ``quotes``       – validated, parsed daily observations, one row per (date, symbol, expiry).
* ``rejections``   – rows that failed validation, with the reason, so nothing disappears silently.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

import pandas as pd

SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_payloads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    request       TEXT,
    fetched_at    TEXT NOT NULL,
    sha256        TEXT NOT NULL UNIQUE,
    content_type  TEXT,
    payload       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
    trade_date    TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    expiry        TEXT NOT NULL,
    open          REAL,
    high          REAL,
    low           REAL,
    close         REAL,
    prev_close    REAL,
    volume_lots   REAL,
    value_lakhs   REAL,
    open_interest REAL,
    source        TEXT NOT NULL,
    raw_id        INTEGER REFERENCES raw_payloads(id),
    ingested_at   TEXT NOT NULL,
    PRIMARY KEY (trade_date, symbol, expiry)
);
CREATE INDEX IF NOT EXISTS ix_quotes_symbol ON quotes(symbol, expiry, trade_date);
CREATE TABLE IF NOT EXISTS rejections (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_id        INTEGER REFERENCES raw_payloads(id),
    trade_date    TEXT,
    symbol        TEXT,
    expiry        TEXT,
    reason        TEXT NOT NULL,
    detail        TEXT,
    row_json      TEXT,
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS duplicates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date    TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    expiry        TEXT NOT NULL,
    kept_raw_id   INTEGER,
    other_raw_id  INTEGER,
    identical     INTEGER NOT NULL,
    diff          TEXT,
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingest_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    status        TEXT NOT NULL,
    detail        TEXT
);
"""

QUOTE_FIELDS = ("open", "high", "low", "close", "prev_close", "volume_lots", "value_lakhs", "open_interest")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._version = 0

    # ---------------------------------------------------------------- utilities
    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
                self._version += 1
            except Exception:
                self._conn.rollback()
                raise

    @property
    def version(self) -> int:
        """Monotonic counter bumped on every write; used to invalidate analytics caches."""
        return self._version

    def close(self) -> None:
        self._conn.close()

    # ---------------------------------------------------------------- raw layer
    def add_raw(self, source: str, payload: str, request: dict | None = None,
                content_type: str = "application/json") -> tuple[int, bool]:
        """Store a raw payload verbatim. Returns (id, created). Identical payloads are deduplicated."""
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        with self.tx() as c:
            row = c.execute("SELECT id FROM raw_payloads WHERE sha256=?", (digest,)).fetchone()
            if row:
                return int(row["id"]), False
            cur = c.execute(
                "INSERT INTO raw_payloads(source, request, fetched_at, sha256, content_type, payload) VALUES (?,?,?,?,?,?)",
                (source, json.dumps(request or {}), utcnow(), digest, content_type, payload),
            )
            return int(cur.lastrowid), True

    def raw_payload(self, raw_id: int) -> dict | None:
        row = self._conn.execute("SELECT * FROM raw_payloads WHERE id=?", (raw_id,)).fetchone()
        return dict(row) if row else None

    def raw_summary(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, source, request, fetched_at, sha256, content_type, length(payload) AS bytes "
            "FROM raw_payloads ORDER BY id DESC LIMIT 500").fetchall()
        return [dict(r) for r in rows]

    # ---------------------------------------------------------------- quotes
    def upsert_quotes(self, rows: Iterable[dict], source: str, raw_id: int | None) -> dict:
        """Insert validated quotes. Existing keys are never overwritten silently: a conflict is logged
        in ``duplicates`` and the first-ingested observation is kept."""
        inserted = identical = conflicts = 0
        now = utcnow()
        with self.tx() as c:
            for r in rows:
                key = (r["trade_date"], r["symbol"], r["expiry"])
                existing = c.execute(
                    "SELECT * FROM quotes WHERE trade_date=? AND symbol=? AND expiry=?", key).fetchone()
                if existing is None:
                    c.execute(
                        "INSERT INTO quotes(trade_date, symbol, expiry, open, high, low, close, prev_close, volume_lots,"
                        " value_lakhs, open_interest, source, raw_id, ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (*key, *(r.get(f) for f in QUOTE_FIELDS), source, raw_id, now),
                    )
                    inserted += 1
                    continue
                diff = {f: [existing[f], r.get(f)] for f in QUOTE_FIELDS
                        if not _same(existing[f], r.get(f))}
                if not diff:
                    identical += 1
                    if existing["raw_id"] == raw_id:
                        continue
                else:
                    conflicts += 1
                c.execute(
                    "INSERT INTO duplicates(trade_date, symbol, expiry, kept_raw_id, other_raw_id, identical, diff, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (*key, existing["raw_id"], raw_id, int(not diff), json.dumps(diff) if diff else None, now),
                )
        return {"inserted": inserted, "identical_duplicates": identical, "conflicting_duplicates": conflicts}

    def add_rejections(self, items: Iterable[dict], raw_id: int | None) -> int:
        n = 0
        now = utcnow()
        with self.tx() as c:
            for it in items:
                c.execute(
                    "INSERT INTO rejections(raw_id, trade_date, symbol, expiry, reason, detail, row_json, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (raw_id, it.get("trade_date"), it.get("symbol"), it.get("expiry"), it["reason"],
                     it.get("detail"), json.dumps(it.get("row"), default=str), now),
                )
                n += 1
        return n

    def quotes_frame(self, symbols: Iterable[str] | None = None) -> pd.DataFrame:
        q = "SELECT * FROM quotes"
        params: list = []
        if symbols:
            syms = list(symbols)
            q += f" WHERE symbol IN ({','.join('?' * len(syms))})"
            params = syms
        df = pd.read_sql_query(q + " ORDER BY trade_date, symbol, expiry", self._conn, params=params)
        if df.empty:
            return df
        df["trade_date"] = pd.to_datetime(df["trade_date"])
        df["expiry"] = pd.to_datetime(df["expiry"])
        return df

    def rejections_frame(self) -> pd.DataFrame:
        return pd.read_sql_query("SELECT * FROM rejections ORDER BY id DESC", self._conn)

    def duplicates_frame(self) -> pd.DataFrame:
        return pd.read_sql_query("SELECT * FROM duplicates ORDER BY id DESC", self._conn)

    # ---------------------------------------------------------------- ingest runs
    def start_run(self, source: str, detail: dict | None = None) -> int:
        with self.tx() as c:
            cur = c.execute("INSERT INTO ingest_runs(source, started_at, status, detail) VALUES (?,?,?,?)",
                            (source, utcnow(), "running", json.dumps(detail or {})))
            return int(cur.lastrowid)

    def finish_run(self, run_id: int, status: str, detail: dict) -> None:
        with self.tx() as c:
            c.execute("UPDATE ingest_runs SET finished_at=?, status=?, detail=? WHERE id=?",
                      (utcnow(), status, json.dumps(detail, default=str), run_id))

    def runs(self, limit: int = 50) -> list[dict]:
        rows = self._conn.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["detail"] = json.loads(d["detail"] or "{}")
            except json.JSONDecodeError:
                pass
            out.append(d)
        return out

    def counts(self) -> dict:
        c = self._conn
        return {
            "raw_payloads": c.execute("SELECT count(*) FROM raw_payloads").fetchone()[0],
            "quotes": c.execute("SELECT count(*) FROM quotes").fetchone()[0],
            "rejections": c.execute("SELECT count(*) FROM rejections").fetchone()[0],
            "duplicates": c.execute("SELECT count(*) FROM duplicates").fetchone()[0],
        }


def _same(a, b, tol: float = 1e-9) -> bool:
    if a is None or b is None:
        return a is None and b is None
    try:
        return abs(float(a) - float(b)) <= tol * max(1.0, abs(float(a)))
    except (TypeError, ValueError):
        return a == b
