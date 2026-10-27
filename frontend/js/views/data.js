import { api } from "../api.js";
import { stat, table, toast } from "../components.js";
import { date, esc, int } from "../format.js";

export default async function data(root, _params, app) {
  root.innerHTML = `<div class="page-head"><div><span class="overline">Data sources</span><h1>Market data pipeline</h1>
    <p>Every payload is stored verbatim (content-hashed) before parsing, then validated row by row: OHLC sanity, expiry, and a turnover-vs-price consistency check that catches unit errors and extraction mistakes. Only validated rows reach the research engine.</p></div></div>
    <div id="sum"></div>
    <div class="grid g-3 section">
      <div class="panel"><div class="panel-head"><div><h3>TinyFish collector</h3><div class="caption">Automated collection from the official MCX bhavcopy page</div></div><span class="chip" id="tf-chip">…</span></div>
        <div class="prose"><p>Runs TinyFish's web agent on <code>mcxindia.com/market-data/bhavcopy</code>, one trading day per run. TinyFish output is LLM-extracted, so it is treated as untrusted and must pass the same validation as any other source.</p></div>
        <div class="form-grid"><div class="field"><label>Start</label><input class="input" type="date" id="tf-s"/></div><div class="field"><label>End</label><input class="input" type="date" id="tf-e"/></div></div>
        <div class="row" style="margin-top:12px"><button class="btn" id="tf-run">Collect via TinyFish</button><span class="caption" id="tf-msg"></span></div></div>
      <div class="panel"><div class="panel-head"><div><h3>MCX in-browser collector</h3><div class="caption">Fastest route to full history</div></div></div>
        <div class="prose"><p>Open the <a href="https://www.mcxindia.com/market-data/bhavcopy" target="_blank" rel="noopener">official MCX bhavcopy page</a> in your browser, paste this script into the developer console, then run <code>aureonCollect("2024-01-01", "2026-10-23")</code>. It uses the page's own "Date Wise" request and downloads one JSON bundle — upload it here or drop it into <code>data/import</code>.</p></div>
        <div class="row"><button class="btn" id="copy">Copy collector script</button><a class="btn ghost" href="/api/collector-script" target="_blank">View</a></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Import files</h3><div class="caption">MCX JSON, collector bundles, MCX CSV exports, TinyFish results</div></div></div>
        <label class="empty" style="display:block;padding:24px;cursor:pointer" id="drop"><input type="file" id="file" accept=".json,.csv" multiple hidden/><b>Drop files or click to upload</b><br/><span class="caption">CSV exported with the bhavcopy page's own CSV button is accepted</span></label>
        <div class="row" style="margin-top:12px"><button class="btn" id="scan">Scan data/import folder</button></div>
        <div id="up-res" style="margin-top:12px"></div></div>
    </div>
    <div class="panel flush section"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Ingestion runs</h3></div></div><div id="runs"></div></div>
    <div class="panel flush section"><div class="panel-head" style="padding:20px 20px 0"><div><h3>Raw payload archive</h3><div class="caption">Exactly as received — never modified · also mirrored under data/raw/</div></div></div><div id="raw"></div></div>
    <div class="panel section"><div class="panel-head"><div><h3>Contract specifications in use</h3><div class="caption">Provenance per field — "official_page": MCX product page; "empirical": confirmed from bhavcopy turnover / price data</div></div></div><div id="specs"></div></div>`;

  async function refresh() {
    const [st, runs, specs] = await Promise.all([api.status(), api.runs(), api.specs()]);
    root.querySelector("#sum").innerHTML = `<div class="stat-row">${stat("Validated quotes", int(st.counts.quotes))}${stat("Raw payloads", int(st.counts.raw_payloads))}${stat("Rejected rows", int(st.counts.rejections))}${stat("Duplicates logged", int(st.counts.duplicates))}${stat("Coverage", st.has_data ? `${date(st.first_date)} → ${date(st.last_date)}` : "none")}</div>`;
    const chip = root.querySelector("#tf-chip");
    chip.className = "chip " + (st.tinyfish_configured ? "ok" : "warn");
    chip.textContent = st.tinyfish_configured ? "API key set" : "TINYFISH_API_KEY missing";
    root.querySelector("#tf-run").disabled = !st.tinyfish_configured || st.collection.running;
    root.querySelector("#tf-msg").textContent = st.collection.running ? "Collection running…" : st.collection.error ? `Last run failed: ${st.collection.error}` : st.collection.last_result ? `Last run: ${st.collection.last_result.ok} ok, ${st.collection.last_result.failed} failed` : "";
    root.querySelector("#runs").innerHTML = table([
      { label: "#", key: "id" }, { label: "Source", render: (r) => `<span class="mono">${esc(r.source)}</span>` }, { label: "Started", render: (r) => esc((r.started_at || "").replace("T", " ").slice(0, 19)) },
      { label: "Status", render: (r) => `<span class="chip ${r.status === "ok" ? "ok" : r.status === "running" ? "" : "warn"}">${esc(r.status)}</span>` },
      { label: "Inserted", right: true, render: (r) => int(r.detail && r.detail.inserted) }, { label: "Rejected", right: true, render: (r) => int(r.detail && r.detail.rejected) },
      { label: "Detail", render: (r) => esc(r.detail && (r.detail.file || r.detail.error || (r.detail.requested != null ? `${r.detail.ok}/${r.detail.requested} days` : ""))) },
    ], runs.runs, { maxHeight: 300, emptyText: "No ingestion runs yet." });
    root.querySelector("#raw").innerHTML = table([
      { label: "#", key: "id" }, { label: "Source", render: (r) => `<span class="mono">${esc(r.source)}</span>` }, { label: "Fetched", render: (r) => esc(r.fetched_at.replace("T", " ").slice(0, 19)) },
      { label: "Request", render: (r) => `<span class="caption mono">${esc((r.request || "").slice(0, 60))}</span>` }, { label: "Size", right: true, render: (r) => `${int(r.bytes / 1024)} KB` },
      { label: "SHA-256", render: (r) => `<span class="caption mono">${r.sha256.slice(0, 12)}…</span>` }, { label: "", render: (r) => `<a href="/api/ingest/raw/${r.id}" target="_blank">open</a>` },
    ], runs.raw, { maxHeight: 300, emptyText: "No raw payloads stored." });
    root.querySelector("#specs").innerHTML = table([
      { label: "Symbol", render: (r) => `<span class="mono">${r.symbol}</span>` }, { label: "Name", key: "name" },
      { label: "Lot", right: true, render: (r) => `${r.lot_grams} g <span class="caption">${r.provenance.lot_grams}</span>` },
      { label: "Quote per", right: true, render: (r) => `${r.quote_grams} g <span class="caption">${r.provenance.quote_grams}</span>` },
      { label: "Purity", right: true, render: (r) => `${r.purity} <span class="caption">${r.provenance.purity}</span>` },
      { label: "Tick", right: true, render: (r) => `₹${r.tick} <span class="caption">${r.provenance.tick}</span>` },
      { label: "Expiry", render: (r) => `<span class="caption">${esc(r.expiry_pattern)}</span>` },
      { label: "Spec PDF", render: (r) => (specs.documents[r.symbol] ? `<a href="${esc(specs.documents[r.symbol])}" target="_blank" rel="noopener">MCX</a>` : "") },
    ], specs.specs);
    return st;
  }
  const st = await refresh();
  const today = new Date().toISOString().slice(0, 10);
  root.querySelector("#tf-s").value = st.last_date || today; root.querySelector("#tf-e").value = today;

  root.querySelector("#tf-run").addEventListener("click", async () => {
    try { await api.collect({ start: root.querySelector("#tf-s").value, end: root.querySelector("#tf-e").value }); toast("TinyFish collection started — each day can take several minutes."); refresh(); }
    catch (e) { toast(e.message); }
  });
  root.querySelector("#copy").addEventListener("click", async () => {
    const s = await api.collectorScript();
    try { await navigator.clipboard.writeText(s); toast("Collector script copied."); } catch { toast("Clipboard unavailable — use View instead."); }
  });
  const showRes = (items) => {
    root.querySelector("#up-res").innerHTML = items.map((r) => `<div class="alert ${r.error ? "err" : ""}" style="margin-bottom:6px"><span class="dot ${r.error ? "err" : "ok"}"></span><div><b>${esc(r.file || "upload")}</b> — ${r.error ? esc(r.error) : `${int(r.inserted)} new, ${int(r.identical_duplicates)} duplicate, ${int(r.rejected)} rejected${r.rejection_reasons && Object.keys(r.rejection_reasons).length ? " (" + esc(Object.entries(r.rejection_reasons).map(([k, v]) => `${k}: ${v}`).join(", ")) + ")" : ""}`}</div></div>`).join("");
  };
  async function uploadFiles(files) {
    const results = [];
    for (const f of files) { try { results.push({ file: f.name, ...(await api.upload(f)) }); } catch (e) { results.push({ file: f.name, error: e.message }); } }
    showRes(results); await refresh(); app.refreshStatus();
  }
  const drop = root.querySelector("#drop");
  root.querySelector("#file").addEventListener("change", (e) => uploadFiles([...e.target.files]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "var(--primary)"; });
  drop.addEventListener("dragleave", () => (drop.style.borderColor = ""));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.style.borderColor = ""; uploadFiles([...e.dataTransfer.files]); });
  root.querySelector("#scan").addEventListener("click", async () => {
    const r = await api.scan();
    showRes(r.results.length ? r.results : [{ file: "data/import", error: "no .json or .csv files found" }]);
    await refresh(); app.refreshStatus();
  });
}
