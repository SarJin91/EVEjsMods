"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildHullTradeTypes, HULL_TRADE_METHOD, levelOf } = require("../../tools/trade/buildHullTradeTypes");
const { readMetaGroups } = require("../../tools/strength/sdeReader");
const HULL_TRADE_TYPES = require("../../lib/economy/data/hullTradeTypes");
const STRENGTH = require("../../lib/battle/data/strengthCatalog");

const SDE = { buildNumber: 1, releaseDate: "2026-01-01T00:00:00Z" };
const PINNED_SDE_BUILD = 3724492;
const PINNED_SDE = path.join(__dirname, "..", "..", "..", "..", "_local", "sde",
  `eve-online-static-data-${PINNED_SDE_BUILD}-jsonl`);

const METHOD = Object.freeze({
  tableVersion: 1,
  groups: ["frigate", "cruiser"],
  sourceGroups: { frigate: [25], cruiser: [26] },
  baseGroups: ["frigate"],
  races: [1, 2],
  skillAttributes: [182, 183, 184],
  maxSkillDepth: 8,
  maxTypes: 32,
  factionShipRace: { 500002: 2, 500001: 1 },
  raceControls: {},
});

const T1 = { 422: 1, 633: 0 };
const T2 = { 422: 2, 633: 5, 1692: 2 };
const NAVY = { 422: 1, 633: 7, 1692: 4 };

function fixture() {
  const dogma = new Map([
    [101, { 182: 102 }], [102, { 182: 100, 183: 900 }], [201, { 182: 200 }],
    [1001, { 182: 101, ...T1 }], [1002, { 182: 101, ...T1 }], [1003, { 182: 101, ...T1 }], [1004, { 182: 101, ...T1 }],
    [1005, { 182: 101, ...NAVY }], [1006, { 182: 101, 183: 201, ...T1 }], [1007, { 182: 101, ...T1 }],
    [2001, { 182: 101, ...T2 }],
    [1101, { 182: 201, ...T1 }], [2101, { 182: 201, ...T1 }], [2102, { 182: 201, ...T2 }],
  ]);
  const sums = { 1001: 100, 1002: 300, 1003: 200, 1004: 200, 1005: 50, 1006: 60, 1007: 70, 2001: 900, 1101: 150,
    2101: 800, 2102: 700 };
  const blueprints = new Map(Object.entries(sums).map(([t, q]) => [Number(t), { blueprintTypeId: Number(t) + 50000,
    timeSec: 60, materials: [{ typeId: 34, quantity: q }], productQuantity: 1 }]));
  const hull = (typeId, groupId, hullGroup) => ({ typeId, groupId, hullGroup });
  const types = [hull(1001, 25, "frigate"), hull(1002, 25, "frigate"), hull(1003, 25, "frigate"),
    hull(1004, 25, "frigate"), hull(1005, 25, "frigate"), hull(1006, 25, "frigate"), hull(1007, 999, "frigate"),
    hull(2001, 26, "cruiser"), hull(1101, 25, "frigate"), hull(2101, 26, "cruiser"), hull(2102, 26, "cruiser")];
  const races = [{ raceId: 1, skills: [100, 900] }, { raceId: 2, skills: [200, 900] }, { raceId: 4, skills: [400] }];
  return { sde: SDE, types, blueprints, dogma, races };
}

module.exports = ({ test, skip }) => {
  test("TH1 c1 buildHullTradeTypes fixture: skill closure race, T1 before T2, navy / two-race rejected, lower median, "
    + "RACE_GROUP_EMPTY, RACE_SKILLS_AMBIGUOUS, deterministic source", () => {
    const inputs = fixture();
    const r = buildHullTradeTypes(inputs, METHOD);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(r.races, { 1: { frigate: 1003, cruiser: 2001 }, 2: { frigate: 1101, cruiser: 2101 } });
    assert.deepStrictEqual(r.rows.map((x) => [x.raceId, x.group, x.level, x.mineralSum, x.sampleSize]),
      [[1, "frigate", "T1", 200, 4], [1, "cruiser", "T2", 900, 1], [2, "frigate", "T1", 150, 1],
        [2, "cruiser", "T1", 800, 1]]);
    assert.deepStrictEqual(r.factionRace, { 500001: 1, 500002: 2 });
    assert.strictEqual(r.header.typeCount, 4);
    assert.ok(r.source.startsWith("\"use strict\";\n"), r.source.slice(0, 40));

    const shuffled = { ...fixture(), types: [...fixture().types].reverse() };
    assert.strictEqual(buildHullTradeTypes(shuffled, METHOD).source, r.source);

    const noFrigate = fixture();
    noFrigate.types = noFrigate.types.filter((t) => t.typeId !== 1101);
    assert.deepStrictEqual(buildHullTradeTypes(noFrigate, METHOD), { ok: false, reason: "RACE_GROUP_EMPTY",
      detail: "2:frigate" });
    const shared = fixture();
    shared.races = [{ raceId: 1, skills: [100, 900] }, { raceId: 2, skills: [900] }];
    assert.deepStrictEqual(buildHullTradeTypes(shared, METHOD), { ok: false, reason: "RACE_SKILLS_AMBIGUOUS",
      detail: "2" });
    assert.strictEqual(buildHullTradeTypes(fixture(), { ...METHOD, maxTypes: 3 }).reason, "TOO_MANY_TYPES");
    assert.deepStrictEqual(buildHullTradeTypes(fixture(), { ...METHOD, raceControls: { 1001: 2 } }),
      { ok: false, reason: "RACE_CONTROL_MISMATCH", detail: "1001 race 1 != 2" });
    assert.ok(buildHullTradeTypes(fixture(), { ...METHOD, raceControls: { 1001: 1 } }).ok);
  });

  test("TH2 c1 generated hullTradeTypes: 4 races x 5 base groups, <= 32 types, hulls of strengthCatalog, "
    + "FACTION_RACE 10 entries", () => {
    const { HEADER, RACES, FACTION_RACE } = HULL_TRADE_TYPES;
    assert.ok(Object.isFrozen(RACES) && Object.isFrozen(FACTION_RACE));
    assert.deepStrictEqual(Object.keys(RACES).sort(), ["1", "2", "4", "8"]);
    const distinct = new Set();
    for (const [race, row] of Object.entries(RACES)) {
      for (const g of HULL_TRADE_METHOD.baseGroups) assert.ok(Number.isSafeInteger(row[g]), `${race}:${g}`);
      for (const [g, typeId] of Object.entries(row)) {
        assert.ok(HULL_TRADE_METHOD.groups.includes(g), g);
        const t = STRENGTH.TYPES[typeId];
        assert.ok(t && t.hullGroup === g && HULL_TRADE_METHOD.sourceGroups[g].includes(t.groupId), `${typeId} ${g}`);
        distinct.add(typeId);
      }
    }
    assert.ok(distinct.size <= 32, String(distinct.size));
    assert.strictEqual(HEADER.typeCount, distinct.size);
    assert.deepStrictEqual(FACTION_RACE, { 500001: 1, 500002: 2, 500003: 4, 500004: 8, 500010: 1, 500011: 2,
      500012: 4, 500016: 8, 500019: 4, 500020: 8 });
  });

  test("TH3 c1 metaGroupID wins over dogma: dogma T1 without 1692 and metaGroupID 4 rejected, 1 -> T1, 2 -> T2, "
    + "absent -> dogma", () => {
    const LEGACY_NAVY = { 422: 1, 633: 0 };
    assert.strictEqual(levelOf(LEGACY_NAVY, 4), null);
    assert.strictEqual(levelOf(LEGACY_NAVY, 1), "T1");
    assert.strictEqual(levelOf(T1, 2), "T2");
    assert.strictEqual(levelOf(LEGACY_NAVY, undefined), "T1");
    assert.strictEqual(levelOf(NAVY, undefined), null);
    assert.strictEqual(levelOf(undefined, 1), "T1");

    const inputs = fixture();
    inputs.dogma.set(1005, { 182: 101, ...LEGACY_NAVY });
    const legacy = buildHullTradeTypes(inputs, METHOD);
    assert.strictEqual(legacy.rows[0].sampleSize, 5);
    inputs.types = inputs.types.map((t) => (t.typeId === 1005 ? { ...t, metaGroupId: 4 } : t));
    const r = buildHullTradeTypes(inputs, METHOD);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(r.rows[0], { raceId: 1, group: "frigate", typeId: 1003, level: "T1", mineralSum: 200,
      sampleSize: 4 });
  });

  if (!fs.existsSync(path.join(PINNED_SDE, "types.jsonl"))) {
    skip("TH4 c1 generated hullTradeTypes picks are T1/T2 by metaGroupID of the pinned SDE",
      `pinned SDE missing: ${PINNED_SDE}`);
  } else {
    test("TH4 c1 generated hullTradeTypes picks are T1/T2 by metaGroupID of the pinned SDE", async () => {
      const { HEADER, RACES } = HULL_TRADE_TYPES;
      assert.strictEqual(HEADER.sdeBuild, PINNED_SDE_BUILD);
      const picked = [];
      for (const [race, row] of Object.entries(RACES)) {
        for (const [g, typeId] of Object.entries(row)) picked.push({ race, g, typeId });
      }
      const metaGroups = await readMetaGroups(PINNED_SDE, picked.map((p) => p.typeId));
      for (const p of picked) {
        const mg = metaGroups.get(p.typeId);
        const want = HULL_TRADE_METHOD.baseGroups.includes(p.g) ? [1] : [1, 2];
        assert.ok(want.includes(mg), `${p.race}:${p.g} ${p.typeId} metaGroupID ${mg}`);
      }
      assert.deepStrictEqual(Object.values(RACES).map((row) => row.battlecruiser), [24698, 24702, 24696, 24700]);
    });
  }
};
