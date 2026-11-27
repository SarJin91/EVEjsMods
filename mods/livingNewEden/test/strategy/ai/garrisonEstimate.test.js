"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { chooseNextOperation } = require("../../../lib/strategy/ai/operations");
const { describe } = require("../../../lib/strategy/ai/targeting");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const { buildPowerTable, strengthOf, garrisonPowerOf } = require("../../../lib/strategy/ai/strength");
const { garrisonEstimateOf } = require("../../../lib/strategy/reviewService");
const { resolveConfig } = require("../../../config");
const { createRng } = require("../../../lib/util/rng");
const { DOCTRINES_V1 } = require("../../../lib/strategy/data/doctrines");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");

const MOD_DIR = path.join(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 500006;
const SANSHA = 500019;
const T = 2;
const HOME = 5;
const PER_POINT = Math.sqrt(20000);
const CONCORD = DOCTRINES_V1.find((d) => d.doctrineId === "concord-border-police-v1");

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const FRIGATE = strengthOf([{ hullGroup: "frigate", count: 1 }], POWER);
const PATROL = [{ hullGroup: "frigate", typeId: null, count: 3 }, { hullGroup: "destroyer", typeId: null, count: 3 }];

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 9000,
  maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 0, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40 });

const withEstimate = (ge) => (ge === undefined ? PARAMS : Object.freeze({ ...PARAMS, garrisonEstimate: ge }));
const RESOLVER = Object.freeze({ mode: "resolver", powerPerPoint: PER_POINT, stationPoints: 80 });
const LEGACY = Object.freeze({ mode: "legacy", powerPerPoint: PER_POINT, stationPoints: 80 });

function snapshotOf(o = {}) {
  const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId,
    occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, ...extra });
  return { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: HOME, frontLimit: 1 }, entry: { homeRegionIds: [] },
    doctrine: CONCORD, theatre: [], expansion: [], border: { mode: "ready", candidates: [T] },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 10), regionOf: () => null,
    isHostile: (x) => x === SANSHA || x === o.otherHostile, stations: [], captureAnchors: [HOME],
    systems: [row(T, o.controller === undefined ? SANSHA : o.controller,
      { controllerGarrison: FRIGATE, hostileStations: o.stations || 0 }), row(HOME, F)],
    fleets: [{ fleetId: "vf-patrol", version: 1, state: "IDLE", fleetRole: "patrol", systemId: HOME,
      refitPending: false, shipCount: 6, strength: strengthOf(PATROL, POWER), operationId: null, legSeq: 0,
      homeSystemId: HOME }],
    fleetsTruncated: false, operations: [], operationsTruncated: false,
    intel: [{ systemId: T, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 1, hostileStrength: FRIGATE,
      hostileStations: 0, controllerFactionId: SANSHA }], sightings: [] };
}

function decide(ge) {
  const s = snapshotOf();
  const reach = new Map([[T, 3]]);
  const supply = { frontTargets: [], frontLimit: 1, anchors: [HOME], stationSystems: [HOME],
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6 }, reach, captureReach: new Map(reach), captureRoom: null,
    border: new Map(reach) };
  const params = withEstimate(ge);
  return chooseNextOperation(s, supply, params, createRng(1), createHullLedger(s, params));
}

const factsOf = (ge, o) => {
  const s = snapshotOf(o);
  const f = describe(s, withEstimate(ge), new Map(s.intel.map((x) => [x.systemId, x])), T);
  return [f.garrison, f.enemyStrength];
};

module.exports = ({ test }) => {
  test("GE-R0 garrisonPowerOf: 286 points x sqrt(20000) = 40447, 0 / negative / NaN points -> 0", () => {
    assert.deepStrictEqual([garrisonPowerOf(286, PER_POINT), garrisonPowerOf(0, PER_POINT),
      garrisonPowerOf(-1, PER_POINT), garrisonPowerOf(NaN, PER_POINT), garrisonPowerOf(286, 0)],
    [40447, 0, 0, 0, 0]);
  });

  test("GE-L1 describe without params.garrisonEstimate and with mode legacy: garrison = controllerGarrison "
    + "(288), enemyStrength = intel + garrison (576), as before", () => {
    assert.strictEqual(FRIGATE, 288);
    assert.deepStrictEqual({ none: factsOf(undefined), legacy: factsOf(LEGACY),
      legacyStations: factsOf(LEGACY, { stations: 2 }) },
    { none: [288, 576], legacy: [288, 576], legacyStations: [288, 576] });
  });

  test("GE-R1/R2 describe mode resolver: garrison points in powerTable units, hostile stations x "
    + "stationPoints, a non-hostile controller -> 0", () => {
    assert.deepStrictEqual({
      r1: factsOf(RESOLVER),
      r2: factsOf(RESOLVER, { stations: 1 }),
      r2NoStationPoints: factsOf({ ...RESOLVER, stationPoints: 0 }, { stations: 1 }),
      notHostile: factsOf(RESOLVER, { controller: 500001, stations: 1 }),
    }, {
      r1: [40729, 40729 + 288],
      r2: [Math.round(368 * PER_POINT), Math.round(368 * PER_POINT) + 288],
      r2NoStationPoints: [40729, 40729 + 288],
      notHostile: [0, 288],
    });
  });

  test("GE-R3 CONCORD-like patrol (2337) vs Sansha 1-frigate garrison: legacy (and no object) LAUNCH raid "
    + "with the same decision, resolver INSUFFICIENT_FORCE and no LAUNCH", () => {
    assert.strictEqual(strengthOf(PATROL, POWER), 2337);
    const none = decide(undefined);
    const legacy = decide(LEGACY);
    const resolver = decide(RESOLVER);
    const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);
    assert.deepStrictEqual(legacy, none);
    assert.deepStrictEqual({ legacy: launches(legacy), resolver: [launches(resolver),
      resolver.notes.includes("INSUFFICIENT_FORCE")] }, { legacy: [["raid", T]], resolver: [[], true] },
    JSON.stringify({ legacy: legacy.notes, resolver: resolver.notes }));
  });

  test("GE-C1 config strategy.garrisonEstimate: env legacy, env resolver, an unknown value -> the lower layer "
    + "(legacy) with a warning; powerPerPoint = sqrt(dps x ehp per point), no config.battle -> 0", () => {
    const of = (env, envFile) => resolveConfig({ modDir: MOD_DIR, env, envFile });
    const def = of({ EVEJS_LNE_STRATEGY_GARRISON_ESTIMATE: "legacy" });
    const res = of({ EVEJS_LNE_STRATEGY_GARRISON_ESTIMATE: "resolver" });
    const bad = of({ EVEJS_LNE_STRATEGY_GARRISON_ESTIMATE: "x" }, { EVEJS_LNE_STRATEGY_GARRISON_ESTIMATE: "legacy" });
    const ge = garrisonEstimateOf(res.config);
    const siegeOn = res.config.siege.enabled === true && res.config.siege.stationGarrisonEnabled === true;
    assert.deepStrictEqual({ def: [def.config.strategy.garrisonEstimate, garrisonEstimateOf(def.config).mode],
      res: [ge.mode, ge.powerPerPoint, ge.stationPoints], bad: [bad.config.strategy.garrisonEstimate,
        bad.warnings.some((w) => String(w).includes("GARRISON_ESTIMATE") && String(w).includes("legacy or resolver"))],
      noBattle: garrisonEstimateOf({ ...res.config, battle: undefined }).powerPerPoint }, {
      def: ["legacy", "legacy"], res: ["resolver", PER_POINT, siegeOn ? 80 : 0], bad: ["legacy", true],
      noBattle: 0 });
  });

  test("BIG3 battle.influenceGarrison off: influencePoints false; resolver describe with controllerGarrison "
    + "10120 and 1 hostile station -> round(80 x powerPerPoint); influencePoints true as before; legacy unchanged", () => {
    const of = (env) => resolveConfig({ modDir: MOD_DIR, env }).config;
    const offCfg = of({ EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: "off" });
    const facts = (ge) => {
      const s = snapshotOf({ stations: 1 });
      s.systems.find((x) => x.systemId === T).controllerGarrison = 10120;
      return describe(s, withEstimate(ge), new Map(), T).garrison;
    };
    assert.deepStrictEqual({
      cfg: [garrisonEstimateOf(offCfg).influencePoints,
        garrisonEstimateOf(of({ EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: "legacy" })).influencePoints,
        garrisonEstimateOf({ ...offCfg, battle: undefined }).influencePoints],
      off: facts({ ...RESOLVER, influencePoints: false }),
      on: [facts({ ...RESOLVER, influencePoints: true }), facts(RESOLVER)],
      legacy: [facts({ ...LEGACY, influencePoints: false }), facts(LEGACY)],
    }, {
      cfg: [false, true, true],
      off: Math.round(80 * PER_POINT),
      on: [Math.round(10200 * PER_POINT), Math.round(10200 * PER_POINT)],
      legacy: [10120, 10120],
    });
  });

  test("BIG4 config battle.influenceGarrison: env legacy, env off accepted, foo -> the lower layer (legacy) "
    + "with a warning", () => {
    const of = (env, envFile) => resolveConfig({ modDir: MOD_DIR, env, envFile });
    const bad = of({ EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: "foo" }, { EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: "legacy" });
    assert.deepStrictEqual({ def: of({ EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: "legacy" }).config.battle.influenceGarrison,
      off: of({ EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: "off" }).config.battle.influenceGarrison,
      bad: [bad.config.battle.influenceGarrison, bad.warnings.some((w) => String(w).includes("INFLUENCE_GARRISON")
        && String(w).includes("legacy or off"))] }, { def: "legacy", off: "off", bad: ["legacy", true] });
  });

  test("PAIR1 the default pair (as compose since): strategy.garrisonEstimate resolver "
    + "battle.influenceGarrison off -> garrisonEstimateOf mode resolver without influence points; rollback pair "
    + "legacy + legacy -> mode legacy with influence points", () => {
    const of = (env) => resolveConfig({ modDir: MOD_DIR, env });
    const def = of({});
    const back = of({ EVEJS_LNE_STRATEGY_GARRISON_ESTIMATE: "legacy", EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: "legacy" });
    const pair = (r) => [r.config.strategy.garrisonEstimate, r.config.battle.influenceGarrison,
      garrisonEstimateOf(r.config).mode, garrisonEstimateOf(r.config).influencePoints,
      r.sources["strategy.garrisonEstimate"], r.sources["battle.influenceGarrison"]];
    assert.deepStrictEqual({ def: pair(def), back: pair(back) }, {
      def: ["resolver", "off", "resolver", false, "default", "default"],
      back: ["legacy", "legacy", "legacy", true, "environment", "environment"] });
  });

  test("PAIR2 mixed garrison pair warns (resolver + legacy, legacy + off); resolver + off and legacy + legacy "
    + "give no pair warning", () => {
    const warned = (ge, ig) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_STRATEGY_GARRISON_ESTIMATE: ge,
      EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: ig } }).warnings.some((w) => String(w).includes("mixed garrison pair"));
    assert.deepStrictEqual({ rl: warned("resolver", "legacy"), lo: warned("legacy", "off"),
      ro: warned("resolver", "off"), ll: warned("legacy", "legacy") }, { rl: true, lo: true, ro: false, ll: false });
  });

  test("PAIR3 a bad env value alone (no lower layer) -> the new default resolver / off with a warning", () => {
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_STRATEGY_GARRISON_ESTIMATE: "x",
      EVEJS_LNE_BATTLE_INFLUENCE_GARRISON: "foo" } });
    const has = (a, b) => r.warnings.some((w) => String(w).includes(a) && String(w).includes(b));
    assert.deepStrictEqual({ pair: [r.config.strategy.garrisonEstimate, r.config.battle.influenceGarrison,
      r.sources["strategy.garrisonEstimate"], r.sources["battle.influenceGarrison"]],
    warned: [has("GARRISON_ESTIMATE", "legacy or resolver"), has("INFLUENCE_GARRISON", "legacy or off")] }, {
      pair: ["resolver", "off", "default", "default"], warned: [true, true] });
  });
};
