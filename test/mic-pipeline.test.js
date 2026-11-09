// Tier-2 wiring tests for the mic pipeline (docs/noise-reduction.md). A fake
// AudioContext records node creation, graph connections, and worklet messages so
// we can assert the graph shape and — most importantly — the fail-open paths:
// the pipeline is everyone's outbound audio path, so it must NEVER yield silence.

import test from "node:test";
import assert from "node:assert/strict";

import { createMicPipeline } from "../public/js/mic-pipeline.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeRawStream(id = "raw") {
  return { id, getAudioTracks: () => [{ id: `${id}-track` }] };
}

// A fake Web Audio context that records the graph. `state` controls the post-
// resume state (suspended => silent => fail open); `addModule` controls whether
// the worklet "loads"; `throwOnSource` simulates an unbuildable graph.
function makeFakeAudio({
  state = "running",
  addModule = "resolve",
  throwOnSource = false,
  throwOnSourceCall = 0, // throw on the Nth createMediaStreamSource (e.g. 2 = rebuild)
} = {}) {
  const log = { connects: [], disconnects: 0, posts: [], created: [], closed: false, sourceCalls: 0 };
  const dest = { _kind: "dest", stream: { id: "processed" } };
  const mkNode = (kind) => ({
    _kind: kind,
    frequency: { value: 0 },
    Q: { value: 0 },
    connect(target) {
      log.connects.push([kind, target?._kind ?? "?"]);
    },
    disconnect() {
      log.disconnects++;
    },
  });
  const ctx = {
    state,
    createMediaStreamDestination: () => dest,
    createBiquadFilter() {
      log.created.push("biquad");
      return mkNode("biquad");
    },
    createMediaStreamSource(s) {
      log.sourceCalls++;
      if (throwOnSource || (throwOnSourceCall && log.sourceCalls === throwOnSourceCall)) {
        throw new Error("cannot build source");
      }
      log.created.push("source");
      const n = mkNode("source");
      n._src = s;
      return n;
    },
    async resume() {},
    close() {
      log.closed = true;
    },
    audioWorklet: {
      async addModule() {
        if (addModule === "reject") throw new Error("no worklet module");
      },
    },
  };
  const workletNodeFactory = () => {
    log.created.push("worklet");
    const n = mkNode("worklet");
    n.port = { postMessage: (m) => log.posts.push(m) };
    return n;
  };
  return { ctx, log, dest, workletNodeFactory };
}

function build(raw, fake, extra = {}) {
  return createMicPipeline(raw, {
    level: "lite",
    audioContextFactory: () => fake.ctx,
    workletNodeFactory: fake.workletNodeFactory,
    ...extra,
  });
}

test("no Web Audio available: degrades to raw pass-through (fail-open)", () => {
  // No factory + no global AudioContext (Node) -> pass-through.
  const raw = fakeRawStream();
  const pipe = createMicPipeline(raw);
  assert.equal(pipe.getStream(), raw, "getStream returns the raw stream");
  assert.equal(pipe.isPassthrough, true);
  // setConfig/setMuted are no-ops; rebuild swaps the handed-back stream.
  pipe.setConfig("full");
  pipe.setMuted(true);
  const raw2 = fakeRawStream("raw2");
  pipe.rebuild(raw2);
  assert.equal(pipe.getStream(), raw2);
});

test("happy path: builds HPF graph, splices worklet, output is the processed stream", async () => {
  const raw = fakeRawStream();
  const fake = makeFakeAudio();
  let fellBack = false;
  const pipe = build(raw, fake, { onFallback: () => (fellBack = true) });

  // Synchronously the HPF graph is live and the output is the destination stream.
  assert.equal(pipe.getStream(), fake.dest.stream, "processed (not raw) stream");
  assert.ok(fake.log.created.includes("biquad") && fake.log.created.includes("source"));

  await tick(); // let the async resume + addModule + splice run
  assert.equal(fellBack, false, "no fallback in the happy path");
  assert.ok(fake.log.created.includes("worklet"), "worklet node created");
  // Final graph: source->biquad, then biquad->worklet, worklet->dest.
  assert.deepEqual(fake.log.connects, [
    ["source", "biquad"],
    ["biquad", "dest"],
    ["biquad", "worklet"],
    ["worklet", "dest"],
  ]);
});

test("HPF is configured as an 80 Hz high-pass", () => {
  const raw = fakeRawStream();
  const fake = makeFakeAudio();
  // Capture the biquad the pipeline configures.
  let biquad;
  const origMk = fake.ctx.createBiquadFilter;
  fake.ctx.createBiquadFilter = () => (biquad = origMk());
  build(raw, fake);
  assert.equal(biquad.type, "highpass");
  assert.equal(biquad.frequency.value, 80);
});

test("setConfig / setMuted post to the worklet once it's loaded", async () => {
  const raw = fakeRawStream();
  const fake = makeFakeAudio();
  const pipe = build(raw, fake);
  await tick();
  fake.log.posts.length = 0;
  pipe.setConfig("full");
  pipe.setMuted(true);
  assert.deepEqual(fake.log.posts.at(-2), { level: "full", muted: false });
  assert.deepEqual(fake.log.posts.at(-1), { level: "full", muted: true });
});

test("worklet fails to load: stays HPF-only (audio, not silence), no fallback", async () => {
  const raw = fakeRawStream();
  const fake = makeFakeAudio({ addModule: "reject" });
  let fellBack = false;
  const pipe = build(raw, fake, { onFallback: () => (fellBack = true) });
  await tick();
  assert.equal(fellBack, false, "HPF-only is not a fallback (still audio)");
  assert.equal(pipe.getStream(), fake.dest.stream, "still the processed stream");
  // Final graph is just source->biquad->dest (no worklet spliced).
  assert.deepEqual(fake.log.connects, [
    ["source", "biquad"],
    ["biquad", "dest"],
  ]);
});

test("suspended context (can't run): fail-open to the raw stream + onFallback", async () => {
  const raw = fakeRawStream();
  const fake = makeFakeAudio({ state: "suspended" });
  let fallbackStream = null;
  const pipe = build(raw, fake, { onFallback: (s) => (fallbackStream = s) });
  await tick();
  assert.equal(pipe.getStream(), raw, "fell back to raw");
  assert.equal(fallbackStream, raw, "onFallback got the raw stream");
  assert.equal(fake.log.closed, true, "the dead context was closed");
});

test("unbuildable graph (createMediaStreamSource throws): pass-through to raw", () => {
  const raw = fakeRawStream();
  const fake = makeFakeAudio({ throwOnSource: true });
  const pipe = build(raw, fake);
  assert.equal(pipe.getStream(), raw, "raw pass-through on build failure");
  assert.equal(pipe.isPassthrough, true);
});

test("registerContext is invoked so the context joins the resume set", () => {
  const raw = fakeRawStream();
  const fake = makeFakeAudio();
  let registered = null;
  build(raw, fake, { registerContext: (ctx) => (registered = ctx) });
  assert.equal(registered, fake.ctx);
});

test("fail-open after a mic switch hands back the NEW mic, not the stopped original", async () => {
  // P1 regression: failOpen must use the current raw stream. The controller stops
  // the old mic's tracks on switch, so reattaching the original would ship silence.
  const raw1 = fakeRawStream("raw1");
  const fake = makeFakeAudio({ throwOnSourceCall: 2 }); // 1st = build, 2nd = rebuild
  let fallbackStream = null;
  const pipe = build(raw1, fake, { onFallback: (s) => (fallbackStream = s) });
  await tick();
  const raw2 = fakeRawStream("raw2");
  pipe.rebuild(raw2); // createMediaStreamSource throws -> failOpen("rebuild-failed")
  assert.equal(pipe.getStream(), raw2, "output is the NEW mic, not the original");
  assert.equal(fallbackStream, raw2, "onFallback got the NEW mic, not the stopped raw1");
  assert.notEqual(fallbackStream, raw1);
});

test("rebuild swaps the source but keeps the processed output stream stable", async () => {
  const raw = fakeRawStream();
  const fake = makeFakeAudio();
  const pipe = build(raw, fake);
  await tick();
  const before = pipe.getStream();
  const created = fake.log.created.filter((c) => c === "source").length;
  pipe.rebuild(fakeRawStream("raw2"));
  assert.equal(pipe.getStream(), before, "output stream identity is stable");
  assert.equal(
    fake.log.created.filter((c) => c === "source").length,
    created + 1,
    "a new source node was created for the new mic",
  );
});
