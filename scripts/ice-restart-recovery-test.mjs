// Regression test for ICE-restart recovery (the fix for the reported instability
// where one device permanently lost others while a freshly joined device worked).
//
// Before the fix: connectionState "failed" -> onPeerFailed -> the peer was
// removed locally with no ICE restart and no rebuild, so a transient blip
// severed a pair for the rest of the session.
//
// After the fix: "failed" keeps the peer, marks it "uncertain", and drives
// pc.restartIce() with backoff over the (still-live) WebSocket. Only a locally
// CLOSED pc is removed.
//
// We can't deterministically induce a real ICE failure in loopback, so we spoof
// pc.connectionState on one client and dispatch connectionstatechange, then
// assert behaviour:
//   1. Spoof "failed"  -> restartIce() is called AND the peer tile is retained
//      (marked uncertain), not removed.
//   2. Spoof "connected" -> uncertain is cleared.
//   3. Real pc.close() (-> "closed") -> the peer IS removed.
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const W = 1000;
const H = 720;
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

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  // Collect every RTCPeerConnection and count restartIce() calls per pc so the
  // test can both spoof states and observe recovery.
  await page.evaluateOnNewDocument(() => {
    window.__pcs = [];
    const Orig = window.RTCPeerConnection;
    const Wrapped = function (...args) {
      const pc = new Orig(...args);
      pc.__restartIceCalls = 0;
      const realRestart = pc.restartIce?.bind(pc);
      pc.restartIce = function () {
        pc.__restartIceCalls++;
        return realRestart ? realRestart() : undefined;
      };
      window.__pcs.push(pc);
      return pc;
    };
    Wrapped.prototype = Orig.prototype;
    window.RTCPeerConnection = Wrapped;
  });
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15000 });
  return { browser, page };
}

function remoteTileCount(page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll(".video-tile")].filter(
        (el) => !el.classList.contains("self") && !el.classList.contains("screen-tile"),
      ).length,
  );
}

function uncertainTileCount(page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll(".video-tile.connection-uncertain")].length,
  );
}

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label} -> ${JSON.stringify(detail)}`);
  }
}

(async () => {
  const a = await newClient("Alice");
  const b = await newClient("Bob");
  try {
    await sleep(6000);
    check("baseline: Bob sees Alice", (await remoteTileCount(b.page)) === 1, {
      n: await remoteTileCount(b.page),
    });
    // ICE still asks every configured STUN URL after host candidates already
    // connected the pair, so a healthy P2P call routinely records 701s. Those
    // must not paint the yellow "Fel från STUN/TURN" box while everyone is
    // ansluten (the screenshot bug).
    const healthyHealth = await b.page.evaluate(() => {
      const box = document.getElementById("ice-health");
      return {
        hidden: !box || box.hidden,
        text: box?.textContent || "",
      };
    });
    check(
      "healthy P2P call does not show STUN/TURN gathering errors",
      !/Fel från STUN\/TURN|701/.test(healthyHealth.text),
      healthyHealth,
    );

    // Inject the same leftover 701s a healthy gather records. They must not
    // park on a connected pair, and must not reappear when we later spoof
    // failed (a minutes-old gathering timeout is not an active error).
    await b.page.evaluate(() => {
      for (const pc of window.__pcs) {
        for (const spec of [
          { url: "stun:stun.l.google.com:19302", errorCode: 701, errorText: "STUN binding request timed out." },
          { url: "stun:stun1.l.google.com:19302", errorCode: 701, errorText: "STUN binding request timed out." },
          { url: "turn:relay.example:3478?transport=udp", errorCode: 701, errorText: "TURN allocate request timed out." },
        ]) {
          const ev = new Event("icecandidateerror");
          Object.assign(ev, spec);
          pc.dispatchEvent(ev);
        }
      }
    });
    const afterInjected701 = await b.page.evaluate(() => {
      const box = document.getElementById("ice-health");
      return { hidden: !box || box.hidden, text: box?.textContent || "" };
    });
    check(
      "injected 701s on a connected pair stay off the health box",
      !/Fel från STUN\/TURN|701/.test(afterInjected701.text),
      afterInjected701,
    );

    // 1. Spoof every Bob pc as "failed" and fire the event.
    console.log("-- spoofing Bob's connection as 'failed' --");
    await b.page.evaluate(() => {
      for (const pc of window.__pcs) {
        Object.defineProperty(pc, "connectionState", {
          configurable: true,
          get: () => "failed",
        });
        pc.dispatchEvent(new Event("connectionstatechange"));
      }
    });

    // Peer must be retained immediately (not torn down on "failed").
    await sleep(500);
    if (process.env.SHOT_DIR) {
      await b.page.screenshot({ path: `${process.env.SHOT_DIR}/recovery_failed_retained.png` });
      console.log(`screenshot -> ${process.env.SHOT_DIR}/recovery_failed_retained.png`);
    }
    check("on 'failed': Bob still sees Alice (not removed)", (await remoteTileCount(b.page)) === 1, {
      n: await remoteTileCount(b.page),
    });
    check("on 'failed': tile marked uncertain", (await uncertainTileCount(b.page)) === 1, {
      n: await uncertainTileCount(b.page),
    });
    const failedHealth = await b.page.evaluate(() => {
      const box = document.getElementById("ice-health");
      return { hidden: !box || box.hidden, text: box?.textContent || "" };
    });
    check(
      "osäker after a healthy gather does not resurrect leftover 701s",
      !/Fel från STUN\/TURN|701/.test(failedHealth.text),
      failedHealth,
    );

    // A *new* error while the pair is actually stuck is active and must show.
    await b.page.evaluate(() => {
      for (const pc of window.__pcs) {
        const ev = new Event("icecandidateerror");
        Object.assign(ev, {
          url: "turn:relay.example:3478?transport=udp",
          errorCode: 401,
          errorText: "Unauthorized.",
        });
        pc.dispatchEvent(ev);
      }
    });
    const active401 = await b.page.evaluate(() => {
      const box = document.getElementById("ice-health");
      return { hidden: !box || box.hidden, text: box?.textContent || "" };
    });
    check(
      "a fresh 401 on an osäker pair is shown",
      /401/.test(active401.text) && /Fel från STUN\/TURN/.test(active401.text),
      active401,
    );

    // Wait past the recovery backoff (impolite 2 s, polite ~4 s) + a margin.
    await sleep(6000);
    const restarts = await b.page.evaluate(() =>
      window.__pcs.reduce((s, pc) => s + (pc.__restartIceCalls || 0), 0),
    );
    check("recovery called restartIce() at least once", restarts >= 1, { restarts });
    check("still retained after recovery window", (await remoteTileCount(b.page)) === 1, {
      n: await remoteTileCount(b.page),
    });

    // 2. Spoof back to "connected" -> uncertain cleared.
    console.log("-- spoofing Bob's connection back to 'connected' --");
    await b.page.evaluate(() => {
      for (const pc of window.__pcs) {
        Object.defineProperty(pc, "connectionState", {
          configurable: true,
          get: () => "connected",
        });
        pc.dispatchEvent(new Event("connectionstatechange"));
      }
    });
    await sleep(1000);
    check("on 'connected': uncertain cleared", (await uncertainTileCount(b.page)) === 0, {
      n: await uncertainTileCount(b.page),
    });
    const healedHealth = await b.page.evaluate(() => {
      const box = document.getElementById("ice-health");
      return { hidden: !box || box.hidden, text: box?.textContent || "" };
    });
    check(
      "healed pair drops the active 401 from the health box",
      !/Fel från STUN\/TURN|401/.test(healedHealth.text),
      healedHealth,
    );

    // 3. A genuinely closed pc is still removed.
    console.log("-- closing Bob's pcs for real ('closed' -> remove) --");
    await b.page.evaluate(() => {
      for (const pc of window.__pcs) {
        // Drop the spoof so the real "closed" state surfaces.
        delete pc.connectionState;
        try {
          pc.close();
        } catch {}
        pc.dispatchEvent(new Event("connectionstatechange"));
      }
    });
    await sleep(2000);
    check("on 'closed': peer removed", (await remoteTileCount(b.page)) === 0, {
      n: await remoteTileCount(b.page),
    });
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
