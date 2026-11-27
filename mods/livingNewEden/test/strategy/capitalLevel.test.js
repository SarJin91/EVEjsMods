"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { postLevelOf, huntLevelOf } = require("../../lib/strategy/ai/capitalLevel");
const { planGarrisonReinforce } = require("../../lib/strategy/ai/garrison");
const { planHunts } = require("../../lib/strategy/ai/hunt");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { capitalAttachParamsOf, escalationParamsOf, capitalLevelParamsOf } =
  require("../../lib/strategy/reviewService");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const H = 9;
const HOME = 20;
const CARRIER = 11004;
const TITAN = 11001;
const CLASSES = Object.freeze({ titan: TITAN, carrier: CARRIER });
const POWER = buildPowerTable(expandStrengthGroups(GROUPS));
const GARRISON = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);
const HUNTER = Object.freeze([{ hullGroup: "tackle", count: 2 }, { hullGroup: "frigate", count: 2 }]);
const PROD = Object.freeze({ mobilizeHulls: "required", miningNeedsHulls: false, hullGroups: [...HULL_GROUPS] });

const cfgOf = (env) => resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR }).config;
const ESC_ON = { EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1", EVEJS_LNE_STRATEGY_ESCALATION_ENABLED: "1" };
const CFG = cfgOf(ESC_ON);
const ATTACH = capitalAttachParamsOf(CFG);
const ESCALATION = escalationParamsOf(CFG);
const LEVEL = capitalLevelParamsOf(CFG);
const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const BASE_PARAMS = Object.freeze({ maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, kinds: kinds.list, powerTable: POWER,
  attackWindowMs: 2 * HOUR, reconWindowMs: HOUR / 2, operationGraceMs: HOUR, production: PROD,
  garrison: { maxPerReview: 1 }, capitalAttach: ATTACH, escalation: ESCALATION, capitalLevel: LEVEL });
const prodOf = (stations) => ({ mode: "ready", recipesVersion: 1, recipes: {}, inProduction: {}, activeJobsTotal: 0,
  truncated: false, stations: stations.map((s) => ({ kind: "npc", lines: 1, activeJobs: [], minerals: {}, ...s })) });
const mobsOf = (out) => out.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));

function gaRun(o = {}) {
  const post = o.post === undefined ? HOME : o.post;
  const row = (systemId, c) => ({ systemId, controllerFactionId: c, occupationState: "STABLE", controllerGarrison: 0,
    hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: HOME, doctrineId: "ga", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "ga", canOccupy: true, reachJumps: 30, operationTypes: ["recon", "raid", "reinforce"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], garrison: GARRISON } },
    theatre: [14], expansion: [], neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40),
    regionOf: () => null, isHostile: (x) => x === H, stationsMode: "ready", stations: [{ systemId: 21, stationId: "st21" }],
    systems: [row(14, H), row(post, F), row(21, F)], fleets: [], fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: [], sightings: [],
    territory: [{ systemId: post, detachedSinceAt: null }], territoryTruncated: false,
    production: prodOf([{ stationId: "st21", systemId: 21, hulls: { cruiser: 4, battlecruiser: 2, carrier: 1 } }]),
    capitalClasses: CLASSES };
  const P = { ...BASE_PARAMS, ...(o.params || {}) };
  if (o.dropLevel) delete P.capitalLevel;
  const ledger = createHullLedger(s, P);
  const out = planGarrisonReinforce({ snapshot: s, supply: { stationSystems: [21] }, params: P, ledger,
    slots: { operations: 2, mobilizations: 3 }, budget: { resourceUnits: 1e6, reserveUnits: 1e6 } });
  return { out, mobs: mobsOf(out) };
}

const S1 = 30000001;
const S2 = 30000002;
function huRun(o = {}) {
  const s = { at: AT, factionId: F, huntReady: true, fleetsTruncated: false,
    faction: { status: "ACTIVE", homeSystemId: S1, doctrineId: "h", resourceUnits: 100, reserveUnits: 100, frontLimit: 2,
      version: 3 },
    doctrine: { doctrineId: "h", fieldsHunters: true, hunterTemplate: HUNTER, hunterComposition: [] }, fleets: [],
    stations: [{ systemId: S1, stationId: "st-a", kind: "npc" }],
    systems: [S1, S2].map((id) => ({ systemId: id, controllerFactionId: F })),
    neighbors: (id) => (id === S1 ? [S2] : id === S2 ? [S1] : []),
    intel: o.intel || [],
    production: prodOf([{ stationId: "st-a", systemId: S1,
      hulls: { tackle: 2, frigate: 2, carrier: 1, ...(o.hulls || {}) } }]),
    capitalClasses: CLASSES };
  const P = { ...BASE_PARAMS, hunt: { enabled: true, maxHuntersPerFaction: 2, strikeMaxJumps: 5, dwellMs: 300000,
    maxBfsSystems: 500 }, ...(o.params || {}) };
  if (o.dropLevel) delete P.capitalLevel;
  const ledger = createHullLedger(s, P);
  const out = planHunts({ snapshot: s, params: P, budget: { resourceUnits: 100, reserveUnits: 100 }, ledger,
    war: null });
  return { out, snapshot: s, params: P, mobs: mobsOf(out) };
}

module.exports = ({ test }) => {
  test("CL1 postLevelOf: calm post 0, HQ 2 (valueBonus 1 + homeBonus 1), HQ with a threat >= 2x base at L1=2 -> 3; "
    + "escalation or capitalLevel null -> 0; config defaults on / 1", () => {
    assert.deepStrictEqual([CFG.strategy.capitalPostLevelEnabled, CFG.strategy.capitalHomeLevelBonus], [true, 1]);
    assert.deepStrictEqual([ESCALATION.fleetsL1, ESCALATION.valueBonus], [2, 1]);
    const base = strengthOf(GARRISON, POWER);
    assert.ok(base > 0);
    const snap = (intel) => ({ at: AT, faction: { homeSystemId: HOME }, intel });
    const P = BASE_PARAMS;
    assert.deepStrictEqual(postLevelOf(snap([]), P, 22, GARRISON), { level: 0, seen: 0 });
    assert.deepStrictEqual(postLevelOf(snap([]), P, HOME, GARRISON), { level: 2, seen: 0 });
    const threat = snap([{ systemId: HOME, observedAt: AT - HOUR, hostileStrength: 2 * base }]);
    assert.deepStrictEqual(postLevelOf(threat, P, HOME, GARRISON), { level: 3, seen: 2 * base });
    const stale = snap([{ systemId: HOME, observedAt: AT - 7 * HOUR, hostileStrength: 2 * base }]);
    assert.strictEqual(postLevelOf(stale, P, HOME, GARRISON).level, 2, "stale intel is not seen");
    assert.deepStrictEqual(postLevelOf(threat, { ...P, escalation: null }, HOME, GARRISON), { level: 0, seen: 0 });
    assert.deepStrictEqual(postLevelOf(threat, { ...P, capitalLevel: null }, HOME, GARRISON), { level: 0, seen: 0 });
    assert.strictEqual(capitalLevelParamsOf(cfgOf({ ...ESC_ON, EVEJS_LNE_STRATEGY_CAPITAL_POST_LEVEL_ENABLED: "0" })),
      null);
    assert.strictEqual(capitalLevelParamsOf(cfgOf({})), null, "escalation off -> null");
    assert.deepStrictEqual({ ...LEVEL }, { homeBonus: 1, huntMaxLevel: 2 });
  });

  test("CL2 HQ garrison: MOBILIZE carries the carrier of the template station (composition + hulls)", () => {
    const { mobs, out } = gaRun();
    assert.strictEqual(mobs.length, 1, JSON.stringify(out));
    const m = mobs[0];
    assert.strictEqual(m.stationId, "st21");
    assert.ok(m.composition.some((e) => e.hullGroup === "carrier" && e.typeId === CARRIER), JSON.stringify(m));
    assert.ok(m.hulls.some((h) => h.itemKey === "group:carrier" && h.count === 1), JSON.stringify(m.hulls));
    assert.ok(!Object.hasOwn(m, "capitalGated"));
    assert.ok(!Object.hasOwn(m, "capitalLevel"), "no capitalLevel field on the intent");
  });

  test("CL3 calm non-HQ post: level 0 -> capitalGated true, no capital", () => {
    const { mobs, out } = gaRun({ post: 23 });
    assert.strictEqual(mobs.length, 1, JSON.stringify(out));
    assert.strictEqual(mobs[0].capitalGated, true);
    assert.ok(!mobs[0].composition.some((e) => e.hullGroup === "carrier"));
    assert.ok(out.notes.includes("CAPITAL_LEVEL_GATED"));
  });

  test("CL4 capitalLevel null = the planners without the key (garrison and hunter, byte for byte)", () => {
    const gNull = gaRun({ params: { capitalLevel: null } }).out;
    assert.deepStrictEqual(gNull, gaRun({ dropLevel: true }).out);
    assert.strictEqual(mobsOf(gNull)[0].capitalGated, true, "the gate of before: HQ level 0");
    const hot = [{ systemId: S2, observedAt: AT - HOUR, hostileStrength: 3 * strengthOf(HUNTER, POWER) }];
    const hNull = huRun({ intel: hot, params: { capitalLevel: null } }).out;
    assert.deepStrictEqual(hNull, huRun({ intel: hot, dropLevel: true }).out);
    assert.strictEqual(mobsOf(hNull)[0].capitalGated, true);
  });

  test("CL5 huntLevelOf: one hot candidate (seen 3x base) -> level >= 2, the hunter MOBILIZE carries the carrier; "
    + "calm ground / empty list -> 0", () => {
    const base = strengthOf(HUNTER, POWER);
    const hot = [{ systemId: S2, observedAt: AT - HOUR, hostileStrength: 3 * base }];
    const r = huRun({ intel: hot });
    assert.ok(huntLevelOf(r.snapshot, r.params, [S2], HUNTER).level >= 2);
    assert.strictEqual(r.mobs.length, 1, JSON.stringify(r.out));
    assert.ok(r.mobs[0].composition.some((e) => e.hullGroup === "carrier"), JSON.stringify(r.mobs[0]));
    assert.ok(r.mobs[0].hulls.some((h) => h.itemKey === "group:carrier"));
    const calm = huRun();
    assert.strictEqual(huntLevelOf(calm.snapshot, calm.params, [S2], HUNTER).level, 0);
    assert.strictEqual(huntLevelOf(calm.snapshot, calm.params, [], HUNTER).level, 0);
    assert.strictEqual(calm.mobs[0].capitalGated, true);
  });

  test("CL6 hunter: a super-level ground (seen 10x base) is capped at superMinLevel - 1 = 2 "
    + "with a titan and a carrier in the station the hunter takes the carrier, never the titan", () => {
    const base = strengthOf(HUNTER, POWER);
    const hot = [{ systemId: S2, observedAt: AT - HOUR, hostileStrength: 10 * base }];
    const r = huRun({ intel: hot, hulls: { titan: 1 } });
    assert.strictEqual(postLevelOf(r.snapshot, r.params, S2, HUNTER).level, 3, "the post level itself reaches 3");
    assert.strictEqual(huntLevelOf(r.snapshot, r.params, [S2], HUNTER).level, 2);
    assert.strictEqual(r.mobs.length, 1, JSON.stringify(r.out));
    const m = r.mobs[0];
    assert.ok(!m.composition.some((e) => e.hullGroup === "titan" || e.hullGroup === "supercarrier"), JSON.stringify(m));
    assert.ok(m.composition.some((e) => e.hullGroup === "carrier"), JSON.stringify(m));
    const free = { ...r.params, capitalLevel: { ...LEVEL, huntMaxLevel: undefined } };
    assert.strictEqual(huntLevelOf(r.snapshot, free, [S2], HUNTER).level, 3, "no cap -> the level of before");
  });
};
