// Unit tests for the stats dashboard's pure formatting helpers (no DOM).

import { test } from "node:test";
import assert from "node:assert/strict";

import { asnLabel } from "../public/js/stats/format.js";

test("asnLabel: prefers the org name over a bare AS number", () => {
  assert.equal(
    asnLabel({ asn: 3301, asn_org: "Telia Company AB" }),
    "Telia Company AB",
  );
});

test("asnLabel: falls back to AS<n> when the org is missing or blank", () => {
  assert.equal(asnLabel({ asn: 3301, asn_org: "" }), "AS3301");
  assert.equal(asnLabel({ asn: 3301, asn_org: "   " }), "AS3301");
  assert.equal(asnLabel({ asn: 3301 }), "AS3301");
});

test("asnLabel: a null/absent ASN reads as okänd", () => {
  assert.equal(asnLabel({ asn: null }), "okänd");
  assert.equal(asnLabel({}), "okänd");
  assert.equal(asnLabel(), "okänd");
});

test("asnLabel: withNumber appends the AS number for tooltips", () => {
  assert.equal(
    asnLabel({ asn: 3301, asn_org: "Telia Company AB" }, { withNumber: true }),
    "Telia Company AB (AS3301)",
  );
  // No org -> just AS<n> (no redundant "(AS<n>)" suffix).
  assert.equal(asnLabel({ asn: 36183 }, { withNumber: true }), "AS36183");
  // null stays "okänd" regardless of withNumber.
  assert.equal(asnLabel({ asn: null }, { withNumber: true }), "okänd");
});
