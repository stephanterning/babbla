// Sessions overview — one row per session for a single day, laid out on a
// horizontally scrollable 00–24 time axis with a fixed 10-hour zoom (default
// focus 08–18). Rendered as HTML/CSS (not SVG) because the frozen label column +
// horizontal/vertical scroll is trivial with `position: sticky`. Clicking a row
// (whole row is the hit target) selects that session. See
// .cursor/plans/stats-poc.md (sessions-utforskaren).

import { fmtClock, fmtDur, shortHash } from "./format.js";

const LABEL_W = 190; // frozen left column width (px)
const MIN_BAR = 7; // min bar width so short sessions stay visible/clickable
const FOCUS_HOURS = 10; // 08–18 fills the visible time area
const DAY_HOURS = 24;

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {object[]} opts.sessions  [{roomSessionId, roomHash, start, end, participants, hadRelay}]
 * @param {number} opts.dayStart    ms at 00:00 local
 * @param {number} opts.focusStart  ms at 08:00 local (default scroll position)
 * @param {string|null} opts.selectedId
 * @param {(id: string) => void} opts.onSelect
 */
export function renderOverview(container, { sessions, dayStart, focusStart, selectedId, onSelect }) {
  container.textContent = "";
  if (!sessions.length) return;

  const dayMs = DAY_HOURS * 3600_000;
  const dayEnd = dayStart + dayMs;
  // Width so the 10h focus window fills the visible time area.
  const visibleTimeW = Math.max(320, (container.clientWidth || 800) - LABEL_W);
  const dayWidth = Math.round(visibleTimeW * (DAY_HOURS / FOCUS_HOURS));
  const xRel = (t) => ((clamp(t, dayStart, dayEnd) - dayStart) / dayMs) * dayWidth;

  const scroll = elx("div", "sessions-scroll");
  const inner = elx("div", "sessions-inner");
  inner.style.width = `${LABEL_W + dayWidth}px`;

  // --- axis header (sticky top) ---
  const axisRow = elx("div", "sessions-axis-row");
  const corner = elx("div", "sessions-corner");
  corner.textContent = `${sessions.length} sessioner`;
  const axis = elx("div", "sessions-axis");
  axis.style.width = `${dayWidth}px`;
  for (let h = 0; h <= DAY_HOURS; h += 2) {
    const x = (h / DAY_HOURS) * dayWidth;
    const tick = elx("span", "axis-tick");
    tick.style.left = `${x}px`;
    tick.textContent = String(h).padStart(2, "0");
    axis.appendChild(tick);
    const line = elx("span", "axis-line");
    line.style.left = `${x}px`;
    axis.appendChild(line);
  }
  axisRow.append(corner, axis);
  inner.appendChild(axisRow);

  // --- one row per session ---
  for (const s of sessions) {
    const row = elx("div", "srow");
    row.dataset.id = s.roomSessionId;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    if (s.roomSessionId === selectedId) row.classList.add("selected");

    const label = elx("div", "slabel");
    const main = elx("span", "slabel-main");
    main.textContent = `${fmtClock(s.start)} · ${s.participants} p`;
    const sub = elx("span", "slabel-sub");
    sub.textContent = `${shortHash(s.roomHash)} · ${fmtDur(s.end - s.start)}`;
    label.append(main, sub);
    if (s.hadRelay) {
      const dot = elx("i", "relay-dot");
      dot.title = "Minst ett par gick via relä (TURN)";
      label.appendChild(dot);
    }

    const time = elx("div", "stime");
    time.style.width = `${dayWidth}px`;
    const bar = elx("div", "sbar");
    if (s.hadRelay) bar.classList.add("relay");
    const left = xRel(s.start);
    bar.style.left = `${left}px`;
    bar.style.width = `${Math.max(MIN_BAR, xRel(s.end) - left)}px`;
    bar.title = `${fmtClock(s.start)}–${fmtClock(s.end)} · ${s.participants} deltagare · ${fmtDur(s.end - s.start)}`;
    time.appendChild(bar);

    row.append(label, time);
    row.addEventListener("click", () => onSelect(s.roomSessionId));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(s.roomSessionId);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const rows = [...inner.querySelectorAll(".srow")];
        const i = rows.indexOf(row);
        const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          next.focus();
          onSelect(next.dataset.id);
        }
      }
    });
    inner.appendChild(row);
  }

  scroll.appendChild(inner);
  container.appendChild(scroll);
  // Default scroll: position 08:00 at the left of the time viewport (the sticky
  // label doesn't consume scroll, so scrollLeft maps directly to time-content x).
  scroll.scrollLeft = xRel(focusStart);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function elx(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}
