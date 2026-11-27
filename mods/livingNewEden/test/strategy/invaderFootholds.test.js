"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createReviewFootholdsOf, FOOTHOLDS_THREW } = require("../../lib/strategy/reviewFootholds");
const { markFootholdHolders, FOOTHOLD_HOLDING } = require("../../lib/strategy/ai/footholdHold");
const { decideReview } = require("../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { decideStep } = require("../../lib/world/invasions/invasionMachine");
const IS = require("../../lib/world/invasions/schema");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const TRIG = 500026;
const SLEEPERS = 500021;
const HIVE = 500025;
const HOSTILE = 9;
const OUTSIDE = 100;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const WING = [{ hullGroup: "cruiser", typeId: null, count: 6 }];

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 15,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 12, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6, routeMaxJumps: 40,
  maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true, footholdHold: null });
const hold = (minFleets) => ({ ...PARAMS, footholdHold: { minFleets } });

const doctrine = (id) => DOCTRINES_V1.find((x) => x.doctrineId === id);
const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0, ...extra });
const intelOf = (systemId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
  hostileStrength: 0, hostileStations: 0, controllerFactionId: null });
const fleet = (fleetId, systemId, fleetRole = "invasion") => ({ fleetId, version: 2, state: "IDLE", fleetRole,
  systemId, refitPending: false, shipCount: 6, strength: strengthOf(WING, POWER), operationId: null, legSeq: 0,
  homeSystemId: systemId, updatedAt: AT - HOUR });

function snap(o) {
  const d = o.doctrine || doctrine(o.doctrineId || "triglavian-invader-v1");
  return { v: 1, factionId: o.factionId || TRIG, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: o.home === undefined ? OUTSIDE : o.home, doctrineId: d.doctrineId,
      resourceUnits: 100000, reserveUnits: 10000, frontLimit: 6, version: 1 },
    entry: { kind: "invader", maxActiveFronts: o.maxActiveFronts === undefined ? 1 : o.maxActiveFronts, allies: [],
      homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: d, theatre: [], expansion: o.expansion || [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 12), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [], captureAnchors: [],
    systems: [row(5, null), row(6, null)], fleets: o.fleets, fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: [intelOf(6)], sightings: [], occupations: [], territory: [],
    territoryTruncated: false, capturedIds: [], footholds: o.footholds };
}
const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);
const usedIds = (d) => new Set(d.intents.flatMap((i) => (Array.isArray(i.fleets) ? i.fleets : [])
  .map((x) => (typeof x === "string" ? x : x.fleetId))));

module.exports = ({ test }) => {
  test("FH1 reader: hive -> nodes (flag on/off), invader off -> [], invader on -> footholdsOf, empire/pirate "
    + "on -> [] without a read; a throw -> FOOTHOLDS_THREW; config key off by default", () => {
    const KIND = { [HIVE]: "hive", [TRIG]: "invader", 500001: "empire", 500010: "pirate" };
    const calls = { nodes: 0, footholds: 0 };
    const hive = { isHive: (f) => f === HIVE,
      listNodesInTx: () => { calls.nodes += 1; return { ok: true, footholds: [{ systemId: 20, jumps: 10 }] }; } };
    const FH = { ok: true, footholds: [{ systemId: 5, jumps: 3 }] };
    const footholdsOf = () => { calls.footholds += 1; return FH; };
    const reader = (enabled) => createReviewFootholdsOf({ hive, footholdsOf, enabled, kindOf: (f) => KIND[f] || null });
    for (const on of [true, false]) {
      assert.deepStrictEqual(reader(on)({}, HIVE), { ok: true, footholds: [{ systemId: 20, jumps: 10 }] });
    }
    assert.deepStrictEqual(calls, { nodes: 2, footholds: 0 });
    assert.deepStrictEqual([reader(false)({}, TRIG), reader(true)({}, 500001), reader(true)({}, 500010)],
      [{ ok: true, footholds: [] }, { ok: true, footholds: [] }, { ok: true, footholds: [] }]);
    assert.strictEqual(calls.footholds, 0);
    assert.strictEqual(reader(true)({}, TRIG), FH);
    assert.strictEqual(calls.footholds, 1);
    assert.deepStrictEqual(createReviewFootholdsOf({ hive, footholdsOf: null, enabled: true,
      kindOf: () => "invader" })({}, TRIG), { ok: true, footholds: [] });
    const threw = createReviewFootholdsOf({ hive, footholdsOf: () => { throw new Error("boom"); }, enabled: true,
      kindOf: () => "invader" })({}, TRIG);
    assert.deepStrictEqual(threw, { ok: false, reason: FOOTHOLDS_THREW, detail: "boom" });
    const off = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: "x" } }).config;
    const on = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: "x",
      EVEJS_LNE_INVASIONS_REVIEW_FOOTHOLDS_ENABLED: "true" } }).config;
    assert.deepStrictEqual([off.invasions.reviewFootholdsEnabled, on.invasions.reviewFootholdsEnabled], [false, true]);
  });

  test("FH2: Triglavian with an ACTIVE foothold 5 (range 3) and a free 6 -> LAUNCH invasion 6; without the "
    + "foothold (flag off) -> no LAUNCH invasion", () => {
    const fleets = [fleet("w1", 5), fleet("w2", 5), fleet("g1", 5, "garrison")];
    const on = decideReview(snap({ footholds: [{ systemId: 5, jumps: 3 }], expansion: [6], fleets }), hold(1));
    assert.strictEqual(on.outcome, "REVIEWED", on.reason);
    assert.ok(launches(on).some(([k, t]) => k === "invasion" && t === 6), JSON.stringify(on.intents));
    assert.ok(!usedIds(on).has("g1"), JSON.stringify(on.intents));
    const off = decideReview(snap({ footholds: [], expansion: [6], fleets }), PARAMS);
    assert.strictEqual(off.outcome, "REVIEWED", off.reason);
    assert.ok(!launches(off).some(([k]) => k === "invasion"), JSON.stringify(off.intents));
  });

  test("FH3: two invasion fleets in the foothold, minFleets 1 -> one leaves, one stays (FOOTHOLD_HOLD), the "
    + "machine HOLDs; minFleets 2 -> no fleet leaves", () => {
    const fleets = [fleet("w1", 5), fleet("w2", 5)];
    const s = snap({ footholds: [{ systemId: 5, jumps: 3 }], expansion: [6], fleets });
    const d = decideReview(s, hold(1));
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    assert.ok(launches(d).some(([k, t]) => k === "invasion" && t === 6), JSON.stringify(d.intents));
    assert.ok(d.notes.includes("FOOTHOLD_HOLD"), JSON.stringify(d.notes));
    const used = usedIds(d);
    const holders = fleets.filter((x) => !used.has(x.fleetId)).length;
    assert.ok(holders >= 1 && holders < fleets.length, `holders=${holders} ${JSON.stringify(d.intents)}`);
    const step = decideStep({ invasion: { state: IS.STATE_ACTIVE, stepSeq: 1, withdrawAt: null }, payloadSeq: 1,
      holders, holdersTruncated: false, at: AT, liveFleets: [], beachhead: {} },
    { holdMinFleets: 1, checkIntervalMs: 600000, withdrawRetryMs: 900000, withdrawMaxRounds: 16 });
    assert.strictEqual(step.action, "HOLD", JSON.stringify(step));
    const bare = usedIds(decideReview(s, PARAMS));
    assert.ok(bare.has("w1") && !used.has("w1") && used.has("w2"), JSON.stringify([[...bare], [...used]]));
    const two = decideReview(s, hold(2));
    assert.strictEqual(two.outcome, "REVIEWED", two.reason);
    assert.ok(!usedIds(two).has("w1") && !usedIds(two).has("w2"), JSON.stringify(two.intents));
    const pseudo = new Map();
    assert.deepStrictEqual(markFootholdHolders(s, hold(2), pseudo), ["FOOTHOLD_HOLD"]);
    assert.deepStrictEqual([...pseudo], [["w1", FOOTHOLD_HOLDING], ["w2", FOOTHOLD_HOLDING]]);
    assert.deepStrictEqual(markFootholdHolders(s, hold(3), new Map()), ["FOOTHOLD_HOLD", "FOOTHOLD_UNHELD"]);
  });

  test("FH4 Sleepers (reach 0, no fronts, no home) take nothing beyond the foothold; the hive decides the same with "
    + "and without footholdHold", () => {
    const sl = decideReview(snap({ factionId: SLEEPERS, doctrineId: "sleeper-invader-v1", home: null,
      maxActiveFronts: 0, footholds: [{ systemId: 5, jumps: 0 }], expansion: [],
      fleets: [fleet("s1", 5, "garrison"), fleet("s2", 5, "garrison")] }), hold(1));
    assert.ok(!launches(sl).some(([k]) => k === "invasion"), JSON.stringify(sl.intents));
    const hiveDoctrine = { ...doctrine("rogue-hive-v1"), expandsBeyondTheatre: false, capturesStations: false,
      hive: true };
    const hs = { ...snap({ factionId: HIVE, doctrine: hiveDoctrine, footholds: [{ systemId: 5, jumps: 3 },
      { systemId: 8, jumps: 3 }], expansion: [6], fleets: [fleet("h1", 5), fleet("h2", 8)] }),
    entry: { kind: "hive", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 } };
    const a = decideReview(hs, PARAMS);
    const b = decideReview(hs, hold(1));
    assert.deepStrictEqual(b, a);
    assert.ok(!b.notes.includes("FOOTHOLD_HOLD"), JSON.stringify(b.notes));
    assert.deepStrictEqual(markFootholdHolders({ ...hs, entry: { ...hs.entry, kind: "invader" },
      doctrine: { ...hs.doctrine, hive: true } }, hold(1), new Map()), []);
  });
};
