"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { planHarvestRaid } = require("../../lib/strategy/ai/harvestRaid");
const { decideReview } = require("../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { DOCTRINES_VERSION, DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createHarvestRaidService } = require("../../lib/stations/harvestRaid/service");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
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
const HR = Object.freeze({ factionKinds: Object.freeze(["pirate"]), maxDispatchPerReview: 1, dispatchMaxJumps: 3,
  maxTargetsReadPerReview: 8 });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  siege: null, playerSiege: null, harvestRaid: HR });

function fleet(fleetId, systemId, extra = {}) {
  const composition = [{ hullGroup: "cruiser", typeId: null, count: 4 }];
  return { fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId, refitPending: false,
    shipCount: 4, strength: strengthOf(composition, POWER), composition, operationId: null, legSeq: 0,
    homeSystemId: 20, updatedAt: AT - 2 * HOUR, ...extra };
}

function snap(o = {}) {
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: o.status || "ACTIVE", homeSystemId: 20, doctrineId: "hr", resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 1, version: 1 },
    entry: { kind: o.kind || "pirate", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "hr", canOccupy: false, reachJumps: 30, returnToBase: true,
      operationTypes: o.operationTypes || ["recon", "raid", "return", "harvest_raid"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: () => false,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [{ systemId: 20, controllerFactionId: F, occupationState: "STABLE", controllerGarrison: 0,
      hostileStations: 0, observed: false }],
    fleets: o.fleets || [], fleetsTruncated: o.fleetsTruncated === true, operations: o.operations || [],
    operationsTruncated: false, intel: [], sightings: [], occupations: [], territory: [], territoryTruncated: false,
    siege: { mode: "off", attacking: [], defending: [], truncated: false } };
  if (o.harvestRaid !== null) {
    s.harvestRaid = { mode: "ready", open: 0, targets: [], truncated: false, ...(o.harvestRaid || {}) };
  }
  return s;
}

const target = (systemId, lootVolumeM3, targetId = 9000 + systemId) => ({ targetKind: "metenox", targetId, systemId,
  ownerCorpId: 98000001, lootVolumeM3 });
const plan = (s, o = {}) => planHarvestRaid(s, { ...PARAMS, ...(o.params || {}) }, o.used || new Set(),
  o.room === undefined ? 2 : o.room, o.opts);
const NOTHING = { intents: [], notes: [], fleetIds: [] };
const launch = (systemId, fleetId, origin) => ({ type: "LAUNCH", kind: "harvest_raid",
  target: { kind: "system", systemId, ref: null }, originSystemId: origin,
  fleets: [{ fleetId, expectedVersion: 2 }], mobilize: [], dueAt: AT + PARAMS.attackWindowMs });

const PIRATE = 500019;
const SYS = 30000142;
const OWNER = 98000001;
const OWNER_B = 98000002;

function bayLines(units, ownerId) {
  return [{ itemId: 1, typeId: 16634, units, unitVolume: 0.05, flagId: 186, groupId: 427, ownerId },
    { itemId: 2, typeId: 16634, units, unitVolume: 0.05, flagId: 186, groupId: 427, ownerId: 98000099 }];
}

function targetService(o = {}) {
  const metenox = (structureId, ownerCorpId) => Object.freeze({ structureId, systemId: SYS, typeId: 81826,
    ownerCorpId });
  const index = new Map([[SYS, Object.freeze(o.structures || [metenox(9001, OWNER)])]]);
  const calls = { bays: 0 };
  const raidsRepo = Object.freeze({
    countOpen: () => ({ ok: true, count: o.mine || 0 }),
    getLastByTarget: (_tx, _kind, id) => ({ ok: true, raid: (o.lastByTarget || {})[id] || null }),
    getLastOwnerStart: (_tx, corp) => ({ ok: true, startedAt: (o.ownerStart || {})[corp] ?? null }),
  });
  const service = createHarvestRaidService(Object.freeze({ store: null, raids: raidsRepo, scheduler: null,
    fleetRepository: null,
    registry: Object.freeze({ isActive: () => true, getFaction: () => Object.freeze({ kind: "pirate" }) }),
    structures: Object.freeze({
      listCandidates: () => ({ ok: true, bySystem: index, total: 1, truncated: false, builtAt: AT }),
      readOwnerFace: () => Object.freeze({ ok: true, ceoId: 90000001, npc: false }),
    }),
    bays: Object.freeze({ readMetenoxBay: (structureId) => {
      calls.bays += 1;
      const st = (o.structures || [metenox(9001, OWNER)]).find((s) => s.structureId === structureId);
      return { ok: true, structure: { structureId, systemId: SYS, ownerCorpId: st.ownerCorpId, destroyed: false },
        lines: bayLines(o.units === undefined ? 20000 : o.units, st.ownerCorpId) };
    } }),
    readStanding: () => ({ ok: true, found: true, standing: -10 }),
    getVirtualCorps: () => Object.freeze({ isVirtualCorporation: () => o.virtual === true }),
    getPlayerSiege: () => (o.sieged ? Object.freeze({ getMode: () => "ready",
      listOpen: () => ({ ok: true, sieges: [{ structureId: o.sieged }] }) }) : null),
    ownerOnline: () => ({ online: o.online !== false }), hostility: () => false, groups: {},
    getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }),
    config: { ...DEFAULTS, harvestRaid: { ...DEFAULTS.harvestRaid, enabled: true, ...(o.over || {}) } },
    clock: Object.freeze({ now: () => AT }), logger: { log() {} } }));
  return { service, calls };
}

module.exports = ({ test }) => {
  test("P1 planHarvestRaid: gates, BUSY, reach, limit, loot order, one nearest fleet; decideReview carries it", () => {
    const fleets = [fleet("near", 21), fleet("far", 18), fleet("refit", 22, { refitPending: true }),
      fleet("scout", 22, { fleetRole: "scout" })];
    const targets = [target(22, 100), target(23, 300), target(19, 300), target(30, 900)];
    const s = snap({ fleets, harvestRaid: { targets } });
    assert.deepStrictEqual(plan(s), { intents: [launch(19, "far", 18)], notes: ["HARVEST_RAID_LAUNCH:19"],
      fleetIds: ["far"] });
    assert.deepStrictEqual(plan(s), plan(s), "deterministic");
    const two = plan(s, { params: { harvestRaid: { ...HR, maxDispatchPerReview: 2 } } });
    assert.deepStrictEqual(two.intents, [launch(19, "far", 18), launch(23, "near", 21)]);
    assert.deepStrictEqual(plan(s, { params: { harvestRaid: { ...HR, maxDispatchPerReview: 2 } }, room: 1 }).intents,
      [launch(19, "far", 18)], "room caps the limit");
    assert.deepStrictEqual(plan(s, { opts: { targets: new Set([19]) }, used: new Set(["near"]) }).intents,
      [launch(23, "far", 18)]);
    for (const g of [plan(s, { params: { harvestRaid: null } }), plan(s, { room: 0 }),
      plan(s, { params: { harvestRaid: { ...HR, maxDispatchPerReview: 0 } } }),
      plan(snap({ fleets, harvestRaid: { targets, mode: "off" } })), plan(snap({ fleets, harvestRaid: null })),
      plan(snap({ fleets, harvestRaid: { targets }, kind: "empire" })),
      plan(snap({ fleets, harvestRaid: { targets }, status: "DORMANT" })),
      plan(snap({ fleets, harvestRaid: { targets }, fleetsTruncated: true }))]) {
      assert.deepStrictEqual(g, NOTHING);
    }
    assert.deepStrictEqual(plan(snap({ fleets, harvestRaid: { targets }, operationTypes: ["raid"] })),
      { intents: [], notes: ["HARVEST_RAID_NO_KIND"], fleetIds: [] });
    const busy = { intents: [], notes: ["HARVEST_RAID_BUSY"], fleetIds: [] };
    assert.deepStrictEqual(plan(snap({ fleets, harvestRaid: { targets, open: 1 } })), busy);
    const op = { operationId: "o1", version: 1, state: "ACTIVE", operationType: "harvest_raid", originSystemId: 20,
      targetSystemId: 35, dueAt: AT + HOUR, members: 1, orderedMembers: 1 };
    assert.deepStrictEqual(plan(snap({ fleets, operations: [op], harvestRaid: { targets } })), busy);
    assert.deepStrictEqual(plan(snap({ fleets: [fleet("home", 20, { state: "MOVING" })], harvestRaid: { targets } })),
      { intents: [], notes: ["HARVEST_RAID_NO_FLEET"], fleetIds: [] });
    const d = decideReview(snap({ fleets: [fleet("far", 18)], harvestRaid: { targets: [target(19, 300)] } }), PARAMS);
    assert.strictEqual(d.outcome, "REVIEWED", JSON.stringify(d));
    assert.ok(d.intents.some((i) => i.type === "LAUNCH" && i.kind === "harvest_raid" && i.target.systemId === 19),
      JSON.stringify(d.intents));
    assert.ok(d.notes.includes("HARVEST_RAID_LAUNCH:19"), JSON.stringify(d.notes));
  });

  test("P2 readTargetsForFaction (fakes): good target; offline, cooldowns, virtual, siege, small loot -> none; "
    + "own open raid -> open 1 without a bay read; read cap -> truncated", () => {
    const tx = Object.freeze({ inTransaction: true });
    const read = (svc) => svc.service.readTargetsForFaction(tx, PIRATE, { systems: [SYS], at: AT });
    const good = targetService();
    assert.deepStrictEqual(read(good), { ok: true, open: 0, targets: [{ targetKind: "metenox", targetId: 9001,
      systemId: SYS, ownerCorpId: OWNER, lootVolumeM3: 150 }], truncated: false });
    const C = DEFAULTS.harvestRaid;
    const none = { ok: true, open: 0, targets: [], truncated: false };
    for (const o of [{ online: false }, { virtual: true }, { sieged: 9001 }, { units: 1000 },
      { lastByTarget: { 9001: { open: false, endedAt: AT - C.targetCooldownMs + 1 } } },
      { lastByTarget: { 9001: { open: true, endedAt: null } } },
      { ownerStart: { [OWNER]: AT - C.ownerCooldownMs + 1 } }]) {
      assert.deepStrictEqual(read(targetService(o)), none, JSON.stringify(o));
    }
    assert.strictEqual(read(targetService({ lastByTarget: { 9001: { open: false, endedAt: AT - C.targetCooldownMs } },
      ownerStart: { [OWNER]: AT - C.ownerCooldownMs } })).targets.length, 1);
    const mine = targetService({ mine: 1 });
    assert.deepStrictEqual(read(mine), { ok: true, open: 1, targets: [], truncated: false });
    assert.strictEqual(mine.calls.bays, 0);
    const metenox = (structureId, ownerCorpId) => ({ structureId, systemId: SYS, typeId: 81826, ownerCorpId });
    const capped = targetService({ structures: [metenox(9002, OWNER_B), metenox(9001, OWNER)],
      over: { maxTargetsReadPerReview: 1 } });
    const r = read(capped);
    assert.deepStrictEqual([r.ok, r.targets.map((t) => t.targetId), r.truncated, capped.calls.bays],
      [true, [9001], true, 1]);
    assert.strictEqual(good.service.readTargetsForFaction({}, PIRATE, { systems: [SYS] }).reason, "TX_REQUIRED");
    assert.strictEqual(good.service.readTargetsForFaction(tx, PIRATE, { systems: SYS }).reason, "INVALID_INPUT");
  });

  test("P3 catalogue: kinds v18 harvest_raid (enabled false, no front, no capture), doctrines v24: pirates run "
    + "harvest_raid, the others not; config defaults", () => {
    assert.strictEqual(OPERATION_KINDS_VERSION, 19);
    const k = kinds.get("harvest_raid");
    assert.deepStrictEqual({ ...k, fleetRoles: [...k.fleetRoles], targetKinds: [...k.targetKinds] }, {
      kind: "harvest_raid", operationType: "harvest_raid", objective: "raid", fleetRoles: ["invasion", "patrol"],
      mobilizeRole: "patrol", offensive: true, opensFront: false, captures: false, targetKinds: ["system"],
      windowKey: "attackWindowMs", needsIntel: false, needsCanOccupy: false, enabled: false, occupationSignal: null,
      inPlace: false });
    assert.strictEqual(OPERATION_KINDS_V1[OPERATION_KINDS_V1.length - 2].kind, "harvest_raid");
    assert.strictEqual(DOCTRINES_VERSION, 25);
    const runs = DOCTRINES_V1.filter((d) => d.operationTypes.includes("harvest_raid"));
    assert.deepStrictEqual(runs.map((d) => d.doctrineId), ["sansha-incursion-v1", "serpentis-territorial-v2",
      "pirate-territorial-v2"]);
    assert.deepStrictEqual(DOCTRINES_V1.filter((d) => d.kind === "pirate").map((d) => d.doctrineId),
      runs.map((d) => d.doctrineId));
    const C = DEFAULTS.harvestRaid;
    assert.deepStrictEqual([C.factionKinds, C.maxDispatchPerReview, C.dispatchMaxJumps, C.maxTargetsReadPerReview],
      ["pirate", 1, 6, 8]);
  });
};
