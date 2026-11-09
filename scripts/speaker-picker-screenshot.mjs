// Screenshot the rendered speaker picker in the sidebar (fake outputs stubbed in,
// since the VM has no real audio output devices). Saves to /opt/cursor/artifacts.
import puppeteer from "puppeteer-core";

const ROOM = `shot-${Math.random().toString(36).slice(2, 10)}`;
const URL = `http://localhost:8080/room/${ROOM}`;
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  defaultViewport: { width: 1100, height: 800 },
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const fakeOutputs = [
      { kind: "audiooutput", deviceId: "spk1", groupId: "g1", label: "MacBook Pro-högtalare" },
      { kind: "audiooutput", deviceId: "spk2", groupId: "g2", label: "Externa hörlurar" },
      { kind: "audiooutput", deviceId: "default", groupId: "g2", label: "Default - Externa hörlurar" },
    ];
    const realEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => {
      const real = await realEnum();
      return [...real.filter((d) => d.kind !== "audiooutput"), ...fakeOutputs];
    };
    HTMLMediaElement.prototype.setSinkId = function () { return Promise.resolve(); };
  });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", "Demo");
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });
  await page.waitForSelector("#speaker-picker:not([hidden])", { timeout: 10000 });
  await page.select("#speaker-select", "spk2");
  await new Promise((r) => setTimeout(r, 400));
  const out = "/opt/cursor/artifacts/speaker_picker_sidebar.png";
  await page.screenshot({ path: out });
  console.log("saved", out);
} finally {
  await browser.close();
}
