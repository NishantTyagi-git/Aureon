// Thin API client. Every view reads data only through these calls.
async function request(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && data.detail) ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

export const api = {
  status: () => request("GET", "/api/status"),
  specs: () => request("GET", "/api/specs"),
  overview: () => request("GET", "/api/overview"),
  contracts: (p = {}) => request("GET", "/api/contracts?" + qs(p)),
  contract: (sym, exp) => request("GET", `/api/contracts/${sym}/${exp}`),
  relativeValue: (p) => request("GET", "/api/relative-value?" + qs(p)),
  matrix: (p = {}) => request("GET", "/api/relative-value/matrix?" + qs(p)),
  termStructure: (p) => request("GET", "/api/term-structure?" + qs(p)),
  signals: (body) => request("POST", "/api/signals", body),
  backtest: (body) => request("POST", "/api/backtest", body),
  walkforward: (body) => request("POST", "/api/walkforward", body),
  latest: () => request("GET", "/api/results/latest"),
  quality: () => request("GET", "/api/quality"),
  upload: (file) => { const f = new FormData(); f.append("file", file); return request("POST", "/api/ingest/upload", f); },
  scan: () => request("POST", "/api/ingest/scan"),
  runs: () => request("GET", "/api/ingest/runs"),
  collect: (body) => request("POST", "/api/collect/tinyfish", body),
  collectorScript: async () => (await fetch("/api/collector-script")).text(),
};
