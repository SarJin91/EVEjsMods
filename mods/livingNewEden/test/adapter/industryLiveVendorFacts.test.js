"use strict";

const assert = require("node:assert");

const { INDUSTRY_GROUPS, HAULER_KEY_BY_GROUP, HAULERS, RACE_BY_FACTION_ID, DEFAULT_RACE, MINERS } =
  require("../../lib/adapter/data/industryLiveProfiles");
const { INDUSTRY_HULL_GROUPS } = require("../../lib/fleets/schema");
const { npcSetupTables } = require("../_support/setupTables");

module.exports = ({ test, skip }) => {
  test("IP1a industry table: groups = industrial + INDUSTRY_HULL_GROUPS, every race has haulers", () => {
    assert.deepStrictEqual([...INDUSTRY_GROUPS], ["industrial", ...INDUSTRY_HULL_GROUPS]);
    for (const group of [...Object.keys(HAULER_KEY_BY_GROUP), ...Object.keys(MINERS)]) {
      assert.ok(INDUSTRY_GROUPS.includes(group), group);
    }
    for (const race of [...new Set([...Object.values(RACE_BY_FACTION_ID), DEFAULT_RACE])]) {
      assert.ok(Object.prototype.hasOwnProperty.call(HAULERS, race), race);
      for (const key of new Set(Object.values(HAULER_KEY_BY_GROUP))) {
        assert.ok(typeof HAULERS[race][key] === "string" && HAULERS[race][key] !== "", `${race} ${key}`);
      }
    }
  });

  const ip1 = "IP1 vendor facts: every industry profile exists in npcProfiles (entityType npc, shipTypeID > 0)";
  const setup = npcSetupTables();
  if (!setup.ok) skip(ip1, setup.reason);
  else {
    test(ip1, () => {
      const rows = setup.tables.npcProfiles.profiles;
      const byId = new Map(rows.map((p) => [p.profileID, p]));
      const ids = new Set([...Object.values(HAULERS).flatMap((h) => Object.values(h)), ...Object.values(MINERS)]);
      for (const id of ids) {
        const row = byId.get(id);
        assert.ok(row, `${id} exists`);
        assert.strictEqual(row.entityType, "npc", id);
        assert.ok(Number.isInteger(row.shipTypeID) && row.shipTypeID > 0, `${id} shipTypeID`);
      }
    });
  }
};
