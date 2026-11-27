"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { planInvaderCounter } = require("../../lib/strategy/ai/invaderCounter");
const { decideReview } = require("../../lib/strategy/ai");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { DOCTRINES_VERSION, DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { listBeachheadsInTx, BEACHHEADS_SQL, BEACHHEADS_IN_SQL } = require("../../lib/world/invasions/footholds");
const { createManualClock } = require("../../lib/util/clock");
const { createIdGenerator } = require("../../lib/util/ids");
const { createRng } = require("../../lib/util/rng");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const COMPOSE = path.resolve(MOD_DIR, "..", "..", "compose.yaml");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const TRIG = 500026;
const ALLY = 8;
const FAR = 99000001;
const NEAR = 30001948;
const BH10 = Object.freeze(Array.from({ length: 10 }, (_, i) => [`inv_${i + 1}`, i < 9 ? FAR + i : NEAR]));

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const IC = Object.freeze({ maxPerReview: 2, rangeJumps: 6, maxBeachheadsRead: 8, holderReadLimit: 16,
  kinds: Object.freeze(["empire"]) });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  siege: null, playerSiege: null, invaderCounter: IC });

const cruisers = (count) => [{ hullGroup: "cruiser", typeId: null, count }];

function fleet(fleetId, systemId, count, extra = {}) {
  const composition = cruisers(count);
  return { fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId, refitPending: false,
    shipCount: count, strength: strengthOf(composition, POWER), composition, operationId: null, legSeq: 0,
    homeSystemId: 20, updatedAt: AT - 2 * HOUR, ...extra };
}

const beachhead = (systemId, factionId = TRIG, holders = 2) => ({ invasionId: `inv_${systemId}`, factionId, systemId,
  holders: [{ fleetId: `h${systemId}`, factionId, composition: cruisers(holders) }], holdersTruncated: false });

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "ic", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [ALLY], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "ic", canOccupy: false, reachJumps: 30, returnToBase: true,
      operationTypes: o.operationTypes || ["recon", "return", "counter"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === TRIG,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(20, F)],
    fleets: o.fleets || [], fleetsTruncated: false, operations: o.operations || [], operationsTruncated: false,
    intel: [], sightings: [], occupations: [], territory: [], territoryTruncated: false,
    siege: { mode: "off", attacking: [], defending: [], truncated: false },
    invaderBeachheads: { mode: "ready", truncated: false, items: o.beachheads || [] } };
}

const plan = (s, o = {}) => planInvaderCounter(s, { ...PARAMS, ...(o.params || {}) }, o.used || new Set(),
  o.room === undefined ? 2 : o.room, o.opts);
const launches = (r) => r.intents.filter((i) => i.type === "LAUNCH");

module.exports = ({ test, skip }) => {
  test("IC1 beachheads 4 and 9 jumps (range 6), idle fleets >= 1.2 x S -> one LAUNCH counter_offensive on the "
    + "nearer, note, fleetIds; decideReview carries it", () => {
    const fleets = [fleet("c1", 20, 3), fleet("c2", 19, 3)];
    const s = snap({ fleets, beachheads: [beachhead(29), beachhead(24)] });
    const r = plan(s);
    assert.deepStrictEqual(launches(r).map((i) => [i.kind, i.target.systemId, i.fleets.map((x) => x.fleetId),
      i.mobilize.length, i.dueAt]), [["counter_offensive", 24, ["c1"], 0, AT + 2 * HOUR]]);
    assert.deepStrictEqual(r.notes, ["INVADER_COUNTER_LAUNCH:24"]);
    assert.deepStrictEqual(r.fleetIds, ["c1"]);
    const d = decideReview(s, PARAMS);
    assert.strictEqual(d.outcome, "REVIEWED", JSON.stringify(d));
    assert.ok(d.intents.some((i) => i.type === "LAUNCH" && i.kind === "counter_offensive" && i.target.systemId === 24),
      JSON.stringify(d.intents.map((i) => [i.type, i.kind])));
    assert.ok(d.notes.includes("INVADER_COUNTER_LAUNCH:24"), JSON.stringify(d.notes));
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  needsDriver("IC2 flag off: null params -> nothing, the k3 review never calls beachheadsOf; on: the empire reads it, "
    + "the pirate not; listBeachheadsInTx takes world_invasions_open", async () => {
    const off = plan(snap({ fleets: [fleet("c1", 20, 3)], beachheads: [beachhead(24)] }),
      { params: { invaderCounter: null } });
    assert.deepStrictEqual(off, { intents: [], notes: [], fleetIds: [] });
    const run = async (env, opened) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(29) }), graph: R.graphOf(),
        controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
      const calls = [];
      const seen = new Map();
      const hooks = { beforeEffect: (d, s) => {
        seen.set(s.factionId, s.invaderBeachheads);
        return d;
      } };
      const all = BH10.map(([invasionId, systemId]) => ({ invasionId, factionId: TRIG, systemId }));
      const beachheadsOf = (tx, limit, systems) => {
        calls.push({ limit, systems });
        const inReach = all.filter((b) => Array.isArray(systems) && systems.includes(b.systemId));
        return { ok: true, beachheads: inReach.slice(0, limit), truncated: inReach.length > limit };
      };
      const e = await R.bootAll(opened, shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", ...env },
        { hooks, beachheadsOf });
      await R.passesAt(e, shared, R.START_MS + R.I);
      const listed = e.tx((db) => listBeachheadsInTx(db, { limit: 8 }));
      const planRows = e.tx((db) => db.prepare(`EXPLAIN QUERY PLAN ${BEACHHEADS_SQL}`).all(9));
      e.tx((db) => {
        const ins = db.prepare("INSERT INTO world_invasions (invasion_id, idempotency_key, roll_round, faction_id, "
          + "profile_id, beachhead_system_id, capture_range_jumps, state, open, step_seq, fleet_ids_json, plan_json, "
          + "started_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'p', ?, 2, 'ACTIVE', 1, 0, '[]', '{}', "
          + "1, 1, 1, 1)");
        BH10.forEach(([invasionId, systemId], i) => ins.run(invasionId, `k:${invasionId}`, i, TRIG, systemId));
      });
      const inReach = e.tx((db) => listBeachheadsInTx(db, { limit: 8, systems: [NEAR, 5] }));
      const none = e.tx((db) => listBeachheadsInTx(db, { limit: 8, systems: [] }));
      const inPlan = e.tx((db) => db.prepare(`EXPLAIN QUERY PLAN ${BEACHHEADS_IN_SQL}`).all("[1]", 9));
      e.strategy.stop("test");
      e.stations.stop("test");
      return { calls, seen, listed, planRows, inReach, none, inPlan };
    };
    const a = await H.withStore(driver, (reopen) => run({}, reopen()));
    assert.deepStrictEqual(a.calls, []);
    assert.ok(a.seen.has(R.AMARR), JSON.stringify([...a.seen.keys()]));
    assert.strictEqual(a.seen.get(R.AMARR), undefined);
    assert.deepStrictEqual(a.listed, { ok: true, beachheads: [], truncated: false });
    assert.ok(a.planRows.some((x) => String(x.detail).includes("world_invasions_open")), JSON.stringify(a.planRows));
    const b = await H.withStore(driver, (reopen) => run({ EVEJS_LNE_STRATEGY_INVADER_COUNTER_ENABLED: "1" }, reopen()));
    assert.ok(b.calls.length >= 1 && b.calls.every((c) => c.limit === 8), JSON.stringify(b.calls));
    assert.ok(b.calls.every((c) => c.systems.includes(NEAR) && !c.systems.includes(FAR)),
      JSON.stringify(b.calls.map((c) => c.systems)));
    assert.deepStrictEqual(b.seen.get(R.AMARR), { mode: "ready", truncated: false, items: [{ invasionId: "inv_10",
      factionId: TRIG, systemId: NEAR, holders: [], holdersTruncated: false }] });
    assert.strictEqual(b.seen.get(R.SANSHA), undefined);
    assert.deepStrictEqual(a.inReach, { ok: true, beachheads: [{ invasionId: "inv_10", factionId: TRIG,
      systemId: NEAR }], truncated: false });
    assert.deepStrictEqual(a.none, { ok: true, beachheads: [], truncated: false });
    assert.ok(a.inPlan.some((x) => String(x.detail).includes("world_invasions_open ")
      || String(x.detail).endsWith("world_invasions_open")), JSON.stringify(a.inPlan));
    assert.ok(!a.inPlan.some((x) => String(x.detail).includes("world_invasions_open_system")), JSON.stringify(a.inPlan));
  });

  test("IC3 too weak -> INVADER_COUNTER_INSUFFICIENT, no LAUNCH; an open own counter operation -> target skipped", () => {
    const weak = plan(snap({ fleets: [fleet("c1", 20, 1)], beachheads: [beachhead(24, TRIG, 4)] }));
    assert.deepStrictEqual([launches(weak).length, weak.notes], [0, ["INVADER_COUNTER_INSUFFICIENT:24"]]);
    const op = { operationId: "o1", version: 1, state: "ACTIVE", operationType: "counter", objective: "destroy",
      originSystemId: 20, targetSystemId: 24, dueAt: AT + HOUR, members: 1, orderedMembers: 1 };
    const busy = plan(snap({ fleets: [fleet("c1", 20, 3)], beachheads: [beachhead(24)], operations: [op] }));
    assert.deepStrictEqual(busy, { intents: [], notes: [], fleetIds: [] });
    assert.deepStrictEqual(plan(snap({ fleets: [fleet("c1", 20, 3)], beachheads: [beachhead(24)] }),
      { opts: { targets: new Set([24]) } }).intents, []);
  });

  test("IC4 doctrine without counter -> INVADER_COUNTER_NO_KIND; an allied beachhead -> skipped", () => {
    const fleets = [fleet("c1", 20, 3)];
    const noKind = plan(snap({ fleets, beachheads: [beachhead(24)], operationTypes: ["recon", "return"] }));
    assert.deepStrictEqual(noKind, { intents: [], notes: ["INVADER_COUNTER_NO_KIND"], fleetIds: [] });
    const ally = plan(snap({ fleets, beachheads: [beachhead(24, ALLY)] }));
    assert.deepStrictEqual(ally, { intents: [], notes: [], fleetIds: [] });
    const own = plan(snap({ fleets, beachheads: [beachhead(24, F)] }));
    assert.deepStrictEqual(own.intents, []);
  });

  test("IC5 catalogue: kinds v17 counter_offensive (opensFront false, enabled false), no front, doctrines v23, "
    + "compose lines", () => {
    assert.strictEqual(OPERATION_KINDS_VERSION, 19);
    const k = kinds.get("counter_offensive");
    assert.deepStrictEqual({ ...k, fleetRoles: [...k.fleetRoles], targetKinds: [...k.targetKinds] }, {
      kind: "counter_offensive", operationType: "counter", objective: "destroy",
      fleetRoles: ["invasion", "patrol", "garrison"], mobilizeRole: "invasion", offensive: true, opensFront: false,
      captures: false, targetKinds: ["system"], windowKey: "attackWindowMs", needsIntel: false,
      needsCanOccupy: false, enabled: false, occupationSignal: null, inPlace: false });
    assert.strictEqual(OPERATION_TYPES[OPERATION_TYPES.length - 2], "counter");
    const op = (operationType) => ({ operationId: "o1", version: 1, state: "ACTIVE", operationType,
      originSystemId: 20, targetSystemId: 26, dueAt: AT + HOUR, members: 1, orderedMembers: 1 });
    assert.ok(!evaluateSupplyAndFronts(snap({ operations: [op("counter")] }), PARAMS).frontTargets.includes(26));
    assert.strictEqual(DOCTRINES_VERSION, 25);
    assert.deepStrictEqual(DOCTRINES_V1.filter((d) => d.operationTypes.includes("counter")).map((d) => d.kind),
      ["pirate", "empire", "pirate", "pirate", "empire"]);
    const serpentis = DOCTRINES_V1.find((d) => d.doctrineId === "serpentis-territorial-v2");
    const pirateSnap = snap({ fleets: [fleet("c1", 20, 9)], beachheads: [beachhead(24)],
      operationTypes: [...serpentis.operationTypes] });
    delete pirateSnap.invaderBeachheads;
    pirateSnap.entry = { ...pirateSnap.entry, kind: "pirate" };
    assert.deepStrictEqual(plan(pirateSnap), { intents: [], notes: [], fleetIds: [] });
    const compose = fs.readFileSync(COMPOSE, "utf8");
    for (const key of ["ENABLED", "RANGE_JUMPS", "MAX_PER_REVIEW"]) {
      const name = `EVEJS_LNE_STRATEGY_INVADER_COUNTER_${key}`;
      assert.ok(compose.includes(`${name}: \${${name}:-}`), name);
    }
  });
};
