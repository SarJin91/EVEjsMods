"use strict";

const assert = require("node:assert");

const P = require("../../lib/playerHunt/policy");
const S = require("../../lib/playerHunt/schema");
const { FACTION_KINDS } = require("../../lib/strategy/registry");

const T = Object.freeze({ hostileMax: -5, friendlyMin: 5 });
const POLICY = S.parseNeutralPolicy("pirate:hostile,invader:hostile,empire:ignore,police:ignore,neutral:ignore");
const SCAN = Object.freeze({ basePermille: 250, minPermille: 50, maxPermille: 900, refSignatureM: 100 });

module.exports = ({ test }) => {
  test("PH5b: huntThresholds off = as before, on = friendlyMin 2 (2.5 spared, 1.9 hunted)", () => {
    const base = { hostileStandingMax: -5, friendlyStandingMin: 5, loyaltySpareStandingMin: 2 };
    assert.deepStrictEqual(P.huntThresholds({ ...base, loyaltySpareEnabled: false }), { hostileMax: -5, friendlyMin: 5 });
    const on = P.huntThresholds({ ...base, loyaltySpareEnabled: true });
    assert.deepStrictEqual(on, { hostileMax: -5, friendlyMin: 2 });
    assert.strictEqual(P.isTarget(P.classifyStanding(2.5, on), "pirate", { pirate: "hostile" }), false);
    assert.strictEqual(P.isTarget(P.classifyStanding(1.9, on), "pirate", { pirate: "hostile" }), true);
  });
  test("PH5 policy: classifyStanding, isTarget, hasScanner, sweepOrder, scanRoll, pickCandidate, parsers", () => {
    const got = {};
    got.classify = [-5, -4.99, 0, 4.99, 5, Number.NaN].map((v) => P.classifyStanding(v, T));
    got.target = [["hostile", "empire"], ["neutral", "pirate"], ["neutral", "empire"], ["friendly", "pirate"],
      ["hostile", ""], ["neutral", "unknown"]].map(([cls, kind]) => P.isTarget(cls, kind, POLICY));
    got.scanner = [
      P.hasScanner([{ hullGroup: "frigate", typeId: null, count: 3 }, { hullGroup: "ewar", typeId: null, count: 1 }],
        ["ewar"]),
      P.hasScanner([{ hullGroup: "frigate", typeId: null, count: 3 }], ["ewar"]),
      P.hasScanner([{ hullGroup: "ewar", typeId: null, count: 0 }], ["ewar"]),
      P.hasScanner([{ hullGroup: "ewar", typeId: null, count: 2 }], [])];
    const objects = [{ kind: "planet", itemId: 40 }, { kind: "stargate", itemId: 70 }, { kind: "moon", itemId: 1 },
      { kind: "stargate", itemId: 50 }, { kind: "station", itemId: 60 }];
    const kinds = ["stargate", "station", "asteroidBelt", "planet"];
    const tag = (list) => list.map((o) => `${o.kind}:${o.itemId}`);
    got.sweep = [tag(P.sweepOrder(objects, kinds, 0)), tag(P.sweepOrder(objects, kinds, 6)),
      tag(P.sweepOrder([], kinds, 3))];
    const a = P.scanRoll(12345, 3, 100, SCAN);
    got.scanSame = JSON.stringify(a) === JSON.stringify(P.scanRoll(12345, 3, 100, SCAN));
    got.scanChance = [P.scanRoll(1, 0, 100, SCAN).chancePermille, P.scanRoll(1, 0, 1, SCAN).chancePermille,
      P.scanRoll(1, 0, 10000, SCAN).chancePermille, P.scanRoll(1, 0, 0, SCAN).chancePermille,
      P.scanRoll(1, 0, 150, SCAN).chancePermille];
    got.scanEdges = [P.scanRoll(7, 1, 100, { ...SCAN, minPermille: 1000, maxPermille: 1000 }).found,
      P.scanRoll(7, 1, 100, { ...SCAN, basePermille: 0, minPermille: 0, maxPermille: 0 }).found];
    let hits = 0;
    for (let cycle = 0; cycle < 400; cycle += 1) if (P.scanRoll(99, cycle, 100, SCAN).found) hits += 1;
    got.scanRate = hits >= 70 && hits <= 130;
    const fleet = (fleetId, extra = {}) => ({ fleetId, factionId: 500010, state: "IDLE", operationId: null,
      refitPending: false, fleetRole: "patrol", shipCount: 5, ...extra });
    const kindOf = (f) => (f === 500010 ? "pirate" : f === 500018 ? "neutral" : null);
    const opts = { roles: ["patrol", "garrison"], maxShips: 10, excludedFactions: [500018], factionKindOf: kindOf };
    got.pick = [
      P.pickCandidate([fleet("f_c"), fleet("f_a", { state: "STAGED" }), fleet("f_b", { refitPending: true }),
        fleet("f_0", { operationId: "op" }), fleet("f_1", { fleetRole: "logistics" }), fleet("f_2", { shipCount: 11 }),
        fleet("f_3", { factionId: 500018 }), fleet("f_4", { factionId: 500099 }), fleet("f_d")], opts),
      P.pickCandidate([fleet("f_x", { state: "MATERIALIZED" })], opts)].map((f) => (f ? f.fleetId : null));
    got.pickLarger = [
      P.pickCandidate([fleet("f_a", { shipCount: 1, fleetRole: "garrison" }), fleet("f_z", { shipCount: 8 }),
        fleet("f_y", { shipCount: 8 }), fleet("f_b", { shipCount: 11 })], opts),
      P.pickCandidate([fleet("f_b", { shipCount: 3 }), fleet("f_a", { shipCount: 3 })], opts)]
      .map((f) => (f ? f.fleetId : null));
    got.parse = [S.parseNeutralPolicy("pirate:hostile,pirate:ignore"), S.parseNeutralPolicy("pirate:attack"),
      S.parseRoleList("patrol,ghost"), S.parseObjectKinds("planet,stargate"), S.parseObjectKinds("sun")];

    assert.deepStrictEqual(got, {
      classify: ["hostile", "neutral", "neutral", "neutral", "friendly", "neutral"],
      target: [true, true, false, false, false, false],
      scanner: [true, false, false, false],
      sweep: [["stargate:50", "stargate:70", "station:60", "planet:40"],
        ["station:60", "planet:40", "stargate:50", "stargate:70"], []],
      scanSame: true,
      scanChance: [250, 50, 900, 250, 375],
      scanEdges: [true, false],
      scanRate: true,
      pick: ["f_c", null],
      pickLarger: ["f_y", "f_a"],
      parse: [null, null, null, ["planet", "stargate"], null],
    });
    assert.deepStrictEqual([...S.FACTION_KINDS], [...FACTION_KINDS]);
  });

  test("PN3 dscanOrder: deterministic, anchor stays at 0, the object nearest the quarry is at index 1 "
    + "(the first warp of the sweep); quarry out of range / null -> unchanged; noise 0 -> strict distance order", () => {
    const AU = 149597870700;
    const at = (x) => ({ x, y: 0, z: 0 });
    const objects = Object.freeze([{ kind: "stargate", itemId: 11, position: at(0) },
      { kind: "station", itemId: 12, position: at(9 * AU) }, { kind: "planet", itemId: 13, position: at(-3 * AU) },
      { kind: "planet", itemId: 14, position: at(5 * AU) }, { kind: "asteroidBelt", itemId: 15, position: at(-6 * AU) },
      { kind: "planet", itemId: 16, position: at(7 * AU) }]);
    const p = { rangeMeters: 14.3 * AU, noisePermille: 300 };
    const quarry = at(6 * AU);
    const ids = (list) => list.map((o) => o.itemId);
    for (const seed of [0, 1, 7, 123456, 4294967295]) {
      const a = P.dscanOrder(objects, quarry, seed, p);
      assert.deepStrictEqual(ids(a), ids(P.dscanOrder(objects, quarry, seed, p)), `deterministic ${seed}`);
      assert.strictEqual(a[0], objects[0], "anchor first, same reference");
      assert.ok([14, 16].includes(a[1].itemId), `nearest (1 AU) at index 1, seed ${seed}: ${ids(a)}`);
      assert.deepStrictEqual([...ids(a)].sort(), ids(objects), "a permutation");
    }
    assert.deepStrictEqual(ids(P.dscanOrder(objects, quarry, 5, { ...p, noisePermille: 0 })), [11, 14, 16, 12, 13, 15]);
    assert.deepStrictEqual(ids(P.dscanOrder(objects, at(20 * AU), 5, p)), ids(objects), "out of range");
    assert.deepStrictEqual(ids(P.dscanOrder(objects, null, 5, p)), ids(objects), "no quarry");
    assert.deepStrictEqual(ids(P.dscanOrder(objects.slice(0, 2), quarry, 5, p)), [11, 12], "< 3 objects");
    assert.notStrictEqual(P.dscanOrder(objects, null, 5, p), objects, "a copy");
  });

  test("CH1 pickClaimCandidates: STAGED with an operation and IDLE of the pretender "
    + "taken; PLANNED, ENGAGED, refitPending, another faction, 17 ships at 16 refused; order 14 > 12 > 12 (fleetId); "
    + "claim null -> []", () => {
    const P0 = 500010;
    const fleet = (fleetId, extra = {}) => ({ fleetId, factionId: P0, state: "IDLE", operationId: null,
      refitPending: false, fleetRole: "invasion", shipCount: 12, ...extra });
    const kindOf = (f) => (f === P0 ? "pirate" : f === 500011 ? "pirate" : null);
    const opts = { roles: ["patrol", "invasion"], maxShips: 16, excludedFactions: [500018], factionKindOf: kindOf };
    const claim = { occupierFactionId: P0, state: "INVASION" };
    const fleets = [
      fleet("f_b"),
      fleet("f_a"),
      fleet("f_staged", { state: "STAGED", operationId: "op_inv", shipCount: 14 }),
      fleet("f_planned", { state: "PLANNED", operationId: "op_x" }),
      fleet("f_engaged", { state: "ENGAGED" }),
      fleet("f_refit", { refitPending: true }),
      fleet("f_other", { factionId: 500011 }),
      fleet("f_big", { shipCount: 17 }),
      fleet("f_idleop", { operationId: "op_y" }),
      fleet("f_role", { fleetRole: "logistics" }),
    ];
    const ids = (list) => list.map((f) => f.fleetId);
    assert.deepStrictEqual(ids(P.pickClaimCandidates(fleets, claim, opts)), ["f_staged", "f_a", "f_b"]);
    assert.deepStrictEqual(P.pickClaimCandidates(fleets, null, opts), []);
    assert.deepStrictEqual(P.pickClaimCandidates(fleets, claim, { ...opts, excludedFactions: [P0] }), []);
    assert.deepStrictEqual(P.pickClaimCandidates(fleets, claim, { ...opts, factionKindOf: () => null }), []);
    assert.deepStrictEqual(P.pickClaimCandidates(fleets, claim, { ...opts, factionKindOf: () => {
      throw new Error("x");
    } }), []);
    assert.deepStrictEqual(P.pickClaimCandidates(null, claim, opts), []);
    assert.deepStrictEqual(ids(P.pickClaimCandidates(fleets, claim, { ...opts, maxShips: 17 })),
      ["f_big", "f_staged", "f_a", "f_b"]);
  });

  test("SZ1 scale rule: parseScaleTable, hullClassOf (catalogue typeId, unknown "
    + "typeId by groupId, capsule, no typeId -> null despite the vendor groupID 25), huntSizeFor, pickDetachment", () => {
    const { TYPES } = require("../../lib/battle/data/strengthCatalog");
    const { pickDetachment, membersOf } = require("../../lib/playerHunt/huntRepository");
    const table = S.parseScaleTable(" frigate:2 , cruiser:4,capsule:1 ");
    assert.deepStrictEqual(table, { frigate: 2, cruiser: 4, capsule: 1 });
    assert.ok(Object.isFrozen(table));
    for (const bad of ["moon:2", "frigate:2,frigate:3", "frigate:0", "frigate:65", "frigate:2,", "frigate:x",
      "frigate:2.5", "frigate", "frigate:2:3", "", null]) {
      assert.strictEqual(S.parseScaleTable(bad), null, String(bad));
    }
    assert.deepStrictEqual([...S.HULL_SCALE_CLASSES].slice(-1), ["capsule"]);

    const index = P.buildGroupIndex(TYPES);
    assert.strictEqual(index.get(25), "frigate");
    assert.strictEqual(P.hullClassOf({ typeId: 587, groupId: 25 }, TYPES, index), "frigate");
    assert.strictEqual(P.hullClassOf({ typeId: 99999999, groupId: 26 }, TYPES, index), "cruiser");
    assert.strictEqual(P.hullClassOf({ typeId: 99999999, groupId: 99999 }, TYPES, index), null);
    assert.strictEqual(P.hullClassOf({ typeId: 670, groupId: 29, capsule: true }, TYPES, index), "capsule");
    assert.strictEqual(P.hullClassOf({ typeId: null, groupId: 25 }, TYPES, index), null, "Vendor default 25");
    assert.strictEqual(P.hullClassOf(null, TYPES, index), null);
    assert.strictEqual(P.buildGroupIndex({ 9: { typeId: 9, groupId: 1, hullGroup: "b" },
      3: { typeId: 3, groupId: 1, hullGroup: "a" } }).get(1), "a");

    const p = { defaultShips: 4, maxShips: 10, fleetShips: 10 };
    assert.deepStrictEqual(P.huntSizeFor("frigate", table, p), { cap: 2, known: true });
    assert.deepStrictEqual(P.huntSizeFor("cruiser", table, { ...p, maxShips: 3 }), { cap: 3, known: true });
    assert.deepStrictEqual(P.huntSizeFor("cruiser", table, { ...p, fleetShips: 2 }), { cap: 2, known: true });
    assert.deepStrictEqual(P.huntSizeFor("battleship", table, p), { cap: 4, known: false });
    assert.deepStrictEqual(P.huntSizeFor(null, table, p), { cap: 4, known: false });
    assert.deepStrictEqual(P.huntSizeFor("frigate", table, { ...p, fleetShips: 0 }), { cap: 2, known: true });

    const all = membersOf("f1", [{ hullGroup: "cruiser", count: 3 }, { hullGroup: "frigate", typeId: 587, count: 2 },
      { hullGroup: "ewar", typeId: 11, count: 1 }]);
    const keys = (list) => list.map((m) => m.memberKey);
    assert.deepStrictEqual(keys(all), ["f1:cruiser:0:1", "f1:cruiser:0:2", "f1:cruiser:0:3", "f1:ewar:11:1",
      "f1:frigate:587:1", "f1:frigate:587:2"]);
    assert.deepStrictEqual(keys(pickDetachment(all, 2)), ["f1:cruiser:0:1", "f1:ewar:11:1"]);
    assert.deepStrictEqual(keys(pickDetachment(all, 4)), ["f1:cruiser:0:1", "f1:ewar:11:1", "f1:frigate:587:1",
      "f1:cruiser:0:2"]);
    assert.deepStrictEqual(keys(pickDetachment(all, 6)), keys(all));
    assert.deepStrictEqual(keys(pickDetachment(all, 99)), keys(all));
  });

  test("PL-A1 placeAnomalies: anchor = first non-anomaly, nearest anomalies next "
    + "cut to max + dropped, no quarry = itemId, only anomalies = anchorless, no anomaly = unchanged copy", () => {
    const at = (x) => ({ x, y: 0, z: 0 });
    const a1 = { kind: "anomaly", itemId: 1, position: at(900) };
    const a2 = { kind: "anomaly", itemId: 2, position: at(100) };
    const a3 = { kind: "anomaly", itemId: 3, position: at(500) };
    const a4 = { kind: "anomaly", itemId: 4, position: null };
    const g = { kind: "stargate", itemId: 50, position: at(0) };
    const s = { kind: "station", itemId: 60, position: at(10) };
    const ids = (r) => r.objects.map((o) => o.itemId);
    const r1 = P.placeAnomalies([a1, a2, g, a3, s], at(0), 8);
    assert.deepStrictEqual([ids(r1), r1.anchorless, r1.dropped], [[50, 2, 3, 1, 60], false, 0]);
    assert.strictEqual(r1.objects[0], g, "same references");
    const r2 = P.placeAnomalies([g, a1, a2, a3, a4, s], at(1000), 2);
    assert.deepStrictEqual([ids(r2), r2.dropped], [[50, 1, 3, 60], 2]);
    const r3 = P.placeAnomalies([g, a4, a3, a1, s], null, 8);
    assert.deepStrictEqual(ids(r3), [50, 1, 3, 4, 60], "no quarry -> itemId, without a position last");
    assert.deepStrictEqual(P.placeAnomalies([a1, a2], at(0), 8), { objects: [], anchorless: true, dropped: 0 });
    const plain = [s, g];
    const r4 = P.placeAnomalies(plain, at(0), 8);
    assert.deepStrictEqual([ids(r4), r4.anchorless, r4.dropped], [[60, 50], false, 0]);
    assert.notStrictEqual(r4.objects, plain);
    assert.deepStrictEqual(S.OBJECT_KINDS, ["stargate", "station", "asteroidBelt", "planet", "anomaly"]);
  });

  test("PL-R1 retargetTowardQuarry: the object on the grid of the quarry, sweep before "
    + "extra, current object on grid / nothing on grid / bad input -> null", () => {
    const at = (x) => ({ x, y: 0, z: 0 });
    const objs = [{ kind: "stargate", itemId: 50, position: at(0) }, { kind: "anomaly", itemId: 7, position: at(1e9) },
      { kind: "planet", itemId: 60, position: at(5e9) }];
    const extra = [{ kind: "anomaly", itemId: 9, position: at(8e9) }];
    assert.deepStrictEqual(P.retargetTowardQuarry(objs, 0, at(1e9 + 1000), 250000, extra),
      { objectIndex: 1, itemId: 7, point: at(1e9) });
    assert.deepStrictEqual(P.retargetTowardQuarry(objs, 0, at(8e9 - 5000), 250000, extra),
      { objectIndex: null, itemId: 9, point: at(8e9) });
    assert.strictEqual(P.retargetTowardQuarry(objs, 1, at(1e9 + 1000), 250000, extra), null, "already there");
    assert.strictEqual(P.retargetTowardQuarry(objs, 0, at(3e9), 250000, extra), null, "nothing on grid");
    assert.strictEqual(P.retargetTowardQuarry(objs, 0, null, 250000, extra), null);
    assert.strictEqual(P.retargetTowardQuarry(objs, 0, at(1e9), 0, extra), null);
  });
};
