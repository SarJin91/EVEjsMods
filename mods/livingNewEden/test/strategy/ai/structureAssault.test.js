"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planStructureAssault } = require("../../../lib/strategy/ai/structureAssault");
const { decideReview } = require("../../../lib/strategy/ai");
const { evaluateSupplyAndFronts } = require("../../../lib/strategy/ai/supply");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { DOCTRINES_VERSION, DOCTRINES_V1 } = require("../../../lib/strategy/data/doctrines");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { SIEGE_ROLES } = require("../../../lib/stations/siege/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { createPlayerSiegeService } = require("../../../lib/stations/playerSiege/service");
const { resolveConfig } = require("../../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const DPS_GROUPS = Object.freeze({ cruiser: Object.freeze({ dps: 100, applicationFactor: 1 }) });
const PS = Object.freeze({ fleetRoles: SIEGE_ROLES, maxDispatchPerReview: 1, dispatchMaxJumps: 3,
  dispatchDpsMargin: 1.5, groups: DPS_GROUPS });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  siege: null, playerSiege: PS });

const cruisers = (count) => [{ hullGroup: "cruiser", typeId: null, count }];

function fleet(fleetId, systemId, count, extra = {}) {
  const composition = cruisers(count);
  return { fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId, refitPending: false,
    shipCount: count, strength: strengthOf(composition, POWER), composition, operationId: null, legSeq: 0,
    homeSystemId: 20, updatedAt: AT - 2 * HOUR, ...extra };
}

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "pa", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "pirate", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "pa", canOccupy: false, reachJumps: 30, returnToBase: true,
      operationTypes: ["recon", "raid", "return", "structure_assault"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: () => false,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(20, F)],
    fleets: o.fleets || [], fleetsTruncated: false, operations: o.operations || [], operationsTruncated: false,
    intel: [], sightings: [], occupations: [], territory: [], territoryTruncated: false,
    siege: { mode: "off", attacking: [], defending: [], truncated: false } };
  if (o.playerSiege !== null) {
    s.playerSiege = { mode: "ready", attacking: [], targets: [], truncated: false, ...(o.playerSiege || {}) };
  }
  return s;
}

const target = (systemId, requiredDps = 1000) => ({ systemId, structureId: 1035000000 + systemId,
  ownerCorpId: 98000001, requiredDps });
const plan = (s, o = {}) => planStructureAssault(s, { ...PARAMS, ...(o.params || {}) }, o.used || new Set(),
  o.room === undefined ? 2 : o.room, o.opts);

module.exports = ({ test }) => {
  test("PA1 markSiegeFleets: IDLE invasion fleet in a playerSiege.attacking system is SIEGING with siege.mode off "
    + "(no intent takes it); without the player siege it is sent home", () => {
    const fleets = [fleet("s18", 18, 6)];
    const attacking = [{ siegeId: "ps_1", systemId: 18, structureId: 1035000018, state: "SHIELD_ASSAULT",
      phaseEndsAt: AT + HOUR }];
    const takes = (d) => d.intents.filter((i) => JSON.stringify(i).includes("\"s18\""));
    const free = decideReview(snap({ fleets, playerSiege: null }), PARAMS);
    assert.strictEqual(free.outcome, "REVIEWED", JSON.stringify(free));
    assert.ok(takes(free).length > 0, `contrast: the idle fleet is used ${JSON.stringify(free.intents)}`);
    const pinned = decideReview(snap({ fleets, playerSiege: { attacking } }), PARAMS);
    assert.strictEqual(pinned.outcome, "REVIEWED", JSON.stringify(pinned));
    assert.deepStrictEqual(takes(pinned), []);
    assert.ok(pinned.notes.includes("STRUCTURE_ASSAULT_BUSY"), JSON.stringify(pinned.notes));
  });

  test("PA6 markSiegeFleets: a siege whose STEP deadline + liveWindowMs is past does not pin; inside the "
    + "window it pins", () => {
    const fleets = [fleet("s18", 18, 6)];
    const params = { ...PARAMS, playerSiege: { ...PS, liveWindowMs: 2 * HOUR } };
    const at = (phaseEndsAt) => [{ siegeId: "ps_1", systemId: 18, structureId: 1035000018, state: "SHIELD_ASSAULT",
      phaseEndsAt }];
    const takes = (d) => d.intents.filter((i) => JSON.stringify(i).includes("\"s18\"")).length;
    assert.ok(takes(decideReview(snap({ fleets, playerSiege: { attacking: at(AT - 10 * HOUR) } }), params)) > 0,
      "a lost siege releases the fleet");
    assert.strictEqual(takes(decideReview(snap({ fleets, playerSiege: { attacking: at(AT - HOUR) } }), params)), 0);
  });

  test("PA2 planStructureAssault: two IDLE fleets (60 % / 120 % of required x margin) -> one LAUNCH with the nearer "
    + "one that meets it; target 5 jumps from own space with dispatchMaxJumps 3 -> no LAUNCH", () => {
    const fleets = [fleet("big", 21, 18), fleet("small", 20, 9)];
    const r = plan(snap({ fleets, playerSiege: { targets: [target(22)] } }));
    assert.deepStrictEqual(r, { intents: [{ type: "LAUNCH", kind: "structure_assault",
      target: { kind: "system", systemId: 22, ref: null }, originSystemId: 21,
      fleets: [{ fleetId: "big", expectedVersion: 2 }], mobilize: [], dueAt: AT + PARAMS.attackWindowMs }],
    notes: ["STRUCTURE_ASSAULT_LAUNCH:22"], fleetIds: ["big"] });
    assert.deepStrictEqual(plan(snap({ fleets, playerSiege: { targets: [target(22)] } })), r, "deterministic");
    const far = plan(snap({ fleets, playerSiege: { targets: [target(25)] } }));
    assert.deepStrictEqual(far.intents, []);
  });

  test("PA3 planStructureAssault: an own open player structure siege -> STRUCTURE_ASSAULT_BUSY; "
    + "maxDispatchPerReview 0 -> nothing", () => {
    const fleets = [fleet("big", 21, 18)];
    const busy = plan(snap({ fleets, playerSiege: { targets: [target(22)], attacking: [{ siegeId: "ps_1",
      systemId: 30, structureId: 1, state: "ARMOR_TIMER", phaseEndsAt: AT + HOUR }] } }));
    assert.deepStrictEqual(busy, { intents: [], notes: ["STRUCTURE_ASSAULT_BUSY"], fleetIds: [] });
    const off = plan(snap({ fleets, playerSiege: { targets: [target(22)] } }),
      { params: { playerSiege: { ...PS, maxDispatchPerReview: 0 } } });
    assert.deepStrictEqual(off, { intents: [], notes: [], fleetIds: [] });
  });

  test("PA4 catalogue: kinds v16 structure_assault (opensFront false, its operation holds no front), doctrines v20: "
    + "every doctrine with raid runs structure_assault", () => {
    assert.strictEqual(OPERATION_KINDS_VERSION, 19);
    const k = kinds.get("structure_assault");
    assert.deepStrictEqual({ ...k, fleetRoles: [...k.fleetRoles], targetKinds: [...k.targetKinds] }, {
      kind: "structure_assault", operationType: "structure_assault", objective: "destroy",
      fleetRoles: ["invasion", "patrol"], mobilizeRole: "invasion", offensive: true, opensFront: false,
      captures: false, targetKinds: ["system"], windowKey: "attackWindowMs", needsIntel: false,
      needsCanOccupy: false, enabled: false, occupationSignal: null, inPlace: false });
    assert.strictEqual(OPERATION_TYPES[OPERATION_TYPES.length - 3], "structure_assault");
    const op = (operationType) => ({ operationId: "o1", version: 1, state: "ACTIVE", operationType,
      originSystemId: 20, targetSystemId: 26, dueAt: AT + HOUR, members: 1, orderedMembers: 1 });
    assert.ok(!evaluateSupplyAndFronts(snap({ operations: [op("structure_assault")] }), PARAMS).frontTargets
      .includes(26));
    assert.ok(evaluateSupplyAndFronts(snap({ operations: [op("raid")] }), PARAMS).frontTargets.includes(26),
      "contrast: a raid op holds the front");
    assert.strictEqual(DOCTRINES_VERSION, 25);
    const withRaid = DOCTRINES_V1.filter((d) => d.operationTypes.includes("raid"));
    assert.deepStrictEqual(withRaid.filter((d) => !d.operationTypes.includes("structure_assault")), []);
    assert.deepStrictEqual(DOCTRINES_V1.filter((d) => d.operationTypes.includes("structure_assault"))
      .map((d) => d.doctrineId), withRaid.map((d) => d.doctrineId));
    assert.strictEqual(withRaid.length, 8);
  });

  test("PA5 readTargetsForFaction (fake seam, frozen views): damage cap below the required DPS -> skipped; neutral "
    + "owner -> target of a pirate faction, none for an empire faction", () => {
    const PIRATE = 500019;
    const EMPIRE = 500001;
    const SYS = 30000142;
    const view = (structureId, damageLimit) => Object.freeze({ structureId, systemId: SYS, typeId: 35832,
      family: "citadel", size: "medium", ownerCorpId: 98000001, allianceId: null, state: "SHIELD_VULNERABLE",
      stateEndsAt: null, name: "Fort", stateId: 3, destroyedAt: null, upkeep: "FULL_POWER",
      ehp: Object.freeze({ shield: 1e6, armor: 1e6, hull: 1e6 }),
      damageLimit: Object.freeze({ shield: damageLimit, armor: 0, hull: 0 }), assetSafety: true, tagged: false });
    const views = new Map([[1, view(1, 10)], [2, view(2, 0)]]);
    const seam = Object.freeze({
      listCandidates: () => ({ ok: true, bySystem: new Map([[SYS, Object.freeze([...views.values()])]]), total: 2,
        truncated: false, builtAt: AT }),
      readStructure: (id) => ({ ok: true, view: views.get(id) }),
      readOwnerFace: () => Object.freeze({ ok: true, ceoId: 90000001, npc: false }),
    });
    const sieges = Object.freeze({ countOpen: () => ({ ok: true, count: 0 }),
      getLastByStructure: () => ({ ok: true, siege: null }) });
    const service = createPlayerSiegeService(Object.freeze({ store: null, sieges, scheduler: null,
      fleetRepository: null, seam, groups: {}, clock: Object.freeze({ now: () => AT }),
      config: { ...DEFAULTS, playerSiege: { ...DEFAULTS.playerSiege, enabled: true } },
      registry: Object.freeze({ isActive: () => true,
        getFaction: (f) => Object.freeze({ kind: f === EMPIRE ? "empire" : "pirate" }) }),
      getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }),
      readStanding: () => ({ ok: true, found: true, standing: 0 }),
      getVirtualCorps: () => Object.freeze({ isVirtualCorporation: () => false }),
      hostility: () => false }));
    const tx = Object.freeze({ inTransaction: true });
    const required = Math.ceil((1000 * 1e6) / DEFAULTS.playerSiege.assaultMaxMs);
    assert.deepStrictEqual(service.readTargetsForFaction(tx, PIRATE, { limit: 4, at: AT }), { ok: true,
      targets: [{ systemId: SYS, structureId: 2, ownerCorpId: 98000001, requiredDps: required }], truncated: false });
    assert.deepStrictEqual(service.readTargetsForFaction(tx, EMPIRE, { limit: 4, at: AT }),
      { ok: true, targets: [], truncated: false });
    assert.strictEqual(service.readTargetsForFaction({}, PIRATE).reason, "TX_REQUIRED");
  });

  test("PA7 readTargetsForFaction opts.systems: 4 hostile structures in low systemIds + 1 next to the "
    + "faction -> the near one; without the reach the 4 low ones fill the limit (contrast)", () => {
    const PIRATE = 500019;
    const view = (systemId) => Object.freeze({ structureId: 1035000000 + systemId, systemId, typeId: 35832,
      family: "citadel", size: "medium", ownerCorpId: 98000001, allianceId: null, state: "SHIELD_VULNERABLE",
      stateEndsAt: null, name: "Fort", stateId: 3, destroyedAt: null, upkeep: "FULL_POWER",
      ehp: Object.freeze({ shield: 1e6, armor: 1e6, hull: 1e6 }),
      damageLimit: Object.freeze({ shield: 0, armor: 0, hull: 0 }), assetSafety: true, tagged: false });
    const views = new Map([1, 2, 3, 4, 30].map((s) => [1035000000 + s, view(s)]));
    let reads = 0;
    const seam = Object.freeze({
      listCandidates: () => ({ ok: true, bySystem: new Map([...views.values()].map((v) => [v.systemId,
        Object.freeze([v])])), total: 5, truncated: false, builtAt: AT }),
      readStructure: (id) => {
        reads += 1;
        return { ok: true, view: views.get(id) };
      },
      readOwnerFace: () => Object.freeze({ ok: true, ceoId: 90000001, npc: false }),
    });
    const service = createPlayerSiegeService(Object.freeze({ store: null,
      sieges: Object.freeze({ countOpen: () => ({ ok: true, count: 0 }),
        getLastByStructure: () => ({ ok: true, siege: null }) }),
      scheduler: null, fleetRepository: null, seam, groups: {}, clock: Object.freeze({ now: () => AT }),
      config: { ...DEFAULTS, playerSiege: { ...DEFAULTS.playerSiege, enabled: true } },
      registry: Object.freeze({ isActive: () => true, getFaction: () => Object.freeze({ kind: "pirate" }) }),
      getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }),
      readStanding: () => ({ ok: true, found: true, standing: -10 }),
      getVirtualCorps: () => Object.freeze({ isVirtualCorporation: () => false }),
      hostility: () => false }));
    const tx = Object.freeze({ inTransaction: true });
    const ids = (r) => r.targets.map((t) => t.systemId);
    const all = service.readTargetsForFaction(tx, PIRATE, { limit: 4, at: AT });
    assert.deepStrictEqual([all.ok, ids(all)], [true, [1, 2, 3, 4]]);
    reads = 0;
    const near = service.readTargetsForFaction(tx, PIRATE, { limit: 4, at: AT, systems: [28, 29, 30, 31, 32] });
    assert.deepStrictEqual([near.ok, ids(near), reads], [true, [30], 1]);
    assert.strictEqual(service.readTargetsForFaction(tx, PIRATE, { systems: 30 }).reason, "INVALID_INPUT");
  });
};
