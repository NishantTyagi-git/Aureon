// Formatting helpers. Missing values render as an em dash — never as zero.
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const dash = "—";

export function num(v, d = 2) {
  if (!isNum(v)) return dash;
  return v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export const int = (v) => (isNum(v) ? Math.round(v).toLocaleString("en-IN") : dash);
export function inr(v, d = 0) {
  if (!isNum(v)) return dash;
  const s = Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  return (v < 0 ? "−₹" : "₹") + s;
}
export function inrCompact(v) {
  if (!isNum(v)) return dash;
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  return `${sign}₹${a.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}
export const pct = (v, d = 2) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : dash);
export const bps = (v, d = 1) => (isNum(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)} bps` : dash);
export const signed = (v, d = 2) => (isNum(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}` : dash);
export const cls = (v) => (!isNum(v) ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function date(s) {
  if (!s) return dash;
  const d = new Date(s + (s.length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return s;
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function expiry(s) {
  if (!s) return dash;
  const d = new Date(s + "T00:00:00");
  return `${String(d.getDate()).padStart(2, "0")}${MONTHS[d.getMonth()].toUpperCase()}${String(d.getFullYear()).slice(2)}`;
}
export const ts = (s) => new Date(s + (s && s.length === 10 ? "T00:00:00" : "")).getTime();

export const SYMBOL_COLORS = { GOLDM: "var(--c-goldm)", GOLDTEN: "var(--c-goldten)", GOLDGUINEA: "var(--c-goldguinea)", GOLDPETAL: "var(--c-goldpetal)", GOLD: "var(--c-gold)" };
export const RESEARCH = ["GOLDM", "GOLDTEN", "GOLDGUINEA", "GOLDPETAL"];
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
