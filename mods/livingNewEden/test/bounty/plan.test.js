"use strict";

const assert = require("node:assert");

const { rollTarget, pickNextSystem, gangSpecOf } = require("../../lib/bounty/plan");
const { buildTerritory } = require("../../lib/bounty/territory");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { DATA } = require("../../lib/names/generate");
const { OWNER_KINDS, OWNER_PREFIXES, FLEET_OWNER_KINDS, parseIdentityKey } = require("../../lib/virtualCorps/schema");
const { buildPilotCandidates, buildCivilianCandidates } = require("../../lib/virtualCorps/pilotCandidates");
const { buildOwnerPlan } = require("../../lib/virtualCorps/identityPlan");

const POCHVEN = 10000070;
const SYSTEMS = Object.freeze({ 1: "nullsec", 2: "nullsec", 3: "nullsec", 4: "highsec", 5: "lowsec", 6: "lowsec",
  7: "lowsec", 8: "nullsec" });
const LINKS = Object.freeze({ 1: [2], 2: [1, 3, 6], 3: [2, 4], 4: [3, 5], 5: [4], 6: [2, 7], 7: [6, 8], 8: [7] });

function graph() {
  return {
    getSystem: (id) => (SYSTEMS[id] ? { id: Number(id), secClass: SYSTEMS[id], regionId: Number(id) === 8 ? POCHVEN
      : 10000001, constellationId: 20000001 } : null),
    getNeighbors: (id) => (LINKS[id] ? LINKS[id].slice() : null),
  };
}
function territoryOf(g) {
  const systems = Object.keys(SYSTEMS).map(Number).map((id) => ({ systemId: id, ...g.getSystem(id), gated: true }));
  const t = buildTerritory({ systems, factionOfSystem: new Map(), usableFactionIds: [500010],
    excludedRegionIds: new Set([POCHVEN]) });
  assert.strictEqual(t.ok, true);
  return t;
}

function roll(over) {
  const g = graph();
  return rollTarget({ worldSeed: 7, slot: 1, cycle: 1, factionId: 500010, now: 1000, levels: LEVELS,
    territory: territoryOf(g), busySystems: new Set(), smugglerPermille: 150, ...over });
}

module.exports = ({ test }) => {
  test("BH2 rollTarget / pickNextSystem: deterministic, class of the level, busy and excluded avoided, "
    + "NO_NEIGHBOR keeps the target, smuggler L3+ x1.5", () => {
    assert.deepStrictEqual(roll(), roll(), "same inputs -> same row");
    const levelsSeen = new Set();
    let smugglers = 0;
    for (let cycle = 1; cycle <= 300; cycle += 1) {
      const r = roll({ cycle, busySystems: new Set([6]) });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      const row = r.row;
      levelsSeen.add(row.level);
      assert.ok(LEVELS[row.level].secClasses.includes(SYSTEMS[row.systemId]), `cycle ${cycle}`);
      assert.notStrictEqual(row.systemId, 6, "busy system never a start");
      assert.notStrictEqual(row.systemId, 8, "excluded region never a start");
      assert.ok(row.nextMoveAt - 1000 >= LEVELS[row.level].stayMs[0] && row.nextMoveAt - 1000 <= LEVELS[row.level].stayMs[1]);
      assert.strictEqual(row.expiresAt, 1000 + LEVELS[row.level].lifetimeMs);
      if (row.smuggler === 1) {
        smugglers += 1;
        assert.ok(row.level >= 3);
        assert.strictEqual(row.rewardIsk, LEVELS[row.level].rewardIsk * 1.5);
      } else {
        assert.strictEqual(row.rewardIsk, LEVELS[row.level].rewardIsk);
      }
      if (row.level <= 2) assert.notStrictEqual(row.archetype, "AMBUSH");
    }
    assert.deepStrictEqual([...levelsSeen].sort(), [1, 2, 3, 4, 5, 6]);
    assert.ok(smugglers > 0 && smugglers < 60, `smugglers ${smugglers} of ~300 * 0.27 * 0.15`);
    assert.deepStrictEqual(roll({ busySystems: new Set([1, 2, 3, 4, 5, 6, 7]) }), { ok: false, reason: "NO_SYSTEM" });
    assert.deepStrictEqual(roll({ slot: 0 }), { ok: false, reason: "INVALID_INPUT" });

    const g = graph();
    const territory = territoryOf(g);
    const move = (over) => pickNextSystem({ seed: 12345, stayIndex: 0, systemId: 2, level: 3, factionId: 500010,
      levels: LEVELS, territory, graph: g, busySystems: new Set([2]), now: 5000, ...over });
    assert.deepStrictEqual(move(), move(), "same seed and stay_index -> same move");
    const nullTargets = new Set();
    for (let i = 0; i < 40; i += 1) {
      const m = move({ stayIndex: i });
      assert.strictEqual(m.ok, true);
      assert.ok([1, 3].includes(m.systemId), "nullsec neighbours of 2 only (6 is lowsec)");
      nullTargets.add(m.systemId);
    }
    assert.deepStrictEqual([...nullTargets].sort(), [1, 3]);
    assert.deepStrictEqual(move({ busySystems: new Set([1, 2]) }).systemId, 3, "busy neighbour skipped");
    assert.deepStrictEqual(move({ busySystems: new Set([1, 2, 3]) }), { ok: false, reason: "NO_NEIGHBOR" });
    for (let i = 0; i < 20; i += 1) {
      assert.strictEqual(move({ systemId: 7, level: 1, stayIndex: i, busySystems: new Set([7]) }).systemId, 6);
    }
    assert.deepStrictEqual(move({ systemId: 7, level: 1, busySystems: new Set([6, 7]) }),
      { ok: false, reason: "NO_NEIGHBOR" });
    const floor = move({ minStayMs: 999999999 });
    assert.strictEqual(floor.nextMoveAt, 5000 + 999999999, "minStayMs is the floor of the stay");
  });

  test("BH4 outlaw owner kind: prefix o, parseIdentityKey, never a pilot / civilian candidate; gangSpecOf passes "
    + "buildOwnerPlan", () => {
    assert.strictEqual(OWNER_KINDS.OUTLAW, "outlaw");
    assert.strictEqual(OWNER_PREFIXES.outlaw, "o");
    assert.ok(!FLEET_OWNER_KINDS.includes("outlaw"));
    assert.deepStrictEqual(parseIdentityKey("o:3:corp:0:char:1"),
      { type: "character", factionId: 3, slot: 0, n: 1, ownerPrefix: "o" });
    const prefixOwner = Object.fromEntries(Object.entries(OWNER_PREFIXES).map(([k, v]) => [v, k]));
    assert.strictEqual(prefixOwner[parseIdentityKey("o:3:corp:0:char:1").ownerPrefix], "outlaw");
    const rows = [
      { kind: "corporation", identity_key: "o:3:corp:0", owner_kind: "outlaw", owner_id: 3, evejs_id: 98000001 },
      { kind: "character", identity_key: "o:3:corp:0:char:0", owner_kind: "outlaw", owner_id: 3, evejs_id: 92000001 },
      { kind: "character", identity_key: "f:500010:corp:0:char:0", owner_kind: "faction", owner_id: 500010,
        evejs_id: 91000001 },
    ];
    assert.deepStrictEqual(buildPilotCandidates(rows).map((c) => c.characterId), [91000001]);
    assert.deepStrictEqual(buildCivilianCandidates(rows), []);

    const spec = gangSpecOf({ slot: 3, factionId: 500010, worldSeed: 7, members: 3,
      home: { stationId: 60012556, corporationId: 1000127, systemId: 30001290 },
      system: { constellationId: 20000188, regionId: 10000015 }, bloodlineIds: [1, 2, 11], securityRating: -5 });
    assert.strictEqual(spec.ok, true);
    assert.deepStrictEqual(spec, gangSpecOf({ slot: 3, factionId: 500010, worldSeed: 7, members: 3,
      home: { stationId: 60012556, corporationId: 1000127, systemId: 30001290 },
      system: { constellationId: 20000188, regionId: 10000015 }, bloodlineIds: [1, 2, 11], securityRating: -5 }));
    assert.strictEqual(spec.spec.ownerKind, "outlaw");
    assert.strictEqual(spec.spec.ownerId, 3);
    const surname = spec.spec.corporation.name.split(" ").slice(0, -1).join(" ");
    assert.ok(DATA.caldari.last.includes(surname), `Guristas -> caldari surname: ${spec.spec.corporation.name}`);
    assert.ok(/^[A-Z0-9]{2,5}$/.test(spec.spec.corporation.ticker), spec.spec.corporation.ticker);
    const plan = buildOwnerPlan(spec.spec);
    assert.strictEqual(plan.ok, true, JSON.stringify(plan));
    assert.deepStrictEqual(plan.entries.map((e) => e.key),
      ["o:3:corp:0", "o:3:corp:0:char:0", "o:3:corp:0:char:1", "o:3:corp:0:char:2"]);
  });

  test("BRW1 reward rebalance: level rewards 50M..4B, rewardPermille scales a new target before the "
    + "smuggler x1.5, the roll itself unchanged, 0 = no reward, invalid -> INVALID_INPUT", () => {
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map((l) => LEVELS[l].rewardIsk),
      [50000000, 120000000, 350000000, 750000000, 1500000000, 4000000000], "pinned on purpose");
    let plain = 0;
    let smugglers = 0;
    for (let cycle = 1; cycle <= 120; cycle += 1) {
      const base = roll({ cycle });
      const same = roll({ cycle, rewardPermille: 1000 });
      const x25 = roll({ cycle, rewardPermille: 2500 });
      const zero = roll({ cycle, rewardPermille: 0 });
      assert.deepStrictEqual(same, base, "1000 = no multiplier (absent key)");
      const { rewardIsk: r25, ...rest25 } = x25.row;
      const { rewardIsk: r0, ...rest0 } = zero.row;
      const { rewardIsk: r1, ...rest1 } = base.row;
      assert.deepStrictEqual(rest25, rest1, "the multiplier never changes the roll");
      assert.deepStrictEqual(rest0, rest1);
      const level = LEVELS[base.row.level].rewardIsk;
      const scaled = Math.floor((level * 2500) / 1000);
      assert.strictEqual(r1, base.row.smuggler === 1 ? level * 1.5 : level);
      assert.strictEqual(r25, base.row.smuggler === 1 ? Math.floor((scaled * 1500) / 1000) : scaled);
      assert.strictEqual(r0, 0);
      if (base.row.smuggler === 1) smugglers += 1;
      else plain += 1;
    }
    assert.ok(plain > 0 && smugglers > 0, `plain ${plain}, smugglers ${smugglers}`);
    const max = roll({ rewardPermille: 100000, levels: { ...LEVELS, 1: LEVELS[6], 2: LEVELS[6], 3: LEVELS[6],
      4: LEVELS[6], 5: LEVELS[6] } });
    assert.ok(Number.isSafeInteger(max.row.rewardIsk) && max.row.rewardIsk >= 400000000000, String(max.row.rewardIsk));
    for (const bad of [-1, 1.5, "1000", null]) {
      assert.deepStrictEqual(roll({ rewardPermille: bad }), { ok: false, reason: "INVALID_INPUT" }, String(bad));
    }
  });
};
