"""Contract lifecycle: every individual (symbol, expiry) contract is tracked separately.

Different expiries are never stitched into a single "continuous" instrument. When analytics need a
reference contract per day (e.g. the front contract), the selection is explicit and every switch is
recorded as a transition with its date and the contracts involved.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .panel import trading_calendar


@dataclass
class EligibilityRules:
    min_dte: int = 5  # calendar days to expiry required to open/hold a position
    min_volume_lots: float = 1.0  # contract must have traded on the day
    min_open_interest: float = 0.0


def contract_table(panel: pd.DataFrame, asof: pd.Timestamp | None = None,
                   rules: EligibilityRules | None = None) -> pd.DataFrame:
    rules = rules or EligibilityRules()
    if panel.empty:
        return pd.DataFrame()
    cal = trading_calendar(panel)
    asof = asof or cal[-1]
    g = panel.groupby(["symbol", "expiry"])
    out = g.agg(first_seen=("trade_date", "min"), last_seen=("trade_date", "max"), observations=("trade_date", "size"),
                traded_days=("traded", "sum"), total_volume_lots=("volume_lots", "sum"),
                avg_open_interest=("open_interest", "mean")).reset_index()
    last = panel.sort_values("trade_date").groupby(["symbol", "expiry"]).tail(1).set_index(["symbol", "expiry"])
    out = out.join(last[["close", "norm", "volume_lots", "open_interest", "traded"]]
                   .rename(columns={"close": "last_close", "norm": "last_norm", "volume_lots": "last_volume",
                                    "open_interest": "last_oi", "traded": "last_traded"}),
                   on=["symbol", "expiry"])
    # Expected observations: exchange trading days between first sighting and min(expiry, asof).
    expected = []
    for _, r in out.iterrows():
        end = min(r["expiry"], asof)
        expected.append(int(((cal >= r["first_seen"]) & (cal <= end)).sum()))
    out["expected_observations"] = expected
    out["missing_observations"] = (out["expected_observations"] - out["observations"]).clip(lower=0)
    out["coverage"] = out["observations"] / out["expected_observations"].where(out["expected_observations"] > 0)
    out["dte"] = (out["expiry"] - asof).dt.days
    out["status"] = out.apply(lambda r: "expired" if r["expiry"] < asof else
                              ("active" if r["last_seen"] == asof else "no_recent_data"), axis=1)
    out["eligible"] = ((out["status"] == "active") & (out["dte"] >= rules.min_dte) & out["last_traded"].fillna(False)
                       & (out["last_volume"].fillna(0) >= rules.min_volume_lots)
                       & (out["last_oi"].fillna(0) >= rules.min_open_interest))

    def reason(r) -> str:
        if r["status"] == "expired":
            return "expired"
        if r["status"] != "active":
            return f"no data on {asof.date()}"
        if r["dte"] < rules.min_dte:
            return f"{r['dte']}d to expiry < {rules.min_dte}d minimum"
        if not r["last_traded"]:
            return "no trades on latest day (reference price only)"
        if r["last_volume"] < rules.min_volume_lots:
            return "volume below minimum"
        if r["last_oi"] < rules.min_open_interest:
            return "open interest below minimum"
        return "eligible"

    out["eligibility_reason"] = out.apply(reason, axis=1)
    return out.sort_values(["symbol", "expiry"]).reset_index(drop=True)


def front_contracts(panel: pd.DataFrame, symbol: str, min_dte: int = 5, require_traded: bool = True) -> pd.DataFrame:
    """Per date, the nearest-expiry contract with dte >= min_dte (and traded, if required).

    Returns one row per date with a ``transition`` flag on days the selected contract changes.
    """
    p = panel[(panel["symbol"] == symbol) & (panel["dte"] >= min_dte)]
    if require_traded:
        p = p[p["traded"]]
    if p.empty:
        return p.assign(transition=[])
    front = p.sort_values(["trade_date", "expiry"]).groupby("trade_date").head(1).reset_index(drop=True)
    front["transition"] = front["expiry"].ne(front["expiry"].shift()) & front.index.to_series().gt(0)
    return front


def transitions(front: pd.DataFrame) -> list[dict]:
    out = []
    prev = None
    for _, r in front.iterrows():
        if prev is not None and r["expiry"] != prev["expiry"]:
            out.append({"date": r["trade_date"], "from_expiry": prev["expiry"], "to_expiry": r["expiry"],
                        "from_dte_on_switch": int((prev["expiry"] - r["trade_date"]).days)})
        prev = r
    return out
