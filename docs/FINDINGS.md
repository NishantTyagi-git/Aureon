# Aureon research findings — MCX gold contracts, Jan 2023 – Oct 2026

**Bottom line: no persistent, statistically supported relative-value profit after costs was found.**
Spreads between the four gold contracts are real, sizeable and partly mean-reverting, but the
backtested profits rest on a handful of trades, concentrate in one market-stress episode
(Jan–Feb 2026), and do not hold up out of sample with significance.

## Data

* Source: official MCX date-wise bhavcopy (FUTCOM), collected with the in-browser collector,
  2 Jan 2023 – 23 Oct 2026. Raw bundle archived as raw payload #1 (6.8 MB, SHA-256 in the Data view).
* 977 exchange days; 20,283 gold-futures rows parsed, 20,268 validated.
* Rejected: 15 expiry-day rows where MCX reports the **final settlement price** as the close (outside
  the traded range — kept for audit, never used as a trade price); 17 exchange holidays
  ("No data found"); **1 day failed to download (3 Feb 2026)** — absent, not filled.
* **GOLDTEN data starts 31 Mar 2025**; the other contracts cover the full period.
* Spec check from the data itself: turnover ÷ (lots × lot multiplier) lands inside the traded range for
  100 % of traded rows of every contract (lot 100 g / 10 g / 8 g / 1 g; quoted per 10 g / 10 g / 8 g / 1 g).
  100 % of traded prices sit on a ₹1 tick grid.

## Structural pricing differences (₹/10 g fine, front contract vs GOLDM, quarterly median)

| Period | GOLDTEN | GOLDGUINEA | GOLDPETAL |
|---|---|---|---|
| 2023 | n/a | −61 … +95 bps | −25 … −177 bps |
| 2024 | n/a | +35 … +97 bps | −3 … −203 bps |
| 2025 | −16 … −20 bps | +9 … +83 bps | +24 … +90 bps |
| 2026 | −13 … +25 bps | +9 … +196 bps | +7 … +242 bps |

* The small contracts (Guinea, Petal) trade at persistent, time-varying premia/discounts to the
  10 g/100 g contracts — far larger than the 995/999 purity difference (~40 bps), which is already
  normalized away.
* **GOLDPETAL flips from a ~150–200 bps discount (2023–24) to a premium (2025–26)**, coinciding with the
  "Gold Petal April 2025 contracts onwards" specification. Pre-2025 Petal prices may not be economically
  comparable to later ones; treat Petal pairs before 2025 with caution.
* Carry-adjusted spread volatility is large (σ ≈ 42 bps for GOLDM/GOLDTEN, 58–136 bps for pairs with
  the small contracts). AR(1) half-lives within contract pairs: ~7 days (GOLDM/TEN, GOLDM/GUINEA,
  TEN/GUINEA), 12–26 days (Petal pairs), ~72 days (GUINEA/PETAL).

## Backtests (default settings: |z| ≥ 2 on a 60-obs window, 1 kg fine target, next-day close fills, 1-tick slippage, statutory costs, cost hurdle 1.5×)

| Pair | Trades | Net (₹) | Net excl. best trade | Trade t | Walk-forward OOS |
|---|---|---|---|---|---|
| GOLDM / GOLDTEN | 3 | +2.41 L | −6.8 k | 0.96 | not enough history (338 obs) |
| GOLDM / GOLDGUINEA | 7 | +3.65 L | +29.7 k | 1.02 | 12 trades, +4.28 L — insufficient evidence |
| GOLDM / GOLDPETAL | 15 | +4.67 L | +3.03 L | 1.79 | 7 trades, **−3.94 L** |
| GOLDTEN / GOLDGUINEA | 8 | +3.19 L | +1.55 L | 1.99 | 1 fold, abstained |
| GOLDTEN / GOLDPETAL | 7 | +1.02 L | +1.8 k | 0.70 | 2 trades, −45.8 k |
| GOLDGUINEA / GOLDPETAL | 8 | +79 k | −27.1 k | 0.43 | 5 trades, +1.68 L — insufficient evidence |

Why these numbers are not evidence of an edge:

1. **Too few trades.** No pair reaches 20 trades; no default-setting t-stat reaches 2.
2. **Concentration.** For GOLDM/GOLDTEN and GOLDM/GOLDGUINEA almost all profit is one trade entered
   6 Feb 2026, days after gold fell ~12 % in one session (30 Jan 2026) and spreads blew out to
   −200 … −450 bps. Daily closes during such moves are non-synchronous and possibly limit-affected;
   assuming a fill at the next close at 1 kg size is optimistic.
3. **After the stress window** (from 1 Mar 2026) most pairs lost money or made trivial amounts.
4. **Out of sample** (walk-forward: params chosen on train, confirmed on validation, applied to unseen
   test windows) results are mixed in sign and never significant.
5. **Looser thresholds** (|z| ≥ 1.5, hurdle 1.0×) raise in-sample t-stats to ~2 for two pairs, but that
   is the result of trying multiple settings on the same data; it was not confirmed out of sample.
6. Costs are small relative to these spreads (roughly 5–25 % of gross) — the binding problem is
   evidence, not costs.

## What would change the conclusion

* Intraday, synchronous prices to test whether daily-close spreads are executable.
* Longer GOLDTEN history; separating the pre/post-April-2025 Petal regime.
* Confirming current costs, margins and the Petal/Guinea specification history against MCX circulars.

All figures are reproducible in the app (Relative value, Backtest, Performance & risk) from the
archived raw payload.
