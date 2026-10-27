# Aureon — Commodity Derivatives Intelligence

Quantitative research terminal for relative pricing between Indian MCX gold futures —
**GOLDM, GOLDTEN, GOLDGUINEA, GOLDPETAL** (GOLD 1 kg used only as a curve reference).

It ingests official MCX bhavcopy data, validates and archives it, normalizes contracts to
₹ per 10 g of fine gold, studies spreads, term structure and carry, generates explainable research
signals, and backtests them with walk-forward validation, realistic execution, lot sizes, expiries
and costs. Results are reported honestly — including "no edge after costs".

> Aureon never fabricates prices. With no data loaded every view shows an empty state.

## Run it

Requires Python 3.11+ (built and tested on 3.13).

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt     # Windows
# source .venv/bin/activate && pip install -r requirements.txt   (macOS / Linux)
copy .env.example .env      # then add TINYFISH_API_KEY if you want automated collection
.venv\Scripts\python run.py # → http://127.0.0.1:8000
```

A fresh install loads the bundled MCX data in `data/seed/` (2019–2026) automatically on first start.
To put Aureon online, see **[docs/DEPLOY.md](docs/DEPLOY.md)** (Render in a few clicks, or any Docker host).

Tests:

```bash
.venv\Scripts\python -m pytest
```

CLI:

```bash
.venv\Scripts\python run.py import                     # ingest everything in data/import
.venv\Scripts\python run.py import path\to\file.json   # ingest specific files
.venv\Scripts\python run.py collect --start 2026-10-01 --end 2026-10-23   # TinyFish
.venv\Scripts\python run.py status
```

## Getting real market data

MCX's site is behind bot protection; plain HTTP clients are refused. Three supported routes, all
ending in the same validation pipeline:

1. **In-browser MCX collector (recommended for history).** Open
   <https://www.mcxindia.com/market-data/bhavcopy> in your browser, paste the script from the Data
   page ("Copy collector script", also at `frontend/collector/mcx_collector.js`) into the developer
   console and run `aureonCollect("2023-01-01", "2026-10-23")`. It calls the page's own *Date Wise*
   request one day at a time (≈0.7 s apart) and downloads `aureon_mcx_<start>_<end>.json`. Upload it
   on the Data page or drop it into `data/import/` and click *Scan*. Data is available from 2003.
2. **TinyFish (automated).** Set `TINYFISH_API_KEY` in `.env`, then use the Data page or
   `run.py collect`. One TinyFish browser-agent run per trading day. Its output is LLM-extracted, so
   it is treated as untrusted: rows whose turnover is inconsistent with their prices are rejected.
   In testing (Oct 2026) a run for 22-Oct-2026 took ~7 minutes and returned no rows, so expect to
   rely on route 1 for history and use TinyFish for incremental updates, checking the rejections.
3. **Files.** CSV exported with the bhavcopy page's own CSV button, raw MCX JSON responses, or
   TinyFish results (`{"rows": [...]}`).

Current state (26 Oct 2026): 2 Jan 2023 – 23 Oct 2026 loaded via route 1. Research conclusions are in
`docs/FINDINGS.md`.

Every payload is stored verbatim in SQLite (`raw_payloads`, SHA-256 deduplicated) and mirrored to
`data/raw/<source>/` before parsing.

## Architecture

```
backend/aureon/
  config.py, logging_setup.py      settings from env / .env
  specs.py                         contract specs + provenance, normalization formulas
  data/                            pipeline — parsers, validation, SQLite store, TinyFish client
  analytics/                       panel, lifecycle, term structure & carry, relative value, quality
  signals/engine.py                rule-based explainable signals
  backtest/                        costs, sizing, event-driven engine, metrics, walk-forward
  service.py                       caching service layer used by the API
  api.py                           FastAPI routes + static frontend
frontend/                          dependency-free ES-module UI, custom SVG charts
tests/                             pytest suite (synthetic fixtures live only here)
docs/METHODOLOGY.md                every formula and assumption
```

Layers are one-directional: `data → analytics → signals → backtest → service → api → frontend`.

## Interface

Dark graphite terminal adapted from the Genesis design file (`Design.md`): General Sans display,
DM Sans body, JetBrains Mono numerics, 4 px grid, 6/8/12 px radii, indigo reserved for interactive
elements, flat 1 px-bordered surfaces that lift only on hover. Light theme toggle in the nav;
⌘K / Ctrl+K opens quick navigation.

Navigation follows the research workflow:

| Section | What it's for |
|---|---|
| Home | What Aureon does, a plain-English summary of today, and a getting-started checklist |
| Market data → Contracts / Price curves | Explore individual contracts, expiries and carry |
| Compare | Compare two contracts: price difference, how unusual it is, typical reversion time |
| Opportunities | Days when a difference was unusual *and* practical to act on, with reasons |
| Test strategy | Realistic (walk-forward) or quick test on past data, with costs |
| Results | Verdict, profit after costs, risk, and where the profit came from |
| Data → Data health / Data sources | Coverage and validation checks; loading data |

Compare → Opportunities → Test strategy → Results share one selected pair and settings, shown in
a step bar at the top of each page. Every page has a collapsible "How to read this page" guide,
technical terms carry ⓘ explanations, and the "?" button opens a searchable glossary. Advanced
settings are folded away; beginners can pick a Strict / Balanced / Relaxed sensitivity instead of
raw thresholds. Old links (`#/relative`, `#/term`, `#/backtest`, …) redirect to the new pages.

## Honesty rules built in

* Missing observations are never filled; zero-volume reference prices are never treated as trades.
* Specs carry provenance; lot/quote units are re-verified from turnover on every ingest.
* Positions use the actual contracts' prices, close before expiry, and are never silently rolled.
* Walk-forward reports only unseen test windows; folds abstain when validation fails.
* Verdicts require ≥ 20 trades, positive net P&L and a trade t-stat ≥ 2 before calling anything
  "positive", and even then say "verify".

See `docs/METHODOLOGY.md` for details and limitations.
