"""Lot sizing for a two-leg gold position.

Contracts have different physical sizes (100 g, 10 g, 8 g, 1 g) and purities (995, 999), so a
hedge is almost never exact. We choose integer lot counts that minimise the residual *fine-gold*
exposure and report that residual explicitly — it is real directional gold exposure.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..specs import get_spec


@dataclass
class LegSizing:
    lots_a: int
    lots_b: int
    fine_grams_a: float
    fine_grams_b: float
    residual_fine_grams: float  # fine grams long A minus fine grams of B (for a long-A / short-B position)

    @property
    def residual_pct(self) -> float:
        return 100.0 * self.residual_fine_grams / self.fine_grams_a if self.fine_grams_a else 0.0

    def to_dict(self) -> dict:
        return {"lots_a": self.lots_a, "lots_b": self.lots_b, "fine_grams_a": self.fine_grams_a,
                "fine_grams_b": self.fine_grams_b, "residual_fine_grams": self.residual_fine_grams,
                "residual_pct": self.residual_pct}


def size_pair(a: str, b: str, target_fine_grams: float, max_lots: int = 5000,
              search_slack: float = 0.25) -> LegSizing:
    """Find (lots_a, lots_b) with A's fine grams within ±``search_slack`` of the target that minimise
    |residual|; ties prefer A closest to the target."""
    sa, sb = get_spec(a), get_spec(b)
    ga, gb = sa.fine_grams_per_lot, sb.fine_grams_per_lot
    lo = max(1, int((target_fine_grams * (1 - search_slack)) // ga))
    hi = max(lo, min(max_lots, int(round(target_fine_grams * (1 + search_slack) / ga))))
    best: LegSizing | None = None
    best_key = None
    for na in range(lo, hi + 1):
        nb = max(1, int(round(na * ga / gb)))
        if nb > max_lots:
            continue
        resid = na * ga - nb * gb
        key = (round(abs(resid), 9), abs(na * ga - target_fine_grams))
        if best_key is None or key < best_key:
            best_key = key
            best = LegSizing(na, nb, na * ga, nb * gb, resid)
    if best is None:
        nb = max(1, int(round(ga / gb)))
        best = LegSizing(1, nb, ga, nb * gb, ga - nb * gb)
    return best
