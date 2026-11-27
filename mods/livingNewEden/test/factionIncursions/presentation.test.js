"use strict";

const assert = require("node:assert");

const S = require("../../lib/factionIncursions/schema");
const { buildUiEntries, buildHudIncursions } = require("../../lib/factionIncursions/presentation");
const { buildIncursionUiPayload, mergeEntries } = require("../../lib/world/invasions/incursionUi");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { T0, TRIG, SYS, harness, boot } = require("./harness");

const ROLES4 = [{ systemId: 31, role: "hq" }, { systemId: 32, role: "assault" }, { systemId: 33, role: "vanguard" },
  { systemId: 34, role: "staging" }];
const view = (over) => ({ incursionId: 1, factionId: TRIG, constellationId: 2, targetSystemId: 31, systems: ROLES4,
  influenceMilli: 456, state: "ACTIVE", phase: "ESTABLISHED", expiresAt: T0 + 1, influenceRawMilli: 500,
  influenceUpdatedAt: T0, graceMinutes: 10, decayMilliPerHour: 20, ...over });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();

  test("FI9 window entries: buildUiEntries, mergeEntries, listUiEntries off / on", () => {
    const entries = buildUiEntries([
      view(),
      view({ incursionId: 2, factionId: 500027, phase: "MOBILIZING", systems: ROLES4.slice(0, 3), influenceMilli: 4 }),
      view({ incursionId: 3, state: "DECIDED" }),
      view({ incursionId: 4, phase: "WITHDRAWING" }),
      view({ incursionId: 5, phase: "OVER" }),
    ], { templateNameID: 7, maxEntries: 16 });
    assert.deepStrictEqual(entries.map((e) => [e.taleID, e.aggressorFactionID, e.state, e.influence,
      e.stagingSolarSystemID]), [[9500000000001, TRIG, 2, 0.46, 34], [9500000000002, 500027, 1, 0, 33],
      [9500000000004, TRIG, 0, 0.46, 34], [9500000000005, TRIG, 0, 0.46, 34]]);
    assert.deepStrictEqual(entries[0], { taleID: S.taleIdOf(1), severity: 4, stagingSolarSystemID: 34, state: 2,
      templateNameID: 7, templateClassID: 2, aggressorFactionID: TRIG, influence: 0.46,
      systems: [{ solarSystemID: 31, sceneType: 1, templateNameID: 7 }, { solarSystemID: 32, sceneType: 2,
        templateNameID: 7 }, { solarSystemID: 33, sceneType: 3, templateNameID: 7 }, { solarSystemID: 34,
        sceneType: 4, templateNameID: 7 }], effects: [], incursedSystems: [31, 32, 33, 34], rewardGroupID: 0,
      hasChat: false, hasFinalEncounter: false, chatAnnouncementMessageId: 0, musicState: null });
    assert.strictEqual(buildUiEntries([view(), view({ incursionId: 2 })], { templateNameID: 0, maxEntries: 1 }).length,
      1);
    assert.deepStrictEqual(buildHudIncursions([view(), view({ incursionId: 5, phase: "OVER" }),
      view({ incursionId: 3, state: "DECIDED" })]).map((h) => [h.taleId, h.influenceMilli, h.systems[3].sceneType]),
    [[9500000000001, 500, 4]]);

    const rows = [{ roll_round: 0, faction_id: 500020, beachhead_system_id: 33, state: "ACTIVE", started_at: T0,
      withdraw_at: T0 + 1000 }, { roll_round: 1, faction_id: 500020, beachhead_system_id: 99, state: "ACTIVE",
      started_at: T0, withdraw_at: T0 + 1000 }, { roll_round: 2, faction_id: 500020, beachhead_system_id: 98,
      state: "ACTIVE", started_at: T0, withdraw_at: T0 + 1000 }];
    const inv = buildIncursionUiPayload(rows, { now: T0, templateNameID: 0, maxEntries: 16 });
    assert.deepStrictEqual(mergeEntries(inv, [entries[0]], 16).map((e) => e.taleID),
      [9000000000002, 9000000000003, 9500000000001], "the invasion staged in 33 drops out");
    assert.deepStrictEqual(mergeEntries(inv.slice(1), [entries[0]], 2).map((e) => e.taleID),
      [9000000000002, 9500000000001], "maxEntries 2: 1 invasion + 1 incursion");
    assert.deepStrictEqual(mergeEntries(inv, [], 16), inv, "no extra: the invasions unchanged");

    if (!driver.ok) return;
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const off = boot(h);
      assert.strictEqual(off.runPass(T0).created, 1, JSON.stringify(h.lines));
      assert.deepStrictEqual(off.listUiEntries({ templateNameID: 0, maxEntries: 16 }), { ok: true, entries: [] },
        "ui.enabled off -> no entries");
      off.stop();
      const on = boot(h, { EVEJS_LNE_FACTION_INCURSIONS_UI_ENABLED: "1" });
      const r = on.listUiEntries({ templateNameID: 0, maxEntries: 16 });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(r.entries.map((e) => [e.taleID, e.aggressorFactionID, e.state, e.influence,
        e.stagingSolarSystemID, e.systems.map((s) => s.sceneType)]),
      [[9500000000001, TRIG, 2, 0.6, SYS[3], [1, 2, 3, 4]]]);
      const raw = on.listActive().incursions[0];
      assert.deepStrictEqual([raw.influenceRawMilli, raw.influenceUpdatedAt, raw.graceMinutes, raw.decayMilliPerHour],
        [600, T0, 10, 20]);
      on.stop();
    });
  });

  if (!driver.ok) skip("FI9 listUiEntries on a store", `better-sqlite3 unavailable (${driver.detail})`);
};
