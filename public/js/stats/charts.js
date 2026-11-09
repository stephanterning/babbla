// Chart.js wrappers for the aggregate dashboard charts. Chart.js is loaded as a
// global (vendored UMD in /vendor) — see stats.html. Each builder destroys and
// recreates its chart on refresh (the data volume is tiny, so simplicity wins).

import { asnLabel } from "./format.js";

// X-axis labels stay readable across ~12 bars; the full name + AS number live in
// the tooltip, so truncating the visible tick is lossless.
function truncLabel(s, n = 18) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const C = {
  fg: "#e8eaed",
  muted: "#9aa0aa",
  accent: "#5b8cff",
  ok: "#43d17a",
  relay: "#b388ff",
  danger: "#ff5b6e",
  grid: "rgba(255,255,255,0.06)",
};

let defaultsSet = false;
function ensureDefaults() {
  if (defaultsSet || !window.Chart) return;
  const Chart = window.Chart;
  Chart.defaults.color = C.muted;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.font.family =
    "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
  defaultsSet = true;
}

const instances = new Map();
function render(canvas, config) {
  ensureDefaults();
  if (!window.Chart || !canvas) return;
  const prev = instances.get(canvas.id);
  if (prev) prev.destroy();
  instances.set(canvas.id, new window.Chart(canvas, config));
}

function clock(ms) {
  return new Date(ms).toLocaleString("sv-SE", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const baseOpts = (extra = {}) => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { boxWidth: 12 } } },
  ...extra,
});

// Latest concurrency series + zoom callback, read by the drag-to-zoom handlers
// (bound once per canvas, below) so they always act on the current data.
let concurrencySeries = [];
let onConcurrencyZoom = null;

export function concurrencyChart(canvas, series, onZoom) {
  concurrencySeries = series;
  onConcurrencyZoom = onZoom || null;
  const labels = series.map((p) => clock(p.t));
  render(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "deltagare", data: series.map((p) => p.participants), borderColor: C.accent, backgroundColor: "rgba(91,140,255,0.15)", fill: true, tension: 0.25, pointRadius: 0 },
        { label: "aktiva rum", data: series.map((p) => p.rooms), borderColor: C.ok, backgroundColor: "rgba(67,209,122,0.12)", fill: true, tension: 0.25, pointRadius: 0 },
        // Relaying pairs over time (a relay pair = up to two reläade users). Drawn
        // as a line (no fill) on the same count axis; its peak matches the
        // "max N samtidiga reläpar" card — both come from relayIntervals().
        { label: "samtidiga reläpar", data: series.map((p) => p.relayPairs ?? 0), borderColor: C.relay, fill: false, tension: 0.25, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: baseOpts({
      scales: {
        x: { ticks: { maxTicksLimit: 6, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    }),
  });
  bindConcurrencyZoom(canvas);
}

// Hand-rolled drag-select zoom: draw a selection band over the plot, map the
// dragged pixels to the underlying bucket timestamps, and hand [from,to] back to
// the dashboard (which re-fetches that window = finer detail). Bound once per
// canvas; reads the live chart instance + series on each drag. The x-axis is a
// category scale, so getValueForPixel(px) returns a (fractional) bucket index.
function bindConcurrencyZoom(canvas) {
  const box = canvas.parentNode;
  if (!box || box.dataset.zoomBound) return;
  box.dataset.zoomBound = "1";

  const sel = document.createElement("div");
  sel.className = "zoom-sel";
  box.appendChild(sel);

  let dragging = false;
  let startX = 0;
  const localX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  const hide = () => {
    dragging = false;
    sel.style.display = "none";
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !instances.get(canvas.id)) return;
    dragging = true;
    startX = localX(e);
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    sel.style.display = "block";
    sel.style.left = `${startX}px`;
    sel.style.width = "0px";
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const x = localX(e);
    sel.style.left = `${Math.min(startX, x)}px`;
    sel.style.width = `${Math.abs(x - startX)}px`;
  });

  canvas.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    const endX = localX(e);
    hide();
    const chart = instances.get(canvas.id);
    if (!chart || !onConcurrencyZoom || concurrencySeries.length < 2) return;
    if (Math.abs(endX - startX) < 10) return; // a click (read a tooltip), not a drag

    const xs = chart.scales.x;
    const toIdx = (px) => {
      const clamped = Math.max(xs.left, Math.min(xs.right, px));
      const i = Math.round(xs.getValueForPixel(clamped));
      return Math.max(0, Math.min(concurrencySeries.length - 1, i));
    };
    let i0 = toIdx(startX);
    let i1 = toIdx(endX);
    if (i0 > i1) [i0, i1] = [i1, i0];
    if (i1 <= i0) return; // need at least one bucket of span
    onConcurrencyZoom(concurrencySeries[i0].t, concurrencySeries[i1].t);
  });

  canvas.addEventListener("pointercancel", hide);
}

export function asnRelayChart(canvas, perAsn) {
  const rows = perAsn.slice(0, 12);
  // Label each bar by the network's org name (e.g. "Telia") rather than a bare AS
  // number; the full name + AS number are in the tooltip title.
  const labels = rows.map((r) => truncLabel(asnLabel(r)));
  render(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "reläade", data: rows.map((r) => r.relayed), backgroundColor: C.relay },
        { label: "totalt", data: rows.map((r) => r.total), backgroundColor: "rgba(154,160,170,0.4)" },
      ],
    },
    options: baseOpts({
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
      plugins: {
        legend: { labels: { boxWidth: 12 } },
        // Show the full org name + AS number on hover (the axis tick is truncated).
        tooltip: {
          callbacks: {
            title: (items) => asnLabel(rows[items[0]?.dataIndex] || {}, { withNumber: true }),
          },
        },
      },
    }),
  });
}
