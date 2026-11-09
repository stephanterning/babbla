// Real WebRTC peers, with a held setSinkId promise to expose the Chromium
// startup race: srcObject must not be attached while output routing is pending.
// Hardware routing is stubbed; this proves ordering, not audible AirPods output.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const URL = process.env.BABBLA_URL || `http://localhost:8080/room/speaker-startup-${Date.now()}`;
const launch = {
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
  headless: process.env.HEADLESS === "1",
  args: ["--no-sandbox", "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
};

function installOutputs() {
  localStorage.setItem("babbla:speakerStack", JSON.stringify([
    { deviceId: "macbook", label: "MacBook Pro Speakers" },
  ]));
  const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = async () => [
    ...(await enumerate()).filter((d) => d.kind !== "audiooutput"),
    { kind: "audiooutput", deviceId: "macbook", groupId: "mac", label: "MacBook Pro Speakers" },
    { kind: "audiooutput", deviceId: "airpods", groupId: "pods", label: "AirPods" },
    { kind: "audiooutput", deviceId: "default", groupId: "pods", label: "Default - AirPods" },
  ];
  window.__earlyAttachments = 0;
  window.__overlappingRoutes = 0;
  const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    ...source,
    set(stream) {
      if (stream && this.__pendingSink) window.__earlyAttachments++;
      if (stream) this.__sinkAtAttach = this.__appliedSink || "";
      source.set.call(this, stream);
    },
  });
  HTMLMediaElement.prototype.setSinkId = async function (id) {
    if (this.__pendingSink) window.__overlappingRoutes++;
    this.__pendingSink = true;
    if (this.parentElement?.id === "audio-sink" && !window.__heldAudio) {
      window.__heldAudio = this;
      await new Promise((resolve) => { window.__releaseSink = resolve; });
    }
    this.__appliedSink = id;
    this.__pendingSink = false;
  };
  if (typeof AudioContext !== "undefined") {
    AudioContext.prototype.setSinkId = async function () {};
  }
}

async function join(page, name) {
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])");
  // Onboarding must not intercept leave/menu controls.
  await page.evaluate(() => document.querySelector("dialog[open]")?.close());
}

const tester = await puppeteer.launch(launch);
let peer;
let failed = 0;
try {
  peer = await puppeteer.launch(launch);
  for (const scenario of ["saved speaker at join", "speaker change during join",
    "peer leaves during routing", "leave during routing", "DND during routing"]) {
    const page = await tester.newPage();
    const other = await peer.newPage();
    try {
      await page.evaluateOnNewDocument(installOutputs);
      await join(page, "Speaker tester");
      await join(other, "Peer");
      await page.waitForFunction(() => !!window.__releaseSink);
      if (scenario === "speaker change during join") {
        await page.select("#speaker-select", "airpods");
      } else if (scenario === "peer leaves during routing") {
        await other.click("#leave-btn");
        await page.waitForFunction(() => !document.querySelector("#audio-sink audio"));
      } else if (scenario === "leave during routing") {
        await page.click("#leave-btn");
        await page.waitForFunction(() => !document.querySelector("#audio-sink audio"));
      } else if (scenario === "DND during routing") {
        await page.click("#dnd-btn");
      }
      const before = await page.evaluate(() => ({
        attached: !!window.__heldAudio.srcObject,
        selected: document.querySelector("#speaker-select").value,
      }));
      // Release even on the old, broken implementation, so the whole scenario
      // finishes and failures report the observed ordering, not a timeout.
      await page.evaluate(() => window.__releaseSink());
      if (scenario === "peer leaves during routing" || scenario === "leave during routing") {
        await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
        assert.equal(await page.evaluate(() => window.__heldAudio.srcObject), null,
          "a removed peer must not regain its stream after routing completes");
      } else {
        const wanted = scenario === "speaker change during join" ? "airpods" : "macbook";
        await page.waitForFunction((id) => window.__heldAudio.srcObject &&
          window.__heldAudio.__appliedSink === id, {}, wanted);
        if (scenario !== "DND during routing") {
          await page.click("#mute-menu-btn");
          await page.waitForSelector('[data-control="speaker"][aria-checked="true"]');
        }
        const state = await page.evaluate(() => ({
          early: window.__earlyAttachments,
          overlaps: window.__overlappingRoutes,
          atAttach: window.__heldAudio.__sinkAtAttach,
          selected: document.querySelector("#speaker-select").value,
          menuSelected: document.querySelector('[data-control="speaker"][aria-checked="true"]')?.dataset.value,
        }));
        assert.equal(before.attached, false, "no voice stream while initial output selection is pending");
        assert.equal(state.early, 0, "srcObject never races a pending setSinkId");
        assert.equal(state.overlaps, 0, "startup and speaker changes share routing order");
        assert.equal(state.atAttach, "macbook", "initial voice stream uses the saved speaker");
        assert.equal(state.selected, wanted, "menu agrees with the completed output selection");
        if (scenario === "DND during routing") {
          assert.equal(await page.evaluate(() => window.__heldAudio.muted), true,
            "voice arriving during DND stays muted");
        } else {
          assert.equal(state.menuSelected, wanted, "visible menu marks the routed speaker");
        }
      }
      console.log(`PASS: ${scenario}`);
    } catch (error) {
      failed++;
      console.error(`FAIL: ${scenario}: ${error.message}`);
    } finally {
      await page.close();
      await other.close();
    }
  }
} finally {
  await tester.close();
  await peer?.close();
}
if (failed) process.exitCode = 1;
