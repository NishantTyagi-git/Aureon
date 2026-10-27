"""The analytics panel: validated quotes enriched with contract specs and normalized prices.

Columns added
-------------
norm         ₹ per 10 g of fine gold  = close × 10/quote_grams × 1000/purity   (see specs.normalize_price)
norm_raw     ₹ per 10 g of contract-standard gold (no purity adjustment)
dte          calendar days from trade date to expiry
traded       volume_lots > 0 — only traded closes are treated as observed trade prices
lot_value    ₹ value of one lot at the close
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..specs import SPECS


def build_panel(quotes: pd.DataFrame, purity_adjust: bool = True) -> pd.DataFrame:
    if quotes.empty:
        cols = ["trade_date", "symbol", "expiry", "open", "high", "low", "close", "prev_close", "volume_lots",
                "value_lakhs", "open_interest", "source", "raw_id", "norm_raw", "norm", "norm_open", "dte", "traded",
                "lot_value", "fine_grams_lot", "volume_grams"]
        return pd.DataFrame(columns=cols).astype({"trade_date": "datetime64[ns]", "expiry": "datetime64[ns]",
                                                   "traded": bool})
    df = quotes.copy()
    df["symbol"] = df["symbol"].str.strip().str.upper()
    spec = df["symbol"].map(SPECS)
    quote_g = spec.map(lambda s: s.quote_grams)
    purity = spec.map(lambda s: s.purity)
    lot_g = spec.map(lambda s: s.lot_grams)
    df["norm_raw"] = df["close"] * 10.0 / quote_g
    df["norm"] = df["norm_raw"] * (1000.0 / purity if purity_adjust else 1.0)
    df["norm_open"] = np.where(df["open"].fillna(0) > 0, df["open"] * 10.0 / quote_g, np.nan)
    if purity_adjust:
        df["norm_open"] = df["norm_open"] * 1000.0 / purity
    df["dte"] = (df["expiry"] - df["trade_date"]).dt.days
    df["traded"] = df["volume_lots"].fillna(0) > 0
    df["lot_value"] = df["close"] * lot_g / quote_g
    df["fine_grams_lot"] = lot_g * purity / 1000.0
    df["volume_grams"] = df["volume_lots"].fillna(0) * lot_g
    return df.sort_values(["trade_date", "symbol", "expiry"]).reset_index(drop=True)


def trading_calendar(panel: pd.DataFrame) -> pd.DatetimeIndex:
    """Empirical exchange calendar: every date on which any gold contract was reported."""
    if panel.empty:
        return pd.DatetimeIndex([])
    return pd.DatetimeIndex(sorted(panel["trade_date"].unique()))
