import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { checked, ctx, input, noDataState, numVal, pairParams, saveCtx, select, stat, table, toggle, track, val } from "../components.js";
import { bps, date, esc, expiry, int, isNum, num, RESEARCH, SYMBOL_COLORS, ts } from "../format.js";

export default async function relative(root, params) {
  if (params[0] && params[1] && RESEARCH.includes(params[0]) && RESEARCH.includes(params[1])) saveCtx({ a: params[0], b: params[1] });
  root.innerHTML = `<div class="page-head"><div><span class="overline">Relative-value research</span><h1>Spread analysis</h1>
    <p>Leg A uses its nearest traded contract; leg B uses the traded contract whose expiry is closest to A's. Prices are normalized to ₹/10 g fine gold and, optionally, discounted by the day's implied carry to a common spot-equivalent basis. An unusual spread is an observation, not proof of arbitrage or of mean reversion.</p></div></div>
    <div class="grid g-side">
      <div class="panel" id="ctl"></div>
      <div class="stack" id="out"></div>
    </div>`;
  const ctl = root.querySelector("#ctl");
  ctl.innerHTML = `
    <div class="form-section"><div class="form-grid">
      ${select("f-a", RESEARCH, ctx.a, "Leg A")}${select("f-b", RESEARCH, ctx.b, "Leg B")}
    </div></div>
    <div class="form-section"><div class="form-grid">
      ${input("f-lb", ctx.lookback, "Lookback (obs)")}${input("f-mo", ctx.min_obs, "Min observations")}
      ${input("f-dte", ctx.min_dte, "Min days to expiry")}${input("f-gap", ctx.max_gap, "Max expiry gap (d)")}
    </div><div style="margin-top:12px">${toggle("f-carry", ctx.carry, "Carry-adjust to spot-equivalent")}</div></div>
    <div class="form-section row"><button class="btn primary" id="run">Update analysis</button><a class="btn ghost" href="#/signals">Signals →</a></div>`;
  const out = root.querySelector("#out");

  async function run() {
    const a = val(ctl, "f-a"), b = val(ctl, "f-b");
    if (a === b) { out.innerHTML = `<div class="alert warn"><span class="dot warn"></span>Choose two different contracts.</div>`; return; }
    saveCtx({ a, b, lookback: numVal(ctl, "f-lb") ?? 60, min_obs: numVal(ctl, "f-mo") ?? 30, min_dte: numVal(ctl, "f-dte") ?? 5, max_gap: numVal(ctl, "f-gap") ?? 10, carry: checked(ctl, "f-carry") });
    history.replaceState(null, "", `#/relative/${a}/${b}`);
    out.innerHTML = `<div class="panel"><div class="loading"><span class="spinner"></span>Building pair series…</div></div>`;
    const [res, status] = await Promise.all([api.relativeValue(pairParams()), api.status()]);
    if (!status.has_data) { out.innerHTML = noDataState(); return; }
    if (!res.series.length) {
      out.innerHTML = `<div class="empty"><h3>No overlapping observations</h3><p>${a} and ${b} have no days where both had a traded contract with ≥${ctx.min_dte} days to expiry and expiries within ${ctx.max_gap} days of each other. Widen the expiry gap, or load more history.</p></div>`;
      return;
    }
    render(res, a, b);
  }
  ctl.querySelector("#run").addEventListener("click", run);
  await run();

  function render(res, a, b) {
    const s = res.series, st = res.stats;
    const rolls = s.filter((r) => r.roll).map((r) => ({ x: ts(r.trade_date), color: "var(--border-strong)" }));
    out.innerHTML = `
      <div class="stat-row">
        ${stat("Spread now", bps(st.last_spread_bps), `₹${num(st.last_spread_abs, 0)} / 10g fine`)}
        ${stat("z-score", isNum(st.last_z) ? (st.last_z >= 0 ? "+" : "−") + Math.abs(st.last_z).toFixed(2) : "—", `${ctx.lookback}-obs window`)}
        ${stat("Percentile", isNum(st.last_pctile) ? num(st.last_pctile, 0) : "—", "of trailing window")}
        ${stat("Mean / σ", `${num(st.mean_bps, 1)} / ${num(st.std_bps, 1)}`, "bps, full sample")}
        ${stat("AR(1) half-life", isNum(st.mean_reversion_half_life_days) ? num(st.mean_reversion_half_life_days, 1) + " d" : "none", "within contract pairs")}
        ${stat("Observations", int(st.observations), `${st.segments} contract pairs`)}
      </div>
      <div class="panel"><div class="panel-head"><div><h3>Normalized legs</h3><div class="caption">${ctx.carry ? "Carry-adjusted" : "Unadjusted"} ₹ / 10 g fine · now ${a} ${expiry(st.last_expiry_a)} vs ${b} ${expiry(st.last_expiry_b)}</div></div>${legend([{ name: a, color: SYMBOL_COLORS[a] }, { name: b, color: SYMBOL_COLORS[b] }])}</div><div id="c-legs"></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Spread</h3><div class="caption">10 000 × ln(A/B) · rolling mean ±2σ band · dotted verticals mark contract-pair changes · drag to zoom, double-click to reset</div></div>${legend([{ name: "Spread", color: "var(--c-goldm)" }, { name: "Rolling mean", color: "var(--text-2)", dash: true }, { name: "Raw (no carry adj.)", color: "var(--muted)" }])}</div><div id="c-spread"></div></div>
      <div class="grid g-2">
        <div class="panel"><div class="panel-head"><div><h3>z-score</h3><div class="caption">(spread − rolling mean) / rolling σ · lines at ±${ctx.signal.entry_z}σ entry</div></div></div><div id="c-z"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>Distribution</h3><div class="caption">Full-sample histogram of spread (bps) · current value marked</div></div></div><div id="c-hist"></div></div>
      </div>
      <div class="grid g-2">
        <div class="panel"><div class="panel-head"><div><h3>Rolling percentile</h3><div class="caption">Rank of today's spread within the trailing window</div></div></div><div id="c-pct"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>Expiry alignment & carry</h3><div class="caption">Expiry gap B−A (days, left) and implied carry (right)</div></div></div><div id="c-gap"></div></div>
      </div>
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Contract pairs used</h3><div class="caption">Each row is one explicit (A expiry, B expiry) combination</div></div></div><div id="segs"></div></div>`;

    const f1 = (v) => num(v, 1);
    track(lineChart(out.querySelector("#c-legs"), { height: 240, syncKey: "rv", yFormat: (v) => num(v, 0), series: [
      { name: a, color: SYMBOL_COLORS[a], data: s.map((r) => [ts(r.trade_date), r.adj_a]), format: (v) => num(v, 0) },
      { name: b, color: SYMBOL_COLORS[b], data: s.map((r) => [ts(r.trade_date), r.adj_b]), format: (v) => num(v, 0) }] }));
    track(lineChart(out.querySelector("#c-spread"), { height: 280, syncKey: "rv", yFormat: f1, vlines: rolls, series: [
      { name: "±2σ band", kind: "band", color: "var(--c-band)", data: s.map((r) => [ts(r.trade_date), r.lower, r.upper]), format: f1 },
      { name: "Raw", color: "var(--muted)", width: 1, opacity: 0.5, data: s.map((r) => [ts(r.trade_date), r.raw_spread_bps]), format: f1 },
      { name: "Mean", color: "var(--text-2)", dash: "4 3", width: 1, data: s.map((r) => [ts(r.trade_date), r.mean]), format: f1 },
      { name: "Spread", color: "var(--c-goldm)", data: s.map((r) => [ts(r.trade_date), r.spread_bps]), format: f1 }],
      tooltipExtra: (x) => { const r = s.find((q) => ts(q.trade_date) === x); return r ? `<div class="r"><span>Contracts</span><span>${expiry(r.expiry_a)} / ${expiry(r.expiry_b)}</span></div><div class="r"><span>₹/10g</span><span>${num(r.spread_abs, 0)}</span></div>` : ""; } }));
    const ez = ctx.signal.entry_z;
    track(lineChart(out.querySelector("#c-z"), { height: 220, syncKey: "rv", yFormat: (v) => v.toFixed(1), hlines: [{ y: ez, label: `+${ez}σ` }, { y: -ez, label: `−${ez}σ` }],
      series: [{ name: "z", color: "var(--c-goldten)", data: s.map((r) => [ts(r.trade_date), r.z]), format: (v) => v.toFixed(2) }] }));
    track(lineChart(out.querySelector("#c-pct"), { height: 200, syncKey: "rv", yFormat: (v) => v.toFixed(0), hlines: [{ y: 95, dash: "2 4" }, { y: 5, dash: "2 4" }],
      series: [{ name: "Percentile", color: "var(--c-goldpetal)", data: s.map((r) => [ts(r.trade_date), r.pctile]), format: (v) => v.toFixed(0) }] }));
    track(lineChart(out.querySelector("#c-gap"), { height: 200, syncKey: "rv", yFormat: (v) => v.toFixed(0), yFormatRight: (v) => (v * 100).toFixed(1) + "%", series: [
      { name: "Expiry gap (d)", kind: "bars", color: "var(--c-gold)", data: s.map((r) => [ts(r.trade_date), r.expiry_gap]), format: (v) => v.toFixed(0) },
      { name: "Carry", axis: "right", color: "var(--c-goldguinea)", data: s.map((r) => [ts(r.trade_date), r.carry]), format: (v) => (v * 100).toFixed(2) + "%" }] }));

    // histogram
    const vals = s.map((r) => r.spread_bps).filter(isNum);
    const lo = Math.min(...vals), hi = Math.max(...vals), nb = 40, w = (hi - lo) / nb || 1;
    const bins = Array.from({ length: nb }, (_, i) => [lo + (i + 0.5) * w, 0]);
    for (const v of vals) bins[Math.min(nb - 1, Math.floor((v - lo) / w))][1]++;
    track(lineChart(out.querySelector("#c-hist"), { height: 220, xType: "number", yZero: true, xFormat: (v) => v.toFixed(0), xLabel: "spread (bps)", yFormat: (v) => v.toFixed(0),
      vlines: [{ x: st.last_spread_bps, color: "var(--c-goldm)", dash: "0" }],
      series: [{ name: "Days", kind: "bars", color: "var(--c-goldten)", data: bins, format: (v) => v.toFixed(0) }] }));

    const segs = [];
    for (const r of s) {
      const last = segs[segs.length - 1];
      if (!last || last.seg !== r.segment) segs.push({ seg: r.segment, ea: r.expiry_a, eb: r.expiry_b, from: r.trade_date, to: r.trade_date, n: 1, sum: r.spread_bps, gap: r.expiry_gap });
      else { last.to = r.trade_date; last.n++; last.sum += r.spread_bps; }
    }
    out.querySelector("#segs").innerHTML = table([
      { label: `${a} expiry`, render: (r) => `<span class="mono">${expiry(r.ea)}</span>` }, { label: `${b} expiry`, render: (r) => `<span class="mono">${expiry(r.eb)}</span>` },
      { label: "Gap (d)", right: true, render: (r) => r.gap }, { label: "From", render: (r) => date(r.from) }, { label: "To", render: (r) => date(r.to) },
      { label: "Days", right: true, render: (r) => r.n }, { label: "Avg spread", right: true, render: (r) => bps(r.sum / r.n) },
    ], segs.reverse(), { maxHeight: 300 });
  }
}
