// Screenshot the in-room controls under an iPhone UA: mic + speaker pickers are
// hidden (system handles those), camera picker remains. Saves to /opt/cursor/artifacts.
import puppeteer from "puppeteer-core";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
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
  await page.setUserAgent(IPHONE_UA);
  await page.evaluateOnNewDocument(() => {
    navigator.mediaDevices.getDisplayMedia = undefined;
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: "audioinput", deviceId: "mic1", groupId: "a", label: "Mic 1" },
      { kind: "audioinput", deviceId: "mic2", groupId: "b", label: "Mic 2" },
      { kind: "videoinput", deviceId: "cam1", groupId: "c", label: "Främre kamera" },
      { kind: "videoinput", deviceId: "cam2", groupId: "d", label: "Bakre kamera" },
      { kind: "audiooutput", deviceId: "spk1", groupId: "e", label: "Speaker 1" },
      { kind: "audiooutput", deviceId: "spk2", groupId: "f", label: "Speaker 2" },
    ];
  });
  await page.goto(`http://localhost:8080/room/ios-shot-${Math.random().toString(36).slice(2, 8)}`, { waitUntil: "networkidle2" });
  await page.type("#name-input", "Demo");
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  const out = "/opt/cursor/artifacts/ios_pickers_hidden.png";
  await page.screenshot({ path: out });
  console.log("saved", out);
} finally {
  await browser.close();
}
