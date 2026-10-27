"""Term structure: per-day futures curves, calendar spreads and implied carry.

Implied carry between two expiries T1 < T2 of the same product on the same day:

    r_implied = ln(F2 / F1) / ((T2 - T1) / 365)

This is the market-implied annualised cost of carry (financing + storage − convenience yield) under
continuous compounding. It is an *observed* quantity, not a forecast, and only uses traded closes.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def curve(panel: pd.DataFrame, symbol: str, date: pd.Timestamp) -> pd.DataFrame:
    c = panel[(panel["symbol"] == symbol) & (panel["trade_date"] == date)].sort_values("expiry")
    return c[["expiry", "dte", "close", "norm", "traded", "volume_lots", "open_interest"]].reset_index(drop=True)


def calendar_spreads(panel: pd.DataFrame, symbol: str, min_dte: int = 3, traded_only: bool = True) -> pd.DataFrame:
    """Front-vs-next calendar spread per day using the two nearest qualifying expiries."""
    cols = ["trade_date", "front_expiry", "next_expiry", "front_norm", "next_norm", "spread", "spread_bps",
            "days_between", "implied_carry", "front_dte"]
    if panel.empty:
        return pd.DataFrame(columns=cols)
    p = panel[(panel["symbol"] == symbol) & (panel["dte"] >= min_dte)]
    if traded_only:
        p = p[p["traded"]]
    # Two nearest qualifying expiries per day, side by side (vectorized; no per-day loop).
    p = p.sort_values(["trade_date", "expiry"])
    rank = p.groupby("trade_date").cumcount()
    f = p[rank == 0].set_index("trade_date")
    n = p[rank == 1].set_index("trade_date")
    m = f[["expiry", "norm", "dte"]].join(n[["expiry", "norm"]], how="inner", lsuffix="_f", rsuffix="_n")
    m["days_between"] = (m["expiry_n"] - m["expiry_f"]).dt.days
    m = m[m["days_between"] > 0]
    if m.empty:
        return pd.DataFrame(columns=cols)
    log_ratio = np.log(m["norm_n"] / m["norm_f"])
    out = pd.DataFrame({
        "trade_date": m.index, "front_expiry": m["expiry_f"].values, "next_expiry": m["expiry_n"].values,
        "front_norm": m["norm_f"].values, "next_norm": m["norm_n"].values,
        "spread": (m["norm_n"] - m["norm_f"]).values, "spread_bps": (1e4 * log_ratio).values,
        "days_between": m["days_between"].values, "implied_carry": (log_ratio / (m["days_between"] / 365.0)).values,
        "front_dte": m["dte"].astype(int).values,
    })
    return out[cols].reset_index(drop=True)


def carry_reference(panel: pd.DataFrame, symbols: tuple[str, ...] = ("GOLDM", "GOLD", "GOLDTEN", "GOLDPETAL"),
                    min_dte: int = 3, smooth: int = 5) -> pd.DataFrame:
    """Daily implied carry rate used to put contracts with different expiries on a common footing.

    Uses the first symbol in ``symbols`` with a valid front/next spread on each date (priority order),
    then a trailing median over ``smooth`` observations (causal: only past and current values) to damp
    noise from thin back months. Days with no estimate stay NaN — they are never filled forward
    beyond what the trailing median provides.
    """
    frames = []
    for i, s in enumerate(symbols):
        cs = calendar_spreads(panel, s, min_dte=min_dte)
        if cs.empty:
            continue
        cs = cs[(cs["implied_carry"] > -0.5) & (cs["implied_carry"] < 0.5)]
        frames.append(cs[["trade_date", "implied_carry"]].assign(priority=i, source=s))
    if not frames:
        return pd.DataFrame(columns=["trade_date", "carry", "carry_source"])
    allc = pd.concat(frames).sort_values(["trade_date", "priority"]).groupby("trade_date").head(1)
    allc = allc.set_index("trade_date").sort_index()
    allc["carry"] = allc["implied_carry"].rolling(smooth, min_periods=1).median()
    return allc.rename(columns={"source": "carry_source"})[["carry", "carry_source", "implied_carry"]].reset_index()


def curve_history(panel: pd.DataFrame, symbol: str, max_points: int = 6) -> pd.DataFrame:
    """Normalized prices by tenor rank (1 = nearest) through time — the shape of the curve over time."""
    p = panel[(panel["symbol"] == symbol) & (panel["dte"] >= 0)].copy()
    if p.empty:
        return p
    p["tenor_rank"] = p.groupby("trade_date")["expiry"].rank(method="first").astype(int)
    return p[p["tenor_rank"] <= max_points][["trade_date", "expiry", "tenor_rank", "dte", "norm", "traded"]]
