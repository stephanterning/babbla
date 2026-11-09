// Regression: in the baseline gallery case (both cameras ON, nothing focused),
// EVERY peer's outbound camera sender must carry the standard 250 kbps cap.
//
// The bug: addCameraTrack applies the cap with getParameters() + await
// setParameters(). When two peers turn their camera on at (nearly) the same
// time, the other side's renegotiation lands in that await gap and re-numbers
// the sender's parameters, so setParameters rejects the now-stale object
// ("Read-only field modified"). The call is try/caught, so the cap is silently
// dropped and that peer's "standard" (640x360) camera streams UNCAPPED — free to
// spike well past 1.5 Mbit/s — while the other peer stays capped (the reported
// asymmetric upstream). The fix re-applies the cap when signaling settles back to
// "stable", where no renegotiation is in flight and setParameters succeeds.
//
// The race is timing-dependent, so the test would be a silent false-negative on
// regressed code if it never fired on a given run (no race -> setParameters
// succeeds -> cap set even on the buggy code). To stay deterministic we
// instrument RTCRtpSender.setParameters to count camera-sender failures — the
// exact bug path — and only read the caps on a round where that path was
// actually exercised (retrying the camera on/off cycle to re-roll the timing,
// and failing loudly if it never fires).
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const W = 1280;
const H = 800;
const LAUNCH = {
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--window-size=${W},${H}`,
  ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hook RTCPeerConnection to collect connections (so we can read the camera
// sender) and RTCRtpSender.setParameters to count camera-sender failures — a
// rejected setParameters on a video sender is exactly the race that drops the
// cap. The counter increments on whichever client loses the race on a given run.
const HOOK = `
  window.__pcs = [];
  window.__camSetParamsFail = 0;
  const OrigPC = window.RTCPeerConnection;
  const OrigSender = window.RTCRtpSender;
  if (OrigSender && OrigSender.prototype.setParameters) {
    const origSP = OrigSender.prototype.setParameters;
    OrigSender.prototype.setParameters = function () {
      const isVideo = this.track && this.track.kind === "video";
      return origSP.apply(this, arguments).catch((e) => {
        if (isVideo) window.__camSetParamsFail++;
        throw e;
      });
    };
  }
  window.RTCPeerConnection = function (...args) {
    const pc = new OrigPC(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
`;

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(HOOK);
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15000 });
  return { browser, page };
}

function cameraSenderMaxBitrate(page) {
  return page.evaluate(() => {
    for (const pc of window.__pcs) {
      for (const s of pc.getSenders()) {
        if (!s.track || s.track.kind !== "video") continue;
        return s.getParameters().encodings?.[0]?.maxBitrate ?? null;
      }
    }
    return undefined; // no video sender at all
  });
}

// Read and reset the camera-sender setParameters-failure counter so each attempt
// measures only its own camera-on renegotiation (not a prior round's).
function readAndResetCamFails(page) {
  return page.evaluate(() => {
    const n = window.__camSetParamsFail || 0;
    window.__camSetParamsFail = 0;
    return n;
  });
}

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS: ${label}`);
  } else {
    fail++;
    console.log(`FAIL: ${label} -> ${JSON.stringify(detail)}`);
  }
}

(async () => {
  const a = await newClient("Alice");
  const b = await newClient("Bob");
  try {
    await sleep(3000);

    // Mute both mics, then turn both cameras on back-to-back so the two camera
    // renegotiations overlap (the race that drops one peer's cap). The overlap
    // is timing-dependent, so retry the on/off cycle until the instrumentation
    // confirms a camera-sender setParameters actually failed, and read the caps
    // on that round.
    await a.page.click("#mute-btn");
    await b.page.click("#mute-btn");

    let aMax;
    let bMax;
    let camFails = 0;
    let exercised = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await readAndResetCamFails(a.page);
      await readAndResetCamFails(b.page);

      await a.page.click("#camera-btn");
      await b.page.click("#camera-btn");
      await sleep(4000);

      camFails =
        (await readAndResetCamFails(a.page)) + (await readAndResetCamFails(b.page));
      aMax = await cameraSenderMaxBitrate(a.page);
      bMax = await cameraSenderMaxBitrate(b.page);

      // Only a round where the cap apply actually lost the race is a valid
      // measurement: a clean (no-race) camera add sets the cap even on the buggy
      // code, so reading caps there would be a false negative.
      if (camFails > 0) {
        exercised = true;
        break;
      }
      // The race didn't fire this round: toggle both cameras off and retry to
      // re-roll the timing.
      await a.page.click("#camera-btn");
      await b.page.click("#camera-btn");
      await sleep(2000);
    }

    // Guard against a silent false-negative: if the cap-dropping race never
    // fired, the cap assertions below wouldn't prove anything, so fail explicitly.
    check("cap-dropping setParameters race was exercised", exercised, { camFails });
    check("Alice has a camera sender", aMax !== undefined, { aMax });
    check("Bob has a camera sender", bMax !== undefined, { bMax });
    check("Alice camera capped at 250000", aMax === 250_000, { aMax });
    check("Bob camera capped at 250000", bMax === 250_000, { bMax });
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
  console.log(`VERDICT: ${fail ? "FAIL" : "PASS"} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})();
