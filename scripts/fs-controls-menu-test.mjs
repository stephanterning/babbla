import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const CHROME = "/usr/bin/google-chrome-stable";
const W = 1360;
const H = 900;
const LAUNCH = {
  executablePath: CHROME,
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    `--window-size=${W},${H}`,
  ],
};

const INSTALL_STUBS = () => {
  window.__sinkCalls = [];
  window.__ctxSinkCalls = [];
  window.__rejectSinks = new Set(["spk-gone"]);
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: "audioinput", deviceId: "mic1", groupId: "m1", label: "Mic 1" },
    { kind: "audioinput", deviceId: "mic2", groupId: "m2", label: "Mic 2" },
    { kind: "audioinput", deviceId: "default", groupId: "m2", label: "Default - Mic 2" },
    { kind: "videoinput", deviceId: "cam1", groupId: "c1", label: "Cam 1" },
    { kind: "videoinput", deviceId: "cam2", groupId: "c2", label: "Cam 2" },
    { kind: "audiooutput", deviceId: "spk1", groupId: "s1", label: "Speaker 1" },
    { kind: "audiooutput", deviceId: "spk2", groupId: "s2", label: "Speaker 2" },
    { kind: "audiooutput", deviceId: "spk-gone", groupId: "s3", label: "Vanishing Speaker" },
    { kind: "audiooutput", deviceId: "default", groupId: "s2", label: "Default - Speaker 2" },
  ];
  const wrap = (store) =>
    function (deviceId) {
      store.push(deviceId);
      if (window.__rejectSinks.has(deviceId)) {
        return Promise.reject(new DOMException("not found", "NotFoundError"));
      }
      return Promise.resolve();
    };
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    configurable: true,
    writable: true,
    value: wrap(window.__sinkCalls),
  });
  if (typeof AudioContext !== "undefined") {
    Object.defineProperty(AudioContext.prototype, "setSinkId", {
      configurable: true,
      writable: true,
      value: wrap(window.__ctxSinkCalls),
    });
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = null) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
};

async function join(page, name) {
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });
}

const tester = await puppeteer.launch(LAUNCH);
const peer = await puppeteer.launch(LAUNCH);
try {
  const page = await tester.newPage();
  await page.evaluateOnNewDocument(INSTALL_STUBS);
  await join(page, "Tester");

  // Regression: the sidebar device menu must open even when the big stage is
  // empty (no focused/shared video). The menu used to be a child of
  // #screen-wrap, which is display:none whenever nothing is on stage — so the
  // chooser silently failed to appear (notably while you were the only screen
  // sharer). It now lives at body level, independent of the stage layout.
  await page.click("#mute-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  check(
    "sidebar audio menu opens with an empty stage (portal, not nested in #screen-wrap)",
    await page.evaluate(() => {
      const menu = document.getElementById("fs-device-menu");
      const wrap = document.getElementById("screen-wrap");
      const cs = getComputedStyle(menu);
      const rect = menu.getBoundingClientRect();
      const visible =
        !menu.hidden &&
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight + 1 &&
        rect.right <= window.innerWidth + 1;
      // The empty stage really is hidden, and the menu is NOT nested inside it.
      return visible && wrap.hidden === true && !wrap.contains(menu);
    }),
  );
  await page.click("#mute-menu-btn");
  await page.waitForSelector("#fs-device-menu[hidden]", { timeout: 10000 });

  const peerPage = await peer.newPage();
  await join(peerPage, "Peer");
  await peerPage.click("#camera-btn");

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".video-tile")].some(
        (tile) => !tile.classList.contains("self") && tile.classList.contains("has-video"),
      ),
    { timeout: 15000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#audio-sink audio").length >= 1,
    { timeout: 10000 },
  );

  await page.evaluate(() => {
    const tile = [...document.querySelectorAll(".video-tile")].find(
      (el) => !el.classList.contains("self") && el.classList.contains("has-video"),
    );
    tile?.click();
  });
  await page.waitForSelector("#fullscreen-btn:not([hidden])", { timeout: 10000 });
  await page.click("#fullscreen-btn");
  await page.waitForFunction(
    () => document.body.classList.contains("fullscreen-stage"),
    { timeout: 10000 },
  );

  check(
    "fullscreen share button visible in fullscreen controls",
    await page.$eval("#fs-share", (btn) => !btn.hidden),
  );

  await page.click("#fs-share");
  await page.waitForFunction(
    () => document.getElementById("fs-share").getAttribute("aria-pressed") === "true",
    { timeout: 10000 },
  );
  check(
    "fullscreen share button toggles on",
    await page.$eval("#fs-share", (btn) => btn.getAttribute("aria-pressed") === "true"),
  );
  await page.click("#fs-share");
  await page.waitForFunction(
    () => document.getElementById("fs-share").getAttribute("aria-pressed") === "false",
    { timeout: 10000 },
  );
  check(
    "fullscreen share button toggles off",
    await page.$eval("#fs-share", (btn) => btn.getAttribute("aria-pressed") === "false"),
  );

  await page.click("#fs-mute-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  check(
    "audio menu shows mic/speaker/noise sections",
    await page.evaluate(() => {
      const sections = [...document.querySelectorAll("#fs-device-menu .fs-device-section-title")].map((el) =>
        el.textContent.trim(),
      );
      return (
        sections.includes("Mikrofon") &&
        sections.includes("Högtalare") &&
        sections.includes("Brusreducering")
      );
    }),
  );

  await sleep(3400);
  check(
    "auto-hide stays paused while device menu is open",
    await page.$eval("#screen-wrap", (el) => !el.classList.contains("fs-idle")),
  );

  await page.evaluate(() => {
    document
      .querySelector('#fs-device-menu .fs-device-item[data-control="speaker"][data-value="spk2"]')
      ?.click();
  });
  await page.waitForSelector("#fs-device-menu[hidden]", { timeout: 10000 });
  await page.click("#fs-mute-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  check(
    "speaker selection persists as active after reopen (stale-active guard)",
    await page.evaluate(() => {
      const active = document.querySelector(
        '#fs-device-menu .fs-device-item[data-control="speaker"][aria-checked="true"]',
      );
      return active?.dataset.value === "spk2" &&
        document.getElementById("speaker-select").value === "spk2";
    }),
  );

  await page.evaluate(() => {
    document
      .querySelector('#fs-device-menu .fs-device-item[data-control="noise"][data-value="full"]')
      ?.click();
  });
  await page.waitForSelector("#fs-device-menu[hidden]", { timeout: 10000 });
  await page.click("#fs-mute-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  check(
    "noise level persists as active after reopen (stale-active guard)",
    await page.evaluate(() => {
      const active = document.querySelector(
        '#fs-device-menu .fs-device-item[data-control="noise"][aria-checked="true"]',
      );
      return active?.dataset.value === "full" &&
        document.getElementById("noise-select").value === "full";
    }),
  );
  await page.click("#fs-mute-menu-btn");
  await page.waitForSelector("#fs-device-menu[hidden]", { timeout: 10000 });

  check(
    "camera disclosure visible with >=2 cameras",
    await page.$eval("#fs-camera-menu-btn", (btn) => !btn.hidden),
  );
  await page.click("#fs-camera-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  await page.evaluate(() => {
    document
      .querySelector('#fs-device-menu .fs-device-item[data-control="camera"][data-value="cam2"]')
      ?.click();
  });
  await page.waitForSelector("#fs-device-menu[hidden]", { timeout: 10000 });
  await page.click("#fs-camera-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  check(
    "camera-off selection persists as active after reopen (stale-active guard)",
    await page.evaluate(() => {
      const active = document.querySelector(
        '#fs-device-menu .fs-device-item[data-control="camera"][aria-checked="true"]',
      );
      return active?.dataset.value === "cam2" &&
        document.getElementById("camera-select").value === "cam2";
    }),
  );
  await page.click("#fs-camera-menu-btn");
  await page.waitForSelector("#fs-device-menu[hidden]", { timeout: 10000 });

  await page.click("#fs-mute-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  await page.evaluate(() => {
    document
      .querySelector('#fs-device-menu .fs-device-item[data-control="speaker"][data-value="spk-gone"]')
      ?.click();
  });
  await sleep(450);
  await page.click("#fs-mute-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  // spk2 was picked just before spk-gone, so it is the next entry on the speaker
  // stack. A device that is listed but whose setSinkId rejects must fall through
  // to that previous pick rather than all the way to Systemstandard, and the
  // marker + select must follow the sink that actually took.
  check(
    "a rejected speaker falls back to the next stack entry, in sync with the marker/select",
    await page.evaluate(() => {
      const active = document.querySelector(
        '#fs-device-menu .fs-device-item[data-control="speaker"][aria-checked="true"]',
      );
      const sinkCalls = window.__sinkCalls || [];
      return active?.dataset.value === "spk2" &&
        document.getElementById("speaker-select").value === "spk2" &&
        sinkCalls.includes("spk-gone") &&
        sinkCalls.lastIndexOf("spk2") > sinkCalls.indexOf("spk-gone");
    }),
  );
  await page.click("#fs-mute-menu-btn");
  await page.waitForSelector("#fs-device-menu[hidden]", { timeout: 10000 });

  await page.evaluate(() => {
    const controls = document.getElementById("fs-controls");
    const x = Math.max(8, window.innerWidth - controls.offsetWidth - 12);
    controls.style.left = `${x}px`;
    controls.style.top = "12px";
    controls.style.right = "auto";
    controls.style.bottom = "auto";
  });
  await page.click("#fs-mute-menu-btn");
  await page.waitForSelector("#fs-device-menu:not([hidden])", { timeout: 10000 });
  const placement = await page.evaluate(() => {
    const trigger = document.getElementById("fs-mute-menu-btn");
    const controls = document.getElementById("fs-controls");
    const rect = document.getElementById("fs-device-menu").getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();
    const maxWidth = Math.max(window.innerWidth, document.documentElement.clientWidth || 0);
    return {
      opensDown: trigger.classList.contains("opens-down"),
      left: rect.left,
      right: rect.right,
      triggerLeft: triggerRect.left,
      triggerTop: triggerRect.top,
      controlsLeft: controlsRect.left,
      controlsTop: controlsRect.top,
      styleLeft: controls.style.left,
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      maxWidth,
    };
  });
  check(
    "menu flips downward near the top and stays clamped inside viewport",
    placement.opensDown && placement.left >= 7 && placement.right <= placement.maxWidth - 7,
    placement,
  );

  await page.keyboard.press("Escape");
  check(
    "first Escape closes menu but stays in fullscreen",
    await page.evaluate(() =>
      document.getElementById("fs-device-menu").hidden &&
      document.body.classList.contains("fullscreen-stage"),
    ),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.body.classList.contains("fullscreen-stage"),
    { timeout: 10000 },
  );
  check(
    "second Escape exits fullscreen",
    await page.evaluate(() => !document.body.classList.contains("fullscreen-stage")),
  );

  const passed = results.every(Boolean);
  console.log(`VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
  if (!passed) process.exitCode = 1;
} finally {
  await tester.close();
  await peer.close();
}
