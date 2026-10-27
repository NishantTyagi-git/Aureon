"""Event-driven daily backtester for two-leg relative-value positions.

Timing (no look-ahead)
----------------------
* A signal is evaluated with information available at the close of day *t*.
* Orders execute on the next exchange trading day *t+1*, at that day's close (``next_close``)
  or open (``next_open``) of the **specific contracts** chosen on day *t*.
* If either leg did not trade on the execution day, an entry is cancelled; an exit is retried on
  the following day (and the delay is recorded).

Positions are always held in specific expiries. A position is force-closed when either leg reaches
``exit_dte`` calendar days to expiry; it is never silently rolled into the next contract.

P&L for a leg = side × lots × (lot grams / quote grams) × Δprice. Daily P&L is split into
* directional — net fine-gold exposure × change in leg B's fine-gold price, and
* relative    — leg A fine grams × (change in A's fine price − change in B's fine price),
which sum exactly to the gross P&L.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from ..signals.engine import SignalConfig, evaluate_day, with_segment_obs
from ..specs import get_spec
from .costs import CostModel
from .sizing import size_pair


@dataclass
class BacktestConfig:
    a: str = "GOLDM"
    b: str = "GOLDTEN"
    execution: str = "next_close"  # or "next_open"
    capital: float = 1_000_000.0  # ₹ account size for return/drawdown/margin figures
    signal: SignalConfig = field(default_factory=SignalConfig)
    costs: CostModel = field(default_factory=CostModel)

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


@dataclass
class _Leg:
    symbol: str
    expiry: pd.Timestamp
    side: int  # +1 long, -1 short
    lots: int
    entry_price: float
    mark: float
    stale_days: int = 0


def _norm(price: float, symbol: str) -> float:
    s = get_spec(symbol)
    return price * 10.0 / s.quote_grams * 1000.0 / s.purity


# Lookups derived from the (immutable) panel / pair frames are reused across the many backtests a
# walk-forward run makes; entries are only valid while the very same frame object is alive.
_LOOKUPS: dict = {}


def _lookup(obj, key, build):
    k = (id(obj), key)
    hit = _LOOKUPS.get(k)
    if hit is not None and hit[0] is obj:
        return hit[1]
    if len(_LOOKUPS) > 64:
        _LOOKUPS.clear()
    value = build()
    _LOOKUPS[k] = (obj, value)
    return value


class _Prices:
    def __init__(self, panel: pd.DataFrame, symbols: tuple[str, str]):
        p = panel[panel["symbol"].isin(symbols)]
        self.rows = {(r.trade_date, r.symbol, r.expiry): r for r in p.itertuples(index=False)}

    def get(self, d, sym, exp):
        return self.rows.get((d, sym, exp))

    def last_on_or_before(self, d, sym, exp, dates: pd.DatetimeIndex):
        for dd in reversed(dates[dates <= d]):
            r = self.get(dd, sym, exp)
            if r is not None:
                return dd, r
        return None, None


def run_backtest(panel: pd.DataFrame, pair: pd.DataFrame, cfg: BacktestConfig,
                 start: pd.Timestamp | None = None, end: pd.Timestamp | None = None,
                 carry: pd.DataFrame | None = None, flagged: set | None = None) -> dict:
    """Run one backtest over [start, end]. ``pair`` must be the causal pair series from
    :func:`aureon.analytics.relative_value.pair_series` (it may extend before ``start`` — that
    history only feeds the rolling statistics)."""
    sc, costs = cfg.signal, cfg.costs
    a, b = cfg.a, cfg.b
    sa, sb = get_spec(a), get_spec(b)
    all_dates = _lookup(panel, "calendar", lambda: pd.DatetimeIndex(sorted(panel["trade_date"].unique())))
    cal = all_dates
    if start is not None:
        cal = cal[cal >= start]
    if end is not None:
        cal = cal[cal <= end]
    empty = {"trades": [], "daily": pd.DataFrame(), "signals": [], "events": [], "config": cfg.to_dict()}
    if pair.empty or len(cal) < 2:
        return empty

    # Plain dicts per day: far faster than pandas row access inside the daily loop.
    pair = _lookup(pair, "rows", lambda: {r["trade_date"]: r for r in with_segment_obs(pair).to_dict("records")})
    carry_map = {} if carry is None or carry.empty else _lookup(carry, "map", lambda: dict(zip(carry["trade_date"], carry["carry"])))
    prices = _lookup(panel, ("prices", a, b), lambda: _Prices(panel, (a, b)))
    sizing = size_pair(a, b, sc.target_fine_grams)

    position: dict | None = None
    pending: dict | None = None
    trades, daily, signals, events = [], [], [], []

    def exec_price(r, side: str, spec) -> float | None:
        if r is None or not (r.volume_lots and r.volume_lots > 0):
            return None
        px = r.close if cfg.execution == "next_close" else (r.open if r.open and r.open > 0 else None)
        if px is None or (isinstance(px, float) and math.isnan(px)):
            return None
        return costs.slipped_price(float(px), spec.tick, side)

    def fees_for(leg: _Leg, price: float, side: str) -> float:
        spec = get_spec(leg.symbol)
        return costs.fees(leg.lots * spec.quote_units_per_lot * price, side)["total"]

    last_date = cal[-1]
    for d in cal:
        day = {"trade_date": d, "gross": 0.0, "costs": 0.0, "directional": 0.0, "relative": 0.0,
               "in_position": False, "net_fine_grams": 0.0, "gross_notional": 0.0}

        # 1) execute pending orders -------------------------------------------------------------
        if pending is not None:
            if pending["type"] == "entry":
                ra = prices.get(d, a, pending["expiry_a"])
                rb = prices.get(d, b, pending["expiry_b"])
                side_a = 1 if pending["direction"] == "long_spread" else -1
                pa = exec_price(ra, "buy" if side_a > 0 else "sell", sa)
                pb = exec_price(rb, "sell" if side_a > 0 else "buy", sb)
                if pa is None or pb is None:
                    events.append({"date": d, "event": "entry_cancelled",
                                   "detail": "a leg did not trade on the execution day"})
                else:
                    la = _Leg(a, pending["expiry_a"], side_a, sizing.lots_a, pa, pa)
                    lb = _Leg(b, pending["expiry_b"], -side_a, sizing.lots_b, pb, pb)
                    c = fees_for(la, pa, "buy" if side_a > 0 else "sell") + fees_for(lb, pb, "sell" if side_a > 0 else "buy")
                    position = {"legs": (la, lb), "direction": pending["direction"], "entry_date": d,
                                "signal_date": pending["signal_date"], "entry_z": pending["z"], "costs": c,
                                "gross": 0.0, "directional": 0.0, "relative": 0.0, "max_adverse": 0.0,
                                "entry_spread_bps": pending["spread_bps"]}
                    day["costs"] += c
                    events.append({"date": d, "event": "entry", "detail": f"{pending['direction']} "
                                   f"{la.lots}×{a} {la.expiry.date()} @ {pa:.2f} / {lb.lots}×{b} {lb.expiry.date()} @ {pb:.2f}"})
                pending = None
            elif pending["type"] == "exit" and position is not None:
                la, lb = position["legs"]
                ra, rb = prices.get(d, a, la.expiry), prices.get(d, b, lb.expiry)
                pa = exec_price(ra, "sell" if la.side > 0 else "buy", sa)
                pb = exec_price(rb, "sell" if lb.side > 0 else "buy", sb)
                expired = d > min(la.expiry, lb.expiry)
                forced = False
                if (pa is None or pb is None) and (expired or d == last_date):
                    # Cannot trade: settle at the last available official close and flag it.
                    _, ra2 = prices.last_on_or_before(d, a, la.expiry, all_dates)
                    _, rb2 = prices.last_on_or_before(d, b, lb.expiry, all_dates)
                    pa = pa or costs.slipped_price(float(ra2.close), sa.tick, "sell" if la.side > 0 else "buy")
                    pb = pb or costs.slipped_price(float(rb2.close), sb.tick, "sell" if lb.side > 0 else "buy")
                    forced = True
                if pa is None or pb is None:
                    pending["delays"] = pending.get("delays", 0) + 1
                    events.append({"date": d, "event": "exit_delayed", "detail": "a leg did not trade; retrying"})
                else:
                    g = _apply_marks(position, pa, pb, day)
                    c = fees_for(la, pa, "sell" if la.side > 0 else "buy") + fees_for(lb, pb, "sell" if lb.side > 0 else "buy")
                    position["costs"] += c
                    day["costs"] += c
                    trades.append(_close_trade(position, d, pa, pb, pending["reason"] + ("+forced_settle" if forced else ""),
                                               pending.get("delays", 0), sizing))
                    events.append({"date": d, "event": "exit", "detail": f"{pending['reason']} gross ₹{g:,.0f}"})
                    position = None
                    pending = None

        # 2) mark open position to market ----------------------------------------------------------
        if position is not None:
            la, lb = position["legs"]
            ra, rb = prices.get(d, a, la.expiry), prices.get(d, b, lb.expiry)
            if ra is None:
                la.stale_days += 1
            if rb is None:
                lb.stale_days += 1
            pa = float(ra.close) if ra is not None else la.mark
            pb = float(rb.close) if rb is not None else lb.mark
            _apply_marks(position, pa, pb, day)
            day["in_position"] = True
            day["net_fine_grams"] = la.side * la.lots * sa.fine_grams_per_lot + lb.side * lb.lots * sb.fine_grams_per_lot
            day["gross_notional"] = la.lots * sa.quote_units_per_lot * pa + lb.lots * sb.quote_units_per_lot * pb

        # 3) exit decisions (information at close of d) ------------------------------------------
        if position is not None and pending is None:
            reason = _exit_reason(position, d, pair, carry_map, sc, last_date)
            if reason == "window_end":
                la, lb = position["legs"]
                pa = costs.slipped_price(la.mark, sa.tick, "sell" if la.side > 0 else "buy")
                pb = costs.slipped_price(lb.mark, sb.tick, "sell" if lb.side > 0 else "buy")
                g = _apply_marks(position, pa, pb, day)
                c = fees_for(la, pa, "sell" if la.side > 0 else "buy") + fees_for(lb, pb, "sell" if lb.side > 0 else "buy")
                position["costs"] += c
                day["costs"] += c
                trades.append(_close_trade(position, d, pa, pb, "window_end", 0, sizing))
                position = None
            elif reason:
                pending = {"type": "exit", "reason": reason, "decided": d}

        # 4) entry decisions --------------------------------------------------------------------
        if position is None and pending is None and d in pair and d < last_date:
            row = dict(pair[d])
            row["trade_date"] = d
            ev = evaluate_day(row, a, b, sc, costs, sizing, flagged)
            signals.append(ev)
            if ev["signal"]:
                pending = {"type": "entry", "direction": ev["signal"], "expiry_a": row["expiry_a"],
                           "expiry_b": row["expiry_b"], "signal_date": d, "z": ev["z"],
                           "spread_bps": float(row["spread_bps"])}

        day["net"] = day["gross"] - day["costs"]
        daily.append(day)

    dd = pd.DataFrame(daily)
    if not dd.empty:
        dd["equity"] = cfg.capital + dd["net"].cumsum()
        dd["return"] = dd["net"] / cfg.capital
    return {"trades": trades, "daily": dd, "signals": signals, "events": events, "config": cfg.to_dict(),
            "sizing": sizing.to_dict()}


def _apply_marks(position: dict, pa: float, pb: float, day: dict) -> float:
    la, lb = position["legs"]
    sa, sb = get_spec(la.symbol), get_spec(lb.symbol)
    pnl_a = la.side * la.lots * sa.quote_units_per_lot * (pa - la.mark)
    pnl_b = lb.side * lb.lots * sb.quote_units_per_lot * (pb - lb.mark)
    # attribution in fine-gold terms
    ga = la.side * la.lots * sa.fine_grams_per_lot
    gb = lb.side * lb.lots * sb.fine_grams_per_lot
    dna = (_norm(pa, la.symbol) - _norm(la.mark, la.symbol)) / 10.0  # ₹ per fine gram
    dnb = (_norm(pb, lb.symbol) - _norm(lb.mark, lb.symbol)) / 10.0
    directional = (ga + gb) * dnb
    relative = ga * (dna - dnb)
    gross = pnl_a + pnl_b
    la.mark, lb.mark = pa, pb
    for k, v in (("gross", gross), ("directional", directional), ("relative", relative)):
        position[k] += v
        day[k] += v
    position["max_adverse"] = min(position["max_adverse"], position["gross"])
    return gross


def _held_z(position: dict, d, pair: pd.DataFrame, carry_map: dict) -> float | None:
    la, lb = position["legs"]
    if d not in pair:
        return None
    row = pair[d]
    if pd.isna(row["std"]) or row["std"] <= 0:
        return None
    r = carry_map.get(d, np.nan)
    na, nb = _norm(la.mark, la.symbol), _norm(lb.mark, lb.symbol)
    if not np.isnan(r):
        na *= math.exp(-r * (la.expiry - d).days / 365.0)
        nb *= math.exp(-r * (lb.expiry - d).days / 365.0)
    s = 1e4 * math.log(na / nb)
    return (s - row["mean"]) / row["std"]


def _exit_reason(position: dict, d, pair: pd.DataFrame, carry_map: dict, sc: SignalConfig, last_date) -> str | None:
    la, lb = position["legs"]
    if d >= last_date:
        return "window_end"
    # exit_dte is measured in business days so the next-day execution always precedes expiry
    if min(np.busday_count(d.date(), la.expiry.date()), np.busday_count(d.date(), lb.expiry.date())) <= sc.exit_dte:
        return "expiry"
    holding = int(np.busday_count(position["entry_date"].date(), d.date()))
    z = _held_z(position, d, pair, carry_map)
    position["last_z"] = z
    if z is not None:
        if position["direction"] == "short_spread":
            if z <= sc.exit_z:
                return "target"
            if z >= sc.stop_z:
                return "stop"
        else:
            if z >= -sc.exit_z:
                return "target"
            if z <= -sc.stop_z:
                return "stop"
    if holding >= sc.max_holding_days:
        return "max_holding"
    return None


def _close_trade(position: dict, d, pa: float, pb: float, reason: str, delays: int, sizing) -> dict:
    la, lb = position["legs"]
    return {
        "direction": position["direction"], "signal_date": position["signal_date"],
        "entry_date": position["entry_date"], "exit_date": d, "exit_reason": reason,
        "symbol_a": la.symbol, "expiry_a": la.expiry, "lots_a": la.lots, "entry_a": la.entry_price, "exit_a": pa,
        "symbol_b": lb.symbol, "expiry_b": lb.expiry, "lots_b": lb.lots, "entry_b": lb.entry_price, "exit_b": pb,
        "entry_z": position["entry_z"], "exit_z": position.get("last_z"),
        "entry_spread_bps": position["entry_spread_bps"],
        "holding_days": int(np.busday_count(position["entry_date"].date(), d.date())),
        "gross": position["gross"], "costs": position["costs"], "net": position["gross"] - position["costs"],
        "directional": position["directional"], "relative": position["relative"],
        "max_adverse": position["max_adverse"], "exit_delays": delays,
        "residual_fine_grams": sizing.residual_fine_grams,
        "stale_mark_days": la.stale_days + lb.stale_days,
    }
