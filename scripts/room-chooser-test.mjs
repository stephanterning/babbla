// e2e for the SPA room chooser + navigation.
//
// Model: `/` is a landing page (name + room chooser); `/room/x` shows the same
// chooser preselected to the URL room. Choosing/typing a room navigates in-app
// (history.pushState, NO reload) and connects. Leave returns to `/` in-app.
// Back/forward reconcile to the URL: leaving a room tears it down; landing on a
// room URL shows its join screen (preselected) WITHOUT auto-joining. Mute resets
// on a fresh room session; video-opt-out is a persistent preference.
//
// Single browser, single participant (join succeeds alone — no peer media), so
// it's fast and deterministic.
//
// Usage: node scripts/room-chooser-test.mjs   (BABBLA_URL from the e2e harness)
import puppeteer from "puppeteer-core";

const RAW = process.env.BABBLA_URL || "http://localhost:8080/room/test";
const ORIGIN = new URL(RAW).origin;
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable";
const roomA = `chooser-${Math.random().toString(36).slice(2, 8)}`;
const roomB = `bokmarke-${Math.random().toString(36).slice(2, 8)}`;

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});

const path = (p) => p.evaluate(() => location.pathname);
const hidden = (p, sel) => p.evaluate((s) => document.querySelector(s).hidden, sel);
const text = (p, sel) => p.evaluate((s) => document.querySelector(s).textContent.trim(), sel);
const pressed = (p, sel) => p.evaluate((s) => document.querySelector(s).getAttribute("aria-pressed"), sel);
const markNoReload = (p) => p.evaluate(() => { window.__kept = "yes"; });
const survivedNoReload = (p) => p.evaluate(() => window.__kept === "yes");
const waitRoomView = (p) =>
  p.waitForFunction(
    () => !document.getElementById("room-view").hidden &&
          document.getElementById("status").textContent.includes("ansluten"),
    { timeout: 10_000 },
  );
const waitJoinView = (p) =>
  p.waitForFunction(() => !document.getElementById("join-view").hidden, { timeout: 10_000 });

try {
  const page = await browser.newPage();

  // --- 1. Landing chooser (empty history) ---------------------------------
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle2" });
  check("landing: chooser visible", !(await hidden(page, "#room-chooser")));
  check("landing: dropdown hidden (empty history)", await hidden(page, "#room-select"));
  check("landing: free-text visible (empty history)", !(await hidden(page, "#room-input")));
  check("landing: join disabled until filled", await page.evaluate(() => document.getElementById("join-btn").disabled));

  // --- 2. SPA join (pushState, no reload) ---------------------------------
  await page.type("#name-input", "Alice");
  await page.type("#room-input", roomA);
  await markNoReload(page);
  await page.click("#join-btn");
  await waitRoomView(page);
  check("join: navigated to /room/<roomA>", (await path(page)) === `/room/${roomA}`, await path(page));
  check("join: no full reload (SPA)", await survivedNoReload(page));
  const hist1 = await page.evaluate(() => JSON.parse(localStorage.getItem("babbla:roomHistory") || "[]"));
  check("join: room recorded in history", hist1[0] === roomA, JSON.stringify(hist1));

  // --- 3. Onboarding arrow (alone) shows + dismiss ------------------------
  await page.waitForFunction(() => !document.getElementById("share-onboarding").hidden, { timeout: 5_000 });
  check("onboarding: arrow shown when alone", true);
  await page.click("#share-onboarding");
  check("onboarding: dismissed on click", await hidden(page, "#share-onboarding"));

  // --- 4. Mute + opt out of video, then leave (SPA) ----------------------
  await page.click("#mute-btn");
  await page.click("#video-off-btn");
  check("mute: button reflects muted", (await pressed(page, "#mute-btn")) === "false");
  await markNoReload(page);
  await page.click("#leave-btn");
  await waitJoinView(page);
  check("leave: returned to landing /", (await path(page)) === "/", await path(page));
  check("leave: no full reload (SPA)", await survivedNoReload(page));

  // --- 5. Landing dropdown now has history, preselected to most recent ----
  const sel = await page.evaluate(() => {
    const s = document.getElementById("room-select");
    return { hidden: s.hidden, value: s.value, options: [...s.options].map((o) => o.value) };
  });
  check("landing: dropdown shown once history exists", !sel.hidden);
  check("landing: most recent preselected", sel.value === roomA, sel.value);
  check("landing: 'another room' sentinel present", sel.options.includes("__other__"));

  // --- 6. Rejoin: mute reset (parity) but video-opt-out persists (pref) ---
  await waitJoinView(page);
  await page.click("#join-btn"); // name still filled, roomA preselected
  await waitRoomView(page);
  check("rejoin: mute reset to unmuted", (await pressed(page, "#mute-btn")) === "true");
  check("rejoin: video-opt-out persisted", (await text(page, "#video-off-btn")) === "Slå på video");
  await page.click("#leave-btn");
  await waitJoinView(page);

  // --- 7. Direct visit to a room URL → chooser preselected to URL room ----
  await page.goto(`${ORIGIN}/room/${roomB}`, { waitUntil: "networkidle2" });
  check("direct /room/x: chooser visible", !(await hidden(page, "#room-chooser")));
  check("direct /room/x: not auto-joined (join screen)", !(await hidden(page, "#join-view")));
  const selB = await page.evaluate(() => {
    const s = document.getElementById("room-select");
    return { hidden: s.hidden, value: s.value, options: [...s.options].map((o) => o.value) };
  });
  check("direct /room/x: URL room preselected", selB.value === roomB, selB.value);
  check("direct /room/x: URL room in list even if not in history", selB.options.includes(roomB));

  // --- 8. Join from the room URL in-place, then back/forward (popstate) ---
  await page.type("#name-input", "Alice");
  await markNoReload(page);
  await page.click("#join-btn");
  await waitRoomView(page);
  check("direct join: in /room/<roomB>", (await path(page)) === `/room/${roomB}`, await path(page));
  check("direct join: in-place, no reload", await survivedNoReload(page));

  // Back: from the room → previous entry. Should tear down to a join screen and
  // NOT auto-join.
  await page.goBack({ waitUntil: "networkidle2" }).catch(() => {});
  await waitJoinView(page);
  check("popstate back: room view torn down (join screen shown)", await hidden(page, "#room-view"));
  check("popstate back: not auto-joined", !(await hidden(page, "#join-view")));

  // Forward: to the room URL again → join screen (preselected), still no auto-join.
  await page.goForward({ waitUntil: "networkidle2" }).catch(() => {});
  await waitJoinView(page);
  check("popstate forward: room URL shows join screen", (await path(page)) === `/room/${roomB}`, await path(page));
  check("popstate forward: not auto-joined", await hidden(page, "#room-view"));

  // --- 9. Back during the mic prompt cancels the pending join -------------
  // Delay getUserMedia so we can press Back while the prompt is "open". The join
  // must NOT complete behind the landing screen, and no mic error should show.
  const page2 = await browser.newPage();
  await page2.evaluateOnNewDocument(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) =>
      new Promise((res, rej) => setTimeout(() => orig(c).then(res, rej), 1000));
  });
  await page2.goto(`${ORIGIN}/`, { waitUntil: "networkidle2" });
  await page2.type("#name-input", "Alice");
  await page2.type("#room-input", `pending-${Math.random().toString(36).slice(2, 7)}`);
  await page2.click("#join-btn");
  // The URL is pushed to the room synchronously, before the (delayed) mic prompt.
  await page2.waitForFunction(() => location.pathname.startsWith("/room/"), { timeout: 3_000 });
  await page2.evaluate(() => history.back());
  await page2.waitForFunction(
    () => location.pathname === "/" && !document.getElementById("join-view").hidden,
    { timeout: 3_000 },
  );
  // Wait past the getUserMedia delay so a buggy join would have surfaced by now.
  await new Promise((r) => setTimeout(r, 1500));
  check("mic-prompt back: not in room", await hidden(page2, "#room-view"));
  check("mic-prompt back: on landing /", (await path(page2)) === "/", await path(page2));
  check("mic-prompt back: no mic error shown", await hidden(page2, "#join-error"));
  await page2.close();

  const passed = results.every(Boolean);
  console.log(`VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
