// Minimal, dependency-free SVG charting for the research terminal.
// Features: multi-series lines / areas / bands / bars / dots, dual y-axes, reference lines, markers,
// crosshair tooltip, drag-to-zoom (double-click to reset), synced x-domains across charts, and
// explicit gaps: a line is broken at missing values or calendar gaps instead of being interpolated.
import { esc, isNum } from "./format.js";

const NS = "http://www.w3.org/2000/svg";
const DAY = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const syncGroups = new Map();

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export function niceTicks(min, max, count = 5) {
  if (!isNum(min) || !isNum(max)) return [];
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function timeTicks(min, max, maxTicks) {
  const spanDays = (max - min) / DAY;
  const monthSteps = [1, 2, 3, 6, 12, 24];
  if (spanDays / 7 <= maxTicks) {
    const step = spanDays <= maxTicks ? 1 : spanDays / 7 <= maxTicks ? 7 : 14;
    const out = [];
    const start = new Date(min); start.setHours(0, 0, 0, 0);
    for (let t = start.getTime(); t <= max; t += step * DAY) if (t >= min) out.push(t);
    return { ticks: out, fmt: (t) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; } };
  }
  const months = spanDays / 30.4;
  const ms = monthSteps.find((s) => months / s <= maxTicks) || 48;
  const d0 = new Date(min);
  let y = d0.getFullYear(), m = d0.getMonth();
  m = Math.ceil(m / ms) * ms; while (m >= 12) { m -= 12; y++; }
  const out = [];
  for (let i = 0; i < 400; i++) {
    const t = new Date(y, m, 1).getTime();
    if (t > max) break;
    if (t >= min) out.push(t);
    m += ms; while (m >= 12) { m -= 12; y++; }
  }
  return { ticks: out, fmt: (t) => { const d = new Date(t); return ms >= 12 ? String(d.getFullYear()) : `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`; } };
}

function bisect(arr, x) {
  let lo = 0, hi = arr.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < x) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(arr[lo - 1][0] - x) < Math.abs(arr[lo][0] - x)) return lo - 1;
  return lo;
}

export function lineChart(container, options) {
  const state = { opts: options, domain: null };
  container.classList.add("chart");
  container.innerHTML = "";
  const svg = el("svg", {}, container);
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  container.appendChild(tip);

  const group = options.syncKey ? (syncGroups.get(options.syncKey) || syncGroups.set(options.syncKey, new Set()).get(options.syncKey)) : null;
  const api = {
    update(o) { state.opts = { ...state.opts, ...o }; render(); },
    setDomain(d, silent) { state.domain = d; render(); if (!silent && group) group.forEach((c) => c !== api && c.setDomain(d, true)); },
    destroy() { ro.disconnect(); window.removeEventListener("mouseup", up); if (group) group.delete(api); },
  };
  const up = (ev) => state.onUp && state.onUp(ev);
  window.addEventListener("mouseup", up);
  if (group) group.add(api);

  function render() {
    const o = state.opts;
    const W = Math.max(280, container.clientWidth || 600);
    const H = o.height || 260;
    const hasRight = o.series.some((s) => s.axis === "right");
    const M = { l: o.marginLeft ?? 60, r: hasRight ? 60 : 14, t: 10, b: o.xType === "number" ? 34 : 24 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", H);
    svg.innerHTML = "";
    const series = o.series.filter((s) => s.data && s.data.length);
    if (!series.length) {
      el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "axis-text" }, svg).textContent = o.emptyText || "No data";
      return;
    }
    let xmin = Infinity, xmax = -Infinity;
    for (const s of series) for (const p of s.data) { if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0]; }
    if (o.xDomain) [xmin, xmax] = o.xDomain;
    if (state.domain) [xmin, xmax] = state.domain;
    if (xmin === xmax) { xmin -= o.xType === "number" ? 1 : DAY; xmax += o.xType === "number" ? 1 : DAY; }

    const yr = { left: [Infinity, -Infinity], right: [Infinity, -Infinity] };
    for (const s of series) {
      const r = yr[s.axis === "right" ? "right" : "left"];
      for (const p of s.data) {
        if (p[0] < xmin || p[0] > xmax) continue;
        for (let k = 1; k < p.length; k++) if (isNum(p[k])) { if (p[k] < r[0]) r[0] = p[k]; if (p[k] > r[1]) r[1] = p[k]; }
      }
    }
    for (const h of o.hlines || []) if (h.include !== false && isNum(h.y)) { const r = yr[h.axis === "right" ? "right" : "left"]; r[0] = Math.min(r[0], h.y); r[1] = Math.max(r[1], h.y); }
    for (const k of ["left", "right"]) {
      let [a, b] = yr[k];
      if (!isNum(a)) { a = 0; b = 1; }
      if (o.yZero && k === "left") { a = Math.min(a, 0); b = Math.max(b, 0); }
      const pad = (b - a) * 0.06 || Math.abs(a) * 0.01 || 1;
      yr[k] = [a - pad, b + pad];
    }
    const ix = (x) => M.l + ((x - xmin) / (xmax - xmin)) * (W - M.l - M.r);
    const iy = (y, ax = "left") => { const [a, b] = yr[ax]; return M.t + (1 - (y - a) / (b - a)) * (H - M.t - M.b); };
    const xinv = (px) => xmin + ((px - M.l) / (W - M.l - M.r)) * (xmax - xmin);

    // grid + axes
    const yt = niceTicks(yr.left[0], yr.left[1], Math.max(3, Math.floor((H - 40) / 48)));
    const fy = o.yFormat || ((v) => v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
    for (const t of yt) {
      el("line", { x1: M.l, x2: W - M.r, y1: iy(t), y2: iy(t), class: "grid-line" }, svg);
      el("text", { x: M.l - 8, y: iy(t) + 3.5, "text-anchor": "end", class: "axis-text" }, svg).textContent = fy(t);
    }
    if (hasRight) {
      const fr = o.yFormatRight || fy;
      for (const t of niceTicks(yr.right[0], yr.right[1], Math.max(3, Math.floor((H - 40) / 48))))
        el("text", { x: W - M.r + 8, y: iy(t, "right") + 3.5, class: "axis-text" }, svg).textContent = fr(t);
    }
    if (yr.left[0] < 0 && yr.left[1] > 0) el("line", { x1: M.l, x2: W - M.r, y1: iy(0), y2: iy(0), class: "zero" }, svg);
    if (o.xType === "number") {
      for (const t of niceTicks(xmin, xmax, Math.floor((W - M.l - M.r) / 80)))
        el("text", { x: ix(t), y: H - M.b + 16, "text-anchor": "middle", class: "axis-text" }, svg).textContent = (o.xFormat || String)(t);
      if (o.xLabel) el("text", { x: (M.l + W - M.r) / 2, y: H - 2, "text-anchor": "middle", class: "axis-text" }, svg).textContent = o.xLabel;
    } else {
      const { ticks, fmt } = timeTicks(xmin, xmax, Math.max(2, Math.floor((W - M.l - M.r) / 84)));
      for (const t of ticks) el("text", { x: ix(t), y: H - 6, "text-anchor": "middle", class: "axis-text" }, svg).textContent = fmt(t);
    }

    const clipId = "c" + Math.random().toString(36).slice(2);
    const cp = el("clipPath", { id: clipId }, el("defs", {}, svg));
    el("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b }, cp);
    const plot = el("g", { "clip-path": `url(#${clipId})` }, svg);

    for (const v of o.vlines || []) {
      if (v.x < xmin || v.x > xmax) continue;
      el("line", { x1: ix(v.x), x2: ix(v.x), y1: M.t, y2: H - M.b, stroke: v.color || "var(--border-strong)", "stroke-dasharray": v.dash || "2 3", "stroke-width": 1 }, plot);
    }
    for (const r of o.regions || []) {
      const x1 = ix(Math.max(r.x0, xmin)), x2 = ix(Math.min(r.x1, xmax));
      if (x2 > x1) el("rect", { x: x1, y: M.t, width: x2 - x1, height: H - M.t - M.b, fill: r.color || "var(--surface-3)", opacity: r.opacity ?? 0.5 }, plot);
    }

    const gapMs = (o.gapDays ?? 6) * DAY;
    for (const s of series) {
      const ax = s.axis === "right" ? "right" : "left";
      const pts = s.data;
      const broken = (i) => i > 0 && (o.xType !== "number" && pts[i][0] - pts[i - 1][0] > gapMs || (s.breakAt && s.breakAt(pts[i - 1], pts[i])));
      if (s.kind === "band") {
        let segs = [], cur = [];
        pts.forEach((p, i) => { if (!isNum(p[1]) || !isNum(p[2]) || broken(i)) { if (cur.length) segs.push(cur); cur = []; } if (isNum(p[1]) && isNum(p[2])) cur.push(p); });
        if (cur.length) segs.push(cur);
        for (const seg of segs) {
          const d = seg.map((p, i) => `${i ? "L" : "M"}${ix(p[0]).toFixed(1)},${iy(p[2], ax).toFixed(1)}`).join("") +
            seg.slice().reverse().map((p) => `L${ix(p[0]).toFixed(1)},${iy(p[1], ax).toFixed(1)}`).join("") + "Z";
          el("path", { d, fill: s.color || "var(--c-band)", stroke: "none" }, plot);
        }
        continue;
      }
      if (s.kind === "bars") {
        const xs = pts.map((p) => ix(p[0]));
        let minGap = Infinity; for (let i = 1; i < xs.length; i++) minGap = Math.min(minGap, xs[i] - xs[i - 1]);
        const bw = Math.max(1, Math.min(14, (isFinite(minGap) ? minGap : 8) * 0.7));
        const y0 = iy(0, ax);
        for (const p of pts) {
          if (!isNum(p[1]) || p[0] < xmin || p[0] > xmax) continue;
          const y = iy(p[1], ax);
          el("rect", { x: ix(p[0]) - bw / 2, y: Math.min(y, y0), width: bw, height: Math.max(0.5, Math.abs(y - y0)),
            fill: typeof s.color === "function" ? s.color(p) : s.color }, plot);
        }
        continue;
      }
      if (s.kind === "dots") {
        for (const p of pts) if (isNum(p[1])) el("circle", { cx: ix(p[0]), cy: iy(p[1], ax), r: s.r || 2.5, fill: typeof s.color === "function" ? s.color(p) : s.color, opacity: s.opacity ?? 0.9 }, plot);
        continue;
      }
      let d = "", pen = false;
      pts.forEach((p, i) => {
        if (!isNum(p[1]) || broken(i)) pen = false;
        if (!isNum(p[1])) return;
        d += `${pen ? "L" : "M"}${ix(p[0]).toFixed(1)},${iy(p[1], ax).toFixed(1)}`;
        pen = true;
      });
      if (s.kind === "area") {
        // fill only between contiguous runs and the baseline
        const runs = d.split("M").filter(Boolean);
        for (const r of runs) {
          const coords = r.split("L");
          const first = coords[0].split(","), last = coords[coords.length - 1].split(",");
          el("path", { d: `M${r}L${last[0]},${iy(o.areaBase ?? yr[ax][0], ax)}L${first[0]},${iy(o.areaBase ?? yr[ax][0], ax)}Z`, fill: s.fill || s.color, opacity: s.fillOpacity ?? 0.12, stroke: "none" }, plot);
        }
      }
      el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 1.5, "stroke-dasharray": s.dash, "stroke-linejoin": "round", opacity: s.opacity ?? 1 }, plot);
      if (s.points) for (const p of pts) if (isNum(p[1])) el("circle", { cx: ix(p[0]), cy: iy(p[1], ax), r: 2.6, fill: s.color }, plot);
    }

    for (const h of o.hlines || []) {
      if (!isNum(h.y)) continue;
      const ax = h.axis === "right" ? "right" : "left";
      el("line", { x1: M.l, x2: W - M.r, y1: iy(h.y, ax), y2: iy(h.y, ax), stroke: h.color || "var(--muted)", "stroke-dasharray": h.dash || "4 4", "stroke-width": 1 }, plot);
      if (h.label) el("text", { x: W - M.r - 4, y: iy(h.y, ax) - 4, "text-anchor": "end", class: "axis-text" }, plot).textContent = h.label;
    }
    for (const mk of o.markers || []) {
      if (mk.x < xmin || mk.x > xmax || !isNum(mk.y)) continue;
      const x = ix(mk.x), y = iy(mk.y, mk.axis || "left"), c = mk.color || "var(--text)";
      if (mk.shape === "up") el("path", { d: `M${x},${y - 6}L${x + 5},${y + 3}L${x - 5},${y + 3}Z`, fill: c }, plot);
      else if (mk.shape === "down") el("path", { d: `M${x},${y + 6}L${x + 5},${y - 3}L${x - 5},${y - 3}Z`, fill: c }, plot);
      else if (mk.shape === "x") el("path", { d: `M${x - 4},${y - 4}L${x + 4},${y + 4}M${x + 4},${y - 4}L${x - 4},${y + 4}`, stroke: c, "stroke-width": 1.6 }, plot);
      else el("circle", { cx: x, cy: y, r: 3.5, fill: "var(--surface)", stroke: c, "stroke-width": 1.6 }, plot);
    }

    // interaction layer
    const cross = el("line", { y1: M.t, y2: H - M.b, class: "crosshair", visibility: "hidden" }, svg);
    const zr = el("rect", { y: M.t, height: H - M.t - M.b, class: "zoom-rect", visibility: "hidden" }, svg);
    const ov = el("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: "transparent", style: "cursor:crosshair" }, svg);
    const primary = series.reduce((a, b) => (b.data.length > a.data.length && b.kind !== "band" ? b : a), series[0]);
    let dragX = null;
    const localX = (ev) => { const r = svg.getBoundingClientRect(); return ((ev.clientX - r.left) / r.width) * W; };
    ov.addEventListener("mousemove", (ev) => {
      const px = localX(ev);
      if (dragX !== null) { zr.setAttribute("x", Math.min(px, dragX)); zr.setAttribute("width", Math.abs(px - dragX)); zr.setAttribute("visibility", "visible"); }
      const x = xinv(px);
      const i = bisect(primary.data, x);
      if (i < 0) return;
      const xs = primary.data[i][0];
      cross.setAttribute("x1", ix(xs)); cross.setAttribute("x2", ix(xs)); cross.setAttribute("visibility", "visible");
      const fx = o.xType === "number" ? (o.xFormat || String) : (t) => { const d = new Date(t); return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
      let html = `<div class="t">${esc(fx(xs))}</div>`;
      for (const s of series) {
        if (s.tooltip === false) continue;
        const j = bisect(s.data, xs);
        const p = j >= 0 ? s.data[j] : null;
        const near = p && (o.xType === "number" ? p[0] === xs : Math.abs(p[0] - xs) < DAY * 0.5);
        const f = s.format || (s.axis === "right" ? o.yFormatRight : null) || fy;
        const val = near ? (s.kind === "band" ? `${f(p[1])} – ${f(p[2])}` : (isNum(p[1]) ? f(p[1]) : "—")) : "—";
        const col = typeof s.color === "function" ? "var(--text-2)" : s.color;
        html += `<div class="r"><span><i class="swatch" style="background:${col}"></i> ${esc(s.name || "")}</span><span>${esc(val)}</span></div>`;
      }
      if (o.tooltipExtra) html += o.tooltipExtra(xs) || "";
      tip.innerHTML = html;
      tip.style.display = "block";
      const cw = container.clientWidth, sx = (ix(xs) / W) * cw;
      tip.style.left = (sx + 14 + tip.offsetWidth > cw ? sx - tip.offsetWidth - 14 : sx + 14) + "px";
      tip.style.top = "8px";
    });
    ov.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); tip.style.display = "none"; });
    if (o.zoom !== false && o.xType !== "number") {
      ov.addEventListener("mousedown", (ev) => { dragX = localX(ev); ev.preventDefault(); });
      state.onUp = (ev) => {
        if (dragX === null) return;
        const px = localX(ev), a = Math.min(px, dragX), b = Math.max(px, dragX);
        dragX = null; zr.setAttribute("visibility", "hidden");
        if (b - a > 8) api.setDomain([xinv(a), xinv(b)]);
      };
      ov.addEventListener("dblclick", () => api.setDomain(null));
    }
  }

  const ro = new ResizeObserver(() => render());
  ro.observe(container);
  render();
  return api;
}

export function legend(items) {
  return `<div class="legend">${items.map((i) => `<span><i style="background:${i.color};${i.dash ? "height:0;border-top:2px dashed " + i.color : ""}"></i>${esc(i.name)}</span>`).join("")}</div>`;
}
