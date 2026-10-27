import { api } from "../api.js";
import { bindTable, noDataState, pageHead, panelHead, stat, table, warnings } from "../components.js";
import { pageGuide } from "../help.js";
import { date, esc, expiry, int, isNum, num, pct, SYMBOL_COLORS } from "../format.js";

export default async function quality(root) {
  root.innerHTML = `${pageHead("Data", "Data health",
      "Can these numbers be trusted? Aureon checks every price it loads and reports anything odd here. Checks only report — they never change or invent data.")}
    ${pageGuide("health", {
      what: "Which dates and contracts are covered, which rows were rejected and why, prices that jumped suspiciously, and every contract's life from listing to expiry.",
      why: "Gaps, bad rows or stale prices can create fake price differences. Knowing where the data is weak tells you which results to treat with caution.",
      next: "If something is missing, load more data on <a href='#/data/sources'>Data sources</a>. Otherwise, head to <a href='#/compare'>Compare</a>.",
    })}
    <div id="out" class="stack"></div>`;
  const out = root.querySelector("#out");
  const q = await api.quality();
  if (q.empty) {
    out.innerHTML = warnings(q.warnings) + noDataState() + (Object.keys(q.rejections || {}).length ? `<div class="panel"><h3>Rejected rows</h3>${rejTable(q.rejections)}</div>` : "");
    return;
  }
  const syms = q.coverage_by_symbol;
  const serious = q.warnings.filter((w) => w.level === "error").length, notes = q.warnings.filter((w) => w.level === "warn").length;
  out.innerHTML = `
    <div class="verdict ${serious ? "err" : notes ? "warn" : "ok"}"><span class="overline">Overall</span>
      <div class="label">${serious ? "Problems found — results may be unreliable" : notes ? "Usable, with notes to keep in mind" : "Healthy"}</div>
      <div class="small muted">${serious ? `${serious} serious issue(s) below need attention.` : notes ? `All prices passed validation. ${notes} item(s) below are worth knowing about when you read results.` : "All prices passed validation and nothing unusual was found."}</div></div>
    <div class="stat-row">${stat("Coverage", `${date(q.first_date)} → ${date(q.latest_date)}`, `${int(q.trading_days)} exchange days`)}${stat("Up to date?", q.business_days_behind > 2 ? `${q.business_days_behind} days behind` : "Yes", q.business_days_behind ? `${q.business_days_behind} business day(s) since last data` : "latest data is current")}
      ${stat("Rows rejected", int(Object.values(q.rejections).reduce((a, b) => a + b, 0)), "kept aside, never used")}${stat("Duplicates", int(q.duplicates.total), `${q.duplicates.conflicting} disagreed`)}
      ${stat("Suspicious jumps", int(q.suspicious_moves.length), "flagged for review")}${stat("No-trade stretches", int(q.stale_runs.length), "3+ days without trades", "", "stale")}</div>
    <div class="panel">${panelHead("Notes and warnings", "Most important first")}${warnings(q.warnings, 50) || `<div class="caption">Nothing to report.</div>`}</div>
    <div class="grid g-2">
      <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("Contract sizes confirmed by the data", "If Aureon\'s assumed lot sizes are right, total value traded ÷ lots traded must fall inside each day\'s price range. “Confirmed” means it does.", "", "lot")}</div>${table([
        { label: "Symbol", render: (r) => `<span class="mono">${r.symbol}</span>` }, { label: "Lot / quote", render: (r) => `${r.lot_grams} g / ${r.quote_grams} g` },
        { label: "Rows", right: true, render: (r) => int(r.rows) }, { label: "Median VWAP/mid", right: true, render: (r) => num(r.median_ratio, 4) },
        { label: "In range", right: true, render: (r) => (isNum(r.inside_range_pct) ? num(r.inside_range_pct, 1) + "%" : "—") },
        { label: "", render: (r) => `<span class="chip ${r.verdict === "confirmed" ? "ok" : "err"}">${r.verdict}</span>` }], q.spec_verification)}</div>
      <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("Price steps confirmed", "Share of traded prices that are whole multiples of the assumed minimum price step", "", "tick")}</div>${table([
        { label: "Symbol", render: (r) => `<span class="mono">${r.symbol}</span>` }, { label: "Assumed tick", right: true, render: (r) => "₹" + r.assumed_tick },
        { label: "Prices", right: true, render: (r) => int(r.prices_checked) }, { label: "Off grid", right: true, render: (r) => int(r.off_grid) },
        { label: "Conforming", right: true, render: (r) => (isNum(r.conforming_pct) ? num(r.conforming_pct, 2) + "%" : "—") }], q.tick_conformity)}</div>
    </div>
    <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("How much history each product has", "Products started trading on MCX at different times. Gap days are trading days inside a product\'s range with no data at all.")}</div>${table([
      { label: "Symbol", render: (r) => `<span class="swatch" style="background:${SYMBOL_COLORS[r.symbol]}"></span> <span class="mono">${r.symbol}</span>` },
      { label: "First", render: (r) => date(r.first_date) }, { label: "Last", render: (r) => date(r.last_date) }, { label: "Days", right: true, render: (r) => int(r.days) },
      { label: "Contracts", right: true, render: (r) => int(r.contracts) }, { label: "Rows", right: true, render: (r) => int(r.rows) },
      { label: "Zero-volume rows", right: true, render: (r) => `${int(r.zero_volume_rows)} <span class="caption">(${pct(r.zero_volume_rows / r.rows, 0)})</span>` },
      { label: "Gap days", right: true, render: (r) => `<span class="${r.gap_days ? "neg" : ""}">${int(r.gap_days)}</span>` }], syms)}</div>
    <div class="panel">${panelHead("Monthly coverage", "Each cell is one month: brighter = more complete, grey = no data")}<div id="heat"></div></div>
    <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("Contract lifecycle", "Every contract from first appearance to expiry, how complete its data is, and whether it can be traded today. Click a row to open it.", "", "expiry")}</div><div id="life"></div></div>
    <div class="grid g-2">
      <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("Suspicious price jumps", "Daily moves larger than 4% or far beyond the contract\'s usual range. Often genuine market events — but worth a look.")}</div>${table([
        { label: "Date", render: (r) => date(r.trade_date) }, { label: "Contract", render: (r) => `<span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` },
        { label: "Change", right: true, render: (r) => pct(r.log_change) }, { label: "Threshold", right: true, render: (r) => pct(r.threshold) },
        { label: "Gap (d)", right: true, render: (r) => r.calendar_gap_days ?? "—" }], q.suspicious_moves.slice().reverse(), { maxHeight: 300, emptyText: "None flagged." })}</div>
      <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("Stretches without trades", "Consecutive days when a contract published a price but nobody traded it", "", "stale")}</div>${table([
        { label: "Contract", render: (r) => `<span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` }, { label: "From", render: (r) => date(r.start) },
        { label: "To", render: (r) => date(r.end) }, { label: "Days", right: true, render: (r) => r.days }, { label: "DTE at end", right: true, render: (r) => r.min_dte }],
        q.stale_runs.slice().sort((a, b) => b.end.localeCompare(a.end)), { maxHeight: 300, emptyText: "None." })}</div>
    </div>
    <div class="grid g-2">
      <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("One product out of line", "Days when one product\'s comparable price was more than 1.5% away from the others", "", "spread")}</div>${table([
        { label: "Date", render: (r) => date(r.trade_date) }, { label: "Contract", render: (r) => `<span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` },
        { label: "Deviation", right: true, render: (r) => num(r.deviation_bps, 0) + " bps" }], (q.cross_product_outliers || []).slice().reverse(), { maxHeight: 300, emptyText: "None." })}</div>
      <div class="panel flush"><div style="padding:20px 20px 0">${panelHead("Missing days", "Days a contract was alive but no price was published (most recent 500)")}</div>${table([
        { label: "Date", render: (r) => date(r.trade_date) }, { label: "Contract", render: (r) => `<span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` }],
        q.missing_contract_days.slice().reverse(), { maxHeight: 300, emptyText: "None." })}</div>
    </div>
    <div class="panel">${panelHead("Rows rejected at import", "These rows were kept for audit but never used in any analysis")}${rejTable(q.rejections)}
      ${q.rejection_samples.length ? `<details style="margin-top:12px"><summary>Latest rejected rows</summary>${table([{ label: "Reason", key: "reason" }, { label: "Symbol", key: "symbol" }, { label: "Date", key: "trade_date" }, { label: "Detail", render: (r) => esc(r.detail || "") }], q.rejection_samples, { maxHeight: 280 })}</details>` : ""}</div>`;

  // monthly heatmap
  const months = [...new Set(q.coverage_heatmap.map((r) => r.month))].sort();
  const symsH = [...new Set(q.coverage_heatmap.map((r) => r.symbol))];
  const look = new Map(q.coverage_heatmap.map((r) => [r.symbol + r.month, r.days / r.calendar_days]));
  out.querySelector("#heat").innerHTML = `<div style="overflow-x:auto"><div class="heat" style="grid-template-columns:96px repeat(${months.length}, minmax(10px,1fr));min-width:${96 + months.length * 12}px">
    ${symsH.map((s) => `<div class="mono caption">${s}</div>${months.map((m) => { const v = look.get(s + m); return `<div class="cell" title="${s} ${m}: ${isNum(v) ? Math.round(v * 100) + "%" : "no data"}" style="background:${isNum(v) ? `color-mix(in srgb, ${SYMBOL_COLORS[s]} ${Math.round(15 + 85 * v)}%, var(--surface-2))` : "var(--surface-2)"}"></div>`; }).join("")}`).join("")}
    <div></div>${months.map((m, i) => `<div class="caption" style="font-size:10px">${i % 6 === 0 ? m.slice(2) : ""}</div>`).join("")}</div></div>`;

  const life = q.contracts.slice().sort((a, b) => b.expiry.localeCompare(a.expiry) || a.symbol.localeCompare(b.symbol));
  const lEl = out.querySelector("#life");
  lEl.innerHTML = table([
    { label: "Contract", render: (r) => `<span class="swatch" style="background:${SYMBOL_COLORS[r.symbol]}"></span> <span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` },
    { label: "Data from → to", render: (r) => `${date(r.first_seen)} → ${date(r.last_seen)}` }, { label: "Expires in", right: true, render: (r) => (r.dte >= 0 ? `${r.dte} d` : "—") },
    { label: "Days of data", right: true, render: (r) => `${int(r.observations)} / ${int(r.expected_observations)}` },
    { label: "Traded days", right: true, render: (r) => int(r.traded_days) },
    { label: "Today", render: (r) => (r.status === "expired" ? `<span class="chip">Expired</span>` : `<span class="chip ${r.eligible ? "ok" : "warn"}">${r.eligible ? "Tradable" : esc(r.eligibility_reason)}</span>`) },
  ], life, { onClick: true, maxHeight: 420 });
  bindTable(lEl, life, (r) => (location.hash = `#/market/contracts/${r.symbol}`));
}

const REASONS = {
  source_error: "Day not available from the exchange (holiday or failed download)",
  expiry_settlement_price: "Expiry-day settlement price, not a traded price",
  invalid_ohlc: "Prices inconsistent with the day's high/low",
  invalid_price: "Missing or non-positive price",
  value_volume_inconsistent: "Traded value doesn't match price × volume",
  expired_contract: "Row dated after the contract expired",
  invalid_quantity: "Negative volume or open interest",
  parse_error: "File row could not be read",
  duplicate_conflict_in_payload: "Same row twice with different values",
};
function rejTable(rej) {
  const rows = Object.entries(rej || {}).map(([k, n]) => ({ k, n }));
  return rows.length ? table([{ label: "Reason", render: (r) => `${esc(REASONS[r.k] || r.k)} <span class="caption mono">${esc(r.k)}</span>` }, { label: "Rows", right: true, render: (r) => int(r.n) }], rows) : `<div class="caption">No rows were rejected.</div>`;
}
