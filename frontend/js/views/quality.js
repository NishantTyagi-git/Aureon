import { api } from "../api.js";
import { bindTable, noDataState, stat, table, warnings } from "../components.js";
import { date, esc, expiry, int, isNum, num, pct, SYMBOL_COLORS } from "../format.js";

export default async function quality(root) {
  root.innerHTML = `<div class="page-head"><div><span class="overline">Data quality & contract lifecycle</span><h1>Can this data be trusted?</h1>
    <p>Every check reports — none of them edits data. Missing observations are never filled with invented prices; rejected rows are kept for audit; conflicting duplicates keep the first-ingested value and are logged.</p></div></div><div id="out" class="stack"></div>`;
  const out = root.querySelector("#out");
  const q = await api.quality();
  if (q.empty) {
    out.innerHTML = warnings(q.warnings) + noDataState() + (Object.keys(q.rejections || {}).length ? `<div class="panel"><h3>Rejected rows</h3>${rejTable(q.rejections)}</div>` : "");
    return;
  }
  const syms = q.coverage_by_symbol;
  out.innerHTML = `
    <div class="stat-row">${stat("Coverage", `${date(q.first_date)} → ${date(q.latest_date)}`, `${int(q.trading_days)} exchange days`)}${stat("Freshness", q.business_days_behind ? `${q.business_days_behind} bdays behind` : "Current", "vs today")}
      ${stat("Rejected rows", int(Object.values(q.rejections).reduce((a, b) => a + b, 0)))}${stat("Duplicates", int(q.duplicates.total), `${q.duplicates.conflicting} conflicting`)}
      ${stat("Suspicious moves", int(q.suspicious_moves.length))}${stat("Stale runs", int(q.stale_runs.length), "≥3 zero-volume days")}</div>
    <div class="panel"><div class="panel-head"><div><h3>Warnings</h3></div></div>${warnings(q.warnings, 50) || `<div class="caption">No warnings.</div>`}</div>
    <div class="grid g-2">
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Specification verification</h3><div class="caption">Turnover ÷ (lots × lot multiplier) should land inside each day's traded range — confirms lot size and quotation unit from the data itself</div></div></div>${table([
        { label: "Symbol", render: (r) => `<span class="mono">${r.symbol}</span>` }, { label: "Lot / quote", render: (r) => `${r.lot_grams} g / ${r.quote_grams} g` },
        { label: "Rows", right: true, render: (r) => int(r.rows) }, { label: "Median VWAP/mid", right: true, render: (r) => num(r.median_ratio, 4) },
        { label: "In range", right: true, render: (r) => (isNum(r.inside_range_pct) ? num(r.inside_range_pct, 1) + "%" : "—") },
        { label: "", render: (r) => `<span class="chip ${r.verdict === "confirmed" ? "ok" : "err"}">${r.verdict}</span>` }], q.spec_verification)}</div>
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Tick conformity</h3><div class="caption">Share of traded prices on the assumed ₹ tick grid</div></div></div>${table([
        { label: "Symbol", render: (r) => `<span class="mono">${r.symbol}</span>` }, { label: "Assumed tick", right: true, render: (r) => "₹" + r.assumed_tick },
        { label: "Prices", right: true, render: (r) => int(r.prices_checked) }, { label: "Off grid", right: true, render: (r) => int(r.off_grid) },
        { label: "Conforming", right: true, render: (r) => (isNum(r.conforming_pct) ? num(r.conforming_pct, 2) + "%" : "—") }], q.tick_conformity)}</div>
    </div>
    <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Historical coverage by symbol</h3><div class="caption">Symbols launched at different times; gap days are exchange days inside a symbol's range with no rows at all</div></div></div>${table([
      { label: "Symbol", render: (r) => `<span class="swatch" style="background:${SYMBOL_COLORS[r.symbol]}"></span> <span class="mono">${r.symbol}</span>` },
      { label: "First", render: (r) => date(r.first_date) }, { label: "Last", render: (r) => date(r.last_date) }, { label: "Days", right: true, render: (r) => int(r.days) },
      { label: "Contracts", right: true, render: (r) => int(r.contracts) }, { label: "Rows", right: true, render: (r) => int(r.rows) },
      { label: "Zero-volume rows", right: true, render: (r) => `${int(r.zero_volume_rows)} <span class="caption">(${pct(r.zero_volume_rows / r.rows, 0)})</span>` },
      { label: "Gap days", right: true, render: (r) => `<span class="${r.gap_days ? "neg" : ""}">${int(r.gap_days)}</span>` }], syms)}</div>
    <div class="panel"><div class="panel-head"><div><h3>Monthly coverage</h3><div class="caption">Days with data ÷ exchange days in the month · darker = complete</div></div></div><div id="heat"></div></div>
    <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Contract lifecycle</h3><div class="caption">Every expiry, its live window, coverage and current eligibility · click to open in Contracts</div></div></div><div id="life"></div></div>
    <div class="grid g-2">
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Suspicious moves</h3><div class="caption">|Δ ln close| above max(4%, 6× robust σ) — review before trusting</div></div></div>${table([
        { label: "Date", render: (r) => date(r.trade_date) }, { label: "Contract", render: (r) => `<span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` },
        { label: "Change", right: true, render: (r) => pct(r.log_change) }, { label: "Threshold", right: true, render: (r) => pct(r.threshold) },
        { label: "Gap (d)", right: true, render: (r) => r.calendar_gap_days ?? "—" }], q.suspicious_moves.slice().reverse(), { maxHeight: 300, emptyText: "None flagged." })}</div>
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Stale price runs</h3><div class="caption">Consecutive zero-volume days — reference prices, not trades</div></div></div>${table([
        { label: "Contract", render: (r) => `<span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` }, { label: "From", render: (r) => date(r.start) },
        { label: "To", render: (r) => date(r.end) }, { label: "Days", right: true, render: (r) => r.days }, { label: "DTE at end", right: true, render: (r) => r.min_dte }],
        q.stale_runs.slice().sort((a, b) => b.end.localeCompare(a.end)), { maxHeight: 300, emptyText: "None." })}</div>
    </div>
    <div class="grid g-2">
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Cross-product outliers</h3><div class="caption">A product's front price >150 bps from the median of the others on the same day</div></div></div>${table([
        { label: "Date", render: (r) => date(r.trade_date) }, { label: "Contract", render: (r) => `<span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` },
        { label: "Deviation", right: true, render: (r) => num(r.deviation_bps, 0) + " bps" }], (q.cross_product_outliers || []).slice().reverse(), { maxHeight: 300, emptyText: "None." })}</div>
      <div class="panel flush"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Missing contract-days</h3><div class="caption">Days a live contract had no row (most recent 500)</div></div></div>${table([
        { label: "Date", render: (r) => date(r.trade_date) }, { label: "Contract", render: (r) => `<span class="mono">${r.symbol} ${expiry(r.expiry)}</span>` }],
        q.missing_contract_days.slice().reverse(), { maxHeight: 300, emptyText: "None." })}</div>
    </div>
    <div class="panel"><div class="panel-head"><div><h3>Validation rejections</h3><div class="caption">Rows that never reached the analytics tables</div></div></div>${rejTable(q.rejections)}
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
    { label: "Live window", render: (r) => `${date(r.first_seen)} → ${date(r.last_seen)}` }, { label: "DTE", right: true, render: (r) => (r.dte >= 0 ? r.dte : "—") },
    { label: "Obs / expected", right: true, render: (r) => `${int(r.observations)} / ${int(r.expected_observations)}` },
    { label: "Traded days", right: true, render: (r) => int(r.traded_days) },
    { label: "Eligibility", render: (r) => (r.status === "expired" ? `<span class="chip">expired</span>` : `<span class="chip ${r.eligible ? "ok" : "warn"}">${esc(r.eligibility_reason)}</span>`) },
  ], life, { onClick: true, maxHeight: 420 });
  bindTable(lEl, life, (r) => (location.hash = `#/contracts/${r.symbol}`));
}

function rejTable(rej) {
  const rows = Object.entries(rej || {}).map(([k, n]) => ({ k, n }));
  return rows.length ? table([{ label: "Reason", render: (r) => `<span class="mono">${esc(r.k)}</span>` }, { label: "Rows", right: true, render: (r) => int(r.n) }], rows) : `<div class="caption">No rows rejected.</div>`;
}
