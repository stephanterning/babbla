// End-to-end check for the device stack, and the script that produces the demo
// artifacts. Drives a real browser through "dock a display, undock it, dock it
// again" with a stubbed device list, and renders an on-page HUD so the stack, the
// live capture and the picker are visible together. Screenshots go to OUT_DIR.
//
// What it pins down, none of which the unit tests can prove in a real browser:
//   * a pick is honored while its device is present, and survives its absence
//   * the picker reads Systemstandard (not the fallback device) while away
//   * the pick is recaptured when the device returns
//   * a device event that changes nothing does NOT recapture (idempotence)
//   * picking the device that is ALREADY live still becomes the top pick
//   * a returning lower entry does not steal the mic back
//   * a reconcile capture that lands after the user goes quiet (Stör ej, or
//     leaving the room) is released rather than adopted — nothing keeps the OS
//     microphone open behind their back
//
//   node scripts/device-stack-demo.mjs            # against localhost:8080
//   BABBLA_URL=... OUT_DIR=... node scripts/device-stack-demo.mjs
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const URL = process.env.BABBLA_URL || "http://localhost:8080/room/device-stack-demo";
const OUT_DIR = process.env.OUT_DIR || "/tmp/device-stack-demo";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

const BUILTIN = { kind: "audioinput", deviceId: "builtin-mic", groupId: "g-mbp", label: "MacBook Pro-mikrofon" };
// A second always-present mic, so the menu's MIKROFON section stays visible
// while the display is unplugged (it is gated on having >= 2 concrete mics).
const HEADSET = { kind: "audioinput", deviceId: "headset-mic", groupId: "g-usb", label: "USB-headset" };
const DISPLAY = { kind: "audioinput", deviceId: "display-mic", groupId: "g-display", label: "Studio Display-mikrofon" };
const BUILTIN_CAM = { kind: "videoinput", deviceId: "builtin-cam", groupId: "g-mbp", label: "FaceTime HD-kamera" };
const DISPLAY_CAM = { kind: "videoinput", deviceId: "display-cam", groupId: "g-display", label: "Studio Display-kamera" };
const OUTPUTS = [
  { kind: "audiooutput", deviceId: "builtin-spk", groupId: "g-mbp", label: "MacBook Pro-högtalare" },
  { kind: "audiooutput", deviceId: "display-spk", groupId: "g-display", label: "Studio Display-högtalare" },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: { width: 1180, height: 760 },
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage();

// Stub the device list so a "display" can be plugged and unplugged on demand,
// and make getUserMedia honor an exact deviceId only while that device is
// present — i.e. behave like a real browser with removable hardware.
await page.evaluateOnNewDocument(
  (builtin, headset, display, builtinCam, displayCam) => {
    window.__display = false;
    const list = () => [builtin, headset, ...(window.__display ? [display] : [])];
    const camList = () => [builtinCam, ...(window.__display ? [displayCam] : [])];
    window.__devices = () => list();
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => {
      const out = [...list(), ...camList(), ...(window.__outputs || [])];
      return out.map((d) => ({ ...d, toJSON: () => d }));
    };
    const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__captures = [];
    // Video captures are counted separately so the microphone assertions above
    // keep reading a clean audio-only history.
    window.__videoCaptures = [];
    window.__liveTracks = [];
    // Real hardware fires "ended" on the live track when the device is removed
    // (Chromium does this on every platform except ChromeOS). Simulate it, so
    // unplugging exercises the same recovery path a real unplug would.
    window.__unplug = (deviceId) => {
      for (const t of window.__liveTracks) {
        if (t.__deviceId === deviceId && !t.__ended) {
          t.__ended = true;
          t.dispatchEvent(new Event("ended"));
        }
      }
    };
    // Hold one capture open on demand, so the test can act (go into Stör ej,
    // leave the room) in the window between asking for a device and getting it.
    window.__holdCapture = null;
    window.__releaseHold = null;
    // Tracks the OS considers live. Capture is what lights the mic indicator, so
    // this is the number that has to reach zero when the user goes quiet.
    window.__liveCaptureCount = () =>
      window.__liveTracks.filter((t) => t.readyState === "live").length;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const isVideo = !!constraints?.video;
      const present = isVideo ? camList() : list();
      const wanted = (isVideo ? constraints.video : constraints.audio)?.deviceId?.exact;
      if (wanted && !present.some((d) => d.deviceId === wanted)) {
        const err = new Error("Requested device not found");
        err.name = "OverconstrainedError";
        throw err;
      }
      if (wanted && wanted === window.__holdCapture) {
        window.__holdCapture = null;
        await new Promise((res) => {
          window.__releaseHold = res;
        });
      }
      // Strip the pin before delegating: the underlying fake-device Chrome has
      // its own device ids, so passing our synthetic id through would fail.
      const key = isVideo ? "video" : "audio";
      const passthrough = { ...constraints, [key]: { ...constraints[key] } };
      delete passthrough[key].deviceId;
      const stream = await realGum(passthrough);
      const id = wanted || (isVideo ? "builtin-cam" : "builtin-mic");
      (isVideo ? window.__videoCaptures : window.__captures).push(wanted || "(okonstruerad)");
      // Report the device the app asked for, the way a real capture would.
      const tracks = isVideo ? stream.getVideoTracks() : stream.getAudioTracks();
      for (const t of tracks) {
        const settings = t.getSettings.bind(t);
        t.getSettings = () => ({ ...settings(), deviceId: id, groupId: `g-${id}` });
        t.__deviceId = id;
        window.__liveTracks.push(t);
      }
      return stream;
    };
    void real;
  },
  BUILTIN,
  HEADSET,
  DISPLAY,
  BUILTIN_CAM,
  DISPLAY_CAM,
);

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.evaluate((outputs) => {
  window.__outputs = outputs;
}, OUTPUTS);

// On-page HUD: the whole point of this change is the relationship between three
// things, so show them together instead of asking the reader to infer it.
const installHud = async () => {
  await page.evaluate(() => {
    if (document.getElementById("__hud")) return;
    const hud = document.createElement("div");
    hud.id = "__hud";
    hud.style.cssText = [
      "position:fixed", "left:16px", "bottom:16px", "width:400px", "z-index:99999",
      "background:rgba(8,12,20,.94)", "color:#e8eefc", "font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace",
      "padding:14px 16px", "border-radius:10px", "border:1px solid #2b3a55",
      "box-shadow:0 8px 30px rgba(0,0,0,.5)", "white-space:pre-wrap",
    ].join(";");
    document.body.appendChild(hud);
    const render = () => {
      const stack = JSON.parse(localStorage.getItem("babbla:micStack") || "[]");
      const lines = stack.length
        ? stack.map((e, i) => `   ${i + 1}. ${e.system ? "Systemstandard (följ OS)" : e.label || e.deviceId}`)
        : ["   (tom)"];
      const sel = document.getElementById("mic-select");
      const selText = sel?.selectedOptions?.[0]?.textContent ?? "-";
      const caps = window.__captures || [];
      hud.textContent = [
        `Studio Display ansluten:  ${window.__display ? "JA" : "NEJ"}`,
        "",
        "babbla:micStack (aktiva val, senast först)",
        ...lines,
        "",
        `Live capture (getUserMedia): ${caps[caps.length - 1] ?? "-"}`,
        `Mick-väljaren visar:         ${selText}`,
        `Antal capture totalt:        ${caps.length}`,
        `Spår som håller micken öppen: ${window.__liveCaptureCount?.() ?? "-"}`,
      ].join("\n");
    };
    render();
    window.__hudTimer = setInterval(render, 200);
  });
};

// Open the real audio device menu so the screenshots show the UI the user sees
// (which mic is marked active), not just the HUD's reading of it.
const openMicMenu = async () => {
  await page.evaluate(() => {
    const menu = document.getElementById("fs-device-menu");
    if (menu && !menu.hidden) return;
    document.getElementById("mute-menu-btn")?.click();
  });
  await sleep(500);
};

const closeMicMenu = async () => {
  await page.evaluate(() => {
    const menu = document.getElementById("fs-device-menu");
    if (menu && !menu.hidden) document.getElementById("mute-menu-btn")?.click();
  });
  await sleep(300);
};

const shot = async (name) => {
  await installHud();
  await openMicMenu();
  await sleep(500);
  await page.screenshot({ path: `${OUT_DIR}/${name}.png` });
  await closeMicMenu();
  console.log(`shot: ${name}.png`);
};

const hud = () => page.evaluate(() => document.getElementById("__hud")?.textContent || "");
const setDisplay = async (on) => {
  await page.evaluate((v) => {
    window.__display = v;
    if (!v) window.__unplug("display-mic");
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  }, on);
  // The app debounces devicechange by 500ms and then reconciles.
  await sleep(2200);
};
/** Pick a concrete device by id (never the Systemstandard sentinel row). */
const pickMic = async (deviceId) => {
  await page.evaluate((wanted) => {
    const sel = document.getElementById("mic-select");
    const opt = [...sel.options].find((o) => o.value === wanted);
    if (!opt) throw new Error(`no mic option for ${wanted}: ${[...sel.options].map((o) => o.value)}`);
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, deviceId);
  await sleep(1600);
};

await page.waitForSelector("#name-input");
await page.type("#name-input", "Stephan");
await page.click("#join-btn");
await page.waitForSelector("#room-view:not([hidden])", { timeout: 20000 });
await sleep(1200);

// 1. Docked: pick the display mic explicitly.
await setDisplay(true);
await pickMic("display-mic");
await shot("1_picked_display_mic");
console.log("\n[1 picked display]\n" + (await hud()));

// 2. Undock. The pick is away, so a fallback goes live — but the stack keeps it,
//    and the picker says Systemstandard rather than claiming the built-in was
//    chosen.
await setDisplay(false);
await shot("2_undocked_fallback");
console.log("\n[2 undocked]\n" + (await hud()));

// 3. Re-dock. The top pick is present again, so it is recaptured.
await setDisplay(true);
await shot("3_redocked_auto_returns");
console.log("\n[3 re-docked]\n" + (await hud()));

// 4. Idempotence: another device event with nothing changed must not recapture.
const before = await page.evaluate(() => window.__captures.length);
await setDisplay(true);
const after = await page.evaluate(() => window.__captures.length);
console.log(`\n[4 idempotent] captures ${before} -> ${after}`);

// 5. Undock again, then explicitly pick the built-in mic while it is ALREADY
//    live. That click must still register as a choice — the bug that started
//    this: previously it was swallowed and the absent display mic kept winning.
await setDisplay(false);
await pickMic("builtin-mic");
await shot("4_explicit_pick_of_live_device");
console.log("\n[5 explicit pick of the live device]\n" + (await hud()));

// 6. Re-dock: the display mic is on the stack but no longer on top, so it must
//    NOT steal the mic back.
await setDisplay(true);
await shot("5_redock_does_not_steal");
console.log("\n[6 re-dock does not steal]\n" + (await hud()));

const stackAfterRedock = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("babbla:micStack") || "[]"),
);
// What is *live* is the honest check here: the last capture was the
// unconstrained unplug recovery, and the point of this step is that re-docking
// did not start a new one.
const liveMicDevice = () =>
  page.evaluate(
    () =>
      window.__liveTracks
        .filter((t) => t.readyState === "live" && !t.__deviceId.endsWith("-cam"))
        .at(-1)?.__deviceId ?? null,
  );
const liveMicAfterRedock = await liveMicDevice();
console.log("\nstack after re-dock:", JSON.stringify(stackAfterRedock));
console.log("live mic after re-dock:", liveMicAfterRedock);

const liveCount = () => page.evaluate(() => window.__liveCaptureCount());
/** Re-dock with the display mic's capture held open, and wait until it blocks. */
const redockHoldingCapture = async () => {
  await page.evaluate(() => {
    window.__holdCapture = "display-mic";
    window.__display = true;
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await page.waitForFunction(() => typeof window.__releaseHold === "function", { timeout: 15000 });
};
const releaseHeldCapture = async () => {
  await page.evaluate(() => {
    const release = window.__releaseHold;
    window.__releaseHold = null;
    release();
  });
  await sleep(1400);
};

// 7. Reconciliation captures without the user asking, so its result can land
//    after they have deliberately gone quiet. Entering Stör ej releases the
//    microphone on purpose; a capture arriving a moment later must be released
//    too, or the OS mic indicator stays lit with nothing on screen to explain it.
await setDisplay(true);
await pickMic("display-mic");
await setDisplay(false);
await redockHoldingCapture();
const liveBeforeDnd = await liveCount();
await page.evaluate(() => document.getElementById("dnd-btn").click());
await sleep(400);
await releaseHeldCapture();
const liveDuringDnd = await liveCount();
await shot("6_dnd_releases_late_capture");
console.log(`\n[7 Stör ej during a capture] mic-holding tracks ${liveBeforeDnd} -> ${liveDuringDnd}`);

// 8. An abandoned capture is not a verdict on the device: leaving Stör ej must
//    still find the pick reachable rather than falling back to something else.
await page.evaluate(() => document.getElementById("dnd-btn").click());
await sleep(1800);
const captureAfterDnd = await page.evaluate(() => window.__captures.at(-1));
const liveAfterDnd = await liveCount();
console.log(`\n[8 back from Stör ej] capture ${captureAfterDnd}, mic-holding tracks ${liveAfterDnd}`);

// 9. The camera counterpart of 7/8, and the sharper case: video goes on the
//    wire, and the walk marks a device unusable when it refuses. If an
//    *abandoned* capture counted as a refusal, turning video off mid-reconcile
//    would burn every camera on the stack and the next enable would fall back
//    to an unconstrained capture with the top pick sitting right there.
const pickCamera = async (deviceId) => {
  await page.evaluate((wanted) => {
    const sel = document.getElementById("camera-select");
    const opt = [...sel.options].find((o) => o.value === wanted);
    if (!opt) throw new Error(`no camera option for ${wanted}`);
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, deviceId);
  await sleep(900);
};
const toggleVideo = async () => {
  await page.evaluate(() => document.getElementById("camera-btn").click());
  await sleep(1600);
};
const lastVideoCapture = () => page.evaluate(() => window.__videoCaptures.at(-1) ?? null);

// Two camera picks, the display camera on top, recorded while it is present.
await setDisplay(true);
await pickCamera("builtin-cam");
await pickCamera("display-cam");
// Undock, then turn video on: the top pick is away, so the built-in comes up.
await setDisplay(false);
await toggleVideo();
const camOnBuiltin = await lastVideoCapture();

// Re-dock with the display camera's capture held open, so the reconcile is
// mid-flight, and turn video off inside that window.
await page.evaluate(() => {
  window.__holdCapture = "display-cam";
  window.__display = true;
  navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
});
await page.waitForFunction(() => typeof window.__releaseHold === "function", { timeout: 15000 });
await toggleVideo();
await releaseHeldCapture();
const liveAfterCamOff = await page.evaluate(() =>
  window.__liveTracks.filter((t) => t.readyState === "live" && t.__deviceId.endsWith("-cam")).length,
);

// Turn video back on. The display camera is present and openable and is still
// the top pick, so it must come up.
await toggleVideo();
const camAfterAbort = await lastVideoCapture();
await shot("8_camera_pick_survives_abandoned_capture");
console.log(
  `\n[9 camera] on-while-away ${camOnBuiltin}, live camera tracks after off ${liveAfterCamOff},` +
    ` re-enable ${camAfterAbort}\n           captures: ` +
    JSON.stringify(await page.evaluate(() => window.__videoCaptures)),
);
await toggleVideo();

// 10. Same window, but the user leaves the room instead of going quiet in it.
//    Once the landing page is showing, nothing may still hold the microphone.
await setDisplay(false);
await redockHoldingCapture();
await page.evaluate(() => document.getElementById("leave-btn").click());
await sleep(400);
await releaseHeldCapture();
const liveAfterLeave = await liveCount();
await page.screenshot({ path: `${OUT_DIR}/7_leave_releases_late_capture.png` });
console.log(`shot: 7_leave_releases_late_capture.png`);
console.log(`\n[10 leaving during a capture] mic-holding tracks ${liveAfterLeave}`);

const ok =
  camOnBuiltin === "builtin-cam" &&
  liveAfterCamOff === 0 &&
  camAfterAbort === "display-cam" &&
  stackAfterRedock[0]?.deviceId === "builtin-mic" &&
  stackAfterRedock[1]?.deviceId === "display-mic" &&
  liveMicAfterRedock === "builtin-mic" &&
  before === after &&
  liveBeforeDnd === 1 &&
  liveDuringDnd === 0 &&
  captureAfterDnd === "display-mic" &&
  liveAfterDnd === 1 &&
  liveAfterLeave === 0;
console.log(ok ? "\nVERDICT: PASS" : "\nVERDICT: FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
