// Shared UI building blocks and cross-view research state.
import { esc, isNum } from "./format.js";

// ---------------------------------------------------------------- shared research context
// One pair / lookback / threshold selection flows through Relative Value → Signals → Backtest.
const DEFAULT_CTX = {
  a: "GOLDM", b: "GOLDTEN", lookback: 60, min_dte: 5, max_gap: 10, carry: true, min_obs: 30,
  signal: { entry_z: 2.0, exit_z: 0.5, stop_z: 4.0, min_entry_dte: 10, exit_dte: 3, max_holding_days: 30,
    max_participation: 0.05, min_open_interest: 50, min_segment_obs: 3, cost_multiple: 1.5, max_residual_pct: 5,
    target_fine_grams: 1000 },
  costs: { brokerage_per_order: 20, exchange_txn_rate: 0.000021, ctt_sell_rate: 0.0001, stamp_buy_rate: 0.00002,
    sebi_fee_rate: 0.000001, gst_rate: 0.18, slippage_ticks: 1 },
  execution: "next_close", capital: 2000000,
  walkforward: { train_days: 250, validation_days: 60, test_days: 60, lookbacks: [20, 40, 60, 120], entry_zs: [1.5, 2.0, 2.5, 3.0], min_train_trades: 3 },
};

function load() {
  try { const s = JSON.parse(localStorage.getItem("aureon.ctx") || "null"); if (s) return deepMerge(structuredClone(DEFAULT_CTX), s); } catch {}
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
export function resetCtx() { Object.assign(ctx, structuredClone(DEFAULT_CTX)); saveCtx(); }
export function pairParams() {
  return { a: ctx.a, b: ctx.b, lookback: ctx.lookback, min_dte: ctx.min_dte, max_gap: ctx.max_gap, carry: ctx.carry, min_obs: Math.min(ctx.min_obs, ctx.lookback) };
}
export function researchBody(extra = {}) {
  return { pair: { a: ctx.a, b: ctx.b, lookback: ctx.lookback, min_dte: ctx.min_dte, max_expiry_gap: ctx.max_gap, carry_adjust: ctx.carry, min_obs: Math.min(ctx.min_obs, ctx.lookback) },
    signal: ctx.signal, costs: ctx.costs, execution: ctx.execution, capital: ctx.capital, ...extra };
}

// ---------------------------------------------------------------- chart lifecycle
const live = [];
export function track(chart) { live.push(chart); return chart; }
export function cleanup() { while (live.length) { try { live.pop().destroy(); } catch {} } }

// ---------------------------------------------------------------- html helpers
export const h = (strings, ...vals) => strings.reduce((s, str, i) => s + str + (i < vals.length ? (vals[i] ?? "") : ""), "");

export function stat(label, value, sub = "", klass = "") {
  return `<div class="stat"><span class="overline">${esc(label)}</span><span class="value ${klass}">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
}

export function empty(title, text, actionHtml = "") {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${text}</p>${actionHtml}</div>`;
}

export function noDataState() {
  return empty("No market data yet",
    "Aureon only shows results computed from real, validated MCX bhavcopy data. Import data on the Data page — via the TinyFish collector, the in-browser MCX collector, or an MCX CSV/JSON export.",
    `<a class="btn primary" href="#/data">Go to Data sources</a>`);
}

export function loading(text = "Computing…") { return `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`; }
export function errorBox(e) { return `<div class="alert err"><span class="dot err"></span><div><b>Request failed.</b> ${esc(e.message || e)}</div></div>`; }

export function warnings(list = [], limit = 6) {
  if (!list.length) return "";
  const lv = { error: "err", warn: "warn", info: "" };
  return `<div class="alerts">${list.slice(0, limit).map((w) => `<div class="alert ${lv[w.level] || ""}"><span class="dot ${lv[w.level] === "err" ? "err" : lv[w.level] === "warn" ? "warn" : ""}"></span><div>${esc(w.message)}</div></div>`).join("")}${list.length > limit ? `<a class="caption" href="#/quality">+${list.length - limit} more in Data quality →</a>` : ""}</div>`;
}

export function table(cols, rows, opts = {}) {
  if (!rows || !rows.length) return `<div class="loading">${esc(opts.emptyText || "No rows.")}</div>`;
  const head = cols.map((c, i) => `<th class="${c.right ? "r" : ""} ${opts.sortable ? "sortable" : ""}" data-i="${i}">${esc(c.label)}</th>`).join("");
  const body = rows.map((r, ri) => `<tr class="${opts.onClick ? "clickable" : ""} ${opts.rowClass ? opts.rowClass(r) : ""}" data-ri="${ri}">${cols.map((c) => {
    const v = c.render ? c.render(r) : esc(r[c.key]);
    return `<td class="${c.right ? "r" : ""} ${c.cls ? (typeof c.cls === "function" ? c.cls(r) : c.cls) : ""}">${v}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="table-wrap" style="${opts.maxHeight ? `max-height:${opts.maxHeight}px` : ""}"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function bindTable(root, rows, onClick) {
  root.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => onClick(rows[+tr.dataset.ri], tr)));
}

export function select(id, options, value, label, hint = "") {
  return `<div class="field"><label for="${id}">${esc(label)}</label><select class="input" id="${id}">${options.map((o) => {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(t)}</option>`;
  }).join("")}</select>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</div>`;
}
export function input(id, value, label, hint = "", type = "number", step = "any") {
  return `<div class="field"><label for="${id}">${esc(label)}</label><input class="input" id="${id}" type="${type}" step="${step}" value="${esc(value)}" />${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</div>`;
}
export function toggle(id, checked, label) {
  return `<label class="toggle"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}/>${esc(label)}</label>`;
}
export const val = (root, id) => root.querySelector("#" + id)?.value;
export const numVal = (root, id) => { const v = parseFloat(val(root, id)); return isNum(v) ? v : undefined; };
export const checked = (root, id) => !!root.querySelector("#" + id)?.checked;

export function toast(msg, ms = 3500) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function zChip(z) {
  if (!isNum(z)) return `<span class="chip">n/a</span>`;
  const a = Math.abs(z);
  const k = a >= 2 ? "warn" : "";
  return `<span class="chip ${k} sq mono">${z >= 0 ? "+" : "−"}${a.toFixed(2)}σ</span>`;
}
