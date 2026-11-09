const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function sanitizeIceErrorReport(msg = {}) {
  const code = Number(msg.errorCode);
  return {
    url: cleanText(msg.url, 200),
    errorCode: Number.isFinite(code) ? Math.trunc(code) : 0,
    errorText: cleanText(msg.errorText, 200),
  };
}

export function createIceErrorReportGate({ maxDistinct = 20 } = {}) {
  const seen = new Set();
  return (msg) => {
    const report = sanitizeIceErrorReport(msg);
    const key = `${report.url}|${report.errorCode}`;
    if (seen.has(key) || seen.size >= maxDistinct) return null;
    seen.add(key);
    return report;
  };
}
