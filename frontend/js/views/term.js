import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { noDataState, stat, table, track } from "../components.js";
import { bps, date, esc, expiry, int, isNum, num, pct, SYMBOL_COLORS, ts } from "../format.js";

const SYMS = ["GOLDM", "GOLDTEN", "GOLDGUINEA", "GOLDPETAL", "GOLD"];

export default async function term(root, params) {
  let sym = SYMS.includes(params[0]) ? params[0] : "GOLDM";
  let day = params[1] || null;
  root.innerHTML = `<div class="page-head"><div><span class="overline">Term structure</span><h1>Futures curves & carry</h1>
    <p>Each point is an individual expiry. Calendar spreads compare the two nearest traded expiries of the same product; implied carry is ln(F₂/F₁) annualized over the days between expiries. Carry reflects financing, storage and convenience yield — it is observed, not assumed.</p></div>
    <div class="row"><div class="seg" id="sym-seg">${SYMS.map((s) => `<button data-s="${s}" class="${s === sym ? "on" : ""}">${s}</button>`).join("")}</div>
    <input class="input" type="date" id="day" style="width:160px" /></div></div><div id="out"></div>`;
  const out = root.querySelector("#out");
  root.querySelectorAll("#sym-seg button").forEach((b) => b.addEventListener("click", () => { sym = b.dataset.s; root.querySelectorAll("#sym-seg button").forEach((x) => x.classList.toggle("on", x === b)); load(); }));
  root.querySelector("#day").addEventListener("change", (e) => { day = e.target.value || null; load(); });

  async function load() {
    out.innerHTML = `<div class="panel"><div class="loading"><span class="spinner"></span>Loading curves…</div></div>`;
    const res = await api.termStructure({ symbol: sym, date: day });
    if (!res.has_data) { out.innerHTML = noDataState(); return; }
    const dEl = root.querySelector("#day");
    dEl.min = res.available_dates[0]; dEl.max = res.available_dates[1]; dEl.value = res.date;
    history.replaceState(null, "", `#/term/${sym}/${res.date}`);
    const cs = res.calendar_spreads;
    const lastCs = cs[cs.length - 1];
    const curve = res.curve;
    out.innerHTML = `
      <div class="stat-row">
        ${stat("Curve date", date(res.date))}
        ${stat("Live expiries", int(curve.length), `${curve.filter((c) => c.traded).length} traded`)}
        ${stat("Front–next spread", lastCs ? bps(lastCs.spread_bps) : "—", lastCs ? `${expiry(lastCs.front_expiry)} → ${expiry(lastCs.next_expiry)}` : "")}
        ${stat("Implied carry", lastCs ? pct(lastCs.implied_carry) : "—", "latest, annualized")}
        ${stat("Median carry", cs.length ? pct(median(cs.map((c) => c.implied_carry))) : "—", "full history")}
      </div>
      <div class="grid g-2 section">
        <div class="panel"><div class="panel-head"><div><h3>${sym} curve on ${date(res.date)}</h3><div class="caption">Normalized ₹/10 g fine vs days to expiry · hollow = reference price (no trades)</div></div></div><div id="c-curve"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>All products on ${date(res.date)}</h3><div class="caption">Traded expiries only, ₹/10 g fine — differences at equal maturity are relative-value candidates</div></div><div id="lg"></div></div><div id="c-all"></div></div>
      </div>
      <div class="panel section"><div class="panel-head"><div><h3>Implied carry through time</h3><div class="caption">${sym} front/next pair (dots) and the cross-product reference carry used for spread adjustment (line)</div></div></div><div id="c-carry"></div></div>
      <div class="grid g-2 section">
        <div class="panel"><div class="panel-head"><div><h3>Calendar spread</h3><div class="caption">Next − front, bps · breaks at contract switches</div></div></div><div id="c-cal"></div></div>
        <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Curve detail</h3></div></div><div id="tbl"></div></div>
      </div>`;

    const tr = curve.filter((c) => c.traded), ref = curve.filter((c) => !c.traded);
    track(lineChart(out.querySelector("#c-curve"), { height: 260, xType: "number", xLabel: "days to expiry", xFormat: (v) => v.toFixed(0), yFormat: (v) => num(v, 0), series: [
      { name: "Traded", color: SYMBOL_COLORS[sym], points: true, data: tr.map((c) => [c.dte, c.norm]), format: (v) => num(v, 0) },
      { name: "Reference", kind: "dots", color: "var(--muted)", data: ref.map((c) => [c.dte, c.norm]), format: (v) => num(v, 0) }] }));
    const allSeries = Object.entries(res.all_curves).filter(([, c]) => c.some((x) => x.traded)).map(([s, c]) => ({ name: s, color: SYMBOL_COLORS[s], points: true, data: c.filter((x) => x.traded).map((x) => [x.dte, x.norm]), format: (v) => num(v, 0) }));
    out.querySelector("#lg").innerHTML = legend(allSeries.map((s) => ({ name: s.name, color: s.color })));
    track(lineChart(out.querySelector("#c-all"), { height: 260, xType: "number", xLabel: "days to expiry", xFormat: (v) => v.toFixed(0), yFormat: (v) => num(v, 0), series: allSeries }));
    track(lineChart(out.querySelector("#c-carry"), { height: 240, syncKey: "ts", yFormat: (v) => (v * 100).toFixed(1) + "%", series: [
      { name: `${sym} front/next`, kind: "dots", r: 1.8, color: SYMBOL_COLORS[sym], opacity: 0.6, data: cs.map((c) => [ts(c.trade_date), c.implied_carry]), format: (v) => (v * 100).toFixed(2) + "%" },
      { name: "Reference carry", color: "var(--text-2)", data: res.carry.map((c) => [ts(c.trade_date), c.carry]), format: (v) => (v * 100).toFixed(2) + "%" }] }));
    track(lineChart(out.querySelector("#c-cal"), { height: 240, syncKey: "ts", yFormat: (v) => v.toFixed(0), series: [
      { name: "Calendar spread", color: SYMBOL_COLORS[sym], data: cs.map((c) => [ts(c.trade_date), c.spread_bps, c.front_expiry]), breakAt: (p, q) => p[2] !== q[2], format: (v) => v.toFixed(1) + " bps" }] }));
    out.querySelector("#tbl").innerHTML = table([
      { label: "Expiry", render: (r) => `<span class="mono">${expiry(r.expiry)}</span>` }, { label: "DTE", right: true, render: (r) => r.dte },
      { label: "Close", right: true, render: (r) => num(r.close, 0) }, { label: "₹/10g fine", right: true, render: (r) => num(r.norm, 0) },
      { label: "Volume", right: true, render: (r) => int(r.volume_lots) }, { label: "OI", right: true, render: (r) => int(r.open_interest) },
      { label: "", render: (r) => (r.traded ? `<span class="chip ok">traded</span>` : `<span class="chip">reference</span>`) },
    ], curve, { maxHeight: 300 });
  }
  await load();
}

function median(a) { const v = a.filter(isNum).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; }
