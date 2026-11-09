// Verify that on iOS (where mic/speaker are best chosen in the system) the mic
// and speaker pickers are hidden even when multiple devices are enumerable,
// while the camera picker is unaffected — and that desktop keeps the concrete-
// count visibility rule (mic picker hidden with only 1 concrete mic even if a
// virtual "default" mic entry is present). The VM has no real devices, so
// enumerateDevices is stubbed.
//
// Usage: node scripts/ios-device-pickers-test.mjs
import puppeteer from "puppeteer-core";

const CHROME = "/usr/bin/google-chrome-stable";
const BASE = (() => {
  if (!process.env.BABBLA_URL) return "http://localhost:8080";
  try {
    return new URL(process.env.BABBLA_URL).origin;
  } catch {
    return "http://localhost:8080";
  }
})();
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
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPADOS_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
};

const DEFAULT_DEVICES = [
  { kind: "audioinput", deviceId: "mic1", groupId: "a", label: "Mic 1" },
  { kind: "audioinput", deviceId: "mic2", groupId: "b", label: "Mic 2" },
  { kind: "videoinput", deviceId: "cam1", groupId: "c", label: "Cam 1" },
  { kind: "videoinput", deviceId: "cam2", groupId: "d", label: "Cam 2" },
  { kind: "audiooutput", deviceId: "spk1", groupId: "e", label: "Speaker 1" },
  { kind: "audiooutput", deviceId: "spk2", groupId: "f", label: "Speaker 2" },
];

const STUB_DEVICES = (fake = DEFAULT_DEVICES) => {
  navigator.mediaDevices.enumerateDevices = async () => fake;
};

function stubPlatform({ platform, maxTouchPoints }) {
  if (!platform) return;
  Object.defineProperty(Navigator.prototype, "userAgentData", {
    configurable: true,
    get: () => ({ platform }),
  });
  Object.defineProperty(Navigator.prototype, "platform", {
    configurable: true,
    get: () => platform,
  });
  Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
    configurable: true,
    get: () => maxTouchPoints ?? 0,
  });
}

async function joinAndRead(browser, { ua, platform, maxTouchPoints, devices } = {}) {
  const page = await browser.newPage();
  if (ua) await page.setUserAgent(ua);
  await page.evaluateOnNewDocument(stubPlatform, { platform, maxTouchPoints });
  await page.evaluateOnNewDocument(STUB_DEVICES, devices ?? DEFAULT_DEVICES);
  const room = `ios-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(`${BASE}/room/${room}`, { waitUntil: "networkidle2" });
  await page.type("#name-input", "Tester");
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });
  await sleep(400);
  await page.click("#mute-menu-btn");
  await sleep(200);
  const audioMenu = await page.evaluate(() => ({
    hidden: document.getElementById("fs-device-menu").hidden,
    sections: [
      ...document.querySelectorAll("#fs-device-menu .fs-device-section-title"),
    ].map((el) => el.textContent.trim()),
  }));
  await page.click("#camera-menu-btn").catch(() => {});
  await sleep(200);
  const cameraMenu = await page.evaluate(() => ({
    buttonHidden: document.getElementById("camera-menu-btn").hidden,
    visible: !document.getElementById("fs-device-menu").hidden,
    sections: [
      ...document.querySelectorAll("#fs-device-menu .fs-device-section-title"),
    ].map((el) => el.textContent.trim()),
  }));
  const pickers = await page.evaluate(() => ({
    mic: document.getElementById("mic-picker").hidden,
    camera: document.getElementById("camera-picker").hidden,
    speaker: document.getElementById("speaker-picker").hidden,
    macosVoiceIsolation: document.getElementById("macos-voice-isolation").hidden,
  }));
  if (cameraMenu.visible || !audioMenu.hidden) {
    await page.keyboard.press("Escape").catch(() => {});
  }
  return {
    ...pickers,
    audioMenuHidden: audioMenu.hidden,
    audioMenuSections: audioMenu.sections,
    cameraMenuButtonHidden: cameraMenu.buttonHidden,
    cameraMenuVisible: cameraMenu.visible,
    cameraMenuSections: cameraMenu.sections,
  };
}

const browser = await puppeteer.launch(LAUNCH);
try {
  const ios = await joinAndRead(browser, { ua: IPHONE_UA });
  check("iOS: mic picker hidden", ios.mic === true);
  check("iOS: speaker picker hidden", ios.speaker === true);
  check("iOS: camera picker still shown (2 cams)", ios.camera === false);
  check("iOS: audio menu opens from split button", ios.audioMenuHidden === false);
  check("iOS: audio menu includes microphone section", ios.audioMenuSections.includes("Mikrofon"));
  check("iOS: audio menu includes noise section", ios.audioMenuSections.includes("Brusreducering"));
  check("iOS: audio menu hides speaker section", !ios.audioMenuSections.includes("Högtalare"));
  check("iOS: camera menu button is visible with 2 cameras", ios.cameraMenuButtonHidden === false);
  check("iOS: camera menu opens from split button", ios.cameraMenuVisible === true);
  check("iOS: camera menu includes camera section", ios.cameraMenuSections.includes("Kamera"));

  const ipados = await joinAndRead(browser, {
    ua: IPADOS_DESKTOP_UA,
    platform: "MacIntel",
    maxTouchPoints: 5,
  });
  check("iPadOS MacIntel: mic picker hidden", ipados.mic === true);
  check("iPadOS MacIntel: speaker picker hidden", ipados.speaker === true);
  check("iPadOS MacIntel: macOS Voice Isolation section hidden", ipados.macosVoiceIsolation === true);

  const desktop = await joinAndRead(browser);
  check("desktop: mic picker shown (2 mics)", desktop.mic === false);
  check("desktop: speaker picker shown (2 speakers)", desktop.speaker === false);

  const desktopOneMicPlusDefault = await joinAndRead(browser, {
    devices: [
      { kind: "audioinput", deviceId: "mic1", groupId: "a", label: "Mic 1" },
      { kind: "audioinput", deviceId: "default", groupId: "a", label: "Default - Mic 1" },
      { kind: "videoinput", deviceId: "cam1", groupId: "c", label: "Cam 1" },
      { kind: "videoinput", deviceId: "cam2", groupId: "d", label: "Cam 2" },
      { kind: "audiooutput", deviceId: "spk1", groupId: "e", label: "Speaker 1" },
      { kind: "audiooutput", deviceId: "spk2", groupId: "f", label: "Speaker 2" },
    ],
  });
  check(
    "desktop: mic picker stays hidden with 1 concrete mic + default sentinel",
    desktopOneMicPlusDefault.mic === true,
  );
  check(
    "desktop: speaker picker still shown (2 speakers)",
    desktopOneMicPlusDefault.speaker === false,
  );

  const passed = results.every(Boolean);
  console.log(`VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
