"""Test fixtures.

SYNTHETIC DATA NOTICE: ``synthetic_rows`` generates artificial quotes purely to exercise the code
paths deterministically. It lives only in the test suite and is never written to the application
database or shown in the UI.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from aureon.config import Settings  # noqa: E402
from aureon.data.store import Store  # noqa: E402
from aureon.specs import SPECS  # noqa: E402


def month_end_bday(y: int, m: int) -> date:
    d = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def fifth_bday(y: int, m: int) -> date:
    d = date(y, m, 5)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def synthetic_rows(n_days: int = 420, seed: int = 7, carry: float = 0.07, guinea_spread_bps: float = 0.0,
                   ou_sigma_bps: float = 8.0, start: date = date(2024, 1, 1)) -> list[dict]:
    """Artificial MCX-like rows: a common fine-gold spot random walk, exact carry pricing per expiry,
    and an optional mean-reverting premium on GOLDGUINEA."""
    rng = np.random.default_rng(seed)
    days = [d.date() for d in pd.bdate_range(start, periods=n_days)]
    spot = 60000 * np.exp(np.cumsum(rng.normal(0, 0.008, n_days)))
    ou = np.zeros(n_days)
    for i in range(1, n_days):
        ou[i] = ou[i - 1] * 0.8 + rng.normal(0, ou_sigma_bps)
    rows = []
    for i, d in enumerate(days):
        for sym, spec in SPECS.items():
            if sym == "GOLD":
                continue
            # live expiries: next 4 months
            for k in range(0, 4):
                y, m = d.year + (d.month + k - 1) // 12, (d.month + k - 1) % 12 + 1
                exp = fifth_bday(y, m) if sym == "GOLDM" else month_end_bday(y, m)
                if exp < d:
                    continue
                tau = (exp - d).days / 365.0
                fine10 = spot[i] * np.exp(carry * tau)
                if sym == "GOLDGUINEA":
                    fine10 *= np.exp((guinea_spread_bps + ou[i]) / 1e4)
                quote = fine10 * spec.purity / 1000.0 * spec.quote_grams / 10.0
                close = float(round(quote / spec.tick) * spec.tick)
                vol = float(500 if k < 2 else 0)
                hi = round(close * 1.003)
                lo = round(close * 0.997)
                value = round(vol * close * spec.quote_units_per_lot / 1e5, 2) if vol else 0.0
                rows.append({"trade_date": d.isoformat(), "symbol": sym, "expiry": exp.isoformat(),
                             "open": close if vol else None, "high": hi if vol else None, "low": lo if vol else None,
                             "close": close, "prev_close": close, "volume_lots": vol, "value_lakhs": value,
                             "open_interest": 5000.0 if k < 2 else 0.0})
    return rows


@pytest.fixture
def tmp_settings(tmp_path) -> Settings:
    s = Settings(data_dir=tmp_path / "data")
    for d in (s.data_dir, s.raw_dir, s.import_dir):
        d.mkdir(parents=True, exist_ok=True)
    return s


@pytest.fixture
def store(tmp_settings) -> Store:
    st = Store(tmp_settings.database)
    yield st
    st.close()


@pytest.fixture
def synthetic_store(store) -> Store:
    store.upsert_quotes(synthetic_rows(guinea_spread_bps=20.0), source="synthetic_test", raw_id=None)
    return store


# Verbatim excerpt of the official MCX date-wise bhavcopy response for 23 Oct 2026 (FUTCOM),
# used to test parsing and validation against the real format.
MCX_SAMPLE = {
    "IsSuccess": True, "Message": "Request was successful",
    "Data": [
        {"sLTT": None, "Date": "10/23/2026", "Symbol": "GOLDM        ", "ExpiryDate": "05NOV2026", "Open": 140802,
         "High": 141500, "Low": 139772, "Close": 140453, "PreviousClose": 141802, "Volume": 39364,
         "VolumeInThousands": "3936.400 GRMS ", "Value": 553872.9, "OpenInterest": 42924, "DateDisplay": "23 Oct 2026",
         "InstrumentName": "FUTCOM", "StrikePrice": 0.00, "OptionType": "-"},
        {"sLTT": None, "Date": "10/23/2026", "Symbol": "GOLDPETAL    ", "ExpiryDate": "30OCT2026", "Open": 14231,
         "High": 14250, "Low": 14088, "Close": 14155, "PreviousClose": 14287, "Volume": 165873,
         "VolumeInThousands": "165.873 GRMS ", "Value": 23509.95, "OpenInterest": 126729, "DateDisplay": "23 Oct 2026",
         "InstrumentName": "FUTCOM", "StrikePrice": 0.00, "OptionType": "-"},
        {"sLTT": None, "Date": "10/23/2026", "Symbol": "GOLDGUINEA   ", "ExpiryDate": "30OCT2026", "Open": 113701,
         "High": 113976, "Low": 112644, "Close": 113168, "PreviousClose": 114285, "Volume": 9017,
         "VolumeInThousands": "72.136 GRMS ", "Value": 10214.63, "OpenInterest": 10582, "DateDisplay": "23 Oct 2026",
         "InstrumentName": "FUTCOM", "StrikePrice": 0.00, "OptionType": "-"},
        {"sLTT": None, "Date": "10/23/2026", "Symbol": "GOLDTEN      ", "ExpiryDate": "30OCT2026", "Open": 141444,
         "High": 141872, "Low": 140130, "Close": 140832, "PreviousClose": 142223, "Volume": 16895,
         "VolumeInThousands": "168.950 GRMS ", "Value": 23829.92, "OpenInterest": 22198, "DateDisplay": "23 Oct 2026",
         "InstrumentName": "FUTCOM", "StrikePrice": 0.00, "OptionType": "-"},
        {"sLTT": None, "Date": "10/23/2026", "Symbol": "GOLD         ", "ExpiryDate": "05AUG2027", "Open": 0, "High": 0,
         "Low": 0, "Close": 153479, "PreviousClose": 153479, "Volume": 0, "VolumeInThousands": "0.000 GRMS ",
         "Value": 0, "OpenInterest": 0, "DateDisplay": "23 Oct 2026", "InstrumentName": "FUTCOM",
         "StrikePrice": 0.00, "OptionType": "-"},
        {"sLTT": None, "Date": "10/23/2026", "Symbol": "ALUMINI      ", "ExpiryDate": "30OCT2026", "Open": 325.60,
         "High": 329.65, "Low": 324.30, "Close": 328.80, "PreviousClose": 325.05, "Volume": 3005,
         "VolumeInThousands": "3005.000 KGS  ", "Value": 9842.65, "OpenInterest": 1358, "DateDisplay": "23 Oct 2026",
         "InstrumentName": "FUTCOM", "StrikePrice": 0.00, "OptionType": "-"},
    ],
}
