import { api } from "../api.js";
import { lineChart } from "../charts.js";
import { ctx, input, noDataState, numVal, researchBody, saveCtx, select, stat, track, val } from "../components.js";
import { bps, date, esc, expiry, inr, int, isNum, num, RESEARCH, ts } from "../format.js";

const CHECK_LABELS = { history: "History", z_threshold: "z threshold", expiry: "Expiry", roll_settled: "Roll settled", liquidity: "Liquidity", hedge_residual: "Hedge residual", cost_hurdle: "Cost hurdle", data_quality: "Data quality" };

export function signalForm(prefix = "s") {
  const s = ctx.signal;
  return `
    <div class="form-section"><span class="overline">Pair</span><div class="form-grid" style="margin-top:8px">${select(prefix + "-a", RESEARCH, ctx.a, "Leg A")}${select(prefix + "-b", RESEARCH, ctx.b, "Leg B")}${input(prefix + "-lb", ctx.lookback, "Lookback (obs)")}${input(prefix + "-gap", ctx.max_gap, "Max expiry gap (d)")}</div></div>
    <div class="form-section"><span class="overline">Thresholds</span><div class="form-grid" style="margin-top:8px">
      ${input(prefix + "-ez", s.entry_z, "Entry |z|")}${input(prefix + "-xz", s.exit_z, "Exit |z|")}
      ${input(prefix + "-sz", s.stop_z, "Stop |z|")}${input(prefix + "-mh", s.max_holding_days, "Max holding (bdays)")}
      ${input(prefix + "-med", s.min_entry_dte, "Min DTE to enter")}${input(prefix + "-xd", s.exit_dte, "Exit at DTE (bdays)")}
    </div></div>
    <div class="form-section"><span class="overline">Sizing, liquidity & costs</span><div class="form-grid" style="margin-top:8px">
      ${input(prefix + "-tg", s.target_fine_grams, "Target fine gold (g)")}${input(prefix + "-mr", s.max_residual_pct, "Max hedge residual %")}
      ${input(prefix + "-mp", s.max_participation, "Max participation", "fraction of day volume")}${input(prefix + "-oi", s.min_open_interest, "Min open interest")}
      ${input(prefix + "-cm", s.cost_multiple, "Cost hurdle ×")}${input(prefix + "-sl", ctx.costs.slippage_ticks, "Slippage (ticks/side)")}
      ${input(prefix + "-br", ctx.costs.brokerage_per_order, "Brokerage ₹/order")}${input(prefix + "-ex", ctx.costs.exchange_txn_rate * 1e5, "Exchange ₹ per lakh")}
    </div></div>`;
}

export function readSignalForm(root, prefix = "s") {
  const n = (id, d) => numVal(root, prefix + "-" + id) ?? d;
  saveCtx({
    a: val(root, prefix + "-a"), b: val(root, prefix + "-b"), lookback: n("lb", ctx.lookback), max_gap: n("gap", ctx.max_gap),
    signal: { entry_z: n("ez", 2), exit_z: n("xz", 0.5), stop_z: n("sz", 4), max_holding_days: n("mh", 30), min_entry_dte: n("med", 10), exit_dte: n("xd", 3),
      target_fine_grams: n("tg", 1000), max_residual_pct: n("mr", 5), max_participation: n("mp", 0.05), min_open_interest: n("oi", 50), cost_multiple: n("cm", 1.5) },
    costs: { slippage_ticks: n("sl", 1), brokerage_per_order: n("br", 20), exchange_txn_rate: n("ex", 2.1) / 1e5 },
  });
}

export function checksHtml(checks) {
  return `<div class="checks">${checks.map((c) => `<div class="check"><span class="mark ${c.passed ? "ok" : "no"}">${c.passed ? "✓" : "✕"}</span><span class="name">${esc(CHECK_LABELS[c.check] || c.check)}</span><span class="det">${esc(c.detail)}</span></div>`).join("")}</div>`;
}

export default async function signals(root) {
  root.innerHTML = `<div class="page-head"><div><span class="overline">Research signal engine</span><h1>Signal analysis</h1>
    <p>Each trading day is evaluated against every rule using only information available at that day's close. A signal fires only if all checks pass — otherwise the engine returns <b>no signal</b> and records why. Signals are research hypotheses, not trade recommendations.</p></div></div>
    <div class="grid g-side"><div class="panel" id="ctl">${signalForm()}<div class="form-section row"><button class="btn primary" id="run">Evaluate</button><a class="btn ghost" href="#/backtest">Backtest →</a></div></div><div class="stack" id="out"></div></div>`;
  const ctl = root.querySelector("#ctl"), out = root.querySelector("#out");
  async function run() {
    readSignalForm(ctl);
    if (ctx.a === ctx.b) { out.innerHTML = `<div class="alert warn"><span class="dot warn"></span>Choose two different contracts.</div>`; return; }
    out.innerHTML = `<div class="panel"><div class="loading"><span class="spinner"></span>Evaluating every day…</div></div>`;
    const [res, status] = await Promise.all([api.signals(researchBody({ last_n: 2000 })), api.status()]);
    if (!status.has_data) { out.innerHTML = noDataState(); return; }
    const ev = res.evaluations;
    if (!ev.length) { out.innerHTML = `<div class="empty"><h3>Nothing to evaluate</h3><p>No overlapping observations for ${ctx.a}/${ctx.b} under these settings.</p></div>`; return; }
    const last = ev[ev.length - 1];
    const fired = ev.filter((e) => e.signal);
    const fails = Object.entries(res.rejection_counts).sort((a, b) => b[1] - a[1]);
    out.innerHTML = `
      <div class="stat-row">${stat("Days evaluated", int(ev.length))}${stat("Signals", int(fired.length), `${((100 * fired.length) / ev.length).toFixed(1)}% of days`)}
        ${stat("Long spread", int(fired.filter((e) => e.signal === "long_spread").length))}${stat("Short spread", int(fired.filter((e) => e.signal === "short_spread").length))}
        ${stat("Lots per signal", `${last.lots_a} / ${last.lots_b}`, `${ctx.a} / ${ctx.b}`)}${stat("Round-trip cost", inr(last.round_trip_cost), "latest estimate")}</div>
      <div class="panel"><div class="panel-head"><div><h3>Latest decision · ${date(last.trade_date)}</h3><div class="caption">${esc(last.summary)}</div></div>${last.signal ? `<span class="chip warn">${last.signal.replace("_", " ")}</span>` : `<span class="chip">no signal</span>`}</div>${checksHtml(last.checks)}</div>
      <div class="panel"><div class="panel-head"><div><h3>z-score and signals</h3><div class="caption">▲ long spread (buy ${ctx.a}/sell ${ctx.b}) · ▼ short spread · hover for values · click a day below for its full reasoning</div></div></div><div id="c-z"></div></div>
      <div class="grid g-2">
        <div class="panel"><div class="panel-head"><div><h3>Why days were rejected</h3><div class="caption">Count of days each check failed (a day can fail several)</div></div></div><div id="fails"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>Expected edge vs cost</h3><div class="caption">Reversion edge to the mean (₹) vs round-trip cost (₹) on each day</div></div></div><div id="c-edge"></div></div>
      </div>
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Decision log</h3><div class="caption">Most recent first · click a row to see every check</div></div>
        <div class="seg" id="flt" style="margin-right:20px"><button data-f="all" class="on">All days</button><button data-f="sig">Signals only</button></div></div><div id="log" class="list" style="max-height:520px;overflow:auto"></div></div>`;

    const max = Math.max(1, ...fails.map((f) => f[1]));
    out.querySelector("#fails").innerHTML = fails.length ? fails.map(([k, n]) => `<div style="margin-bottom:10px"><div class="row between small"><span>${esc(CHECK_LABELS[k] || k)}</span><span class="mono muted">${int(n)}</span></div><div style="height:6px;background:var(--surface-3);border-radius:3px;margin-top:4px"><div style="height:6px;width:${(100 * n) / max}%;background:var(--c-goldm);border-radius:3px"></div></div></div>`).join("") : `<div class="caption">No check failed.</div>`;
    const ez = ctx.signal.entry_z;
    track(lineChart(out.querySelector("#c-z"), { height: 260, syncKey: "sig", yFormat: (v) => v.toFixed(1), hlines: [{ y: ez, label: `+${ez}σ` }, { y: -ez, label: `−${ez}σ` }],
      markers: fired.map((e) => ({ x: ts(e.trade_date), y: e.z, shape: e.signal === "long_spread" ? "up" : "down", color: e.signal === "long_spread" ? "var(--pos)" : "var(--neg)" })),
      series: [{ name: "z", color: "var(--c-goldten)", data: ev.map((e) => [ts(e.trade_date), e.z]), format: (v) => v.toFixed(2) }] }));
    track(lineChart(out.querySelector("#c-edge"), { height: 220, syncKey: "sig", yFormat: (v) => inr(v), series: [
      { name: "Expected edge", color: "var(--c-goldm)", data: ev.map((e) => [ts(e.trade_date), e.expected_edge]), format: (v) => inr(v) },
      { name: `Cost × ${ctx.signal.cost_multiple}`, color: "var(--neg)", dash: "4 3", data: ev.map((e) => [ts(e.trade_date), e.round_trip_cost * ctx.signal.cost_multiple]), format: (v) => inr(v) }] }));

    let mode = "all";
    const logEl = out.querySelector("#log");
    function drawLog() {
      const rows = (mode === "sig" ? fired : ev).slice().reverse().slice(0, 400);
      logEl.innerHTML = rows.map((e, i) => `<div class="list-row" data-i="${i}" style="cursor:pointer;flex-direction:column;align-items:stretch">
        <div class="row between"><span class="mono small">${date(e.trade_date)} · z ${isNum(e.z) ? e.z.toFixed(2) : "—"} · ${bps(e.spread_bps)} · ${expiry(e.expiry_a)}/${expiry(e.expiry_b)}</span>${e.signal ? `<span class="chip warn">${e.signal.replace("_", " ")}</span>` : `<span class="chip">no signal</span>`}</div>
        <div class="caption">${esc(e.summary)}</div><div class="detail" style="display:none;margin-top:10px">${checksHtml(e.checks)}</div></div>`).join("") || `<div class="loading">No signals under these settings.</div>`;
      logEl.querySelectorAll(".list-row").forEach((r) => r.addEventListener("click", () => { const d = r.querySelector(".detail"); d.style.display = d.style.display === "none" ? "block" : "none"; }));
    }
    out.querySelectorAll("#flt button").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.f; out.querySelectorAll("#flt button").forEach((x) => x.classList.toggle("on", x === b)); drawLog(); }));
    drawLog();
  }
  ctl.querySelector("#run").addEventListener("click", run);
  await run();
}
