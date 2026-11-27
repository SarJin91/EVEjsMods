"use strict";

const assert = require("node:assert");
const { createFakeSovNative } = require("../_support/fakeSovNative");
const { createSovNativeReader, filetimeToMs, FILETIME_EPOCH_OFFSET, FILETIME_TICKS_PER_MS } = require("../../lib/adapter/sovNative");

module.exports = ({ test }) => {
  function makeRequireGame(fake) {
    return (relPath) => {
      if (relPath === "services/sovereignty/sovState") {
        return { ok: true, exports: { getSystemState: fake.getSystemState } };
      }
      if (relPath === "services/sovereignty/sovStore") {
        return { ok: true, exports: { readSovereigntyTableUpdatedAt: fake.readSovereigntyTableUpdatedAt } };
      }
      return { ok: false, reason: "not_in_game_modules" };
    };
  }

  test("TA4 readCampaignOutcomes: never throws, returns structural error on failure", () => {
    const fake = createFakeSovNative();
    fake.faults.getSystemState = "throw";
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res = reader.readCampaignOutcomes(30000001);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "SOV_UNAVAILABLE");
  });

  test("TA4 readCampaignOutcomes: ascending by completedAtMs, tie-break campaignEpoch, targetId", () => {
    const fake = createFakeSovNative();
    fake.setOutcomes(30000001, [
      { targetId: 1, campaignEpoch: "b", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 2000 },
      { targetId: 2, campaignEpoch: "a", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 1000 },
      { targetId: 3, campaignEpoch: "a", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 1000 },
    ]);
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res = reader.readCampaignOutcomes(30000001, { max: 10 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.outcomes.length, 3);
    assert.strictEqual(res.outcomes[0].completedAtMs, 1000);
    assert.strictEqual(res.outcomes[0].targetId, 2);
    assert.strictEqual(res.outcomes[1].targetId, 3);
    assert.strictEqual(res.outcomes[2].targetId, 1);
  });

  test("TA4 readCampaignOutcomes: max limits to newest, truncated=true", () => {
    const fake = createFakeSovNative();
    fake.setOutcomes(30000001, [
      { targetId: 1, campaignEpoch: "1", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 1000 },
      { targetId: 2, campaignEpoch: "2", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 2000 },
      { targetId: 3, campaignEpoch: "3", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 3000 },
    ]);
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res = reader.readCampaignOutcomes(30000001, { max: 2 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(res.outcomes.length, 2);
    assert.strictEqual(res.outcomes[0].targetId, 2);
    assert.strictEqual(res.outcomes[1].targetId, 3);
  });

  test("TA4 readCampaignOutcomes: skipped counts invalid records", () => {
    const fake = createFakeSovNative();
    fake.setOutcomes(30000001, [
      { targetId: 1, campaignEpoch: "1", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 1000 },
      { targetId: 0, campaignEpoch: "2", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 2000 },
      { targetId: 3, campaignEpoch: "", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 3000 },
      { targetId: 4, campaignEpoch: "4", defenderAllianceId: 0, result: "attacker", completedAtMs: 4000 },
      { targetId: 5, campaignEpoch: "5", defenderAllianceId: 99000001, result: "invalid", completedAtMs: 5000 },
      { targetId: 6, campaignEpoch: "6", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 0 },
    ]);
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res = reader.readCampaignOutcomes(30000001, { max: 10 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.outcomes.length, 1);
    assert.strictEqual(res.skipped, 5);
  });

  test("TA4 readCampaignOutcomes: skipped counts completedAtTime <= offset or unreadable (including '0')", () => {
    const fake = createFakeSovNative();
    const sys = fake.getSystemState(30000001);
    fake.setOutcomes(30000001, [
      { targetId: 1, campaignEpoch: "1", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 1000 },
    ]);
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res = reader.readCampaignOutcomes(30000001, { max: 10, offsetMs: 500 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.outcomes.length, 1);
    const res2 = reader.readCampaignOutcomes(30000001, { max: 10, offsetMs: 2000 });
    assert.strictEqual(res2.skipped, 1);
  });

  test("TA4 readCampaignOutcomes: frozen vendor record unchanged, result = new objects", () => {
    const fake = createFakeSovNative();
    fake.setOutcomes(30000001, [
      { targetId: 1, campaignEpoch: "1", defenderAllianceId: 99000001, result: "attacker", completedAtMs: 1000 },
    ]);
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res1 = reader.readCampaignOutcomes(30000001, { max: 10 });
    const res2 = reader.readCampaignOutcomes(30000001, { max: 10 });
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res2.ok, true);
    assert.notStrictEqual(res1.outcomes, res2.outcomes);
    assert.notStrictEqual(res1.outcomes[0], res2.outcomes[0]);
    assert.deepStrictEqual(res1.outcomes[0], res2.outcomes[0]);
  });

  test("TA4 readUpdatedAt: returns updatedAt from sovStore", () => {
    const fake = createFakeSovNative();
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res = reader.readUpdatedAt();
    assert.strictEqual(res.ok, true);
    assert.ok(typeof res.updatedAt === "string");
  });

  test("TA4 readUpdatedAt: structural error when sovStore unavailable", () => {
    const fake = createFakeSovNative();
    fake.faults.readSovereigntyTableUpdatedAt = "throw";
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res = reader.readUpdatedAt();
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "SOV_STORE_UNAVAILABLE");
  });

  test("TA4 checkSovNativeSeams: ok when both seams available", () => {
    const fake = createFakeSovNative();
    const reader = createSovNativeReader({ requireGame: makeRequireGame(fake) });
    const res = reader.checkSovNativeSeams();
    assert.strictEqual(res.ok, true);
  });

  test("TA4 checkSovNativeSeams: missing seam names returned", () => {
    const fake = createFakeSovNative();
    const drift = (relPath) => (relPath === "services/sovereignty/sovState" || relPath === "services/sovereignty/sovStore"
      ? { ok: true, exports: {} } : makeRequireGame(fake)(relPath));
    const reader = createSovNativeReader({ requireGame: drift });
    const res = reader.checkSovNativeSeams();
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "SEAM_MISSING");
    assert.deepStrictEqual(res.missing, ["sovState.getSystemState", "sovStore.readSovereigntyTableUpdatedAt"]);
    const storeOnly = createSovNativeReader({ requireGame: (relPath) => (relPath === "services/sovereignty/sovStore"
      ? { ok: true, exports: {} } : makeRequireGame(fake)(relPath)) });
    assert.deepStrictEqual(storeOnly.checkSovNativeSeams().missing, ["sovStore.readSovereigntyTableUpdatedAt"]);
  });

  test("TA4 filetimeToMs constants match vendor", () => {
    assert.strictEqual(FILETIME_EPOCH_OFFSET, 116444736000000000n);
    assert.strictEqual(FILETIME_TICKS_PER_MS, 10000n);
    const ms = 1700000000000;
    const ft = (FILETIME_EPOCH_OFFSET + BigInt(ms) * FILETIME_TICKS_PER_MS).toString();
    assert.strictEqual(filetimeToMs(ft), ms);
  });
};