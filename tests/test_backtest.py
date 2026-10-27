import copy

import numpy as np
import pandas as pd
import pytest

from aureon.analytics.panel import build_panel
from aureon.analytics.relative_value import PairConfig, pair_series
from aureon.analytics.term_structure import carry_reference
from aureon.backtest.costs import CostModel
from aureon.backtest.engine import BacktestConfig, run_backtest
from aureon.backtest.metrics import max_drawdown, performance, verdict
from aureon.backtest.walkforward import WalkForwardConfig, walk_forward
from aureon.signals.engine import SignalConfig, generate_signals
from aureon.specs import get_spec
from conftest import synthetic_rows


def make_panel(**kw):
    df = pd.DataFrame(synthetic_rows(**kw))
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    df["expiry"] = pd.to_datetime(df["expiry"])
    return build_panel(df)


@pytest.fixture(scope="module")
def setup():
    panel = make_panel(n_days=420, guinea_spread_bps=15, ou_sigma_bps=12)
    carry = carry_reference(panel)
    pc = PairConfig(a="GOLDTEN", b="GOLDGUINEA", lookback=40, min_obs=20)
    pair = pair_series(panel, pc, carry)
    return panel, carry, pc, pair


def cfg(**sig):
    base = dict(entry_z=1.5, min_open_interest=0, max_participation=1.0, cost_multiple=0.0, target_fine_grams=100)
    base.update(sig)
    return BacktestConfig(a="GOLDTEN", b="GOLDGUINEA", signal=SignalConfig(**base), costs=CostModel())


def test_signals_explain_every_decision(setup):
    panel, carry, pc, pair = setup
    ev = generate_signals(pair, "GOLDTEN", "GOLDGUINEA", SignalConfig(), CostModel())
    assert len(ev) == len(pair)
    early = ev[0]
    assert early["signal"] is None and any(c["check"] == "history" and not c["passed"] for c in early["checks"])
    for e in ev:
        assert e["summary"]
        assert (e["signal"] is not None) == all(c["passed"] for c in e["checks"])


def test_huge_costs_block_all_signals(setup):
    panel, carry, pc, pair = setup
    ev = generate_signals(pair, "GOLDTEN", "GOLDGUINEA", SignalConfig(entry_z=1.0, cost_multiple=1.0),
                          CostModel(brokerage_per_order=1e7))
    assert not any(e["signal"] for e in ev)


def test_backtest_trades_and_accounting(setup):
    panel, carry, pc, pair = setup
    res = run_backtest(panel, pair, cfg(), carry=carry)
    trades = res["trades"]
    assert trades, "expected the synthetic mean-reverting premium to trigger trades"
    daily = res["daily"]
    # gross P&L in the daily ledger equals the sum over trades
    assert daily["gross"].sum() == pytest.approx(sum(t["gross"] for t in trades), rel=1e-9, abs=1e-6)
    assert daily["costs"].sum() == pytest.approx(sum(t["costs"] for t in trades), rel=1e-9, abs=1e-6)
    # attribution sums to gross for every trade
    for t in trades:
        assert t["directional"] + t["relative"] == pytest.approx(t["gross"], abs=1e-6)
        # execution happens strictly after the signal date
        assert t["entry_date"] > t["signal_date"]
        # positions are closed before either leg expires
        assert t["exit_date"] < min(t["expiry_a"], t["expiry_b"])


def test_trade_pnl_uses_traded_contract_prices(setup):
    panel, carry, pc, pair = setup
    res = run_backtest(panel, pair, cfg(), carry=carry)
    t = res["trades"][0]
    costs = CostModel()
    sa, sb = get_spec("GOLDTEN"), get_spec("GOLDGUINEA")
    side_a = 1 if t["direction"] == "long_spread" else -1
    ra = panel[(panel.symbol == "GOLDTEN") & (panel.expiry == t["expiry_a"]) & (panel.trade_date == t["entry_date"])].iloc[0]
    assert t["entry_a"] == pytest.approx(costs.slipped_price(ra.close, sa.tick, "buy" if side_a > 0 else "sell"))
    expected = side_a * t["lots_a"] * sa.quote_units_per_lot * (t["exit_a"] - t["entry_a"]) \
        - side_a * t["lots_b"] * sb.quote_units_per_lot * (t["exit_b"] - t["entry_b"])
    assert t["gross"] == pytest.approx(expected, abs=1e-6)


def test_no_lookahead_future_prices_do_not_change_past(setup):
    panel, carry, pc, pair = setup
    base = run_backtest(panel, pair, cfg(), carry=carry)
    cut = base["trades"][len(base["trades"]) // 2]["exit_date"]
    # scramble everything strictly after the cut
    p2 = panel.copy()
    mask = p2["trade_date"] > cut + pd.Timedelta(days=7)
    rng = np.random.default_rng(1)
    p2.loc[mask, "close"] = p2.loc[mask, "close"] * np.exp(rng.normal(0, 0.05, mask.sum()))
    p2 = build_panel(p2.drop(columns=["norm", "norm_raw", "norm_open", "dte", "traded", "lot_value",
                                      "fine_grams_lot", "volume_grams"]))
    c2 = carry_reference(p2)
    pair2 = pair_series(p2, pc, c2)
    alt = run_backtest(p2, pair2, cfg(), carry=c2)
    before = [t for t in base["trades"] if t["exit_date"] <= cut]
    before2 = [t for t in alt["trades"] if t["exit_date"] <= cut]
    assert len(before) == len(before2)
    for x, y in zip(before, before2):
        assert x["net"] == pytest.approx(y["net"])


def test_costs_reduce_pnl_monotonically(setup):
    panel, carry, pc, pair = setup
    nets = []
    for mult in (0.0, 1.0, 3.0):
        c = cfg()
        c.costs.multiplier = mult
        r = run_backtest(panel, pair, c, carry=carry)
        nets.append(sum(t["net"] for t in r["trades"]))
    # with identical trades, more cost means less net (signal cost hurdle disabled in cfg)
    assert nets[0] >= nets[1] >= nets[2]


def test_expiry_forced_exit():
    panel = make_panel(n_days=200, guinea_spread_bps=15, ou_sigma_bps=12)
    carry = carry_reference(panel)
    pc = PairConfig(a="GOLDTEN", b="GOLDGUINEA", lookback=30, min_obs=20)
    pair = pair_series(panel, pc, carry)
    c = cfg(exit_z=-99, stop_z=99, max_holding_days=10_000, min_entry_dte=5, exit_dte=4)  # never exit on z
    res = run_backtest(panel, pair, c, carry=carry)
    reasons = {t["exit_reason"] for t in res["trades"]}
    assert "expiry" in reasons
    for t in res["trades"]:
        assert (t["expiry_a"] - t["exit_date"]).days >= 0


def test_metrics_and_verdict():
    eq = pd.Series([100, 120, 90, 130, 80])
    abs_dd, pct = max_drawdown(eq)
    assert abs_dd == -50 and pct == pytest.approx(-50 / 130)
    assert verdict({"trade_count": 0})["label"] == "insufficient_evidence"
    assert verdict({"trade_count": 5, "net_pnl": 1e6})["label"] == "insufficient_evidence"
    assert verdict({"trade_count": 50, "net_pnl": -10, "gross_pnl": 100})["label"] == "unprofitable_after_costs"
    assert verdict({"trade_count": 50, "net_pnl": 10, "gross_pnl": 100, "trade_t_stat": 1.1})["label"] == "not_significant"


def test_walk_forward_is_chronological(setup):
    panel, carry, pc, pair = setup
    wf = WalkForwardConfig(train_days=120, validation_days=40, test_days=40, lookbacks=[20, 40], entry_zs=[1.5, 2.5],
                           min_train_trades=1)
    res = walk_forward(panel, cfg(), pc, wf, carry)
    assert res["folds"]
    prev_test_end = None
    for f in res["folds"]:
        assert f["train"][1] < f["validation"][0] <= f["validation"][1] < f["test"][0] <= f["test"][1]
        if f.get("status") == "abstain" and "validation_trades" in f:
            # only a losing validation period stops a fold; a quiet one does not
            assert f["validation_trades"] > 0 and f["validation_net"] <= 0
        if f.get("status") == "traded":
            assert f["confirmed"] == (f["validation_trades"] > 0)
        if prev_test_end is not None:
            assert f["test"][0] > prev_test_end
        prev_test_end = f["test"][1]
    # OOS trades all fall inside test windows
    windows = [(f["test"][0], f["test"][1]) for f in res["folds"] if f.get("status") == "traded"]
    for t in res["oos"]["trades"]:
        assert any(s <= t["entry_date"] <= e for s, e in windows)


def test_no_trades_without_data():
    res = run_backtest(make_panel(n_days=30), pd.DataFrame(), cfg())
    assert res["trades"] == []
    assert performance(res, 1e6)["verdict"] == "no_data"


def test_walk_forward_shrinks_windows_for_short_history(setup):
    panel, carry, pc, pair = setup
    n = pair["trade_date"].nunique()
    wf = WalkForwardConfig(train_days=n, validation_days=60, test_days=60, lookbacks=[40], entry_zs=[2.0])
    res = walk_forward(panel, cfg(), pc, wf, carry)
    assert res["folds"], res.get("message")
    assert res["note"] and "shortened" in res["note"]
    for f in res["folds"]:
        assert f["train"][1] < f["validation"][0] < f["test"][0]


def test_walk_forward_refuses_tiny_overlap():
    panel = make_panel(n_days=100, guinea_spread_bps=15)
    carry = carry_reference(panel)
    pc = PairConfig(a="GOLDTEN", b="GOLDGUINEA", lookback=20, min_obs=10)
    res = walk_forward(panel, cfg(), pc, WalkForwardConfig(lookbacks=[20], entry_zs=[2.0]), carry)
    assert res["folds"] == [] and "at least" in res["message"]


def test_margin_estimate_reported(setup):
    panel, carry, pc, pair = setup
    res = run_backtest(panel, pair, cfg(), carry=carry)
    m = performance(res, 1_000)
    assert m["peak_margin"] == pytest.approx(m["peak_gross_notional"] * m["margin_rate"])
    assert m["margin_exceeds_capital"] is True
