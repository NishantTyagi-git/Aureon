import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { bindTable, failText, noDataState, pageHead, panelHead, stat, table, track, visited, warnings, zChip, zWords } from "../components.js";
import { bps, cls, date, esc, expiry, int, isNum, num, pct, RESEARCH, SYMBOL_COLORS, ts } from "../format.js";
import { info, term } from "../help.js";

const NAMES = { GOLDM: "Gold Mini · 100 g", GOLDTEN: "Gold Ten · 10 g", GOLDGUINEA: "Gold Guinea · 8 g", GOLDPETAL: "Gold Petal · 1 g", GOLD: "Gold · 1 kg (reference)" };

function steps(state) {
  const s = [
    { n: 1, t: "Load market data", p: "Daily official MCX prices for the four gold contracts.", href: "#/data/sources", done: state.data },
    { n: 2, t: "Compare two contracts", p: "See how their prices differ and whether today's gap is unusual.", href: "#/compare", done: state.compare },
    { n: 3, t: "Find opportunities", p: "Days when a gap was unusual and practical to act on — with reasons.", href: "#/opportunities", done: state.opportunities },
    { n: 4, t: "Test a strategy", p: "Replay the idea on past data, with costs, to see if it would have worked.", href: "#/test", done: state.test },
  ];
  return `<div class="steps">${s.map((x) => `<a class="step" href="${x.href}"><span class="n">STEP ${x.n}</span><b>${x.t}</b><p>${x.p}</p>
    <span class="state">${x.done ? `<span class="chip ok">Done</span>` : `<span class="chip">Not yet</span>`}</span></a>`).join("")}</div>`;
}

function specCards(specs) {
  return `<div class="grid g-4">${specs.specs.filter((s) => RESEARCH.includes(s.symbol)).map((s) => `
    <div class="card"><div class="sym row"><i class="swatch" style="background:${SYMBOL_COLORS[s.symbol]}"></i><b class="mono">${s.symbol}</b></div>
    <div class="caption" style="margin-top:4px">${esc(s.name)}</div>
    <div class="quote-card"><div class="meta">
      <span>Smallest trade</span><b>${s.lot_grams} g</b><span>Price quoted per</span><b>${s.quote_grams} g</b>
      <span>Purity</span><b>${s.purity / 10}%</b><span>Pure gold / lot</span><b>${num(s.fine_grams_per_lot, 2)} g</b>
    </div></div></div>`).join("")}</div>`;
}

export default async function home(root) {
  const [ov, specs, latest] = await Promise.all([api.overview(), api.specs(), api.latest()]);
  const v = visited();
  const state = { data: ov.has_data, compare: !!v.compare, opportunities: !!v.opportunities, test: !!(latest.backtest || latest.walkforward) };

  if (!ov.has_data) {
    root.innerHTML = `
      ${pageHead("Welcome", "Are India's gold futures priced consistently?",
        "MCX lists four gold futures of different sizes. Once you adjust for size and purity they should cost about the same. Aureon measures how far their prices drift apart, explains whether a gap is unusual, and tests whether trading those gaps would have made money after real costs.")}
      ${steps(state)}
      <div class="section">${noDataState()}</div>
      <div class="section">${panelHead("The four contracts Aureon compares", "Each one is a futures contract on gold — they differ in size and purity, which Aureon adjusts for.", "", "goldm")}${specCards(specs)}</div>`;
    return;
  }

  // ---- plain-English summary built from the real data
  const m = ov.matrix.filter((r) => isNum(r.last_z));
  const top = m.slice().sort((x, y) => Math.abs(y.last_z) - Math.abs(x.last_z))[0];
  const unusual = m.filter((r) => Math.abs(r.last_z) >= 2);
  const sig = ov.signals_today.filter((s) => s.signal);
  const warnCount = ov.warnings.filter((w) => w.level !== "info").length;
  const summary = `
    <p class="summary-line">Latest prices are from <b>${date(ov.last_date)}</b> (${int(ov.trading_days)} trading days loaded, starting ${date(ov.first_date)}).</p>
    <p class="summary-line" style="margin-top:10px">${unusual.length
      ? `<b>${unusual.length} of ${m.length}</b> contract pairs show an unusual price difference today. The largest is <b>${top.a} vs ${top.b}</b>, ${zWords(top.last_z)}.`
      : `No contract pair shows an unusual price difference today. The pair furthest from normal is <b>${top ? `${top.a} vs ${top.b}` : "—"}</b>, which is ${top ? zWords(top.last_z) : "—"}.`}</p>
    <p class="summary-line" style="margin-top:10px">${sig.length ? `<b>${sig.length}</b> pair${sig.length > 1 ? "s" : ""} passed every practical check for a research signal today.` : `No pair passed every practical check today, so there is <b>no signal</b> — that is the normal outcome on most days.`}</p>
    ${warnCount ? `<p class="caption" style="margin-top:12px">${warnCount} data-health notes need attention — <a href="#/data/health">review them</a>.</p>` : ""}`;

  root.innerHTML = `
    ${pageHead(`Home · data to ${date(ov.last_date)}`, "Market at a glance",
      "Four MCX gold futures, converted to the same unit — rupees per 10 grams of pure gold — so their prices can be compared directly.",
      `<a class="btn" href="#/market/contracts">Explore market data</a><a class="btn primary" href="#/compare">Compare two contracts</a>`)}
    <div class="hero">
      <div class="panel">${panelHead("Today in plain English", "Generated from the latest loaded prices")}${summary}</div>
      <div class="panel">${panelHead("Getting started", "Your progress through a typical first session")}
        <ul class="checklist">
          ${[["Market data loaded", state.data, `${int(ov.trading_days)} trading days available`],
             ["Compared two contracts", state.compare, `<a href="#/compare">Open Compare</a> and pick any two contracts`],
             ["Looked for opportunities", state.opportunities, `<a href="#/opportunities">See which days were flagged and why</a>`],
             ["Tested a strategy", state.test, `<a href="#/test">Run a test on past data</a>`]]
            .map(([t, ok, d]) => `<li class="${ok ? "ok" : ""}"><span class="tick">${ok ? "✓" : ""}</span><span>${t}<br><span class="caption">${d}</span></span></li>`).join("")}
        </ul></div>
    </div>
    <div class="grid g-5 section" id="quotes"></div>
    <div class="panel section">${panelHead("Comparable prices over time", "Nearest active contract of each product, in ₹ per 10 g of pure gold. If the contracts were priced identically, these lines would sit on top of each other. Gaps in a line mark a switch to the next contract. Drag across the chart to zoom; double-click to reset.", `<div id="lg"></div>`, "normalized")}<div id="c-front"></div></div>
    <div class="grid g-2 section">
      <div class="panel flush">${`<div style="padding:20px 20px 0">${panelHead("Price differences right now", "Click a pair to study it in detail. “How unusual” compares today's gap with its last 60 trading days.", "", "spread")}</div>`}<div id="matrix"></div></div>
      <div class="panel">${panelHead("Today's opportunity check", "Every pair is checked against the practical rules. Most days, nothing qualifies — that is expected.", `<a class="btn small" href="#/opportunities">See all</a>`, "signal")}<div id="sigs" class="list"></div></div>
    </div>
    ${ov.warnings.length ? `<div class="panel section">${panelHead("Data health notes", "Things to keep in mind when reading the numbers", `<a class="btn small" href="#/data/health">Data health</a>`)}${warnings(ov.warnings, 4)}</div>` : ""}
    <div class="section"><span class="overline">Your research path</span><div style="margin-top:10px">${steps(state)}</div></div>`;

  root.querySelector("#quotes").innerHTML = ov.snapshot.map((s) => !s.available ? `<div class="card"><b class="mono">${s.symbol}</b><div class="caption" style="margin-top:12px">No actively traded contract on the latest date.</div></div>` : `
    <a class="card interactive quote-card" href="#/market/curves/${s.symbol}" title="Open the ${s.symbol} price curve">
      <div class="sym"><i class="swatch" style="background:${SYMBOL_COLORS[s.symbol]}"></i><b class="mono">${s.symbol}</b></div>
      <div class="caption">${NAMES[s.symbol]}</div>
      <div class="px">${num(s.close, 0)}</div>
      <div class="caption">as quoted · <span class="${cls(s.change)}">${s.change == null ? "—" : (s.change >= 0 ? "+" : "") + pct(s.change)}</span> on the day</div>
      <div class="meta"><span>Comparable ₹/10 g</span><b>${num(s.norm, 0)}</b><span>Contract</span><b>${expiry(s.expiry)}</b><span>Expires in</span><b>${s.dte} days</b><span>Traded today</span><b>${int(s.volume_lots)} lots</b></div>
    </a>`).join("");

  const by = {};
  for (const r of ov.front_history) (by[r.symbol] ||= []).push([ts(r.trade_date), r.norm, r.expiry]);
  const series = RESEARCH.filter((s) => by[s]).map((s) => ({ name: s, color: SYMBOL_COLORS[s], data: by[s], breakAt: (p, q) => p[2] !== q[2], format: (v) => "₹" + num(v, 0) }));
  root.querySelector("#lg").innerHTML = legend(series.map((s) => ({ name: s.name, color: s.color })));
  track(lineChart(root.querySelector("#c-front"), { series, height: 300, yFormat: (v) => num(v, 0) }));

  const mEl = root.querySelector("#matrix");
  mEl.innerHTML = table([
    { label: "Pair", render: (r) => `<span class="mono">${r.a} vs ${r.b}</span>` },
    { label: "Difference", right: true, help: "spread", render: (r) => `${bps(r.last_spread_bps)}<div class="caption">${isNum(r.last_spread_bps) ? (r.last_spread_bps / 100).toFixed(2) + "%" : ""}</div>` },
    { label: "How unusual", right: true, help: "zscore", render: (r) => zChip(r.last_z) },
    { label: "Reading", render: (r) => `<span class="caption">${esc(zWords(r.last_z))}</span>` },
  ], ov.matrix, { onClick: true, emptyText: "No pairs have overlapping data." });
  bindTable(mEl, ov.matrix, (r) => (location.hash = `#/compare/${r.a}/${r.b}`));

  root.querySelector("#sigs").innerHTML = ov.signals_today.length ? ov.signals_today.map((s) => {
    const failed = failText(s.checks);
    return `<a class="list-row" href="#/opportunities" style="color:inherit"><div><div class="mono small">${s.a} vs ${s.b}</div>
      <div class="caption">${s.signal ? esc(s.summary) : `Didn't qualify: ${esc(failed.slice(0, 2).join("; "))}${failed.length > 2 ? ` (+${failed.length - 2} more)` : ""}`}</div></div>
      ${s.signal ? `<span class="chip warn">Signal</span>` : `<span class="chip">No signal</span>`}</a>`;
  }).join("") : `<div class="table-empty">No pair had enough overlapping data to check.</div>`;
}
