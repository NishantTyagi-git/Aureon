# Aureon — methodology, formulas and assumptions

This document states every formula and assumption the analytics rely on. If a number in the UI
cannot be traced to a rule below, it is a bug.

## 1. Contract specifications

| Symbol | Lot | Quoted per | Purity | Fine g / lot | Tick (assumed) | Expiry pattern (observed) |
|---|---|---|---|---|---|---|
| GOLDM | 100 g | 10 g | 995 | 99.5 | ₹1 | 5th of contract month (prior business day if holiday) |
| GOLDTEN | 10 g | 10 g | 999 | 9.99 | ₹1 | last business day of month |
| GOLDGUINEA | 8 g | 8 g | 999 | 7.992 | ₹1 | last business day of month |
| GOLDPETAL | 1 g | 1 g | 999 | 0.999 | ₹1 | last business day of month |
| GOLD (reference only) | 1 kg | 10 g | 995 | 995 | ₹1 | 5th of even months |

**How each field was verified**

* **Lot size and purity** — stated on the official MCX product page
  (<https://www.mcxindia.com/products/bullion/gold>, read 2026-10-26): Gold Mini 100 g / 995;
  Gold Ten 10 g / 999; Gold Guinea 8 g / 999; Gold Petal 1 g / 999.
* **Quotation unit and lot size, empirically** — the official bhavcopy publishes turnover
  (`Value`, ₹ lakh) and volume (lots). For every traded row,
  `turnover × 10⁵ / (lots × lot_grams / quote_grams)` must fall inside the day's high–low range.
  On the 23-Oct-2026 bhavcopy this holds for all five symbols (e.g. GOLDPETAL:
  23 509.95 lakh / 165 873 lots = ₹14 173 per lot, inside 14 088–14 250 ⇒ quoted per 1 g, lot 1 g).
  This check runs on **every ingest** (`validation.py`) and is summarised on the Quality page.
* **Tick** — not machine-verified from the spec PDFs. The Quality page reports the share of traded
  prices that lie on the assumed ₹1 grid. Secondary sources disagree for Gold Petal (₹1 vs ₹0.50).
* **Spec PDFs** (linked in `specs.py` and on the Data page) could not be machine-read during the
  build: MCX blocks non-browser clients, the PDFs embed subset CID fonts, and an LLM-based
  extraction attempt via TinyFish returned clearly wrong values (e.g. "GOLDTEN 1 kg"). Confirm tick
  sizes and historical purity bases against the PDFs before relying on early history.
* **Historical purity basis** — the current specs say 999 for Guinea/Ten/Petal. Earlier contract
  series may have differed; a persistent level shift in the GOLDGUINEA–GOLDTEN spread around a spec
  change date would reveal it.

## 2. Normalization

All products are converted to **₹ per 10 g of fine (100 %) gold**:

```
P_norm = P_quote × (10 / quote_grams) × (1000 / purity)
```

Without purity adjustment GOLDM (995) looks ~0.4 % cheaper than the 999 contracts for purely
mechanical reasons. Whether the 995 vs 999 price relationship is exactly proportional to fineness
in practice (refining premium, delivery logistics) is itself a research question; the UI shows both
the carry-adjusted and raw spreads.

## 3. Hedge sizing — no perfect hedges

Fine grams per lot differ (99.5, 9.99, 7.992, 0.999). For a target fine-gold size, integer lots are
chosen to minimise `|lots_A × fine_A − lots_B × fine_B|` within ±25 % of the target
(`backtest/sizing.py`). The **residual fine grams** are reported for every signal and trade and are
a real directional gold exposure. Signals are refused if the residual exceeds `max_residual_pct`.

## 4. Pair construction and expiry handling

* Only **traded** rows (`volume > 0`) are used as prices. Zero-volume rows carry MCX's reference
  close; they are kept, shown as "reference", and never treated as trades.
* Leg A on each day = nearest-expiry traded contract with `dte ≥ min_dte`.
* Leg B = traded contract whose expiry is closest to leg A's, if `|gap| ≤ max_expiry_gap`.
* GOLDM expires on the 5th, the small contracts at month-end, so the legs usually differ by ~5–6
  days. Every change of the (A, B) contract pair is recorded as a **segment**/roll.

## 5. Carry adjustment

Market-implied carry from two expiries of one product on the same day:

```
r = ln(F₂ / F₁) / ((T₂ − T₁) / 365)
```

The reference carry series uses the first available of GOLDM, GOLD, GOLDTEN, GOLDPETAL front/next
pairs (traded only, |r| < 50 %), then a 5-observation trailing median (causal). Each leg is put on a
spot-equivalent footing with `adj = P_norm × exp(−r × dte / 365)`. Days without a carry estimate
are dropped from carry-adjusted analysis rather than filled. Assumption: one carry rate applies to
all gold contracts on a day (they share the underlying); differences in carry between products are
then part of the measured spread.

## 6. Spread statistics

```
spread_abs = adj_A − adj_B                      (₹ per 10 g fine)
spread_bps = 10 000 × ln(adj_A / adj_B)
mean, σ    = rolling mean / sample std over the last `lookback` observations (incl. today)
z          = (spread_bps − mean) / σ           (undefined if σ = 0 or < min_obs observations)
percentile = share of window values ≤ today's value
half-life  = −ln 2 / ln(1 + β), from Δs_t = α + β s_{t−1} within contract segments (β < 0 only)
```

Everything is computed from data at or before day *t* (tested in `test_rolling_stats_are_causal`).

## 7. Signal rules

A signal at day *t* requires **all** of:

| Check | Rule |
|---|---|
| history | rolling stats available (≥ `min_obs`) |
| z_threshold | `|z| ≥ entry_z` |
| expiry | both legs `dte ≥ min_entry_dte` |
| roll_settled | ≥ `min_segment_obs` days on the current contract pair |
| liquidity | our lots ≤ `max_participation` × day volume, OI ≥ `min_open_interest`, both legs |
| hedge_residual | `|residual| ≤ max_residual_pct` of leg A fine grams |
| cost_hurdle | `|spread − mean|` (bps) × min leg notional ≥ `cost_multiple` × estimated round-trip cost |
| data_quality | neither leg flagged as a suspicious move that day |

`z > 0` ⇒ short spread (sell A, buy B); `z < 0` ⇒ long spread. The "expected edge" assumes full
reversion to the rolling mean — an optimistic upper bound, which is why a cost multiple > 1 is used.

## 8. Backtest

* **Timing**: decide on close *t*; execute at close (default) or open of *t+1* in the **specific
  contracts** selected on *t*. If a leg did not trade on *t+1*, entries are cancelled and exits are
  retried the next day.
* **Exits** (decided on close, executed next day): business days to the nearer expiry ≤ `exit_dte`
  (min 2, so execution precedes expiry), z back within `exit_z`, z beyond `stop_z`,
  `max_holding_days`, or end of window (closed at that day's close with slippage).
* **No rolling**: a position never migrates to another expiry.
* **Prices**: every fill = official price ± `slippage_ticks × tick` against us.
* **P&L**: `side × lots × (lot_g / quote_g) × Δprice` per leg; mark-to-market on official closes.
* **Attribution** (exact): with signed fine grams `g_A`, `g_B` and fine-gold price changes per gram
  `Δa`, `Δb`: directional = `(g_A + g_B) × Δb`, relative = `g_A × (Δa − Δb)`.
* **Costs** (all configurable, defaults are approximations to verify): brokerage ₹20/order,
  exchange 2.1e-5 of turnover, CTT 0.01 % on sells, stamp 0.002 % on buys, SEBI ₹10/crore, GST 18 %
  on brokerage + exchange + SEBI. Sensitivity runs scale all costs by 0–3×.

## 9. Walk-forward validation

Folds of `train | validation | test` pair observations, rolled forward by the test length:
parameters (lookback × entry z grid) are chosen on train by net P&L (≥ `min_train_trades`),
confirmed on validation (fold **abstains** if the setting traded there and lost money; a validation window with no trades is not counted against it and the fold is marked unconfirmed), then applied unchanged to the
unseen test window. Only test windows are stitched into the reported out-of-sample result.

If a pair has fewer shared trading days than train + validation + test (e.g. GOLDTEN pairs, whose
history starts in March 2025), the windows are shortened to 55 % / 15 % / 15 % of the available days
and the result says so. Below 150 shared days the test is refused. A period sits out only when the chosen
setting traded in the validation window and lost money; the reason is reported per period.

**Sizing and margin.** Defaults: 200 g of pure gold per side and a ₹10 lakh account. Results report the
peak exchange margin, estimated at 8 % of the value of both legs (MCX gold margins are typically
6–10 % and vary with volatility), and warn when it exceeds the account size.

## 10. Verdicts

The app never claims profitability by default. Verdict rules (`metrics.verdict`):
no trades or < 20 trades ⇒ *insufficient evidence*; net ≤ 0 with gross > 0 ⇒ *unprofitable after
costs*; net > 0 but trade t-stat < 2 ⇒ *not significant*; otherwise *positive — verify* (still
subject to capacity, cost and regime checks).

## 11. Data quality rules

Expiry-day rows whose close lies outside the traded range are rejected as
`expiry_settlement_price`: on the last trading day MCX reports the final settlement price as the
close, which is not a traded price. Requested days that failed to download (as opposed to holidays,
reported by MCX as "No data found") are listed as a quality warning, because the empirical calendar
cannot otherwise see them.

Rejected at ingest: non-positive close, high < low, close/open outside the range, negative
quantities, rows after expiry, turnover inconsistent with prices, conflicting duplicates within a
payload. Reported (never edited): missing contract-days, symbol gap days, stale zero-volume runs,
moves above max(4 %, 6 × robust σ), cross-product deviations > 150 bps, tick-grid conformity,
freshness. Duplicates across payloads keep the first-ingested value; conflicts are logged.

## 12. Known limitations

* Daily data only: no intraday synchronicity — the two legs' closes may not be simultaneous, which
  inflates apparent spread noise, especially for thinly traded legs.
* Bhavcopy "close" for MCX is the official closing price; true executable prices may differ.
* Margin, funding of margin, and delivery obligations are not modelled (positions exit before
  expiry to avoid delivery).
* Costs and tick sizes are assumptions until confirmed against current circulars.
