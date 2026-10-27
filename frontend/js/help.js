// Plain-English explanations used across the app: inline ⓘ hints, page guides and the glossary panel.
import { esc } from "./format.js";

export const GLOSSARY = {
  contract: { t: "Futures contract", s: "An agreement to buy or sell gold at a set price on a future date (its expiry). Each MCX gold product lists several contracts with different expiry months." },
  goldm: { t: "GOLDM, GOLDTEN, GOLDGUINEA, GOLDPETAL", s: "Four MCX gold futures of different sizes: Gold Mini (100 g), Gold Ten (10 g), Gold Guinea (8 g) and Gold Petal (1 g). They all track gold, so their prices should line up once sizes are made comparable." },
  normalized: { t: "Comparable price (₹ per 10 g fine gold)", s: "Each product is quoted differently (per 10 g, per 8 g, per 1 g) and has slightly different purity. Aureon converts every price to rupees per 10 grams of pure gold so they can be compared directly." },
  spread: { t: "Price difference (spread)", s: "How much more or less one contract costs than another, after making them comparable. Shown in basis points: 100 bps = 1%." },
  bps: { t: "Basis point (bps)", s: "One hundredth of a percent. 100 bps = 1%, so a 25 bps difference means one price is 0.25% higher than the other." },
  zscore: { t: "How unusual (z-score)", s: "How far today's price difference is from its recent average, measured in typical day-to-day swings. 0 = normal; beyond ±2 is unusual (it happens roughly 5% of the time)." },
  percentile: { t: "Percentile", s: "Where today's difference ranks within the recent window. 95 means it is higher than 95% of recent days; 5 means lower than 95% of them." },
  lookback: { t: "History window", s: "How many recent trading days are used to decide what 'normal' looks like. Shorter windows react faster; longer windows are steadier." },
  halflife: { t: "Typical time to revert", s: "When the difference moves away from normal, roughly how many days it has historically taken to close half of that gap. It describes the past, not a promise." },
  carry: { t: "Carry adjustment", s: "Contracts expiring later usually cost a little more (financing and storage). Aureon removes that predictable effect so contracts with different expiry dates can be compared fairly." },
  expiry: { t: "Expiry", s: "The last trading day of a contract. Close to expiry, prices can behave oddly and positions risk physical delivery, so Aureon avoids trading contracts that are about to expire." },
  dte: { t: "Days to expiry", s: "Calendar days until a contract stops trading." },
  liquidity: { t: "Trading activity (liquidity)", s: "How much a contract actually trades. If few contracts change hands, you may not be able to buy or sell at the quoted price, so comparisons using thinly traded contracts are less practical." },
  openinterest: { t: "Open interest", s: "How many contracts are currently held open. Higher open interest usually means an active, easier-to-trade market." },
  volume: { t: "Volume", s: "How many lots traded that day." },
  lot: { t: "Lot", s: "The smallest quantity you can trade: 100 g for GOLDM, 10 g for GOLDTEN, 8 g for GOLDGUINEA, 1 g for GOLDPETAL." },
  residual: { t: "Unmatched gold (hedge residual)", s: "Because lot sizes and purities differ, the two sides of a trade almost never hold exactly the same amount of gold. The leftover amount still moves with the gold price." },
  signal: { t: "Signal", s: "A day when the price difference was unusual AND every practical check passed (enough history, enough trading, not near expiry, profit potential above costs). A signal is a research idea, not advice to trade." },
  costhurdle: { t: "Profit potential vs costs", s: "Aureon estimates how much could be gained if the difference returned to normal and compares it with brokerage, taxes, exchange fees and slippage. Ideas that cannot beat costs are rejected." },
  slippage: { t: "Slippage", s: "Getting a slightly worse price than quoted when you actually trade. Aureon assumes a set number of price ticks against you on every trade." },
  tick: { t: "Tick", s: "The smallest possible price step — ₹1 for these contracts." },
  backtest: { t: "Strategy test (backtest)", s: "Replaying the strategy day by day on past market data, as if you had followed it, including costs and realistic timing." },
  walkforward: { t: "Realistic test (walk-forward)", s: "The strategy's settings are chosen on one stretch of history, checked on the next, then judged on a later period it has never seen. This mimics real use and guards against settings that only fit the past." },
  oos: { t: "Unseen-data results (out-of-sample)", s: "Performance on historical data that was not used to develop or tune the strategy. This is the most honest measure of whether an idea works." },
  insample: { t: "Same-data results (in-sample)", s: "Performance on the same data used to set up the strategy. Usually looks better than reality." },
  netpnl: { t: "Net profit / loss", s: "Profit or loss after all modelled trading costs." },
  drawdown: { t: "Largest drop (max drawdown)", s: "The biggest fall from a previous high in account value — a measure of how painful the worst stretch was." },
  sharpe: { t: "Sharpe ratio", s: "Return per unit of risk (annualized). Above 1 is generally considered good; around 0 means returns did not compensate for the ups and downs." },
  tstat: { t: "Confidence (t-statistic)", s: "Whether the average trade result is distinguishable from luck. Below about 2, results could easily be random." },
  winrate: { t: "Win rate", s: "Share of trades that made money after costs." },
  directional: { t: "Gold-price effect", s: "Profit or loss caused by the overall gold price moving, because the two sides were not perfectly matched. Not part of the price-difference idea." },
  relative: { t: "Price-difference effect", s: "Profit or loss from the gap between the two contracts changing — the part the strategy is actually trying to capture." },
  margin: { t: "Margin", s: "Money the exchange requires you to keep aside while a position is open — roughly 6–10% of the position's value for MCX gold. Aureon assumes 8% for both sides. If this is larger than your account, the test isn't realistic." },
  turnover: { t: "Turnover", s: "Total value traded divided by capital — how actively the strategy trades." },
  termstructure: { t: "Price curve (term structure)", s: "Prices of the same product for different expiry dates, side by side. Usually later expiries cost more because of carry." },
  calendar: { t: "Calendar spread", s: "Price difference between two expiry months of the same product." },
  stale: { t: "Stale price", s: "A price published on a day with no trades. It is a reference value, not a price anyone actually traded at, so Aureon never uses it for comparisons or trades." },
  roll: { t: "Contract switch", s: "When the nearest contract gets close to expiry, comparisons move to the next one. Each switch is marked so you can see it." },
  verdict: { t: "Verdict", s: "Aureon's cautious summary of the evidence. It only calls a result positive when there are enough trades, profit after costs and statistical confidence." },
};

export function info(key, extra = "") {
  const g = GLOSSARY[key];
  if (!g) return "";
  return `<button type="button" class="info" data-term="${key}" aria-label="What is ${esc(g.t)}?">i</button>${extra}`;
}

/** Label followed by an ⓘ hint. */
export function term(label, key) {
  return `<span class="term">${esc(label)}${info(key)}</span>`;
}

// ---------------------------------------------------------------- page guides
export function pageGuide(id, { what, why, next }) {
  let open = true;
  try { open = localStorage.getItem("aureon.guide." + id) !== "closed"; } catch {}
  return `<details class="guide" data-guide="${id}" ${open ? "open" : ""}>
    <summary><span class="guide-icon">?</span>How to read this page</summary>
    <div class="guide-body">
      <div><span class="overline">What you see</span><p>${what}</p></div>
      <div><span class="overline">Why it matters</span><p>${why}</p></div>
      <div><span class="overline">What to do next</span><p>${next}</p></div>
    </div></details>`;
}

// ---------------------------------------------------------------- popover + glossary behaviour
let pop;
function hidePop() { if (pop) pop.style.display = "none"; }
function showPop(btn) {
  const g = GLOSSARY[btn.dataset.term];
  if (!g) return;
  if (!pop) { pop = document.createElement("div"); pop.className = "popover"; pop.setAttribute("role", "tooltip"); document.body.appendChild(pop); }
  pop.innerHTML = `<b>${esc(g.t)}</b><p>${esc(g.s)}</p>`;
  pop.style.display = "block";
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = r.top - h - 8;
  pop.style.left = left + "px";
  pop.style.top = top + window.scrollY + "px";
}

export function installHelp() {
  document.addEventListener("mouseover", (e) => { const b = e.target.closest(".info"); if (b) showPop(b); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest(".info")) hidePop(); });
  document.addEventListener("focusin", (e) => { const b = e.target.closest(".info"); if (b) showPop(b); });
  document.addEventListener("focusout", (e) => { if (e.target.closest(".info")) hidePop(); });
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".info");
    if (b) { e.preventDefault(); e.stopPropagation(); showPop(b); return; }
    hidePop();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hidePop(); });
  window.addEventListener("scroll", hidePop, { passive: true });
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.classList && d.classList.contains("guide")) {
      try { localStorage.setItem("aureon.guide." + d.dataset.guide, d.open ? "open" : "closed"); } catch {}
    }
  }, true);
}

export function glossaryPanel() {
  const items = Object.values(GLOSSARY).sort((a, b) => a.t.localeCompare(b.t));
  return `<div class="drawer-head"><h2>Glossary</h2><button class="icon-btn" id="gl-close" aria-label="Close">✕</button></div>
    <input class="input" id="gl-search" placeholder="Search terms…" style="font-family:var(--font-body)"/>
    <div class="gl-list" id="gl-list">${items.map((g) => `<div class="gl-item"><b>${esc(g.t)}</b><p>${esc(g.s)}</p></div>`).join("")}</div>`;
}
