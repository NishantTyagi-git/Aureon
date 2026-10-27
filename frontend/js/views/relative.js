import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { advanced, checked, ctx, input, loading, markVisited, noDataState, numVal, pageHead, pairParams, panelHead, saveCtx, select, stat, table, toggle, track, val, workflowBar, zWords } from "../components.js";
import { bps, date, esc, expiry, int, isNum, num, RESEARCH, SYMBOL_COLORS, ts } from "../format.js";
import { info, pageGuide } from "../help.js";

const WINDOWS = [[20, "1 month (20 days)"], [40, "2 months (40 days)"], [60, "3 months (60 days)"], [120, "6 months (120 days)"], [250, "1 year (250 days)"]];
const pctText = (b) => (isNum(b) ? `${b >= 0 ? "+" : "−"}${Math.abs(b / 100).toFixed(2)}%` : "—");

export default async function compare(root, params) {
  if (params[0] && params[1] && RESEARCH.includes(params[0]) && RESEARCH.includes(params[1]) && params[0] !== params[1]) saveCtx({ a: params[0], b: params[1] });
  markVisited("compare");
  const winOpts = WINDOWS.some(([w]) => w === ctx.lookback) ? WINDOWS : [...WINDOWS, [ctx.lookback, `Custom (${ctx.lookback} days)`]];
  root.innerHTML = `
    ${workflowBar("compare")}
    ${pageHead("Step 1 · Compare", "Compare two contracts",
      "Pick two gold contracts. Aureon converts both to the same unit, tracks the difference between them every day, and shows whether today's difference is normal or unusual.")}
    ${pageGuide("compare", {
      what: "The <b>price difference</b> between two contracts over time, its normal range, and how unusual each day was.",
      why: "The contracts all track the same gold, so a large, unusual gap might close again. That is the idea behind every opportunity Aureon looks for — but an unusual gap is <b>not</b> a guaranteed profit.",
      next: "If the gap often strays and returns, go to <a href='#/opportunities'>Find opportunities</a> to see which days were practical to act on.",
    })}
    <div class="grid g-side">
      <div class="panel" id="ctl">
        <div class="form-grid">${select("f-a", RESEARCH, ctx.a, "First contract", "", "goldm")}${select("f-b", RESEARCH, ctx.b, "Second contract")}</div>
        <div style="margin-top:14px">${select("f-lb", winOpts, ctx.lookback, "What counts as “normal”?", "The recent period used as the baseline", "lookback")}</div>
        ${advanced(`
          <div class="form-grid">${input("f-mo", ctx.min_obs, "Min. days of history", "Before judging unusualness")}${input("f-dte", ctx.min_dte, "Skip contracts expiring within (days)", "", "number", "any", "expiry")}
          ${input("f-gap", ctx.max_gap, "Max. expiry mismatch (days)", "How far apart the two expiry dates may be")}</div>
          ${toggle("f-carry", ctx.carry, "Adjust for different expiry dates", "carry")}`)}
        <p class="caption" style="margin:14px 0 0">The comparison updates as soon as you change a setting.</p>
      </div>
      <div class="stack" id="out"></div>
    </div>`;
  const ctl = root.querySelector("#ctl");
  const out = root.querySelector("#out");

  async function run() {
    const a = val(ctl, "f-a"), b = val(ctl, "f-b");
    if (a === b) { out.innerHTML = `<div class="alert warn"><span class="dot warn"></span><div>Pick two <b>different</b> contracts to compare.</div></div>`; return; }
    const lb = numVal(ctl, "f-lb") ?? 60;
    saveCtx({ a, b, lookback: lb, min_obs: Math.min(numVal(ctl, "f-mo") ?? 30, lb), min_dte: numVal(ctl, "f-dte") ?? 5, max_gap: numVal(ctl, "f-gap") ?? 10, carry: checked(ctl, "f-carry") });
    history.replaceState(null, "", `#/compare/${a}/${b}`);
    root.querySelector(".flow").outerHTML = workflowBar("compare");
    out.innerHTML = loading(`Comparing ${a} with ${b}…`);
    const [res, status] = await Promise.all([api.relativeValue(pairParams()), api.status()]);
    if (!status.has_data) { out.innerHTML = noDataState(); return; }
    if (!res.series.length) {
      out.innerHTML = `<div class="empty"><h3>These two contracts can't be compared yet</h3><p>There are no days on which both ${a} and ${b} were actively traded with expiry dates close enough together (within ${ctx.max_gap} days). Try a different pair, or allow a larger expiry mismatch under <b>Advanced settings</b>.</p></div>`;
      return;
    }
    render(res, a, b);
  }
  let timer;
  ctl.addEventListener("change", () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  await run();

  function render(res, a, b) {
    const s = res.series, st = res.stats;
    const rolls = s.filter((r) => r.roll).map((r) => ({ x: ts(r.trade_date), color: "var(--border-strong)" }));
    const lb = ctx.lookback;
    out.innerHTML = `
      <div class="panel">
        <p class="summary-line">On <b>${date(st.last_date)}</b>, ${a} cost <b>${Math.abs(st.last_spread_bps / 100).toFixed(2)}%</b> ${st.last_spread_bps >= 0 ? "more" : "less"} than ${b} (₹${num(Math.abs(st.last_spread_abs), 0)} per 10 g of pure gold). That is <b>${esc(zWords(st.last_z))}</b> for the last ${lb} trading days.</p>
        <p class="caption" style="margin-top:8px">Over the whole history the difference averaged ${pctText(st.mean_bps)}${isNum(st.mean_reversion_half_life_days) ? `, and when it strayed it typically closed half the gap in about ${num(st.mean_reversion_half_life_days, 0)} trading days` : ""}.</p>
      </div>
      <div class="stat-row">
        ${stat("Difference now", bps(st.last_spread_bps), `${pctText(st.last_spread_bps)} · ₹${num(st.last_spread_abs, 0)} / 10 g`, "", "spread")}
        ${stat("How unusual", isNum(st.last_z) ? (st.last_z >= 0 ? "+" : "−") + Math.abs(st.last_z).toFixed(2) + "σ" : "—", esc(zWords(st.last_z)), "", "zscore")}
        ${stat("Percentile", isNum(st.last_pctile) ? num(st.last_pctile, 0) : "—", `rank within last ${lb} days`, "", "percentile")}
        ${stat("Typical difference", bps(st.mean_bps), `swings ±${num(st.std_bps, 0)} bps`, "", "bps")}
        ${stat("Time to revert", isNum(st.mean_reversion_half_life_days) ? `${num(st.mean_reversion_half_life_days, 0)} days` : "no pattern", "historical half-life", "", "halflife")}
        ${stat("Days compared", int(st.observations), `${st.segments} contract switches`, "", "roll")}
      </div>
      <div class="panel">${panelHead("Price difference over time", `${a} minus ${b}, in basis points (100 bps = 1%). The shaded band is the normal range — the recent average ± 2 typical swings. Dotted lines mark contract switches. Drag to zoom; double-click to reset.`, legend([{ name: "Difference", color: "var(--c-goldm)" }, { name: "Recent average", color: "var(--text-2)", dash: true }, { name: "Normal range", color: "var(--c-band)" }]), "spread")}<div id="c-spread"></div></div>
      <div class="grid g-2">
        <div class="panel">${panelHead("How unusual each day was", `0 = normal. Beyond the dashed lines (±${ctx.signal.entry_z}) the difference counts as unusual.`, "", "zscore")}<div id="c-z"></div></div>
        <div class="panel">${panelHead("How often each difference occurs", "All days in the history. The gold line marks today.")}<div id="c-hist"></div></div>
      </div>
      <div class="panel">${panelHead("Comparable prices of both contracts", `₹ per 10 g of pure gold${ctx.carry ? ", adjusted for different expiry dates" : ""}. Currently ${a} ${expiry(st.last_expiry_a)} vs ${b} ${expiry(st.last_expiry_b)}.`, legend([{ name: a, color: SYMBOL_COLORS[a] }, { name: b, color: SYMBOL_COLORS[b] }]), "normalized")}<div id="c-legs"></div></div>
      <details class="panel"><summary class="caption" style="cursor:pointer">More detail — percentile, expiry alignment and contracts used</summary>
        <div class="stack" style="margin-top:16px">
          <div>${panelHead("Percentile within recent history", "Above 95 or below 5 means today's gap is at an extreme of the recent range.", "", "percentile")}<div id="c-pct"></div></div>
          <div>${panelHead("Expiry mismatch and carry", "Days between the two expiry dates (bars) and the market's annual cost of carry (line).", "", "carry")}<div id="c-gap"></div></div>
          <div>${panelHead("Contracts used", "Each row is one specific pair of expiries that was compared", "", "roll")}<div id="segs"></div></div>
        </div></details>
      <div class="panel row between"><div><h3>Next: were any of these gaps worth acting on?</h3><div class="caption">The opportunity check adds practical rules — trading activity, expiry, costs — on top of “unusual”.</div></div><a class="btn primary" href="#/opportunities">Find opportunities →</a></div>`;

    const f1 = (v) => num(v, 1) + " bps";
    track(lineChart(out.querySelector("#c-spread"), { height: 280, syncKey: "rv", yFormat: (v) => num(v, 0), vlines: rolls, series: [
      { name: "Normal range", kind: "band", color: "var(--c-band)", data: s.map((r) => [ts(r.trade_date), r.lower, r.upper]), format: f1 },
      { name: "Recent average", color: "var(--text-2)", dash: "4 3", width: 1, data: s.map((r) => [ts(r.trade_date), r.mean]), format: f1 },
      { name: "Difference", color: "var(--c-goldm)", data: s.map((r) => [ts(r.trade_date), r.spread_bps]), format: f1 }],
      tooltipExtra: (x) => { const r = s.find((q) => ts(q.trade_date) === x); return r ? `<div class="r"><span>Contracts</span><span>${expiry(r.expiry_a)} / ${expiry(r.expiry_b)}</span></div><div class="r"><span>₹ per 10 g</span><span>${num(r.spread_abs, 0)}</span></div>` : ""; } }));
    const ez = ctx.signal.entry_z;
    track(lineChart(out.querySelector("#c-z"), { height: 220, syncKey: "rv", yFormat: (v) => v.toFixed(1), hlines: [{ y: ez, label: `unusual +${ez}` }, { y: -ez, label: `unusual −${ez}` }],
      series: [{ name: "How unusual", color: "var(--c-goldten)", data: s.map((r) => [ts(r.trade_date), r.z]), format: (v) => v.toFixed(2) + "σ" }] }));
    track(lineChart(out.querySelector("#c-legs"), { height: 240, syncKey: "rv", yFormat: (v) => num(v, 0), series: [
      { name: a, color: SYMBOL_COLORS[a], data: s.map((r) => [ts(r.trade_date), r.adj_a]), format: (v) => "₹" + num(v, 0) },
      { name: b, color: SYMBOL_COLORS[b], data: s.map((r) => [ts(r.trade_date), r.adj_b]), format: (v) => "₹" + num(v, 0) }] }));
    track(lineChart(out.querySelector("#c-pct"), { height: 200, syncKey: "rv", yFormat: (v) => v.toFixed(0), hlines: [{ y: 95, dash: "2 4" }, { y: 5, dash: "2 4" }],
      series: [{ name: "Percentile", color: "var(--c-goldpetal)", data: s.map((r) => [ts(r.trade_date), r.pctile]), format: (v) => v.toFixed(0) }] }));
    track(lineChart(out.querySelector("#c-gap"), { height: 200, syncKey: "rv", yFormat: (v) => v.toFixed(0), yFormatRight: (v) => (v * 100).toFixed(1) + "%", series: [
      { name: "Expiry mismatch (days)", kind: "bars", color: "var(--c-gold)", data: s.map((r) => [ts(r.trade_date), r.expiry_gap]), format: (v) => v.toFixed(0) + " d" },
      { name: "Carry (per year)", axis: "right", color: "var(--c-goldguinea)", data: s.map((r) => [ts(r.trade_date), r.carry]), format: (v) => (v * 100).toFixed(2) + "%" }] }));

    const vals = s.map((r) => r.spread_bps).filter(isNum);
    const lo = Math.min(...vals), hi = Math.max(...vals), nb = 40, w = (hi - lo) / nb || 1;
    const bins = Array.from({ length: nb }, (_, i) => [lo + (i + 0.5) * w, 0]);
    for (const v of vals) bins[Math.min(nb - 1, Math.floor((v - lo) / w))][1]++;
    track(lineChart(out.querySelector("#c-hist"), { height: 220, xType: "number", yZero: true, xFormat: (v) => v.toFixed(0), xLabel: "difference (bps)", yFormat: (v) => v.toFixed(0),
      vlines: [{ x: st.last_spread_bps, color: "var(--c-goldm)", dash: "0" }],
      series: [{ name: "Days", kind: "bars", color: "var(--c-goldten)", data: bins, format: (v) => v.toFixed(0) + " days" }] }));

    const segs = [];
    for (const r of s) {
      const last = segs[segs.length - 1];
      if (!last || last.seg !== r.segment) segs.push({ seg: r.segment, ea: r.expiry_a, eb: r.expiry_b, from: r.trade_date, to: r.trade_date, n: 1, sum: r.spread_bps, gap: r.expiry_gap });
      else { last.to = r.trade_date; last.n++; last.sum += r.spread_bps; }
    }
    out.querySelector("#segs").innerHTML = table([
      { label: `${a} contract`, render: (r) => `<span class="mono">${expiry(r.ea)}</span>` }, { label: `${b} contract`, render: (r) => `<span class="mono">${expiry(r.eb)}</span>` },
      { label: "Expiry gap", right: true, render: (r) => `${r.gap} d` }, { label: "From", render: (r) => date(r.from) }, { label: "To", render: (r) => date(r.to) },
      { label: "Days", right: true, render: (r) => r.n }, { label: "Avg. difference", right: true, render: (r) => bps(r.sum / r.n) },
    ], segs.reverse(), { maxHeight: 300 });
  }
}
