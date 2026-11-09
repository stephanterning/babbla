// User-agent bucketing. We never store the raw UA string (it's a fingerprint
// surface). Instead we reduce it to a few low-cardinality buckets that carry the
// analytic value we actually want — "does iOS-WebKit relay more often?",
// version/OS correlations — without the long fingerprintable tail. See
// .cursor/plans/stats-poc.md "Leak-safe by default".
//
// Deliberately a small, dependency-free heuristic (not a full UA parser): order
// matters (Edge/Opera before Chrome; Chrome before Safari, since Chrome's UA
// also contains "Safari"). Anything unrecognized buckets to "Other".

/**
 * @param {string} ua
 * @returns {{ ua_browser: string, ua_version_major: string|null,
 *   ua_os: string, is_ios: 0|1, is_chromium: 0|1 }}
 */
export function parseUserAgent(ua) {
  const s = String(ua || "");

  const os = detectOs(s);
  // All iOS browsers are WebKit (even "Chrome"/"Edge" on iPhone) — central to
  // babbla's AEC3/relay story, so flag it explicitly off the OS, not the brand.
  const isIos = os === "iOS" ? 1 : 0;

  const { browser, version } = detectBrowser(s);
  // Chromium engine (desktop Chrome/Edge/Opera/Brave). NOT true on iOS, where
  // every brand is WebKit regardless of name.
  const isChromium =
    !isIos && /(Chrome|Chromium|CriOS|Edg|OPR)\//.test(s) ? 1 : 0;

  return {
    ua_browser: browser,
    ua_version_major: version,
    ua_os: os,
    is_ios: isIos,
    is_chromium: isChromium,
  };
}

function detectOs(s) {
  if (/iPhone|iPad|iPod/.test(s)) return "iOS";
  // iPadOS Safari reports as "Macintosh"; we can't reliably split it out here,
  // so it buckets as macOS — acceptable for the PoC.
  if (/Android/.test(s)) return "Android";
  if (/Windows/.test(s)) return "Windows";
  if (/Mac OS X|Macintosh/.test(s)) return "macOS";
  if (/Linux|X11|CrOS/.test(s)) return "Linux";
  return "Other";
}

function detectBrowser(s) {
  // Order matters: the more specific brands first.
  const rules = [
    ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["Opera", /OPR\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    // Chrome on iOS is CriOS; desktop/Android Chrome is Chrome.
    ["Chrome", /(?:CriOS|Chrome|Chromium)\/(\d+)/],
    ["Safari", /Version\/(\d+).*Safari/],
  ];
  for (const [name, re] of rules) {
    const m = s.match(re);
    if (m) return { browser: name, version: m[1] ?? null };
  }
  return { browser: "Other", version: null };
}
