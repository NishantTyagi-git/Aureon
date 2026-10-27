"""MCX gold futures contract specifications and normalization constants.

Every field carries a provenance tag so the UI and docs can show how it was established:

* ``official_page``   – stated on https://www.mcxindia.com/products/bullion/gold (read 2026-10-26).
* ``empirical``       – confirmed from official bhavcopy data (value / volume / price consistency),
                        see :mod:`aureon.data.spec_verify`. Re-checked on every ingest.
* ``assumed``         – not machine-verified; must be confirmed against the contract-spec PDFs.

The official contract-specification PDFs are linked in ``SPEC_DOCUMENTS``. They could not be
machine-read during the build (bot protection + embedded CID fonts), so tick sizes and the purity
basis of historical contract series are flagged ``assumed`` until confirmed.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

RESEARCH_SYMBOLS = ("GOLDM", "GOLDTEN", "GOLDGUINEA", "GOLDPETAL")
REFERENCE_SYMBOLS = ("GOLD",)  # 1 kg contract, used only as a curve/carry reference
ALL_SYMBOLS = RESEARCH_SYMBOLS + REFERENCE_SYMBOLS

NORMALIZED_BASIS_GRAMS = 10.0  # all normalized prices are ₹ per 10 g of fine (pure) gold


@dataclass(frozen=True)
class ContractSpec:
    symbol: str
    name: str
    lot_grams: float  # physical gold per lot (trading unit)
    quote_grams: float  # grams the quoted price refers to
    purity: float  # fineness in parts per thousand (995 / 999)
    tick: float  # minimum price move in quote units (₹)
    expiry_pattern: str
    provenance: dict[str, str] = field(default_factory=dict)
    notes: str = ""

    @property
    def fine_grams_per_lot(self) -> float:
        return self.lot_grams * self.purity / 1000.0

    @property
    def quote_units_per_lot(self) -> float:
        """Multiplier from quoted price to rupee value of one lot."""
        return self.lot_grams / self.quote_grams

    def to_dict(self) -> dict:
        d = asdict(self)
        d["fine_grams_per_lot"] = self.fine_grams_per_lot
        d["quote_units_per_lot"] = self.quote_units_per_lot
        return d


SPECS: dict[str, ContractSpec] = {
    "GOLDM": ContractSpec(
        symbol="GOLDM",
        name="Gold Mini",
        lot_grams=100.0,
        quote_grams=10.0,
        purity=995.0,
        tick=1.0,
        expiry_pattern="5th calendar day of the contract month (previous business day if holiday)",
        provenance={"lot_grams": "official_page", "purity": "official_page", "quote_grams": "empirical",
                    "tick": "empirical", "expiry_pattern": "empirical"},
        notes="Quoted ₹ per 10 g of 995 gold; lot 100 g.",
    ),
    "GOLDTEN": ContractSpec(
        symbol="GOLDTEN",
        name="Gold Ten",
        lot_grams=10.0,
        quote_grams=10.0,
        purity=999.0,
        tick=1.0,
        expiry_pattern="Last business day of the contract month",
        provenance={"lot_grams": "official_page", "purity": "official_page", "quote_grams": "empirical",
                    "tick": "empirical", "expiry_pattern": "empirical"},
        notes="Quoted ₹ per 10 g of 999 gold; lot 10 g.",
    ),
    "GOLDGUINEA": ContractSpec(
        symbol="GOLDGUINEA",
        name="Gold Guinea",
        lot_grams=8.0,
        quote_grams=8.0,
        purity=999.0,
        tick=1.0,
        expiry_pattern="Last business day of the contract month",
        provenance={"lot_grams": "official_page", "purity": "official_page", "quote_grams": "empirical",
                    "tick": "empirical", "expiry_pattern": "empirical"},
        notes="Quoted ₹ per 8 g; lot 8 g. Older Guinea series may have used a different purity basis — "
              "check the persistent premium vs GOLDTEN before relying on early history.",
    ),
    "GOLDPETAL": ContractSpec(
        symbol="GOLDPETAL",
        name="Gold Petal",
        lot_grams=1.0,
        quote_grams=1.0,
        purity=999.0,
        tick=1.0,
        expiry_pattern="Last business day of the contract month",
        provenance={"lot_grams": "official_page", "purity": "official_page", "quote_grams": "empirical",
                    "tick": "empirical", "expiry_pattern": "empirical"},
        notes="Quoted ₹ per 1 g; lot 1 g. A ₹1 tick is ₹10 per 10 g — coarse relative to the 10 g contracts.",
    ),
    "GOLD": ContractSpec(
        symbol="GOLD",
        name="Gold (1 kg) — reference only",
        lot_grams=1000.0,
        quote_grams=10.0,
        purity=995.0,
        tick=1.0,
        expiry_pattern="5th calendar day of even contract months",
        provenance={"lot_grams": "official_page", "purity": "official_page", "quote_grams": "empirical",
                    "tick": "empirical", "expiry_pattern": "empirical"},
        notes="Used as a liquid curve reference for carry estimation; not part of the research universe.",
    ),
}

SPEC_DOCUMENTS = {
    "product_page": "https://www.mcxindia.com/products/bullion/gold",
    "GOLDM": "https://www.mcxindia.com/docs/default-source/about-us/gold-mini-august-2026-contract-onwards8a79913a-e8de-4136-9f0b-25d31dc163c4.pdf",
    "GOLDTEN": "https://www.mcxindia.com/docs/default-source/about-us/gold-ten-july-2026-contract-onwards.pdf",
    "GOLDGUINEA": "https://www.mcxindia.com/docs/default-source/about-us/gold-guinea-july-2026-contract-onwards.pdf",
    "GOLDPETAL": "https://www.mcxindia.com/docs/default-source/about-us/gold-petal-july-2026-contract-onwards.pdf",
    "GOLD": "https://www.mcxindia.com/docs/default-source/about-us/gold-february-2027-contract-onwards.pdf",
}


def get_spec(symbol: str) -> ContractSpec:
    try:
        return SPECS[symbol.strip().upper()]
    except KeyError as exc:  # pragma: no cover - defensive
        raise KeyError(f"No contract specification for {symbol!r}") from exc


def normalize_price(price: float, spec: ContractSpec, purity_adjust: bool = True) -> float:
    """Convert a quoted price to ₹ per 10 g, optionally of fine (100 %) gold.

    P_norm = P_quote × (10 / quote_grams) × (1000 / purity  if purity_adjust else 1)
    """
    if price is None:
        return float("nan")
    value = price * NORMALIZED_BASIS_GRAMS / spec.quote_grams
    if purity_adjust:
        value *= 1000.0 / spec.purity
    return value


def lot_value(price: float, spec: ContractSpec) -> float:
    """Rupee value of one lot at a quoted price."""
    return price * spec.quote_units_per_lot
