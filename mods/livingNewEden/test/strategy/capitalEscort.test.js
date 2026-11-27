"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { chooseNextOperation } = require("../../lib/strategy/ai/operations");
const { planGarrisonReinforce } = require("../../lib/strategy/ai/garrison");
const { planCapitalEscort, escortDistOf } = require("../../lib/strategy/ai/capitalEscort");
const { eligibleClassesOf } = require("../../lib/strategy/ai/capitalAttach");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { fitIskOf } = require("../../lib/strategy/ai/warChest");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createRng } = require("../../lib/util/rng");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { capitalAttachParamsOf, capitalEscortParamsOf, escalationParamsOf, capitalLevelParamsOf } =
  require("../../lib/strategy/reviewService");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const H = 9;
const TITAN = 11001;
const DREAD = 11002;
const CLASSES = Object.freeze({ titan: TITAN, dreadnought: DREAD });
const VALUES = Object.freeze({ cruiser: 1000, frigate: 500, battlecruiser: 2000, titan: 100000, dreadnought: 50000 });
const PERMILLE = 100;
const WAR = Object.freeze({ valueByGroup: VALUES, fitPermille: PERMILLE, captureIsk: 0 });
const POWER = buildPowerTable(expandStrengthGroups(GROUPS));
const PATROL = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const TITAN_ONE = Object.freeze([{ hullGroup: "titan", count: 1 }]);
const fit = (c) => fitIskOf(c, VALUES, PERMILLE);
const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();

const cfgOf = (env) => resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
const ATTACH = capitalAttachParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1" }).config);
const PREFER = capitalAttachParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1",
  EVEJS_LNE_STRATEGY_CAPITAL_PREFER_STATION_ENABLED: "1" }).config);
const ESCORT = capitalEscortParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1",
  EVEJS_LNE_STRATEGY_CAPITAL_ESCORT_ENABLED: "1" }).config);
const PROD = Object.freeze({ mobilizeHulls: "required", miningNeedsHulls: false, hullGroups: [...HULL_GROUPS] });
const prodOf = (stations) => ({ mode: "ready", recipesVersion: 1, recipes: {}, inProduction: {}, activeJobsTotal: 0,
  truncated: false, stations: stations.map((s) => ({ kind: "npc", lines: 1, activeJobs: [], minerals: {}, ...s })) });
const line = (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40);
const launchOf = (out) => out.intents.find((i) => i.type === "LAUNCH");

const OP_PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  production: PROD });

function opRun(o = {}) {
  const T = 1;
  const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: 40, frontLimit: 1 }, entry: { homeRegionIds: [] },
    doctrine: { doctrineId: "ce", canOccupy: false, captureTargets: [], operationTypes: ["recon", "raid"],
      templates: { patrol: PATROL, scout: [{ hullGroup: "frigate", count: 1 }] } },
    theatre: [T], expansion: [], neighbors: line, regionOf: () => null, isHostile: (x) => x === H,
    stations: [{ systemId: 5, stationId: "st5" }, { systemId: 9, stationId: "st9" }],
    systems: [{ systemId: T, controllerFactionId: H, occupationState: "STABLE", controllerGarrison: 0,
      hostileStations: 0, observed: false }], fleets: [], operations: [], operationsTruncated: false,
    intel: [{ systemId: T, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0, hostileStrength: o.enemy || 0,
      hostileStations: 0, controllerFactionId: H }], sightings: [],
    production: prodOf([{ stationId: "st5", systemId: 5, hulls: o.st5 || {} },
      { stationId: "st9", systemId: 9, hulls: o.st9 || {} }]), capitalClasses: CLASSES };
  const war = o.isk !== undefined ? WAR : null;
  const supply = { frontTargets: [], frontLimit: 1, anchors: [40], stationSystems: [5, 9],
    affordable: { resourceUnits: o.resources !== undefined ? o.resources : 1e6, reserveUnits: 1e6,
      ...(war ? { isk: o.isk } : {}) }, reach: new Map([[T, 1]]), captureReach: new Map(), captureRoom: null,
    border: new Map(), ...(war ? { war } : {}) };
  const P = { ...OP_PARAMS, ...(o.params || {}), capitalAttach: o.attach === undefined ? null : o.attach,
    ...(o.escort ? { capitalEscort: o.escort } : {}) };
  const ledger = createHullLedger(s, P);
  const out = chooseNextOperation(s, supply, P, createRng(1), ledger);
  return { out, ledger };
}

const GARRISON = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);
function gaRun(o = {}) {
  const posts = [22, 25, 18];
  const row = (systemId, c) => ({ systemId, controllerFactionId: c, occupationState: "STABLE", controllerGarrison: 0,
    hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "ga", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "ga", canOccupy: true, reachJumps: 30, operationTypes: ["recon", "raid", "reinforce"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: PATROL, garrison: GARRISON } },
    theatre: [14], expansion: [], neighbors: line, regionOf: () => null, isHostile: (x) => x === H,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }, { systemId: 24, stationId: "st24" }],
    systems: [row(14, H), ...posts.map((id) => row(id, F)), row(20, F), row(24, F)], fleets: [],
    fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], sightings: [],
    territory: posts.map((systemId) => ({ systemId, detachedSinceAt: null })), territoryTruncated: false,
    production: prodOf([{ stationId: "st20", systemId: 20, hulls: { cruiser: 4, battlecruiser: 2 } },
      { stationId: "st24", systemId: 24, hulls: { titan: 1 } }]), capitalClasses: CLASSES };
  const P = { ...OP_PARAMS, maxAssemblyJumps: 8, maxOperationsPerReview: 2, maxMobilizationsPerReview: 3,
    garrison: { maxPerReview: 1 }, capitalAttach: ATTACH, ...(o.escort ? { capitalEscort: o.escort } : {}),
    ...(o.params || {}) };
  const ledger = createHullLedger(s, P);
  const out = planGarrisonReinforce({ snapshot: s, supply: { stationSystems: [20, 24], war: WAR }, params: P, ledger,
    slots: { operations: 2, mobilizations: o.mobSlots || 3 },
    budget: { resourceUnits: 1e6, reserveUnits: 1e6, isk: 1e9 } });
  return { out, ledger };
}

module.exports = ({ test }) => {
  test("CE1 planCapitalEscort: the nearest station with a capital (never T, never beyond maxJumps), class order of "
    + "attach.order; none -> CAPITAL_ESCORT_NONE; budget / ISK short -> CAPITAL_ESCORT_RESOURCES / _ISK", () => {
    assert.deepStrictEqual(ESCORT, { maxJumps: 8, maxBfsSystems: 2000 });
    const stock = { stT: { dreadnought: 1 }, st3: {}, st6: { dreadnought: 1, titan: 1 }, st12: { titan: 1 } };
    const lgOf = (map) => ({ available: (st, cls) => (map[st] && map[st][cls]) || 0 });
    const snapshot = { neighbors: line, capitalClasses: CLASSES,
      stations: [{ systemId: 12, stationId: "st12" }, { systemId: 6, stationId: "st6" }, { systemId: 3, stationId: "st3" },
        { systemId: 1, stationId: "stT" }] };
    const params = { capitalAttach: ATTACH, capitalEscort: ESCORT, mobilizeResourcePerShip: 10,
      mobilizeReservePerShip: 1, powerTable: POWER };
    const dist = escortDistOf(snapshot, params, 1);
    assert.deepStrictEqual([dist.has(9), dist.has(10)], [true, false]);
    const base = { snapshot, params, target: 1, level: 0, role: "patrol", dist,
      budget: { resourceUnits: 1e6, reserveUnits: 1e6 }, iskLeft: 1e9, war: WAR };
    const r = planCapitalEscort({ ...base, lg: lgOf(stock) });
    const comp = [{ hullGroup: "titan", typeId: TITAN, count: 1 }];
    assert.deepStrictEqual(r, { intent: { type: "MOBILIZE", role: "patrol", systemId: 6, homeSystemId: 6, composition: comp,
      cost: { resourceUnits: 10, reserveUnits: 1 }, stationId: "st6", hulls: [{ itemKey: "group:titan", count: 1 }],
      warIsk: fit(TITAN_ONE) }, strength: strengthOf(comp, POWER), fit: fit(TITAN_ONE), cls: "titan" });
    assert.ok(!("warIsk" in planCapitalEscort({ ...base, lg: lgOf(stock), iskLeft: null }).intent));
    assert.deepStrictEqual(planCapitalEscort({ ...base, lg: lgOf({ stT: stock.stT, st12: stock.st12 }) }),
      { intent: null, note: "CAPITAL_ESCORT_NONE" });
    assert.deepStrictEqual(planCapitalEscort({ ...base, lg: lgOf(stock), budget: { resourceUnits: 9, reserveUnits: 9 } }),
      { intent: null, note: "CAPITAL_ESCORT_RESOURCES" });
    assert.deepStrictEqual(planCapitalEscort({ ...base, lg: lgOf(stock), iskLeft: fit(TITAN_ONE) - 1 }),
      { intent: null, note: "CAPITAL_ESCORT_ISK" });
    assert.deepStrictEqual(eligibleClassesOf({ template: [], capitalClasses: CLASSES, attach: ATTACH }),
      ["titan", "dreadnought"]);
    assert.deepStrictEqual(eligibleClassesOf({ template: TITAN_ONE, capitalClasses: CLASSES, attach: ATTACH }),
      ["dreadnought"]);
    const gated = { ...ATTACH, minLevelOf: { titan: 3, dreadnought: 2 } };
    assert.deepStrictEqual([eligibleClassesOf({ template: [], capitalClasses: CLASSES, attach: gated, level: 2 }),
      planCapitalEscort({ ...base, lg: lgOf(stock), params: { ...params, capitalAttach: gated }, level: 1 })],
    [["dreadnought"], { intent: null, note: "CAPITAL_ESCORT_NONE" }]);
  });

  test("CE2 preference: two stations with the whole template, the titan only on the farther one -> flag on: the "
    + "MOBILIZE from st9 with the titan; off: from st5 without it (CAPITAL_NOT_AT_STATION)", () => {
    const o = { st5: { cruiser: 2 }, st9: { cruiser: 2, titan: 1 } };
    const on = opRun({ ...o, attach: PREFER });
    const mOn = launchOf(on.out).mobilize;
    assert.strictEqual(mOn.length, 1, JSON.stringify(on.out));
    assert.deepStrictEqual([mOn[0].stationId, mOn[0].composition.map((e) => e.hullGroup)], ["st9", ["cruiser", "titan"]]);
    assert.strictEqual(on.ledger.available("st9", "titan"), 0);
    const off = opRun({ ...o, attach: ATTACH });
    const mOff = launchOf(off.out).mobilize;
    assert.deepStrictEqual([mOff[0].stationId, mOff[0].composition.map((e) => e.hullGroup)], ["st5", ["cruiser"]]);
    assert.ok(off.out.notes.includes("CAPITAL_NOT_AT_STATION"), JSON.stringify(off.out.notes));
    const gated = opRun({ ...o, attach: { ...PREFER, minLevelOf: { titan: 3, dreadnought: 3 } } });
    assert.strictEqual(launchOf(gated.out).mobilize[0].stationId, "st5");
  });

  test("CE3 escort of an attack: LAUNCH with 2 MOBILIZE (template st5 + titan of st9), slot / warIsk / cost, note "
    + "CAPITAL_ESCORT once; the escort that closes the requirement; limits; both flags off = the intents of today", () => {
    const o = { st5: { cruiser: 2 }, st9: { titan: 1 }, isk: 1e9 };
    const r = opRun({ ...o, attach: ATTACH, escort: ESCORT });
    const l = launchOf(r.out);
    assert.ok(l, JSON.stringify(r.out));
    assert.strictEqual(l.mobilize.length, 2, JSON.stringify(l));
    const e = l.mobilize[1];
    assert.deepStrictEqual(e, { type: "MOBILIZE", slot: 1, role: "patrol", systemId: 9, homeSystemId: 9,
      composition: [{ hullGroup: "titan", typeId: TITAN, count: 1 }], cost: { resourceUnits: 10, reserveUnits: 1 },
      stationId: "st9", hulls: [{ itemKey: "group:titan", count: 1 }], warIsk: fit(TITAN_ONE) });
    assert.deepStrictEqual([l.mobilize[0].stationId, l.mobilize[0].slot, l.slot, l.originSystemId], ["st5", 0, 2, 5]);
    assert.strictEqual(r.ledger.available("st9", "titan"), 0);
    assert.strictEqual(r.out.notes.filter((n) => n === "CAPITAL_ESCORT").length, 1);
    const tplS = strengthOf(PATROL.map((x) => ({ ...x, typeId: null })), POWER);
    const tiS = strengthOf([{ hullGroup: "titan", typeId: TITAN, count: 1 }], POWER);
    const enemy = Math.floor((tplS + tiS / 2) / 1.2);
    const req = Math.max(1, Math.ceil(enemy * 1.2));
    assert.ok(req > tplS && req <= tplS + tiS, `${tplS} ${tiS} ${req}`);
    const close = opRun({ ...o, enemy, attach: ATTACH, escort: ESCORT });
    assert.strictEqual(launchOf(close.out).mobilize.length, 2, JSON.stringify(close.out));
    for (const lim of [{ params: { maxMobilizationsPerReview: 1 } }, { params: { maxFleetsPerOperation: 1 } },
      { resources: 20 }]) {
      const x = opRun({ ...o, ...lim, attach: ATTACH, escort: ESCORT });
      const miss = lim.resources !== undefined ? ["CAPITAL_ESCORT_RESOURCES"] : [];
      assert.deepStrictEqual(x.out.notes.filter((n) => n.startsWith("CAPITAL_ESCORT_")), miss, JSON.stringify(lim));
      assert.deepStrictEqual({ ...x.out, notes: x.out.notes.filter((n) => !miss.includes(n)) },
        opRun({ ...o, ...lim, attach: ATTACH }).out, JSON.stringify(lim));
      assert.strictEqual(x.ledger.available("st9", "titan"), 1);
    }
    const today = { ...ATTACH };
    delete today.preferStation;
    assert.strictEqual(ATTACH.preferStation, false);
    assert.strictEqual(JSON.stringify(opRun({ ...o, attach: ATTACH }).out), JSON.stringify(opRun({ ...o, attach: today }).out));
    assert.deepStrictEqual(opRun({ ...o, escort: ESCORT }).out, opRun(o).out);
  });

  test("CE4 an attack the escort does not close -> no escort intent: the near MOBILIZE as today, titan of st9 still "
    + "available, slot 0, no CAPITAL_ESCORT", () => {
    const o = { st5: { cruiser: 2 }, st9: { titan: 1 }, isk: 1e9, enemy: 1e7 };
    const r = opRun({ ...o, attach: ATTACH, escort: ESCORT });
    assert.deepStrictEqual(r.out, opRun({ ...o, attach: ATTACH }).out);
    assert.ok(r.out.notes.includes("INSUFFICIENT_FORCE"), JSON.stringify(r.out.notes));
    assert.ok(!r.out.notes.includes("CAPITAL_ESCORT"));
    assert.strictEqual(launchOf(r.out), undefined);
    const mobs = r.out.intents.filter((i) => i.type === "MOBILIZE");
    assert.deepStrictEqual(mobs.map((m) => [m.stationId, m.slot]), [["st5", 0]]);
    assert.strictEqual(r.ledger.available("st9", "titan"), 1);
  });

  test("CE5 garrison: the template of st20 without a capital -> LAUNCH garrison with mobilize [template, titan of "
    + "st24], cost / ISK of both; slots.mobilizations 1 -> no escort; config defaults, warning and the row bound", () => {
    const off = gaRun();
    const r = gaRun({ escort: ESCORT });
    const l = r.out.intents.find((i) => i.type === "LAUNCH");
    assert.ok(l, JSON.stringify(r.out));
    assert.strictEqual(l.mobilize.length, 2, JSON.stringify(l));
    const e = l.mobilize[1];
    assert.deepStrictEqual([e.role, e.stationId, e.systemId, e.composition, e.slot, l.slot],
      ["garrison", "st24", 24, [{ hullGroup: "titan", typeId: TITAN, count: 1 }], 1, 2]);
    assert.deepStrictEqual([r.out.cost.resourceUnits, r.out.cost.isk],
      [off.out.cost.resourceUnits + 10, off.out.cost.isk + fit(TITAN_ONE)]);
    assert.ok(r.out.notes.includes("CAPITAL_ESCORT"));
    assert.strictEqual(r.ledger.available("st24", "titan"), 0);
    assert.ok(!Object.hasOwn(e, "escalationLevel"), "garrison ladder off -> no level, as the template MOBILIZE");
    const escCfg = cfgOf({ EVEJS_LNE_STRATEGY_ESCALATION_ENABLED: "1" }).config;
    const lv = gaRun({ escort: ESCORT, params: { garrison: { maxPerReview: 1, escalation: true },
      escalation: escalationParamsOf(escCfg), capitalLevel: capitalLevelParamsOf(escCfg), attackStrengthRatio: 1.2,
      intelTtlMs: 6 * HOUR } }).out.intents.find((i) => i.type === "LAUNCH");
    assert.strictEqual(lv.mobilize.length, 2, JSON.stringify(lv));
    assert.ok(Number.isSafeInteger(lv.mobilize[0].escalationLevel), JSON.stringify(lv.mobilize[0]));
    assert.strictEqual(lv.mobilize[1].escalationLevel, lv.mobilize[0].escalationLevel);
    const none = gaRun({ escort: { ...ESCORT, maxJumps: 0 } });
    assert.deepStrictEqual(none.out.notes.filter((n) => n.startsWith("CAPITAL_ESCORT")), ["CAPITAL_ESCORT_NONE"]);
    const one = gaRun({ escort: ESCORT, mobSlots: 1 });
    assert.deepStrictEqual(one.out, gaRun({ mobSlots: 1 }).out);
    assert.strictEqual(one.out.intents.find((i) => i.type === "LAUNCH").mobilize.length, 1);

    const d = cfgOf({});
    const S = d.config.strategy;
    assert.deepStrictEqual([S.capitalPreferStationEnabled, S.capitalEscortEnabled, S.capitalEscortMaxJumps],
      [false, false, 8]);
    assert.strictEqual(capitalEscortParamsOf(d.config), null);
    assert.strictEqual(capitalEscortParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ESCORT_ENABLED: "1" }).config), null);
    assert.ok(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ESCORT_ENABLED: "1" }).warnings
      .some((w) => w.startsWith("strategy.capitalEscortEnabled without")));
    assert.strictEqual(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ESCORT_MAX_JUMPS: "99" }).config.strategy.capitalEscortMaxJumps,
      20);
    const flags = { EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1" };
    const on = cfgOf({ ...flags, EVEJS_LNE_STRATEGY_CAPITAL_PREFER_STATION_ENABLED: "1",
      EVEJS_LNE_STRATEGY_CAPITAL_ESCORT_ENABLED: "1" }).config;
    assert.deepStrictEqual(rowBoundsOfConfig(on), rowBoundsOfConfig(cfgOf(flags).config));
  });
};
