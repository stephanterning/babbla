// Dashboard orchestration: fetches the read API, renders the live cards and the
// Chart.js aggregates. The per-session timeline lives on its own day-paginated
// page (/stats/sessions), which this dashboard links to. All read-only.

import { concurrencyChart, asnRelayChart } from "./charts.js";

const $ = (id) => document.getElementById(id);

// Drag-zoom on the concurrency chart scopes the WHOLE dashboard to an arbitrary
// [from,to] window (ms) instead of a preset range. While zoomed, a transient
// <option> in the interval menu shows the span; picking any preset clears it.
const CUSTOM = "__custom__";
let customWindow = null;

function fmtSpan(from, to) {
  const p = (n) => String(n).padStart(2, "0");
  const date = (x) => `${x.getDate()}/${x.getMonth() + 1}`;
  const time = (x) => `${p(x.getHours())}:${p(x.getMinutes())}`;
  const a = new Date(from);
  const b = new Date(to);
  return date(a) === date(b)
    ? `${date(a)} ${time(a)}–${time(b)}`
    : `${date(a)} ${time(a)}–${date(b)} ${time(b)}`;
}

function setCustomOption(label) {
  const sel = $("range");
  let opt = sel.querySelector(`option[value="${CUSTOM}"]`);
  if (!opt) {
    opt = document.createElement("option");
    opt.value = CUSTOM;
    sel.appendChild(opt);
  }
  opt.textContent = `⤢ ${label}`;
  sel.value = CUSTOM;
}

function clearCustomOption() {
  $("range").querySelector(`option[value="${CUSTOM}"]`)?.remove();
}

// Called by the concurrency chart when the user drag-selects a span.
function onZoom(fromTs, toTs) {
  customWindow = { from: Math.round(fromTs), to: Math.round(toTs) };
  setCustomOption(fmtSpan(customWindow.from, customWindow.to));
  refreshSummary();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg || "";
  el.classList.toggle("error", isError);
}

// --- live cards (polled) ---------------------------------------------------
async function refreshLive() {
  try {
    const live = await getJson("/stats/api/live");
    $("live-participants").textContent = live.participantsNow;
    $("live-rooms").textContent = live.roomsNow;
  } catch {
    $("live-participants").textContent = "–";
    $("live-rooms").textContent = "–";
  }
}

// --- summary (charts) ------------------------------------------------------
async function refreshSummary() {
  setStatus("laddar…");
  try {
    const url = customWindow
      ? `/stats/api/summary?from=${customWindow.from}&to=${customWindow.to}`
      : `/stats/api/summary?range=${encodeURIComponent($("range").value)}`;
    const data = await getJson(url);
    $("relay-pct").textContent = `${data.relay.pctWithRelay}%`;
    $("relay-detail").textContent =
      `${data.relay.participantsWithRelay}/${data.relay.totalParticipants} deltagare · max ${data.relay.maxConcurrentRelayPairs} samtidiga reläpar`;

    concurrencyChart($("chart-concurrency"), data.concurrency, onZoom);
    asnRelayChart($("chart-asn"), data.relay.perAsn);

    setStatus(`${data.totalEvents} händelser`);
  } catch (e) {
    setStatus(`kunde inte ladda statistik: ${e.message}`, true);
  }
}

function init() {
  $("range").addEventListener("change", () => {
    // Any preset selection drops out of a drag-zoomed custom window.
    if ($("range").value !== CUSTOM) {
      customWindow = null;
      clearCustomOption();
    }
    refreshSummary();
  });
  $("refresh").addEventListener("click", () => {
    refreshLive();
    refreshSummary();
  });

  refreshLive();
  refreshSummary();
  setInterval(refreshLive, 5000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
