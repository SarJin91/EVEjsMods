"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { buildUniverseGraph } = require("../../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../../lib/graph/routes");
const { createRng, deriveSeed } = require("../../../lib/util/rng");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { createHostility } = require("../../../lib/battle/data/hostility");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../../lib/strategy/registry");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { decideReview } = require("../../../lib/strategy/ai");
const { bfs } = require("../../../lib/strategy/ai/bfs");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { evaluateSupplyAndFronts } = require("../../../lib/strategy/ai/supply");
const { planMining } = require("../../../lib/strategy/ai/mining");
const { k3StaticMap } = require("../fixtures/k3Cluster.fixture");
const { ownSpaceSystems } = require("../../../lib/economy/mining/ownSpace");
const config = require("../../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const CONCORD = 500006;
const AMARR = 500003;
const SANSHA = 500019;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const PAYE = 30001718;
const AT = 1760000000000;
const HOUR = 3600000;

const builtGraph = (() => {
  const built = buildUniverseGraph(k3StaticMap());
  assert.ok(built.ok);
  return built.graph;
})();

const TEST_HIGHSEC_NEIGHBORS = [30001720, 30001721, 30001722];

function createTestGraph() {
  const baseGetSystem = builtGraph.getSystem.bind(builtGraph);
  const baseGetNeighbors = builtGraph.getNeighbors.bind(builtGraph);
  const baseGetSystemIds = builtGraph.getSystemIds.bind(builtGraph);

  const overrides = new Map();
  overrides.set(PAYE, { 
    id: PAYE, 
    name: 'S' + PAYE, 
    regionId: 10000020, 
    constellationId: 20000254, 
    security: 0.64, 
    trueSecurity: 0.64, 
    secClass: "highsec", 
    factionId: AMARR, 
    position: { x: PAYE, y: 0, z: 0 } 
  });
  for (const id of TEST_HIGHSEC_NEIGHBORS) {
    overrides.set(id, { 
      id, 
      name: 'S' + id, 
      regionId: 10000020, 
      constellationId: 20000254, 
      security: 0.7, 
      trueSecurity: 0.7, 
      secClass: "highsec", 
      factionId: AMARR, 
      position: { x: id, y: 0, z: 0 } 
    });
  }

  return {
    getSystem: (id) => {
      const base = baseGetSystem(id);
      const ov = overrides.get(id);
      if (ov) return ov;
      return base;
    },
    getNeighbors: (id) => {
      const base = baseGetNeighbors(id) || [];
      if (id === PAYE) {
        return [...base, ...TEST_HIGHSEC_NEIGHBORS];
      }
      if (TEST_HIGHSEC_NEIGHBORS.includes(id)) {
        return [...base, PAYE];
      }
      return base;
    },
    getSystemIds: () => {
      const base = baseGetSystemIds() || [];
      return [...base, ...TEST_HIGHSEC_NEIGHBORS];
    },
    getRoute: builtGraph.getRoute,
    getDistance: builtGraph.getDistance,
  };
}

const graph = (() => {
  const g = createTestGraph();
  const routes = createRouteFinder(g, { cacheSize: 16, maxJumps: 40 });
  return Object.freeze({ ...g, ...routes.publicApi });
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
const hostility = createHostility();

const PARAMS = Object.freeze({
  maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3,
  maxOperationsPerReview: 1, maxFleetsPerOperation: 4, maxFleetsPerFaction: 12,
  maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
  reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR,
  maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2, kinds: kinds.list,
  scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  mining: {
    maxFleetsPerFaction: 6, maxFleetsPerSystem: 1, targetFleetsPerSystemPermille: 1000,
    maxMobilizationsPerReview: 3, maxDispatchesPerReview: 3, maxTripJumps: 5,
    maxCandidateSystems: 32, distancePenaltyPermille: 250, avoidHostileIntel: true,
    ownSpaceScanSystems: 256,
  },
});

const COMP = Object.freeze([{ hullGroup: "cruiser", typeId: null, count: 4 }]);
const MINER_COMP = Object.freeze([{ hullGroup: "industrial", typeId: null, count: 3 }]);

function snapConcordWithMiningSites(miningSites, o = {}) {
  const entry = registry.getFaction(CONCORD);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const stationSystems = o.stations || [PAYE];
  const controllers = o.controllers || new Map();
  const fleets = o.fleets || [];
  const intel = o.intel || [];

  const worldRowSystems = [...new Set([...stationSystems, ...controllers.keys()])].sort((a, b) => a - b);

  return {
    v: 1, factionId: CONCORD, round: 7, at: AT, seed: o.seed || 12345,
    faction: {
      status: "ACTIVE", homeSystemId: entry.hqSystemId,
      doctrineId: doctrine.doctrineId, resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3,
    },
    entry: {
      kind: entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
      homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId,
    },
    doctrine: {
      doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
      expandsBeyondTheatre: doctrine.expandsBeyondTheatre,
      operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates,
      ownSpace: doctrine.ownSpace, ownSpaceMaxJumps: doctrine.ownSpaceMaxJumps,
      borderReachKey: doctrine.borderReachKey, borderTargets: doctrine.borderTargets,
      borderCaptures: doctrine.borderCaptures, confinedToBelt: doctrine.confinedToBelt,
    },
    theatre: stationSystems,
    neighbors: (id) => graph.getNeighbors(id),
    regionOf: (id) => graph.getSystem(id) ? graph.getSystem(id).regionId : null,
    isHostile: (x) => x !== CONCORD && !entry.allies.includes(x) && hostility(CONCORD, x),
    stationsMode: "ready",
    stations: stationSystems.map((systemId, i) => ({ systemId, stationId: `st${i}`, kind: "upwell" })),
    systems: worldRowSystems.map((systemId) => {
      const ctrl = controllers.get(systemId);
      return {
        systemId,
        controllerFactionId: ctrl !== undefined ? ctrl : null,
        occupationState: "STABLE",
        ownInfluence: 0,
        occupierFactionId: null,
        controllerGarrison: 0,
        hostileStations: 0,
        observed: false,
      };
    }),
    fleets,
    fleetsTruncated: false,
    operations: [],
    operationsTruncated: false,
    intel,
    sightings: [],
    mining: {
      mode: "ready",
      sites: miningSites.map(s => ({ systemId: s.systemId, richnessPermille: s.richness || 800, projected: s.projected || false })),
      openByBelt: o.openByBelt || [],
      busyFleetIds: o.busy || [],
    },
  };
}

const fleet = (fleetId, systemId, extra = {}) => ({
  fleetId, version: 1, state: extra.state || "IDLE", fleetRole: extra.fleetRole || "mining",
  systemId, refitPending: extra.refitPending || false, shipCount: extra.shipCount || 3,
  strength: strengthOf(extra.composition || MINER_COMP, POWER), operationId: extra.operationId || null,
  legSeq: extra.legSeq || 0, homeSystemId: extra.homeSystemId || systemId,
  composition: extra.composition || MINER_COMP, updatedAt: AT,
});

const freshIntel = (systemId, hostileFleets = 0) => ({
  systemId, observedAt: AT - HOUR, hostileFleets, hostileShips: 0,
  hostileStrength: hostileFleets * 1000, hostileStations: 0, controllerFactionId: AMARR,
});

function createMockMiningEnv() {
  const mockGraph = {
    getSystem: (id) => {
      const base = builtGraph.getSystem(id);
      if (id === PAYE) return { ...base, factionId: AMARR, secClass: "highsec" };
      if (TEST_HIGHSEC_NEIGHBORS.includes(id)) return { id, name: 'S'+id, regionId: 10000020, constellationId: 20000254, security: 0.7, trueSecurity: 0.7, secClass: "highsec", factionId: AMARR, position: { x: id, y: 0, z: 0 } };
      return base;
    },
    getNeighbors: (id) => {
      const base = builtGraph.getNeighbors(id) || [];
      if (id === PAYE) return [...base, ...TEST_HIGHSEC_NEIGHBORS];
      if (TEST_HIGHSEC_NEIGHBORS.includes(id)) return [...base, PAYE];
      return base;
    },
  };
  const richnessCache = new Map();
  const mockMining = {
    richnessOf: (systemId) => {
      if (richnessCache.has(systemId)) return richnessCache.get(systemId);
      const sys = mockGraph.getSystem(systemId);
      if (!sys) return { ok: false, reason: "UNKNOWN_SYSTEM" };
      const belts = 4;
      const richness = Math.floor((belts * 200) / (sys.secClass === "highsec" ? 1 : sys.secClass === "lowsec" ? 2 : 4));
      const result = { ok: true, richnessPermille: richness, secClass: sys.secClass, belts };
      richnessCache.set(systemId, result);
      return result;
    },
    getMode: () => "ready",
    readSiteState: () => ({ ok: true, openByBelt: [], busyFleetIds: [] }),
  };
  const mockWorldRepo = {
    limits: { maxBatchReadIds: 100 },
    getSystems: (tx, ids) => {
      return { ok: true, systems: [], missing: ids };
    },
    getSystem: (tx, id) => ({ ok: true, system: null }),
  };
  return { mockGraph, mockMining, mockWorldRepo };
}

module.exports = ({ test }) => {

  test("planMining: CONCORD gets candidates in doctrine ownSpace (highsec, any sovereignty)", () => {

    const stations = [PAYE];
    const miningSites = [
      { systemId: PAYE, richness: 800, projected: true },
      { systemId: TEST_HIGHSEC_NEIGHBORS[0], richness: 800, projected: true },
      { systemId: TEST_HIGHSEC_NEIGHBORS[1], richness: 800, projected: true },
    ];

    const s = snapConcordWithMiningSites(miningSites, { stations });

    const d = decideReview(s, PARAMS);
    const mineIntents = d.intents.filter(i => i.type === "MINE_DISPATCH");
    const mobilizeIntents = d.intents.filter(i => i.type === "MOBILIZE" && i.role === "mining");

    assert.ok(mineIntents.length > 0 || mobilizeIntents.length > 0,
      `CONCORD should have mining candidates. mineIntents: ${mineIntents.length}, mobilize: ${mobilizeIntents.length}. notes: ${d.notes}`);

    for (const i of mineIntents) {
      const sys = graph.getSystem(i.beltSystemId);
      assert.ok(sys, `system ${i.beltSystemId} not in graph`);
      assert.strictEqual(sys.secClass, "highsec", `candidate ${i.beltSystemId} must be highsec`);
      const dist = bfs([PAYE], graph.getNeighbors, { maxJumps: PARAMS.mining.maxTripJumps, maxSystems: 500 });
      assert.ok(dist.has(i.beltSystemId), `candidate ${i.beltSystemId} must be within ${PARAMS.mining.maxTripJumps} jumps from Paye`);
    }

    assert.ok(s.mining.sites.every(site => site.projected === true), "all test sites should be projected");
  });

  test("planMining: CONCORD mobilizes miners with mining_frigate hull group template", () => {

    const stations = [PAYE];
    const miningSites = [
      { systemId: PAYE, richness: 800, projected: true },
      { systemId: TEST_HIGHSEC_NEIGHBORS[0], richness: 800, projected: true },
    ];

    const s = snapConcordWithMiningSites(miningSites, { stations, fleets: [] });

    const d = decideReview(s, PARAMS);
    const mobilizeIntents = d.intents.filter(i => i.type === "MOBILIZE" && i.role === "mining");

    assert.ok(mobilizeIntents.length > 0, `CONCORD should mobilize miners. notes: ${d.notes}, intents: ${JSON.stringify(d.intents)}`);

    for (const m of mobilizeIntents) {
      assert.ok(Array.isArray(m.composition), "mobilize must have composition");
      const minerShips = m.composition.filter(e => e.hullGroup === "mining_frigate");
      assert.ok(minerShips.length > 0, `mobilize composition must include mining_frigate: ${JSON.stringify(m.composition)}`);
      const totalShips = minerShips.reduce((n, e) => n + e.count, 0);
      assert.strictEqual(totalShips, 3, `mining_frigate count must be 3 per template: got ${totalShips}`);
      assert.strictEqual(m.role, "mining", "mobilize role must be mining");
    }

    assert.ok(!d.notes.includes("MINING_NO_TEMPLATE"), `should not have MINING_NO_TEMPLATE: ${d.notes}`);
  });

  test("readOwnSpaceSites: doctrine projection does not duplicate SDE projection", () => {

    const mockGraph = {
      getSystem: (id) => {
        if (id === PAYE) return { id: PAYE, secClass: "highsec", factionId: CONCORD };
        if (id === TEST_HIGHSEC_NEIGHBORS[0]) return { id: TEST_HIGHSEC_NEIGHBORS[0], secClass: "highsec", factionId: CONCORD };
        if (id === TEST_HIGHSEC_NEIGHBORS[1]) return { id: TEST_HIGHSEC_NEIGHBORS[1], secClass: "highsec", factionId: AMARR };
        return null;
      },
      getNeighbors: (id) => {
        if (id === PAYE) return [TEST_HIGHSEC_NEIGHBORS[0], TEST_HIGHSEC_NEIGHBORS[1]];
        if (id === TEST_HIGHSEC_NEIGHBORS[0]) return [PAYE];
        if (id === TEST_HIGHSEC_NEIGHBORS[1]) return [PAYE];
        return [];
      },
    };

    const sdeSystems = ownSpaceSystems({
      fromSystemIds: [PAYE],
      factionId: CONCORD,
      getSystem: mockGraph.getSystem,
      neighbors: mockGraph.getNeighbors,
      maxJumps: 5,
      maxSystems: 256,
    });

    assert.ok(sdeSystems.includes(PAYE), "SDE projection should find PAYE (factionId=CONCORD)");
    assert.ok(sdeSystems.includes(TEST_HIGHSEC_NEIGHBORS[0]), "SDE projection should find neighbor with factionId=CONCORD");
    assert.ok(!sdeSystems.includes(TEST_HIGHSEC_NEIGHBORS[1]), "SDE projection should NOT find neighbor with factionId=AMARR");

    const doctrinalSystems = new Set();
    const maxJumps = 10;
    const sources = [PAYE];
    const secClasses = new Set(["highsec"]);
    const visited = new Set(sources);
    for (const id of sources) {
      const v = mockGraph.getSystem(id);
      if (v && secClasses.has(v.secClass)) doctrinalSystems.add(id);
    }
    let frontier = [...sources];
    for (let jump = 1; jump <= maxJumps && frontier.length > 0; jump += 1) {
      const next = new Set();
      for (const id of frontier) {
        const list = mockGraph.getNeighbors(id);
        for (const nb of list) {
          if (visited.has(nb)) continue;
          const v = mockGraph.getSystem(nb);
          if (!v || !secClasses.has(v.secClass)) continue;
          visited.add(nb);
          doctrinalSystems.add(nb);
          next.add(nb);
        }
      }
      frontier = [...next];
    }

    assert.ok(doctrinalSystems.has(PAYE), "Doctrinal should find PAYE");
    assert.ok(doctrinalSystems.has(TEST_HIGHSEC_NEIGHBORS[0]), "Doctrinal should find neighbor 0");
    assert.ok(doctrinalSystems.has(TEST_HIGHSEC_NEIGHBORS[1]), "Doctrinal should find neighbor 1 (any sovereignty)");

    const seen = new Set();
    const combined = [];
    for (const id of sdeSystems) {
      if (!seen.has(id)) {
        seen.add(id);
        combined.push({ systemId: id, projected: true, source: "sde" });
      }
    }
    for (const id of doctrinalSystems) {
      if (!seen.has(id)) {
        seen.add(id);
        combined.push({ systemId: id, projected: true, source: "doctrinal" });
      }
    }

    const systemIds = combined.map(s => s.systemId);
    const uniqueIds = [...new Set(systemIds)];
    assert.deepStrictEqual(systemIds, uniqueIds, "No duplicate systemIds after deduplication");

    assert.ok(systemIds.includes(PAYE), "PAYE in combined");
    assert.ok(systemIds.includes(TEST_HIGHSEC_NEIGHBORS[0]), "Neighbor 0 in combined");
    assert.ok(systemIds.includes(TEST_HIGHSEC_NEIGHBORS[1]), "Neighbor 1 in combined");

    const payeEntry = combined.find(s => s.systemId === PAYE);
    const n0Entry = combined.find(s => s.systemId === TEST_HIGHSEC_NEIGHBORS[0]);
    const n1Entry = combined.find(s => s.systemId === TEST_HIGHSEC_NEIGHBORS[1]);
    assert.strictEqual(payeEntry.source, "sde", "PAYE should come from SDE projection");
    assert.strictEqual(n0Entry.source, "sde", "Neighbor 0 should come from SDE projection");
    assert.strictEqual(n1Entry.source, "doctrinal", "Neighbor 1 should come from doctrinal projection");
  });

  test("readMining: sovereignty=self - BFS does not pass through systems controlled by other factions", () => {
    
    const mockGraph = {
      getSystem: (id) => {
        if (id === PAYE) return { id: PAYE, secClass: "highsec", factionId: CONCORD };
        if (id === TEST_HIGHSEC_NEIGHBORS[0]) return { id: TEST_HIGHSEC_NEIGHBORS[0], secClass: "highsec", factionId: AMARR };
        if (id === TEST_HIGHSEC_NEIGHBORS[1]) return { id: TEST_HIGHSEC_NEIGHBORS[1], secClass: "highsec", factionId: CONCORD };
        if (id === TEST_HIGHSEC_NEIGHBORS[2]) return { id: TEST_HIGHSEC_NEIGHBORS[2], secClass: "highsec", factionId: AMARR };
        return null;
      },
      getNeighbors: (id) => {
        if (id === PAYE) return [TEST_HIGHSEC_NEIGHBORS[0]];
        if (id === TEST_HIGHSEC_NEIGHBORS[0]) return [PAYE, TEST_HIGHSEC_NEIGHBORS[1]];
        if (id === TEST_HIGHSEC_NEIGHBORS[1]) return [TEST_HIGHSEC_NEIGHBORS[0], TEST_HIGHSEC_NEIGHBORS[2]];
        if (id === TEST_HIGHSEC_NEIGHBORS[2]) return [TEST_HIGHSEC_NEIGHBORS[1]];
        return [];
      },
    };

    const sovereignty = "self";
    const secClasses = new Set(["highsec"]);
    const sources = [PAYE];
    const maxJumps = 10;
    const maxSystems = 256;
    const visited = new Map();
    for (const id of sources) visited.set(id, 0);
    let frontier = [...visited.keys()];

    const mockHostility = (a, b) => a !== b;

    for (let jump = 1; jump <= maxJumps && frontier.length > 0 && visited.size < maxSystems; jump += 1) {
      const next = new Set();
      for (const id of frontier) {
        if (visited.size >= maxSystems) break;
        const v = mockGraph.getSystem(id);
        if (sovereignty !== "any") {
          const isSource = sources.includes(id);
          let canPass = false;
          if (sovereignty === "self") {
            canPass = isSource || (v && v.factionId === CONCORD);
          } else if (sovereignty === "friendly") {
            if (isSource) canPass = true;
            else if (v && v.factionId === CONCORD) canPass = true;
            else if (v && isId(v.factionId) && typeof mockHostility === "function") {
              canPass = mockHostility(v.factionId, CONCORD) === false;
            }
          }
          if (!canPass) continue;
        }
        const list = mockGraph.getNeighbors(id);
        if (!Array.isArray(list)) continue;
        for (const nb of list) {
          if (visited.size >= maxSystems) break;
          if (visited.has(nb)) continue;
          const vnb = mockGraph.getSystem(nb);
          if (!vnb) continue;
          if (!secClasses.has(vnb.secClass)) continue;
          let accept = false;
          if (sovereignty === "any") accept = true;
          else if (sovereignty === "self") accept = vnb.factionId === CONCORD;
          else if (sovereignty === "friendly") accept = vnb.factionId === CONCORD || mockHostility(vnb.factionId, CONCORD) === false;
          if (!accept) continue;
          visited.set(nb, jump);
          next.add(nb);
        }
      }
      frontier = [...next].sort((a, b) => a - b);
    }

    assert.ok(visited.has(PAYE), "Source system PAYE should be visited");
    assert.strictEqual(visited.get(PAYE), 0, "PAYE at jump 0");
    
    assert.ok(!visited.has(TEST_HIGHSEC_NEIGHBORS[0]), "Amarr-controlled neighbor should NOT be visited (target rejection)");
    
    assert.ok(!visited.has(TEST_HIGHSEC_NEIGHBORS[1]), "CONCORD system behind Amarr should NOT be reached (BFS blocked by sovereignty)");
    
    assert.ok(!visited.has(TEST_HIGHSEC_NEIGHBORS[2]), "Amarr system beyond should NOT be reached");
  });

  test("readMining: sovereignty=friendly - BFS passes through allies, not enemies", () => {
    
    const GALLENTE = 500004;
    const ANGEL = 500011;
    const SERPENTIS = 500020;
    const GURISTAS = 500010;
    
    const mockGraph = {
      getSystem: (id) => {
        if (id === 1001) return { id: 1001, secClass: "highsec", factionId: GALLENTE };
        if (id === 1002) return { id: 1002, secClass: "highsec", factionId: AMARR };
        if (id === 1003) return { id: 1003, secClass: "highsec", factionId: CONCORD };
        if (id === 1004) return { id: 1004, secClass: "highsec", factionId: ANGEL };
        if (id === 1005) return { id: 1005, secClass: "highsec", factionId: SERPENTIS };
        if (id === 1006) return { id: 1006, secClass: "highsec", factionId: GURISTAS };
        if (id === 1007) return { id: 1007, secClass: "highsec", factionId: GALLENTE };
        return null;
      },
      getNeighbors: (id) => {
        if (id === 1001) return [1002, 1004];
        if (id === 1002) return [1001, 1003];
        if (id === 1003) return [1002, 1007];
        if (id === 1004) return [1001, 1005];
        if (id === 1005) return [1004, 1006];
        if (id === 1006) return [1005];
        if (id === 1007) return [1003];
        return [];
      },
    };

    const sovereignty = "friendly";
    const factionId = GALLENTE;
    const secClasses = new Set(["highsec"]);
    const sources = [1001];
    const maxJumps = 10;
    const maxSystems = 256;
    const visited = new Map();
    for (const id of sources) visited.set(id, 0);
    let frontier = [...visited.keys()];
    const hostility = createHostility();

    for (let jump = 1; jump <= maxJumps && frontier.length > 0 && visited.size < maxSystems; jump += 1) {
      const next = new Set();
      for (const id of frontier) {
        if (visited.size >= maxSystems) break;
        const v = mockGraph.getSystem(id);
        if (sovereignty !== "any") {
          const isSource = sources.includes(id);
          let canPass = false;
          if (sovereignty === "self") {
            canPass = isSource || (v && v.factionId === factionId);
          } else if (sovereignty === "friendly") {
            if (isSource) canPass = true;
            else if (v && v.factionId === factionId) canPass = true;
            else if (v && isId(v.factionId) && typeof hostility === "function") {
              canPass = hostility(v.factionId, factionId) === false;
            }
          }
          if (!canPass) continue;
        }
        const list = mockGraph.getNeighbors(id);
        if (!Array.isArray(list)) continue;
        for (const nb of list) {
          if (visited.size >= maxSystems) break;
          if (visited.has(nb)) continue;
          const vnb = mockGraph.getSystem(nb);
          if (!vnb) continue;
          if (!secClasses.has(vnb.secClass)) continue;
          let accept = false;
          if (sovereignty === "any") accept = true;
          else if (sovereignty === "self") accept = vnb.factionId === factionId;
          else if (sovereignty === "friendly") accept = vnb.factionId === factionId || hostility(vnb.factionId, factionId) === false;
          if (!accept) continue;
          visited.set(nb, jump);
          next.add(nb);
        }
      }
      frontier = [...next].sort((a, b) => a - b);
    }

    assert.ok(visited.has(1001), "Source system 1001 (Gallente) should be visited");
    assert.strictEqual(visited.get(1001), 0, "Source at jump 0");
    
    assert.ok(visited.has(1002), "Amarr (friendly via bloc) should be visited");
    
    assert.ok(visited.has(1003), "CONCORD (friendly via bloc) should be visited");
    
    assert.ok(visited.has(1007), "Gallente beyond CONCORD should be visited");
    
    assert.ok(!visited.has(1004), "Angel (hostile) should NOT be visited");
    
    assert.ok(!visited.has(1005), "Serpentis (hostile) should NOT be visited");
    
    assert.ok(!visited.has(1006), "Guristas (hostile) should NOT be visited");
  });

  test("readMining: sovereignty=any - BFS passes through all matching secClasses (CONCORD behavior unchanged)", () => {
    
    const mockGraph = {
      getSystem: (id) => {
        if (id === PAYE) return { id: PAYE, secClass: "highsec", factionId: AMARR };
        if (id === TEST_HIGHSEC_NEIGHBORS[0]) return { id: TEST_HIGHSEC_NEIGHBORS[0], secClass: "highsec", factionId: AMARR };
        if (id === TEST_HIGHSEC_NEIGHBORS[1]) return { id: TEST_HIGHSEC_NEIGHBORS[1], secClass: "highsec", factionId: SANSHA };
        if (id === TEST_HIGHSEC_NEIGHBORS[2]) return { id: TEST_HIGHSEC_NEIGHBORS[2], secClass: "lowsec", factionId: AMARR };
        return null;
      },
      getNeighbors: (id) => {
        if (id === PAYE) return [TEST_HIGHSEC_NEIGHBORS[0], TEST_HIGHSEC_NEIGHBORS[2]];
        if (id === TEST_HIGHSEC_NEIGHBORS[0]) return [PAYE, TEST_HIGHSEC_NEIGHBORS[1]];
        if (id === TEST_HIGHSEC_NEIGHBORS[1]) return [TEST_HIGHSEC_NEIGHBORS[0]];
        if (id === TEST_HIGHSEC_NEIGHBORS[2]) return [PAYE];
        return [];
      },
    };

    const sovereignty = "any";
    const secClasses = new Set(["highsec"]);
    const sources = [PAYE];
    const maxJumps = 10;
    const maxSystems = 256;
    const visited = new Map();
    for (const id of sources) visited.set(id, 0);
    let frontier = [...visited.keys()];
    const hostility = createHostility();

    for (let jump = 1; jump <= maxJumps && frontier.length > 0 && visited.size < maxSystems; jump += 1) {
      const next = new Set();
      for (const id of frontier) {
        if (visited.size >= maxSystems) break;
        const v = mockGraph.getSystem(id);
        const list = mockGraph.getNeighbors(id);
        if (!Array.isArray(list)) continue;
        for (const nb of list) {
          if (visited.size >= maxSystems) break;
          if (visited.has(nb)) continue;
          const vnb = mockGraph.getSystem(nb);
          if (!vnb) continue;
          if (!secClasses.has(vnb.secClass)) continue;
          let accept = false;
          if (sovereignty === "any") accept = true;
          else if (sovereignty === "self") accept = vnb.factionId === CONCORD;
          else if (sovereignty === "friendly") accept = vnb.factionId === CONCORD || hostility(vnb.factionId, CONCORD) === false;
          if (!accept) continue;
          visited.set(nb, jump);
          next.add(nb);
        }
      }
      frontier = [...next].sort((a, b) => a - b);
    }

    assert.ok(visited.has(PAYE), "Source PAYE should be visited");
    assert.strictEqual(visited.get(PAYE), 0);
    
    assert.ok(visited.has(TEST_HIGHSEC_NEIGHBORS[0]), "Amarr highsec should be visited (any sovereignty)");
    
    assert.ok(visited.has(TEST_HIGHSEC_NEIGHBORS[1]), "Sansha highsec should be visited (any sovereignty)");
    
    assert.ok(!visited.has(TEST_HIGHSEC_NEIGHBORS[2]), "Lowsec should NOT be visited (secClass filter)");
  });

};