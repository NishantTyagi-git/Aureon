"""Relative-value research between two gold contracts.

For each trading day a *specific* contract is chosen for each leg:

* leg A: nearest-expiry contract of symbol A that traded and has ``dte >= min_dte``;
* leg B: the traded contract of symbol B whose expiry is closest to leg A's, provided the gap is
  at most ``max_expiry_gap`` days.

Prices are normalized to ₹ per 10 g of fine gold. Because the two legs can expire on different
days (GOLDM expires on the 5th, the small contracts at month-end), an optional carry adjustment
discounts each leg to a common spot-equivalent basis with the day's market-implied carry rate:

    adj = norm × exp(−carry × dte / 365)

Spread definitions:  spread_abs = adjA − adjB  (₹ per 10 g fine)
                     spread_bps = 10 000 × ln(adjA / adjB)

Rolling statistics are strictly causal (window ends at, and includes, the current day).
An unusual spread is a research observation — not evidence of arbitrage or of mean reversion.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from .term_structure import carry_reference


@dataclass
class PairConfig:
    a: str = "GOLDM"
    b: str = "GOLDTEN"
    min_dte: int = 5
    max_expiry_gap: int = 10
    carry_adjust: bool = True
    lookback: int = 60
    min_obs: int = 30

    def to_dict(self) -> dict:
        return asdict(self)


def _eligible(panel: pd.DataFrame, symbol: str, min_dte: int) -> pd.DataFrame:
    p = panel[(panel["symbol"] == symbol) & (panel["dte"] >= min_dte) & (panel["traded"])]
    return p[["trade_date", "expiry", "close", "open", "norm", "norm_open", "dte", "volume_lots", "open_interest"]]


def pair_series(panel: pd.DataFrame, cfg: PairConfig, carry: pd.DataFrame | None = None) -> pd.DataFrame:
    if panel.empty:
        return pd.DataFrame()
    a = _eligible(panel, cfg.a, cfg.min_dte)
    b = _eligible(panel, cfg.b, cfg.min_dte)
    if a.empty or b.empty:
        return pd.DataFrame()
    a_front = a.sort_values(["trade_date", "expiry"]).groupby("trade_date").head(1)
    m = a_front.merge(b, on="trade_date", suffixes=("_a", "_b"))
    m["expiry_gap"] = (m["expiry_b"] - m["expiry_a"]).dt.days
    m["abs_gap"] = m["expiry_gap"].abs()
    m = m.sort_values(["trade_date", "abs_gap", "expiry_b"]).groupby("trade_date").head(1)
    m = m[m["abs_gap"] <= cfg.max_expiry_gap].drop(columns="abs_gap").reset_index(drop=True)
    if m.empty:
        return m

    if carry is None:
        carry = carry_reference(panel)
    m = m.merge(carry[["trade_date", "carry", "carry_source"]] if not carry.empty else
                pd.DataFrame(columns=["trade_date", "carry", "carry_source"]), on="trade_date", how="left")
    m["carry"] = pd.to_numeric(m["carry"], errors="coerce").astype(float)
    if cfg.carry_adjust:
        m["adj_a"] = m["norm_a"] * np.exp(-m["carry"] * m["dte_a"] / 365.0)
        m["adj_b"] = m["norm_b"] * np.exp(-m["carry"] * m["dte_b"] / 365.0)
    else:
        m["adj_a"], m["adj_b"] = m["norm_a"], m["norm_b"]
    m = m.dropna(subset=["adj_a", "adj_b"]).reset_index(drop=True)
    m["spread_abs"] = m["adj_a"] - m["adj_b"]
    m["spread_bps"] = 1e4 * np.log(m["adj_a"] / m["adj_b"])
    m["raw_spread_bps"] = 1e4 * np.log(m["norm_a"] / m["norm_b"])
    key = m["expiry_a"].astype(str) + "|" + m["expiry_b"].astype(str)
    m["roll"] = key.ne(key.shift()) & (m.index > 0)
    m["segment"] = m["roll"].cumsum()
    return add_rolling_stats(m, cfg.lookback, cfg.min_obs)


def add_rolling_stats(m: pd.DataFrame, lookback: int, min_obs: int) -> pd.DataFrame:
    s = m["spread_bps"]
    roll = s.rolling(lookback, min_periods=min_obs)
    m = m.copy()
    m["mean"] = roll.mean()
    m["std"] = roll.std(ddof=1)
    m["z"] = (s - m["mean"]) / m["std"].where(m["std"] > 0)
    m["pctile"] = s.rolling(lookback, min_periods=min_obs).apply(lambda w: (w <= w[-1]).mean() * 100.0, raw=True)
    m["upper"] = m["mean"] + 2 * m["std"]
    m["lower"] = m["mean"] - 2 * m["std"]
    return m


def summary_stats(m: pd.DataFrame) -> dict:
    if m.empty:
        return {}
    s = m["spread_bps"]
    last = m.iloc[-1]
    # Lag-1 autocorrelation of daily spread changes and an AR(1) half-life on levels, within segments.
    ds = m.groupby("segment")["spread_bps"].diff()
    lag = m.groupby("segment")["spread_bps"].shift()
    ok = lag.notna()
    half_life = None
    if ok.sum() > 20:
        x, y = lag[ok].values, ds[ok].values
        x = x - x.mean()
        beta = float(np.dot(x, y - y.mean()) / np.dot(x, x)) if np.dot(x, x) > 0 else 0.0
        if beta < 0:
            half_life = float(-np.log(2) / np.log(1 + beta)) if beta > -1 else None
    return {
        "observations": int(len(m)),
        "segments": int(m["segment"].nunique()),
        "first_date": m["trade_date"].min(),
        "last_date": m["trade_date"].max(),
        "mean_bps": float(s.mean()), "std_bps": float(s.std()), "min_bps": float(s.min()), "max_bps": float(s.max()),
        "p05_bps": float(s.quantile(0.05)), "p50_bps": float(s.quantile(0.5)), "p95_bps": float(s.quantile(0.95)),
        "mean_abs_rupees": float(m["spread_abs"].mean()),
        "last_spread_bps": float(last["spread_bps"]), "last_spread_abs": float(last["spread_abs"]),
        "last_z": None if pd.isna(last["z"]) else float(last["z"]),
        "last_pctile": None if pd.isna(last["pctile"]) else float(last["pctile"]),
        "last_expiry_a": last["expiry_a"], "last_expiry_b": last["expiry_b"],
        "mean_reversion_half_life_days": half_life,
        "change_autocorr_lag1": float(ds.autocorr(1)) if ds.notna().sum() > 10 else None,
    }
