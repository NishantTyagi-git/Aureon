import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { noDataState, pageHead, panelHead, stat, table, track } from "../components.js";
import { pageGuide } from "../help.js";
import { bps, date, esc, expiry, int, isNum, num, pct, SYMBOL_COLORS, ts } from "../format.js";

const SYMS = ["GOLDM", "GOLDTEN", "GOLDGUINEA", "GOLDPETAL", "GOLD"];

export default async function term(root, params) {
  let sym = SYMS.includes(params[0]) ? params[0] : "GOLDM";
  let day = params[1] || null;
  root.innerHTML = `${pageHead("Market data", "Price curves",
      "The same product usually costs more for later expiry dates, because holding gold until then has a cost (financing and storage). This page shows that pattern — the price curve — and how steep it has been over time.",
      `<div class="seg" id="sym-seg" aria-label="Product">${SYMS.map((s) => `<button data-s="${s}" class="${s === sym ? "on" : ""}">${s}</button>`).join("")}</div>
      <label class="sr-only" for="day">Date</label><input class="input" type="date" id="day" style="width:160px" title="Pick a date" />`)}
    ${pageGuide("curves", {
      what: "Prices of every expiry of one product on a chosen day, the same for all products, and the yearly <b>carry</b> rate implied by the curve.",
      why: "Contracts with different expiry dates differ in price partly because of carry. Aureon measures it from the market and removes it before comparing contracts, so only the unexpected part of a price gap remains.",
      next: "Use the date picker to look at a stressful day, or go to <a href='#/compare'>Compare</a> to study gaps between products.",
    })}
    <div id="out"></div>`;
  const out = root.querySelector("#out");
  root.querySelectorAll("#sym-seg button").forEach((b) => b.addEventListener("click", () => { sym = b.dataset.s; root.querySelectorAll("#sym-seg button").forEach((x) => x.classList.toggle("on", x === b)); load(); }));
  root.querySelector("#day").addEventListener("change", (e) => { day = e.target.value || null; load(); });

  async function load() {
    out.innerHTML = `<div class="panel"><div class="loading" role="status"><span class="spinner"></span>Loading price curves…</div></div>`;
    const res = await api.termStructure({ symbol: sym, date: day });
    if (!res.has_data) { out.innerHTML = noDataState(); return; }
    const dEl = root.querySelector("#day");
    dEl.min = res.available_dates[0]; dEl.max = res.available_dates[1]; dEl.value = res.date;
    history.replaceState(null, "", `#/market/curves/${sym}/${res.date}`);
    const cs = res.calendar_spreads;
    const lastCs = cs[cs.length - 1];
    const curve = res.curve;
    out.innerHTML = `
      <div class="stat-row">
        ${stat("Date shown", date(res.date))}
        ${stat("Expiries listed", int(curve.length), `${curve.filter((c) => c.traded).length} traded that day`)}
        ${stat("Next month costs more by", lastCs ? bps(lastCs.spread_bps) : "—", lastCs ? `${expiry(lastCs.front_expiry)} → ${expiry(lastCs.next_expiry)}` : "", "", "calendar")}
        ${stat("Carry rate", lastCs ? pct(lastCs.implied_carry) : "—", "per year, latest", "", "carry")}
        ${stat("Typical carry", cs.length ? pct(median(cs.map((c) => c.implied_carry))) : "—", "median, whole history")}
      </div>
      <div class="grid g-2 section">
        <div class="panel">${panelHead(`${sym} price curve on ${date(res.date)}`, "Comparable price (₹ per 10 g pure gold) against days until expiry. Grey dots: reference prices on days with no trades.", "", "termstructure")}<div id="c-curve"></div></div>
        <div class="panel">${panelHead(`All products on ${date(res.date)}`, "Traded expiries only. Where curves for different products don't overlap at the same expiry, their prices differ.", `<div id="lg"></div>`)}<div id="c-all"></div></div>
      </div>
      <div class="panel section">${panelHead("Carry rate over time", `Dots: ${sym}'s nearest two expiries. Line: the reference rate Aureon uses to adjust comparisons.`, "", "carry")}<div id="c-carry"></div></div>
      <div class="grid g-2 section">
        <div class="panel">${panelHead("Next month vs this month", "How much more the next expiry cost than the nearest one (bps). Breaks mark contract switches.", "", "calendar")}<div id="c-cal"></div></div>
        <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("Every expiry on this date")}</div><div id="tbl"></div></div>
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
      { label: "Expiry", render: (r) => `<span class="mono">${expiry(r.expiry)}</span>` }, { label: "Days left", right: true, render: (r) => r.dte },
      { label: "Price", right: true, render: (r) => num(r.close, 0) }, { label: "Comparable ₹/10 g", right: true, help: "normalized", render: (r) => num(r.norm, 0) },
      { label: "Volume", right: true, render: (r) => int(r.volume_lots) }, { label: "Open interest", right: true, help: "openinterest", render: (r) => int(r.open_interest) },
      { label: "", render: (r) => (r.traded ? `<span class="chip ok">Traded</span>` : `<span class="chip" title="No trades — reference price only">No trades</span>`) },
    ], curve, { maxHeight: 300 });
  }
  await load();
}

function median(a) { const v = a.filter(isNum).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; }
