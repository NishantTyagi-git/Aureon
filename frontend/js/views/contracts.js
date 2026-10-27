import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { bindTable, noDataState, stat, table, track } from "../components.js";
import { date, esc, expiry, int, num, pct, SYMBOL_COLORS, ts } from "../format.js";

const SYMS = ["ALL", "GOLDM", "GOLDTEN", "GOLDGUINEA", "GOLDPETAL", "GOLD"];

export default async function contracts(root, params) {
  root.innerHTML = `<div class="page-head"><div><span class="overline">Contract explorer</span><h1>Individual contracts</h1>
    <p>Every (symbol, expiry) is tracked as its own instrument — different expiries are never merged into a continuous series. Eligibility requires an active, traded contract with enough days to expiry.</p></div></div>
    <div id="body"></div>`;
  const res = await api.contracts();
  const body = root.querySelector("#body");
  if (!res.contracts.length) { body.innerHTML = noDataState(); return; }
  let sym = params[0] || "ALL", statusF = "active";
  body.innerHTML = `
    <div class="row between" style="margin-bottom:16px">
      <div class="row" id="sym-chips">${SYMS.map((s) => `<span class="chip btn-chip ${s === sym ? "on" : ""}" data-s="${s}">${s === "ALL" ? "All symbols" : s}</span>`).join("")}</div>
      <div class="seg" id="status-seg">${["active", "expired", "all"].map((s) => `<button data-s="${s}" class="${s === statusF ? "on" : ""}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>
    </div>
    <div class="grid g-side">
      <div class="panel flush" id="tbl"></div>
      <div class="stack" id="detail"><div class="panel"><div class="caption">Select a contract to inspect its full history.</div></div></div>
    </div>
    <div class="panel section"><div class="panel-head"><div><h3>Front-contract transitions</h3><div class="caption">Days on which the nearest eligible contract (≥5 days to expiry, traded) switched — every switch is explicit</div></div></div><div id="trans"></div></div>`;
  // make the table column wider than the side-panel default
  body.querySelector(".g-side").style.gridTemplateColumns = "minmax(0, 1.25fr) minmax(0, 1fr)";

  function draw() {
    const rows = res.contracts.filter((c) => (sym === "ALL" || c.symbol === sym) && (statusF === "all" || (statusF === "active" ? c.status !== "expired" : c.status === "expired")))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.expiry.localeCompare(b.expiry));
    const t = body.querySelector("#tbl");
    t.innerHTML = table([
      { label: "Contract", render: (r) => `<span class="swatch" style="background:${SYMBOL_COLORS[r.symbol]}"></span> <span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` },
      { label: "Status", render: (r) => r.status === "active" ? (r.eligible ? `<span class="chip ok">eligible</span>` : `<span class="chip warn" title="${esc(r.eligibility_reason)}">${esc(r.eligibility_reason.length > 22 ? "ineligible" : r.eligibility_reason)}</span>`) : `<span class="chip">${r.status.replace(/_/g, " ")}</span>` },
      { label: "DTE", right: true, render: (r) => (r.dte >= 0 ? r.dte : "—") },
      { label: "Last", right: true, render: (r) => num(r.last_close, 0) },
      { label: "Obs", right: true, render: (r) => int(r.observations) },
      { label: "Coverage", right: true, render: (r) => `<span class="${r.coverage < 0.98 ? "neg" : ""}">${pct(r.coverage, 0)}</span>` },
      { label: "Traded days", right: true, render: (r) => int(r.traded_days) },
      { label: "Volume", right: true, render: (r) => int(r.total_volume_lots) },
    ], rows, { onClick: true, maxHeight: 620 });
    bindTable(t, rows, (r, tr) => { t.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel")); tr.classList.add("sel"); showDetail(r); });
  }
  body.querySelectorAll("#sym-chips .chip").forEach((c) => c.addEventListener("click", () => { sym = c.dataset.s; body.querySelectorAll("#sym-chips .chip").forEach((x) => x.classList.toggle("on", x === c)); draw(); }));
  body.querySelectorAll("#status-seg button").forEach((b) => b.addEventListener("click", () => { statusF = b.dataset.s; body.querySelectorAll("#status-seg button").forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
  draw();

  async function showDetail(c) {
    const d = body.querySelector("#detail");
    d.innerHTML = `<div class="panel"><div class="loading"><span class="spinner"></span>Loading ${c.symbol} ${expiry(c.expiry)}…</div></div>`;
    const hist = (await api.contract(c.symbol, c.expiry)).history;
    d.innerHTML = `
      <div class="panel"><div class="panel-head"><div><h3 class="mono">${c.symbol} ${expiry(c.expiry)}</h3><div class="caption">Expires ${date(c.expiry)} · first seen ${date(c.first_seen)} · last ${date(c.last_seen)}</div></div>
        <span class="chip ${c.eligible ? "ok" : ""}">${esc(c.eligibility_reason)}</span></div>
        <div class="stat-row">${stat("Last close", num(c.last_close, 0))}${stat("₹/10g fine", num(c.last_norm, 0))}${stat("Missing days", int(c.missing_observations), `${int(c.expected_observations)} expected`)}${stat("Zero-volume days", int(c.observations - c.traded_days))}</div></div>
      <div class="panel"><div class="panel-head"><div><h3>Price</h3><div class="caption">Solid: traded closes · hollow dots: reference closes on zero-volume days (not tradable)</div></div></div><div id="cp"></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Volume & open interest</h3></div>${legend([{ name: "Volume (lots)", color: "var(--c-gold)" }, { name: "Open interest", color: SYMBOL_COLORS[c.symbol] }])}</div><div id="cv"></div></div>
      <details class="panel"><summary>Raw observations (${hist.length})</summary><div style="margin-top:12px">${table([
        { label: "Date", render: (r) => date(r.trade_date) }, { label: "Open", right: true, render: (r) => num(r.open, 0) }, { label: "High", right: true, render: (r) => num(r.high, 0) },
        { label: "Low", right: true, render: (r) => num(r.low, 0) }, { label: "Close", right: true, render: (r) => num(r.close, 0) }, { label: "Vol", right: true, render: (r) => int(r.volume_lots) },
        { label: "OI", right: true, render: (r) => int(r.open_interest) }, { label: "Source", render: (r) => r.raw_id ? `<a href="/api/ingest/raw/${r.raw_id}" target="_blank">${esc(r.source)} #${r.raw_id}</a>` : esc(r.source) },
      ], hist.slice().reverse(), { maxHeight: 320 })}</div></details>`;
    const traded = hist.map((r) => [ts(r.trade_date), r.traded ? r.close : null]);
    const ref = hist.filter((r) => !r.traded).map((r) => [ts(r.trade_date), r.close]);
    const hl = hist.map((r) => [ts(r.trade_date), r.traded ? r.low : null, r.traded ? r.high : null]);
    track(lineChart(d.querySelector("#cp"), { height: 220, yFormat: (v) => num(v, 0), syncKey: "contract", series: [
      { name: "High–low", kind: "band", color: "var(--c-band)", data: hl, format: (v) => num(v, 0) },
      { name: "Close (traded)", color: SYMBOL_COLORS[c.symbol], data: traded, format: (v) => num(v, 0) },
      { name: "Reference close", kind: "dots", color: "var(--muted)", data: ref, format: (v) => num(v, 0) }] }));
    track(lineChart(d.querySelector("#cv"), { height: 180, yZero: true, syncKey: "contract", yFormat: (v) => int(v), series: [
      { name: "Volume (lots)", kind: "bars", color: "var(--c-gold)", data: hist.map((r) => [ts(r.trade_date), r.volume_lots]), format: int },
      { name: "Open interest", axis: "right", color: SYMBOL_COLORS[c.symbol], data: hist.map((r) => [ts(r.trade_date), r.open_interest]), format: int }], yFormatRight: int }));
  }

  const tr = Object.entries(res.fronts).flatMap(([s, v]) => v.transitions.map((t) => ({ symbol: s, ...t }))).sort((a, b) => b.date.localeCompare(a.date));
  body.querySelector("#trans").innerHTML = table([
    { label: "Date", render: (r) => date(r.date) }, { label: "Symbol", render: (r) => `<span class="mono">${r.symbol}</span>` },
    { label: "From", render: (r) => `<span class="mono">${expiry(r.from_expiry)}</span>` }, { label: "To", render: (r) => `<span class="mono">${expiry(r.to_expiry)}</span>` },
    { label: "Old contract DTE at switch", right: true, render: (r) => r.from_dte_on_switch },
  ], tr, { maxHeight: 300, emptyText: "No transitions in the loaded history." });
}
