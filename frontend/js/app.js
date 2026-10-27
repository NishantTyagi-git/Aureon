// App shell: routing, navigation, sub-tabs, command palette, glossary, theme, data-status pill.
import { api } from "./api.js";
import { cleanup, errorBox } from "./components.js";
import { date, RESEARCH } from "./format.js";
import { GLOSSARY, glossaryPanel, installHelp } from "./help.js";
import home from "./views/overview.js";
import contracts from "./views/contracts.js";
import compare from "./views/relative.js";
import curves from "./views/term.js";
import opportunities from "./views/signals.js";
import test from "./views/backtest.js";
import results from "./views/performance.js";
import health from "./views/quality.js";
import sources from "./views/data.js";

// Primary navigation follows the research workflow. Sections with several views get sub-tabs.
const SECTIONS = [
  { path: "home", label: "Home", view: home, hint: "What Aureon does and today's summary" },
  { path: "market", label: "Market data", hint: "Explore individual contracts and price curves",
    tabs: [{ path: "contracts", label: "Contracts", view: contracts }, { path: "curves", label: "Price curves", view: curves }] },
  { path: "compare", label: "Compare", view: compare, hint: "Compare the prices of two contracts" },
  { path: "opportunities", label: "Opportunities", view: opportunities, hint: "Days when a price difference looked unusual" },
  { path: "test", label: "Test strategy", view: test, hint: "Test a strategy on past market data" },
  { path: "results", label: "Results", view: results, hint: "Review profit, risk and the verdict" },
  { path: "data", label: "Data", hint: "Data health and data sources",
    tabs: [{ path: "health", label: "Data health", view: health }, { path: "sources", label: "Data sources", view: sources }] },
];

// Old links keep working.
const ALIASES = { overview: "home", contracts: "market/contracts", term: "market/curves", relative: "compare", signals: "opportunities",
  backtest: "test", performance: "results", quality: "data/health" };

const root = document.getElementById("view");
const navLinks = document.getElementById("nav-links");
navLinks.innerHTML = SECTIONS.map((s) => `<a href="#/${s.path}" data-path="${s.path}" title="${s.hint}">${s.label}</a>`).join("");

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
      pill.title = `Market data available from ${date(s.first_date)} to ${date(s.last_date)}`;
    }
  } catch (e) {
    pill.innerHTML = `<span class="dot err"></span><span>Server offline</span>`;
  }
}

function resolve() {
  let parts = (location.hash.replace(/^#\/?/, "") || "home").split("/").map(decodeURIComponent);
  if (ALIASES[parts[0]]) parts = [...ALIASES[parts[0]].split("/"), ...parts.slice(1)];
  const section = SECTIONS.find((s) => s.path === parts[0]) || SECTIONS[0];
  if (section.tabs) {
    const tab = section.tabs.find((t) => t.path === parts[1]) || section.tabs[0];
    return { section, tab, view: tab.view, params: section.tabs.some((t) => t.path === parts[1]) ? parts.slice(2) : parts.slice(1) };
  }
  return { section, view: section.view, params: parts.slice(1) };
}

async function route() {
  const { section, tab, view, params } = resolve();
  navLinks.querySelectorAll("a").forEach((a) => {
    const on = a.dataset.path === section.path;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  navLinks.classList.remove("open");
  cleanup();
  root.innerHTML = "";
  window.scrollTo(0, 0);
  let host = root;
  if (section.tabs) {
    root.innerHTML = `<nav class="subtabs" aria-label="${section.label}">${section.tabs.map((t) => `<a href="#/${section.path}/${t.path}" class="${t === tab ? "on" : ""}">${t.label}</a>`).join("")}</nav><div id="subview"></div>`;
    host = root.querySelector("#subview");
  }
  document.title = `${tab ? tab.label : section.label} · Aureon`;
  try {
    await view(host, params, { refreshStatus });
  } catch (e) {
    console.error(e);
    host.innerHTML = errorBox(e, true);
    host.querySelector("[data-retry]")?.addEventListener("click", route);
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

// ---------------------------------------------------------------- glossary drawer
const drawer = document.getElementById("glossary");
function openGlossary() {
  drawer.innerHTML = `<div class="drawer">${glossaryPanel()}</div>`;
  drawer.classList.add("open");
  const s = drawer.querySelector("#gl-search");
  s.focus();
  s.addEventListener("input", () => {
    const q = s.value.toLowerCase();
    drawer.querySelectorAll(".gl-item").forEach((it) => (it.style.display = it.textContent.toLowerCase().includes(q) ? "" : "none"));
  });
  drawer.querySelector("#gl-close").addEventListener("click", closeGlossary);
}
function closeGlossary() { drawer.classList.remove("open"); }
document.getElementById("help-btn").addEventListener("click", openGlossary);
drawer.addEventListener("click", (e) => { if (e.target === drawer) closeGlossary(); });

// ---------------------------------------------------------------- command palette (⌘K / Ctrl+K)
const pal = document.getElementById("palette");
const palInput = document.getElementById("palette-input");
const palItems = document.getElementById("palette-items");
let palSel = 0, palList = [];
function paletteEntries() {
  const items = [];
  for (const s of SECTIONS) {
    if (s.tabs) for (const t of s.tabs) items.push({ label: t.label, hint: s.label, go: `#/${s.path}/${t.path}` });
    else items.push({ label: s.label, hint: s.hint, go: `#/${s.path}` });
  }
  for (let i = 0; i < RESEARCH.length; i++) for (let j = i + 1; j < RESEARCH.length; j++)
    items.push({ label: `Compare ${RESEARCH[i]} with ${RESEARCH[j]}`, hint: "Compare", go: `#/compare/${RESEARCH[i]}/${RESEARCH[j]}` });
  for (const s of [...RESEARCH, "GOLD"]) items.push({ label: `${s} price curve`, hint: "Market data", go: `#/market/curves/${s}` });
  for (const g of Object.values(GLOSSARY)) items.push({ label: g.t, hint: "Glossary", glossary: true });
  return items;
}
function renderPalette() {
  const q = palInput.value.toLowerCase();
  palList = paletteEntries().filter((i) => i.label.toLowerCase().includes(q)).slice(0, 40);
  palSel = Math.min(palSel, Math.max(0, palList.length - 1));
  palItems.innerHTML = palList.length ? palList.map((i, k) => `<div class="item ${k === palSel ? "on" : ""}" data-k="${k}" role="option"><span>${i.label}</span><span class="caption">${i.hint}</span></div>`).join("")
    : `<div class="item">No matches</div>`;
  palItems.querySelectorAll(".item[data-k]").forEach((n) => n.addEventListener("click", () => go(palList[+n.dataset.k])));
}
function openPalette() { pal.classList.add("open"); palInput.value = ""; palSel = 0; renderPalette(); palInput.focus(); }
function closePalette() { pal.classList.remove("open"); }
function go(item) {
  closePalette();
  if (!item) return;
  if (item.glossary) { openGlossary(); const s = drawer.querySelector("#gl-search"); s.value = item.label; s.dispatchEvent(new Event("input")); return; }
  location.hash = item.go;
}
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
  if (e.key === "Escape") closeGlossary();
});

installHelp();
refreshStatus();
route();
