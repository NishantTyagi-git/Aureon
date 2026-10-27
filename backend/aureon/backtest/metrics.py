"""Performance and risk metrics. Figures are descriptive of the sample; with few trades they carry
large uncertainty, which is reported (t-statistic, trade count) rather than hidden."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

TRADING_DAYS = 252
# Assumed exchange margin as a share of position value (both legs). MCX gold futures margins are
# typically in the 6-10 % range and change with volatility; this is an estimate, not a quote.
MARGIN_RATE = 0.08


def max_drawdown(equity: pd.Series) -> tuple[float, float]:
    """Return (max drawdown in ₹, max drawdown as fraction of running peak)."""
    if equity.empty:
        return 0.0, 0.0
    peak = equity.cummax()
    dd = equity - peak
    return float(dd.min()), float((dd / peak).min())


def performance(result: dict, capital: float, gold_returns: pd.Series | None = None) -> dict:
    trades = pd.DataFrame(result.get("trades", []))
    daily = result.get("daily", pd.DataFrame())
    out: dict = {"trade_count": int(len(trades))}
    if daily is None or daily.empty:
        return {**out, "verdict": "no_data"}
    net = daily["net"]
    ret = daily["return"]
    days = len(daily)
    years = days / TRADING_DAYS
    total_net = float(net.sum())
    mdd_abs, mdd_pct = max_drawdown(daily["equity"])
    vol = float(ret.std(ddof=1) * math.sqrt(TRADING_DAYS)) if days > 1 else 0.0
    sharpe = float(ret.mean() / ret.std(ddof=1) * math.sqrt(TRADING_DAYS)) if days > 1 and ret.std() > 0 else None
    out.update({
        "days": days, "years": years,
        "gross_pnl": float(daily["gross"].sum()), "costs": float(daily["costs"].sum()), "net_pnl": total_net,
        "directional_pnl": float(daily["directional"].sum()), "relative_pnl": float(daily["relative"].sum()),
        "total_return": total_net / capital,
        "annualized_return": (total_net / capital) / years if years > 0 else None,
        "annualized_volatility": vol, "sharpe": sharpe,
        "max_drawdown": mdd_abs, "max_drawdown_pct": mdd_pct,
        "time_in_market": float(daily["in_position"].mean()),
        "turnover": float(_turnover(trades) / capital) if len(trades) else 0.0,
        "avg_gross_notional": float(daily.loc[daily["in_position"], "gross_notional"].mean())
        if daily["in_position"].any() else 0.0,
        "peak_gross_notional": float(daily["gross_notional"].max()) if "gross_notional" in daily else 0.0,
        "margin_rate": MARGIN_RATE,
    })
    out["peak_margin"] = out["peak_gross_notional"] * MARGIN_RATE
    out["margin_exceeds_capital"] = bool(out["peak_margin"] > capital)
    if len(trades):
        wins = trades["net"] > 0
        gw, gl = trades.loc[wins, "net"].sum(), -trades.loc[~wins, "net"].sum()
        mean_t, sd_t = trades["net"].mean(), trades["net"].std(ddof=1)
        out.update({
            "win_rate": float(wins.mean()),
            "avg_trade_net": float(mean_t), "median_trade_net": float(trades["net"].median()),
            "best_trade": float(trades["net"].max()), "worst_trade": float(trades["net"].min()),
            "profit_factor": float(gw / gl) if gl > 0 else None,
            "avg_holding_days": float(trades["holding_days"].mean()),
            "cost_share_of_gross": float(trades["costs"].sum() / trades["gross"].abs().sum())
            if trades["gross"].abs().sum() > 0 else None,
            "trade_t_stat": float(mean_t / (sd_t / math.sqrt(len(trades)))) if len(trades) > 1 and sd_t > 0 else None,
            "exit_reasons": trades["exit_reason"].value_counts().to_dict(),
            "gross_profitable_trades": float((trades["gross"] > 0).mean()),
        })
    if gold_returns is not None and not gold_returns.empty:
        j = pd.concat([ret.set_axis(daily["trade_date"]), gold_returns], axis=1, join="inner").dropna()
        j.columns = ["s", "g"]
        j = j[daily.set_index("trade_date").loc[j.index, "in_position"]]
        if len(j) > 10 and j["g"].var() > 0:
            out["gold_beta"] = float(np.cov(j["s"], j["g"])[0, 1] / j["g"].var())
            out["gold_correlation"] = float(j["s"].corr(j["g"]))
    out["verdict"] = verdict(out)
    return out


def _turnover(trades: pd.DataFrame) -> float:
    from ..specs import get_spec
    total = 0.0
    for _, t in trades.iterrows():
        sa, sb = get_spec(t["symbol_a"]), get_spec(t["symbol_b"])
        total += t["lots_a"] * sa.quote_units_per_lot * (t["entry_a"] + t["exit_a"])
        total += t["lots_b"] * sb.quote_units_per_lot * (t["entry_b"] + t["exit_b"])
    return total


def verdict(m: dict) -> dict:
    """A conservative, evidence-based statement. Profitability is only claimed when net P&L is
    positive, there are enough trades, and the mean trade is statistically distinguishable from 0."""
    n = m.get("trade_count", 0)
    net = m.get("net_pnl", 0.0)
    t = m.get("trade_t_stat")
    gross = m.get("gross_pnl", 0.0)
    if n == 0:
        return {"label": "insufficient_evidence", "text": "The strategy never traded in this period, so there is no evidence either way. Try a more relaxed setting or a different pair."}
    if n < 20:
        return {"label": "insufficient_evidence",
                "text": f"Only {n} trades — too few to tell a real pattern from luck. Net result ₹{net:,.0f}; at least 20 trades are needed before drawing conclusions."}
    if net <= 0 and gross > 0:
        return {"label": "unprofitable_after_costs",
                "text": f"Before costs the strategy made ₹{gross:,.0f}, but trading costs turned that into ₹{net:,.0f}. There is no profit left after costs."}
    if net <= 0:
        return {"label": "unprofitable", "text": f"The strategy lost ₹{-net:,.0f} over {n} trades. No profitable pattern was found."}
    if t is None or t < 2.0:
        return {"label": "not_significant",
                "text": f"The strategy made ₹{net:,.0f} over {n} trades, but results vary so much from trade to trade that "
                        f"luck can't be ruled out (confidence t = {t if t is None else round(t, 2)}, needs about 2). Treat as unproven."}
    return {"label": "positive_but_verify",
            "text": f"The strategy made ₹{net:,.0f} over {n} trades with reasonable statistical confidence (t = {t:.2f}). "
                    f"Promising in this period — confirm on unseen data and with higher costs before relying on it."}
