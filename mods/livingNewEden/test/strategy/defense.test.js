"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { createRng, deriveSeed } = require("../../lib/util/rng");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { chooseTargetSystem, describe, categoryOf, captureBlock, adjacentOwn } = require("../../lib/strategy/ai/targeting");
const { planDefense } = require("../../lib/strategy/ai/defense");
const { planRelief, pickDefenders, heldStrength } = require("../../lib/strategy/ai/relief");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { decideReview } = require("../../lib/strategy/ai");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AMARR = 500003;
const CONCORD = 500006;
const SANSHA = 500019;
const SERPENTIS = 500020;
const SAMINER = 30001721;
const A_DZA8 = 30001954;
const AT = 1760000000000;
const HOUR = 3600000;

const graph = (() => {
  const built = buildUniverseGraph(k3StaticMap());
  assert.ok(built.ok);
  return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 16, maxJumps: 40 }).publicApi });
})();
const registry = (() => {
  const r = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
    operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
    maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
  assert.ok(r.ok);
  return r.registry;
})();
const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const THEATRE = [...registry.getCampaign("k3-stain").systemIds].sort((a, b) => a - b);
const hostility = createHostility();

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
  maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
  reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
  maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2,
  routeMaxJumps: 40, maxCapturedSystemsPerFaction: 24, captureRequiresAdjacency: true,
  defense: { enabled: true, maxPerReview: 1 }, maxThreatsRead: 32, maxLostHomeRead: 32 });

const COMP = Object.freeze([{ hullGroup: "cruiser", typeId: null, count: 4 }]);

function snap(factionId, o = {}) {
  const entry = registry.getFaction(factionId);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const controllers = o.controllers || new Map(THEATRE.map((id) => [id, SANSHA]));
  const ids = [...new Set([...THEATRE, ...controllers.keys(), SAMINER])].sort((a, b) => a - b);
  return {
    v: 1, factionId, round: 7, at: AT, seed: o.seed === undefined ? 12345 : o.seed,
    faction: { status: "ACTIVE", homeSystemId: o.home === undefined ? entry.hqSystemId : o.home,
      doctrineId: doctrine.doctrineId, resourceUnits: 20000, reserveUnits: 300, frontLimit: o.frontLimit || 1, version: 3 },
    entry: { kind: entry.kind, maxActiveFronts: o.maxActiveFronts || entry.maxActiveFronts, allies: [...entry.allies],
      homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
      operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates,
      fieldsDefense: doctrine.fieldsDefense, captureTargets: o.captureTargets || doctrine.captureTargets },
    theatre: THEATRE,
    neighbors: (id) => graph.getNeighbors(id),
    regionOf: (id) => (graph.getSystem(id) ? graph.getSystem(id).regionId : null),
    isHostile: (x) => x !== factionId && !entry.allies.includes(x) && hostility(factionId, x),
    stationsMode: o.stationsMode || "ready",
    stations: (o.stations || [SAMINER]).map((systemId, i) => ({ systemId, stationId: `st${i}` })),
    captureAnchors: o.stations || [SAMINER],
    systems: ids.map((systemId) => ({ systemId, controllerFactionId: controllers.has(systemId)
      ? controllers.get(systemId) : null, occupationState: "STABLE", controllerGarrison: (o.garrison || 0),
      hostileStations: 0, observed: false, homeFactionId: o.homeFactionId === systemId ? factionId : null })),
    fleets: o.fleets || [], fleetsTruncated: false, operations: o.operations || [], operationsTruncated: false,
    intel: o.intel || [], sightings: o.sightings || [],
    threats: o.threats || { mode: "off", items: [] },
    lostHome: o.lostHome || { mode: "off", systemIds: [] },
    capturedIds: o.capturedIds || [],
    upkeep: o.upkeep || { mode: "off" },
    territoryTruncated: false,
    occupations: o.occupations || [],
  };
}

const fleet = (fleetId, systemId, extra = {}) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "invasion",
  systemId, refitPending: false, shipCount: 4, strength: strengthOf(COMP, POWER), operationId: null, legSeq: 0,
  homeSystemId: systemId, ...extra });
const freshIntel = (systemId, strength = 0) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
  hostileStrength: strength, hostileStations: 0, controllerFactionId: SANSHA });
const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH");
const dist = (starts, max) => bfs(starts, (id) => graph.getNeighbors(id), { maxJumps: max, maxSystems: 5000 });

module.exports = ({ test, skip }) => {
  test("A1 planDefense: INVASION with sufficient fleets -> 1 LAUNCH; insufficient -> DEFENSE_INSUFFICIENT; open defense / relief target skipped; DEFENSE_HELD; order; defense:null -> none; no defense kind -> DEFENSE_NO_KIND only with threats", () => {
    const threatenedSys = 30001954;
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    controllers.set(threatenedSys, SANSHA);

    const fleets = [
      fleet("f1", SAMINER),
      fleet("f2", SAMINER),
    ];
    const threats = { mode: "ready", items: [{ systemId: threatenedSys, state: "INVASION", occupier: SANSHA,
      occupierStrength: 1000, phaseDueAt: AT + HOUR }], truncated: false };

    const s = snap(AMARR, { controllers, fleets, threats, stations: [SAMINER] });
    const supply = evaluateSupplyAndFronts(s, PARAMS);

    const defense = planDefense(s, supply, PARAMS, { targets: new Set() });
    const l = launches(defense);
    assert.strictEqual(l.length, 1, "one LAUNCH defense");
    assert.strictEqual(l[0].kind, "defense");
    assert.strictEqual(l[0].target.systemId, threatenedSys);
    assert.ok(defense.notes.includes(`DEFENSE_LAUNCH:${threatenedSys}`));

    const fleets2 = [fleet("f1", SAMINER)];
    const threats2 = { mode: "ready", items: [{ systemId: threatenedSys, state: "INVASION", occupier: SANSHA,
      occupierStrength: 10000, phaseDueAt: AT + HOUR }], truncated: false };
    const s2 = snap(AMARR, { controllers, fleets: fleets2, threats: threats2, stations: [SAMINER] });
    const supply2 = evaluateSupplyAndFronts(s2, PARAMS);
    const defense2 = planDefense(s2, supply2, PARAMS, { targets: new Set() });
    assert.ok(defense2.notes.includes(`DEFENSE_INSUFFICIENT:${threatenedSys}`));
    assert.strictEqual(launches(defense2).length, 0);

    const ops = [{ operationId: "op1", version: 1, state: "PLANNED", operationType: "defense",
      targetSystemId: threatenedSys, dueAt: AT + HOUR, members: 1, orderedMembers: 1 }];
    const s3 = snap(AMARR, { controllers, fleets, threats, operations: ops, stations: [SAMINER] });
    const supply3 = evaluateSupplyAndFronts(s3, PARAMS);
    const defense3 = planDefense(s3, supply3, PARAMS, { targets: new Set() });
    assert.strictEqual(launches(defense3).length, 0);
    assert.ok(!defense3.notes.some(n => n.startsWith("DEFENSE_LAUNCH")));

    const defense4 = planDefense(s, supply, PARAMS, { targets: new Set([threatenedSys]) });
    assert.strictEqual(launches(defense4).length, 0);

    const fleets5 = [
      fleet("f1", threatenedSys, { state: "DEFENDING", strength: 5000 }),
      fleet("f2", SAMINER),
    ];
    const s5 = snap(AMARR, { controllers, fleets: fleets5, threats, stations: [SAMINER] });
    const supply5 = evaluateSupplyAndFronts(s5, PARAMS);
    const defense5 = planDefense(s5, supply5, PARAMS, { targets: new Set() });
    assert.ok(defense5.notes.includes(`DEFENSE_HELD:${threatenedSys}`));
    assert.strictEqual(launches(defense5).length, 0);

    const threats6 = { mode: "ready", items: [
      { systemId: 30001953, state: "CONTESTED", occupier: SANSHA, occupierStrength: 500, phaseDueAt: AT + HOUR },
      { systemId: threatenedSys, state: "INVASION", occupier: SANSHA, occupierStrength: 500, phaseDueAt: AT + HOUR },
    ], truncated: false };
    const s6 = snap(AMARR, { controllers, fleets, threats: threats6, stations: [SAMINER] });
    const supply6 = evaluateSupplyAndFronts(s6, PARAMS);
    const defense6 = planDefense(s6, supply6, PARAMS, { targets: new Set() });
    assert.strictEqual(defense6.targets[0], threatenedSys, "INVASION before CONTESTED");

    const paramsNoDefense = { ...PARAMS, defense: null };
    const defense7 = planDefense(s, supply, paramsNoDefense, { targets: new Set() });
    assert.strictEqual(defense7.intents.length, 0);

    const doctrineNoDefense = { ...registry.getDoctrine("amarr-border-defense-v3"), operationTypes: ["patrol", "recon", "raid", "invasion", "logistics"] };
    const s8 = { ...s, doctrine: { ...s.doctrine, operationTypes: doctrineNoDefense.operationTypes, fieldsDefense: false } };
    const defense8 = planDefense(s8, supply, PARAMS, { targets: new Set() });
    assert.ok(defense8.notes.includes("DEFENSE_NO_KIND"));
  });

  test("A2 planDefense runs outside chooseNextOperation (no front limit, no upkeep brake)", () => {
    const threatenedSys = 30001954;
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    controllers.set(threatenedSys, SANSHA);

    const fleets = [fleet("f1", SAMINER), fleet("f2", SAMINER)];
    const threats = { mode: "ready", items: [{ systemId: threatenedSys, state: "INVASION", occupier: SANSHA,
      occupierStrength: 1000, phaseDueAt: AT + HOUR }], truncated: false };
    const ops = [
      { operationId: "op1", version: 1, state: "ACTIVE", operationType: "recon", targetSystemId: 30001953,
        dueAt: AT + HOUR, members: 1, orderedMembers: 1 },
      { operationId: "op2", version: 1, state: "ACTIVE", operationType: "invasion", targetSystemId: 30001952,
        dueAt: AT + HOUR, members: 1, orderedMembers: 1 },
    ];

    const s = snap(AMARR, { controllers, fleets, threats, operations: ops, stations: [SAMINER] });
    const supply = evaluateSupplyAndFronts(s, PARAMS);
    assert.ok(supply.frontCount >= supply.frontLimit);

    const defense = planDefense(s, supply, PARAMS, { targets: new Set() });
    const defenseLaunches = launches(defense);
    assert.ok(defenseLaunches.length > 0, "defense LAUNCH exists despite front limit");
    assert.ok(defense.targets.includes(threatenedSys));
    assert.strictEqual(defenseLaunches[0].kind, "defense");
  });

  test("A3 territory room: captureRoom = 0 -> raid + TERRITORY_LIMIT; home -> invasion + RECLAIM; room = cap - captured - claims; truncated read -> 0; no key -> null", () => {
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    const fleets = [fleet("f1", SAMINER)];
    const s = snap(AMARR, { controllers, fleets, stations: [SAMINER],
      capturedIds: [30001953, 30001952],
      occupations: [{ systemId: 30001953, state: "CONTESTED", occupier: AMARR, homeOwn: false }] });
    const supply = evaluateSupplyAndFronts(s, PARAMS);

    assert.strictEqual(supply.captureRoomKnown, true);
    assert.strictEqual(supply.captureRoom, 21);

    const supplyZero = { ...supply, captureRoom: 0, captureRoomKnown: true };
    const facts = describe(s, PARAMS, new Map(), 30001953);
    assert.strictEqual(facts.category, "contested");
    const block = captureBlock(s, supplyZero, PARAMS, facts, 30001953);
    assert.strictEqual(block, "TERRITORY_LIMIT");

    const factsHome = { ...facts, category: "home" };
    const blockHome = captureBlock(s, supplyZero, PARAMS, factsHome, 30001953);
    assert.strictEqual(blockHome, null);

    const paramsNoCap = { ...PARAMS, maxCapturedSystemsPerFaction: undefined };
    const blockNoKey = captureBlock(s, { ...supplyZero, captureRoom: null }, paramsNoCap, facts, 30001953);
    assert.strictEqual(blockNoKey, null);
  });

  test("A4 adjacency: target without own neighbor -> raid + CAPTURE_NOT_ADJACENT; exceptions: station, capturedIds, foothold, belt=1, home; captureRequiresAdjacency:false = old behavior", () => {
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    const fleets = [fleet("f1", SAMINER)];
    const s = snap(AMARR, { controllers, fleets, stations: [SAMINER] });
    const supply = evaluateSupplyAndFronts(s, PARAMS);

    const targetNoAdj = 30001952;
    const facts = describe(s, PARAMS, new Map(), targetNoAdj);
    assert.strictEqual(facts.category, "contested");

    const block = captureBlock(s, supply, PARAMS, facts, targetNoAdj);
    assert.strictEqual(block, "CAPTURE_NOT_ADJACENT");

    const sStation = { ...s, systems: s.systems.map(sys => sys.systemId === SAMINER ? { ...sys, controllerFactionId: AMARR } : sys) };
    const blockStation = captureBlock(sStation, supply, PARAMS, facts, SAMINER);
    assert.strictEqual(blockStation, null);

    const sCaptured = { ...s, capturedIds: [targetNoAdj] };
    const blockCaptured = captureBlock(sCaptured, supply, PARAMS, facts, targetNoAdj);
    assert.strictEqual(blockCaptured, null);

    const supplyBelt = { ...supply, border: new Map([[targetNoAdj, 1]]) };
    const blockBelt = captureBlock(s, supplyBelt, PARAMS, facts, targetNoAdj);
    assert.strictEqual(blockBelt, null);

    const factsHome = { ...facts, category: "home" };
    const blockHome = captureBlock(s, supply, PARAMS, factsHome, targetNoAdj);
    assert.strictEqual(blockHome, null);

    const paramsNoAdj = { ...PARAMS, captureRequiresAdjacency: false };
    const blockNoAdj = captureBlock(s, supply, paramsNoAdj, facts, targetNoAdj);
    assert.strictEqual(blockNoAdj, null);
  });

  test("A5 home category: lost home gets home + homeReclaim; maxTargetCandidates 1 with closer theatre candidate -> home picked; empire without home -> old category; v2: home -> invasion, other hostile -> raid", () => {
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    const fleets = [fleet("f1", SAMINER)];
    const HOME_LIST = ["free", "contested", "home"];
    const lostHomeSys = 30001952;
    const s = snap(AMARR, { controllers, fleets, stations: [SAMINER],
      lostHome: { mode: "ready", systemIds: [lostHomeSys] },
      capturedIds: [lostHomeSys],
      captureTargets: HOME_LIST,
      homeFactionId: lostHomeSys });
    const supply = evaluateSupplyAndFronts(s, PARAMS);

    const facts = describe(s, PARAMS, new Map(), lostHomeSys);
    assert.strictEqual(facts.category, "home");

    const w = PARAMS.scoring;
    const scoreHome = w.base + w.perJump * 1 + w.homeReclaim;
    const scoreTheatre = w.base + w.perJump * 1;
    assert.ok(scoreHome > scoreTheatre, "homeReclaim adds weight");

    const params1 = { ...PARAMS, maxTargetCandidates: 1 };
    const threatSys = 30001953;
    const controllers2 = new Map(THEATRE.map((id) => [id, SANSHA]));
    controllers2.set(threatSys, SANSHA);
    const s2 = snap(AMARR, { controllers: controllers2, fleets, stations: [SAMINER],
      lostHome: { mode: "ready", systemIds: [lostHomeSys] },
      capturedIds: [lostHomeSys], captureTargets: HOME_LIST,
      homeFactionId: lostHomeSys });
    const supply2 = evaluateSupplyAndFronts(s2, params1);
    const picked = chooseTargetSystem(s2, supply2, params1, createRng(1));
    assert.strictEqual(picked.systemId, lostHomeSys, "home picked before slice");

    const doctrineOld = { ...registry.getDoctrine("amarr-border-defense-v3"), captureTargets: ["free", "contested"] };
    const sOld = { ...s, doctrine: { ...s.doctrine, captureTargets: ["free", "contested"] } };
    const factsOld = describe(sOld, PARAMS, new Map(), lostHomeSys);
    assert.strictEqual(factsOld.category, "contested", "empire without home in captureTargets -> contested (in theatre)");

    const serpentisEntry = registry.getFaction(SERPENTIS);
    const serpentisDoctrine = registry.getDoctrine(serpentisEntry.doctrineId);
    assert.ok(serpentisDoctrine.captureTargets.includes("home"));
    assert.ok(serpentisDoctrine.operationTypes.includes("invasion"));
    assert.ok(serpentisDoctrine.fieldsDefense === true);
  });

  const INTRUDED = A_DZA8;
  const CLAIMED = 30001953;
  const IP = Object.freeze({ ...PARAMS, defense: { enabled: true, maxPerReview: 1, intruders: { maxPerReview: 1 } } });
  const intruders = (items, truncated = false) => ({ mode: "ready", truncated, items: items.map(([systemId,
    hostileStrength]) => ({ systemId, hostileStrength, hostileFleets: 1, factionIds: [SANSHA] })) });
  const claim = (systemId, occupierStrength) => ({ mode: "ready", truncated: false, items: [{ systemId,
    state: "CONTESTED", occupier: SANSHA, occupierStrength, phaseDueAt: AT + HOUR }] });
  const amarr = (o) => {
    const s = snap(AMARR, { stations: [SAMINER, INTRUDED], ...o });
    if (o.intruders) s.intruders = o.intruders;
    return s;
  };
  const twoIdle = () => [fleet("f1", SAMINER), fleet("f2", SAMINER)];

  test("A6 hostile-fleets-loiter: an intruder in a held system + an IDLE defender in reach -> LAUNCH defense "
    + "+ DEFENSE_INTRUDER_LAUNCH; claim + intruder -> two LAUNCHes (independent limits); own force in T -> HELD; "
    + "too strong -> INSUFFICIENT; truncated -> note", () => {
    const s = amarr({ fleets: twoIdle(), intruders: intruders([[INTRUDED, 1]]) });
    const d = planDefense(s, null, IP, { targets: new Set() });
    assert.deepStrictEqual(launches(d).map((l) => [l.kind, l.target.systemId, l.fleets.length]),
      [["defense", INTRUDED, 1]], JSON.stringify(d));
    assert.deepStrictEqual(d.notes, [`DEFENSE_INTRUDER_LAUNCH:${INTRUDED}`]);
    assert.strictEqual(launches(d)[0].dueAt, AT + IP.attackWindowMs);

    const both = planDefense(amarr({ fleets: twoIdle(), threats: claim(CLAIMED, 1),
      intruders: intruders([[INTRUDED, 1]]) }), null, IP, { targets: new Set() });
    assert.deepStrictEqual(launches(both).map((l) => l.target.systemId), [CLAIMED, INTRUDED], JSON.stringify(both));
    assert.deepStrictEqual(both.notes, [`DEFENSE_LAUNCH:${CLAIMED}`, `DEFENSE_INTRUDER_LAUNCH:${INTRUDED}`]);
    assert.strictEqual(new Set(both.fleetIds).size, 2, "no fleet in two LAUNCHes");

    const held = planDefense(amarr({ fleets: [...twoIdle(), fleet("f3", INTRUDED, { strength: 5000 })],
      intruders: intruders([[INTRUDED, 1]]) }), null, IP, { targets: new Set() });
    assert.deepStrictEqual([launches(held).length, held.notes], [0, [`DEFENSE_INTRUDER_HELD:${INTRUDED}`]]);
    const heldPlus = planDefense(amarr({ fleets: [...twoIdle(), fleet("f3", INTRUDED, { strength: 5000 })],
      intruders: intruders([[INTRUDED, 100], [CLAIMED, 1]]) }), null, IP, { targets: new Set() });
    assert.deepStrictEqual(heldPlus.notes, [`DEFENSE_INTRUDER_HELD:${INTRUDED}`,
      `DEFENSE_INTRUDER_LAUNCH:${CLAIMED}`], JSON.stringify(heldPlus));
    assert.deepStrictEqual(launches(heldPlus).map((l) => l.target.systemId), [CLAIMED]);
    assert.ok(!heldPlus.fleetIds.includes("f3"), JSON.stringify(heldPlus.fleetIds));
    const heldOnly = planDefense(amarr({ fleets: [fleet("f3", INTRUDED, { strength: 5000 })],
      intruders: intruders([[INTRUDED, 100], [CLAIMED, 1]]) }), null, IP, { targets: new Set() });
    assert.deepStrictEqual([heldOnly.fleetIds, heldOnly.notes], [[], [`DEFENSE_INTRUDER_HELD:${INTRUDED}`,
      `DEFENSE_INTRUDER_INSUFFICIENT:${CLAIMED}`]], JSON.stringify(heldOnly));

    const weak = planDefense(amarr({ fleets: twoIdle(), intruders: intruders([[INTRUDED, 1e7]], true) }), null, IP,
      { targets: new Set() });
    assert.deepStrictEqual([launches(weak).length, weak.notes], [0, ["DEFENSE_INTRUDER_TRUNCATED",
      `DEFENSE_INTRUDER_INSUFFICIENT:${INTRUDED}`]]);

    const open = [{ operationId: "op1", version: 1, state: "ACTIVE", operationType: "defense", targetSystemId: INTRUDED,
      dueAt: AT + HOUR, members: 1, orderedMembers: 1 }];
    const covered = planDefense(amarr({ fleets: twoIdle(), operations: open, intruders: intruders([[INTRUDED, 1]]) }),
      null, IP, { targets: new Set() });
    assert.deepStrictEqual([covered.intents, covered.notes], [[], []], "an open defense on T: no second operation");
  });

  test("A7 hostile-fleets-loiter: no params.defense.intruders or no snapshot.intruders -> planDefense equal to "
    + "the result without the intruder loop", () => {
    const base = amarr({ fleets: twoIdle(), threats: claim(CLAIMED, 1) });
    const before = planDefense(base, null, PARAMS, { targets: new Set() });
    assert.strictEqual(launches(before).length, 1);
    assert.deepStrictEqual(planDefense(base, null, IP, { targets: new Set() }), before, "snapshot without intruders");
    const withItems = amarr({ fleets: twoIdle(), threats: claim(CLAIMED, 1), intruders: intruders([[INTRUDED, 1]]) });
    assert.deepStrictEqual(planDefense(withItems, null, PARAMS, { targets: new Set() }), before, "params off");
    const zero = { ...IP, defense: { ...IP.defense, intruders: { maxPerReview: 0 } } };
    assert.deepStrictEqual(planDefense(withItems, null, zero, { targets: new Set() }), before, "limit 0");
    assert.deepStrictEqual(planDefense(amarr({ fleets: twoIdle(), intruders: intruders([[INTRUDED, 1]]) }), null,
      PARAMS, { targets: new Set() }), { intents: [], notes: [], fleetIds: [], targets: [] }, "threats off, no loop");
  });

  test("A8 hostile-fleets-loiter: readIntrudersOf reads home + own held station systems (no CONTESTED "
    + "INVASION, no foreign row), counts hostile factions only, full page -> truncated; disabled -> null, no read", () => {
    const { readIntrudersOf } = require("../../lib/strategy/reviewService");
    const HOME = 30001954;
    const ST1 = 30001953;
    const CONT = 30001955;
    const FOREIGN = 30001956;
    const ALLY = 500999;
    const rows = new Map([[HOME, { controllerFactionId: AMARR, occupationState: "STABLE" }],
      [ST1, { controllerFactionId: AMARR, occupationState: "STABLE" }],
      [CONT, { controllerFactionId: AMARR, occupationState: "CONTESTED" }],
      [FOREIGN, { controllerFactionId: SANSHA, occupationState: "STABLE" }]]);
    const x = (factionId) => ({ factionId, composition: COMP });
    const calls = [];
    const repository = { listFleetsInSystems: (db, ids, o) => {
      calls.push({ ids, o });
      return { ok: true, bySystem: new Map([[HOME, [x(SANSHA), x(ALLY)]], [ST1, [x(SERPENTIS), x(SANSHA)]]]) };
    } };
    const spec = { enabled: true, factionId: AMARR, homeSystemId: HOME, stationSystemIds: [FOREIGN, CONT, ST1, HOME, ST1],
      rows, isHostile: (f) => f === SANSHA || f === SERPENTIS, repository, powerTable: POWER, maxSystems: 8,
      limitPerSystem: 2 };
    const r = readIntrudersOf({}, spec);
    assert.deepStrictEqual(calls.map((c) => [c.ids, c.o.limitPerSystem]), [[[HOME, ST1], 2]]);
    const one = strengthOf(COMP, POWER);
    assert.deepStrictEqual(r, { ok: true, intruders: { mode: "ready", truncated: true, items: [
      { systemId: HOME, hostileStrength: one, hostileFleets: 1, factionIds: [SANSHA] },
      { systemId: ST1, hostileStrength: 2 * one, hostileFleets: 2, factionIds: [SANSHA, SERPENTIS] }] } });
    calls.length = 0;
    assert.deepStrictEqual(readIntrudersOf({}, { ...spec, maxSystems: 1, limitPerSystem: 3 }).intruders.items
      .map((i) => i.systemId), [HOME]);
    assert.deepStrictEqual(calls[0].ids, [HOME], "home first, cut to maxSystems");
    const HS = 30001957;
    rows.set(HS, { controllerFactionId: AMARR, occupationState: "STABLE" });
    calls.length = 0;
    readIntrudersOf({}, { ...spec, hostileStations: new Map([[FOREIGN, 1], [CONT, 2], [HS, 1], [ST1, 1],
      [30001958, 0]]) });
    assert.deepStrictEqual(calls[0].ids, [HOME, ST1, HS], "home, own stations, then hostile station systems");
    calls.length = 0;
    readIntrudersOf({}, { ...spec });
    assert.deepStrictEqual(calls[0].ids, [HOME, ST1], "no hostileStations map: as before");
    calls.length = 0;
    assert.deepStrictEqual(readIntrudersOf({}, { ...spec, enabled: false }), { ok: true, intruders: null });
    assert.strictEqual(calls.length, 0, "flag off: no read");
    const refused = readIntrudersOf({}, { ...spec, repository: { listFleetsInSystems: () => ({ ok: false,
      reason: "DB_ERROR" }) } });
    assert.deepStrictEqual(refused, { ok: false, reason: "DB_ERROR" });
  });

  const { harness: H } = require("../battle/settlement.test");
  const driver = H.loadDriver();
  const A9 = "A9 hostile-fleets-loiter: the real review with strategy.intruderDefenseEnabled reads "
    + "a hostile fleet in an own held station system into snapshot.intruders; off -> no key";
  const A10 = "A10 hostile fleets loitering: J-CIJV shape in the real review - a Sansha-held system "
    + "(not home, no Sansha station) with a live hostile Amarr station and an IDLE Amarr fleet is in rows and in "
    + "intruders; an IDLE Sansha defender next door -> DEFENSE_INTRUDER_LAUNCH";
  if (!driver.ok) {
    if (typeof skip === "function") {
      skip(A9, `better-sqlite3 unavailable (${driver.detail})`);
      skip(A10, `better-sqlite3 unavailable (${driver.detail})`);
    }
  } else {
    const { harness: R } = require("./review.test");
    const { createManualClock } = require("../../lib/util/clock");
    const { createIdGenerator } = require("../../lib/util/ids");
    let graphR = null;
    const J = R.THEATRE[0];
    const run = (flag, o = {}) => H.withStore(driver, async (reopen) => {
      graphR = graphR || R.graphOf();
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph: graphR,
        controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
      const snaps = [];
      const decisions = [];
      const hooks = { beforeEffect: (d, s) => {
        if (d.factionId === R.SANSHA) {
          snaps.push(s);
          decisions.push(d);
        }
        return d;
      } };
      const owner = o.stationOwner || R.SANSHA;
      const active = [...new Set([R.SANSHA, owner])].join(",");
      const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: active,
        EVEJS_LNE_STRATEGY_INTRUDER_DEFENSE_ENABLED: flag }, { hooks });
      const created = env.tx((db) => env.stations.repository.createStation(db, { stationId: "a9-st", kind: "upwell",
        typeId: 35832, structureFamily: "astrahus", systemId: J, ownerFactionId: owner,
        ownerCorporationId: env.strategy.registry.getFaction(owner).ownerCorporationId, origin: "built",
        at: clock.now() }, "a9:station"));
      assert.ok(created.ok, JSON.stringify(created));
      const intruder = env.fleets.createFleet({ factionId: R.AMARR, currentSystemId: J, homeSystemId: J,
        fleetRole: "invasion", composition: COMP }, "a9:intruder");
      assert.ok(intruder.ok, JSON.stringify(intruder));
      if (o.defenderIn) {
        const def = env.fleets.createFleet({ factionId: R.SANSHA, currentSystemId: o.defenderIn,
          homeSystemId: o.defenderIn, fleetRole: "invasion",
          composition: [{ hullGroup: "battleship", typeId: null, count: 10 }] }, "a9:defender");
        assert.ok(def.ok, JSON.stringify(def));
      }
      await R.passesAt(env, shared, R.START_MS + R.I);
      env.strategy.stop("test");
      assert.ok(snaps.length >= 1, "a Sansha round ran");
      return { snap: snaps[0], decision: decisions[0] };
    });

    test(A10, async () => {
      graphR = graphR || R.graphOf();
      const next = (graphR.getNeighbors(J) || []).filter((id) => R.THEATRE.includes(id)).sort((a, b) => a - b)[0];
      assert.ok(Number.isSafeInteger(next), "a theatre neighbour of J");
      const { snap, decision } = await run("1", { stationOwner: R.AMARR, defenderIn: next });
      assert.notStrictEqual(snap.faction.homeSystemId, J, "J is not the Sansha home");
      assert.ok(!snap.stations.some((s) => s.systemId === J), "no Sansha station in J");
      const rowJ = snap.systems.find((s) => s.systemId === J);
      assert.ok(rowJ && rowJ.controllerFactionId === R.SANSHA && rowJ.hostileStations > 0, JSON.stringify(rowJ));
      const item = snap.intruders.items.find((i) => i.systemId === J);
      assert.ok(item && item.factionIds.includes(R.AMARR), JSON.stringify(snap.intruders));
      assert.ok(decision.notes.includes(`DEFENSE_INTRUDER_LAUNCH:${J}`), decision.notes.join());
      const launch = decision.intents.find((i) => i.type === "LAUNCH" && i.kind === "defense"
        && i.target.systemId === J);
      assert.ok(launch, JSON.stringify(decision.intents));
      const off = await run("0", { stationOwner: R.AMARR, defenderIn: next });
      assert.ok(!("intruders" in off.snap), "flag off: no snapshot key");
      assert.ok(!off.decision.notes.some((n) => n.startsWith("DEFENSE_INTRUDER_")), off.decision.notes.join());
    });

    test(A9, async () => {
      const off = (await run("0")).snap;
      assert.ok(!("intruders" in off), "flag off: no snapshot key");
      const on = (await run("1")).snap;
      assert.strictEqual(on.intruders && on.intruders.mode, "ready", JSON.stringify(on.intruders));
      const item = on.intruders.items.find((i) => i.systemId === J);
      assert.ok(item && item.hostileFleets === 1 && item.factionIds.includes(R.AMARR), JSON.stringify(on.intruders));
    });
  }
};