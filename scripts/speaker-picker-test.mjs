// Automated check for the speaker (audio output) picker.
//
// The cloud VM has no real audio output devices and headless Chrome's fake
// media exposes no `audiooutput`, so we *stub* navigator.mediaDevices.
// enumerateDevices to advertise a few fake outputs and *hook* setSinkId (on
// both HTMLMediaElement and AudioContext) to record what the app routes where.
// A second browser joins as a peer so the tester actually has a peer <audio>
// element (and a join chime AudioContext) to route.
//
// Verifies: the picker appears with >=2 outputs; selecting an output calls
// setSinkId on the peer <audio> + the chime context; and a device whose
// setSinkId rejects (vanished) falls back to the system default and snaps the
// dropdown back. Real audible routing still needs a human on real hardware.
//
// Usage: node scripts/speaker-picker-test.mjs
import puppeteer from "puppeteer-core";

const ROOM = `test-${Math.random().toString(36).slice(2, 10)}`;
const URL = process.env.BABBLA_URL || `http://localhost:8080/room/${ROOM}`;
const CHROME = "/usr/bin/google-chrome-stable";
const LAUNCH = {
  executablePath: CHROME,
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
};

// Injected into the tester page before any script runs: fake output devices +
// setSinkId hooks. A device id listed in __rejectSinks rejects (simulates a
// vanished output) so we can exercise the fallback path.
const INSTALL_STUBS = () => {
  window.__sinkCalls = [];
  window.__ctxSinkCalls = [];
  window.__rejectSinks = new Set(["spk-gone"]);

  const fakeOutputs = [
    { kind: "audiooutput", deviceId: "spk1", groupId: "g1", label: "Speaker 1" },
    { kind: "audiooutput", deviceId: "spk2", groupId: "g2", label: "Speaker 2" },
    { kind: "audiooutput", deviceId: "spk-gone", groupId: "g3", label: "Vanishing Speaker" },
    { kind: "audiooutput", deviceId: "default", groupId: "g2", label: "Default - Speaker 2" },
  ];
  const realEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = async () => {
    const real = await realEnum();
    // Keep the real (fake) audioinput so the mic side still works; append outputs.
    return [...real.filter((d) => d.kind !== "audiooutput"), ...fakeOutputs];
  };

  const wrap = (label, store) =>
    function (deviceId) {
      store.push(deviceId);
      if (window.__rejectSinks.has(deviceId)) {
        return Promise.reject(new DOMException("not found", "NotFoundError"));
      }
      return Promise.resolve();
    };
  HTMLMediaElement.prototype.setSinkId = wrap("audio", window.__sinkCalls);
  if (typeof AudioContext !== "undefined") {
    AudioContext.prototype.setSinkId = wrap("ctx", window.__ctxSinkCalls);
  }
};

const tester = await puppeteer.launch(LAUNCH);
const peer = await puppeteer.launch(LAUNCH);
try {
  const page = await tester.newPage();
  await page.evaluateOnNewDocument(INSTALL_STUBS);
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", "Speaker Tester");
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });

  check(
    "speaker picker visible with >=2 outputs",
    !(await page.$eval("#speaker-picker", (b) => b.hidden)),
  );
  check(
    "speaker select lists Systemstandard sentinel + the real outputs",
    await page.$eval("#speaker-select", (s) =>
      [...s.options].map((o) => o.value).join(",") === ",spk1,spk2,spk-gone",
    ),
  );
  check(
    "Systemstandard label resolves the current default output name",
    await page.$eval(
      "#speaker-select",
      (s) => s.options[0]?.textContent === "Systemstandard (Speaker 2)",
    ),
  );
  check(
    "no remembered pref defaults to Systemstandard ('')",
    await page.$eval("#speaker-select", (s) => s.value === ""),
  );

  // A peer joins the same room so the tester gets a real peer <audio> + chime ctx.
  const peerPage = await peer.newPage();
  await peerPage.goto(URL, { waitUntil: "networkidle2" });
  await peerPage.type("#name-input", "Peer");
  await peerPage.click("#join-btn");
  await peerPage.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });
  // Wait until the tester actually created an <audio> sink for the peer.
  await page.waitForFunction(
    () => document.querySelectorAll("#audio-sink audio").length >= 1,
    { timeout: 10000 },
  );
  await sleep(500); // let the join chime build the notify AudioContext

  // Happy path: pick spk2.
  await page.select("#speaker-select", "spk2");
  await sleep(300);
  check(
    "selecting spk2 routes the peer <audio> to spk2",
    await page.evaluate(() => window.__sinkCalls.includes("spk2")),
  );
  check(
    "selecting spk2 routes the chime AudioContext to spk2",
    await page.evaluate(() => window.__ctxSinkCalls.includes("spk2")),
  );
  check(
    "dropdown reflects the live pick (spk2)",
    await page.$eval("#speaker-select", (s) => s.value === "spk2"),
  );

  // Fallback: pick the vanishing device -> setSinkId rejects -> default + revert.
  await page.evaluate(() => { window.__sinkCalls.length = 0; });
  await page.select("#speaker-select", "spk-gone");
  await sleep(400);
  check(
    "rejected device falls back to default ('') on the peer <audio>",
    await page.evaluate(
      () =>
        window.__sinkCalls.includes("spk-gone") && window.__sinkCalls.includes(""),
    ),
  );
  check(
    "dropdown snaps to Systemstandard ('') after fallback, matching the sink",
    await page.$eval("#speaker-select", (s) => s.value === ""),
  );

  const passed = results.every(Boolean);
  console.log(
    `VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`,
  );
  if (!passed) process.exitCode = 1;
} finally {
  await tester.close();
  await peer.close();
}
