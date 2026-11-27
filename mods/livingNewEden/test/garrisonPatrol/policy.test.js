"use strict";

const assert = require("node:assert");

const P = require("../../lib/garrisonPatrol/policy");
const GS = require("../../lib/garrisonPatrol/schema");
const hs = require("../../lib/adapter/huntScene");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");

const SYSTEM = 30000142;
const pos = (x, y = 0, z = 0) => ({ x, y, z });

module.exports = ({ test }) => {
  test("GP1 garrison patrol policy: chooseMode, pickCampGate, patrolRoute, pickPatrolFleets, parsers", () => {
    const permille = GS.parseCampPermille("pirate:700,invader:500,hive:500,neutral:300,empire:250,police:0");
    const gates = [{ itemId: 3, position: pos(1) }];
    const opts = { campPermille: permille, maxCampsPerSystem: 1 };
    let camps = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const a = P.chooseMode({ fleetSeed: seed, kind: "pirate", gates, campsInSystem: 0 }, opts);
      assert.strictEqual(P.chooseMode({ fleetSeed: seed, kind: "pirate", gates, campsInSystem: 0 }, opts), a);
      if (a === "GATE_CAMP") camps += 1;
      assert.strictEqual(P.chooseMode({ fleetSeed: seed, kind: "police", gates, campsInSystem: 0 }, opts), "PATROL");
      assert.strictEqual(P.chooseMode({ fleetSeed: seed, kind: "pirate", gates: [], campsInSystem: 0 }, opts),
        "PATROL");
      assert.strictEqual(P.chooseMode({ fleetSeed: seed, kind: "pirate", gates, campsInSystem: 1 }, opts), "PATROL");
    }
    assert.ok(camps > 220 && camps < 340, `pirate camps ${camps}/400`);

    const here = { secClass: "nullsec", factionId: 500010 };
    const systems = { 1: { secClass: "nullsec", factionId: 500010 }, 2: { secClass: "lowsec", factionId: 500010 },
      3: { secClass: "nullsec", factionId: 500011 } };
    const systemOf = (id) => systems[id] || null;
    const g = [{ itemId: 50, position: pos(5e9), toSystemId: 2 }, { itemId: 10, position: pos(1e9), toSystemId: 1 },
      { itemId: 30, position: pos(3e9), toSystemId: 9 }, { itemId: 40, position: pos(4e9), toSystemId: 3 }];
    for (let seed = 0; seed < 8; seed += 1) {
      const picked = P.pickCampGate(g, { policy: "border", here, systemOf, triggerPos: null, gridRadiusMeters: 1 },
        seed);
      assert.ok([40, 50].includes(picked.itemId), `border ${picked.itemId}`);
      assert.strictEqual(picked.itemId, [40, 50][seed % 2]);
    }
    const inner = g.filter((x) => x.toSystemId === 1 || x.toSystemId === 9);
    const fallback = [0, 1].map((seed) => P.pickCampGate(inner, { policy: "border", here, systemOf }, seed).itemId);
    assert.deepStrictEqual(fallback, [10, 30]);
    assert.strictEqual(P.pickCampGate(g, { policy: "arrival", here, systemOf, triggerPos: pos(3e9 + 1000),
      gridRadiusMeters: 250000 }, 0).itemId, 30);
    assert.strictEqual(P.pickCampGate(g, { policy: "arrival", here, systemOf, triggerPos: pos(7e9),
      gridRadiusMeters: 250000 }, 0).itemId, 40);
    assert.strictEqual(P.pickCampGate(g, { policy: "random", here, systemOf }, 5).itemId, 30);
    assert.strictEqual(P.pickCampGate([], { policy: "border", here, systemOf }, 1), null);

    const objects = [{ kind: "stargate", itemId: 7, position: pos(7) }, { kind: "planet", itemId: 2, position: pos(2) },
      { kind: "station", itemId: 4, position: pos(4) }, { kind: "sun", itemId: 1, position: pos(0), radius: 5e8 },
      { kind: "stargate", itemId: 5, position: pos(5) }];
    const kinds = GS.parsePatrolObjectKinds("sun,stargate,station");
    for (let seed = 0; seed < 4; seed += 1) {
      const route = P.patrolRoute(objects, kinds, seed);
      assert.strictEqual(route[0], objects[3]);
      assert.deepStrictEqual(route.map((o) => o.itemId).slice(1).sort(), [4, 5, 7]);
    }
    assert.strictEqual(P.patrolRoute(objects, ["stargate", "sun"], 0)[0].kind, "stargate");

    const f = (fleetId, extra = {}) => ({ fleetId, factionId: 500010, state: "IDLE", operationId: null,
      refitPending: false, fleetRole: "garrison", shipCount: 40, ...extra });
    const fleets = [f("f3"), f("f1"), f("f2", { state: "MATERIALIZED" }), f("f4", { fleetRole: "patrol" }),
      f("f5", { refitPending: true }), f("f6", { factionId: 1 }), f("f7", { shipCount: 0 }), f("f8", { factionId: 2 })];
    const picked = P.pickPatrolFleets(fleets, { roles: ["garrison"], maxShips: 12, excludedFactions: [2],
      factionKindOf: (id) => (id === 500010 || id === 2 ? "pirate" : null) });
    assert.deepStrictEqual(picked.map((x) => x.fleetId), ["f1", "f3"]);

    assert.strictEqual(GS.parseCampPermille("pirate:700,pirate:1"), null);
    assert.strictEqual(GS.parseCampPermille("pirate:1001"), null);
    assert.strictEqual(GS.parseCampPermille("ghost:1"), null);
    assert.strictEqual(GS.parseCampPermille("pirate:1.5"), null);
    assert.strictEqual(GS.parsePatrolObjectKinds("sun,moon"), null);
    assert.strictEqual(GS.isCampGatePolicy("arrival"), true);
    assert.strictEqual(GS.isCampGatePolicy("gate"), false);
  });

  test("GPR1: rotateToNearest - the nearest first (cyclic order kept), a tie -> the "
    + "smaller index, no position -> unchanged", () => {
    const route = [{ itemId: 1, point: pos(0) }, { itemId: 2, point: pos(10) }, { itemId: 3, position: pos(20) },
      { itemId: 4, point: pos(30) }];
    const ids = (r) => r.map((o) => o.itemId);
    assert.deepStrictEqual(ids(P.rotateToNearest(route, pos(19))), [3, 4, 1, 2]);
    assert.deepStrictEqual(ids(P.rotateToNearest(route, pos(25))), [3, 4, 1, 2], "tie 20/30 -> the smaller index");
    assert.deepStrictEqual(ids(P.rotateToNearest(route, pos(29))), [4, 1, 2, 3]);
    assert.deepStrictEqual(ids(P.rotateToNearest(route, null)), [1, 2, 3, 4]);
    assert.notStrictEqual(P.rotateToNearest(route, null), route, "a copy");
    assert.deepStrictEqual(P.rotateToNearest(null, pos(0)), []);
  });

  test("GP3 garrison patrol geometry (standoffPoint / campPoint) and listSystemObjects sun with radius", () => {
    const p = P.standoffPoint({ position: pos(0), radius: 5e8 }, 25000);
    assert.deepStrictEqual(p, { x: 500025000, y: 0, z: 0 });
    assert.ok(Math.sqrt((p.x * p.x) + (p.y * p.y) + (p.z * p.z)) > 5e8, "outside the sun");
    assert.deepStrictEqual(P.standoffPoint({ position: pos(0, 3e6, 4e6), radius: 1e6 }, 4e6),
      { x: 0, y: 6e6, z: 8e6 });
    assert.deepStrictEqual(P.standoffPoint({ position: pos(1e9) }, 25000), { x: 1e9 + 25000, y: 0, z: 0 });
    assert.strictEqual(P.standoffPoint({ position: null }, 1), null);
    assert.deepStrictEqual(P.campPoint({ position: pos(1e9) }, 15000), { x: 1e9 - 15000, y: 0, z: 0 });
    assert.deepStrictEqual(P.campPoint({ position: pos(0) }, 15000), { x: 15000, y: 0, z: 0 });

    const worldData = {
      getStargatesForSystem: () => [{ itemID: 50000002, position: pos(2) }],
      getStationsForSystem: () => [],
      getAsteroidBeltsForSystem: () => [],
      getCelestialsForSystem: () => [{ itemID: 40000001, groupID: 6, position: pos(0), radius: 5e8 },
        { itemID: 40000002, groupID: 7, position: pos(7) }, { itemID: 40000003, groupID: 7, position: pos(8),
          radius: 3e6 }, { itemID: 40000009, kind: "sun", position: pos(9), radius: "x" }],
    };
    const requireGame = (rel) => (rel === hs.MODULE_PATHS.worldData ? { ok: true, exports: worldData }
      : { ok: false, reason: "file_not_found" });
    const seam = hs.createHuntScene({ requireGame, data: liveProfiles });
    assert.deepStrictEqual(seam.listSystemObjects(SYSTEM, ["sun", "planet", "stargate"]), { ok: true, objects: [
      { kind: "sun", itemId: 40000001, position: pos(0), radius: 5e8 },
      { kind: "sun", itemId: 40000009, position: pos(9) },
      { kind: "planet", itemId: 40000002, position: pos(7) },
      { kind: "planet", itemId: 40000003, position: pos(8), radius: 3e6 },
      { kind: "stargate", itemId: 50000002, position: pos(2) }] });
  });
};
