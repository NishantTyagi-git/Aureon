import { api } from "../api.js";
import { ctx, input, noDataState, numVal, researchBody, saveCtx, select, toast, val } from "../components.js";
import { esc } from "../format.js";
import { renderResults } from "./performance.js";
import { readSignalForm, signalForm } from "./signals.js";

export default async function backtest(root) {
  const wf = ctx.walkforward;
  root.innerHTML = `<div class="page-head"><div><span class="overline">Backtesting workspace</span><h1>Backtest & walk-forward</h1>
    <p>Signals at day <i>t</i>'s close execute at day <i>t+1</i> in the specific contracts chosen on <i>t</i>, with slippage, statutory charges and integer lot sizes. Positions close before expiry and are never rolled silently. Walk-forward chooses parameters on train, confirms them on validation, and reports only unseen test windows.</p></div></div>
    <div class="grid g-side">
      <div class="panel" id="ctl">
        <div class="form-section"><span class="overline">Mode</span><div class="seg" id="mode" style="margin-top:8px;display:flex"><button data-m="walkforward" class="on" style="flex:1">Walk-forward</button><button data-m="backtest" style="flex:1">Single window</button></div></div>
        <div class="form-section"><span class="overline">Execution</span><div class="form-grid" style="margin-top:8px">
          ${select("b-exec", [["next_close", "Next-day close"], ["next_open", "Next-day open"]], ctx.execution, "Fill price")}${input("b-cap", ctx.capital, "Capital (₹)")}
          <div class="single-only field" style="display:none"><label>Start</label><input class="input" type="date" id="b-start"/></div>
          <div class="single-only field" style="display:none"><label>End</label><input class="input" type="date" id="b-end"/></div>
        </div></div>
        <div class="form-section wf-only"><span class="overline">Walk-forward windows (pair observations)</span><div class="form-grid" style="margin-top:8px">
          ${input("w-tr", wf.train_days, "Train")}${input("w-va", wf.validation_days, "Validation")}${input("w-te", wf.test_days, "Test")}${input("w-mt", wf.min_train_trades, "Min train trades")}
          <div class="field" style="grid-column:span 2"><label>Lookback grid</label><input class="input" id="w-lb" value="${esc(wf.lookbacks.join(", "))}" type="text"/></div>
          <div class="field" style="grid-column:span 2"><label>Entry-z grid</label><input class="input" id="w-ez" value="${esc(wf.entry_zs.join(", "))}" type="text"/></div>
        </div></div>
        ${signalForm("s")}
        <div class="form-section row"><button class="btn primary" id="run">Run</button><span class="caption" id="hint"></span></div>
      </div>
      <div class="stack" id="out"><div class="empty"><h3>Configure and run</h3><p>The pair and thresholds are shared with the Relative Value and Signals views. Results stay available on the Performance & risk page.</p></div></div>
    </div>`;
  const ctl = root.querySelector("#ctl"), out = root.querySelector("#out");
  let mode = "walkforward";
  ctl.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.m;
    ctl.querySelectorAll("#mode button").forEach((x) => x.classList.toggle("on", x === b));
    ctl.querySelectorAll(".wf-only").forEach((e) => (e.style.display = mode === "walkforward" ? "" : "none"));
    ctl.querySelectorAll(".single-only").forEach((e) => (e.style.display = mode === "backtest" ? "" : "none"));
  }));
  const st = await api.status();
  if (!st.has_data) { out.innerHTML = noDataState(); return; }
  ctl.querySelector("#b-start").value = st.first_date; ctl.querySelector("#b-end").value = st.last_date;

  ctl.querySelector("#run").addEventListener("click", async () => {
    readSignalForm(ctl, "s");
    if (ctx.a === ctx.b) { toast("Choose two different contracts."); return; }
    const parseList = (s) => s.split(/[ ,]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
    saveCtx({ execution: val(ctl, "b-exec"), capital: numVal(ctl, "b-cap") ?? 2000000,
      walkforward: { train_days: numVal(ctl, "w-tr") ?? 250, validation_days: numVal(ctl, "w-va") ?? 60, test_days: numVal(ctl, "w-te") ?? 60,
        min_train_trades: numVal(ctl, "w-mt") ?? 3, lookbacks: parseList(val(ctl, "w-lb")), entry_zs: parseList(val(ctl, "w-ez")) } });
    const btn = ctl.querySelector("#run");
    btn.disabled = true;
    out.innerHTML = `<div class="panel"><div class="loading"><span class="spinner"></span>${mode === "walkforward" ? `Running walk-forward (${ctx.walkforward.lookbacks.length * ctx.walkforward.entry_zs.length} parameter sets per fold)…` : "Running backtest and cost-sensitivity sweep…"}</div></div>`;
    try {
      const res = mode === "walkforward"
        ? await api.walkforward(researchBody({ walkforward: ctx.walkforward }))
        : await api.backtest(researchBody({ start: val(ctl, "b-start"), end: val(ctl, "b-end") }));
      if (mode === "walkforward" && !(res.folds || []).length) {
        out.innerHTML = `<div class="empty"><h3>Not enough history for walk-forward</h3><p>${esc(res.message || "")} Reduce the window sizes or load more data.</p></div>`;
      } else {
        out.innerHTML = `<div class="row between"><span class="caption">${mode === "walkforward" ? "Out-of-sample results" : "In-sample, single-window results — not evidence of out-of-sample performance"}</span><a class="btn small" href="#/performance">Open in Performance & risk →</a></div><div class="stack" id="res"></div>`;
        renderResults(out.querySelector("#res"), res);
      }
    } catch (e) {
      out.innerHTML = `<div class="alert err"><span class="dot err"></span><div><b>Run failed.</b> ${esc(e.message)}</div></div>`;
    } finally { btn.disabled = false; }
  });
}
