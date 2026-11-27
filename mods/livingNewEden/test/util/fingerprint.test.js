"use strict";

const assert = require("node:assert");

const { stableJson, fingerprint, fingerprintWithPayloadJson } = require("../../lib/util/fingerprint");

const PAYLOADS = Object.freeze([
  { b: { z: [1, { y: 2, x: [3, 4] }], a: null }, a: "x" },
  [3, [2, [1, []]], { k: "v" }],
  { name: "Zażółć gęślą jaźń \u{1F680}", "klucz-ü": "\u0000\u001f\"\\" },
  { n: -42, f: -0.125, big: 1e21, tiny: 5e-324, i: 9007199254740991 },
  {},
  [],
  null,
  "plain string",
]);

const HEADS = Object.freeze([
  { kind: "APPLY", aggregateType: "fleet", aggregateId: "fl-1", eventType: "FLEET_CREATED" },
  { eventType: "STRATEGY_REVIEW", aggregateType: "faction", aggregateId: "500019" },
]);

module.exports = ({ test }) => {
  test("FP1 fingerprintWithPayloadJson equals fingerprint({...head, payload}) for 8 payloads x 2 heads", () => {
    const bad = [];
    for (const head of HEADS) {
      for (const payload of PAYLOADS) {
        const want = fingerprint({ ...head, payload });
        const got = fingerprintWithPayloadJson(head, stableJson(payload));
        if (got !== want || !/^[0-9a-f]{64}$/.test(got)) bad.push({ head, payload, got, want });
      }
    }
    assert.deepStrictEqual(bad, []);
  });

  test("FP2 head with a payload key, not a plain object, or holding non-JSON data -> TypeError", () => {
    assert.throws(() => fingerprintWithPayloadJson({ kind: "APPLY", payload: 1 }, "1"), TypeError);
    assert.throws(() => fingerprintWithPayloadJson(null, "1"), TypeError);
    assert.throws(() => fingerprintWithPayloadJson(new Map(), "1"), TypeError);
    assert.throws(() => fingerprintWithPayloadJson({ eventType: undefined }, "1"), TypeError);
  });
};
