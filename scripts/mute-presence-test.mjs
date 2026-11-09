// Manual/automated check for mic-mute presence: a peer who mutes their mic shows
// a persistent mic-off badge on (1) their tile for other peers, (2) their own
// self-tile, (3) the enlarged stage when focused, and (4) the welcome roster for
// a late joiner. Drives separate Chrome instances (one per participant) per the
// VM constraint that two WebRTC tabs in one browser crash the renderer.
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-mute-presence-${Math.random().toString(36).slice(2, 8)}`;

const launch = (x) => ({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--window-position=${x},40`,
    "--window-size=760,800",
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
};

async function newClient(name, x) {
  const browser = await puppeteer.launch(launch(x));
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page };
}

// Is the lone other participant's tile flagged muted on this page?
const peerMuted = (page) =>
  page.evaluate(() => {
    const t = document.querySelector(".video-tile:not(.self)");
    return !!t && t.classList.contains("is-muted");
  });
const selfMuted = (page) =>
  page.evaluate(() =>
    !!document.querySelector(".video-tile.self")?.classList.contains("is-muted"),
  );
const stageMuteVisible = (page) =>
  page.evaluate(() => {
    const el = document.getElementById("screen-mute");
    return !!el && !el.hidden;
  });

(async () => {
  const a = await newClient("Alice", 20);
  const b = await newClient("Bob", 800);
  let c = null;
  try {
    await sleep(6000); // connect + mesh

    // Alice turns the camera on so there's something to enlarge on the stage.
    await a.page.click("#camera-btn");
    await sleep(4000);

    // Alice mutes.
    await a.page.click("#mute-btn");
    await sleep(2500);

    check("Bob sees Alice's tile as muted", await peerMuted(b.page));
    check("Alice sees her own self-tile as muted", await selfMuted(a.page));
    await b.page.screenshot({ path: "/opt/cursor/artifacts/mute_peer_tile.png" });
    await a.page.screenshot({ path: "/opt/cursor/artifacts/mute_self_tile.png" });

    // Bob focuses Alice's camera → enlarged stage should show the mic-off badge.
    await b.page.click(".video-tile:not(.self)");
    await sleep(2000);
    check("Bob's stage shows the mic-off badge for muted Alice", await stageMuteVisible(b.page));
    await b.page.screenshot({ path: "/opt/cursor/artifacts/mute_stage_badge.png" });

    // Alice unmutes → badge clears on the tile and the stage.
    await a.page.click("#mute-btn");
    await sleep(2500);
    check("Bob's stage badge clears after Alice unmutes", !(await stageMuteVisible(b.page)));
    check("Bob's tile badge clears after Alice unmutes", !(await peerMuted(b.page)));

    // Welcome roster: Alice re-mutes, then Carol joins and must see it from the
    // initial roster (no live mute event while Carol was connecting).
    await a.page.click("#mute-btn");
    await sleep(1500);
    c = await newClient("Carol", 800);
    await sleep(6000);
    check("Late joiner Carol sees Alice muted from the welcome roster", await peerMuted(c.page));

    const allPass = results.every(([, ok]) => ok);
    console.log(`VERDICT: ${allPass ? "PASS" : "FAIL"} (${results.filter(([, ok]) => ok).length}/${results.length})`);
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await a.browser.close();
    await b.browser.close();
    if (c) await c.browser.close();
  }
})();
