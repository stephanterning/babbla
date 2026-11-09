// Session timeline — a hand-rolled SVG swimlane that "draws" one room session
// from its raw events: one lane per participant with a presence bar, overlaid
// camera/screen/mute spans, a transport-colored understrip (direct/relay), and
// discrete markers (camera-focus / video-suppress / camera-limit). Pair events
// show as a marker + tooltip in the source lane (connecting lines between lanes
// are a later iteration). See .cursor/plans/stats-poc.md (fråga 12).
//
// Chart.js is used for the aggregate charts; the timeline is its own SVG because
// a Gantt/swimlane with overlaid spans is awkward to force into Chart.js.

import { asnLabel } from "./format.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const COLORS = {
  presence: "#2c3240",
  // Cyan — deliberately distinct from `direct` (green) and `screen` (blue) so the
  // camera band and the direct-transport understrip don't read as the same color.
  camera: "#22d3ee",
  screen: "#5b8cff",
  mute: "#ff5b6e",
  direct: "#43d17a",
  relay: "#b388ff",
  unknown: "#6b7280",
  marker: "#f0b429",
  axis: "#9aa0aa",
  label: "#e8eaed",
};

const LANE_H = 48; // total height per participant lane
const BAR_H = 16; // presence bar height
const TOP = 34; // top axis area
const LEFT = 150; // left gutter for labels
const RIGHT = 16;

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDur(ms) {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m} min ${rs} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

function shortId(id) {
  return String(id || "?").slice(0, 6);
}

function title(node, text) {
  node.appendChild(el("title", {}, text));
  return node;
}

/**
 * Render a session timeline into `container`.
 * @param {HTMLElement} container
 * @param {object|null} tl sessionTimeline payload from /stats/api/timeline
 */
export function renderTimeline(container, tl) {
  container.textContent = "";
  if (!tl || !tl.participants || !tl.participants.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Ingen sessionsdata.";
    container.appendChild(empty);
    return;
  }

  const { start, end, participants } = tl;
  const span = Math.max(1, end - start);
  const width = Math.max(container.clientWidth || 900, 640);
  const innerW = width - LEFT - RIGHT;
  const height = TOP + participants.length * LANE_H + 12;
  const x = (t) => LEFT + ((t - start) / span) * innerW;
  const w = (a, b) => Math.max(1, ((Math.min(b, end) - Math.max(a, start)) / span) * innerW);

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height,
    role: "img",
    "aria-label": "Sessionstidslinje",
  });

  // --- time axis (a handful of ticks) ---
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = start + (span * i) / ticks;
    const tx = x(t);
    svg.appendChild(el("line", { x1: tx, y1: TOP - 8, x2: tx, y2: height - 6, stroke: "#1c1f27", "stroke-width": 1 }));
    svg.appendChild(el("text", { x: tx, y: 16, fill: COLORS.axis, "font-size": 11, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle" }, fmtClock(t)));
  }

  participants.forEach((p, i) => {
    const laneY = TOP + i * LANE_H;
    const barY = laneY + 8;

    // label
    const label = el("text", { x: 8, y: barY + BAR_H - 3, fill: COLORS.label, "font-size": 12 }, shortId(p.clientId));
    title(label, labelTooltip(p));
    svg.appendChild(label);
    const sub = el("text", { x: 8, y: barY + BAR_H + 12, fill: COLORS.axis, "font-size": 10 }, subLabel(p.meta));
    svg.appendChild(sub);

    // presence bars
    for (const iv of p.presence) {
      svg.appendChild(
        title(
          el("rect", { x: x(iv.start), y: barY, width: w(iv.start, iv.end), height: BAR_H, rx: 3, fill: COLORS.presence }),
          `Närvarande ${fmtClock(iv.start)}–${fmtClock(iv.end)} (${fmtDur(iv.end - iv.start)})`,
        ),
      );
    }

    // transport understrip: relay is attributed to the restrictive party, so a
    // relay strip means THIS participant's own network needed the relay (likely
    // restrictive NAT/firewall) — not merely that some link of theirs relayed.
    const strip = barY + BAR_H + 2;
    const segs = transportSegments(p.transport, start, end);
    for (const s of segs) {
      const when = `${fmtClock(s.start)}–${fmtClock(s.end)}`;
      const tip =
        s.classification === "relay"
          ? `Behövde relä (trolig restriktiv part)${s.relayPeers?.length ? " — via " + s.relayPeers.map((id) => shortId(id)).join(", ") : ""} ${when}`
          : `Transport: ${s.classification} ${when}`;
      svg.appendChild(
        title(
          el("rect", { x: x(s.start), y: strip, width: w(s.start, s.end), height: 3, fill: COLORS[s.classification] || COLORS.unknown }),
          tip,
        ),
      );
    }

    // camera spans (top third of the bar)
    for (const c of p.camera) {
      svg.appendChild(
        title(
          el("rect", { x: x(c.start), y: barY, width: w(c.start, c.end), height: 5, rx: 2, fill: COLORS.camera }),
          `Kamera ${fmtDur(c.end - c.start)}`,
        ),
      );
    }
    // screen spans (middle band)
    for (const s of p.screen) {
      svg.appendChild(
        title(
          el("rect", { x: x(s.start), y: barY + 6, width: w(s.start, s.end), height: 5, rx: 2, fill: COLORS.screen }),
          `Skärmdelning ${fmtDur(s.end - s.start)}`,
        ),
      );
    }
    // mute spans (bottom band)
    for (const m of p.mute) {
      svg.appendChild(
        title(
          el("rect", { x: x(m.start), y: barY + 12, width: w(m.start, m.end), height: 3, rx: 1, fill: COLORS.mute }),
          `Mutead ${fmtDur(m.end - m.start)}`,
        ),
      );
    }

    // discrete markers
    for (const mk of p.markers) {
      const mx = x(mk.t);
      svg.appendChild(
        title(
          el("circle", { cx: mx, cy: barY - 3, r: 3, fill: COLORS.marker }),
          `${mk.type}${mk.target ? " → " + shortId(mk.target) : ""} @ ${fmtClock(mk.t)}`,
        ),
      );
    }
  });

  container.appendChild(svg);
}

function transportSegments(transport, start, end) {
  if (!transport || !transport.length) return [];
  const sorted = [...transport].sort((a, b) => a.t - b.t);
  const segs = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i].t;
    const to = i + 1 < sorted.length ? sorted[i + 1].t : end;
    segs.push({
      start: from,
      end: to,
      classification: sorted[i].classification,
      relayPeers: sorted[i].relayPeers || [],
    });
  }
  return segs;
}

function labelTooltip(p) {
  const lines = [`Deltagare ${shortId(p.clientId)}`];
  const total = p.presence.reduce((a, iv) => a + (iv.end - iv.start), 0);
  lines.push(`Total tid: ${fmtDur(total)}`);
  if (p.meta?.asn) lines.push(`Nätverk: ${asnLabel(p.meta, { withNumber: true })}`);
  if (p.meta?.country) lines.push(`Land: ${p.meta.country}`);
  return lines.join("\n");
}

function subLabel(meta = {}) {
  const bits = [];
  if (meta.ua_browser) bits.push(meta.ua_browser);
  if (meta.ua_os) bits.push(meta.ua_os);
  if (meta.asn) bits.push(asnLabel(meta));
  return bits.join(" · ") || "—";
}

// Legend metadata for the dashboard to render alongside the timeline.
export const TIMELINE_LEGEND = [
  { label: "närvaro", color: COLORS.presence },
  { label: "kamera", color: COLORS.camera },
  { label: "skärm", color: COLORS.screen },
  { label: "mute", color: COLORS.mute },
  { label: "direkt", color: COLORS.direct },
  { label: "relä", color: COLORS.relay },
  { label: "händelse", color: COLORS.marker },
];
