import math

import numpy as np
import pandas as pd
import pytest

from aureon.analytics.lifecycle import contract_table, front_contracts, transitions
from aureon.analytics.panel import build_panel
from aureon.analytics.quality import quality_report, spec_verification, suspicious_moves
from aureon.analytics.relative_value import PairConfig, add_rolling_stats, pair_series, summary_stats
from aureon.analytics.term_structure import calendar_spreads, carry_reference
from aureon.backtest.sizing import size_pair
from aureon.specs import SPECS, get_spec, normalize_price
from conftest import synthetic_rows


def panel_from(rows):
    df = pd.DataFrame(rows)
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    df["expiry"] = pd.to_datetime(df["expiry"])
    return build_panel(df)


# ----------------------------------------------------------------- normalization
def test_normalization_formulas():
    # ₹ per 10 g of fine gold
    assert normalize_price(14155, get_spec("GOLDPETAL")) == pytest.approx(141550 / 0.999)
    assert normalize_price(113168, get_spec("GOLDGUINEA")) == pytest.approx(113168 * 10 / 8 / 0.999)
    assert normalize_price(140453, get_spec("GOLDM")) == pytest.approx(140453 / 0.995)
    assert normalize_price(140453, get_spec("GOLDM"), purity_adjust=False) == pytest.approx(140453)
    assert get_spec("GOLDM").fine_grams_per_lot == pytest.approx(99.5)
    assert get_spec("GOLDGUINEA").quote_units_per_lot == 1.0
    assert get_spec("GOLDM").quote_units_per_lot == 10.0


def test_sizing_never_assumes_perfect_hedge():
    s = size_pair("GOLDM", "GOLDTEN", 1000)
    assert s.lots_a * 99.5 == pytest.approx(s.fine_grams_a)
    assert s.residual_fine_grams == pytest.approx(s.fine_grams_a - s.fine_grams_b)
    assert s.residual_fine_grams != 0  # 995 vs 999 purity cannot be matched exactly
    g = size_pair("GOLDM", "GOLDGUINEA", 1000)
    assert abs(g.residual_pct) < 1.0
    # residual is minimised over the search range
    for na in range(8, 13):
        nb = round(na * 99.5 / 7.992)
        assert abs(na * 99.5 - nb * 7.992) >= abs(g.residual_fine_grams) - 1e-9


# ----------------------------------------------------------------- lifecycle & term structure
def test_contract_lifecycle_and_transitions():
    p = panel_from(synthetic_rows(120))
    ct = contract_table(p)
    assert set(ct["status"]) <= {"active", "expired", "no_recent_data"}
    assert (ct.loc[ct["status"] == "expired", "expiry"] < p["trade_date"].max()).all()
    f = front_contracts(p, "GOLDTEN", min_dte=5)
    assert (f["dte"] >= 5).all()
    tr = transitions(f)
    assert tr and all(t["to_expiry"] > t["from_expiry"] for t in tr)


def test_implied_carry_recovered():
    p = panel_from(synthetic_rows(150, carry=0.07))
    cs = calendar_spreads(p, "GOLDTEN")
    assert cs["implied_carry"].median() == pytest.approx(0.07, abs=0.004)  # tick rounding noise only
    cr = carry_reference(p)
    assert cr["carry"].median() == pytest.approx(0.07, abs=0.004)


def test_carry_adjustment_removes_expiry_mismatch():
    # No real mispricing: GOLDM (5th) vs GOLDTEN (month end) differ only by carry.
    p = panel_from(synthetic_rows(200, carry=0.08))
    adj = pair_series(p, PairConfig(a="GOLDM", b="GOLDTEN", carry_adjust=True))
    raw = pair_series(p, PairConfig(a="GOLDM", b="GOLDTEN", carry_adjust=False))
    assert adj["spread_bps"].abs().median() < raw["spread_bps"].abs().median()
    assert adj["spread_bps"].abs().median() < 3.0
    assert (adj["expiry_gap"].abs() <= 10).all()


# ----------------------------------------------------------------- statistics
def test_rolling_stats_are_causal():
    p = panel_from(synthetic_rows(300, guinea_spread_bps=15))
    cfg = PairConfig(a="GOLDTEN", b="GOLDGUINEA", lookback=40, min_obs=20)
    full = pair_series(p, cfg)
    cut_date = full["trade_date"].iloc[150]
    trunc = pair_series(p[p["trade_date"] <= cut_date], cfg)
    a = full[full["trade_date"] <= cut_date].set_index("trade_date")[["mean", "std", "z", "pctile"]]
    b = trunc.set_index("trade_date")[["mean", "std", "z", "pctile"]]
    pd.testing.assert_frame_equal(a, b, check_exact=False, atol=1e-9)


def test_zscore_matches_manual_formula():
    m = pd.DataFrame({"spread_bps": [1.0, 2.0, 3.0, 4.0, 10.0]})
    out = add_rolling_stats(m, lookback=5, min_obs=5)
    s = m["spread_bps"]
    assert out["z"].iloc[-1] == pytest.approx((10 - s.mean()) / s.std(ddof=1))
    assert out["pctile"].iloc[-1] == 100.0
    assert out["z"].iloc[:4].isna().all()


def test_constant_spread_gives_no_zscore():
    out = add_rolling_stats(pd.DataFrame({"spread_bps": [5.0] * 10}), lookback=5, min_obs=5)
    assert out["z"].isna().all()


def test_summary_detects_mean_reversion():
    p = panel_from(synthetic_rows(400, guinea_spread_bps=15, ou_sigma_bps=10))
    st = summary_stats(pair_series(p, PairConfig(a="GOLDTEN", b="GOLDGUINEA")))
    # stationary sd ≈ 16.7 bps with AR(0.8) → standard error of the mean ≈ 2.5 bps over 400 days
    assert st["mean_bps"] == pytest.approx(-15, abs=8)
    assert st["mean_reversion_half_life_days"] is not None and st["mean_reversion_half_life_days"] < 10


# ----------------------------------------------------------------- quality
def test_quality_flags_injected_problems():
    rows = synthetic_rows(120)
    # suspicious jump
    i = next(k for k, r in enumerate(rows) if r["symbol"] == "GOLDTEN" and r["volume_lots"] > 0 and r["trade_date"] > "2024-03-01")
    rows[i] = dict(rows[i], close=rows[i]["close"] * 1.2, high=rows[i]["close"] * 1.2)
    # drop a whole day of GOLDPETAL (collection gap)
    gap_day = "2024-04-10"
    rows = [r for r in rows if not (r["symbol"] == "GOLDPETAL" and r["trade_date"] == gap_day)]
    p = panel_from(rows)
    assert len(suspicious_moves(p)) >= 1
    rep = quality_report(p, pd.DataFrame(columns=["reason"]), pd.DataFrame(columns=["identical"]))
    codes = {w["code"] for w in rep["warnings"]}
    assert "symbol_gaps" in codes and "suspicious_moves" in codes
    gaps = rep["symbol_gaps"]
    assert ((gaps["symbol"] == "GOLDPETAL") & (gaps["trade_date"] == pd.Timestamp(gap_day))).any()


def test_spec_verification_confirms_consistent_units():
    p = panel_from(synthetic_rows(60))
    v = {r["symbol"]: r for r in spec_verification(p)}
    assert all(v[s]["verdict"] == "confirmed" for s in ("GOLDM", "GOLDTEN", "GOLDGUINEA", "GOLDPETAL"))
