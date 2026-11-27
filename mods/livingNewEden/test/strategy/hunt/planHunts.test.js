"use strict";

const assert = require("node:assert");
const { planHunts } = require("../../../lib/strategy/ai/hunt");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");

const F = 500019;
const S1 = 30000001;
const S2 = 30000002;
const S3 = 30000003;
const S4 = 30000004;
const S5 = 30000005;
const AT = 1760000000000;
const GRAPH = { [S1]: [S2], [S2]: [S1, S3], [S3]: [S2, S4], [S4]: [S3, S5], [S5]: [S4] };

function snap(over = {}) {
  return {
    at: AT, factionId: F, huntReady: true, fleetsTruncated: false,
    faction: { status: "ACTIVE", homeSystemId: S1, doctrineId: "sansha-incursion-v1", resourceUnits: 100,
      reserveUnits: 100, frontLimit: 2, version: 3 },
    doctrine: { doctrineId: "sansha-incursion-v1", fieldsHunters: true,
      hunterTemplate: [{ hullGroup: "tackle", count: 2 }, { hullGroup: "frigate", count: 2 }],
      hunterComposition: [] },
    fleets: [],
    stations: [{ systemId: S2, stationId: "st-b", kind: "npc" }, { systemId: S1, stationId: "st-a", kind: "npc" }],
    systems: [S1, S2, S3, S4, S5].map((id) => ({ systemId: id, controllerFactionId: id === S5 ? 500020 : F })),
    neighbors: (id) => GRAPH[id] || [],
    production: null,
    ...over,
  };
}

const PARAMS = { hunt: { enabled: true, maxHuntersPerFaction: 2, strikeMaxJumps: 5, dwellMs: 300000, maxBfsSystems: 500 },
  mobilizeResourcePerShip: 3, mobilizeReservePerShip: 1 };
const BUDGET = { resourceUnits: 100, reserveUnits: 100 };

const hunter = (fleetId, systemId, version) => ({ fleetId, version, state: "IDLE", fleetRole: "hunter", systemId,
  refitPending: false, operationId: null, legSeq: 1, homeSystemId: S1, composition: [], updatedAt: AT - 1 });

module.exports = ({ test }) => {
  test("TP1 planHunts: MOBILIZE with numeric systemId, string stationId, cost ships x rates; fieldsHunters false -> "
    + "nothing; budget 0 -> HUNT_INSUFFICIENT_RESOURCES", () => {
    const r = planHunts({ snapshot: snap(), params: PARAMS, budget: BUDGET, ledger: null });
    assert.deepStrictEqual(r.notes, []);
    assert.deepStrictEqual(r.intents, [{ type: "MOBILIZE", slot: 0, role: "hunter", systemId: S1, homeSystemId: S1,
      composition: [{ hullGroup: "tackle", typeId: null, count: 2 }, { hullGroup: "frigate", typeId: null, count: 2 }],
      cost: { resourceUnits: 12, reserveUnits: 4 }, stationId: "st-a", hulls: [] }]);
    assert.deepStrictEqual(r.cost, { resourceUnits: 12, reserveUnits: 4 });

    const off = planHunts({ snapshot: snap({ doctrine: { ...snap().doctrine, fieldsHunters: false } }), params: PARAMS,
      budget: BUDGET, ledger: null });
    assert.deepStrictEqual([off.intents, off.notes], [[], []]);

    const poor = planHunts({ snapshot: snap(), params: PARAMS, budget: { resourceUnits: 0, reserveUnits: 0 },
      ledger: null });
    assert.deepStrictEqual([poor.intents, poor.notes], [[], ["HUNT_INSUFFICIENT_RESOURCES"]]);
  });

  test("TP2 planHunts: IDLE hunters outside the station system -> LAUNCH hunt with the snapshot version, origin = own "
    + "system, distinct targets never the own system; same snapshot -> deepStrictEqual", () => {
    const fleets = [hunter("f-2", S4, 7), hunter("f-1", S3, 5)];
    const s = snap({ fleets });
    const r = planHunts({ snapshot: s, params: PARAMS, budget: BUDGET, ledger: null });
    const launches = r.intents.filter((i) => i.type === "LAUNCH");
    assert.strictEqual(r.intents.filter((i) => i.type === "MOBILIZE").length, 0, "at the hunter limit");
    assert.deepStrictEqual(launches.map((l) => [l.kind, l.fleets, l.originSystemId, l.mobilize, l.dueAt]), [
      ["hunt", [{ fleetId: "f-1", expectedVersion: 5 }], S3, [], AT + 300000],
      ["hunt", [{ fleetId: "f-2", expectedVersion: 7 }], S4, [], AT + 300000]]);
    const targets = launches.map((l) => l.target.systemId);
    assert.deepStrictEqual(targets, [S4, S2]);
    assert.notStrictEqual(targets[0], targets[1]);
    for (const l of launches) assert.notStrictEqual(l.target.systemId, l.originSystemId);
    assert.deepStrictEqual(planHunts({ snapshot: snap({ fleets }), params: PARAMS, budget: BUDGET, ledger: null }), r);
  });

  const run = (over, params = PARAMS, budget = BUDGET, ledger = null) => planHunts({ snapshot: snap(over), params,
    budget, ledger });
  const launchesOf = (r) => r.intents.filter((i) => i.type === "LAUNCH");
  const mobsOf = (r) => r.intents.filter((i) => i.type === "MOBILIZE");

  test("planHunts: hunt off (params.hunt null / enabled false) or huntReady false -> no intent, no note", () => {
    for (const r of [run({}, { ...PARAMS, hunt: null }), run({}, { ...PARAMS, hunt: { ...PARAMS.hunt, enabled: false } }),
      run({ huntReady: false })]) {
      assert.deepStrictEqual([r.intents, r.notes, r.cost], [[], [], { resourceUnits: 0, reserveUnits: 0 }]);
    }
  });

  test("planHunts: faction not ACTIVE or fleets truncated -> HUNT_SKIPPED only", () => {
    const dormant = run({ faction: { ...snap().faction, status: "DORMANT" } });
    const cut = run({ fleetsTruncated: true });
    for (const r of [dormant, cut]) assert.deepStrictEqual([r.intents, r.notes], [[], ["HUNT_SKIPPED"]]);
  });

  test("planHunts: at maxHuntersPerFaction -> no MOBILIZE; empty hunterTemplate -> no MOBILIZE, no note", () => {
    const busy = (id) => ({ ...hunter(id, S2, 1), state: "TRAVELLING" });
    assert.deepStrictEqual(mobsOf(run({ fleets: [busy("a"), busy("b")] })), []);
    const r = run({ doctrine: { ...snap().doctrine, hunterTemplate: [] } });
    assert.deepStrictEqual([r.intents, r.notes], [[], []]);
  });

  test("planHunts: no own station -> HUNT_NO_STATION (no MOBILIZE) and no patrol target -> HUNT_NO_PATROL_TARGET", () => {
    const r = run({ stations: [], fleets: [hunter("f-1", S3, 2)] });
    assert.deepStrictEqual([r.intents, r.notes], [[], ["HUNT_NO_STATION", "HUNT_NO_PATROL_TARGET"]]);
  });

  test("planHunts: no station in the home system -> the station of the lowest systemId", () => {
    const r = run({ stations: [{ systemId: S4, stationId: "st-d" }, { systemId: S3, stationId: "st-c" }] });
    assert.deepStrictEqual(mobsOf(r).map((m) => [m.systemId, m.stationId]), [[S3, "st-c"]]);
  });

  test("planHunts: hunter ledger (needs) -> station holding the template with its hulls; none -> the ledger note", () => {
    const P = { ...PARAMS, production: { mobilizeHulls: "required", miningNeedsHulls: false, freeHullGroups: [] } };
    const production = (hullsB) => ({ mode: "ready", inProduction: {},
      stations: [{ stationId: "st-a", systemId: S1, hulls: {} }, { stationId: "st-b", systemId: S2, hulls: hullsB }] });
    const s = snap({ production: production({ tackle: 2, frigate: 2 }) });
    const ledger = createHullLedger(s, P);
    const r = planHunts({ snapshot: s, params: P, budget: BUDGET, ledger });
    const hulls = [{ itemKey: "group:frigate", count: 2 }, { itemKey: "group:tackle", count: 2 }];
    assert.deepStrictEqual(mobsOf(r).map((m) => [m.systemId, m.stationId, m.hulls]), [[S2, "st-b", hulls]]);
    assert.deepStrictEqual([ledger.available("st-b", "tackle"), ledger.available("st-b", "frigate")], [0, 0], "taken");
    const s0 = snap({ production: production({}) });
    const none = planHunts({ snapshot: s0, params: P, budget: BUDGET, ledger: createHullLedger(s0, P) });
    assert.deepStrictEqual([none.intents, none.notes, none.cost], [[], ["NO_HULLS:frigate"],
      { resourceUnits: 0, reserveUnits: 0 }]);
  });

  test("planHunts: hunters with an operation, refit pending, not IDLE or without a system -> no patrol", () => {
    const fleets = [{ ...hunter("a", S3, 1), operationId: "op-1" }, { ...hunter("b", S3, 1), refitPending: true },
      { ...hunter("c", S3, 1), state: "TRAVELLING" }, { ...hunter("d", null, 1) }];
    assert.deepStrictEqual(launchesOf(run({ fleets }, { ...PARAMS, hunt: { ...PARAMS.hunt, maxHuntersPerFaction: 9 } })),
      []);
  });

  test("planHunts: home system and coreOwners are never patrol targets", () => {
    const fleets = [hunter("a", S4, 1), hunter("b", S4, 1)];
    const r = run({ fleets, coreOwners: new Map([[S2, 500020]]) });
    assert.deepStrictEqual(launchesOf(r).map((l) => l.target.systemId), [S3]);
    assert.deepStrictEqual(r.notes, ["HUNT_NO_PATROL_TARGET"]);
  });

  test("planHunts: strikeMaxJumps bounds the candidates (BFS from the own station systems)", () => {
    const P = { ...PARAMS, hunt: { ...PARAMS.hunt, strikeMaxJumps: 1 } };
    const r = run({ fleets: [hunter("a", S4, 1), hunter("b", S4, 1)] }, P);
    assert.deepStrictEqual(launchesOf(r).map((l) => l.target.systemId), [S2, S3]);
  });

  test("planHunts: dueAt = snapshot.at + hunt.dwellMs", () => {
    const P = { ...PARAMS, hunt: { ...PARAMS.hunt, dwellMs: 1234 } };
    assert.deepStrictEqual(launchesOf(run({ fleets: [hunter("a", S2, 1)] }, P)).map((l) => l.dueAt), [AT + 1234]);
  });
};
