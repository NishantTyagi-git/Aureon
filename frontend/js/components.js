// Shared UI building blocks and cross-view research state.
import { esc, isNum } from "./format.js";
import { info } from "./help.js";

// ---------------------------------------------------------------- shared research context
// One pair / window / threshold selection flows through Compare → Opportunities → Test strategy.
const DEFAULT_CTX = {
  a: "GOLDM", b: "GOLDGUINEA", lookback: 60, min_dte: 10, max_gap: 10, carry: true, min_obs: 30,
  signal: { entry_z: 2.0, exit_z: 0.5, stop_z: 4.0, min_entry_dte: 10, exit_dte: 3, max_holding_days: 30,
    max_participation: 0.05, min_open_interest: 50, min_segment_obs: 3, cost_multiple: 1.5, max_residual_pct: 5,
    target_fine_grams: 200 },
  costs: { brokerage_per_order: 20, exchange_txn_rate: 0.000021, ctt_sell_rate: 0.0001, stamp_buy_rate: 0.00002,
    sebi_fee_rate: 0.000001, gst_rate: 0.18, slippage_ticks: 1 },
  execution: "next_close", capital: 1000000, version: 3,
  walkforward: { train_days: 250, validation_days: 60, test_days: 60, lookbacks: [20, 40, 60, 120], entry_zs: [1.5, 2.0, 2.5, 3.0], min_train_trades: 3 },
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem("aureon.ctx") || "null");
    if (s) {
      // v2 switched to realistic default sizing; older saved settings keep everything else.
      if ((s.version || 1) < 2) { delete s.capital; if (s.signal) delete s.signal.target_fine_grams; }
      // v3 compares contracts only while they are still tradable (≥10 days to expiry).
      if ((s.version || 1) < 3) { if ((s.min_dte || 0) < 10) delete s.min_dte; s.version = 3; }
      return deepMerge(structuredClone(DEFAULT_CTX), s);
    }
  } catch {}
  return structuredClone(DEFAULT_CTX);
}
function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b || {})) a[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v;
  return a;
}
export const ctx = load();
export function saveCtx(patch) {
  if (patch) deepMerge(ctx, patch);
  try { localStorage.setItem("aureon.ctx", JSON.stringify(ctx)); } catch {}
}
export function resetCtx() {
  for (const k of Object.keys(ctx)) delete ctx[k];
  Object.assign(ctx, structuredClone(DEFAULT_CTX));
  saveCtx();
}
export function pairParams() {
  return { a: ctx.a, b: ctx.b, lookback: ctx.lookback, min_dte: ctx.min_dte, max_gap: ctx.max_gap, carry: ctx.carry, min_obs: Math.min(ctx.min_obs, ctx.lookback) };
}
export function researchBody(extra = {}) {
  return { pair: { a: ctx.a, b: ctx.b, lookback: ctx.lookback, min_dte: ctx.min_dte, max_expiry_gap: ctx.max_gap, carry_adjust: ctx.carry, min_obs: Math.min(ctx.min_obs, ctx.lookback) },
    signal: ctx.signal, costs: ctx.costs, execution: ctx.execution, capital: ctx.capital, ...extra };
}
export function markVisited(step) {
  try { const v = JSON.parse(localStorage.getItem("aureon.visited") || "{}"); v[step] = true; localStorage.setItem("aureon.visited", JSON.stringify(v)); } catch {}
}
export function visited() {
  try { return JSON.parse(localStorage.getItem("aureon.visited") || "{}"); } catch { return {}; }
}

// ---------------------------------------------------------------- sensitivity presets (beginner-friendly entry threshold)
export const SENSITIVITY = [
  { z: 2.5, label: "Strict", hint: "Only very unusual differences (fewer, rarer ideas)" },
  { z: 2.0, label: "Balanced", hint: "Unusual differences — about 1 day in 20 under normal conditions" },
  { z: 1.5, label: "Relaxed", hint: "Moderately unusual differences (more ideas, more noise)" },
];
export function sensitivityControl(id, z) {
  const known = SENSITIVITY.some((s) => s.z === z);
  return `<div class="field"><label>How unusual must a difference be? ${info("zscore")}</label>
    <div class="seg seg-fill" id="${id}">${SENSITIVITY.map((s) => `<button type="button" data-z="${s.z}" class="${s.z === z ? "on" : ""}" title="${esc(s.hint)}">${s.label}<small>${s.z}σ</small></button>`).join("")}</div>
    <span class="hint" id="${id}-hint">${known ? esc(SENSITIVITY.find((s) => s.z === z).hint) : `Custom threshold ${z}σ (set under advanced settings)`}</span></div>`;
}
export function bindSensitivity(root, id, onChange) {
  root.querySelectorAll(`#${id} button`).forEach((b) => b.addEventListener("click", () => {
    root.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b));
    const s = SENSITIVITY.find((x) => x.z === +b.dataset.z);
    root.querySelector(`#${id}-hint`).textContent = s.hint;
    onChange(+b.dataset.z);
  }));
}

// ---------------------------------------------------------------- chart lifecycle
const live = [];
export function track(chart) { live.push(chart); return chart; }
export function cleanup() { while (live.length) { try { live.pop().destroy(); } catch {} } }

// ---------------------------------------------------------------- layout helpers
export function pageHead(overline, title, text, actions = "") {
  return `<div class="page-head"><div><span class="overline">${esc(overline)}</span><h1>${esc(title)}</h1>${text ? `<p>${text}</p>` : ""}</div>${actions ? `<div class="row">${actions}</div>` : ""}</div>`;
}

const FLOW = [
  { key: "compare", label: "Compare", href: "#/compare" },
  { key: "opportunities", label: "Find opportunities", href: "#/opportunities" },
  { key: "test", label: "Test strategy", href: "#/test" },
  { key: "results", label: "Review results", href: "#/results" },
];
/** Shows where this page sits in the research workflow and which pair is selected. */
export function workflowBar(current) {
  const i = FLOW.findIndex((f) => f.key === current);
  const next = FLOW[i + 1];
  return `<div class="flow" role="navigation" aria-label="Research steps">
    <ol>${FLOW.map((f, k) => `<li class="${k < i ? "done" : k === i ? "now" : ""}"><a href="${f.href}"><span class="n">${k + 1}</span>${f.label}</a></li>`).join("")}</ol>
    <div class="flow-pair"><span class="caption">Pair</span><span class="mono">${ctx.a}</span><span class="caption">vs</span><span class="mono">${ctx.b}</span>
    ${next ? `<a class="btn small" href="${next.href}">Next: ${next.label} →</a>` : ""}</div></div>`;
}

export function panelHead(title, caption = "", right = "", helpKey = "") {
  return `<div class="panel-head"><div><h3>${esc(title)}${helpKey ? info(helpKey) : ""}</h3>${caption ? `<div class="caption">${caption}</div>` : ""}</div>${right}</div>`;
}

export function advanced(inner, label = "Advanced settings") {
  return `<details class="advanced"><summary>${esc(label)}</summary><div class="advanced-body">${inner}</div></details>`;
}

// ---------------------------------------------------------------- html helpers
export const h = (strings, ...vals) => strings.reduce((s, str, i) => s + str + (i < vals.length ? (vals[i] ?? "") : ""), "");

export function stat(label, value, sub = "", klass = "", helpKey = "") {
  return `<div class="stat"><span class="overline">${esc(label)}${helpKey ? info(helpKey) : ""}</span><span class="value ${klass}">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
}

export function empty(title, text, actionHtml = "") {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${text}</p>${actionHtml ? `<div class="row" style="justify-content:center">${actionHtml}</div>` : ""}</div>`;
}

export function noDataState() {
  return empty("No market data loaded yet",
    "Aureon only works with real MCX prices — it never fills screens with made-up numbers. Load the daily price files (bhavcopy) on the Data sources page; it takes a few minutes, and every page will then come to life.",
    `<a class="btn primary" href="#/data/sources">Load market data</a><a class="btn ghost" href="#/home">What does Aureon do?</a>`);
}

export function loading(text = "Calculating…") { return `<div class="panel"><div class="loading" role="status"><span class="spinner"></span>${esc(text)}</div></div>`; }
export function errorBox(e, retry = false) {
  return `<div class="alert err" role="alert"><span class="dot err"></span><div><b>Something went wrong.</b> ${esc(e.message || e)}
    <div class="caption" style="margin-top:4px">If this keeps happening, check that the Aureon server is still running.</div>
    ${retry ? `<button class="btn small" data-retry style="margin-top:8px">Try again</button>` : ""}</div></div>`;
}

export function warnings(list = [], limit = 6) {
  if (!list.length) return "";
  const lv = { error: "err", warn: "warn", info: "" };
  return `<div class="alerts">${list.slice(0, limit).map((w) => `<div class="alert ${lv[w.level] || ""}"><span class="dot ${lv[w.level] === "err" ? "err" : lv[w.level] === "warn" ? "warn" : ""}"></span><div>${esc(w.message)}</div></div>`).join("")}${list.length > limit ? `<a class="caption" href="#/data/health">+${list.length - limit} more on the Data health page →</a>` : ""}</div>`;
}

export function table(cols, rows, opts = {}) {
  if (!rows || !rows.length) return `<div class="table-empty">${esc(opts.emptyText || "Nothing to show.")}</div>`;
  const head = cols.map((c) => `<th class="${c.right ? "r" : ""}" scope="col">${c.help ? `<span class="term">${esc(c.label)}${info(c.help)}</span>` : esc(c.label)}</th>`).join("");
  const body = rows.map((r, ri) => `<tr class="${opts.onClick ? "clickable" : ""} ${opts.rowClass ? opts.rowClass(r) : ""}" data-ri="${ri}" ${opts.onClick ? 'tabindex="0"' : ""}>${cols.map((c) => {
    const v = c.render ? c.render(r) : esc(r[c.key]);
    return `<td class="${c.right ? "r" : ""} ${c.cls ? (typeof c.cls === "function" ? c.cls(r) : c.cls) : ""}">${v}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="table-wrap" style="${opts.maxHeight ? `max-height:${opts.maxHeight}px` : ""}"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function bindTable(root, rows, onClick) {
  root.querySelectorAll("tbody tr").forEach((tr) => {
    const fire = () => onClick(rows[+tr.dataset.ri], tr);
    tr.addEventListener("click", fire);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); } });
  });
}

export function select(id, options, value, label, hint = "", helpKey = "") {
  return `<div class="field"><label for="${id}">${esc(label)}${helpKey ? info(helpKey) : ""}</label><select class="input" id="${id}">${options.map((o) => {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(t)}</option>`;
  }).join("")}</select>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</div>`;
}
export function input(id, value, label, hint = "", type = "number", step = "any", helpKey = "") {
  return `<div class="field"><label for="${id}">${esc(label)}${helpKey ? info(helpKey) : ""}</label><input class="input" id="${id}" type="${type}" step="${step}" value="${esc(value)}" />${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</div>`;
}
export function toggle(id, checked, label, helpKey = "") {
  return `<label class="toggle"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}/>${esc(label)}${helpKey ? info(helpKey) : ""}</label>`;
}
export const val = (root, id) => root.querySelector("#" + id)?.value;
export const numVal = (root, id) => { const v = parseFloat(val(root, id)); return isNum(v) ? v : undefined; };
export const checked = (root, id) => !!root.querySelector("#" + id)?.checked;

export function toast(msg, ms = 3500, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function zChip(z) {
  if (!isNum(z)) return `<span class="chip" title="Not enough history yet">n/a</span>`;
  const a = Math.abs(z);
  const k = a >= 2 ? "warn" : "";
  return `<span class="chip ${k} sq mono" title="${a >= 2 ? "Unusual" : "Within the normal range"}">${z >= 0 ? "+" : "−"}${a.toFixed(2)}σ</span>`;
}

/** Plain-English description of a z-score. */
export function zWords(z) {
  if (!isNum(z)) return "not enough history to judge";
  const a = Math.abs(z);
  const side = z > 0 ? "above" : "below";
  if (a < 1) return `close to normal (${side} average)`;
  if (a < 2) return `somewhat ${side} normal, within the usual range`;
  if (a < 3) return `unusually far ${side} normal`;
  return `extremely far ${side} normal`;
}

/** How to say a failed check in a sentence ("didn't qualify because …"). */
export const FAIL_REASONS = {
  history: "there wasn't enough history yet", z_threshold: "the difference wasn't unusual enough",
  expiry: "a contract was too close to expiry", roll_settled: "a contract had only just switched",
  liquidity: "there wasn't enough trading activity", hedge_residual: "the sizes couldn't be matched closely enough",
  cost_hurdle: "the profit potential didn't beat costs", data_quality: "a data problem was flagged",
};
export const failText = (checks) => checks.filter((c) => !c.passed).map((c) => FAIL_REASONS[c.check] || c.check);

export const CHECK_LABELS = {
  history: "Enough history", z_threshold: "Difference is unusual", expiry: "Not too close to expiry",
  roll_settled: "Contract switch settled", liquidity: "Enough trading activity", hedge_residual: "Sizes can be matched",
  cost_hurdle: "Profit potential beats costs", data_quality: "Data looks clean",
};
