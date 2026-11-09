import test from "node:test";
import assert from "node:assert/strict";

import {
  createIceErrorReportGate,
  sanitizeIceErrorReport,
} from "../ice-error-report.js";

test("sanitizeIceErrorReport strips log-control characters and bounds fields", () => {
  const report = sanitizeIceErrorReport({
    url: `turn:relay.example:3478\n${"x".repeat(220)}`,
    errorCode: "701.9",
    errorText: "timeout\u001b[2J\r\nforged log line",
  });

  assert.equal(report.errorCode, 701);
  assert.equal(report.url.length, 200);
  assert.doesNotMatch(report.url, /[\r\n]/);
  assert.equal(report.errorText, "timeout [2J forged log line");
});

test("ICE error gate deduplicates and caps distinct reports per connection", () => {
  const accept = createIceErrorReportGate({ maxDistinct: 2 });

  assert.deepEqual(accept({ url: "turn:a", errorCode: 401 }), {
    url: "turn:a",
    errorCode: 401,
    errorText: "",
  });
  assert.equal(accept({ url: "turn:a", errorCode: 401, errorText: "retry" }), null);
  assert.ok(accept({ url: "turn:b", errorCode: 701 }));
  assert.equal(accept({ url: "turn:c", errorCode: 403 }), null);
});
