// Sessions explorer orchestration: day navigation (viewer-local timezone),
// fetch the day's sessions, render the overview, and on row-select fetch +
// render that session's detailed swimlane (reusing timeline.js). See
// .cursor/plans/stats-poc.md (sessions-utforskaren).

import { renderOverview } from "./overview.js";
import { renderTimeline, TIMELINE_LEGEND } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const DAY_MS = 24 * 3600_000;
const HOUR = 3600_000;

// --- local-timezone day helpers -------------------------------------------
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function toInputValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fromInputValue(v) {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d).getTime(); // local midnight
}
function dayLabel(ms) {
  return new Date(ms).toLocaleDateString("sv-SE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// --- state -----------------------------------------------------------------
let day = startOfDay(Date.now());
let sessions = [];
let selectedId = null;
let lastTimeline = null;

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

function renderCurrentOverview() {
  renderOverview($("overview"), {
    sessions,
    dayStart: day,
    focusStart: day + 8 * HOUR,
    selectedId,
    onSelect: pickSession,
  });
}

async function loadDay() {
  $("day-label").textContent = dayLabel(day);
  $("date-input").value = toInputValue(day);
  $("date-input").max = toInputValue(startOfDay(Date.now()));
  $("next-day").disabled = day >= startOfDay(Date.now());

  setStatus("laddar…");
  try {
    const data = await getJson(`/stats/api/sessions?from=${day}&to=${day + DAY_MS}`);
    sessions = (data.sessions || []).sort((a, b) => a.start - b.start); // earliest on top
  } catch (e) {
    sessions = [];
    setStatus(`kunde inte ladda: ${e.message}`, true);
  }

  const empty = sessions.length === 0;
  $("empty-note").hidden = !empty;
  $("overview").hidden = empty;
  if (empty) {
    selectedId = null;
    lastTimeline = null;
    renderTimeline($("detail"), null);
    setStatus("inga sessioner");
    return;
  }
  // Keep the current selection if it survived the (re)load — so Uppdatera on the
  // same day doesn't jump away; otherwise auto-select the day's earliest.
  selectedId = sessions.some((s) => s.roomSessionId === selectedId)
    ? selectedId
    : sessions[0].roomSessionId;
  renderCurrentOverview();
  setStatus(`${sessions.length} sessioner`);
  loadDetail(selectedId);
}

function pickSession(id) {
  selectedId = id;
  // Toggle highlight in place (no full re-render -> preserves scroll position).
  for (const row of $("overview").querySelectorAll(".srow")) {
    row.classList.toggle("selected", row.dataset.id === id);
  }
  loadDetail(id);
}

async function loadDetail(id) {
  if (!id) {
    lastTimeline = null;
    renderTimeline($("detail"), null);
    return;
  }
  try {
    const tl = await getJson(`/stats/api/timeline?session=${encodeURIComponent(id)}`);
    lastTimeline = tl && tl.participants ? tl : null;
  } catch {
    lastTimeline = null;
  }
  renderTimeline($("detail"), lastTimeline);
}

// Jump to the most recent day that has any sessions (used from the empty state).
async function gotoLatestActiveDay() {
  setStatus("söker senaste aktiva dag…");
  try {
    const now = Date.now();
    const data = await getJson(`/stats/api/sessions?from=${now - 365 * DAY_MS}&to=${now}`);
    if (!data.sessions?.length) {
      setStatus("inga sessioner alls ännu");
      return;
    }
    const latest = data.sessions.reduce((a, b) => (b.start > a.start ? b : a));
    day = startOfDay(latest.start);
    loadDay();
  } catch (e) {
    setStatus(`kunde inte söka: ${e.message}`, true);
  }
}

function renderLegend() {
  const wrap = $("legend");
  wrap.innerHTML = "";
  for (const item of TIMELINE_LEGEND) {
    const span = document.createElement("span");
    span.className = "legend-item";
    const dot = document.createElement("i");
    dot.style.background = item.color;
    span.appendChild(dot);
    span.appendChild(document.createTextNode(item.label));
    wrap.appendChild(span);
  }
}

function go(deltaDays) {
  const next = startOfDay(day + deltaDays * DAY_MS);
  if (next > startOfDay(Date.now())) return; // no future
  day = next;
  loadDay();
}

function init() {
  renderLegend();
  $("prev-day").addEventListener("click", () => go(-1));
  $("next-day").addEventListener("click", () => go(1));
  $("today-btn").addEventListener("click", () => {
    day = startOfDay(Date.now());
    loadDay();
  });
  $("date-input").addEventListener("change", (e) => {
    if (!e.target.value) return;
    const picked = startOfDay(fromInputValue(e.target.value));
    if (picked > startOfDay(Date.now())) return;
    day = picked;
    loadDay();
  });
  $("latest-active").addEventListener("click", gotoLatestActiveDay);
  $("refresh").addEventListener("click", () => loadDay());

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (sessions.length) renderCurrentOverview();
      renderTimeline($("detail"), lastTimeline);
    }, 150);
  });

  loadDay();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
