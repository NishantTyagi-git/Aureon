import { api } from "../api.js";
import { lineChart, legend } from "../charts.js";
import { ctx, empty, markVisited, pageHead, panelHead, saveCtx, stat, table, track, workflowBar } from "../components.js";
import { cls, date, esc, expiry, inr, inrCompact, int, isNum, num, pct, ts } from "../format.js";
import { info, pageGuide } from "../help.js";

const VERDICTS = {
  positive_but_verify: { k: "ok", label: "Promising — verify further" },
  not_significant: { k: "warn", label: "Profit could be luck" },
  insufficient_evidence: { k: "warn", label: "Not enough evidence" },
  unprofitable_after_costs: { k: "err", label: "Not profitable after costs" },
  unprofitable: { k: "err", label: "Not profitable" },
};
const EXIT_REASONS = {
  target: "Gap returned to normal", stop: "Gap kept widening (stop-loss)", expiry: "Contract close to expiry",
  max_holding: "Held for the maximum time", window_end: "Test period ended",
};
const exitText = (r) => (EXIT_REASONS[r.split("+")[0]] || r) + (r.includes("forced_settle") ? " (no trade possible — settled at last price)" : "");

export function verdictHtml(m, oos) {
  const v = m && m.verdict;
  if (!v || typeof v !== "object") return "";
  const d = VERDICTS[v.label] || { k: "warn", label: v.label };
  return `<div class="verdict ${d.k}"><span class="overline">${oos ? "Verdict on unseen data" : "Verdict (quick test on the full period)"}${info("verdict")}</span><div class="label">${esc(d.label)}</div><div class="small muted">${esc(v.text)}</div></div>`;
}

export function metricsRow(m) {
  return `<div class="stat-row">
    ${stat("Net profit / loss", `<span class="${cls(m.net_pnl)}">${inrCompact(m.net_pnl)}</span>`, `before costs ${inrCompact(m.gross_pnl)} · costs ${inrCompact(m.costs)}`, "", "netpnl")}
    ${stat("Trades", int(m.trade_count), isNum(m.win_rate) ? `${pct(m.win_rate, 0)} were winners` : "", "", "winrate")}
    ${stat("Largest drop", inrCompact(m.max_drawdown), isNum(m.max_drawdown_pct) ? `${pct(m.max_drawdown_pct, 2)} of the account` : "", "", "drawdown")}
    ${stat("Return on capital", pct(m.total_return), isNum(m.annualized_return) ? `${pct(m.annualized_return)} per year` : "")}
    ${stat("Confidence", isNum(m.trade_t_stat) ? m.trade_t_stat.toFixed(2) : "—", !isNum(m.trade_t_stat) ? "needs more trades" : (m.trade_count || 0) < 20 ? "too few trades to rely on" : m.trade_t_stat >= 2 ? "unlikely to be luck" : "could easily be luck", "", "tstat")}
    ${stat("Sharpe ratio", isNum(m.sharpe) ? m.sharpe.toFixed(2) : "—", "return per unit of risk", "", "sharpe")}
  </div>`;
}

/** One-click alternatives offered whenever a test ends without trades, so there is always a next step. */
function alternatives(res, oos) {
  const p = res.pair || {};
  const z = (res.config && res.config.signal && res.config.signal.entry_z) || ctx.signal.entry_z;
  const opts = [];
  if (oos) opts.push({ mode: "backtest", patch: {}, label: "Run a quick test on this pair", hint: "uses the whole period" });
  if (z > 1.5) opts.push({ mode: oos ? "walkforward" : "backtest", patch: { signal: { entry_z: 1.5 } }, label: "Try the Relaxed setting", hint: "flags more moderate gaps" });
  if (!(p.a === "GOLDM" && p.b === "GOLDGUINEA")) opts.push({ mode: oos ? "walkforward" : "backtest", patch: { a: "GOLDM", b: "GOLDGUINEA" }, label: "Try GOLDM vs GOLDGUINEA", hint: "the pair with the most history" });
  return `<div class="panel"><h3>Try one of these instead</h3><div class="caption" style="margin:4px 0 12px">Each runs immediately on the Test strategy page.</div><div class="row">${opts.map((o) => `<button class="btn" data-alt-mode="${o.mode}" data-alt-patch='${esc(JSON.stringify(o.patch))}' title="${esc(o.hint)}">${esc(o.label)}</button>`).join("")}</div></div>`;
}

function bindAlternatives(container) {
  container.querySelectorAll("[data-alt-mode]").forEach((b) => b.addEventListener("click", () => {
    saveCtx(JSON.parse(b.dataset.altPatch));
    try { sessionStorage.setItem("aureon.autorun", b.dataset.altMode); } catch {}
    if (location.hash.startsWith("#/test")) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else location.hash = "#/test";
  }));
}

export function renderResults(container, res) {
  const oos = res.kind === "walkforward";
  const m = oos ? res.oos_metrics || {} : res.metrics || {};
  const daily = oos ? (res.oos && res.oos.daily) || [] : res.daily || [];
  const trades = oos ? (res.oos && res.oos.trades) || [] : res.trades || [];
  const p = res.pair || {};
  if (oos && !(res.folds || []).length) {
    container.innerHTML = empty(`The realistic test couldn't run for ${p.a || "this pair"} vs ${p.b || ""}`,
      `${esc(res.message || "There wasn't enough shared history.")}`) + alternatives(res, oos);
    bindAlternatives(container);
    return;
  }
  const capital = (res.config && res.config.capital) || 0;
  const satOut = oos && (res.folds || []).every((f) => f.status !== "traded");
  container.innerHTML = `
    ${res.note ? `<div class="alert"><span class="dot"></span><div>${esc(res.note)}</div></div>` : ""}
    ${m.margin_exceeds_capital ? `<div class="alert warn"><span class="dot warn"></span><div><b>Not realistic for this account size.</b> At its largest the position needed about ${inrCompact(m.peak_margin)} of exchange margin, more than the ${inrCompact(capital)} account. Reduce the position size or raise the account size under advanced settings.</div></div>` : ""}
    ${verdictHtml(m, oos)}
    ${!trades.length ? alternatives(res, oos) : ""}
    ${satOut ? `<div class="alert"><span class="dot"></span><div><b>Why no trades?</b> In every period ${esc((res.folds || []).map((f) => f.reason).filter((x, i, a) => a.indexOf(x) === i).join(", or "))}, so the strategy stayed out.</div></div>` : ""}
    ${metricsRow(m)}
    <div class="stat-row">
      ${stat("From the price gap", `<span class="${cls(m.relative_pnl)}">${inrCompact(m.relative_pnl)}</span>`, "what the strategy aims for", "", "relative")}
      ${stat("From gold-price moves", `<span class="${cls(m.directional_pnl)}">${inrCompact(m.directional_pnl)}</span>`, "unmatched gold", "", "directional")}
      ${stat("Costs paid", inrCompact(m.costs), isNum(m.cost_share_of_gross) ? `${pct(m.cost_share_of_gross, 0)} of gross results` : "", "", "costhurdle")}
      ${stat("Time with a position", pct(m.time_in_market, 0), isNum(m.avg_holding_days) ? `avg. ${num(m.avg_holding_days, 1)} trading days per trade` : "")}
      ${stat("Margin needed (est.)", inrCompact(m.peak_margin), isNum(m.peak_margin) && capital ? `${pct(m.peak_margin / capital, 0)} of the ${inrCompact(capital)} account` : "", m.margin_exceeds_capital ? "neg" : "", "margin")}
    </div>
    <div class="panel">${panelHead("Account value over time", `${p.a || ""} vs ${p.b || ""} · ${oos ? "unseen test periods only, joined end to end" : "whole period"} · after all costs. The red area shows drops from the previous high.`, "", oos ? "oos" : "insample")}<div id="r-eq"></div><div id="r-dd"></div></div>
    <div class="grid g-2">
      <div class="panel">${panelHead("Where the profit came from", "Running totals: the price-gap effect (the idea), gold-price moves (side effect) and costs", legend([{ name: "Price gap", color: "var(--c-goldten)" }, { name: "Gold price", color: "var(--c-goldm)" }, { name: "Costs", color: "var(--neg)" }]))}<div id="r-attr"></div></div>
      <div class="panel">${panelHead("What if costs were higher?", "Net result with every cost scaled — 2× means double the assumed costs")}<div id="r-sens"></div></div>
    </div>
    <div class="grid g-2">
      <div class="panel">${panelHead("Result of each trade", "After costs, in the order trades closed")}<div id="r-tr"></div></div>
      <div class="panel">${panelHead("Why trades were closed")}<div id="r-exit"></div></div>
    </div>
    ${oos ? `<div class="panel flush"><div style="padding:20px 20px 0">${panelHead("How the realistic test was run", "For each period: settings were picked on older data, double-checked on the next stretch, then judged on a later period they had never seen. If the setting lost money in the double-check, the strategy sat that period out.", "", "walkforward")}</div><div id="r-folds"></div></div>` : ""}
    <details class="panel flush"><summary class="caption" style="cursor:pointer;padding:16px 20px">Every trade (${trades.length}) — dates, contracts and profit of each one</summary><div id="r-trades"></div></details>`;

  bindAlternatives(container);
  if (!daily.length || !trades.length) {
    container.querySelector("#r-eq").innerHTML = `<div class="table-empty">${trades.length ? "No daily results to chart." : "No trades were made, so the account value stayed flat."}</div>`;
    container.querySelector("#r-attr").innerHTML = `<div class="table-empty">Nothing to split — no trades were made.</div>`;
  } else {
    let peak = -Infinity;
    const eq = daily.map((d) => [ts(d.trade_date), d.equity]);
    const dd = daily.map((d) => { peak = Math.max(peak, d.equity); return [ts(d.trade_date), d.equity - peak]; });
    track(lineChart(container.querySelector("#r-eq"), { height: 240, syncKey: "perf", yFormat: inrCompact, series: [{ name: "Account value", kind: "area", color: "var(--c-goldm)", data: eq, format: inr }] }));
    track(lineChart(container.querySelector("#r-dd"), { height: 110, syncKey: "perf", yFormat: inrCompact, series: [{ name: "Drop from high", kind: "area", color: "var(--neg)", data: dd, format: inr }], areaBase: 0 }));
    let cr = 0, cd = 0, cc = 0;
    track(lineChart(container.querySelector("#r-attr"), { height: 240, syncKey: "perf", yFormat: inrCompact, series: [
      { name: "Price gap", color: "var(--c-goldten)", data: daily.map((d) => [ts(d.trade_date), (cr += d.relative)]), format: inr },
      { name: "Gold price", color: "var(--c-goldm)", data: daily.map((d) => [ts(d.trade_date), (cd += d.directional)]), format: inr },
      { name: "Costs", color: "var(--neg)", data: daily.map((d) => [ts(d.trade_date), -(cc += d.costs)]), format: inr }] }));
  }
  const sens = res.cost_sensitivity || [];
  if (sens.length) {
    track(lineChart(container.querySelector("#r-sens"), { height: 240, xType: "number", xLabel: "cost multiplier", xFormat: (v) => v.toFixed(1) + "×", yFormat: inrCompact, yZero: true, series: [
      { name: "Net result", color: "var(--c-goldm)", points: true, data: sens.map((s) => [s.multiplier, s.net_pnl]), format: inr },
      { name: "Before costs", color: "var(--muted)", dash: "4 3", data: sens.map((s) => [s.multiplier, s.gross_pnl]), format: inr }] }));
  } else container.querySelector("#r-sens").innerHTML = `<div class="table-empty">${oos ? "Cost scenarios are calculated by the quick test. Run one on the Test strategy page to see them." : "Not available."}</div>`;
  if (trades.length) {
    track(lineChart(container.querySelector("#r-tr"), { height: 240, yZero: true, yFormat: inrCompact, series: [{ name: "Net result", kind: "bars", color: (q) => (q[1] >= 0 ? "var(--pos)" : "var(--neg)"), data: trades.map((t) => [ts(t.exit_date), t.net]), format: inr }] }));
  } else container.querySelector("#r-tr").innerHTML = `<div class="table-empty">No trades.</div>`;
  const reasons = m.exit_reasons || {};
  container.querySelector("#r-exit").innerHTML = Object.keys(reasons).length ? table([{ label: "Reason", render: (r) => esc(exitText(r.k)) }, { label: "Trades", right: true, key: "n" }], Object.entries(reasons).map(([k, n]) => ({ k, n }))) : `<div class="table-empty">No trades were closed.</div>`;
  if (oos) {
    container.querySelector("#r-folds").innerHTML = table([
      { label: "Settings picked on", render: (f) => `${date(f.train[0])} → ${date(f.train[1])}` },
      { label: "Double-checked on", render: (f) => `${date(f.validation[0])} → ${date(f.validation[1])}` },
      { label: "Judged on (unseen)", render: (f) => `${date(f.test[0])} → ${date(f.test[1])}` },
      { label: "Settings chosen", render: (f) => (f.chosen ? `<span class="mono">${f.chosen.lookback}-day normal · ${f.chosen.entry_z}σ</span>` : "—") },
      { label: "Double-check result", right: true, render: (f) => inrCompact(f.validation_net) },
      { label: "Unseen result", right: true, render: (f) => `<span class="${cls(f.test_net)}">${inrCompact(f.test_net)}</span>` },
      { label: "Status", render: (f) => (f.status === "traded"
        ? `<span class="chip ok">Traded</span>${f.confirmed === false ? `<div class="caption" style="white-space:normal;max-width:240px">not double-checked — no signals in that stretch</div>` : ""}`
        : `<span class="chip warn">Sat out</span><div class="caption" style="white-space:normal;max-width:240px">${esc(f.reason || "")}</div>`) },
    ], res.folds || [], { emptyText: res.message || "No test periods." });
  }
  container.querySelector("#r-trades").innerHTML = table([
    { label: "Trade", render: (t) => `<span class="small">${t.direction === "long_spread" ? `Bought ${t.symbol_a}, sold ${t.symbol_b}` : `Sold ${t.symbol_a}, bought ${t.symbol_b}`}</span>` },
    { label: "Opened", render: (t) => date(t.entry_date) }, { label: "Closed", render: (t) => date(t.exit_date) },
    { label: "Contracts", render: (t) => `<span class="mono small">${t.lots_a}× ${t.symbol_a} ${expiry(t.expiry_a)} · ${t.lots_b}× ${t.symbol_b} ${expiry(t.expiry_b)}</span>` },
    { label: "Days", right: true, render: (t) => t.holding_days },
    { label: "Before costs", right: true, render: (t) => inr(t.gross) }, { label: "Costs", right: true, render: (t) => inr(t.costs) },
    { label: "Net", right: true, cls: (t) => cls(t.net), render: (t) => inr(t.net) },
    { label: "Why closed", render: (t) => `<span class="caption">${esc(exitText(t.exit_reason))}</span>` },
  ], trades.slice().reverse(), { maxHeight: 420, emptyText: "The strategy didn't trade in this period." });
}

export default async function results(root) {
  markVisited("results");
  root.innerHTML = `
    ${workflowBar("results")}
    ${pageHead("Step 4 · Review results", "Did the strategy work?",
      "Results from your most recent test: profit after costs, how bumpy the ride was, and where the profit came from. Aureon only calls a result promising when the evidence supports it.",
      `<div class="seg" id="kind"><button data-k="walkforward">Realistic test</button><button data-k="backtest">Quick test</button></div>`)}
    ${pageGuide("results", {
      what: "A verdict, the profit or loss after costs, the account value over time, and a split of profit into the <b>price-gap effect</b> (the idea being tested) and <b>gold-price moves</b> (a side effect of imperfect matching).",
      why: "A strategy can look profitable by luck, or only because of one lucky trade. Few trades, low confidence or profit from gold-price moves are warning signs.",
      next: "Try a different pair or sensitivity on <a href='#/test'>Test strategy</a>, or check the realistic test if you only ran a quick one.",
    })}
    <div id="out" class="stack"></div>`;
  const res = await api.latest();
  const out = root.querySelector("#out");
  const avail = { backtest: res.backtest, walkforward: res.walkforward };
  let kind = res.walkforward ? "walkforward" : "backtest";
  function draw() {
    root.querySelectorAll("#kind button").forEach((b) => b.classList.toggle("on", b.dataset.k === kind));
    const r = avail[kind];
    if (!r) {
      const none = !avail.backtest && !avail.walkforward;
      out.innerHTML = empty(none ? "No test has been run yet" : kind === "walkforward" ? "No realistic test has been run yet" : "No quick test has been run yet",
        "Results appear here after you run a test on the Test strategy page. They are kept until the Aureon server restarts.",
        `<a class="btn primary" href="#/test">Go to Test strategy</a>`);
      return;
    }
    renderResults(out, r);
  }
  root.querySelectorAll("#kind button").forEach((b) => b.addEventListener("click", () => { kind = b.dataset.k; draw(); }));
  draw();
}
