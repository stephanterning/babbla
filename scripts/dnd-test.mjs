// End-to-end check for "Stör ej" (Do Not Disturb). Verifies the feature across
// two real Chrome instances (one per participant, per the VM constraint that
// two WebRTC tabs in one browser crash the renderer):
//
//   1. Presence: the DND peer shows a moon badge on their tile for others, on
//      their own self-tile, and on the enlarged stage; a late joiner sees it
//      from the welcome roster; exiting DND clears every badge.
//   2. Media path (both directions, instrumented so it can't false-negative):
//      RTCRtpSender.replaceTrack is hooked, so we assert the DND user actually
//      pauses their outbound senders (replaceTrack(null)) AND the other peer
//      pauses what it sends the DND user — and both resume (replaceTrack(track))
//      on exit. The local presentation gate mutes the DND user's incoming audio.
//   3. Presence chimes: entering DND plays the falling leave tone for the other
//      peer (and is silent for self); leaving DND plays the rising join tone
//      for the other peer (silent for self). OscillatorNode.start is hooked so
//      the tones are classified as rising/falling rather than assumed.
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-dnd-${Math.random().toString(36).slice(2, 8)}`;

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

// Hook replaceTrack before any app script runs so we can prove the mesh actually
// paused/resumed senders (not just that a badge flipped). __rt.sinceMark is reset
// by __rtMark() so each phase is measured independently.
async function newClient(name, x) {
  const browser = await puppeteer.launch(launch(x));
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__rt = { nulls: 0, tracks: 0 };
    const proto = window.RTCRtpSender && window.RTCRtpSender.prototype;
    if (proto && proto.replaceTrack) {
      const orig = proto.replaceTrack;
      proto.replaceTrack = function (track) {
        if (track === null) window.__rt.nulls++;
        else window.__rt.tracks++;
        return orig.call(this, track);
      };
    }
    // Count audio getUserMedia acquisitions and audio-track stops so we can prove
    // DND releases the mic device (stop) and re-acquires it on exit (gUM).
    window.__gum = { audio: 0 };
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const origGum = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => {
        if (c && c.audio) window.__gum.audio++;
        return origGum(c);
      };
    }
    window.__stops = { audio: 0 };
    const tp = window.MediaStreamTrack && window.MediaStreamTrack.prototype;
    if (tp && tp.stop) {
      const origStop = tp.stop;
      tp.stop = function () {
        if (this.kind === "audio") window.__stops.audio++;
        return origStop.call(this);
      };
    }
    // Record every presence chime by the frequency of each scheduled note, so a
    // rising (join-style) tone can be told apart from a falling (leave) one.
    window.__tones = [];
    const op = window.OscillatorNode && window.OscillatorNode.prototype;
    if (op && op.start) {
      const origStart = op.start;
      op.start = function (...args) {
        try {
          window.__tones.push(this.frequency.value);
        } catch {}
        return origStart.apply(this, args);
      };
    }
    window.__rtMark = () => {
      window.__rt = { nulls: 0, tracks: 0 };
      window.__gum = { audio: 0 };
      window.__stops = { audio: 0 };
      window.__tones = [];
    };
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page };
}

const mark = (page) => page.evaluate(() => window.__rtMark());
const rt = (page) => page.evaluate(() => ({ ...window.__rt }));

const peerDnd = (page) =>
  page.evaluate(() => {
    const t = document.querySelector(".video-tile:not(.self)");
    return !!t && t.classList.contains("is-dnd");
  });
const selfDnd = (page) =>
  page.evaluate(() =>
    !!document.querySelector(".video-tile.self")?.classList.contains("is-dnd"),
  );
// Every incoming <audio> is muted by the presentation gate (and there's at least
// one, so the assertion isn't vacuously true).
const incomingAudioMuted = (page) =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll("#audio-sink audio")];
    return els.length > 0 && els.every((a) => a.muted);
  });
const anyIncomingAudioUnmuted = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#audio-sink audio")].some((a) => !a.muted),
  );
// Chimes are two-note sequences: rising = join-style ping, falling = leave.
const chimes = (page) =>
  page.evaluate(() => {
    const t = [...window.__tones];
    const out = { rising: 0, falling: 0 };
    for (let i = 0; i + 1 < t.length; i += 2) {
      if (t[i + 1] > t[i]) out.rising++;
      else out.falling++;
    }
    return out;
  });
const gum = (page) => page.evaluate(() => ({ ...window.__gum }));
const stops = (page) => page.evaluate(() => ({ ...window.__stops }));
const btnDisabled = (page, id) =>
  page.evaluate((sel) => !!document.getElementById(sel)?.disabled, id);

(async () => {
  const a = await newClient("Alice", 20);
  const b = await newClient("Bob", 800);
  let c = null;
  try {
    await sleep(6000); // connect + mesh + audio flowing

    // --- Alice enters DND -------------------------------------------------
    await Promise.all([mark(a.page), mark(b.page)]);
    await a.page.click("#dnd-btn");
    await sleep(3000);

    check("Bob sees Alice's tile with the DND (moon) badge", await peerDnd(b.page));
    check("Alice sees her own self-tile in DND", await selfDnd(a.page));
    check(
      "Alice's DND button reads 'Avsluta Stör ej'",
      (await a.page.$eval("#dnd-btn", (el) => el.textContent.trim())) ===
        "Avsluta Stör ej",
    );
    check("Alice's incoming audio is muted by the presentation gate", await incomingAudioMuted(a.page));

    const aStops = await stops(a.page);
    const aGum = await gum(a.page);
    check("Alice released the mic device on DND (audio track stopped)", aStops.audio > 0);
    check("Alice did NOT re-acquire the mic while entering DND", aGum.audio === 0);
    check("Alice's mute button is disabled in DND", await btnDisabled(a.page, "mute-btn"));
    check("Alice's camera button is disabled in DND", await btnDisabled(a.page, "camera-btn"));
    check("Alice's share button is disabled in DND", await btnDisabled(a.page, "share-btn"));

    const aRt = await rt(a.page);
    const bRt = await rt(b.page);
    check("Alice paused her outbound senders (replaceTrack(null))", aRt.nulls > 0);
    check("Bob paused what he sends Alice (replaceTrack(null))", bRt.nulls > 0);

    const bChimeEnter = await chimes(b.page);
    check(
      "Bob hears the leave chime when Alice enters DND",
      bChimeEnter.rising === 0 && bChimeEnter.falling === 1,
    );
    const aChimeEnter = await chimes(a.page);
    check(
      "Alice hears no chime for her own DND enter",
      aChimeEnter.rising === 0 && aChimeEnter.falling === 0,
    );

    await b.page.screenshot({ path: "/opt/cursor/artifacts/dnd_peer_tile.png" });
    await a.page.screenshot({ path: "/opt/cursor/artifacts/dnd_self_tile.png" });

    // (No stage-badge assertion: a DND peer sends no camera/screen, so their tile
    // has no focusable video and can't be enlarged onto the stage while in DND.
    // The stage moon badge — updateStageDnd — stays as a defensive mirror of the
    // mute badge for any transient focused→DND race, but isn't reachable here.)

    // --- Alice exits DND --------------------------------------------------
    await Promise.all([mark(a.page), mark(b.page)]);
    await a.page.click("#dnd-btn");
    await sleep(3000);

    check("Bob's tile badge clears after Alice exits DND", !(await peerDnd(b.page)));
    check("Alice's self badge clears after exit", !(await selfDnd(a.page)));
    check("Alice's incoming audio unmutes after exit", await anyIncomingAudioUnmuted(a.page));
    check("Alice re-acquired the mic on exit (getUserMedia)", (await gum(a.page)).audio > 0);
    check("Alice's mute button is re-enabled after exit", !(await btnDisabled(a.page, "mute-btn")));

    const aRt2 = await rt(a.page);
    const bRt2 = await rt(b.page);
    check("Alice resumed her outbound senders (replaceTrack(track))", aRt2.tracks > 0);
    check("Bob resumed sending to Alice (replaceTrack(track))", bRt2.tracks > 0);

    // Coming back from DND is announced to the others with the join chime, so
    // nobody keeps talking to someone they think is still away.
    const bChimeExit = await chimes(b.page);
    check(
      "Bob hears the join chime when Alice returns from DND",
      bChimeExit.rising === 1 && bChimeExit.falling === 0,
    );
    const aChimeExit = await chimes(a.page);
    check(
      "Alice hears no chime for her own DND exit",
      aChimeExit.rising === 0 && aChimeExit.falling === 0,
    );

    // --- Welcome roster: late joiner sees DND -----------------------------
    await a.page.click("#dnd-btn"); // Alice back into DND
    await sleep(1500);
    c = await newClient("Carol", 800);
    await sleep(6000);
    check("Late joiner Carol sees Alice in DND from the welcome roster", await peerDnd(c.page));
    const cChime = await chimes(c.page);
    check(
      "Late joiner Carol hears no DND chime from the welcome roster",
      cChime.rising === 0 && cChime.falling === 0,
    );

    const allPass = results.every(([, ok]) => ok);
    console.log(
      `VERDICT: ${allPass ? "PASS" : "FAIL"} (${results.filter(([, ok]) => ok).length}/${results.length})`,
    );
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await a.browser.close();
    await b.browser.close();
    if (c) await c.browser.close();
  }
})();
