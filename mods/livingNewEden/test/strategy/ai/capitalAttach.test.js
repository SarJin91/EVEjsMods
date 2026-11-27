"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { chooseNextOperation } = require("../../../lib/strategy/ai/operations");
const { planGarrisonReinforce } = require("../../../lib/strategy/ai/garrison");
const { planHunts } = require("../../../lib/strategy/ai/hunt");
const { planMerges } = require("../../../lib/strategy/ai/merge");
const { planHiveBrood } = require("../../../lib/strategy/ai/hive");
const { createHullLedger, paidOf } = require("../../../lib/strategy/ai/hulls");
const { fitIskOf } = require("../../../lib/strategy/ai/warChest");
const { CAPITAL_ATTACH_ROLES_ALLOWED, parseCapitalClassList, planCapitalAttach } =
  require("../../../lib/strategy/ai/capitalAttach");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { expandStrengthGroups } = require("../../../lib/battle/strength");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { hullDeltas } = require("../../../lib/stations/stockKeys");
const { createRng } = require("../../../lib/util/rng");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { HULL_GROUPS, CAPITAL_HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } =
  require("../../../lib/fleets/schema");
const { EXCLUDED_HULL_GROUPS } = require("../../../lib/strategy/expeditions/data/expeditionRules");
const { buildTradeCatalog } = require("../../../lib/economy/trade/tradeCatalog");
const HULL_TRADE_TYPES_DATA = require("../../../lib/economy/data/hullTradeTypes");
const HULL_RECIPES_DATA = require("../../../lib/economy/data/hullRecipes");
const wrecks = require("../../../lib/events/salvage/data");
const { capitalAttachParamsOf, fleetCompositionOf } = require("../../../lib/strategy/reviewService");
const { resolveConfig } = require("../../../config");
const { createManualClock } = require("../../../lib/util/clock");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: SH } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const H = 9;
const TITAN = 11001;
const DREAD = 11002;
const CLASSES = Object.freeze({ titan: TITAN, dreadnought: DREAD });
const VALUES = Object.freeze({ cruiser: 1000, frigate: 500, battlecruiser: 2000, tackle: 400, titan: 100000,
  dreadnought: 50000 });
const PERMILLE = 100;
const WAR = Object.freeze({ valueByGroup: VALUES, fitPermille: PERMILLE, captureIsk: 0 });
const POWER = buildPowerTable(expandStrengthGroups(GROUPS));
const PATROL = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const fit = (c) => fitIskOf(c, VALUES, PERMILLE);
const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();

const cfgOf = (env) => resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
const ATTACH = capitalAttachParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1" }).config);
const PROD = Object.freeze({ mobilizeHulls: "required", miningNeedsHulls: false, hullGroups: [...HULL_GROUPS] });
const prodOf = (stations) => ({ mode: "ready", recipesVersion: 1, recipes: {}, inProduction: {}, activeJobsTotal: 0,
  truncated: false, stations: stations.map((s) => ({ kind: "npc", lines: 1, activeJobs: [], minerals: {}, ...s })) });
const hullsOfComp = (comp) => hullDeltas(paidOf(comp, []).map((e) => ({ hullGroup: e.hullGroup, count: e.count })), -1)
  .deltas.map((d) => ({ itemKey: d.itemKey, count: -d.delta }));
const mobsOf = (out) => out.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));

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
  const templates = { patrol: o.patrol || PATROL, scout: [{ hullGroup: "frigate", count: 1 }] };
  const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: 40, frontLimit: 1 }, entry: { homeRegionIds: [] },
    doctrine: { doctrineId: "ca", canOccupy: false, captureTargets: [], operationTypes: ["recon", "raid"], templates },
    theatre: [T], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === H, stations: [{ systemId: 5, stationId: "st5" }],
    systems: [{ systemId: T, controllerFactionId: H, occupationState: "STABLE", controllerGarrison: 0,
      hostileStations: 0, observed: false }], fleets: [], operations: [], operationsTruncated: false,
    intel: o.noIntel ? [] : [{ systemId: T, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
      hostileStrength: 0, hostileStations: 0, controllerFactionId: H }], sightings: [],
    production: prodOf([{ stationId: "st5", systemId: 5, hulls: o.stock }]),
    ...(o.classes === undefined ? { capitalClasses: CLASSES } : o.classes === null ? {} : { capitalClasses: o.classes }) };
  const war = o.isk !== undefined ? WAR : null;
  const supply = { frontTargets: [], frontLimit: 1, anchors: [40], stationSystems: [5],
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6, ...(war ? { isk: o.isk } : {}) }, reach: new Map([[T, 1]]),
    captureReach: new Map(), captureRoom: null, border: new Map(), ...(war ? { war } : {}) };
  const P = { ...OP_PARAMS, capitalAttach: o.attach === undefined ? null : o.attach,
    ...(o.escalation ? { escalation: o.escalation } : {}) };
  const ledger = createHullLedger(s, P);
  const out = chooseNextOperation(s, supply, P, createRng(1), ledger);
  return { out, ledger, mobs: mobsOf(out) };
}

const GARRISON = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);
const GA_PARAMS = Object.freeze({ ...OP_PARAMS, maxAssemblyJumps: 8, maxOperationsPerReview: 2,
  maxMobilizationsPerReview: 3, garrison: { maxPerReview: 1 } });
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
    theatre: [14], expansion: [], neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40),
    regionOf: () => null, isHostile: (x) => x === H, stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(14, H), ...posts.map((id) => row(id, F)), row(20, F)], fleets: [], fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: [], sightings: [],
    territory: posts.map((systemId) => ({ systemId, detachedSinceAt: null })), territoryTruncated: false,
    production: prodOf([{ stationId: "st20", systemId: 20, hulls: o.stock }]), capitalClasses: CLASSES };
  const P = { ...GA_PARAMS, capitalAttach: o.attach === undefined ? null : o.attach };
  const ledger = createHullLedger(s, P);
  const out = planGarrisonReinforce({ snapshot: s, supply: { stationSystems: [20], war: WAR }, params: P, ledger,
    slots: { operations: 2, mobilizations: 3 }, budget: { resourceUnits: 1e6, reserveUnits: 1e6, isk: 1e9 } });
  return { out, ledger };
}

const S1 = 30000001;
const S2 = 30000002;
const HUNTER = Object.freeze([{ hullGroup: "tackle", count: 2 }, { hullGroup: "frigate", count: 2 }]);
function huRun(o = {}) {
  const s = { at: AT, factionId: F, huntReady: true, fleetsTruncated: false,
    faction: { status: "ACTIVE", homeSystemId: S1, doctrineId: "h", resourceUnits: 100, reserveUnits: 100, frontLimit: 2,
      version: 3 },
    doctrine: { doctrineId: "h", fieldsHunters: true, hunterTemplate: HUNTER, hunterComposition: [] }, fleets: [],
    stations: [{ systemId: S2, stationId: "st-b", kind: "npc" }, { systemId: S1, stationId: "st-a", kind: "npc" }],
    systems: [S1, S2].map((id) => ({ systemId: id, controllerFactionId: F })),
    neighbors: (id) => (id === S1 ? [S2] : id === S2 ? [S1] : []),
    production: prodOf([{ stationId: "st-a", systemId: S1, hulls: o.stock }]), capitalClasses: o.classes || CLASSES };
  const P = { hunt: { enabled: true, maxHuntersPerFaction: 2, strikeMaxJumps: 5, dwellMs: 300000, maxBfsSystems: 500 },
    mobilizeResourcePerShip: 3, mobilizeReservePerShip: 1, capitalAttach: o.attach === undefined ? null : o.attach,
    production: { ...PROD, mobilizeHulls: o.legacy ? "legacy" : "required" } };
  const ledger = createHullLedger(s, P);
  const out = planHunts({ snapshot: s, params: P, budget: { resourceUnits: 100, reserveUnits: 100, isk: 1e9 },
    ledger, war: WAR });
  return { out, ledger };
}

module.exports = ({ test, skip }) => {
  test("CA1 off: capitalAttach null = the intents and notes of today (operations, garrison) with a titan in the "
    + "station; config defaults (flag off, 4 keys) and capitalAttachParamsOf null", () => {
    const stockT = { cruiser: 2, frigate: 1, titan: 1 };
    const stock0 = { cruiser: 2, frigate: 1 };
    assert.deepStrictEqual(opRun({ stock: stockT }).out, opRun({ stock: stock0 }).out);
    assert.deepStrictEqual(opRun({ stock: stockT, isk: 1e9 }).out, opRun({ stock: stock0, isk: 1e9 }).out);
    assert.deepStrictEqual(gaRun({ stock: { cruiser: 4, battlecruiser: 2, titan: 1 } }).out,
      gaRun({ stock: { cruiser: 4, battlecruiser: 2 } }).out);
    const d = cfgOf({});
    const S = d.config.strategy;
    assert.deepStrictEqual([S.capitalAttachEnabled, S.capitalAttachRoles, S.capitalAttachOrder, S.capitalAttachMax],
      [false, "invasion,garrison,patrol,hunter", "titan,supercarrier,dreadnought,carrier,force_auxiliary", 1]);
    assert.strictEqual(capitalAttachParamsOf(d.config), null);
    assert.ok(!d.warnings.some((w) => w.includes("capitalAttach")), JSON.stringify(d.warnings));
    assert.deepStrictEqual({ ...ATTACH, roles: [...ATTACH.roles], order: [...ATTACH.order], freeGroups: [] },
      { roles: [...CAPITAL_ATTACH_ROLES_ALLOWED], order: ["titan", "supercarrier", "dreadnought", "carrier",
        "force_auxiliary"], max: 1, maxGroups: 18, maxEntries: 32, maxShips: 500, freeGroups: [],
      preferStation: false });
    const on = cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1" });
    assert.strictEqual(on.warnings.filter((w) => w.startsWith("strategy.capitalAttachEnabled with")).length, 3);
    const bad = cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ROLES: "invasion,scout",
      EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ORDER: "titan,cruiser", EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_MAX: "9" }).config;
    assert.deepStrictEqual([bad.strategy.capitalAttachRoles, bad.strategy.capitalAttachOrder,
      bad.strategy.capitalAttachMax], ["invasion,garrison,patrol,hunter",
      "titan,supercarrier,dreadnought,carrier,force_auxiliary", 3]);
    assert.deepStrictEqual([parseCapitalClassList("none", CAPITAL_HULL_GROUPS),
      parseCapitalClassList(" titan , carrier", CAPITAL_HULL_GROUPS), parseCapitalClassList("titan,titan",
        CAPITAL_HULL_GROUPS), parseCapitalClassList("cruiser", CAPITAL_HULL_GROUPS)],
    [[], ["titan", "carrier"], null, null]);
  });

  test("CA2 on (patrol mobilization of a raid): template + titan (typeId of capitalClasses), hulls = hullDeltas "
    + "order, titan taken from the ledger, dreadnought left, warIsk = fit + titan fit, strength with the titan; max 3 "
    + "with a 17-group template -> exactly 1 capital", () => {
    const r = opRun({ stock: { cruiser: 2, titan: 1, dreadnought: 1 }, attach: ATTACH, isk: 1e9 });
    assert.strictEqual(r.mobs.length, 1, JSON.stringify(r.out));
    const m = r.mobs[0];
    const comp = [{ hullGroup: "cruiser", typeId: null, count: 2 }, { hullGroup: "titan", typeId: TITAN, count: 1 }];
    assert.deepStrictEqual([m.role, m.stationId, m.composition, m.hulls], ["patrol", "st5", comp, hullsOfComp(comp)]);
    assert.deepStrictEqual([r.ledger.available("st5", "titan"), r.ledger.available("st5", "dreadnought")], [0, 1]);
    assert.strictEqual(m.warIsk, fit(PATROL) + fit([{ hullGroup: "titan", count: 1 }]));
    assert.ok(fit([{ hullGroup: "titan", count: 1 }]) > 0);
    assert.deepStrictEqual(r.out.notes.filter((n) => n.startsWith("CAPITAL_")), []);
    const big = opRun({ stock: { cruiser: 2, titan: 1, dreadnought: 1 }, attach: ATTACH });
    assert.ok(strengthOf(comp, POWER) > strengthOf(PATROL.map((e) => ({ ...e, typeId: null })), POWER));
    assert.deepStrictEqual(big.mobs[0].composition, comp);

    const groups = HULL_GROUPS.filter((g) => !CAPITAL_HULL_GROUPS.includes(g) && g !== "capital").slice(0, 17);
    assert.strictEqual(groups.length, 17);
    const wide = groups.map((g) => ({ hullGroup: g, count: 1 }));
    const stock = Object.fromEntries([...groups.map((g) => [g, 1]), ["titan", 1], ["dreadnought", 1], ["frigate", 1]]);
    const w = opRun({ patrol: wide, stock, attach: { ...ATTACH, max: 3 } });
    const caps = w.mobs[0].composition.filter((e) => CAPITAL_HULL_GROUPS.includes(e.hullGroup));
    assert.deepStrictEqual(caps, [{ hullGroup: "titan", typeId: TITAN, count: 1 }], "18 groups at most");
    assert.deepStrictEqual(w.mobs[0].hulls, hullsOfComp(w.mobs[0].composition));
  });

  test("CA3 ISK: war room = template fit + 1 -> the mobilization of today, CAPITAL_SKIPPED_ISK once, no "
    + "WAR_CHEST_SHORT", () => {
    const isk = fit(PATROL) + 1;
    const stock = { cruiser: 2, titan: 1 };
    const on = opRun({ stock, attach: ATTACH, isk });
    const off = opRun({ stock, isk });
    assert.deepStrictEqual(on.out.intents, off.out.intents);
    assert.deepStrictEqual(on.out.notes.filter((n) => n !== "CAPITAL_SKIPPED_ISK"), off.out.notes);
    assert.strictEqual(on.out.notes.filter((n) => n === "CAPITAL_SKIPPED_ISK").length, 1);
    assert.ok(!on.out.notes.includes("WAR_CHEST_SHORT"), JSON.stringify(on.out.notes));
    assert.strictEqual(on.ledger.available("st5", "titan"), 1, "nothing taken");
  });

  test("CA4 roles / stock: scout (recon) without a capital and note; patrol with it; no capital in the station "
    + "-> CAPITAL_NOT_AT_STATION; a faction without classes -> no note", () => {
    const stock = { cruiser: 2, frigate: 1, titan: 1 };
    const scout = opRun({ stock, attach: ATTACH, noIntel: true });
    assert.deepStrictEqual(scout.out, opRun({ stock, noIntel: true }).out);
    assert.strictEqual(scout.mobs[0].role, "scout");
    assert.strictEqual(scout.ledger.available("st5", "titan"), 1);
    const patrol = opRun({ stock, attach: ATTACH });
    assert.ok(patrol.mobs[0].composition.some((e) => e.hullGroup === "titan"));
    const none = opRun({ stock: { cruiser: 2 }, attach: ATTACH });
    assert.deepStrictEqual(none.out.intents, opRun({ stock: { cruiser: 2 } }).out.intents);
    assert.deepStrictEqual(none.out.notes.filter((n) => n.startsWith("CAPITAL_")), ["CAPITAL_NOT_AT_STATION"]);
    for (const classes of [{}, null]) {
      const noClass = opRun({ stock, attach: ATTACH, classes });
      assert.deepStrictEqual(noClass.out, opRun({ stock, classes }).out, JSON.stringify(classes));
    }
    const lg = { available: () => 1 };
    const base = { template: PATROL, stationId: "st5", lg, capitalClasses: CLASSES, iskLeft: null, war: null };
    assert.deepStrictEqual([planCapitalAttach({ ...base, role: "scout", attach: ATTACH }).eligible,
      planCapitalAttach({ ...base, role: "patrol", attach: { ...ATTACH, max: 0 } }).eligible,
      planCapitalAttach({ ...base, role: "patrol", attach: ATTACH }).entries.length,
      planCapitalAttach({ ...base, role: "patrol", attach: ATTACH, capitalClasses: { titan: 0, dreadnought: null } })
        .eligible], [false, false, 1, false]);
  });

  test("CA5 garrison: planGarrisonReinforce on -> MOBILIZE of the LAUNCH garrison with the titan, out.cost.isk "
    + "= fit + titan fit", () => {
    const r = gaRun({ stock: { cruiser: 4, battlecruiser: 2, titan: 1 }, attach: ATTACH });
    const l = r.out.intents.find((i) => i.type === "LAUNCH" && i.kind === "garrison");
    assert.ok(l, JSON.stringify(r.out));
    const m = l.mobilize[0];
    const comp = [...GARRISON.map((e) => ({ ...e, typeId: null })), { hullGroup: "titan", typeId: TITAN, count: 1 }];
    const iskAll = fit(GARRISON) + fit([{ hullGroup: "titan", count: 1 }]);
    assert.deepStrictEqual([m.composition, m.hulls, m.warIsk, r.out.cost.isk], [comp, hullsOfComp(comp), iskAll, iskAll]);
    assert.strictEqual(r.ledger.available("st20", "titan"), 0);
  });

  test("CA6 effect: mobilizeInTx gives createFleet a typeId only for a positive safe integer (other entries = "
    + "the input of today); capitalAttached / capitalAttachSkipped are review counters", () => {
    const mob = { composition: [{ hullGroup: "cruiser", typeId: null, count: 2 },
      { hullGroup: "titan", typeId: TITAN, count: 1 }, { hullGroup: "frigate", typeId: 0, count: 1 }] };
    const out = fleetCompositionOf(mob);
    assert.deepStrictEqual(out, [{ hullGroup: "cruiser", count: 2 }, { hullGroup: "titan", typeId: TITAN, count: 1 },
      { hullGroup: "frigate", count: 1 }]);
    assert.ok(!Object.hasOwn(out[0], "typeId") && !Object.hasOwn(out[2], "typeId"));
    const src = fs.readFileSync(path.join(MOD_DIR, "lib", "strategy", "reviewService.js"), "utf8");
    const body = src.slice(src.indexOf("function mobilizeInTx("), src.indexOf("function takeHullsInTx("));
    assert.ok(body.includes("composition: fleetCompositionOf(mob)"), "mobilizeInTx maps through fleetCompositionOf");
    const names = src.slice(src.indexOf("const COUNTER_NAMES"), src.indexOf("]);", src.indexOf("const COUNTER_NAMES")));
    assert.ok(names.includes("\"capitalAttached\", \"capitalAttachSkipped\""));
    assert.ok(src.includes("bump(\"capitalAttached\", summary.capitalAttached)")
      && src.includes("bump(\"capitalAttachSkipped\", summary.capitalAttachSkipped)"));
  });

  test("CA7 MERGE guard + wrecks", () => {
    const fl = (fleetId, composition) => ({ fleetId, version: 1, state: "IDLE", operationId: null, refitPending: false,
      fleetRole: "garrison", systemId: 5, shipCount: composition.reduce((s, e) => s + e.count, 0), composition });
    const P = (capital) => ({ merge: { roles: ["garrison"], maxPerReview: 4, maxShipsPerFleet: 500,
      capital: capital ? { maxGroups: 18, classes: CAPITAL_HULL_GROUPS } : null } });
    const pair = (a, b, capital) => planMerges({ fleets: [a, b] }, P(capital), new Set()).intents
      .map((i) => [i.keeper.fleetId, i.absorbed.fleetId]);
    const titanFleet = fl("b", [{ hullGroup: "cruiser", count: 1 }, { hullGroup: "titan", typeId: TITAN, count: 1 }]);
    const big = fl("a", [{ hullGroup: "cruiser", typeId: null, count: 6 }]);
    assert.deepStrictEqual(pair(big, titanFleet, true), [], "a fleet with a titan is never absorbed");
    assert.deepStrictEqual(pair(big, titanFleet, false), [["a", "b"]], "off = as today");
    const keeperT = fl("a", [{ hullGroup: "cruiser", count: 5 }, { hullGroup: "titan", typeId: TITAN, count: 1 }]);
    assert.deepStrictEqual(pair(keeperT, fl("b", [{ hullGroup: "frigate", count: 2 }]), true), [["a", "b"]]);
    const nonCap = HULL_GROUPS.filter((g) => !CAPITAL_HULL_GROUPS.includes(g));
    const groupsOf = (a, b) => new Set([...a.composition, ...b.composition].map((e) => e.hullGroup)).size;
    const wide = fl("a", nonCap.slice(0, 11).map((g) => ({ hullGroup: g, count: 2 })));
    const seven = fl("b", nonCap.slice(11, 18).map((g) => ({ hullGroup: g, count: 1 })));
    assert.strictEqual(groupsOf(wide, seven), 18);
    assert.deepStrictEqual(pair(wide, seven, true), [["a", "b"]], "18 groups merge");
    const wideT = fl("a", [...nonCap.slice(0, 12).map((g) => ({ hullGroup: g, count: 2 })),
      { hullGroup: "titan", typeId: TITAN, count: 1 }]);
    const six = fl("b", nonCap.slice(12, 18).map((g) => ({ hullGroup: g, count: 1 })));
    assert.strictEqual(groupsOf(wideT, six), 19);
    assert.deepStrictEqual([pair(wideT, six, true), pair(wideT, six, false)], [[], [["a", "b"]]],
      "19 groups -> refused with the guard, merged without it");

    const names = wrecks.fallbackWreckNamesOf("titan", 500012);
    const blood = names.indexOf("Blood Dreadnought Wreck");
    assert.ok(blood >= 0 && blood < names.indexOf("Blood Large Wreck"), JSON.stringify(names));
    for (const cls of CAPITAL_HULL_GROUPS) {
      assert.ok(wrecks.fallbackWreckNamesOf(cls, 500019).includes("Sansha Dreadnought Wreck"), cls);
    }
    assert.strictEqual(wrecks.allFallbackWreckNames().length, 68, "the start set as SA-WN (GOLDEN)");
  });

  test("CA8 hunters: ledger branch -> hunter MOBILIZE with the dreadnought (never the titan) "
    + "cost.isk = warIsk = fit + capital fit; off = today; legacy branch and a role list without hunter -> no capital, "
    + "no note", () => {
    const stockT = { tackle: 2, frigate: 2, titan: 1, dreadnought: 1 };
    const r = huRun({ stock: stockT, attach: ATTACH });
    const m = r.out.intents.find((i) => i.type === "MOBILIZE");
    const comp = [...HUNTER.map((e) => ({ ...e, typeId: null })), { hullGroup: "dreadnought", typeId: DREAD, count: 1 }];
    const iskAll = fit(HUNTER) + fit([{ hullGroup: "dreadnought", count: 1 }]);
    assert.deepStrictEqual([m.role, m.stationId, m.composition, m.hulls, m.warIsk, r.out.cost.isk],
      ["hunter", "st-a", comp, hullsOfComp(comp), iskAll, iskAll]);
    assert.deepStrictEqual([r.ledger.available("st-a", "dreadnought"), r.ledger.available("st-a", "titan")], [0, 1]);
    const titanOnly = huRun({ stock: stockT, attach: ATTACH, classes: { titan: TITAN } });
    const t = titanOnly.out.intents.find((i) => i.type === "MOBILIZE");
    assert.deepStrictEqual([t.capitalGated, titanOnly.out.notes.includes("CAPITAL_LEVEL_GATED"),
      titanOnly.ledger.available("st-a", "titan")], [true, true, 1]);
    assert.deepStrictEqual(huRun({ stock: stockT }).out, huRun({ stock: { tackle: 2, frigate: 2 } }).out);
    assert.deepStrictEqual(huRun({ stock: stockT, attach: ATTACH, legacy: true }).out,
      huRun({ stock: stockT, legacy: true }).out, "legacy branch");
    assert.deepStrictEqual(huRun({ stock: stockT, attach: { ...ATTACH, roles: ["invasion"] } }).out,
      huRun({ stock: stockT }).out, "hunter not listed");
    assert.deepStrictEqual(huRun({ stock: { tackle: 2, frigate: 2 }, attach: ATTACH }).out.notes,
      ["CAPITAL_NOT_AT_STATION"]);
  });

  test("CA9 exclusions: the hive brood never takes a capital, expeditions exclude every capital class "
    + "the trade catalog has no capital group", () => {
    const hive = (attach) => planHiveBrood({ snapshot: { factionId: F, faction: { status: "ACTIVE" },
      doctrine: { hive: true, templates: { patrol: [{ hullGroup: "frigate", count: 2 }] } },
      upkeep: { mode: "ready", controlledCount: 10 }, hive: { homeSystems: 10 }, fleets: [], operations: [],
      footholds: [{ systemId: 100 }, { systemId: 101 }], capitalClasses: CLASSES },
    params: { hive: { maxFleets: 5, fleetsPerNode: 1 }, maxFleetsPerFaction: 12, mobilizeResourcePerShip: 1,
      mobilizeReservePerShip: 1, capitalAttach: attach }, slots: { mobilizations: 3 },
    budget: { resourceUnits: 1e6, reserveUnits: 1e6 }, mobilized: 0 });
    const on = hive(ATTACH);
    assert.ok(on.intents.length > 0, JSON.stringify(on));
    assert.deepStrictEqual(on, hive(null));
    for (const cls of CAPITAL_HULL_GROUPS) assert.ok(EXCLUDED_HULL_GROUPS.includes(cls), cls);
    const cat = buildTradeCatalog({ hullTypes: HULL_TRADE_TYPES_DATA, hullRecipes: HULL_RECIPES_DATA,
      hullOffersEnabled: true });
    const hullEntries = cat.entries.filter((e) => e.itemKind === "hull");
    assert.ok(hullEntries.length > 0 && Object.keys(cat.hullsFor(500001)).length > 0, "hulls in the catalog");
    assert.deepStrictEqual(hullEntries.filter((e) => CAPITAL_HULL_GROUPS.includes(e.group)), []);
    assert.deepStrictEqual(Object.keys(cat.hullsFor(500001)).filter((g) => CAPITAL_HULL_GROUPS.includes(g)), []);
  });

  const ESC_ON = { EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1", EVEJS_LNE_STRATEGY_ESCALATION_ENABLED: "1" };
  const ATTACH_ESC = capitalAttachParamsOf(cfgOf(ESC_ON).config);
  const MIN_LEVEL = { carrier: 2, dreadnought: 2, force_auxiliary: 2, supercarrier: 3, titan: 3 };
  const GATED = { entries: [], items: [], fitIsk: 0, note: "CAPITAL_LEVEL_GATED", eligible: false, gated: true };
  const escAt = (maxLevel) => ({ fleetsL1: 1, fleetsL2: 1, fleetsL3: 1, valueBonus: 0, lossStep: 0, maxLevel });

  test("CL1 off: no minLevelOf (escalationEnabled false) = the result of today for any level; config defaults "
    + "2 / 3, minLevelOf only with escalationEnabled, warning when supers come before the other capitals", () => {
    const lg1 = { available: () => 1 };
    const base = { template: PATROL, role: "patrol", stationId: "st5", capitalClasses: CLASSES, attach: ATTACH };
    const cases = [
      [{ ...base, lg: lg1, iskLeft: null, war: null }, { entries: [{ hullGroup: "titan", typeId: TITAN, count: 1 }],
        items: [{ itemKey: "group:titan", count: 1 }], fitIsk: 0, note: null, eligible: true }],
      [{ ...base, lg: lg1, iskLeft: 0, war: WAR }, { entries: [], items: [], fitIsk: 0, note: "CAPITAL_SKIPPED_ISK",
        eligible: true }],
      [{ ...base, lg: { available: () => 0 }, iskLeft: null, war: null }, { entries: [], items: [], fitIsk: 0,
        note: "CAPITAL_NOT_AT_STATION", eligible: true }],
    ];
    for (const [input, expected] of cases) {
      for (const level of [undefined, 0, 1, 3]) {
        assert.deepStrictEqual(planCapitalAttach({ ...input, level }), expected, `${expected.note} level ${level}`);
      }
    }
    const S = cfgOf({}).config.strategy;
    assert.deepStrictEqual([S.escalationCapitalMinLevel, S.escalationSuperMinLevel], [2, 3]);
    assert.deepStrictEqual(ATTACH, capitalAttachParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1",
      EVEJS_LNE_STRATEGY_ESCALATION_ENABLED: "0" }).config));
    assert.ok(!Object.hasOwn(ATTACH, "minLevelOf"));
    assert.deepStrictEqual({ ...ATTACH_ESC.minLevelOf }, MIN_LEVEL);
    assert.strictEqual(capitalAttachParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_ESCALATION_ENABLED: "1" }).config), null);
    const stock = { cruiser: 2, titan: 1 };
    const unlevel = (m) => {
      assert.ok(Number.isSafeInteger(m.escalationLevel), JSON.stringify(m));
      const { escalationLevel, ...rest } = m;
      return rest;
    };
    const on = opRun({ stock, attach: ATTACH, escalation: escAt(1) }).out;
    const onToday = { ...on, intents: on.intents.map((i) => (i.type === "MOBILIZE" ? unlevel(i)
      : i.type === "LAUNCH" ? { ...i, mobilize: i.mobilize.map(unlevel) } : i)) };
    assert.deepStrictEqual(onToday, opRun({ stock, attach: ATTACH }).out);
    const warn = (env) => cfgOf(env).warnings.filter((w) => w.startsWith("strategy.escalationSuperMinLevel="));
    assert.deepStrictEqual(warn({}), []);
    assert.strictEqual(warn({ EVEJS_LNE_STRATEGY_ESCALATION_SUPER_MIN_LEVEL: "1" }).length, 1);
    const clamped = cfgOf({ EVEJS_LNE_STRATEGY_ESCALATION_CAPITAL_MIN_LEVEL: "0",
      EVEJS_LNE_STRATEGY_ESCALATION_SUPER_MIN_LEVEL: "9" }).config.strategy;
    assert.deepStrictEqual([clamped.escalationCapitalMinLevel, clamped.escalationSuperMinLevel], [1, 3]);
  });

  test("CL2 gate: level 1 -> gated, note CAPITAL_LEVEL_GATED; chooseNextOperation (no level = 0) -> the "
    + "template of today with capitalGated, the note once, the titan stays in the ledger; no class -> not gated", () => {
    const base = { template: PATROL, role: "patrol", stationId: "st5", lg: { available: () => 1 },
      capitalClasses: CLASSES, attach: ATTACH_ESC, iskLeft: null, war: null };
    assert.deepStrictEqual(planCapitalAttach({ ...base, level: 1 }), GATED);
    assert.deepStrictEqual(planCapitalAttach({ ...base }), GATED, "level absent = 0");
    assert.deepStrictEqual(planCapitalAttach({ ...base, capitalClasses: {} }),
      { entries: [], items: [], fitIsk: 0, note: null, eligible: false });
    const stock = { cruiser: 2, titan: 1 };
    const on = opRun({ stock, attach: ATTACH_ESC });
    const off = opRun({ stock });
    assert.strictEqual(on.mobs.length, 1, JSON.stringify(on.out));
    assert.strictEqual(on.mobs[0].capitalGated, true);
    const strip = (o) => JSON.parse(JSON.stringify(o.out.intents, (k, v) => (k === "capitalGated" ? undefined : v)));
    assert.deepStrictEqual(strip(on), strip(off));
    assert.deepStrictEqual(on.out.notes.filter((n) => n !== "CAPITAL_LEVEL_GATED"), off.out.notes);
    assert.strictEqual(on.out.notes.filter((n) => n === "CAPITAL_LEVEL_GATED").length, 1);
    assert.strictEqual(on.ledger.available("st5", "titan"), 1, "nothing taken");
  });

  test("CL3 tiers: order titan,supercarrier,dreadnought - level 2 -> dreadnought, level 3 -> titan; through "
    + "chooseNextOperation the level of the target (not the ladder step) picks the class", () => {
    const classes = { titan: TITAN, supercarrier: 11003, dreadnought: DREAD };
    const attach = { ...ATTACH_ESC, order: ["titan", "supercarrier", "dreadnought"] };
    const base = { template: PATROL, role: "patrol", stationId: "st5", lg: { available: () => 1 },
      capitalClasses: classes, attach, iskLeft: null, war: null };
    const take = (level) => planCapitalAttach({ ...base, level }).entries.map((e) => e.hullGroup);
    assert.deepStrictEqual([take(2), take(3)], [["dreadnought"], ["titan"]]);
    const stock = { cruiser: 2, titan: 1, dreadnought: 1 };
    const capsAt = (maxLevel) => {
      const r = opRun({ stock, attach: { ...ATTACH_ESC, order: ["titan", "dreadnought"] }, escalation: escAt(maxLevel) });
      assert.strictEqual(r.mobs.length, 1, JSON.stringify(r.out));
      return [r.mobs[0].composition.filter((e) => CAPITAL_HULL_GROUPS.includes(e.hullGroup)).map((e) => e.hullGroup),
        r.mobs[0].capitalGated === true];
    };
    assert.deepStrictEqual([capsAt(1), capsAt(2), capsAt(3)],
      [[[], true], [["dreadnought"], false], [["titan"], false]]);
  });

  const driver = SH.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  needsDriver("CL4 counters on a real store: an applied MOBILIZE with capitalGated counts capitalLevelGated 1 "
    + "never capitalAttachSkipped", () => SH.withStore(driver, async (reopen) => {
    const SANSHA = 500019;
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(43) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, SANSHA])) };
    const state = { base: null, post: null, injected: false };
    const hooks = { beforeEffect: (d) => {
      if (state.injected || d.factionId !== SANSHA || d.outcome !== "REVIEWED" || state.base === null) return d;
      state.injected = true;
      const mob = { type: "MOBILIZE", slot: 0, role: "garrison", systemId: state.base, homeSystemId: state.base,
        composition: [{ hullGroup: "cruiser", typeId: null, count: 2 }], cost: { resourceUnits: 2, reserveUnits: 0 },
        stationId: null, hulls: [], capitalGated: true };
      const launch = { type: "LAUNCH", slot: 1, kind: "garrison", target: { kind: "system", systemId: state.post,
        ref: null }, originSystemId: state.base, fleets: [], mobilize: [mob], dueAt: R.START_MS + R.I * 8 };
      const touch = d.intents.findIndex((i) => i.type === "FACTION_TOUCH");
      const intents = [...d.intents];
      intents.splice(touch < 0 ? intents.length : touch, 0, launch);
      return { ...d, intents };
    } };
    const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0" }, { hooks });
    const base = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", SANSHA)[0];
    assert.ok(base, "a Sansha station");
    state.base = base.system_id;
    state.post = shared.graph.getNeighbors(base.system_id)[0];
    await R.passesAt(e, shared, R.START_MS + R.I);
    assert.ok(state.injected, "a Sansha review ran");
    const c = e.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c.capitalLevelGated, c.capitalAttachSkipped || 0], [1, 0], JSON.stringify(c));
    e.strategy.stop("test");
  }));
};
