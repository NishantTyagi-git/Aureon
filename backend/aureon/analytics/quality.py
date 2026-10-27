"""Data-quality diagnostics. Nothing here modifies data; it only reports.

Checks
------
* coverage            observations vs. exchange trading days for every contract
* missing dates       trading days on which a live contract has no row
* stale prices        runs of zero-volume days (reference price repeated, no trades)
* suspicious moves    |daily log change| far outside the contract's robust volatility
* cross-product       a product's front normalized price far from the other products' median
* tick conformity     closes that are not multiples of the assumed tick
* spec verification   turnover-implied average price vs. traded range (lot/quote-unit check)
* data freshness      latest data date vs. today
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from ..specs import RESEARCH_SYMBOLS, SPECS
from .lifecycle import contract_table
from .panel import trading_calendar


def missing_dates(panel: pd.DataFrame) -> pd.DataFrame:
    cal = trading_calendar(panel)
    rows = []
    for (sym, exp), g in panel.groupby(["symbol", "expiry"]):
        live = cal[(cal >= g["trade_date"].min()) & (cal <= min(exp, cal[-1]))]
        miss = live.difference(pd.DatetimeIndex(g["trade_date"]))
        for d in miss:
            rows.append({"symbol": sym, "expiry": exp, "trade_date": d})
    return pd.DataFrame(rows, columns=["symbol", "expiry", "trade_date"])


def symbol_gaps(panel: pd.DataFrame) -> pd.DataFrame:
    """Trading days on which a symbol has no rows at all (e.g. before launch or a collection gap)."""
    cal = trading_calendar(panel)
    rows = []
    for sym, g in panel.groupby("symbol"):
        have = pd.DatetimeIndex(g["trade_date"].unique())
        span = cal[(cal >= have.min()) & (cal <= have.max())]
        for d in span.difference(have):
            rows.append({"symbol": sym, "trade_date": d})
    return pd.DataFrame(rows, columns=["symbol", "trade_date"])


def stale_runs(panel: pd.DataFrame, min_run: int = 3) -> pd.DataFrame:
    rows = []
    for (sym, exp), g in panel.sort_values("trade_date").groupby(["symbol", "expiry"]):
        flag = ~g["traded"].values
        start = None
        for i, f in enumerate(list(flag) + [False]):
            if f and start is None:
                start = i
            elif not f and start is not None:
                if i - start >= min_run:
                    rows.append({"symbol": sym, "expiry": exp, "start": g["trade_date"].iloc[start],
                                 "end": g["trade_date"].iloc[i - 1], "days": i - start,
                                 "min_dte": int(g["dte"].iloc[i - 1])})
                start = None
    return pd.DataFrame(rows, columns=["symbol", "expiry", "start", "end", "days", "min_dte"])


def suspicious_moves(panel: pd.DataFrame, k: float = 6.0, floor: float = 0.04) -> pd.DataFrame:
    rows = []
    t = panel[panel["traded"]].sort_values("trade_date")
    for (sym, exp), g in t.groupby(["symbol", "expiry"]):
        if len(g) < 5:
            continue
        r = np.log(g["close"]).diff()
        gap = g["trade_date"].diff().dt.days
        mad = (r - r.median()).abs().median()
        sigma = 1.4826 * mad if mad and mad > 0 else r.std()
        thr = max(floor, k * (sigma or 0))
        bad = r.abs() > thr
        for idx in g.index[bad.fillna(False).values]:
            rows.append({"symbol": sym, "expiry": exp, "trade_date": g.at[idx, "trade_date"],
                         "log_change": float(r.loc[idx]), "threshold": float(thr),
                         "calendar_gap_days": int(gap.loc[idx]) if pd.notna(gap.loc[idx]) else None,
                         "close": float(g.at[idx, "close"])})
    return pd.DataFrame(rows)


def cross_product_outliers(panel: pd.DataFrame, threshold_bps: float = 150.0, min_dte: int = 3) -> pd.DataFrame:
    p = panel[panel["traded"] & (panel["dte"] >= min_dte) & panel["symbol"].isin(RESEARCH_SYMBOLS)]
    front = p.sort_values(["trade_date", "expiry"]).groupby(["trade_date", "symbol"]).head(1)
    rows = []
    for d, g in front.groupby("trade_date"):
        if len(g) < 3:
            continue
        for _, r in g.iterrows():
            others = g[g["symbol"] != r["symbol"]]["norm"]
            dev = 1e4 * np.log(r["norm"] / others.median())
            if abs(dev) > threshold_bps:
                rows.append({"trade_date": d, "symbol": r["symbol"], "expiry": r["expiry"],
                             "deviation_bps": float(dev), "norm": float(r["norm"])})
    return pd.DataFrame(rows)


def tick_conformity(panel: pd.DataFrame) -> list[dict]:
    out = []
    for sym, g in panel[panel["traded"]].groupby("symbol"):
        tick = SPECS[sym].tick
        prices = pd.concat([g["close"], g["high"], g["low"]]).dropna()
        off = (np.abs(prices / tick - np.round(prices / tick)) > 1e-6)
        out.append({"symbol": sym, "assumed_tick": tick, "prices_checked": int(len(prices)),
                    "off_grid": int(off.sum()), "conforming_pct": float(100 * (1 - off.mean())) if len(prices) else None})
    return out


def spec_verification(panel: pd.DataFrame) -> list[dict]:
    """For traded rows, turnover / (lots × lot multiplier) must fall inside [low, high].
    A median ratio near 1 confirms both the lot size and the quotation unit."""
    out = []
    t = panel[panel["traded"] & (panel["value_lakhs"].fillna(0) > 0)]
    for sym, g in t.groupby("symbol"):
        spec = SPECS[sym]
        vwap = g["value_lakhs"] * 1e5 / (g["volume_lots"] * spec.quote_units_per_lot)
        mid = (g["high"] + g["low"]) / 2
        ratio = vwap / mid
        inside = ((vwap >= g["low"] * 0.995) & (vwap <= g["high"] * 1.005))
        weight = g["volume_lots"] >= 20  # tiny volumes make the rounded turnover imprecise
        verdict = "confirmed" if len(g) and abs(ratio[weight].median() - 1) < 0.005 else "check"
        out.append({"symbol": sym, "rows": int(len(g)), "median_ratio": float(ratio.median()) if len(g) else None,
                    "inside_range_pct": float(100 * inside[weight].mean()) if weight.any() else None,
                    "lot_grams": spec.lot_grams, "quote_grams": spec.quote_grams, "verdict": verdict})
    return out


def quality_report(panel: pd.DataFrame, rejections: pd.DataFrame, duplicates: pd.DataFrame,
                   today: date | None = None) -> dict:
    today = today or date.today()
    if panel.empty:
        return {"empty": True, "rejections": _reason_counts(rejections), "warnings": [
            {"level": "error", "code": "no_data", "message": "No market data has been loaded yet."}]}
    cal = trading_calendar(panel)
    contracts = contract_table(panel)
    miss = missing_dates(panel)
    gaps = symbol_gaps(panel)
    stale = stale_runs(panel)
    sus = suspicious_moves(panel)
    xo = cross_product_outliers(panel)
    ticks = tick_conformity(panel)
    specv = spec_verification(panel)
    latest = cal[-1].date()
    bdays_behind = int(np.busday_count(latest, today)) if today > latest else 0

    warnings = []
    if bdays_behind > 2:
        warnings.append({"level": "warn", "code": "stale_dataset",
                         "message": f"The newest prices are from {latest}, {bdays_behind} business days ago. Load recent data to stay current."})
    for sym in RESEARCH_SYMBOLS:
        if sym not in set(panel["symbol"]):
            warnings.append({"level": "warn", "code": "symbol_missing", "message": f"No data has been loaded for {sym}."})
    if len(gaps):
        warnings.append({"level": "warn", "code": "symbol_gaps",
                         "message": f"{len(gaps)} trading days have no data for a product that was otherwise covered — likely gaps in collection."})
    if len(miss):
        warnings.append({"level": "info", "code": "contract_missing_days",
                         "message": f"{len(miss)} days where a contract was trading but no price was published for it."})
    if len(sus):
        warnings.append({"level": "warn", "code": "suspicious_moves",
                         "message": f"{len(sus)} unusually large one-day price jumps were flagged. Most match real market events (e.g. late Jan 2026), but they are worth a look."})
    if len(xo):
        warnings.append({"level": "warn", "code": "cross_product_outliers",
                         "message": f"On {len(xo)} days one product's comparable price was more than 1.5% away from the others — partly persistent premiums of the small contracts."})
    for s in specv:
        if s["verdict"] != "confirmed":
            warnings.append({"level": "error", "code": "spec_unverified",
                             "message": f"{s['symbol']}: the traded values don't match the assumed contract size — normalized prices may be wrong."})
    for t in ticks:
        if t["conforming_pct"] is not None and t["conforming_pct"] < 99:
            warnings.append({"level": "info", "code": "tick_mismatch",
                             "message": f"{t['symbol']}: {t['off_grid']} prices are not whole multiples of the assumed ₹{t['assumed_tick']} price step."})
    failed = collection_failures(rejections)
    if failed:
        warnings.append({"level": "warn", "code": "collection_failures",
                         "message": f"{len(failed)} day(s) failed to download and are missing entirely: "
                                    f"{', '.join(failed[:8])}{'…' if len(failed) > 8 else ''}. Re-collect them to fill the gap."})
    if len(rejections):
        warnings.append({"level": "info", "code": "rejections",
                         "message": f"{len(rejections)} rows were rejected when importing (kept for audit, never used)."})
    if len(duplicates) and (duplicates["identical"] == 0).any():
        n = int((duplicates["identical"] == 0).sum())
        warnings.append({"level": "warn", "code": "conflicting_duplicates",
                         "message": f"{n} prices were imported twice with different values; the first one is kept."})

    coverage_by_symbol = []
    for sym, g in panel.groupby("symbol"):
        coverage_by_symbol.append({
            "symbol": sym, "first_date": g["trade_date"].min(), "last_date": g["trade_date"].max(),
            "days": int(g["trade_date"].nunique()), "contracts": int(g["expiry"].nunique()),
            "rows": int(len(g)), "traded_rows": int(g["traded"].sum()),
            "zero_volume_rows": int((~g["traded"]).sum()),
            "gap_days": int((gaps["symbol"] == sym).sum()) if len(gaps) else 0,
        })
    heat = (panel.assign(month=panel["trade_date"].dt.to_period("M").astype(str))
            .groupby(["symbol", "month"])["trade_date"].nunique().reset_index(name="days"))
    cal_month = pd.Series(cal).dt.to_period("M").astype(str).value_counts().rename("calendar_days")
    heat = heat.join(cal_month, on="month")

    return {
        "empty": False,
        "latest_date": latest, "first_date": cal[0].date(), "trading_days": int(len(cal)),
        "business_days_behind": bdays_behind,
        "warnings": warnings,
        "coverage_by_symbol": coverage_by_symbol,
        "coverage_heatmap": heat.to_dict("records"),
        "contracts": contracts,
        "missing_contract_days": miss.tail(500),
        "symbol_gaps": gaps.tail(500),
        "stale_runs": stale,
        "suspicious_moves": sus,
        "cross_product_outliers": xo.tail(300) if len(xo) else xo,
        "tick_conformity": ticks,
        "spec_verification": specv,
        "rejections": _reason_counts(rejections),
        "rejection_samples": rejections.head(50).to_dict("records") if len(rejections) else [],
        "duplicates": {"total": int(len(duplicates)),
                       "conflicting": int((duplicates["identical"] == 0).sum()) if len(duplicates) else 0},
    }


def collection_failures(rej: pd.DataFrame) -> list[str]:
    """Requested days whose download failed (as opposed to exchange holidays, which MCX reports as
    'No data found.'). The empirical calendar cannot see these days, so they are surfaced explicitly."""
    if rej is None or rej.empty:
        return []
    import json
    out = []
    src = rej[(rej["reason"] == "source_error") & (rej["detail"].fillna("") != "No data found.")]
    for raw in src["row_json"].fillna("null"):
        try:
            req = json.loads(raw) or {}
        except ValueError:
            req = {}
        out.append(str(req.get("fromDate") or req.get("date") or "unknown date"))
    return sorted(set(out))


def _reason_counts(rej: pd.DataFrame) -> dict:
    if rej is None or rej.empty:
        return {}
    return rej["reason"].value_counts().to_dict()
