import { api } from "../api.js";
import { lineChart } from "../charts.js";
import { advanced, bindSensitivity, CHECK_LABELS, ctx, FAIL_REASONS, failText, input, loading, markVisited, noDataState, numVal, pageHead, panelHead, researchBody, saveCtx, select, sensitivityControl, stat, track, val, workflowBar } from "../components.js";
import { bps, date, esc, expiry, inr, int, isNum, RESEARCH, ts } from "../format.js";
import { info, pageGuide } from "../help.js";

const WINDOWS = [[20, "1 month (20 days)"], [40, "2 months (40 days)"], [60, "3 months (60 days)"], [120, "6 months (120 days)"], [250, "1 year (250 days)"]];

/** Settings shared by Opportunities and Test strategy: essentials first, everything else folded away. */
export function signalForm(prefix = "s") {
  const s = ctx.signal;
  const winOpts = WINDOWS.some(([w]) => w === ctx.lookback) ? WINDOWS : [...WINDOWS, [ctx.lookback, `Custom (${ctx.lookback} days)`]];
  return `
    <div class="form-grid">${select(prefix + "-a", RESEARCH, ctx.a, "First contract")}${select(prefix + "-b", RESEARCH, ctx.b, "Second contract")}</div>
    <div style="margin-top:14px">${select(prefix + "-lb", winOpts, ctx.lookback, "What counts as “normal”?", "", "lookback")}</div>
    <div style="margin-top:14px">${sensitivityControl(prefix + "-sens", s.entry_z)}</div>
    ${advanced(`
      <span class="overline">When to get out</span>
      <div class="form-grid">
        ${input(prefix + "-ez", s.entry_z, "Unusual threshold (σ)", "Set by the buttons above", "number", "any", "zscore")}
        ${input(prefix + "-xz", s.exit_z, "Close when back within (σ)", "Difference considered normal again")}
        ${input(prefix + "-sz", s.stop_z, "Give up beyond (σ)", "Stop-loss if the gap keeps widening")}
        ${input(prefix + "-mh", s.max_holding_days, "Max. days to hold", "Trading days")}
      </div>
      <span class="overline">Expiry rules ${info("expiry")}</span>
      <div class="form-grid">
        ${input(prefix + "-med", s.min_entry_dte, "Don't start within (days)", "of either contract's expiry")}
        ${input(prefix + "-xd", s.exit_dte, "Close before expiry (trading days)", "Minimum 2")}
      </div>
      <span class="overline">Size and trading activity ${info("liquidity")}</span>
      <div class="form-grid">
        ${input(prefix + "-tg", s.target_fine_grams, "Position size (g of pure gold)", "Per side · 200 g ≈ 2 GOLDM lots")}
        ${input(prefix + "-mr", s.max_residual_pct, "Max. unmatched gold (%)", "", "number", "any", "residual")}
        ${input(prefix + "-mp", s.max_participation, "Max. share of day's volume", "0.05 = 5%")}
        ${input(prefix + "-oi", s.min_open_interest, "Min. open interest (lots)", "", "number", "any", "openinterest")}
      </div>
      <span class="overline">Costs ${info("costhurdle")}</span>
      <div class="form-grid">
        ${input(prefix + "-cm", s.cost_multiple, "Profit potential must beat costs ×", "1.5 = 50% safety margin")}
        ${input(prefix + "-sl", ctx.costs.slippage_ticks, "Slippage (ticks per trade)", "", "number", "any", "slippage")}
        ${input(prefix + "-br", ctx.costs.brokerage_per_order, "Brokerage (₹ per order)")}
        ${input(prefix + "-ex", +(ctx.costs.exchange_txn_rate * 1e5).toFixed(4), "Exchange fee (₹ per ₹1 lakh)")}
      </div>`)}`;
}

export function bindSignalForm(root, prefix = "s", onChange = null) {
  bindSensitivity(root, prefix + "-sens", (z) => { root.querySelector("#" + prefix + "-ez").value = z; if (onChange) onChange(); });
}

export function readSignalForm(root, prefix = "s") {
  const n = (id, d) => numVal(root, prefix + "-" + id) ?? d;
  const xd = Math.max(2, n("xd", 3));
  saveCtx({
    a: val(root, prefix + "-a"), b: val(root, prefix + "-b"), lookback: n("lb", ctx.lookback),
    signal: { entry_z: n("ez", 2), exit_z: n("xz", 0.5), stop_z: n("sz", 4), max_holding_days: n("mh", 30), min_entry_dte: n("med", 10), exit_dte: xd,
      target_fine_grams: n("tg", 1000), max_residual_pct: n("mr", 5), max_participation: n("mp", 0.05), min_open_interest: n("oi", 50), cost_multiple: n("cm", 1.5) },
    costs: { slippage_ticks: n("sl", 1), brokerage_per_order: n("br", 20), exchange_txn_rate: n("ex", 2.1) / 1e5 },
  });
  ctx.min_obs = Math.min(ctx.min_obs, ctx.lookback);
}

export function checksHtml(checks) {
  return `<div class="checks">${checks.map((c) => `<div class="check"><span class="mark ${c.passed ? "ok" : "no"}" aria-label="${c.passed ? "passed" : "failed"}">${c.passed ? "✓" : "✕"}</span><span class="name">${esc(CHECK_LABELS[c.check] || c.check)}</span><span class="det">${esc(c.detail)}</span></div>`).join("")}</div>`;
}

export default async function opportunities(root) {
  markVisited("opportunities");
  root.innerHTML = `
    ${workflowBar("opportunities")}
    ${pageHead("Step 2 · Find opportunities", "When was a price difference worth a closer look?",
      "Every trading day is checked against a set of practical rules. A day is flagged as a <b>signal</b> only if the difference was unusual <i>and</i> it would have been realistic to act on.")}
    ${pageGuide("opportunities", {
      what: "For each day: was the gap unusual, and did it pass the practical checks — enough trading activity, not too close to expiry, sizes that can be matched, and profit potential above costs.",
      why: "An unusual gap is only interesting if you could actually trade it. Most unusual days fail at least one check, and seeing <b>why</b> is as useful as the signals themselves.",
      next: "Signals are ideas, not advice. To see whether acting on them would have made money, go to <a href='#/test'>Test strategy</a>.",
    })}
    <div class="grid g-side"><div class="panel" id="ctl">${signalForm()}<p class="caption" style="margin:14px 0 0">Results update as soon as you change a setting.</p></div><div class="stack" id="out"></div></div>`;
  const ctl = root.querySelector("#ctl"), out = root.querySelector("#out");
  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  bindSignalForm(ctl, "s", schedule);
  ctl.addEventListener("change", schedule);
  async function run() {
    readSignalForm(ctl);
    root.querySelector(".flow").outerHTML = workflowBar("opportunities");
    if (ctx.a === ctx.b) { out.innerHTML = `<div class="alert warn"><span class="dot warn"></span><div>Pick two <b>different</b> contracts.</div></div>`; return; }
    out.innerHTML = loading("Checking every trading day…");
    const [res, status] = await Promise.all([api.signals(researchBody({ last_n: 2000 })), api.status()]);
    if (!status.has_data) { out.innerHTML = noDataState(); return; }
    const ev = res.evaluations;
    if (!ev.length) { out.innerHTML = `<div class="empty"><h3>Nothing to check</h3><p>${ctx.a} and ${ctx.b} have no days with comparable, actively traded contracts. Try another pair on the <a href="#/compare">Compare</a> page.</p></div>`; return; }
    const last = ev[ev.length - 1];
    const fired = ev.filter((e) => e.signal);
    const fails = Object.entries(res.rejection_counts).sort((a, b) => b[1] - a[1]);
    const unusualDays = ev.filter((e) => isNum(e.z) && Math.abs(e.z) >= ctx.signal.entry_z).length;
    out.innerHTML = `
      <div class="panel"><p class="summary-line">Of <b>${int(ev.length)}</b> trading days, <b>${int(unusualDays)}</b> had an unusual difference and <b>${int(fired.length)}</b> passed every practical check.${fails.length ? ` Most often, a day didn't qualify because <b>${esc(FAIL_REASONS[fails[0][0]] || fails[0][0])}</b>.` : ""}</p>
        ${fired.length ? `<p class="caption" style="margin-top:8px">Signals often repeat on several days in a row while a gap stays wide, so these ${int(fired.length)} signal days come from <b>${int(res.signal_episodes)}</b> separate situation${res.signal_episodes === 1 ? "" : "s"}. A strategy test holds one position at a time, so it will make at most about that many trades — often fewer, because a trade may still be open when the next situation starts.</p>` : ""}</div>
      <div class="stat-row">${stat("Days checked", int(ev.length))}${stat("Unusual days", int(unusualDays), `beyond ±${ctx.signal.entry_z}σ`, "", "zscore")}
        ${stat("Signal days", int(fired.length), `${int(res.signal_episodes)} separate situations`, "", "signal")}
        ${stat("Position size", `${last.lots_a} × ${ctx.a}`, `vs ${last.lots_b} × ${ctx.b}`, "", "lot")}${stat("Est. round-trip cost", inr(last.round_trip_cost), "both sides, in and out", "", "costhurdle")}</div>
      <div class="panel">${panelHead(`Latest day · ${date(last.trade_date)}`, last.signal ? "This day qualified as a signal." : "This day did not qualify. Each check is listed with the numbers behind it.", last.signal ? `<span class="chip warn">Signal</span>` : `<span class="chip">No signal</span>`)}${checksHtml(last.checks)}</div>
      <div class="panel">${panelHead("Signals on the timeline", `How unusual each day was. ▲ = buy ${ctx.a} / sell ${ctx.b} (gap below normal); ▼ = the reverse (gap above normal).`, "", "zscore")}<div id="c-z"></div></div>
      <div class="grid g-2">
        <div class="panel">${panelHead("Why days didn't qualify", "How many days each check failed (a day can fail several)")}<div id="fails"></div></div>
        <div class="panel">${panelHead("Profit potential vs costs", "Estimated gain if the gap returned to normal, against the cost hurdle", "", "costhurdle")}<div id="c-edge"></div></div>
      </div>
      <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("Day-by-day decisions", "Most recent first. Click a day to see every check.", `<div class="seg" id="flt"><button data-f="all" class="on">All days</button><button data-f="sig">Signals only</button></div>`)}</div><div id="log" class="list" style="max-height:520px;overflow:auto"></div></div>
      <div class="panel row between"><div><h3>Next: would acting on these signals have made money?</h3><div class="caption">Test the same settings on past data, including costs and realistic timing.</div></div><a class="btn primary" href="#/test">Test strategy →</a></div>`;

    const max = Math.max(1, ...fails.map((f) => f[1]));
    out.querySelector("#fails").innerHTML = fails.length ? fails.map(([k, n]) => `<div style="margin-bottom:12px"><div class="row between small"><span>${esc(CHECK_LABELS[k] || k)}</span><span class="mono muted">${int(n)} days</span></div><div style="height:6px;background:var(--surface-3);border-radius:3px;margin-top:4px"><div style="height:6px;width:${(100 * n) / max}%;background:var(--c-goldm);border-radius:3px"></div></div></div>`).join("") : `<div class="caption">Every day passed every check.</div>`;
    const ez = ctx.signal.entry_z;
    track(lineChart(out.querySelector("#c-z"), { height: 260, syncKey: "sig", yFormat: (v) => v.toFixed(1), hlines: [{ y: ez, label: `unusual +${ez}` }, { y: -ez, label: `unusual −${ez}` }],
      markers: fired.map((e) => ({ x: ts(e.trade_date), y: e.z, shape: e.signal === "long_spread" ? "up" : "down", color: e.signal === "long_spread" ? "var(--pos)" : "var(--neg)" })),
      series: [{ name: "How unusual", color: "var(--c-goldten)", data: ev.map((e) => [ts(e.trade_date), e.z]), format: (v) => v.toFixed(2) + "σ" }] }));
    track(lineChart(out.querySelector("#c-edge"), { height: 220, syncKey: "sig", yFormat: (v) => inr(v), series: [
      { name: "Profit potential", color: "var(--c-goldm)", data: ev.map((e) => [ts(e.trade_date), e.expected_edge]), format: (v) => inr(v) },
      { name: "Cost hurdle", color: "var(--neg)", dash: "4 3", data: ev.map((e) => [ts(e.trade_date), e.round_trip_cost * ctx.signal.cost_multiple]), format: (v) => inr(v) }] }));

    let mode = "all";
    const logEl = out.querySelector("#log");
    function drawLog() {
      const rows = (mode === "sig" ? fired : ev).slice().reverse().slice(0, 400);
      logEl.innerHTML = rows.map((e, i) => `<div class="list-row" data-i="${i}" tabindex="0" role="button" aria-expanded="false" style="cursor:pointer;flex-direction:column;align-items:stretch">
        <div class="row between"><span class="small"><b>${date(e.trade_date)}</b> <span class="caption mono">· ${isNum(e.z) ? (e.z >= 0 ? "+" : "−") + Math.abs(e.z).toFixed(2) + "σ" : "—"} · ${bps(e.spread_bps)} · ${expiry(e.expiry_a)}/${expiry(e.expiry_b)}</span></span>${e.signal ? `<span class="chip warn">Signal</span>` : `<span class="chip">No signal</span>`}</div>
        <div class="caption">${e.signal ? esc(e.summary) : "Didn't qualify: " + esc(failText(e.checks).join("; "))}</div><div class="detail" style="display:none;margin-top:10px">${checksHtml(e.checks)}</div></div>`).join("") || `<div class="table-empty">No signals with these settings. Try the “Relaxed” setting, a different pair, or a shorter history window.</div>`;
      logEl.querySelectorAll(".list-row").forEach((r) => {
        const t = () => { const d = r.querySelector(".detail"); const open = d.style.display === "none"; d.style.display = open ? "block" : "none"; r.setAttribute("aria-expanded", open); };
        r.addEventListener("click", t);
        r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t(); } });
      });
    }
    out.querySelectorAll("#flt button").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.f; out.querySelectorAll("#flt button").forEach((x) => x.classList.toggle("on", x === b)); drawLog(); }));
    drawLog();
  }
  await run();
}
