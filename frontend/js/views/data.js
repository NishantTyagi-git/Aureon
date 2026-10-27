import { api } from "../api.js";
import { pageHead, panelHead, stat, table, toast } from "../components.js";
import { pageGuide } from "../help.js";
import { date, esc, int } from "../format.js";

export default async function data(root, _params, app) {
  root.innerHTML = `${pageHead("Data", "Data sources",
      "Aureon uses the official daily price files published by MCX (the “bhavcopy”). Load them here. Every file is archived exactly as received and every row is checked before it is used.")}
    ${pageGuide("sources", {
      what: "How much data is loaded, three ways to load more, and a log of everything imported.",
      why: "All analysis depends on real exchange prices. Nothing is shown until real data is loaded — Aureon never fills gaps with made-up numbers.",
      next: "Use option 1 for history (a few minutes). After importing, check <a href='#/data/health'>Data health</a>, then start on <a href='#/home'>Home</a>.",
    })}
    <div id="sum"></div>
    <div class="grid g-3 section">
      <div class="panel" style="order:3"><div class="panel-head"><div><span class="overline">Option 3 · automated</span><h3>TinyFish collector</h3><div class="caption">Experimental: an AI browser agent reads the MCX page</div></div><span class="chip" id="tf-chip">…</span></div>
        <div class="prose"><p>Collects one trading day per run (several minutes each). Its output is AI-extracted, so every row must pass the same checks as any other source. In testing it often returned no rows — prefer option 1 for history.</p></div>
        <div class="form-grid"><div class="field"><label>Start</label><input class="input" type="date" id="tf-s"/></div><div class="field"><label>End</label><input class="input" type="date" id="tf-e"/></div></div>
        <div class="row" style="margin-top:12px"><button class="btn" id="tf-run">Collect via TinyFish</button><span class="caption" id="tf-msg"></span></div></div>
      <div class="panel"><div class="panel-head"><div><span class="overline">Option 1 · recommended</span><h3>Collect from the MCX website</h3><div class="caption">Years of history in a few minutes</div></div></div>
        <ol class="prose" style="padding-left:18px;margin:0 0 12px"><li>Open the <a href="https://www.mcxindia.com/market-data/bhavcopy" target="_blank" rel="noopener">MCX bhavcopy page</a> in your browser.</li>
        <li>Press <b>F12</b>, open the <b>Console</b> tab, paste the script and press Enter.</li>
        <li>Type <code>aureonCollect("2023-01-01", "${new Date().toISOString().slice(0, 10)}")</code> and press Enter.</li>
        <li>When the file downloads, upload it here (option 2).</li></ol>
        <div class="row"><button class="btn primary" id="copy">Copy the script</button><a class="btn ghost" href="/api/collector-script" target="_blank">View script</a></div></div>
      <div class="panel"><div class="panel-head"><div><span class="overline">Option 2</span><h3>Upload files</h3><div class="caption">Collector files, or CSVs saved from the MCX bhavcopy page</div></div></div>
        <label class="empty" style="display:block;padding:24px;cursor:pointer" id="drop" tabindex="0"><input type="file" id="file" accept=".json,.csv" multiple hidden/><b>Drop files here or click to choose</b><br/><span class="caption">.json or .csv · checked row by row on import</span></label>
        <div class="row" style="margin-top:12px"><button class="btn" id="scan">Import from data/import folder</button></div>
        <div id="up-res" style="margin-top:12px"></div></div>
    </div>
    <div class="panel flush section"><div style="padding:20px 20px 0">${panelHead("Import history", "Every import or collection run, newest first")}</div><div id="runs"></div></div>
    <details class="panel flush section"><summary class="caption" style="cursor:pointer;padding:16px 20px">Original files archive — exactly as received, never modified (also saved under data/raw/)</summary><div id="raw"></div></details>
    <details class="panel section"><summary class="caption" style="cursor:pointer">Contract specifications Aureon uses, and where each value comes from</summary><div style="margin-top:12px"><div class="caption" style="margin-bottom:8px">“official_page” = MCX product page · “empirical” = confirmed from the price data itself</div><div id="specs"></div></div></details>`;

  async function refresh() {
    const [st, runs, specs] = await Promise.all([api.status(), api.runs(), api.specs()]);
    root.querySelector("#sum").innerHTML = `<div class="stat-row">${stat("Dates covered", st.has_data ? `${date(st.first_date)} → ${date(st.last_date)}` : "None yet", st.has_data ? `${int(st.trading_days)} trading days` : "load data to begin")}${stat("Price rows in use", int(st.counts.quotes), "passed all checks")}${stat("Rows rejected", int(st.counts.rejections), "kept for audit")}${stat("Files archived", int(st.counts.raw_payloads))}</div>`;
    const chip = root.querySelector("#tf-chip");
    chip.className = "chip " + (st.tinyfish_configured ? "ok" : "warn");
    chip.textContent = st.tinyfish_configured ? "Ready" : "Needs API key";
    chip.title = st.tinyfish_configured ? "" : "Add TINYFISH_API_KEY to the .env file and restart Aureon";
    root.querySelector("#tf-run").disabled = !st.tinyfish_configured || st.collection.running;
    root.querySelector("#tf-msg").textContent = st.collection.running ? "Collection running…" : st.collection.error ? `Last run failed: ${st.collection.error}` : st.collection.last_result ? `Last run: ${st.collection.last_result.ok} ok, ${st.collection.last_result.failed} failed` : "";
    root.querySelector("#runs").innerHTML = table([
      { label: "#", key: "id" }, { label: "Source", render: (r) => `<span class="mono">${esc(r.source)}</span>` }, { label: "When", render: (r) => esc((r.started_at || "").replace("T", " ").slice(0, 16)) },
      { label: "Status", render: (r) => `<span class="chip ${r.status === "ok" ? "ok" : r.status === "running" ? "" : "warn"}">${esc(r.status)}</span>` },
      { label: "New rows", right: true, render: (r) => int(r.detail && r.detail.inserted) }, { label: "Rejected", right: true, render: (r) => int(r.detail && r.detail.rejected) },
      { label: "Detail", render: (r) => esc(r.detail && (r.detail.file || r.detail.error || (r.detail.requested != null ? `${r.detail.ok}/${r.detail.requested} days` : ""))) },
    ], runs.runs, { maxHeight: 300, emptyText: "Nothing imported yet." });
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
  if (st.read_only) {
    root.querySelector(".grid.g-3").outerHTML = `<div class="alert section"><span class="dot"></span><div><b>This is a read-only deployment.</b> It ships with official MCX data from ${date(st.first_date)} to ${date(st.last_date)}. Loading new data is disabled here; run Aureon on your own computer to collect or upload more.</div></div>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  root.querySelector("#tf-s").value = st.last_date || today; root.querySelector("#tf-e").value = today;

  root.querySelector("#tf-run").addEventListener("click", async () => {
    try { await api.collect({ start: root.querySelector("#tf-s").value, end: root.querySelector("#tf-e").value }); toast("TinyFish collection started — each day can take several minutes.", 4000, "ok"); refresh(); }
    catch (e) { toast(e.message, 5000, "err"); }
  });
  root.querySelector("#copy").addEventListener("click", async () => {
    const s = await api.collectorScript();
    try { await navigator.clipboard.writeText(s); toast("Script copied — paste it into the MCX page console.", 4000, "ok"); } catch { toast("Couldn't copy automatically — use “View script” and copy it from there.", 5000, "err"); }
  });
  const showRes = (items) => {
    root.querySelector("#up-res").innerHTML = items.map((r) => `<div class="alert ${r.error ? "err" : ""}" style="margin-bottom:6px"><span class="dot ${r.error ? "err" : "ok"}"></span><div><b>${esc(r.file || "upload")}</b> — ${r.error ? esc(r.error) : `${int(r.inserted)} new rows, ${int(r.identical_duplicates)} already loaded, ${int(r.rejected)} rejected${r.rejection_reasons && Object.keys(r.rejection_reasons).length ? " (" + esc(Object.entries(r.rejection_reasons).map(([k, v]) => `${k}: ${v}`).join(", ")) + ")" : ""}`}</div></div>`).join("");
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
    showRes(r.results.length ? r.results : [{ file: "data/import", error: "No .json or .csv files found in the folder." }]);
    await refresh(); app.refreshStatus();
  });
}
