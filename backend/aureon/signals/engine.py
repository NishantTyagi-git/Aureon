"""Transparent research-signal engine.

A signal is produced for a day only when *every* check passes; each check records whether it
passed and why, so rejected days are as explainable as accepted ones. "No signal" is the default
outcome. Signals are research hypotheses — not trade recommendations.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from ..backtest.costs import CostModel
from ..backtest.sizing import LegSizing, size_pair
from ..specs import get_spec


@dataclass
class SignalConfig:
    entry_z: float = 2.0
    exit_z: float = 0.5
    stop_z: float = 4.0
    min_entry_dte: int = 10  # both legs need at least this many calendar days to expiry to enter
    exit_dte: int = 3  # force-close when either leg is this many business days from expiry (min 2)
    max_holding_days: int = 30
    max_participation: float = 0.05  # our lots / day's traded lots, per leg
    min_open_interest: float = 50.0
    min_segment_obs: int = 3  # trading days on the current contract pair before entries are allowed
    cost_multiple: float = 1.5  # expected edge must exceed this multiple of round-trip cost
    max_residual_pct: float = 5.0  # hedge residual (fine grams) as % of leg A
    target_fine_grams: float = 200.0  # per side; ~2 GOLDM lots, a realistic retail/prop size

    def to_dict(self) -> dict:
        return asdict(self)


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"check": name, "passed": bool(passed), "detail": detail}


def evaluate_day(row: pd.Series, a: str, b: str, cfg: SignalConfig, costs: CostModel, sizing: LegSizing,
                 flagged: set | None = None) -> dict:
    """Evaluate the entry decision for one row of a pair series (data up to and including that day)."""
    sa, sb = get_spec(a), get_spec(b)
    z = row.get("z")
    checks = []

    has_stats = pd.notna(z) and pd.notna(row.get("std")) and row.get("std", 0) > 0
    checks.append(_check("history", has_stats,
                         "enough past days to define normal" if has_stats else "not enough past days yet to judge what is normal"))
    zval = float(z) if has_stats else float("nan")
    checks.append(_check("z_threshold", has_stats and abs(zval) >= cfg.entry_z,
                         f"{abs(zval):.2f} typical swings from normal (needs {cfg.entry_z:.2f})" if has_stats else "cannot judge yet"))

    dte_ok = row["dte_a"] >= cfg.min_entry_dte and row["dte_b"] >= cfg.min_entry_dte
    checks.append(_check("expiry", dte_ok,
                         f"{a} expires in {int(row['dte_a'])} days, {b} in {int(row['dte_b'])} days (need at least {cfg.min_entry_dte})"))

    seg_ok = row.get("segment_obs", cfg.min_segment_obs) >= cfg.min_segment_obs
    checks.append(_check("roll_settled", seg_ok,
                         f"{int(row.get('segment_obs', 0))} days since the last contract switch (need {cfg.min_segment_obs})"))

    part_a = sizing.lots_a / row["volume_lots_a"] if row["volume_lots_a"] else np.inf
    part_b = sizing.lots_b / row["volume_lots_b"] if row["volume_lots_b"] else np.inf
    oi_ok = (row.get("open_interest_a") or 0) >= cfg.min_open_interest and \
            (row.get("open_interest_b") or 0) >= cfg.min_open_interest
    liq_ok = part_a <= cfg.max_participation and part_b <= cfg.max_participation and oi_ok
    checks.append(_check("liquidity", liq_ok,
                         f"our size would be {part_a:.1%} of {a}'s and {part_b:.1%} of {b}'s daily volume (max {cfg.max_participation:.0%}); "
                         f"open interest {row.get('open_interest_a', 0):,.0f} / {row.get('open_interest_b', 0):,.0f} lots "
                         f"(need {cfg.min_open_interest:,.0f})"))

    resid_ok = abs(sizing.residual_pct) <= cfg.max_residual_pct
    checks.append(_check("hedge_residual", resid_ok,
                         f"{sizing.lots_a} lots of {a} vs {sizing.lots_b} lots of {b}: {abs(sizing.residual_fine_grams):.2f} g of pure gold "
                         f"left unmatched ({abs(sizing.residual_pct):.2f}%, max {cfg.max_residual_pct:g}%)"))

    notional_a = sizing.lots_a * row["close_a"] * sa.quote_units_per_lot
    notional_b = sizing.lots_b * row["close_b"] * sb.quote_units_per_lot
    deviation_bps = abs(row["spread_bps"] - row["mean"]) if has_stats else 0.0
    edge = deviation_bps / 1e4 * min(notional_a, notional_b)
    rt_cost = costs.round_trip_estimate([
        (notional_a, sa.tick, sizing.lots_a * sa.quote_units_per_lot),
        (notional_b, sb.tick, sizing.lots_b * sb.quote_units_per_lot)])
    checks.append(_check("cost_hurdle", edge >= cfg.cost_multiple * rt_cost,
                         f"gain if the gap returned to normal ≈ ₹{edge:,.0f}; needs ₹{cfg.cost_multiple * rt_cost:,.0f} "
                         f"({cfg.cost_multiple:g}× estimated costs of ₹{rt_cost:,.0f})"))

    dq_ok = True
    if flagged:
        dq_ok = not ((row["trade_date"], a, row["expiry_a"]) in flagged or (row["trade_date"], b, row["expiry_b"]) in flagged)
    checks.append(_check("data_quality", dq_ok, "no data problems flagged for either contract" if dq_ok
                         else "one contract had a suspicious price jump this day"))

    all_ok = all(c["passed"] for c in checks)
    direction = None
    if all_ok:
        direction = "short_spread" if zval > 0 else "long_spread"
    failed = [c["check"] for c in checks if not c["passed"]]
    if all_ok:
        verb = f"sell {a} and buy {b}" if direction == "short_spread" else f"buy {a} and sell {b}"
        summary = (f"{a} looked {'expensive' if zval > 0 else 'cheap'} relative to {b} "
                   f"({abs(zval):.2f} typical swings {'above' if zval > 0 else 'below'} normal). Research idea: {verb}, "
                   f"expecting the gap to narrow. Potential ≈ ₹{edge:,.0f} vs estimated costs ₹{rt_cost:,.0f}.")
    else:
        summary = "No signal — failed: " + ", ".join(failed)
    return {
        "trade_date": row["trade_date"], "z": None if not has_stats else zval,
        "spread_bps": float(row["spread_bps"]), "mean_bps": None if not has_stats else float(row["mean"]),
        "expiry_a": row["expiry_a"], "expiry_b": row["expiry_b"], "signal": direction,
        "checks": checks, "summary": summary, "expected_edge": edge, "round_trip_cost": rt_cost,
        "lots_a": sizing.lots_a, "lots_b": sizing.lots_b,
    }


def with_segment_obs(m: pd.DataFrame) -> pd.DataFrame:
    m = m.copy()
    m["segment_obs"] = m.groupby("segment").cumcount() + 1
    return m


def generate_signals(m: pd.DataFrame, a: str, b: str, cfg: SignalConfig, costs: CostModel,
                     flagged: set | None = None, lookback: int | None = None) -> list[dict]:
    if m.empty:
        return []
    m = with_segment_obs(m)
    if lookback:
        m["lookback"] = lookback
    sizing = size_pair(a, b, cfg.target_fine_grams)
    return [evaluate_day(r, a, b, cfg, costs, sizing, flagged) for _, r in m.iterrows()]
