"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildStandingGrantCall, applyStandingGrantFrom, readPirateFactionIdsFrom } =
  require("../../lib/adapter/standingWrite");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const DATA = Object.freeze({ eventTypeId: 486, msgByReason: { PIRATE_SUPPRESSION: "Pirate suppression" } });
const GRANT = Object.freeze({ key: "lne:std:7:1:500001:30000001:k5", characterId: 7, factionId: 500001,
  rawChange: 0.0002, reason: "PIRATE_SUPPRESSION" });

function functionBody(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} declared`);
  const rest = source.slice(start);
  return rest.slice(0, rest.search(/^\}/m));
}

module.exports = ({ test }) => {
  test("S5a buildStandingGrantCall: exact shape and key order (vendor fingerprint)", () => {
    const call = buildStandingGrantCall(GRANT, DATA);
    assert.strictEqual(JSON.stringify(call), "{\"ok\":true,\"characterId\":7,\"changes\":[{\"ownerID\":500001,"
      + "\"rawChange\":0.0002,\"eventTypeID\":486,\"applySocial\":false,\"msg\":\"Pirate suppression\"}],"
      + "\"options\":{\"idempotencyKey\":\"lne:std:7:1:500001:30000001:k5\",\"disableDerived\":true,"
      + "\"preservePrecision\":true}}");
    assert.strictEqual(buildStandingGrantCall({ ...GRANT, reason: "NOPE" }, DATA).reason, "GRANT_INVALID");
    assert.strictEqual(buildStandingGrantCall({ ...GRANT, key: " " }, DATA).reason, "GRANT_INVALID");
  });

  test("S5b applyStandingGrantFrom maps every vendor result, never throws", () => {
    const rt = (r) => ({ applyStandingChanges: () => r });
    const applied = applyStandingGrantFrom(rt({ success: true, data: { appliedChanges: [{ fromID: 500001,
      previousStanding: 1, standing: 1.0018 }] } }), GRANT, DATA);
    assert.deepStrictEqual(applied, { ok: true, outcome: "APPLIED", previousStanding: 1, standing: 1.0018 });
    assert.strictEqual(applyStandingGrantFrom(rt({ success: true, duplicate: true, data: {} }), GRANT, DATA).outcome,
      "DUPLICATE");
    const perm = (msg) => applyStandingGrantFrom(rt({ success: false, errorMsg: msg }), GRANT, DATA);
    assert.deepStrictEqual([perm("CHARACTER_NOT_FOUND").reason, perm("CHARACTER_NOT_FOUND").permanent],
      ["CHARACTER_NOT_FOUND", true]);
    assert.deepStrictEqual([perm("IDEMPOTENCY_KEY_REUSED").reason, perm("IDEMPOTENCY_KEY_REUSED").permanent],
      ["IDEMPOTENCY_KEY_REUSED", true]);
    assert.strictEqual(perm("IDEMPOTENCY_KEY_INVALID").reason, "GRANT_INVALID");
    assert.deepStrictEqual([perm("WRITE_ERROR").reason, perm("WRITE_ERROR").permanent],
      ["STANDING_WRITE_FAILED", false]);
    const threw = applyStandingGrantFrom({ applyStandingChanges() { throw new Error("boom"); } }, GRANT, DATA);
    assert.deepStrictEqual([threw.reason, threw.permanent], ["STANDING_THREW", false]);
    assert.deepStrictEqual(applyStandingGrantFrom({}, GRANT, DATA), { ok: false, reason: "SEAM_UNAVAILABLE",
      permanent: false });
    assert.strictEqual(applyStandingGrantFrom(null, null, null).reason, "GRANT_INVALID");
    const ids = readPirateFactionIdsFrom({ PIRATE_FACTION_BY_FACTION_ID: { 500010: "guristas", 500011: "angels" } });
    assert.deepStrictEqual([...ids.ids], [500010, 500011]);
    assert.strictEqual(readPirateFactionIdsFrom({}).reason, "PIRATE_SET_UNAVAILABLE");
  });

  test("S5c vendor facts (v0.12.9 source text): receipts, options, atomic receipt + standing, vendor loss", () => {
    const source = fs.readFileSync(path.join(SERVER_SRC, "services", "character", "standingRuntime.js"), "utf8");
    const exportsAt = source.search(/^module\.exports = \{/m);
    assert.ok(exportsAt >= 0);
    const block = source.slice(exportsAt);
    assert.match(block.slice(0, block.search(/^\};/m)), /^ {2}applyStandingChanges,/m);
    const body = functionBody(source, "applyStandingChanges");
    for (const fact of ["\"idempotencyKey\"", "IDEMPOTENCY_KEY_REUSED", "standingOperationReceipts",
      "preservePrecision", "options.disableDerived", "applySocial === false"]) {
      assert.ok(body.includes(fact), fact);
    }
    const write = body.indexOf("updateCharacterRecord(");
    const receipt = body.indexOf("receipts[idempotencyKey] =");
    const after = body.indexOf("if (!writeResult.success)");
    assert.ok(write >= 0 && write < receipt && receipt < after, "receipt written in the same record update");
    const loss = fs.readFileSync(path.join(SERVER_SRC, "services", "character", "factionKillStandingRuntime.js"),
      "utf8");
    assert.ok(loss.includes("ownerID: factionID") && loss.includes("disableDerived: true"),
      "the vendor loss hits the victim faction only");
  });
};
