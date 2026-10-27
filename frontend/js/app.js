// App shell: routing, navigation, command palette, theme, data-status pill.
import { api } from "./api.js";
import { cleanup, errorBox } from "./components.js";
import { date, RESEARCH } from "./format.js";
import overview from "./views/overview.js";
import contracts from "./views/contracts.js";
import relative from "./views/relative.js";
import term from "./views/term.js";
import signals from "./views/signals.js";
import backtest from "./views/backtest.js";
import performance from "./views/performance.js";
import quality from "./views/quality.js";
import data from "./views/data.js";

const ROUTES = [
  { path: "overview", label: "Overview", view: overview },
  { path: "contracts", label: "Contracts", view: contracts },
  { path: "relative", label: "Relative value", view: relative },
  { path: "term", label: "Term structure", view: term },
  { path: "signals", label: "Signals", view: signals },
  { path: "backtest", label: "Backtest", view: backtest },
  { path: "performance", label: "Performance & risk", view: performance },
  { path: "quality", label: "Quality & lifecycle", view: quality },
  { path: "data", label: "Data", view: data },
];

const root = document.getElementById("view");
const navLinks = document.getElementById("nav-links");
navLinks.innerHTML = ROUTES.map((r) => `<a href="#/${r.path}" data-path="${r.path}">${r.label}</a>`).join("");

export const status = { value: null };

async function refreshStatus() {
  const pill = document.getElementById("data-pill");
  try {
    const s = await api.status();
    status.value = s;
    if (!s.has_data) pill.innerHTML = `<span class="dot err"></span><span>No data loaded</span>`;
    else {
      const behind = Math.round((Date.now() - new Date(s.last_date + "T00:00:00")) / 86400000);
      pill.innerHTML = `<span class="dot ${behind > 4 ? "warn" : "ok"}"></span><span>Data to ${date(s.last_date)}</span>`;
    }
  } catch (e) {
    pill.innerHTML = `<span class="dot err"></span><span>API offline</span>`;
  }
}

let current = null;
async function route() {
  const [path, ...rest] = (location.hash.replace(/^#\/?/, "") || "overview").split("/");
  const r = ROUTES.find((x) => x.path === path) || ROUTES[0];
  navLinks.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.path === r.path));
  navLinks.classList.remove("open");
  cleanup();
  current = r;
  root.innerHTML = "";
  window.scrollTo(0, 0);
  try {
    await r.view(root, rest.map(decodeURIComponent), { refreshStatus });
  } catch (e) {
    console.error(e);
    root.innerHTML = errorBox(e);
  }
}

window.addEventListener("hashchange", route);
document.getElementById("hamburger").addEventListener("click", () => navLinks.classList.toggle("open"));
document.getElementById("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("aureon.theme", next); } catch {}
  route();
});

// ---------------------------------------------------------------- command palette (⌘K / Ctrl+K)
const pal = document.getElementById("palette");
const palInput = document.getElementById("palette-input");
const palItems = document.getElementById("palette-items");
let palSel = 0, palList = [];
function paletteEntries() {
  const items = ROUTES.map((r) => ({ label: r.label, hint: "View", go: `#/${r.path}` }));
  for (let i = 0; i < RESEARCH.length; i++) for (let j = i + 1; j < RESEARCH.length; j++)
    items.push({ label: `${RESEARCH[i]} vs ${RESEARCH[j]}`, hint: "Pair", go: `#/relative/${RESEARCH[i]}/${RESEARCH[j]}` });
  for (const s of [...RESEARCH, "GOLD"]) items.push({ label: `${s} term structure`, hint: "Curve", go: `#/term/${s}` });
  return items;
}
function renderPalette() {
  const q = palInput.value.toLowerCase();
  palList = paletteEntries().filter((i) => i.label.toLowerCase().includes(q));
  palSel = Math.min(palSel, Math.max(0, palList.length - 1));
  palItems.innerHTML = palList.map((i, k) => `<div class="item ${k === palSel ? "on" : ""}" data-k="${k}"><span>${i.label}</span><span class="caption">${i.hint}</span></div>`).join("");
  palItems.querySelectorAll(".item").forEach((n) => n.addEventListener("click", () => go(palList[+n.dataset.k])));
}
function openPalette() { pal.classList.add("open"); palInput.value = ""; palSel = 0; renderPalette(); palInput.focus(); }
function closePalette() { pal.classList.remove("open"); }
function go(item) { if (item) location.hash = item.go; closePalette(); }
document.getElementById("search-trigger").addEventListener("click", openPalette);
pal.addEventListener("click", (e) => { if (e.target === pal) closePalette(); });
palInput.addEventListener("input", () => { palSel = 0; renderPalette(); });
palInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { palSel = Math.min(palSel + 1, palList.length - 1); renderPalette(); e.preventDefault(); }
  if (e.key === "ArrowUp") { palSel = Math.max(palSel - 1, 0); renderPalette(); e.preventDefault(); }
  if (e.key === "Enter") go(palList[palSel]);
  if (e.key === "Escape") closePalette();
});
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.classList.contains("open") ? closePalette() : openPalette(); }
});

refreshStatus();
route();
