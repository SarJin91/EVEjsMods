"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planGarrisonReinforce } = require("../../lib/strategy/ai/garrison");
const { escalationLevelOf, templateLadderOf } = require("../../lib/strategy/ai/escalation");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { escalationParamsOf, capitalLevelParamsOf } = require("../../lib/strategy/reviewService");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const H = 9;
const HOME = 20;
const POWER = buildPowerTable(expandStrengthGroups(GROUPS));
const GARRISON = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);
const INVASION = Object.freeze([{ hullGroup: "cruiser", count: 6 }, { hullGroup: "battlecruiser", count: 3 }]);
const INVASION_BS = Object.freeze([{ hullGroup: "battlecruiser", count: 3 }, { hullGroup: "battleship", count: 3 }]);
const PROD = Object.freeze({ mobilizeHulls: "required", miningNeedsHulls: false, hullGroups: [...HULL_GROUPS] });

const cfgOf = (env) => resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR }).config;
const CFG = cfgOf({ EVEJS_LNE_STRATEGY_ESCALATION_ENABLED: "1" });
const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const ON = Object.freeze({ maxPerReview: 1, escalation: true });
const OFF = Object.freeze({ maxPerReview: 1 });
const BASE_PARAMS = Object.freeze({ maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, kinds: kinds.list, powerTable: POWER,
  attackWindowMs: 2 * HOUR, reconWindowMs: HOUR / 2, operationGraceMs: HOUR, production: PROD, garrison: ON,
  capitalAttach: null, escalation: escalationParamsOf(CFG), capitalLevel: capitalLevelParamsOf(CFG) });
const DOCTRINE = Object.freeze({ doctrineId: "ga", canOccupy: true, reachJumps: 30,
  operationTypes: ["recon", "raid", "reinforce"],
  templates: { scout: [{ hullGroup: "frigate", count: 1 }], garrison: GARRISON, invasion: INVASION },
  stockTemplates: { scout: [{ hullGroup: "frigate", count: 1 }], garrison: GARRISON, invasion: INVASION_BS } });
const mobsOf = (out) => out.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
const shapeOf = (c) => c.map((e) => [e.hullGroup, e.count]);

function gaRun(o = {}) {
  const post = o.post === undefined ? HOME : o.post;
  const row = (systemId, c) => ({ systemId, controllerFactionId: c, occupationState: "STABLE", controllerGarrison: 0,
    hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: HOME, doctrineId: "ga", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: DOCTRINE, theatre: [14], expansion: [], neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40),
    regionOf: () => null, isHostile: (x) => x === H, stationsMode: "ready", stations: [{ systemId: 21, stationId: "st21" }],
    systems: [row(14, H), row(post, F), row(21, F)], fleets: o.fleets || [], fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: [], sightings: [],
    territory: [{ systemId: post, detachedSinceAt: null }], territoryTruncated: false,
    production: { mode: "ready", recipesVersion: 1, recipes: {}, inProduction: {}, activeJobsTotal: 0, truncated: false,
      stations: [{ kind: "npc", lines: 1, activeJobs: [], minerals: {}, stationId: "st21", systemId: 21,
        hulls: o.hulls || { cruiser: 10, battlecruiser: 6, battleship: 3 } }] } };
  const P = { ...BASE_PARAMS, ...(o.params || {}) };
  const ledger = createHullLedger(s, P);
  const out = planGarrisonReinforce({ snapshot: s, supply: { stationSystems: [21] }, params: P, ledger,
    slots: { operations: 2, mobilizations: 3 }, budget: { resourceUnits: 1e6, reserveUnits: 1e6 } });
  return { out, mobs: mobsOf(out) };
}

const standing = (strength) => [{ fleetId: "g1", fleetRole: "garrison", state: "IDLE", operationId: null,
  systemId: HOME, strength, version: 1 }];

module.exports = ({ test }) => {
  test("GE1 HQ post (level 2) with battleships in the station: composition of invasion/stockTemplates, role garrison, "
    + "escalation 2, escalationLevel 2, note ESCALATION_L2; the fleet keeps the post not weak", () => {
    assert.deepStrictEqual(templateLadderOf(DOCTRINE, "garrison", POWER).map((x) => x.template),
      [GARRISON, INVASION, INVASION_BS], "the duplicate garrison/stockTemplates step drops out");
    const { out, mobs } = gaRun();
    assert.strictEqual(mobs.length, 1, JSON.stringify(out));
    const m = mobs[0];
    assert.deepStrictEqual(shapeOf(m.composition), shapeOf(INVASION_BS));
    assert.strictEqual(m.role, "garrison");
    assert.strictEqual(m.escalation, 2);
    assert.strictEqual(m.escalationLevel, 2);
    assert.ok(!Object.hasOwn(m, "escalationFallback"));
    assert.deepStrictEqual(m.cost, { resourceUnits: 60, reserveUnits: 6 }, "the cost of the step (6 ships)");
    assert.ok(m.hulls.some((h) => h.itemKey === "group:battleship" && h.count === 3), JSON.stringify(m.hulls));
    assert.deepStrictEqual(out.notes, ["ESCALATION_L2", "GARRISON_REINFORCE:20"]);
    const heavy = gaRun({ fleets: standing(strengthOf(INVASION_BS, POWER)) });
    assert.deepStrictEqual(heavy.out.intents, []);
    const based = gaRun({ fleets: standing(strengthOf(GARRISON, POWER)) });
    assert.deepStrictEqual(based.out.intents, [], "the weak threshold stays the base template");
  });

  test("GE2 no battleships nor the invasion hulls: base template, escalationFallback, no ledger note of a higher "
    + "step", () => {
    const { out, mobs } = gaRun({ hulls: { cruiser: 4, battlecruiser: 2 } });
    assert.strictEqual(mobs.length, 1, JSON.stringify(out));
    const m = mobs[0];
    assert.deepStrictEqual(shapeOf(m.composition), shapeOf(GARRISON));
    assert.strictEqual(m.role, "garrison");
    assert.strictEqual(m.escalationFallback, true);
    assert.strictEqual(m.escalationLevel, 2);
    assert.ok(!Object.hasOwn(m, "escalation"));
    assert.deepStrictEqual(out.notes, ["ESCALATION_FALLBACK", "GARRISON_REINFORCE:20"]);
    const mid = gaRun({ hulls: { cruiser: 10, battlecruiser: 6 } });
    assert.deepStrictEqual(shapeOf(mid.mobs[0].composition), shapeOf(INVASION));
    assert.deepStrictEqual([mid.mobs[0].escalation, mid.mobs[0].escalationFallback], [1, true]);
  });

  test("GE3 flag off = the planner without the key (byte for byte); calm post (level 0) on = off + escalationLevel 0; "
    + "config default off", () => {
    assert.strictEqual(cfgOf({}).strategy.garrisonEscalationEnabled, false);
    assert.strictEqual(CFG.strategy.garrisonEscalationEnabled, false);
    const off = gaRun({ params: { garrison: OFF } }).out;
    assert.deepStrictEqual(off, gaRun({ params: { garrison: { ...OFF, escalation: false } } }).out);
    assert.deepStrictEqual(off, gaRun({ params: { garrison: ON, escalation: null } }).out, "escalation off");
    assert.deepStrictEqual(shapeOf(mobsOf(off)[0].composition), shapeOf(GARRISON));
    assert.ok(!Object.hasOwn(mobsOf(off)[0], "escalationLevel"));
    const calmOff = gaRun({ post: 23, params: { garrison: OFF } }).out;
    const calmOn = gaRun({ post: 23 }).out;
    const m = mobsOf(calmOn)[0];
    assert.strictEqual(m.escalationLevel, 0);
    const { escalationLevel, ...rest } = m;
    assert.deepStrictEqual(rest, mobsOf(calmOff)[0]);
    const strip = (o) => ({ ...o, intents: o.intents.map((i) => ({ ...i, mobilize: i.mobilize.map((x) => {
      const { escalationLevel: _l, ...r } = x;
      return r;
    }) })) });
    assert.deepStrictEqual(strip(calmOn), calmOff);
  });

  test("GE4 the recommended.env L1/L2/L3 = 1/3/5 (valueBonus 1): weak target 1, weak + hostile station 2 "
    + "3x base 2, 3x base + hostile station 3; the live 2/4/6 give 0/1/1/2", () => {
    const rec = { fleetsL1: 1, fleetsL2: 3, fleetsL3: 5, valueBonus: 1, lossStep: 2, maxLevel: 3 };
    const live = { ...rec, fleetsL1: 2, fleetsL2: 4, fleetsL3: 6 };
    const at = (p, required, hostileStations) => escalationLevelOf({ required, baseStrength: 100, category: null,
      hostileStations, playerSystem: false, losses: 0 }, p).level;
    assert.deepStrictEqual([at(rec, 50, 0), at(rec, 50, 1), at(rec, 300, 0), at(rec, 300, 1)], [1, 2, 2, 3]);
    assert.deepStrictEqual([at(live, 50, 0), at(live, 50, 1), at(live, 300, 0), at(live, 300, 1)], [0, 1, 1, 2]);
    assert.deepStrictEqual([CFG.strategy.escalationFleetsL1, CFG.strategy.escalationFleetsL2,
      CFG.strategy.escalationFleetsL3], [2, 4, 6], "the code defaults stay");
  });
};
