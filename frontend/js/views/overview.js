import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { bindTable, noDataState, stat, table, track, warnings, zChip } from "../components.js";
import { bps, cls, date, esc, expiry, int, num, pct, RESEARCH, SYMBOL_COLORS, ts } from "../format.js";

function specCards(specs) {
  return `<div class="grid g-4">${specs.specs.filter((s) => RESEARCH.includes(s.symbol)).map((s) => `
    <div class="card"><div class="sym row"><i class="swatch" style="background:${SYMBOL_COLORS[s.symbol]}"></i><b class="mono">${s.symbol}</b><span class="caption">${esc(s.name)}</span></div>
    <div class="quote-card"><div class="meta">
      <span>Lot</span><b>${s.lot_grams} g</b><span>Quoted per</span><b>${s.quote_grams} g</b>
      <span>Purity</span><b>${s.purity}</b><span>Fine g / lot</span><b>${num(s.fine_grams_per_lot, 3)}</b>
    </div></div></div>`).join("")}</div>`;
}

export default async function overview(root) {
  const [ov, specs] = await Promise.all([api.overview(), api.specs()]);
  if (!ov.has_data) {
    root.innerHTML = `
      <div class="page-head"><div><span class="overline">Research overview</span><h1>Aureon</h1>
      <p>Relative-value research across MCX gold futures — GOLDM, GOLDTEN, GOLDGUINEA and GOLDPETAL — normalized to rupees per 10 g of fine gold, with costs, lot sizes and expiries modelled explicitly.</p></div></div>
      ${noDataState()}
      <div class="section"><div class="panel-head"><div><h3>Contract specifications</h3><div class="caption">Normalization constants (from the MCX product page; quotation units re-verified on every ingest)</div></div></div>${specCards(specs)}</div>`;
    return;
  }
  const snap = ov.snapshot.filter((s) => s.available);
  root.innerHTML = `
    <div class="page-head"><div><span class="overline">Research overview · as of ${date(ov.last_date)}</span><h1>Gold contract relative value</h1>
      <p>${int(ov.trading_days)} trading days of validated bhavcopy data from ${date(ov.first_date)}. Prices below are normalized to ₹ per 10 g of fine gold so differently sized and differently pure contracts are comparable.</p></div>
      <div class="row"><a class="btn" href="#/quality">Data quality</a><a class="btn primary" href="#/relative">Open research</a></div></div>
    ${warnings(ov.warnings, 3)}
    <div class="grid g-5 section" id="quotes"></div>
    <div class="grid g-3 section">
      <div class="panel span-2"><div class="panel-head"><div><h3>Front-contract normalized prices</h3><div class="caption">₹ / 10 g fine · nearest traded expiry with ≥3 days to expiry · contract switches create breaks · drag to zoom</div></div><div id="lg"></div></div><div id="c-front"></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Market-implied carry</h3><div class="caption">ln(F₂/F₁)/(T₂−T₁), annualized, 5-day trailing median</div></div></div>
        <div class="stat-row" style="margin-bottom:16px">${stat("Carry today", ov.carry ? pct(ov.carry.carry) : "—", ov.carry ? `from ${ov.carry.carry_source} curve` : "no estimate")}</div>
        <div class="prose"><p>Carry puts contracts that expire on different days on a common, spot-equivalent footing before spreads are measured. It is an observed market rate, not a forecast.</p></div></div>
    </div>
    <div class="grid g-2 section">
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Pair monitor</h3><div class="caption">Carry-adjusted spread, 60-day z-score and percentile · click a pair to research it</div></div></div><div id="matrix"></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Latest signal decisions</h3><div class="caption">Default thresholds · every pair is evaluated; most days produce no signal</div></div><a class="btn small" href="#/signals">Signal analysis</a></div><div id="sigs" class="list"></div></div>
    </div>`;

  root.querySelector("#quotes").innerHTML = ov.snapshot.map((s) => !s.available ? `<div class="card"><b class="mono">${s.symbol}</b><div class="caption" style="margin-top:12px">No eligible traded contract on the latest date.</div></div>` : `
    <div class="card interactive quote-card" data-sym="${s.symbol}">
      <div class="sym"><i class="swatch" style="background:${SYMBOL_COLORS[s.symbol]}"></i><b class="mono">${s.symbol}</b><span class="caption">${expiry(s.expiry)} · ${s.dte}d</span></div>
      <div class="px">${num(s.close, 0)}</div>
      <div class="caption">${s.symbol === "GOLD" ? "reference · " : ""}<span class="${cls(s.change)}">${s.change == null ? "—" : (s.change >= 0 ? "+" : "") + pct(s.change)}</span> on day</div>
      <div class="meta"><span>Norm ₹/10g fine</span><b>${num(s.norm, 0)}</b><span>Volume (lots)</span><b>${int(s.volume_lots)}</b><span>Open interest</span><b>${int(s.open_interest)}</b><span>Traded</span><b>${num(s.volume_grams / 1000, 1)} kg</b></div>
    </div>`).join("");
  root.querySelectorAll("[data-sym]").forEach((c) => c.addEventListener("click", () => (location.hash = `#/term/${c.dataset.sym}`)));

  const by = {};
  for (const r of ov.front_history) (by[r.symbol] ||= []).push([ts(r.trade_date), r.norm, r.expiry]);
  const series = RESEARCH.filter((s) => by[s]).map((s) => ({ name: s, color: SYMBOL_COLORS[s], data: by[s], breakAt: (p, q) => p[2] !== q[2], format: (v) => num(v, 0) }));
  root.querySelector("#lg").innerHTML = legend(series.map((s) => ({ name: s.name, color: s.color })));
  track(lineChart(root.querySelector("#c-front"), { series, height: 300, yFormat: (v) => num(v, 0) }));

  const mrows = ov.matrix;
  const mEl = root.querySelector("#matrix");
  mEl.innerHTML = table([
    { label: "Pair", render: (r) => `<span class="mono">${r.a} / ${r.b}</span>` },
    { label: "Spread", right: true, render: (r) => bps(r.last_spread_bps) },
    { label: "₹ / 10g", right: true, render: (r) => num(r.last_spread_abs, 0) },
    { label: "z (60d)", right: true, render: (r) => zChip(r.last_z) },
    { label: "Pctile", right: true, render: (r) => (r.last_pctile == null ? "—" : num(r.last_pctile, 0)) },
    { label: "Obs", right: true, render: (r) => int(r.observations) },
  ], mrows, { onClick: true, emptyText: "No overlapping contracts" });
  bindTable(mEl, mrows, (r) => (location.hash = `#/relative/${r.a}/${r.b}`));

  root.querySelector("#sigs").innerHTML = ov.signals_today.length ? ov.signals_today.map((s) => `
    <div class="list-row"><div><div class="mono small">${s.a} / ${s.b} <span class="caption">· ${date(s.trade_date)}</span></div><div class="caption">${esc(s.summary)}</div></div>
    ${s.signal ? `<span class="chip warn">${s.signal.replace("_", " ")}</span>` : `<span class="chip">no signal</span>`}</div>`).join("")
    : `<div class="loading">No pair had enough overlapping data to evaluate.</div>`;
}
