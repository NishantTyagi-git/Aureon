"""Chronological walk-forward validation.

For each fold, in strict time order:

    |---- train ----|-- validation --|-- test --|
                                                 → roll forward by ``test_days``

1. Train   – every parameter combination in the grid is backtested on the train window; the best is
             chosen by net P&L (ties → fewer trades), requiring at least ``min_train_trades``.
2. Validate – the chosen parameters run on the validation window. If they trade there and lose money,
             the fold *abstains*: no trading in its test window. A validation window with no trades
             is not evidence against the setting; the fold proceeds and is marked unconfirmed.
3. Test    – the chosen parameters run on the unseen test window. Only test windows are stitched
             into the reported out-of-sample result.

Rolling statistics are causal, so history before a window only feeds the indicators; execution is
next-day. No information from a window is used to make decisions inside an earlier window.
"""
from __future__ import annotations

import copy
import itertools
from dataclasses import asdict, dataclass, field

import pandas as pd

from ..analytics.relative_value import PairConfig, pair_series
from .engine import BacktestConfig, run_backtest
from .metrics import performance


MIN_TOTAL_DAYS = 150  # below this, even shortened windows are too small to say anything
MIN_TEST_PERIODS = 3  # if fewer unseen periods would fit, windows are shortened to fit more


@dataclass
class WalkForwardConfig:
    train_days: int = 250
    validation_days: int = 60
    test_days: int = 60
    lookbacks: list[int] = field(default_factory=lambda: [20, 40, 60, 120])
    entry_zs: list[float] = field(default_factory=lambda: [1.5, 2.0, 2.5, 3.0])
    min_train_trades: int = 3

    def to_dict(self) -> dict:
        return asdict(self)


def walk_forward(panel: pd.DataFrame, base: BacktestConfig, pair_cfg: PairConfig, wf: WalkForwardConfig,
                 carry: pd.DataFrame, flagged: set | None = None) -> dict:
    # Pair series for each lookback (stats differ; contract selection does not).
    series = {}
    for lb in wf.lookbacks:
        pc = copy.copy(pair_cfg)
        pc.lookback = lb
        pc.min_obs = min(pc.min_obs, lb)
        series[lb] = pair_series(panel, pc, carry)
    dates = series[wf.lookbacks[0]]["trade_date"] if not series[wf.lookbacks[0]].empty else pd.Series([], dtype="datetime64[ns]")
    dates = pd.DatetimeIndex(sorted(dates.unique()))
    need = wf.train_days + wf.validation_days + wf.test_days
    note = None
    if len(dates) < wf.train_days + wf.validation_days + MIN_TEST_PERIODS * wf.test_days:
        n = len(dates)
        if n < MIN_TOTAL_DAYS:
            return {"folds": [], "oos": None, "config": wf.to_dict(), "message":
                    f"These two contracts overlap on only {n} trading days; a realistic test needs at least "
                    f"{MIN_TOTAL_DAYS}. Pick a pair with more shared history."}
        # Not enough history for the configured windows: shrink them so the test can still run with
        # several short unseen periods (covering more of the history), and say so in the result.
        wf = copy.copy(wf)
        wf.train_days = max(80, int(n * 0.45))
        wf.validation_days = max(20, int(n * 0.10))
        wf.test_days = max(20, int(n * 0.10))
        need = wf.train_days + wf.validation_days + wf.test_days
        note = (f"Only {n} shared trading days were available, so the periods were shortened to "
                f"{wf.train_days} / {wf.validation_days} / {wf.test_days} days (pick settings / double-check / judge).")

    folds, oos_trades, oos_daily = [], [], []
    i = 0
    while i + need <= len(dates):
        tr = (dates[i], dates[i + wf.train_days - 1])
        va = (dates[i + wf.train_days], dates[i + wf.train_days + wf.validation_days - 1])
        te_start = i + wf.train_days + wf.validation_days
        te = (dates[te_start], dates[min(te_start + wf.test_days, len(dates)) - 1])

        grid = []
        for lb, z in itertools.product(wf.lookbacks, wf.entry_zs):
            cfg = _with(base, z)
            res = run_backtest(panel, series[lb], cfg, tr[0], tr[1], carry, flagged)
            n = len(res["trades"])
            net = float(res["daily"]["net"].sum()) if not res["daily"].empty else 0.0
            grid.append({"lookback": lb, "entry_z": z, "train_trades": n, "train_net": net})
        eligible = [g for g in grid if g["train_trades"] >= wf.min_train_trades]
        fold = {"train": tr, "validation": va, "test": te, "grid": grid}
        if not eligible:
            fold.update({"status": "abstain", "reason": "no setting traded often enough on the older data to be chosen"})
            oos_daily.append(_flat(dates, te))
            folds.append(fold)
            i += wf.test_days
            continue
        best = sorted(eligible, key=lambda g: (-g["train_net"], g["train_trades"]))[0]
        cfg = _with(base, best["entry_z"])
        val = run_backtest(panel, series[best["lookback"]], cfg, va[0], va[1], carry, flagged)
        val_net = float(val["daily"]["net"].sum()) if not val["daily"].empty else 0.0
        fold.update({"chosen": {"lookback": best["lookback"], "entry_z": best["entry_z"]},
                     "train_net": best["train_net"], "validation_net": val_net,
                     "validation_trades": len(val["trades"])})
        # Only evidence *against* the setting stops it: losing money on validation. A quiet validation
        # window (no signals at all) says nothing either way, so the setting goes ahead, flagged as unconfirmed.
        if val["trades"] and val_net <= 0:
            fold.update({"status": "abstain", "reason": "the chosen setting lost money in the double-check period"})
            # Abstaining still occupies the test window with zero P&L.
            oos_daily.append(_flat(dates, te))
        else:
            test = run_backtest(panel, series[best["lookback"]], cfg, te[0], te[1], carry, flagged)
            tn = float(test["daily"]["net"].sum()) if not test["daily"].empty else 0.0
            fold.update({"status": "traded", "confirmed": bool(val["trades"]), "test_net": tn,
                         "test_trades": len(test["trades"])})
            oos_trades.extend(test["trades"])
            if not test["daily"].empty:
                oos_daily.append(test["daily"].drop(columns=["equity", "return"], errors="ignore"))
        folds.append(fold)
        i += wf.test_days

    daily = pd.concat(oos_daily, ignore_index=True) if oos_daily else pd.DataFrame()
    if not daily.empty:
        daily = daily.sort_values("trade_date").drop_duplicates("trade_date", keep="first").reset_index(drop=True)
        daily["equity"] = base.capital + daily["net"].cumsum()
        daily["return"] = daily["net"] / base.capital
    oos = {"trades": oos_trades, "daily": daily}
    return {"folds": folds, "oos": oos, "oos_metrics": performance(oos, base.capital), "config": wf.to_dict(),
            "note": note}


def _flat(dates: pd.DatetimeIndex, window: tuple) -> pd.DataFrame:
    """Zero-P&L days for a test window the strategy sat out."""
    return pd.DataFrame({"trade_date": dates[(dates >= window[0]) & (dates <= window[1])], "gross": 0.0, "costs": 0.0,
                         "net": 0.0, "directional": 0.0, "relative": 0.0, "in_position": False,
                         "net_fine_grams": 0.0, "gross_notional": 0.0})


def _with(base: BacktestConfig, entry_z: float) -> BacktestConfig:
    cfg = copy.deepcopy(base)
    cfg.signal.entry_z = entry_z
    return cfg
