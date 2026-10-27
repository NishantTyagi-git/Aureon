/*
 * Aureon — MCX bhavcopy collector (run in YOUR browser, on the official MCX page).
 *
 * 1. Open https://www.mcxindia.com/market-data/bhavcopy in a normal browser tab.
 * 2. Open the developer console (F12 → Console), paste this whole script, press Enter.
 * 3. Call:   aureonCollect("2024-01-01", "2026-10-23")
 *    It requests one trading day at a time through the page's own "Date Wise" endpoint (the same
 *    request the "Show" button makes), politely spaced, and then downloads one JSON bundle.
 * 4. Drop the downloaded file into Aureon's data/import folder (or upload it on the Data page).
 *
 * The bundle keeps every gold-futures row exactly as MCX returned it (other commodities are
 * dropped to keep the file small; the total row count of each response is recorded for audit).
 */
(function () {
  const SYMBOLS = ["GOLD", "GOLDM", "GOLDTEN", "GOLDGUINEA", "GOLDPETAL"];
  const pad = (n) => String(n).padStart(2, "0");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchDay(d) {
    const fromDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const url = "/market-data/bhavcopy/GetDateWiseBhavCopy?" +
      new URLSearchParams({ InstrumentName: "FUTCOM", fromDate });
    const r = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { return { request: { fromDate }, status: r.status, error: "non-JSON response" }; }
    const all = json.Data || [];
    const gold = all.filter((x) => SYMBOLS.includes(String(x.Symbol || "").trim().toUpperCase()));
    return {
      request: { endpoint: "GetDateWiseBhavCopy", InstrumentName: "FUTCOM", fromDate },
      status: r.status, total_rows: all.length,
      response: { IsSuccess: json.IsSuccess, Message: json.Message, Data: gold },
    };
  }

  window.aureonCollect = async function (start, end, delayMs = 700) {
    if (!location.hostname.endsWith("mcxindia.com")) throw new Error("Run this on www.mcxindia.com");
    const s = new Date(start + "T00:00:00"), e = new Date((end || start) + "T00:00:00");
    const items = [];
    let n = 0;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      let item;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { item = await fetchDay(new Date(d)); if (!item.error) break; } catch (err) { item = { error: String(err) }; }
        await sleep(2000 * (attempt + 1));
      }
      items.push(item);
      n++;
      if (n % 20 === 0) console.log(`[aureon] ${n} days fetched — at ${d.toISOString().slice(0, 10)}`);
      await sleep(delayMs);
    }
    const bundle = { aureon_bundle: 1, source: "mcx_bhavcopy_browser", collected_at: new Date().toISOString(),
      page: location.href, start, end: end || start, items };
    const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `aureon_mcx_${start}_${end || start}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    const rows = items.reduce((t, i) => t + ((i.response && i.response.Data) || []).length, 0);
    console.log(`[aureon] done: ${items.length} days, ${rows} gold rows → ${a.download}`);
    return { days: items.length, rows };
  };
  console.log('[aureon] collector ready — run aureonCollect("YYYY-MM-DD", "YYYY-MM-DD")');
})();
