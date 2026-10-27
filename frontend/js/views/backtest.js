import { api } from "../api.js";
import { advanced, ctx, input, loading, markVisited, noDataState, numVal, pageHead, researchBody, saveCtx, select, toast, val, workflowBar } from "../components.js";
import { date, esc } from "../format.js";
import { info, pageGuide } from "../help.js";
import { renderResults } from "./performance.js";
import { bindSignalForm, readSignalForm, signalForm } from "./signals.js";

export default async function test(root) {
  markVisited("test");
  const wf = ctx.walkforward;
  root.innerHTML = `
    ${workflowBar("test")}
    ${pageHead("Step 3 · Test strategy", "Would it have worked in the past?",
      "Replay the opportunity rules day by day on past market data, as if you had followed them — buying and selling the actual contracts, one day after each signal, with realistic trading costs.")}
    ${pageGuide("test", {
      what: "A simulation of the strategy on historical prices. Each signal opens a trade the next day; it closes when the gap returns to normal, keeps widening, the contract nears expiry, or it has been held too long.",
      why: "Unusual gaps only matter if acting on them would have made money after costs. Testing on past data is the honest way to find out — and often the answer is no.",
      next: "Use the <b>realistic test</b> for a trustworthy answer. Then open <a href='#/results'>Review results</a> for the full breakdown.",
    })}
    <div class="grid g-side">
      <div class="panel" id="ctl">
        <div class="field"><label>Type of test</label>
          <div class="seg seg-fill" id="mode"><button type="button" data-m="walkforward" class="on">Realistic<small>recommended</small></button><button type="button" data-m="backtest">Quick<small>whole period</small></button></div>
          <span class="hint" id="mode-hint"></span></div>
        <div class="form-section" style="margin-top:16px">${signalForm("s")}</div>
        ${advanced(`
          <span class="overline">Trading assumptions</span>
          <div class="form-grid">
            ${select("b-exec", [["next_close", "Next day's closing price"], ["next_open", "Next day's opening price"]], ctx.execution, "Trade at")}
            ${input("b-cap", ctx.capital, "Account size (₹)", "Used for returns, drops and the margin check")}
          </div>
          <div class="single-only" style="display:none"><span class="overline">Quick test period</span><div class="form-grid" style="margin-top:8px">
            <div class="field"><label for="b-start">From</label><input class="input" type="date" id="b-start"/></div>
            <div class="field"><label for="b-end">To</label><input class="input" type="date" id="b-end"/></div></div></div>
          <div class="wf-only"><span class="overline">Realistic test periods (trading days) ${info("walkforward")}</span><div class="form-grid" style="margin-top:8px">
            ${input("w-tr", wf.train_days, "Pick settings on")}${input("w-va", wf.validation_days, "Double-check on")}${input("w-te", wf.test_days, "Judge on (unseen)")}${input("w-mt", wf.min_train_trades, "Min. trades to pick settings")}
            <div class="field" style="grid-column:span 2"><label for="w-lb">“Normal” windows to try (days)</label><input class="input" id="w-lb" value="${esc(wf.lookbacks.join(", "))}" type="text"/></div>
            <div class="field" style="grid-column:span 2"><label for="w-ez">Unusual thresholds to try (σ)</label><input class="input" id="w-ez" value="${esc(wf.entry_zs.join(", "))}" type="text"/></div>
          </div></div>`, "Advanced test settings")}
        <div class="row" style="margin-top:16px"><button class="btn primary" id="run">Run test</button><span class="caption" id="eta"></span></div>
      </div>
      <div class="stack" id="out"></div>
    </div>`;
  const ctl = root.querySelector("#ctl"), out = root.querySelector("#out");
  bindSignalForm(ctl, "s");  // the test only runs when the button is pressed
  let mode = "walkforward";
  const HINTS = {
    walkforward: "Settings are chosen on older data and judged only on later data they never saw — the honest answer. Takes up to a minute.",
    backtest: "Runs your exact settings over one period. Fast, but results usually look better than reality because nothing is held back.",
  };
  const setMode = (m) => {
    mode = m;
    ctl.querySelectorAll("#mode button").forEach((x) => x.classList.toggle("on", x.dataset.m === m));
    ctl.querySelector("#mode-hint").textContent = HINTS[m];
    ctl.querySelectorAll(".wf-only").forEach((e) => (e.style.display = m === "walkforward" ? "" : "none"));
    ctl.querySelectorAll(".single-only").forEach((e) => (e.style.display = m === "backtest" ? "" : "none"));
  };
  ctl.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.m)));
  setMode("walkforward");

  const st = await api.status();
  if (!st.has_data) { out.innerHTML = noDataState(); ctl.querySelector("#run").disabled = true; return; }
  ctl.querySelector("#b-start").value = st.first_date; ctl.querySelector("#b-end").value = st.last_date;
  let auto = null;
  try { auto = sessionStorage.getItem("aureon.autorun"); sessionStorage.removeItem("aureon.autorun"); } catch {}
  out.innerHTML = `<div class="empty"><h3>Ready when you are</h3><p>The pair and settings are carried over from the Compare and Opportunities pages. Data covers ${date(st.first_date)} to ${date(st.last_date)}. Press <b>Run test</b> to start.</p></div>`;

  ctl.querySelector("#run").addEventListener("click", async () => {
    readSignalForm(ctl, "s");
    root.querySelector(".flow").outerHTML = workflowBar("test");
    if (ctx.a === ctx.b) { toast("Pick two different contracts.", 3500, "err"); return; }
    const parseList = (s) => s.split(/[ ,]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
    const lbs = parseList(val(ctl, "w-lb")), ezs = parseList(val(ctl, "w-ez"));
    saveCtx({ execution: val(ctl, "b-exec"), capital: numVal(ctl, "b-cap") ?? 2000000,
      walkforward: { train_days: numVal(ctl, "w-tr") ?? 250, validation_days: numVal(ctl, "w-va") ?? 60, test_days: numVal(ctl, "w-te") ?? 60,
        min_train_trades: numVal(ctl, "w-mt") ?? 3, lookbacks: lbs.length ? lbs : [60], entry_zs: ezs.length ? ezs : [2] } });
    const btn = ctl.querySelector("#run");
    btn.disabled = true; btn.textContent = "Running…";
    out.innerHTML = loading(mode === "walkforward"
      ? `Running the realistic test — trying ${ctx.walkforward.lookbacks.length * ctx.walkforward.entry_zs.length} setting combinations per period. This can take up to a minute.`
      : "Running the quick test and the higher-cost scenarios…");
    try {
      const res = mode === "walkforward"
        ? await api.walkforward(researchBody({ walkforward: ctx.walkforward }))
        : await api.backtest(researchBody({ start: val(ctl, "b-start"), end: val(ctl, "b-end") }));
      toast((res.trades || (res.oos && res.oos.trades) || []).length ? "Test finished." : "Test finished — no trades this time.", 2500, "ok");
      out.innerHTML = `<div class="row between"><span class="caption">${mode === "walkforward" ? "Results on unseen data only" : "Quick test on the full period — likely to look better than reality"}</span><a class="btn small" href="#/results">Open full results →</a></div><div class="stack" id="res"></div>`;
      renderResults(out.querySelector("#res"), res);
    } catch (e) {
      out.innerHTML = `<div class="alert err" role="alert"><span class="dot err"></span><div><b>The test couldn't run.</b> ${esc(e.message)}</div></div>`;
    } finally { btn.disabled = false; btn.textContent = "Run test"; }
  });
  if (auto) { setMode(auto); ctl.querySelector("#run").click(); }
}
