// Thin API client. Every view reads data only through these calls.
const UNREACHABLE = "Can't reach the Aureon server. If you run Aureon on your computer, start it with “python run.py”. If it's hosted online, it may be waking up or restarting — try again in a minute.";
const NOT_RESPONDING = "The Aureon server isn't responding right now (it may be restarting or waking up). Try again in a minute.";
const TOO_SLOW = "The server took too long to answer. Try again, or use the quick test, which is much faster.";

function serverError(message) {
  const e = new Error(message);
  e.server = true;
  return e;
}

async function request(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  // Reads are retried briefly when the server is momentarily unavailable; long POSTs (tests) are not,
  // so heavy work never runs twice.
  const attempts = method === "GET" ? 3 : 1;
  let r;
  for (let i = 0; i < attempts; i++) {
    try {
      r = await fetch(path, opts);
      if (![502, 503].includes(r.status)) break;
    } catch {
      r = null;
    }
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  if (!r) throw serverError(UNREACHABLE);
  if (r.status === 502 || r.status === 503) throw serverError(NOT_RESPONDING);
  if (r.status === 504) throw serverError(TOO_SLOW);
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
