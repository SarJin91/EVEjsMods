"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { desiredStructure, diffStructure, planPass, placementCandidates, desiredFingerprint } =
  require("../../lib/stations/structures/projection");
const { CONDITION_FULL, CONDITION_ARMOR_STAGE, CONDITION_HULL_STAGE } = require("../../lib/stations/structures/schema");
const { DEFAULT_STATES, DEFAULT_UPKEEP } = require("../_support/fakeStructureSeam");

const STATES = Object.freeze({ states: DEFAULT_STATES, upkeep: DEFAULT_UPKEEP });
const CFG = Object.freeze({ dockingAccess: "public", quantumCore: false });
const WORLD = 77;
const NOW = 1000000;
const PROJECTION_FILE = path.join(__dirname, "..", "..", "lib", "stations", "structures", "projection.js");

function station(id, extra = {}) {
  return Object.freeze({ stationId: id, kind: "upwell", typeId: 35832, systemId: 30001721, ownerFactionId: 500003,
    ownerCorporationId: 1000084, state: "ONLINE", stateUntilAt: null, name: null, ...extra });
}

function viewOf(st, structureId, extra = {}) {
  const d = desiredStructure(st, NOW, CFG, STATES);
  return Object.freeze({ structureId, tag: { stationId: st.stationId, world: WORLD }, typeId: d.typeId,
    systemId: d.systemId, ownerCorpId: d.ownerCorpId, allianceId: null, state: d.state, stateEndsAt: d.stateEndsAt,
    upkeepState: d.upkeepState, hasQuantumCore: d.quantumCore, docking: d.docking, tethering: "none",
    destroyedAt: null, position: { x: 0, y: 0, z: 0 }, name: "Astrahus", ...extra });
}

const plan = (live, tagged, extra = {}) => planPass({ live, tagged, dirty: null, applied: new Map(), now: NOW,
  cfg: CFG, states: STATES, world: WORLD, maxWrites: 64, ...extra });
const opsOf = (result) => result.ops.map((o) => [o.op, o.stationId, o.structureId || null, o.reason || null]);

module.exports = ({ test }) => {
  test("TS1 desiredStructure: mapping table, now = state_until_at -> vulnerable, never ANCHORING 2, absent "
    + "unmapped; projection.js imports only ./, ../schema, ../../util/rng", () => {
    const d = (extra) => desiredStructure(station("s1", extra), NOW, CFG, STATES);
    const pick = (x) => [x.state, x.stateEndsAt, x.condition];
    assert.deepStrictEqual(pick(d({ state: "ANCHORING", stateUntilAt: NOW + 5 })), [115, null, CONDITION_ARMOR_STAGE]);
    assert.deepStrictEqual(pick(d({ state: "ONLINE" })), [110, null, CONDITION_FULL]);
    assert.deepStrictEqual(pick(d({ state: "ARMOR_REINFORCE", stateUntilAt: NOW + 1 })),
      [111, NOW + 1, CONDITION_ARMOR_STAGE]);
    assert.deepStrictEqual(pick(d({ state: "ARMOR_REINFORCE", stateUntilAt: NOW })),
      [112, null, CONDITION_ARMOR_STAGE]);
    assert.deepStrictEqual(pick(d({ state: "HULL_REINFORCE", stateUntilAt: NOW + 1 })),
      [113, NOW + 1, CONDITION_HULL_STAGE]);
    assert.deepStrictEqual(pick(d({ state: "HULL_REINFORCE", stateUntilAt: NOW })), [114, null, CONDITION_HULL_STAGE]);
    assert.deepStrictEqual(d({ state: "DESTROYED" }), { kind: "destroyed" });
    assert.deepStrictEqual(desiredStructure(station("n", { kind: "npc" }), NOW, CFG, STATES), { kind: "absent" });
    assert.deepStrictEqual(desiredStructure(station("t", { typeId: null }), NOW, CFG, STATES), { kind: "absent" });
    assert.deepStrictEqual(d({ state: "FUTURE_STATE" }), { kind: "unmapped", state: "FUTURE_STATE" });
    assert.deepStrictEqual(diffStructure(d({ state: "FUTURE_STATE" }), viewOf(station("s1"), 9)), { op: "NOOP" });
    const online = d({ state: "ONLINE", name: "Saminer Keep" });
    assert.deepStrictEqual([online.kind, online.typeId, online.systemId, online.ownerCorpId, online.allianceId,
      online.upkeepState, online.docking, online.quantumCore, online.name],
    ["present", 35832, 30001721, 1000084, null, 1, "public", false, "Saminer Keep"]);
    assert.strictEqual(d({}).name, null, "no name -> vendor type name (P9)");
    for (const s of ["ANCHORING", "ONLINE", "ARMOR_REINFORCE", "HULL_REINFORCE"]) {
      for (const until of [null, NOW - 1, NOW, NOW + 1]) {
        assert.notStrictEqual(d({ state: s, stateUntilAt: until }).state, 2);
      }
    }
    const source = fs.readFileSync(PROJECTION_FILE, "utf8");
    const imports = [...source.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(imports, ["../../util/rng", "../schema", "./schema"]);
  });

  test("TS2 diffStructure/planPass: CREATE, NOOP, UPDATE, condition on state change, DESTROY, RECREATE "
    + "duplicate, orphans, budget and priority, incremental unknown vs []", () => {
    const on = station("s-on");
    const want = desiredStructure(on, NOW, CFG, STATES);
    assert.deepStrictEqual(diffStructure(want, null), { op: "CREATE" });
    assert.deepStrictEqual(diffStructure(want, viewOf(on, 9, { destroyedAt: 5 })), { op: "CREATE" });
    assert.deepStrictEqual(diffStructure(want, viewOf(on, 9)), { op: "NOOP" });
    assert.deepStrictEqual(diffStructure(want, viewOf(on, 9, { ownerCorpId: 5, docking: "none" })),
      { op: "UPDATE", patch: { ownerCorpId: 1000084, docking: "public" }, stateChanged: false });
    const reinf = station("s-on", { state: "ARMOR_REINFORCE", stateUntilAt: NOW + 50 });
    assert.deepStrictEqual(diffStructure(desiredStructure(reinf, NOW, CFG, STATES), viewOf(on, 9)),
      { op: "UPDATE", patch: { state: 111, stateEndsAt: NOW + 50, condition: CONDITION_ARMOR_STAGE },
        stateChanged: true });
    const after = desiredStructure(reinf, NOW + 50, CFG, STATES);
    assert.deepStrictEqual(diffStructure(after, viewOf(on, 9, { state: 112, stateEndsAt: NOW + 900 })),
      { op: "UPDATE", patch: { stateEndsAt: null }, stateChanged: false });
    assert.deepStrictEqual(diffStructure({ kind: "destroyed" }, viewOf(on, 9)), { op: "DESTROY" });
    assert.deepStrictEqual(diffStructure({ kind: "destroyed" }, viewOf(on, 9, { destroyedAt: 1 })), { op: "NOOP" });
    assert.deepStrictEqual(diffStructure(want, viewOf(on, 9, { systemId: 1 })).op, "RECREATE");
    assert.deepStrictEqual(opsOf(plan([on], new Map([["s-on", [viewOf(on, 9, { typeId: 35833 })]]]))),
      [["REMOVE", "s-on", 9, "RECREATE"]]);

    const live = [station("a-new"), station("b-dup"), station("c-upd"), station("d-dead", { state: "DESTROYED" })];
    const tagged = new Map([
      ["b-dup", [viewOf(live[1], 30), viewOf(live[1], 20)]],
      ["c-upd", [viewOf(live[2], 40, { ownerCorpId: 5 })]],
      ["d-dead", [viewOf(live[0], 50, { tag: { stationId: "d-dead", world: WORLD } })]],
      ["e-gone", [viewOf(live[0], 60, { tag: { stationId: "e-gone", world: WORLD } })]],
      ["a-new", [viewOf(live[0], 70, { tag: { stationId: "a-new", world: WORLD + 1 } })]],
    ]);
    const full = plan(live, tagged);
    assert.deepStrictEqual(opsOf(full), [
      ["DESTROY", "d-dead", 50, null],
      ["UPDATE", "c-upd", 40, null],
      ["CREATE", "a-new", null, null],
      ["REMOVE", "a-new", 70, "ORPHAN"],
      ["REMOVE", "b-dup", 30, "DUPLICATE"],
      ["REMOVE", "e-gone", 60, "ORPHAN"],
    ]);
    assert.deepStrictEqual([full.deferred, full.needsFullReconcile], [0, false]);
    assert.deepStrictEqual(full.ops[2].tag, { stationId: "a-new", world: WORLD });
    assert.deepStrictEqual(full.ops[3].tag, { stationId: "a-new", world: WORLD + 1 }, "orphan keeps its own tag");
    assert.deepStrictEqual(plan(live, tagged), full, "deterministic");
    const budget = plan(live, tagged, { maxWrites: 2 });
    assert.deepStrictEqual([budget.ops.map((o) => o.op), budget.deferred], [["DESTROY", "UPDATE"], 4]);
    const applied = new Map(live.map((s) => [s.stationId, desiredFingerprint(desiredStructure(s, NOW, CFG, STATES))]));
    const inc = plan(live, new Map([["c-upd", tagged.get("c-upd")]]), { dirty: new Set(["c-upd", "x"]), applied });
    assert.deepStrictEqual([inc.ops.map((o) => o.op), inc.unknown, inc.needsFullReconcile], [["UPDATE"], ["x"], true]);
    const blind = plan(live, new Map(), { dirty: new Set(["a-new"]), applied });
    assert.deepStrictEqual([blind.ops, blind.unknown, blind.needsFullReconcile], [[], ["a-new"], true]);
    const known = plan(live, new Map([["a-new", []]]), { dirty: new Set(["a-new"]), applied });
    assert.deepStrictEqual([opsOf(known), known.unknown, known.needsFullReconcile],
      [[["CREATE", "a-new", null, null]], [], false]);
    assert.deepStrictEqual(plan(live, null).ops, []);
  });

  test("TS3 placementCandidates: deterministic, clearance from the anchor surface, no anchors -> []", () => {
    const anchors = [{ itemId: 40000002, position: { x: 1e11, y: 0, z: -5e10 }, radius: 6e6 },
      { itemId: 40000001, position: { x: 0, y: 0, z: 0 }, radius: 7e8 },
      { itemId: 40000003, position: { x: -3e11, y: 2e9, z: 4e10 }, radius: 0 }];
    const input = { seed: 12345, anchors, clearanceM: 2500000, attempts: 8 };
    const a = placementCandidates(input);
    assert.strictEqual(a.length, 8);
    assert.deepStrictEqual(placementCandidates({ ...input, anchors: [...anchors].reverse() }), a, "anchor order");
    assert.notDeepStrictEqual(placementCandidates({ ...input, seed: 54321 }), a, "another seed");
    for (const p of a) {
      const gaps = anchors.map((x) => Math.hypot(p.x - x.position.x, p.y - x.position.y, p.z - x.position.z)
        - x.radius);
      assert.ok(gaps.some((g) => Math.abs(g - 2500000) < 1e-3 * 2500000), JSON.stringify(gaps));
      assert.ok(gaps.every((g) => g >= 2500000 * (1 - 1e-6)), JSON.stringify(gaps));
    }
    assert.deepStrictEqual(placementCandidates({ ...input, anchors: [] }), []);
    assert.deepStrictEqual(placementCandidates({ ...input, attempts: 0 }), []);
  });

  test("ND1 diffStructure foreignDestroyed: only for a destroyed own view next to no live one; planPass "
    + "carries it on the CREATE of the station whose evejsItemId names the destroyed view; NN2 modDestroyed -> none",
  () => {
    const on = station("s-on");
    const want = desiredStructure(on, NOW, CFG, STATES);
    assert.deepStrictEqual(diffStructure(want, null, { structureId: 7, destroyedAt: 123 }),
      { op: "CREATE", foreignDestroyed: { structureId: 7, destroyedAt: 123 } });
    assert.deepStrictEqual(diffStructure(want, null, viewOf(on, 7)), { op: "CREATE" }, "own live: no field");
    assert.deepStrictEqual(diffStructure(want, null, null), { op: "CREATE" });
    assert.deepStrictEqual(diffStructure({ kind: "destroyed" }, null, viewOf(on, 7, { destroyedAt: 5 })),
      { op: "NOOP" });
    const named = station("s-on", { evejsItemId: 7 });
    const dead = viewOf(on, 7, { destroyedAt: 123 });
    assert.deepStrictEqual(plan([named], new Map([["s-on", [dead]]])).ops[0].foreignDestroyed,
      { structureId: 7, destroyedAt: 123 });
    assert.strictEqual(plan([station("s-on", { evejsItemId: 8 })], new Map([["s-on", [dead]]])).ops[0]
      .foreignDestroyed, undefined);
    assert.deepStrictEqual(diffStructure(want, null, { structureId: 7, destroyedAt: 123, modDestroyed: true }),
      { op: "CREATE" });
    assert.deepStrictEqual(diffStructure(want, null, { structureId: 7, destroyedAt: 123, modDestroyed: false }),
      { op: "CREATE", foreignDestroyed: { structureId: 7, destroyedAt: 123 } });
  });
};
