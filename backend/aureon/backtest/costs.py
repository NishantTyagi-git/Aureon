"""Transaction-cost model for MCX commodity futures.

All rates are *configurable assumptions*. Defaults approximate the published Indian statutory and
exchange charges for non-agricultural commodity futures; confirm current values with the exchange
circulars and your broker before relying on results.

  brokerage        flat ₹ per executed order (per leg, per side)
  exchange_txn     fraction of turnover (MCX transaction charges, ~₹2.10 per ₹1 lakh)
  ctt_sell         Commodity Transaction Tax on the sell side (0.01 % for non-agri futures)
  stamp_buy        stamp duty on the buy side (0.002 %)
  sebi_fee         SEBI turnover fee (₹10 per crore)
  gst              GST on brokerage + exchange + SEBI charges (18 %)
  slippage_ticks   adverse ticks per execution, applied to the execution price
"""
from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class CostModel:
    brokerage_per_order: float = 20.0
    exchange_txn_rate: float = 2.10e-5
    ctt_sell_rate: float = 1.0e-4
    stamp_buy_rate: float = 2.0e-5
    sebi_fee_rate: float = 1.0e-6
    gst_rate: float = 0.18
    slippage_ticks: float = 1.0
    multiplier: float = 1.0  # scales every component — used for cost-sensitivity analysis

    def fees(self, turnover: float, side: str) -> dict:
        """Explicit charges for one order with rupee ``turnover`` on ``side`` ('buy' or 'sell')."""
        m = self.multiplier
        brokerage = self.brokerage_per_order * m
        exch = turnover * self.exchange_txn_rate * m
        sebi = turnover * self.sebi_fee_rate * m
        ctt = turnover * self.ctt_sell_rate * m if side == "sell" else 0.0
        stamp = turnover * self.stamp_buy_rate * m if side == "buy" else 0.0
        gst = (brokerage + exch + sebi) * self.gst_rate
        total = brokerage + exch + sebi + ctt + stamp + gst
        return {"brokerage": brokerage, "exchange": exch, "sebi": sebi, "ctt": ctt, "stamp": stamp, "gst": gst,
                "total": total}

    def slipped_price(self, price: float, tick: float, side: str) -> float:
        slip = self.slippage_ticks * tick * self.multiplier
        return price + slip if side == "buy" else price - slip

    def round_trip_estimate(self, legs: list[tuple[float, float, float]]) -> float:
        """Approximate round-trip cost (₹) for legs given as (turnover, tick, quote_units_traded).
        Each leg is bought once and sold once; slippage on both executions."""
        total = 0.0
        for turnover, tick, units in legs:
            total += self.fees(turnover, "buy")["total"] + self.fees(turnover, "sell")["total"]
            total += 2 * self.slippage_ticks * tick * units * self.multiplier
        return total

    def to_dict(self) -> dict:
        return asdict(self)
