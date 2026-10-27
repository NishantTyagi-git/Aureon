"""Application service: owns the store and caches derived analytics per data version."""
from __future__ import annotations

import logging
import threading
from dataclasses import fields
from datetime import date

import numpy as np
import pandas as pd

from .analytics.lifecycle import EligibilityRules, contract_table, front_contracts, transitions
from .analytics.panel import build_panel, trading_calendar
from .analytics.quality import quality_report, suspicious_moves
from .analytics.relative_value import PairConfig, pair_series, summary_stats
from .analytics.term_structure import calendar_spreads, carry_reference, curve, curve_history
from .backtest.costs import CostModel
from .backtest.engine import BacktestConfig, run_backtest
from .backtest.metrics import performance
from .backtest.walkforward import WalkForwardConfig, walk_forward
from .config import Settings
from .data.store import Store
from .signals.engine import SignalConfig, generate_signals
from .specs import ALL_SYMBOLS, RESEARCH_SYMBOLS, SPEC_DOCUMENTS, SPECS

log = logging.getLogger(__name__)

PAIRS = [(a, b) for i, a in enumerate(RESEARCH_SYMBOLS) for b in RESEARCH_SYMBOLS[i + 1:]]


def build_dataclass(cls, data: dict | None):
    data = data or {}
    names = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in data.items() if k in names and v is not None})


class Service:
    def __init__(self, settings: Settings, store: Store | None = None):
        self.settings = settings
        self.store = store or Store(settings.database)
        self._cache: dict = {}
        self._cache_version = -1
        self._lock = threading.RLock()
        self.last_backtest: dict | None = None
        self.last_walkforward: dict | None = None
        self.collection_status: dict = {"running": False}

    # ------------------------------------------------------------------ cached base data
    def _cached(self, key, fn):
        # The lock only guards the dictionary; the (possibly slow) computation runs outside it so other
        # requests — health checks in particular — are never blocked behind a heavy calculation.
        with self._lock:
            if self._cache_version != self.store.version:
                self._cache.clear()
                self._cache_version = self.store.version
            if key in self._cache:
                return self._cache[key]
            version = self._cache_version
        value = fn()
        with self._lock:
            if self._cache_version == version:
                self._cache.setdefault(key, value)
                return self._cache[key]
        return value

    def panel(self, purity_adjust: bool = True) -> pd.DataFrame:
        return self._cached(("panel", purity_adjust),
                            lambda: build_panel(self.store.quotes_frame(ALL_SYMBOLS), purity_adjust))

    def carry(self) -> pd.DataFrame:
        return self._cached("carry", lambda: carry_reference(self.panel()))

    def flagged(self) -> set:
        def f():
            s = suspicious_moves(self.panel())
            return set() if s.empty else set(zip(s["trade_date"], s["symbol"], s["expiry"]))
        return self._cached("flagged", f)

    def has_data(self) -> bool:
        return not self.panel().empty

    # ------------------------------------------------------------------ views
    def status(self) -> dict:
        # Answered straight from the database (cheap) — never waits for analytics.
        cov = self.store.coverage()
        return {
            "counts": self.store.counts(),
            "has_data": cov["trading_days"] > 0,
            "first_date": cov["first_date"],
            "last_date": cov["last_date"],
            "trading_days": cov["trading_days"],
            "symbols": cov["symbols"],
            "tinyfish_configured": bool(self.settings.tinyfish_api_key),
            "collection": self.collection_status,
            "runs": self.store.runs(10),
        }

    def specs(self) -> dict:
        return {"specs": [s.to_dict() for s in SPECS.values()], "documents": SPEC_DOCUMENTS,
                "research_symbols": RESEARCH_SYMBOLS, "normalized_basis": "₹ per 10 g of fine gold"}

    def contracts(self, rules: dict | None = None) -> pd.DataFrame:
        p = self.panel()
        if p.empty:
            return pd.DataFrame()
        return contract_table(p, rules=build_dataclass(EligibilityRules, rules))

    def contract_history(self, symbol: str, expiry: str) -> pd.DataFrame:
        p = self.panel()
        if p.empty:
            return p
        return p[(p["symbol"] == symbol) & (p["expiry"] == pd.Timestamp(expiry))]

    def fronts(self, min_dte: int = 5) -> dict:
        p = self.panel()
        out = {}
        for s in RESEARCH_SYMBOLS:
            f = front_contracts(p, s, min_dte)
            out[s] = {"series": f[["trade_date", "expiry", "close", "norm", "dte", "volume_lots", "open_interest",
                                   "transition"]] if not f.empty else f,
                      "transitions": transitions(f) if not f.empty else []}
        return out

    def pair(self, cfg: PairConfig) -> pd.DataFrame:
        key = ("pair",) + tuple(sorted(cfg.to_dict().items()))
        return self._cached(key, lambda: pair_series(self.panel(), cfg, self.carry()))

    def relative_value(self, cfg: PairConfig) -> dict:
        m = self.pair(cfg)
        return {"config": cfg.to_dict(), "series": m, "stats": summary_stats(m)}

    def matrix(self, cfg: PairConfig) -> list[dict]:
        out = []
        for a, b in PAIRS:
            c = PairConfig(**{**cfg.to_dict(), "a": a, "b": b})
            m = self.pair(c)
            st = summary_stats(m)
            out.append({"a": a, "b": b, **({k: st.get(k) for k in (
                "observations", "last_spread_bps", "last_spread_abs", "last_z", "last_pctile", "mean_bps",
                "std_bps", "mean_reversion_half_life_days", "last_date", "last_expiry_a", "last_expiry_b")} if st else
                {"observations": 0})})
        return out

    def overview(self) -> dict:
        p = self.panel()
        if p.empty:
            return {"has_data": False}
        cal = trading_calendar(p)
        last = cal[-1]
        snap = []
        for s in RESEARCH_SYMBOLS + ("GOLD",):
            f = front_contracts(p, s, 3)
            f = f[f["trade_date"] == last] if not f.empty else f
            if f.empty:
                snap.append({"symbol": s, "available": False})
                continue
            r = f.iloc[0]
            prev = p[(p["symbol"] == s) & (p["expiry"] == r["expiry"]) & (p["trade_date"] < last)].tail(1)
            chg = float(r["close"] / prev["close"].iloc[0] - 1) if len(prev) else None
            snap.append({"symbol": s, "available": True, "expiry": r["expiry"], "close": r["close"], "norm": r["norm"],
                         "dte": int(r["dte"]), "volume_lots": r["volume_lots"], "open_interest": r["open_interest"],
                         "change": chg, "volume_grams": r["volume_grams"]})
        carry = self.carry()
        cl = carry.iloc[-1].to_dict() if not carry.empty else None
        q = self.quality()
        sigs = []
        for a, b in PAIRS:
            pc = PairConfig(a=a, b=b)
            m = self.pair(pc)
            if m.empty:
                continue
            ev = generate_signals(m.tail(1), a, b, SignalConfig(), CostModel(), self.flagged(), pc.lookback)
            if ev:
                sigs.append({"a": a, "b": b, **ev[-1]})
        return {"has_data": True, "last_date": last, "first_date": cal[0], "trading_days": len(cal),
                "snapshot": snap, "carry": cl, "matrix": self.matrix(PairConfig()),
                "warnings": q["warnings"], "signals_today": sigs, "front_history": self._front_norm_history()}

    def _front_norm_history(self) -> list[dict]:
        p = self.panel()
        rows = []
        for s in RESEARCH_SYMBOLS:
            f = front_contracts(p, s, 3)
            for _, r in f.iterrows():
                rows.append({"trade_date": r["trade_date"], "symbol": s, "norm": r["norm"], "expiry": r["expiry"]})
        return rows

    def term_structure(self, symbol: str, on: str | None = None) -> dict:
        p = self.panel()
        if p.empty:
            return {"has_data": False}
        dates = sorted(p.loc[p["symbol"] == symbol, "trade_date"].unique())
        if not dates:
            return {"has_data": False}
        d = pd.Timestamp(on) if on else dates[-1]
        if d not in set(dates):
            d = max([x for x in dates if x <= d], default=dates[0])
        curves = {s: curve(p, s, d) for s in RESEARCH_SYMBOLS + ("GOLD",)}
        return {"has_data": True, "date": d, "symbol": symbol, "available_dates": [dates[0], dates[-1]],
                "curve": curves[symbol], "all_curves": curves,
                "calendar_spreads": calendar_spreads(p, symbol), "history": curve_history(p, symbol),
                "carry": self.carry()}

    def signals(self, pair_cfg: PairConfig, sig: SignalConfig, costs: CostModel, last_n: int = 250) -> dict:
        m = self.pair(pair_cfg)
        ev = generate_signals(m, pair_cfg.a, pair_cfg.b, sig, costs, self.flagged(), pair_cfg.lookback)
        ev = ev[-last_n:]
        fails: dict[str, int] = {}
        for e in ev:
            for c in e["checks"]:
                if not c["passed"]:
                    fails[c["check"]] = fails.get(c["check"], 0) + 1
        # Signals on consecutive days usually describe one situation (and one trade in a backtest).
        episodes, prev = 0, False
        for e in ev:
            on = bool(e["signal"])
            episodes += on and not prev
            prev = on
        return {"pair": pair_cfg.to_dict(), "signal_config": sig.to_dict(), "costs": costs.to_dict(),
                "evaluations": ev, "signal_count": sum(1 for e in ev if e["signal"]), "signal_episodes": episodes,
                "rejection_counts": fails, "series": m.tail(last_n)}

    def backtest(self, pair_cfg: PairConfig, bt: BacktestConfig, start: str | None, end: str | None,
                 cost_sensitivity: list[float] | None = None) -> dict:
        m = self.pair(pair_cfg)
        s = pd.Timestamp(start) if start else None
        e = pd.Timestamp(end) if end else None
        res = run_backtest(self.panel(), m, bt, s, e, self.carry(), self.flagged())
        metrics = performance(res, bt.capital, self._gold_returns())
        sens = []
        for mult in cost_sensitivity or [0.0, 0.5, 1.0, 1.5, 2.0, 3.0]:
            import copy
            c2 = copy.deepcopy(bt)
            c2.costs.multiplier = mult
            r2 = run_backtest(self.panel(), m, c2, s, e, self.carry(), self.flagged())
            pm = performance(r2, bt.capital)
            sens.append({"multiplier": mult, "net_pnl": pm.get("net_pnl"), "gross_pnl": pm.get("gross_pnl"),
                         "costs": pm.get("costs"), "trades": pm.get("trade_count"), "sharpe": pm.get("sharpe")})
        out = {"kind": "backtest", "pair": pair_cfg.to_dict(), "config": bt.to_dict(), "metrics": metrics,
               "trades": res["trades"], "daily": res["daily"], "events": res["events"][-300:],
               "sizing": res.get("sizing"), "cost_sensitivity": sens,
               "signals_evaluated": len(res["signals"]),
               "signals_fired": sum(1 for x in res["signals"] if x["signal"])}
        self.last_backtest = out
        return out

    def walkforward(self, pair_cfg: PairConfig, bt: BacktestConfig, wf: WalkForwardConfig) -> dict:
        res = walk_forward(self.panel(), bt, pair_cfg, wf, self.carry(), self.flagged())
        if res.get("oos"):
            res["oos_metrics"] = performance(res["oos"], bt.capital, self._gold_returns())
        out = {"kind": "walkforward", "pair": pair_cfg.to_dict(), "config": bt.to_dict(), **res}
        self.last_walkforward = out
        return out

    def _gold_returns(self) -> pd.Series:
        def f():
            fr = front_contracts(self.panel(), "GOLDM", 3)
            if fr.empty:
                return pd.Series(dtype=float)
            fr = fr.set_index("trade_date")
            r = np.log(fr["close"]).diff()
            r[fr["transition"]] = np.nan  # never compute a return across a contract switch
            return r.dropna()
        return self._cached("gold_returns", f)

    def quality(self) -> dict:
        return self._cached("quality", lambda: quality_report(
            self.panel(), self.store.rejections_frame(), self.store.duplicates_frame(), date.today()))
