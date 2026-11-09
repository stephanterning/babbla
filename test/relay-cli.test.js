import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const script of ["relay-live-check.mjs", "relay-cloudflare-check.mjs"]) {
  test(`${script} refuses to contact an implicit installation`, () => {
    const result = spawnSync(process.execPath, [`scripts/${script}`], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  });
}
