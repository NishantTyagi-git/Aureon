import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { empty, stat, table, track } from "../components.js";
import { cls, date, esc, expiry, inr, inrCompact, int, isNum, num, pct, ts } from "../format.js";

export function verdictHtml(m, oos) {
  const v = m && m.verdict;
  if (!v || typeof v !== "object") return "";
  const k = { positive_but_verify: "ok", not_significant: "warn", insufficient_evidence: "warn", unprofitable_after_costs: "err", unprofitable: "err" }[v.label] || "warn";
  const label = { positive_but_verify: "Positive in sample — verify", not_significant: "Not statistically significant", insufficient_evidence: "Insufficient evidence", unprofitable_after_costs: "Unprofitable after costs", unprofitable: "Unprofitable" }[v.label] || v.label;
  return `<div class="verdict ${k}"><span class="overline">${oos ? "Out-of-sample verdict" : "Verdict (single window, in-sample)"}</span><div class="label">${esc(label)}</div><div class="small muted">${esc(v.text)}</div></div>`;
}

export function metricsRow(m) {
  return `<div class="stat-row">
    ${stat("Net P&L", `<span class="${cls(m.net_pnl)}">${inrCompact(m.net_pnl)}</span>`, `gross ${inrCompact(m.gross_pnl)} · costs ${inrCompact(m.costs)}`)}
    ${stat("Trades", int(m.trade_count), isNum(m.win_rate) ? `win rate ${pct(m.win_rate, 0)}` : "")}
    ${stat("Sharpe", isNum(m.sharpe) ? m.sharpe.toFixed(2) : "—", `vol ${pct(m.annualized_volatility, 1)}`)}
    ${stat("Max drawdown", inrCompact(m.max_drawdown), pct(m.max_drawdown_pct, 2))}
    ${stat("Return on capital", pct(m.total_return), isNum(m.annualized_return) ? `${pct(m.annualized_return)} / yr` : "")}
    ${stat("Trade t-stat", isNum(m.trade_t_stat) ? m.trade_t_stat.toFixed(2) : "—", isNum(m.avg_trade_net) ? `avg ${inr(m.avg_trade_net)}` : "")}
  </div>`;
}

export function renderResults(container, res, opts = {}) {
  const oos = res.kind === "walkforward";
  const m = oos ? res.oos_metrics || {} : res.metrics || {};
  const daily = oos ? (res.oos && res.oos.daily) || [] : res.daily || [];
  const trades = oos ? (res.oos && res.oos.trades) || [] : res.trades || [];
  const p = res.pair || {};
  container.innerHTML = `
    ${verdictHtml(m, oos)}
    ${metricsRow(m)}
    <div class="stat-row">
      ${stat("Relative P&L", `<span class="${cls(m.relative_pnl)}">${inrCompact(m.relative_pnl)}</span>`, "spread component")}
      ${stat("Directional P&L", `<span class="${cls(m.directional_pnl)}">${inrCompact(m.directional_pnl)}</span>`, "residual gold exposure")}
      ${stat("Beta to gold", isNum(m.gold_beta) ? m.gold_beta.toFixed(3) : "—", isNum(m.gold_correlation) ? `corr ${m.gold_correlation.toFixed(2)}` : "days in position")}
      ${stat("Cost / |gross|", isNum(m.cost_share_of_gross) ? pct(m.cost_share_of_gross, 0) : "—")}
      ${stat("Time in market", pct(m.time_in_market, 0), isNum(m.avg_holding_days) ? `avg hold ${num(m.avg_holding_days, 1)} bdays` : "")}
      ${stat("Turnover", isNum(m.turnover) ? `${num(m.turnover, 1)}×` : "—", "of capital")}
    </div>
    <div class="panel"><div class="panel-head"><div><h3>Equity & drawdown</h3><div class="caption">${p.a || ""}/${p.b || ""} · ${oos ? "stitched out-of-sample test windows only" : "single backtest window"} · net of all modelled costs</div></div></div><div id="r-eq"></div><div id="r-dd"></div></div>
    <div class="grid g-2">
      <div class="panel"><div class="panel-head"><div><h3>P&L attribution</h3><div class="caption">Cumulative relative (spread) vs directional (residual gold) vs costs</div></div>${legend([{ name: "Relative", color: "var(--c-goldten)" }, { name: "Directional", color: "var(--c-goldm)" }, { name: "Costs", color: "var(--neg)" }])}</div><div id="r-attr"></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Transaction-cost sensitivity</h3><div class="caption">Net P&L as every cost component is scaled</div></div></div><div id="r-sens"></div></div>
    </div>
    <div class="grid g-2">
      <div class="panel"><div class="panel-head"><div><h3>Trade outcomes</h3><div class="caption">Net P&L per trade, chronological</div></div></div><div id="r-tr"></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Exit reasons</h3></div></div><div id="r-exit"></div></div>
    </div>
    ${oos ? `<div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Walk-forward folds</h3><div class="caption">Parameters are chosen on train, confirmed on validation, then applied unchanged to the unseen test window</div></div></div><div id="r-folds"></div></div>` : ""}
    <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Trades</h3><div class="caption">Every leg is a specific contract; prices include slippage</div></div></div><div id="r-trades"></div></div>`;

  if (!daily.length) {
    container.querySelector("#r-eq").innerHTML = `<div class="loading">No daily results.</div>`;
  } else {
    let peak = -Infinity;
    const eq = daily.map((d) => [ts(d.trade_date), d.equity]);
    const dd = daily.map((d) => { peak = Math.max(peak, d.equity); return [ts(d.trade_date), d.equity - peak]; });
    track(lineChart(container.querySelector("#r-eq"), { height: 240, syncKey: "perf", yFormat: inrCompact, series: [{ name: "Equity", kind: "area", color: "var(--c-goldm)", data: eq, format: inr }] }));
    track(lineChart(container.querySelector("#r-dd"), { height: 120, syncKey: "perf", yFormat: inrCompact, series: [{ name: "Drawdown", kind: "area", color: "var(--neg)", data: dd, format: inr }], areaBase: 0 }));
    let cr = 0, cd = 0, cc = 0;
    track(lineChart(container.querySelector("#r-attr"), { height: 240, syncKey: "perf", yFormat: inrCompact, series: [
      { name: "Relative", color: "var(--c-goldten)", data: daily.map((d) => [ts(d.trade_date), (cr += d.relative)]), format: inr },
      { name: "Directional", color: "var(--c-goldm)", data: daily.map((d) => [ts(d.trade_date), (cd += d.directional)]), format: inr },
      { name: "Costs", color: "var(--neg)", data: daily.map((d) => [ts(d.trade_date), -(cc += d.costs)]), format: inr }] }));
  }
  const sens = res.cost_sensitivity || [];
  if (sens.length) {
    track(lineChart(container.querySelector("#r-sens"), { height: 240, xType: "number", xLabel: "cost multiplier", xFormat: (v) => v.toFixed(1) + "×", yFormat: inrCompact, yZero: true, series: [
      { name: "Net P&L", color: "var(--c-goldm)", points: true, data: sens.map((s) => [s.multiplier, s.net_pnl]), format: inr },
      { name: "Gross P&L", color: "var(--muted)", dash: "4 3", data: sens.map((s) => [s.multiplier, s.gross_pnl]), format: inr }] }));
  } else container.querySelector("#r-sens").innerHTML = `<div class="caption">Cost sensitivity is computed for single-window backtests. ${oos ? "Run a backtest on the Backtest page to see it." : ""}</div>`;
  if (trades.length) {
    track(lineChart(container.querySelector("#r-tr"), { height: 240, yZero: true, yFormat: inrCompact, series: [{ name: "Net", kind: "bars", color: (p) => (p[1] >= 0 ? "var(--pos)" : "var(--neg)"), data: trades.map((t) => [ts(t.exit_date), t.net]), format: inr }] }));
  } else container.querySelector("#r-tr").innerHTML = `<div class="loading">No trades.</div>`;
  const reasons = m.exit_reasons || {};
  container.querySelector("#r-exit").innerHTML = Object.keys(reasons).length ? table([{ label: "Reason", key: "k" }, { label: "Trades", right: true, key: "n" }], Object.entries(reasons).map(([k, n]) => ({ k, n }))) : `<div class="caption">No exits.</div>`;
  if (oos) {
    container.querySelector("#r-folds").innerHTML = table([
      { label: "Train", render: (f) => `${date(f.train[0])} → ${date(f.train[1])}` }, { label: "Validation", render: (f) => `${date(f.validation[0])} → ${date(f.validation[1])}` },
      { label: "Test", render: (f) => `${date(f.test[0])} → ${date(f.test[1])}` },
      { label: "Chosen", render: (f) => (f.chosen ? `<span class="mono">L${f.chosen.lookback} · z${f.chosen.entry_z}</span>` : "—") },
      { label: "Train net", right: true, render: (f) => inrCompact(f.train_net) }, { label: "Val net", right: true, render: (f) => inrCompact(f.validation_net) },
      { label: "Test net", right: true, render: (f) => `<span class="${cls(f.test_net)}">${inrCompact(f.test_net)}</span>` },
      { label: "Status", render: (f) => (f.status === "traded" ? `<span class="chip ok">traded</span>` : `<span class="chip warn" title="${esc(f.reason || "")}">abstain</span>`) },
    ], res.folds || [], { emptyText: res.message || "No folds." });
  }
  container.querySelector("#r-trades").innerHTML = table([
    { label: "Dir", render: (t) => `<span class="chip sq">${t.direction === "long_spread" ? "long" : "short"}</span>` },
    { label: "Signal", render: (t) => date(t.signal_date) }, { label: "Entry", render: (t) => date(t.entry_date) }, { label: "Exit", render: (t) => date(t.exit_date) },
    { label: "Leg A", render: (t) => `<span class="mono">${t.lots_a}× ${t.symbol_a} ${expiry(t.expiry_a)}</span>` },
    { label: "Leg B", render: (t) => `<span class="mono">${t.lots_b}× ${t.symbol_b} ${expiry(t.expiry_b)}</span>` },
    { label: "Entry z", right: true, render: (t) => (isNum(t.entry_z) ? t.entry_z.toFixed(2) : "—") },
    { label: "Days", right: true, render: (t) => t.holding_days }, { label: "Gross", right: true, render: (t) => inr(t.gross) },
    { label: "Costs", right: true, render: (t) => inr(t.costs) }, { label: "Net", right: true, cls: (t) => cls(t.net), render: (t) => inr(t.net) },
    { label: "Exit", render: (t) => esc(t.exit_reason) },
  ], trades.slice().reverse(), { maxHeight: 420, emptyText: "No trades were generated." });
}

export default async function performance(root) {
  root.innerHTML = `<div class="page-head"><div><span class="overline">Performance & risk</span><h1>Results analysis</h1>
    <p>Performance from the most recent backtest or walk-forward run. P&L is split into the relative-value component and the directional gold exposure that remains because contract sizes and purities never hedge perfectly. Profitability is only claimed when the evidence supports it.</p></div>
    <div class="seg" id="kind"><button data-k="walkforward">Walk-forward (OOS)</button><button data-k="backtest">Single backtest</button></div></div><div id="out" class="stack"></div>`;
  const res = await api.latest();
  const out = root.querySelector("#out");
  const avail = { backtest: res.backtest, walkforward: res.walkforward };
  let kind = res.walkforward ? "walkforward" : "backtest";
  function draw() {
    root.querySelectorAll("#kind button").forEach((b) => b.classList.toggle("on", b.dataset.k === kind));
    const r = avail[kind];
    if (!r) { out.innerHTML = empty("No results yet", `Run a ${kind === "walkforward" ? "walk-forward validation" : "backtest"} in the Backtest workspace. Results appear here and stay until the server restarts.`, `<a class="btn primary" href="#/backtest">Open Backtest workspace</a>`); return; }
    renderResults(out, r);
  }
  root.querySelectorAll("#kind button").forEach((b) => b.addEventListener("click", () => { kind = b.dataset.k; draw(); }));
  draw();
}
