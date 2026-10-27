"""Row-level validation applied before anything reaches the ``quotes`` table.

Hard failures reject the row (kept in ``rejections`` with a reason). Rows that are valid but carry
no trade (zero volume) are kept: their ``close`` is MCX's reference/settlement price and analytics
treat them as *not tradable* rather than as observed trades.
"""
from __future__ import annotations

from datetime import date

from ..specs import get_spec

# value_lakhs is published rounded to 0.01 lakh = ₹1,000
VALUE_ROUNDING_RUPEES = 1000.0
VALUE_PRICE_TOLERANCE = 0.02  # 2 % outside [low, high] is allowed for rounding of the published value


def implied_average_price(row: dict) -> float | None:
    """Volume-weighted average price implied by turnover: value / (lots × quote units per lot)."""
    vol, val = row.get("volume_lots"), row.get("value_lakhs")
    if not vol or not val or vol <= 0 or val <= 0:
        return None
    spec = get_spec(row["symbol"])
    return val * 1e5 / (vol * spec.quote_units_per_lot)


def validate_row(row: dict) -> tuple[dict | None, dict | None]:
    """Return (clean_row, rejection). Exactly one is not None."""
    def rej(reason: str, detail: str) -> tuple[None, dict]:
        return None, {"reason": reason, "detail": detail, "row": row, "trade_date": row.get("trade_date"),
                      "symbol": row.get("symbol"), "expiry": row.get("expiry")}

    r = dict(row)
    close = r.get("close")
    if close is None or close <= 0:
        return rej("invalid_price", f"close={close}")
    if date.fromisoformat(r["expiry"]) < date.fromisoformat(r["trade_date"]):
        return rej("expired_contract", f"expiry {r['expiry']} before trade date {r['trade_date']}")
    for k in ("volume_lots", "value_lakhs", "open_interest"):
        if r.get(k) is not None and r[k] < 0:
            return rej("invalid_quantity", f"{k}={r[k]}")

    vol = r.get("volume_lots") or 0
    if vol <= 0:
        # No trade: MCX reports zeros for O/H/L. Keep the reference close, drop meaningless zeros.
        for k in ("open", "high", "low"):
            if not r.get(k):
                r[k] = None
        return r, None

    o, h, lo = r.get("open"), r.get("high"), r.get("low")
    if h is None or lo is None or h <= 0 or lo <= 0:
        return rej("invalid_price", f"traded row without high/low (high={h}, low={lo})")
    if h < lo:
        return rej("invalid_ohlc", f"high {h} < low {lo}")
    if not (lo - 1e-9 <= close <= h + 1e-9):
        if r["trade_date"] == r["expiry"]:
            # On expiry day MCX reports the final settlement price (DDR-based) as the close.
            return rej("expiry_settlement_price",
                       f"expiry-day close {close} is a settlement price outside traded range [{lo}, {h}]")
        return rej("invalid_ohlc", f"close {close} outside [{lo}, {h}]")
    if o is not None and o > 0 and not (lo - 1e-9 <= o <= h + 1e-9):
        return rej("invalid_ohlc", f"open {o} outside [{lo}, {h}]")

    vwap = implied_average_price(r)
    if vwap is not None:
        spec = get_spec(r["symbol"])
        slack = VALUE_ROUNDING_RUPEES / (vol * spec.quote_units_per_lot)
        lo_ok = lo * (1 - VALUE_PRICE_TOLERANCE) - slack
        hi_ok = h * (1 + VALUE_PRICE_TOLERANCE) + slack
        if not (lo_ok <= vwap <= hi_ok):
            return rej("value_volume_inconsistent",
                       f"turnover-implied avg price {vwap:.2f} outside [{lo}, {h}] — lot/quote unit mismatch "
                       f"or corrupted extraction")
    return r, None


def validate_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    good, bad = [], []
    seen: dict[tuple, dict] = {}
    for row in rows:
        clean, rej = validate_row(row)
        if rej:
            bad.append(rej)
            continue
        key = (clean["trade_date"], clean["symbol"], clean["expiry"])
        if key in seen:
            if seen[key] != clean:
                bad.append({"reason": "duplicate_conflict_in_payload", "detail": "same key twice with different values",
                            "row": row, "trade_date": key[0], "symbol": key[1], "expiry": key[2]})
            continue
        seen[key] = clean
        good.append(clean)
    return good, bad
