// One-command e2e runner: `npm run e2e`.
//
// Starts a throwaway server on its own port, then runs each browser suite in a
// *unique room* (via BABBLA_URL=.../room/<unique>) so suites can't contaminate
// each other (the shared-room flakiness that previously caused false failures).
// Each suite is a child process; its exit code decides pass/fail. The server is
// torn down at the end. Assumes Chrome is available for the puppeteer suites.
//
// Suites run *in parallel* with a bounded concurrency pool (the suites are fully
// isolated — unique rooms, and each launches its own separate browser instances,
// so separate suite processes never share a renderer). This is the main lever on
// wall-clock time: running them one-by-one took several minutes. Tune with
// E2E_CONCURRENCY (default: CPU count, capped at 4). Per-suite output is buffered
// and flushed as one block when the suite finishes so the parallel logs stay
// readable instead of interleaving line-by-line.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { availableParallelism } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.E2E_PORT) || 8091;
const BASE = `http://localhost:${PORT}`;

// Concurrency: enough to hide the per-suite browser startup/WebRTC-handshake
// latency, but bounded so a 4-core box isn't thrashing (each suite launches
// 1–3 Chrome instances, each itself multi-process). Override with E2E_CONCURRENCY
// (a positive integer; a non-numeric/invalid value falls back to the default).
const DEFAULT_CONCURRENCY = Math.min(availableParallelism() || 4, 4);
const envConcurrency = Math.floor(Number(process.env.E2E_CONCURRENCY));
const CONCURRENCY =
  Number.isFinite(envConcurrency) && envConcurrency > 0
    ? envConcurrency
    : DEFAULT_CONCURRENCY;

// Ordered longest-running first (rough, measured): with a bounded pool the
// makespan is dominated by the slowest suite, so dispatching the long ones up
// front lets them overlap with everything else instead of tailing the run.
// mute-stability deliberately idles ~45s; the mute-* media suites are next.
const SUITES = [
  "mute-stability-test.mjs",
  "mute-bandwidth-test.mjs",
  "mute-presence-test.mjs",
  "dnd-test.mjs",
  "camera-focus-quality-test.mjs",
  "baseline-camera-bitrate-test.mjs",
  "ice-restart-recovery-test.mjs",
  "offer-retransmit-heal-test.mjs",
  "reconnect-video-repro.mjs",
  "camera-role-after-suppress-test.mjs",
  "gallery-regression-test.mjs",
  "stage-fit-test.mjs",
  "noise-reduction-test.mjs",
  "noise-info-modal-test.mjs",
  "room-chooser-test.mjs",
  "onboarding-modal-pause-test.mjs",
  "fs-controls-menu-test.mjs",
  "speaker-startup-test.mjs",
  "device-stack-demo.mjs",
  "ios-device-pickers-test.mjs",
  "ios-standalone-bg-test.mjs",
  "stats-smoke-test.mjs",
  "pip-test.mjs",
  "pip-background-test.mjs",
  // Self-contained: boot their own coturn + server (skip if coturn absent).
  "relay-fallback-test.mjs",
  "relay-stuck-recovery-test.mjs",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

// Run one suite, buffering its output so parallel suites don't interleave.
// Resolve on `close` (fires after the piped stdio is fully drained, so the
// buffered output isn't truncated) and on `error` (a spawn failure — e.g. a
// missing `node` — never emits `exit`/`close`, so without this the promise
// would hang the whole run forever).
function runSuite(file, room) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (code, extra = "") => {
      if (settled) return;
      settled = true;
      resolve({ file, room, code, output: output + extra, ms: Date.now() - started });
    };
    let output = "";
    const child = spawn("node", [join("scripts", file)], {
      cwd: ROOT,
      env: { ...process.env, BABBLA_URL: `${BASE}/room/${room}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (err) => finish(1, `\n[e2e] failed to spawn suite: ${err.message}\n`));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function reportSuite({ file, room, code, output, ms }) {
  const secs = (ms / 1000).toFixed(1);
  console.log(`\n=== ${file}  (room: ${room}, ${secs}s) ===`);
  process.stdout.write(output.endsWith("\n") || output === "" ? output : output + "\n");
  if (code !== 0) console.log(`FAILED: ${file} (exit ${code})`);
}

const server = spawn("node", ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});

let failed = 0;
const startedAll = Date.now();
try {
  if (!(await waitForServer())) {
    console.error(`e2e: server never came up on ${BASE}`);
    failed = SUITES.length;
  } else {
    console.log(`Running ${SUITES.length} e2e suites with concurrency ${CONCURRENCY}…`);
    const queue = [...SUITES];
    async function worker() {
      while (queue.length) {
        const file = queue.shift();
        const room = `test-${file.replace(/\.mjs$/, "").replace(/\W+/g, "-")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const result = await runSuite(file, room);
        reportSuite(result);
        if (result.code !== 0) failed++;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, SUITES.length) }, () => worker()),
    );
    const secs = ((Date.now() - startedAll) / 1000).toFixed(1);
    console.log(`\n${SUITES.length - failed}/${SUITES.length} e2e suites passed (${secs}s)`);
  }
} finally {
  try {
    server.kill("SIGTERM");
  } catch {}
}

process.exit(failed ? 1 : 0);
