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
const { decideReview } = require("../../lib/strategy/ai");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { chooseNextOperation } = require("../../lib/strategy/ai/operations");
const { planMining } = require("../../lib/strategy/ai/mining");
const { chooseTargetSystem, describe, countCaptureCandidates, candidateFacts, usableKinds, effectiveIntel } = require("../../lib/strategy/ai/targeting");
const { ownSpaceBelt, borderCandidates, isBorderTarget } = require("../../lib/strategy/ai/border");
const { createBorderIndex } = require("../../lib/strategy/border");
const { expansionCandidates, rangeCandidates } = require("../../lib/strategy/ai/expansion");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../../lib/strategy/data/expansion");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");
const { planProduction, hullTargets } = require("../../lib/strategy/ai/production");
const { buildProductionView } = require("../../lib/economy/production/productionView");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { planReplenish } = require("../../lib/strategy/ai/replenish");
const { planReturns, observationOrder, planLogisticsRetire } = require("../../lib/strategy/ai/housekeeping");
const { OBJECTIVE_MAP } = require("../../lib/battle/data/contactRules");
const { planLogistics } = require("../../lib/strategy/ai/logistics");
const { planTribute } = require("../../lib/strategy/ai/tribute");
const { planRelief } = require("../../lib/strategy/ai/relief");
const { abandonList } = require("../../lib/strategy/ai/upkeep");
const { planTerritoryTrim } = require("../../lib/strategy/ai/territoryTrim");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const HULL_TYPES = require("../../lib/economy/data/hullTradeTypes");
const { deferSells } = require("../../lib/strategy/ai/tradeSell");
const VOLUMES = require("../../lib/economy/data/cargoVolumes");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AMARR = 500003;
const CONCORD = 500006;
const SANSHA = 500019;
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
  routeMaxJumps: 40 });

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
      operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates },
    theatre: THEATRE,
    neighbors: (id) => graph.getNeighbors(id),
    regionOf: (id) => (graph.getSystem(id) ? graph.getSystem(id).regionId : null),
    isHostile: (x) => x !== factionId && !entry.allies.includes(x) && hostility(factionId, x),
    stationsMode: o.stationsMode || "ready",
    stations: (o.stations || [SAMINER]).map((systemId, i) => ({ systemId, stationId: `st${i}` })),
    systems: ids.map((systemId) => ({ systemId, controllerFactionId: controllers.has(systemId)
      ? controllers.get(systemId) : null, occupationState: "STABLE", controllerGarrison: (o.garrison || 0),
    hostileStations: 0, observed: false })),
    fleets: o.fleets || [], fleetsTruncated: false, operations: o.operations || [], operationsTruncated: false,
    intel: o.intel || [], sightings: o.sightings || [],
  };
}

const fleet = (fleetId, systemId, extra = {}) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "invasion",
  systemId, refitPending: false, shipCount: 4, strength: strengthOf(COMP, POWER), operationId: null, legSeq: 0,
  homeSystemId: systemId, ...extra });
const freshIntel = (systemId, strength = 0) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
  hostileStrength: strength, hostileStations: 0, controllerFactionId: SANSHA });
const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH");
const dist = (starts, max) => bfs(starts, (id) => graph.getNeighbors(id), { maxJumps: max, maxSystems: 5000 });

const PROD = Object.freeze({ maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });
const times = (g, n) => Object.fromEntries(Object.entries(RECIPES.GROUPS[g].minerals).map(([k, v]) => [k, v * n]));
const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
const prodOf = (stations, extra = {}) => ({ mode: "ready", recipesVersion: 1, recipes, inProduction: {},
  activeJobsTotal: 0, truncated: false, stations, ...extra });
const st = (stationId, systemId, minerals, hulls = {}) => ({ stationId, systemId, kind: "npc", lines: 2,
  activeJobs: [], minerals, hulls });

module.exports = ({ test }) => {
  test("T1 reach fuzz: 200 snapshots, every target in theatre and reach, every fleet in assembly range; no base -> NO_ANCHOR", () => {
    const rng = createRng(20261017);
    let launched = 0;
    for (let n = 0; n < 200; n += 1) {
      const factionId = rng.chance(0.5) ? AMARR : SANSHA;
      const controllers = new Map(THEATRE.map((id) => [id, rng.pick([SANSHA, SANSHA, AMARR, null])]));
      const stations = factionId === AMARR ? [SAMINER] : [30001868, rng.pick(THEATRE)];
      const fleets = [];
      for (let i = 0; i < rng.nextInt(0, 5); i += 1) {
        fleets.push(fleet(`f${n}-${i}`, rng.pick([...THEATRE, SAMINER]), { fleetRole: rng.pick(["scout", "invasion",
          "patrol"]), state: rng.pick(["IDLE", "IDLE", "TRAVELLING"]), refitPending: rng.chance(0.2) }));
      }
      const intel = THEATRE.filter(() => rng.chance(0.3)).map((id) => freshIntel(id, rng.nextInt(0, 20000)));
      const s = snap(factionId, { controllers, stations, fleets, intel, stationsMode: rng.pick(["ready", "off"]),
        seed: rng.nextUint32() });
      const d = decideReview(s, PARAMS);
      assert.strictEqual(d.outcome, "REVIEWED", JSON.stringify(d.reason));
      const reach = dist(d.supply.anchors, d.supply.reachJumps);
      const own = new Set(s.stationsMode === "ready" ? stations : []);
      for (const l of launches(d)) {
        launched += 1;
        const T = l.target.systemId;
        assert.ok(THEATRE.includes(T), `theatre ${T}`);
        assert.ok(reach.has(T), `reach ${T}`);
        const c = controllers.get(T);
        assert.ok(c !== factionId && (c === null || s.isHostile(c)), `controller ${c}`);
        if (l.kind === "invasion") assert.ok(dist([...own], PARAMS.captureRangeFromStationJumps).has(T), "D46");
        const fromT = dist([T], PARAMS.maxAssemblyJumps);
        for (const f of l.fleets) {
          const rec = fleets.find((x) => x.fleetId === f.fleetId);
          assert.ok(fromT.has(rec.systemId) && rec.refitPending !== true, `fleet ${f.fleetId}`);
        }
        for (const m of l.mobilize) assert.ok(fromT.has(m.systemId), "staging in assembly range");
      }
    }
    assert.ok(launched > 50, `launches ${launched}`);
    const noBase = snap(AMARR, { home: null, stationsMode: "off" });
    const supply = evaluateSupplyAndFronts(noBase, PARAMS);
    assert.deepStrictEqual(chooseTargetSystem(noBase, supply, PARAMS, createRng(1)),
      { ok: false, reason: "NO_ANCHOR" });
  });

  test("T2 front limit + refit_pending: limit reached -> no LAUNCH/MOBILIZE (housekeeping runs), limit - 1 -> one LAUNCH, recon is a front", () => {
    const op = (operationId, targetSystemId) => ({ operationId, version: 2, state: "ACTIVE", operationType: "recon",
      targetSystemId, dueAt: AT + HOUR, members: 1, orderedMembers: 1 });
    const scoutOf = (opId, systemId) => fleet(`s-${opId}`, systemId, { fleetRole: "scout", state: "TRAVELLING",
      operationId: opId });
    const stranded = fleet("z-stranded", 30001954, { fleetRole: "scout", refitPending: true, legSeq: 4 });
    const base = { frontLimit: 2, maxActiveFronts: 2 };
    const full = snap(AMARR, { ...base, operations: [op("op-a", 30001954), op("op-b", 30001953)],
      fleets: [scoutOf("op-a", SAMINER), scoutOf("op-b", SAMINER), stranded] });
    const d = decideReview(full, PARAMS);
    assert.deepStrictEqual([d.supply.frontCount, d.supply.frontLimit], [2, 2]);
    assert.deepStrictEqual(d.intents.filter((i) => ["LAUNCH", "MOBILIZE"].includes(i.type)), []);
    assert.ok(d.notes.includes("FRONT_LIMIT"));
    assert.deepStrictEqual(d.intents.filter((i) => i.type === "REQUEST_REFIT").map((i) => [i.fleetId, i.legSeq]),
      [["z-stranded", 4]]);
    const one = snap(AMARR, { ...base, operations: [op("op-a", 30001954)],
      fleets: [scoutOf("op-a", SAMINER), stranded] });
    const d1 = decideReview(one, PARAMS);
    const l = launches(d1);
    assert.strictEqual(l.length, 1, JSON.stringify(d1.notes));
    assert.notStrictEqual(l[0].target.systemId, 30001954, "a front is not a new target");
    assert.ok(!l[0].fleets.some((f) => f.fleetId === "z-stranded"), "refit_pending never in an offensive kind");
    assert.strictEqual(l[0].kind, "recon");
  });

  test("T3 repeatability + purity: same snapshot + seed -> deepStrictEqual; seed only changes the top-K pick; lib/strategy/ai requires", () => {
    const s = snap(AMARR, { intel: [freshIntel(30001954)] });
    assert.deepStrictEqual(decideReview(s, PARAMS), decideReview(snap(AMARR, { intel: [freshIntel(30001954)] }), PARAMS));
    const targets = new Set();
    let supply = null;
    for (let seed = 1; seed <= 60; seed += 1) {
      const d = decideReview(snap(AMARR, { seed: deriveSeed(seed, "t3") }), PARAMS);
      targets.add(d.target.systemId);
      if (supply === null) supply = d.supply;
      assert.deepStrictEqual(d.supply, supply);
      const one = decideReview(snap(AMARR, { seed: deriveSeed(seed, "t3") }), { ...PARAMS, targetPickTopK: 1 });
      assert.strictEqual(one.target.systemId, 30001954, "top 1 is seed independent");
    }
    assert.ok(targets.size > 1 && targets.size <= 3, [...targets].join(","));
    const dir = path.join(MOD_DIR, "lib", "strategy", "ai");
    const bad = [];
    for (const name of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
        if (!/^\.\/|^\.\.\/data\/|^\.\.\/\.\.\/util\/rng$/.test(m[1])) bad.push(`${name}: ${m[1]}`);
      }
      if (/require\(\s*[^"'\s]/.test(src)) bad.push(`${name}: dynamic require`);
    }
    assert.deepStrictEqual(bad, []);
  });

  test("D46 capture range: invasion never beyond N jumps of an own ONLINE station, raid / recon reach further; stations off -> no invasion", () => {
    const N = 2;
    const params = { ...PARAMS, captureRangeFromStationJumps: N, targetPickTopK: 10, maxTargetCandidates: 200 };
    const station = 30001868;
    const controllers = new Map(THEATRE.map((id) => [id, AMARR]));
    const fromStation = dist([station], 40);
    const fleets = [];
    const seen = { invasion: [], raid: [], recon: [] };
    for (let seed = 1; seed <= 80; seed += 1) {
      for (const withIntel of [true, false]) {
        const s = snap(SANSHA, { controllers, stations: [station], fleets, seed: deriveSeed(seed, "d46"),
          intel: withIntel ? THEATRE.map((id) => ({ ...freshIntel(id), controllerFactionId: AMARR })) : [] });
        for (const l of launches(decideReview(s, params))) seen[l.kind].push(fromStation.get(l.target.systemId));
      }
    }
    assert.ok(seen.invasion.length > 0 && seen.invasion.every((j) => j <= N), seen.invasion.join(","));
    assert.ok(seen.raid.some((j) => j > N), `raid ${seen.raid.join(",")}`);
    assert.ok(seen.recon.some((j) => j > N), `recon ${seen.recon.join(",")}`);
    const off = snap(SANSHA, { controllers, stations: [station], fleets, stationsMode: "off",
      intel: THEATRE.map((id) => ({ ...freshIntel(id), controllerFactionId: AMARR })) });
    for (let seed = 1; seed <= 20; seed += 1) {
      const d = decideReview({ ...off, seed }, params);
      assert.ok(launches(d).every((l) => l.kind !== "invasion"), "no station data -> no capture");
    }
  });

  test("P8b: expansion group with jumps 0 = only its start system (parity with supply/occupation)", () => {
    const EXIT = 30001863;
    const built = buildUniverseGraph(k3StaticMap());
    assert.ok(built.ok);
    const g2 = built.graph;
    const input = { enabled: true, stationSystems: [], theatre: [], neighbors: (id) => g2.getNeighbors(id),
      getSystem: (id) => g2.getSystem(id), jumps: 5, maxSystems: 2000, limit: 64,
      groups: [{ starts: [EXIT], jumps: 0 }] };
    assert.deepStrictEqual(expansionCandidates(input), [EXIT]);
  });

  test("RR1 expansion from a shared BFS (10 jumps, maxSystems cutting layer 9) = own BFS at 5 jumps "
    + "rangeCandidates(10) reaches layer 8, never lowsec nor theatre", () => {
    const nb = (id) => {
      if (id >= 100) return [id - 100];
      return [id - 1, id + 1, 100 + id].filter((x) => (x >= 1 && x <= 11) || x > 100);
    };
    const LOW = new Set([104, 108]);
    const getSystem = (id) => ({ secClass: LOW.has(id) ? "lowsec" : "nullsec", regionId: 10000001 });
    const THEATRE_ID = 3;
    const maxSystems = 18;
    const shared = bfs([1], nb, { maxJumps: 10, maxSystems });
    const base = { enabled: true, stationSystems: [1], theatre: [THEATRE_ID], neighbors: nb, getSystem, jumps: 5,
      maxSystems };
    const out = [64, 4].map((limit) => [expansionCandidates({ ...base, limit, reach: shared }),
      expansionCandidates({ ...base, limit })]);
    const range = rangeCandidates({ reach: shared, theatre: [THEATRE_ID], getSystem, jumps: 10, limit: 1000 });
    assert.deepStrictEqual({ size: shared.size, layer9: [...shared].filter(([, j]) => j === 9).length,
      same: out.map(([a, b]) => a.length > 0 && JSON.stringify(a) === JSON.stringify(b)),
      layer8: [9, 108].map((id) => shared.get(id)), range: [range.includes(9), range.includes(108),
        range.includes(THEATRE_ID), range.includes(104), Math.max(...range.map((id) => shared.get(id)))] }, {
      size: 18, layer9: 1, same: [true, true], layer8: [8, 8], range: [true, false, false, false, 9] },
    JSON.stringify(out));
  });

  test("P8 pirate expansion: Sansha captures nullsec beyond the theatre only in captureReach, never "
    + "Pochven / Zarzakh / lowsec; Amarr never; vendor facts of the excluded regions", () => {
    assert.deepStrictEqual(EXPANSION_EXCLUDED_REGION_IDS, [10000070, 10001000]);
    assert.deepStrictEqual(["sansha-incursion-v1", "amarr-border-defense-v3", "serpentis-territorial-v2"]
      .map((id) => registry.getDoctrine(id).expandsBeyondTheatre), [true, false, true]);
    const POCH = 30000021;
    const LOWX = 30009001;
    const EXIT = 30001863;
    const map = k3StaticMap({ extra: [system(POCH, 10000070, 20000700, "nullsec"), system(LOWX, 10000022, 20000999,
      "lowsec")] });
    for (const [a, b] of [[EXIT, POCH], [EXIT, LOWX]]) {
      map.gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
    }
    const built = buildUniverseGraph(map);
    assert.ok(built.ok);
    const g2 = built.graph;
    const station = 30001867;
    const input = { enabled: true, stationSystems: [station], theatre: THEATRE, neighbors: (id) => g2.getNeighbors(id),
      getSystem: (id) => g2.getSystem(id), jumps: 5, maxSystems: 2000, limit: 64 };
    const exp = expansionCandidates(input);
    const fromStation = bfs([station], (id) => g2.getNeighbors(id), { maxJumps: 40, maxSystems: 5000 });
    assert.ok(exp.includes(EXIT) && !exp.includes(POCH) && !exp.includes(LOWX), exp.join(","));
    assert.ok(exp.every((id) => !THEATRE.includes(id) && fromStation.get(id) <= 5), exp.join(","));
    assert.deepStrictEqual(expansionCandidates({ ...input, enabled: false }), [], "Amarr: expandsBeyondTheatre false");
    const controllers = new Map([...THEATRE, ...exp, POCH, LOWX].map((id) => [id, AMARR]));
    const params = { ...PARAMS, targetPickTopK: 10, maxTargetCandidates: 200 };
    const outside = [];
    for (let seed = 1; seed <= 80; seed += 1) {
      for (const withIntel of [true, false]) {
        const s = { ...snap(SANSHA, { controllers, stations: [station], seed: deriveSeed(seed, "p8"),
          intel: withIntel ? [...controllers.keys()].map((id) => ({ ...freshIntel(id), controllerFactionId: AMARR }))
            : [] }), neighbors: (id) => g2.getNeighbors(id), regionOf: (id) => (g2.getSystem(id) || {}).regionId || null,
        expansion: exp };
        for (const l of launches(decideReview(s, params))) {
          const T = l.target.systemId;
          if (THEATRE.includes(T)) continue;
          assert.ok(exp.includes(T), `outside target ${T} not an expansion candidate`);
          assert.ok(l.kind === "invasion" || l.kind === "recon", `${l.kind} beyond the theatre`);
          outside.push(T);
        }
      }
    }
    assert.ok(outside.length > 0, "Sansha expands beyond the theatre");
  });

  test("M5 planMining: own systems only, no fresh hostile intel / foreign pretender, per-system room counts this "
    + "round, maxTripJumps, mobilization to desired (none when truncated), miners outside strategy.maxFleetsPerFaction, "
    + "deterministic", () => {
    const MP = { maxFleetsPerFaction: 6, maxFleetsPerSystem: 1, targetFleetsPerSystemPermille: 1000,
      maxMobilizationsPerReview: 1, maxDispatchesPerReview: 3, maxTripJumps: 3, maxCandidateSystems: 32,
      distancePenaltyPermille: 250, avoidHostileIntel: true };
    const P = { ...PARAMS, mining: MP };
    const base = THEATRE[0];
    const near = [...dist([base], 3).keys()].filter((id) => THEATRE.includes(id) && id !== base).sort((a, b) => a - b);
    assert.ok(near.length >= 3, `theatre systems near ${base}: ${near}`);
    const far = THEATRE.find((id) => !dist([base], 3).has(id));
    const [hostileSys, pretended, amarrSys, ...good] = near;
    assert.ok(good.length >= 1, `free candidates near ${base}: ${good}`);
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    controllers.set(amarrSys, AMARR);
    const sites = [base, ...near, ...(far ? [far] : [])].map((systemId) => ({ systemId, richnessPermille: 800 }));
    const miner = (id, extra = {}) => fleet(id, base, { fleetRole: "mining", ...extra });
    const mk = (o = {}) => {
      const sn = snap(SANSHA, { controllers, stations: [base], fleets: o.fleets || [], intel: [{ ...freshIntel(hostileSys),
        hostileFleets: 2 }] });
      sn.systems = sn.systems.map((x) => (x.systemId === pretended ? { ...x, occupierFactionId: AMARR } : x));
      sn.mining = { mode: "ready", sites, openByBelt: o.openByBelt || [], busyFleetIds: o.busy || [] };
      if (o.truncated) sn.fleetsTruncated = true;
      return sn;
    };
    const mineOf = (d) => d.intents.filter((i) => i.type === "MINE_DISPATCH");
    const minersMob = (d) => d.intents.filter((i) => i.type === "MOBILIZE" && i.role === "mining");
    const fleets = [miner("m1"), miner("m2"), miner("m3"), miner("m4", { state: "TRAVELLING" }),
      miner("m5", { refitPending: true }), miner("m6")];
    const d = decideReview(mk({ fleets, busy: ["m6"] }), P);
    const picked = mineOf(d);
    assert.deepStrictEqual(picked.map((i) => i.fleetId), ["m1", "m2", "m3"].slice(0, Math.min(3, good.length + 1)));
    const targets = picked.map((i) => i.beltSystemId);
    assert.strictEqual(new Set(targets).size, targets.length, "maxFleetsPerSystem 1 counts this round");
    for (const t of targets) {
      assert.ok([base, ...good].includes(t), `own, no intel, no pretender, in reach: ${t}`);
      assert.notStrictEqual(t, far);
    }
    assert.deepStrictEqual(decideReview(mk({ fleets, busy: ["m6"] }), P), d, "deterministic");
    const occupied = decideReview(mk({ fleets: [miner("m1")], openByBelt: [base, ...good].map((systemId) =>
      ({ systemId, n: 1 })) }), P);
    assert.deepStrictEqual(mineOf(occupied), []);
    const mob = minersMob(decideReview(mk({ fleets: [] }), P));
    assert.strictEqual(mob.length, 1, "maxMobilizationsPerReview");
    assert.deepStrictEqual([mob[0].systemId, mob[0].composition.reduce((n, e) => n + e.count, 0)], [base, 3]);
    assert.deepStrictEqual(minersMob(decideReview(mk({ fleets: [], truncated: true }), P)), []);
    const enough = Array.from({ length: 6 }, (_v, i) => miner(`x${i}`, { state: "TRAVELLING" }));
    assert.deepStrictEqual(minersMob(decideReview(mk({ fleets: enough }), P)), [], "desired reached");
    const combat = decideReview(mk({ fleets: enough }), { ...P, maxFleetsPerFaction: 1 });
    assert.ok(!combat.notes.includes("FLEET_LIMIT"), JSON.stringify(combat.notes));
    assert.ok(launches(combat).length + combat.intents.filter((i) => i.type === "MOBILIZE").length > 0);
    const plain = snap(SANSHA, { controllers, stations: [base], fleets });
    assert.deepStrictEqual(mineOf(decideReview(plain, P)), []);
  });
  test("M8 planMining: invader doctrine (no mining template) -> MINING_NOT_IN_DOCTRINE, never MINING_NO_BASE "
    + "non-invader without station still MINING_NO_BASE (regression)", () => {
    const MP = { maxFleetsPerFaction: 6, maxFleetsPerSystem: 1, targetFleetsPerSystemPermille: 1000,
      maxMobilizationsPerReview: 1, maxDispatchesPerReview: 3, maxTripJumps: 3, maxCandidateSystems: 32,
      distancePenaltyPermille: 250, avoidHostileIntel: true };
    const P = { ...PARAMS, mining: MP };
    const SANSHA = 500019;
    const trig = snap(500026);
    trig.mining = { mode: "ready", sites: [], openByBelt: [], busyFleetIds: [] };
    assert.ok(trig.entry.kind === "invader", `kind=${trig.entry.kind}`);
    assert.ok(!Array.isArray(trig.doctrine.templates.mining), "Triglavian has no mining template");
    const supplyTrig = { stationSystems: [], affordable: { resourceUnits: 1e9, reserveUnits: 1e9 } };
    const dTrig = planMining(trig, supplyTrig, P, null);
    assert.ok(dTrig.notes.includes("MINING_NOT_IN_DOCTRINE"), JSON.stringify(dTrig.notes));
    assert.ok(!dTrig.notes.includes("MINING_NO_BASE"), JSON.stringify(dTrig.notes));
    const dless = snap(500029);
    dless.mining = { mode: "ready", sites: [], openByBelt: [], busyFleetIds: [] };
    assert.ok(dless.entry.kind === "invader");
    assert.ok(!Array.isArray(dless.doctrine.templates.mining));
    const dDless = planMining({ ...dless, faction: { ...dless.faction, status: "ACTIVE", homeSystemId: 30001721 },
      stationsMode: "ready", stations: [] }, supplyTrig, P, null);
    assert.ok(dDless.notes.includes("MINING_NOT_IN_DOCTRINE"), JSON.stringify(dDless.notes));
    assert.ok(!dDless.notes.includes("MINING_NO_BASE"), JSON.stringify(dDless.notes));
    const sleep = snap(500021);
    sleep.mining = { mode: "ready", sites: [], openByBelt: [], busyFleetIds: [] };
    assert.ok(sleep.entry.kind === "invader");
    assert.ok(!Array.isArray(sleep.doctrine.templates.mining));
    const dSleep = planMining({ ...sleep, faction: { ...sleep.faction, status: "ACTIVE", homeSystemId: 30001721 },
      stationsMode: "ready", stations: [] }, supplyTrig, P, null);
    assert.ok(dSleep.notes.includes("MINING_NOT_IN_DOCTRINE"), JSON.stringify(dSleep.notes));
    const sansha = snap(SANSHA);
    sansha.mining = { mode: "ready", sites: [], openByBelt: [], busyFleetIds: [] };
    assert.ok(Array.isArray(sansha.doctrine.templates.mining), "Sansha has mining template");
    const dSansha = planMining({ ...sansha, faction: { ...sansha.faction, status: "ACTIVE", homeSystemId: sansha.faction.homeSystemId },
      stationsMode: "ready", stations: [] }, supplyTrig, P, null);
    assert.ok(dSansha.notes.includes("MINING_NO_BASE"), JSON.stringify(dSansha.notes));
    assert.ok(!dSansha.notes.includes("MINING_NOT_IN_DOCTRINE"), JSON.stringify(dSansha.notes));
  });
  test("PR4 planProduction (deficit order, mobilization station, local reservation, deterministic) + hull ledger "
    + "(required: nearest station with the template, no double count, NO_HULLS; mining exempt; production off -> "
    + "legacy)", () => {
    const P = { ...PARAMS, production: PROD };
    const times = (g, n) => Object.fromEntries(Object.entries(RECIPES.GROUPS[g].minerals).map(([k, v]) => [k, v * n]));
    const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
    const s = snap(SANSHA);
    const desired = hullTargets(s.doctrine, PROD);
    assert.strictEqual(desired.industrial, undefined, "mining and logistics templates exempt (P4)");
    assert.strictEqual(desired.cruiser, 10);
    s.production = prodOf([st("st0", SAMINER, times("cruiser", 5), { frigate: 11, destroyer: 1 }),
      st("st1", SAMINER, times("cruiser", 7))]);
    const plan = planProduction(s, null, P);
    assert.deepStrictEqual(plan.intents.map((i) => [i.type, i.stationId, i.hullGroup, i.runs, i.recipesVersion]),
      [["PRODUCE", "st0", "cruiser", 4, 1], ["PRODUCE", "st0", "logistics", 1, 1]], JSON.stringify(plan));
    assert.deepStrictEqual(planProduction(s, null, P), plan, "deterministic");
    const busy = { ...s, production: prodOf(s.production.stations.map((x) => ({ ...x, lines: 0 }))) };
    assert.deepStrictEqual(planProduction(busy, null, P).intents, [], "no free line");
    assert.deepStrictEqual(planProduction({ ...s, production: { ...s.production, mode: "off" } }, null, P).intents, []);

    const a = snap(AMARR);
    a.production = prodOf([st("st0", SAMINER, {}, { frigate: 1 })]);
    const d = decideReview(a, P);
    assert.strictEqual(d.hullPolicy, "required");
    const mob = launches(d)[0].mobilize[0];
    assert.deepStrictEqual([mob.stationId, mob.systemId, mob.hulls], ["st0", SAMINER,
      [{ itemKey: "group:frigate", count: 1 }]]);
    const none = snap(AMARR);
    none.production = prodOf([st("st0", SAMINER, {}, {})]);
    const dn = decideReview(none, P);
    assert.deepStrictEqual([launches(dn).length, dn.intents.filter((i) => i.type === "MOBILIZE").length,
      dn.notes.some(n => n.startsWith("NO_HULLS"))], [0, 0, true]);
    const ledger = createHullLedger({ production: prodOf([st("near", 1, {}, { frigate: 1 }),
      st("far", 2, {}, { frigate: 3 })]) }, P);
    const tpl = [{ hullGroup: "frigate", count: 1 }];
    const order = [{ stationId: "near", systemId: 1 }, { stationId: "far", systemId: 2 }];
    const first = ledger.pick(tpl, order);
    ledger.take(first.stationId, first.hulls);
    assert.deepStrictEqual([first.stationId, ledger.pick(tpl, order).stationId], ["near", "far"], "no double count");
    assert.strictEqual(ledger.pick([{ hullGroup: "frigate", count: 4 }], order), null);
    assert.deepStrictEqual([ledger.needs("mining"), ledger.needs("scout")], [false, true]);
    assert.strictEqual(createHullLedger({ production: prodOf([]) }, { production: { ...PROD,
      miningNeedsHulls: true } }).needs("mining"), true);
    const off = snap(AMARR);
    off.production = prodOf([], { mode: "off" });
    const dOff = decideReview(off, P);
    const lm = launches(dOff)[0].mobilize[0];
    assert.deepStrictEqual([dOff.hullPolicy, lm.stationId, lm.hulls, lm.systemId], ["legacy", null, [], SAMINER]);
  });
  test("PR6 scattered hulls: cruisers in A, battleships in B -> production goes on in the "
    + "mobilization station, after the delivery the template is whole there (ledger pick)", () => {
    const P = { ...PARAMS, production: PROD };
    const HOME = 30001868;
    const tpl = [{ hullGroup: "cruiser", count: 2 }, { hullGroup: "battleship", count: 1 }];
    const s = snap(SANSHA);
    s.doctrine = { ...s.doctrine, templates: { invasion: tpl } };
    const A = st("stA", SAMINER, times("battleship", 2), { cruiser: 2 });
    const B = st("stB", HOME, times("battleship", 2), { battleship: 1 });
    s.production = prodOf([A, B]);
    const plan = planProduction(s, null, P);
    assert.deepStrictEqual(plan.intents.map((i) => [i.stationId, i.hullGroup, i.runs]), [["stA", "battleship", 1]],
      JSON.stringify(plan));
    const order = [{ stationId: "stA", systemId: SAMINER }, { stationId: "stB", systemId: HOME }];
    assert.strictEqual(createHullLedger(s, P).pick(tpl, order), null, "scattered: NO_HULLS before the delivery");
    s.production = prodOf([{ ...A, activeJobs: [{ hullGroup: "battleship", runs: 1 }] }, B], { activeJobsTotal: 1 });
    assert.deepStrictEqual(planProduction(s, null, P).intents, []);
    s.production = prodOf([{ ...A, hulls: { cruiser: 2, battleship: 1 } }, B]);
    assert.deepStrictEqual(planProduction(s, null, P).intents, []);
    const picked = createHullLedger(s, P).pick(tpl, order);
    assert.deepStrictEqual([picked.stationId, picked.hulls], ["stA", [{ itemKey: "group:battleship", count: 1 },
      { itemKey: "group:cruiser", count: 2 }]]);
    s.production = prodOf([st("stA", SAMINER, times("cruiser", 2)), st("stB", HOME, times("cruiser", 2))]);
    assert.deepStrictEqual(planProduction(s, null, P).intents.map((i) => i.stationId), ["stB"]);
    assert.deepStrictEqual(planProduction(s, { frontTargets: [SAMINER] }, P).intents.map((i) => i.stationId), ["stA"]);
  });

  test("WTN6 d4: wtsEnabled, hull surplus on the MOBILIZE source station -> the offensive "
    + "MOBILIZE never gets INSUFFICIENT_STOCK (hull WTS of that station dropped, WTS after the offensive); "
    + "no WTS offer -> trade intents unchanged", () => {
    const race = HULL_TYPES.RACES["4"];
    const T = { premiumPermille: 1100, askCapPermille: 980, maxOffersPerReview: 4, maxCancelsPerReview: 4,
      maxOpenOffersPerFaction: 32, maxOpenOffersPerStation: 8, maxQuantityPerOffer: 10000000, minIskPerOffer: 100000,
      maxIskPerOffer: 200000000, offerTtlMs: 259200000, factoryRunsTarget: 2, maxUnitPriceMilli: 1000000000000,
      priceCacheMs: 3600000, hullOffersEnabled: true, hullOffersPerReview: 0, hullMaxPerOffer: 40,
      warReservedOffersPerFaction: 4, wtsEnabled: true, wtsTtlMs: 259200000, wtsOffersPerReview: 2,
      wtsMaxOpenPerFaction: 8, wtsStationSlotHeadroom: 1, wtsMineralSurplusRuns: 0, wtsHullSurplusPermille: 2000,
      wtsAskPermille: 1050, wtsBidPermille: 1100, wtsMaxIskPerOffer: 500000000 };
    const P = { ...PARAMS, production: PROD, trade: T };
    const ask = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli - 1, capMilli: null, source: "ask" });
    const of = (stations) => {
      const a = snap(AMARR, { stations: stations.map((s) => s.systemId) });
      a.production = prodOf(stations);
      a.trade = { mode: "ready", galaxy: { open: 0, factions: 7 }, budget: { availableIsk: 1e8, reservedIsk: 0 },
        open: [], openTruncated: false, stations: stations.map((s) => ({ stationId: s.stationId, systemId: s.systemId,
          ownerCorporationId: 1000001, kind: "npc" })), quotes: {}, privateQuotes: {}, suppliers: [],
        hulls: { frigate: { typeId: race.frigate, itemKey: "group:frigate" } },
        sellQuotes: { "group:frigate": ask(1050000000) }, buyUnitMax: {} };
      return a;
    };
    const keep = 2 * hullTargets(snap(AMARR).doctrine, PROD).frigate;
    const scene = [{ ...st("st0", SAMINER, {}, { frigate: 30 }), lines: 0 },
      { ...st("st1", SAMINER, {}, { frigate: keep }), lines: 0 }];
    const d = decideReview(of(scene), P);
    const mobs = d.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
    assert.ok(mobs.some((m) => m.stationId === "st0" && m.hulls.length > 0), JSON.stringify(d.intents));
    const stock = { st0: 30, st1: keep };
    const refused = [];
    for (const i of d.intents) {
      const takes = i.type === "TRADE_OFFER" && i.side === "sell" ? [{ s: i.stationId, n: i.quantity, i }]
        : (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []).map((m) => ({ s: m.stationId,
          n: m.hulls.reduce((x, h) => x + h.count, 0), i: m }));
      for (const t of takes) {
        if ((stock[t.s] || 0) < t.n) refused.push(t.i.type);
        else stock[t.s] -= t.n;
      }
    }
    assert.deepStrictEqual(refused, [], JSON.stringify(d.intents));
    assert.ok(d.notes.includes("TRADE_WTS_WAR_SOURCE:group:frigate@st0"), JSON.stringify(d.notes));
    assert.ok(!d.notes.includes("TRADE_WTS_OFFER:group:frigate@st0"), JSON.stringify(d.notes));
    assert.deepStrictEqual(d.intents.filter((i) => i.side === "sell"), []);

    const two = [scene[0], { ...st("st1", A_DZA8, {}, { frigate: 30 }), lines: 0 }];
    const d2 = decideReview(of(two), P);
    const sellIdx = d2.intents.findIndex((i) => i.type === "TRADE_OFFER" && i.side === "sell");
    const warIdx = d2.intents.findIndex((i) => i.type === "LAUNCH" || i.type === "MOBILIZE");
    assert.ok(sellIdx > warIdx && warIdx >= 0, JSON.stringify([d2.intents.map((i) => i.type), d2.notes]));
    assert.notStrictEqual(d2.intents[sellIdx].stationId, d2.intents.flatMap((i) => (i.type === "LAUNCH" ? i.mobilize
      : i.type === "MOBILIZE" ? [i] : []))[0].stationId);

    const plain = { intents: [{ type: "TRADE_OFFER", stationId: "st0" }, { type: "TRADE_CANCEL" }], notes: ["X"] };
    const kept = deferSells(plain, mobs);
    assert.ok(kept.intents === plain.intents && kept.notes === plain.notes && kept.sells.length === 0);
  });

  test("PR7 SWEEP: station A with 2 cruisers and no minerals, B with minerals -> PRODUCE in B "
    + "(alive before progress); the panel deficitStation = the AI station", () => {
    const P = { ...PARAMS, production: PROD };
    const HOME = 30001868;
    const tpl = [{ hullGroup: "cruiser", count: 2 }, { hullGroup: "battleship", count: 1 }];
    const s = snap(SANSHA);
    s.doctrine = { ...s.doctrine, templates: { invasion: tpl } };
    const A = st("stA", HOME, {}, { cruiser: 2 });
    const B = st("stB", SAMINER, times("battleship", 2));
    s.production = prodOf([A, B]);
    const plan = planProduction(s, null, P);
    assert.deepStrictEqual(plan.intents.map((i) => [i.stationId, i.hullGroup]), [["stB", "cruiser"],
      ["stB", "battleship"]], JSON.stringify(plan));
    s.production = prodOf([{ ...A, activeJobs: [{ hullGroup: "battleship", runs: 1 }] }, B], { activeJobsTotal: 1 });
    assert.deepStrictEqual(planProduction(s, null, P).intents, []);
    const rows = [{ stationId: "stA", kind: "npc", systemId: HOME, ownerFactionId: SANSHA, state: "ONLINE",
      stock: [{ itemKind: "hull", itemKey: "group:cruiser", quantity: 2 }] },
    { stationId: "stB", kind: "npc", systemId: SAMINER, ownerFactionId: SANSHA, state: "ONLINE",
      stock: Object.entries(times("battleship", 2)).map(([k, q]) => ({ itemKind: "mineral", itemKey: k, quantity: q })) }];
    const repo = { listLiveStations: () => ({ ok: true, records: rows }),
      getStock: (db, id) => ({ ok: true, items: rows.find((r) => r.stationId === id).stock }), getChangeCount: () => 0 };
    const doctrine = { templates: { invasion: tpl } };
    const view = buildProductionView({ store: { isOpen: () => true, transaction: (n, fn) => ({ ok: true, value: fn({}) }) },
      jobs: { listTotals: () => ({ ok: true, totals: [] }), listActiveAll: () => ({ ok: true, jobs: [] }),
        recentEnded: () => ({ ok: true, rows: [] }), getChangeCount: () => 0 },
      clock: { now: () => AT }, config: { production: { targetStockFleets: 1, miningNeedsHulls: false },
        observer: { productionMaxActiveJobs: 50, productionRefreshMs: HOUR } }, getStatus: () => ({ state: "ready" }),
      getStations: () => ({ repository: repo }), linesOf: () => 2,
      registry: { listFactions: () => [{ factionId: SANSHA }], listActiveFactions: () => [{ factionId: SANSHA }],
        getFaction: () => ({ doctrineId: "d" }),
        getDoctrine: () => doctrine },
      getRecipes: () => ({ groups: Object.keys(recipes), lookup: (g) => recipes[g] }) });
    const panel = view.getData().factions.find((f) => f.faction === SANSHA);
    assert.strictEqual(panel.deficitStation, "stB", JSON.stringify(panel));
  });

  test("C4 scattered hulls (A: cruisers, B: battleship, mobilization = A) -> CONVOY_DISPATCH B -> A; the "
    + "cargo on the way counts (no second convoy); no fleet -> MOBILIZE logistics in B; a fleet without carriers is "
    + "not free", () => {
    const LOG = { maxFleetsPerFaction: 3, maxOpenConvoysPerFaction: 4, maxDispatchesPerReview: 2,
      maxMobilizationsPerReview: 1, carrierCapacityM3: 60000, maxCargoItems: 12, minLoadVolume: 100000,
      factoryRunsTarget: 2, maxConvoyJumps: 20, needsHulls: false, maxHullConvoysPerReview: 8,
      mineralSurplusThreshold: 1000, maxMineralConvoysPerReview: 4, mineralConvoyMinLoad: 100,
      volumes: { mineral: VOLUMES.MINERAL_VOLUME,
        hulls: VOLUMES.HULL_VOLUMES, carrierGroups: VOLUMES.CARRIER_GROUPS, unitsPerM3: VOLUMES.VOLUME_UNITS_PER_M3 } };
    const P = { ...PARAMS, production: PROD, logistics: LOG };
    const HOME = 30001868;
    const tpl = [{ hullGroup: "cruiser", count: 2 }, { hullGroup: "battleship", count: 1 }];
    const convoyTpl = [{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }];
    const lf = fleet("lf", HOME, { fleetRole: "logistics" });
    const s = snap(SANSHA, { fleets: [lf] });
    s.doctrine = { ...s.doctrine, templates: { invasion: tpl, logistics: convoyTpl } };
    s.production = prodOf([st("stA", SAMINER, {}, { cruiser: 2 }), st("stB", HOME, {}, { battleship: 1 })]);
    s.logistics = { mode: "ready", open: [], busyFleetIds: [], carriers: { lf: 2 }, truncated: false };
    const d = decideReview(s, P);
    const convoys = d.intents.filter((i) => i.type === "CONVOY_DISPATCH");
    assert.deepStrictEqual(convoys.map((i) => [i.fleetId, i.purpose, i.sourceStationId, i.destStationId, i.items]),
      [["lf", "HULLS_TO_MOBILIZATION", "stB", "stA", [{ itemKind: "hull", itemKey: "group:battleship", quantity: 1 }]]],
      JSON.stringify(d.notes));
    const s2 = { ...s, logistics: { ...s.logistics, busyFleetIds: ["lf"], open: [{ convoyId: "cv1", fleetId: "lf",
      state: "IN_TRANSIT", purpose: "HULLS_TO_MOBILIZATION", sourceStationId: "stB", destStationId: "stA",
      items: { "hull/group:battleship": 1 } }] } };
    s2.production = prodOf([st("stA", SAMINER, {}, { cruiser: 2 }), st("stB", HOME, {})]);
    assert.deepStrictEqual(decideReview(s2, P).intents.filter((i) => ["CONVOY_DISPATCH", "MOBILIZE"].includes(i.type)
      && (i.type === "CONVOY_DISPATCH" || i.role === "logistics")), []);
    const s3 = { ...s, logistics: { ...s.logistics, carriers: { lf: 0 } } };
    const d3 = decideReview(s3, P);
    const mob = d3.intents.filter((i) => i.type === "MOBILIZE" && i.role === "logistics");
    assert.deepStrictEqual(mob.map((i) => [i.systemId, i.hulls]), [[HOME, []]], JSON.stringify(d3.notes));
    assert.ok(d3.notes.includes("LOGISTICS_NO_CARRIERS"));
    assert.deepStrictEqual(d3.intents.filter((i) => i.type === "CONVOY_DISPATCH"), []);
    const s4 = { ...s, production: prodOf([st("stA", SAMINER, {}, { cruiser: 2 }),
      st("stA2", SAMINER, {}, { battleship: 5 }), st("stB", HOME, {}, { battleship: 1 })]) };
    const c4 = decideReview(s4, P).intents.filter((i) => i.type === "CONVOY_DISPATCH");
    assert.deepStrictEqual(c4.map((i) => [i.sourceStationId, i.destStationId]), [["stB", "stA"]]);
  });

  const LOG_R = { maxFleetsPerFaction: 3, maxOpenConvoysPerFaction: 4, maxDispatchesPerReview: 2,
    maxMobilizationsPerReview: 1, carrierCapacityM3: 60000, maxCargoItems: 12, minLoadVolume: 100000,
    factoryRunsTarget: 2, maxConvoyJumps: 20, needsHulls: false, frontStationMaxJumps: 6,
    maxHullConvoysPerReview: 8, mineralSurplusThreshold: 1000, maxMineralConvoysPerReview: 4, mineralConvoyMinLoad: 100,
    volumes: { mineral: VOLUMES.MINERAL_VOLUME, hulls: VOLUMES.HULL_VOLUMES, carrierGroups: VOLUMES.CARRIER_GROUPS,
      unitsPerM3: VOLUMES.VOLUME_UNITS_PER_M3 } };
  const REP = Object.freeze({ maxReplenishPerReview: 2, maxShipsPerFleet: 500 });

  test("LR1 planLogisticsRetire: 0 carriers in a station system -> DISBAND NO_CARRIERS, elsewhere -> LAUNCH "
    + "return LOGISTICS_RETIRE, no base in reach -> DISBAND NO_BASE; busy / refit_pending / carriers > 0 / unknown -> "
    + "nothing; limit; hulls only with the required hull policy; retireEnabled false = the decision without it", () => {
    const HOME = [...dist([SAMINER], 1).keys()].find((id) => id !== SAMINER);
    assert.ok(HOME, "a neighbour of the station system");
    const lf = (id, systemId, extra) => fleet(id, systemId, { fleetRole: "logistics", ...extra });
    const fleets = [lf("z1", SAMINER), lf("z2", HOME), lf("z3", SAMINER), lf("z4", SAMINER, { refitPending: true }),
      lf("z5", HOME), lf("ok", SAMINER), lf("unk", SAMINER)];
    const s = snap(SANSHA, { fleets });
    s.logistics = { mode: "ready", open: [{ convoyId: "cv", fleetId: "z3" }], busyFleetIds: ["z3"],
      carriers: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, ok: 2 }, truncated: false };
    const LOG = { ...LOG_R, retireEnabled: true, maxRetiresPerReview: 2 };
    const P = { ...PARAMS, returnWindowMs: HOUR, logistics: LOG };
    const retired = (d) => d.intents.filter((i) => i.type === "DISBAND" || i.purpose === "LOGISTICS_RETIRE");
    const d = decideReview(s, P);
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    assert.deepStrictEqual(retired(d), [
      { type: "DISBAND", fleetId: "z1", expectedVersion: 1, systemId: SAMINER, stationId: "st0", reason: "NO_CARRIERS",
        returnHulls: false },
      { type: "LAUNCH", kind: "return", target: { kind: "system", systemId: SAMINER, ref: null }, originSystemId: HOME,
        fleets: [{ fleetId: "z2", expectedVersion: 1 }], mobilize: [], dueAt: AT + HOUR, purpose: "LOGISTICS_RETIRE" }]);
    assert.ok(["LOGISTICS_RETIRE", "LOGISTICS_RETIRE_LIMIT"].every((n) => d.notes.includes(n)), JSON.stringify(d.notes));
    const far = retired(decideReview({ ...s, fleets: [lf("z2", HOME)] }, { ...P, maxAssemblyJumps: 0 }));
    assert.deepStrictEqual(far.map((i) => [i.type, i.fleetId, i.stationId, i.reason, i.returnHulls]),
      [["DISBAND", "z2", null, "NO_BASE", false]]);
    const hs = { ...s, fleets: [lf("z1", SAMINER)], production: prodOf([st("st0", SAMINER, {})]) };
    const hp = { ...P, production: { ...PROD, logisticsNeedsHulls: true }, logistics: { ...LOG, needsHulls: true } };
    assert.deepStrictEqual(retired(decideReview(hs, hp)).map((i) => i.returnHulls), [true]);
    assert.deepStrictEqual(retired(decideReview(hs, { ...hp, production: { ...PROD, logisticsNeedsHulls: false } }))
      .map((i) => i.returnHulls), [false]);
    const plain = decideReview(s, { ...P, logistics: LOG_R });
    assert.deepStrictEqual(decideReview(s, { ...P, logistics: { ...LOG, retireEnabled: false } }), plain);
    assert.deepStrictEqual(decideReview(s, { ...P, logistics: { ...LOG, maxRetiresPerReview: 0 } }), plain);
    assert.deepStrictEqual(retired(decideReview({ ...s, logistics: { ...s.logistics, mode: "off" } }, P)), []);
    assert.deepStrictEqual(decideReview(s, { ...P, logistics: { ...LOG, strandedReturnEnabled: false,
      strandedReturnMaxJumps: 40 } }), d);
  });

  const chain = (id) => (id >= 1 && id <= 80 ? [id - 1, id + 1].filter((x) => x >= 1 && x <= 80) : null);
  const LOG_S = { ...LOG_R, retireEnabled: true, maxRetiresPerReview: 2, strandedReturnEnabled: true,
    strandedReturnMaxJumps: 40, jumpFreighterReachJumps: 30 };
  const strandedScene = (fleets, carriers, o = {}) => ({
    snapshot: { at: AT, neighbors: chain, fleets, stationsMode: "ready", fleetsTruncated: false,
      operationsTruncated: false, stations: o.stations || [{ systemId: 1, stationId: "st1" }],
      logistics: { mode: "ready", open: [], busyFleetIds: o.busy || [], carriers, truncated: false } },
    supply: { stationSystems: o.stationSystems || [1] },
  });
  const lgf = (fleetId, systemId, extra = {}) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "logistics",
    systemId, refitPending: false, operationId: null, homeSystemId: 1,
    composition: [{ hullGroup: "industrial", typeId: null, count: 2 }], ...extra });
  const SP = { maxBfsSystems: 2000, maxAssemblyJumps: 15, returnWindowMs: HOUR, logistics: LOG_S };
  const planS = (sc, p = SP) => planLogisticsRetire(sc.snapshot, sc.supply, p, new Set());

  test("SLR1 tribute-c stranded logistics: carriers 25 jumps from the only station -> LAUNCH return "
    + "LOGISTICS_STRANDED to it + note; 20 jumps (in reach) -> nothing; a jump freighter 25 jumps (reach 30) -> "
    + "nothing", () => {
    const far = planS(strandedScene([lgf("f1", 26)], { f1: 2 }));
    assert.deepStrictEqual(far, { intents: [{ type: "LAUNCH", kind: "return",
      target: { kind: "system", systemId: 1, ref: null }, originSystemId: 26,
      fleets: [{ fleetId: "f1", expectedVersion: 1 }], mobilize: [], dueAt: AT + HOUR,
      purpose: "LOGISTICS_STRANDED" }], notes: ["LOGISTICS_STRANDED_RETURN"] });
    assert.deepStrictEqual(planS(strandedScene([lgf("f1", 21)], { f1: 2 })), { intents: [], notes: [] });
    const jf = lgf("f1", 26, { composition: [{ hullGroup: "jump_freighter", typeId: null, count: 1 }] });
    assert.deepStrictEqual(planS(strandedScene([jf], { f1: 1 })), { intents: [], notes: [] });
  });

  test("SLR2 tribute-c stranded logistics: flag off = class 1 only; one budget with the retirement "
    + "first (LOGISTICS_STRANDED_LIMIT); no station in the BFS -> home; no base -> NO_BASE; busy / refit / op / "
    + "carriers missing or 0 -> never class 2", () => {
    const out = [];
    const both = strandedScene([lgf("z0", 11), lgf("f1", 26)], { z0: 0, f1: 2 });
    const off = planS(both, { ...SP, logistics: { ...LOG_S, strandedReturnEnabled: false } });
    out.push(["off", off.intents.map((i) => [i.fleetId || i.fleets[0].fleetId, i.purpose]), off.notes]);
    const one = planS(both, { ...SP, logistics: { ...LOG_S, maxRetiresPerReview: 1 } });
    out.push(["limit", one.intents.map((i) => [i.fleets[0].fleetId, i.purpose]), one.notes]);
    const only = planS(both, { ...SP, logistics: { ...LOG_S, retireEnabled: false } });
    out.push(["only", only.intents.map((i) => [i.fleets[0].fleetId, i.purpose]), only.notes]);
    const home = planS(strandedScene([lgf("f1", 61)], { f1: 2 }));
    out.push(["home", home.intents.map((i) => i.target.systemId), home.notes]);
    const noBase = planS(strandedScene([lgf("f1", 61, { homeSystemId: 70 })], { f1: 2 }));
    out.push(["noBase", noBase.intents.length, noBase.notes]);
    const noKind = planS(strandedScene([lgf("f1", 26)], { f1: 2 }), { ...SP, returnKindEnabled: false });
    out.push(["noKind", noKind.intents.length, noKind.notes]);
    const never = planS(strandedScene([lgf("b", 26), lgf("r", 26, { refitPending: true }),
      lgf("o", 26, { operationId: "op1" }), lgf("m", 26), lgf("z", 26), lgf("t", 26, { state: "TRAVELLING" })],
    { b: 2, r: 2, o: 2, z: 0, t: 2 }, { busy: ["b"] }), { ...SP, logistics: { ...LOG_S, retireEnabled: false } });
    out.push(["never", never.intents.length, never.notes]);
    assert.deepStrictEqual(out, [
      ["off", [["z0", "LOGISTICS_RETIRE"]], ["LOGISTICS_RETIRE"]],
      ["limit", [["z0", "LOGISTICS_RETIRE"]], ["LOGISTICS_RETIRE", "LOGISTICS_STRANDED_LIMIT"]],
      ["only", [["f1", "LOGISTICS_STRANDED"]], ["LOGISTICS_STRANDED_RETURN"]],
      ["home", [1], ["LOGISTICS_STRANDED_RETURN"]],
      ["noBase", 0, ["LOGISTICS_STRANDED_NO_BASE"]],
      ["noKind", 0, ["LOGISTICS_STRANDED_NO_BASE"]],
      ["never", 0, []],
    ]);
  });

  const denseNb = (two) => (id) => {
    if (id === 1) return [2, ...Array.from({ length: 21 }, (_, i) => 100 + i)];
    if (id >= 100 && id <= 120) return [1];
    if (two && id === 11) return [10, ...Array.from({ length: 21 }, (_, i) => 200 + i)];
    if (two && id >= 200 && id <= 220) return [11];
    const last = two ? 11 : 6;
    if (id >= 2 && id <= last - (two ? 1 : 0)) return [id - 1, id + 1].filter((x) => x <= last);
    return null;
  };
  const denseScene = (fleets, carriers, two = false) => {
    const sc = strandedScene(fleets, carriers, two ? { stations: [{ systemId: 1, stationId: "st1" },
      { systemId: 11, stationId: "st11" }], stationSystems: [1, 11] } : {});
    return { ...sc, snapshot: { ...sc.snapshot, neighbors: denseNb(two) } };
  };
  const LOG_F = { ...LOG_S, strandedFromStationsEnabled: true, strandedMaxStationBfs: 4 };
  const SPF = { ...SP, maxBfsSystems: 20, logistics: LOG_F };

  test("SLR6 a fleet 5 jumps from its station but outside the planner BFS of "
    + "the station (maxBfsSystems 20) -> LAUNCH return LOGISTICS_STRANDED to it; flag off -> nothing "
    + "maxBfsSystems 2000 -> nothing (visible); 'visible' equals the planner BFS (logistics.js dispatchPlans)", () => {
    const sc = denseScene([lgf("f1", 6)], { f1: 2 });
    const out = [];
    for (const [name, p] of [["on20", SPF], ["off20", { ...SPF, logistics: { ...LOG_F,
      strandedFromStationsEnabled: false } }], ["on2000", { ...SPF, maxBfsSystems: 2000 }]]) {
      const r = planS(sc, p);
      const near = bfs([1], sc.snapshot.neighbors, { maxJumps: p.logistics.maxConvoyJumps,
        maxSystems: p.maxBfsSystems });
      const plannerSees = near.has(6) && near.get(6) <= p.logistics.maxConvoyJumps;
      out.push([name, r.intents.map((i) => [i.fleets[0].fleetId, i.target.systemId, i.purpose]), r.notes,
        plannerSees]);
    }
    assert.deepStrictEqual(out, [
      ["on20", [["f1", 1, "LOGISTICS_STRANDED"]], ["LOGISTICS_STRANDED_RETURN"], false],
      ["off20", [], [], false],
      ["on2000", [], [], true],
    ]);
  });

  test("SLR7 two stations in reach, neither sees the fleet: "
    + "strandedMaxStationBfs 1 -> no intent + LOGISTICS_STRANDED_BFS_LIMIT, 2 -> LAUNCH; the station BFS cache: "
    + "3 fleets in one system, cap 1, one station -> 3 returns (budget 3), no LIMIT note; shared by the review: 2 fleets "
    + "near 2 different stations, cap 1 -> LIMIT, cap 2 -> none", () => {
    const out = [];
    const two = denseScene([lgf("f1", 6)], { f1: 2 }, true);
    for (const cap of [1, 2]) {
      const r = planS(two, { ...SPF, logistics: { ...LOG_F, strandedMaxStationBfs: cap } });
      out.push([cap, r.intents.map((i) => [i.fleets[0].fleetId, i.target.systemId]), r.notes]);
    }
    const three = denseScene([lgf("f1", 6), lgf("f2", 6), lgf("f3", 6)], { f1: 2, f2: 2, f3: 2 });
    const r3 = planS(three, { ...SPF, logistics: { ...LOG_F, strandedMaxStationBfs: 1, maxRetiresPerReview: 3 } });
    out.push(["cache", r3.intents.map((i) => i.fleets[0].fleetId), r3.notes]);
    const apart = denseScene([lgf("f1", 2), lgf("f2", 10)], { f1: 2, f2: 2 }, true);
    for (const cap of [1, 2]) {
      const r = planS(apart, { ...SPF, logistics: { ...LOG_F, strandedMaxStationBfs: cap } });
      out.push([`review${cap}`, r.intents.length, r.notes]);
    }
    assert.deepStrictEqual(out, [
      [1, [], ["LOGISTICS_STRANDED_BFS_LIMIT"]],
      [2, [["f1", 1]], ["LOGISTICS_STRANDED_RETURN"]],
      ["cache", ["f1", "f2", "f3"], ["LOGISTICS_STRANDED_RETURN"]],
      ["review1", 0, ["LOGISTICS_STRANDED_BFS_LIMIT"]],
      ["review2", 0, []],
    ]);
  });

  test("R1 planReplenish: 6/12 cruisers + station with 4 -> REPLENISH +4 (template groups only, cost per ship) "
    + "refit_pending / in an operation / mining / logistics fleets never; the fleet stays out of the LAUNCH; "
    + "replenish off -> none (DoD 13)", () => {
    const P = { ...PARAMS, production: PROD, replenish: REP };
    const big = [{ hullGroup: "cruiser", count: 12 }];
    const c6 = [{ hullGroup: "cruiser", typeId: null, count: 6 }, { hullGroup: "frigate", typeId: null, count: 2 }];
    const s = snap(SANSHA, { fleets: [fleet("f1", SAMINER, { composition: c6, shipCount: 8 }),
      fleet("f2", SAMINER, { composition: c6, shipCount: 8, refitPending: true }),
      fleet("f3", SAMINER, { composition: c6, shipCount: 8, operationId: "op1" }),
      fleet("f4", SAMINER, { composition: [{ hullGroup: "industrial", typeId: null, count: 1 }], fleetRole: "mining" }),
      fleet("f5", SAMINER, { composition: [{ hullGroup: "industrial", typeId: null, count: 1 }],
        fleetRole: "logistics" })] });
    s.doctrine = { ...s.doctrine, templates: { ...s.doctrine.templates, invasion: big } };
    s.production = prodOf([st("st0", SAMINER, {}, { cruiser: 4, frigate: 9, industrial: 9 })]);
    const d = decideReview(s, P);
    const reps = d.intents.filter((i) => i.type === "REPLENISH");
    assert.deepStrictEqual(reps.map((i) => [i.fleetId, i.stationId, i.systemId, i.add, i.cost]),
      [["f1", "st0", SAMINER, [{ hullGroup: "cruiser", count: 4 }], { resourceUnits: 40, reserveUnits: 4 }]],
      JSON.stringify(d.notes));
    assert.ok(!launches(d).some((l) => l.fleets.some((x) => x.fleetId === "f1")), "replenished fleet not launched");
    assert.deepStrictEqual(decideReview(s, P), d, "deterministic");
    assert.deepStrictEqual(decideReview(s, { ...P, replenish: null }).intents.filter((i) => i.type === "REPLENISH"),
      []);
    const cfg = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_LOGISTICS_REPLENISH_ENABLED: "0" } }).config;
    assert.deepStrictEqual([cfg.logistics.replenishEnabled, cfg.logistics.maxReplenishPerReview,
      cfg.logistics.frontStationMaxJumps], [false, 2, 6]);
    const s2 = { ...s, production: prodOf([st("st0", SAMINER, {}, { frigate: 9 })]) };
    const r2 = planReplenish(s2, { affordable: { resourceUnits: 1e4, reserveUnits: 1e3 } }, P,
      createHullLedger(s2, P));
    assert.deepStrictEqual([r2.intents, r2.notes], [[], ["REPLENISH_NO_STOCK"]]);
  });

  test("R3 HULLS_TO_FRONT: the front station F (!= M) with a short fleet -> CONVOY_DISPATCH from M with only "
    + "its surplus above desired; M without surplus -> another station", () => {
    const P = { ...PARAMS, production: PROD, logistics: LOG_R, replenish: REP };
    const HOME = 30001868;
    const T = A_DZA8;
    const s = snap(SANSHA, { fleets: [fleet("f1", T, { composition: [{ hullGroup: "cruiser", typeId: null,
      count: 1 }], shipCount: 1 }), fleet("lf", SAMINER, { fleetRole: "logistics" })] });
    s.doctrine = { ...s.doctrine, templates: { invasion: [{ hullGroup: "cruiser", count: 4 }],
      logistics: [{ hullGroup: "industrial", count: 2 }] } };
    s.logistics = { mode: "ready", open: [], busyFleetIds: [], carriers: { lf: 2 }, truncated: false };
    const supply = { frontTargets: [T], affordable: { resourceUnits: 1e4, reserveUnits: 1e3 } };
    const run = (stations) => {
      const x = { ...s, production: prodOf(stations) };
      const ledger = createHullLedger(x, P);
      const rep = planReplenish(x, supply, P, ledger);
      return planLogistics(x, supply, P, null, ledger, rep).intents.filter((i) => i.type === "CONVOY_DISPATCH")
        .map((i) => [i.purpose, i.sourceStationId, i.destStationId, i.items]);
    };
    const cruisers = (n) => [{ itemKind: "hull", itemKey: "group:cruiser", quantity: n }];
    assert.deepStrictEqual(run([st("stM", SAMINER, {}, { cruiser: 6 }), st("stF", T, {}),
      st("stO", HOME, {}, { cruiser: 3 })]), [["HULLS_TO_FRONT", "stM", "stF", cruisers(2)]], "surplus 6 - 4 only");
    assert.deepStrictEqual(run([st("stM", SAMINER, {}, { cruiser: 4 }), st("stF", T, {}),
      st("stO", HOME, {}, { cruiser: 3 })]), [["HULLS_TO_FRONT", "stO", "stF", cruisers(3)]], "buffer of M untouched");
    assert.deepStrictEqual(run([st("stM", SAMINER, {}, { cruiser: 4 }), st("stF", T, {}, { cruiser: 3 }),
      st("stO", HOME, {}, { cruiser: 3 })]).filter((x) => x[0] === "HULLS_TO_FRONT"), [], "F replenishes locally");
    const refit = fleet("f1", T, { state: "REFITTING", composition: [{ hullGroup: "cruiser", typeId: null, count: 1 }],
      shipCount: 1 });
    const lf2 = fleet("lf2", SAMINER, { fleetRole: "logistics" });
    const runWith = (fleets, stations) => {
      const x = { ...s, fleets, production: prodOf(stations),
        logistics: { ...s.logistics, carriers: { lf: 2, lf2: 2 } } };
      const ledger = createHullLedger(x, P);
      return planLogistics(x, supply, P, null, ledger, planReplenish(x, supply, P, ledger)).intents
        .filter((i) => i.type === "CONVOY_DISPATCH").map((i) => [i.purpose, i.sourceStationId, i.destStationId, i.items]);
    };
    const mJob = (hulls = {}) => ({ ...st("stM", SAMINER, {}, hulls), activeJobs: [{ hullGroup: "cruiser", runs: 1 }] });
    const lfs = [refit, s.fleets[1]];
    assert.deepStrictEqual(runWith(lfs, [mJob(), st("stF", T, {}, { cruiser: 3 })]), [], "front hulls stay in F");
    const refit3 = { ...refit, composition: [{ hullGroup: "cruiser", typeId: null, count: 3 }], shipCount: 3 };
    assert.deepStrictEqual(runWith([refit3, s.fleets[1]], [mJob(), st("stF", T, {}, { cruiser: 3 })]),
      [["HULLS_TO_MOBILIZATION", "stF", "stM", cruisers(2)]], "only the surplus of F above the front demand");
    assert.deepStrictEqual(runWith([{ ...refit3, state: "HOLDING" }, s.fleets[1]],
      [mJob(), st("stF", T, {}, { cruiser: 3 })]), [["HULLS_TO_MOBILIZATION", "stF", "stM", cruisers(2)]],
    "the same demand as a REFITTING fleet");
    const two = [refit, s.fleets[1], lf2];
    assert.deepStrictEqual(runWith(two, [mJob(), st("stF", T, {}), st("stO", HOME, {}, { cruiser: 3 })]),
      [["HULLS_TO_MOBILIZATION", "stO", "stM", cruisers(3)]], "O emptied by the first plan");
    assert.deepStrictEqual(runWith(two, [mJob({ cruiser: 2 }), st("stF", T, {}), st("stO", HOME, {}, { cruiser: 3 })]),
      [["HULLS_TO_MOBILIZATION", "stO", "stM", cruisers(1)], ["HULLS_TO_FRONT", "stO", "stF", cruisers(2)]],
      "the second plan gets only the rest of O");
  });

  test("U2 upkeep brake: resources below offensiveReservePeriods x cost -> no LAUNCH + UPKEEP_RESERVE; more "
    + "systems -> the same resources stop being enough; DORMANT still pays; claim fronts only while fresh", () => {
    const UP = { periodMs: HOUR, maxCatchUpPeriods: 48, incomePerSystem: 3, incomePerStation: 10, reservePerStation: 1,
      maxReserveUnits: 1000, costPerSystem: 1, capturedCostPerSystem: 4, costPerShipPermille: 100,
      offensiveReservePeriods: 24, abandonAfterUnpaidPeriods: 24, maxAbandonsPerReview: 1, tradeIncomeSharePermille: 200,
      maxResourceUnits: 1000000000 };
    const P = { ...PARAMS, upkeep: UP, claimFrontGraceMs: 6 * HOUR };
    const withUpkeep = (n, res) => {
      const s = snap(AMARR);
      s.faction = { ...s.faction, resourceUnits: res };
      s.upkeep = { mode: "ready", paidUntil: AT - (AT % HOUR) - HOUR, unpaidPeriods: 0, controlledCount: n, captured: [],
        capturedTruncated: false, liveShips: 0, stationCount: 1, tradeReady: false };
      return s;
    };
    const ok = decideReview(withUpkeep(10, 1000), P);
    assert.strictEqual(launches(ok).length, 1, JSON.stringify(ok.notes));
    const up = ok.intents.find((i) => i.type === "UPKEEP");
    assert.deepStrictEqual([up.charged, up.delta], [1, 30]);
    assert.ok(ok.intents.indexOf(up) < ok.intents.indexOf(launches(ok)[0]), "economy before war");
    const wide = decideReview(withUpkeep(100, 1000), P);
    assert.deepStrictEqual(launches(wide), [], JSON.stringify(wide.notes));
    assert.ok(wide.notes.includes("UPKEEP_RESERVE") && !wide.notes.includes("FRONT_LIMIT"), JSON.stringify(wide.notes));
    assert.ok(wide.intents.some((i) => i.type === "UPKEEP"), "the charge still runs");
    assert.strictEqual(launches(decideReview(withUpkeep(100, 5000), P)).length, 1, "enough resources -> LAUNCH");
    assert.deepStrictEqual(decideReview(withUpkeep(100, 5000), { ...P, upkeep: null }).intents
      .filter((i) => i.type === "UPKEEP"), [], "upkeep off -> no intent");
    const dormant = withUpkeep(10, 1000);
    dormant.faction = { ...dormant.faction, status: "DORMANT" };
    assert.ok(decideReview(dormant, P).intents.some((i) => i.type === "UPKEEP"), "DORMANT pays too");
    const claim = (phaseDueAt) => ({ ...snap(AMARR), occupations: [{ systemId: 30001954, state: "CONTESTED",
      occupier: AMARR, phaseDueAt }] });
    assert.deepStrictEqual(evaluateSupplyAndFronts(claim(AT - HOUR), P).frontTargets, [30001954]);
    assert.deepStrictEqual(evaluateSupplyAndFronts(claim(AT - 6 * HOUR - 1), P).frontTargets, []);
    assert.deepStrictEqual(evaluateSupplyAndFronts(claim(null), P).frontTargets, []);
  });

  test("B1 border belt (pure): sources = own systems of homeRegionIds with a foreign neighbour; the belt never "
    + "holds nor crosses own space; jump limit; sovereignty self vs any vs friendly; no own space -> off "
    + "candidates", () => {
    const R1 = 10000901;
    const R2 = 10000902;
    const GALLENTE = 500004;
    const [A1, A2, A3, B1, G1] = [30090001, 30090002, 30090003, 30090004, 30090005];
    const [N1, N2, N3, N4, N5] = [30090011, 30090012, 30090013, 30090014, 30090015];
    const sys = (id, region, secClass, factionId) => ({ ...system(id, region, region === R1 ? 20090001 : 20090002,
      secClass), factionId });
    const map = { systems: [sys(A1, R1, "highsec", AMARR), sys(A2, R1, "lowsec", AMARR), sys(A3, R1, "highsec", AMARR),
      sys(B1, R2, "lowsec", AMARR), sys(G1, R2, "highsec", GALLENTE), sys(N1, R1, "nullsec", 0),
      sys(N2, R1, "nullsec", 0), sys(N3, R1, "nullsec", 0), sys(N4, R1, "nullsec", 0), sys(N5, R2, "nullsec", 0)],
    gates: [] };
    for (const [a, b] of [[A3, A1], [A1, A2], [A2, N1], [N1, N2], [N2, N3], [N3, N4], [N2, G1], [N2, B1], [B1, N5]]) {
      map.gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
    }
    const g = buildUniverseGraph(map).graph;
    const input = { factionId: AMARR, ownSpace: { secClasses: ["highsec", "lowsec"], sovereignty: "self" },
      homeRegionIds: [R1], systemsOfClass: (c) => g.getSystemsBySecClass(c), getSystem: (id) => g.getSystem(id),
      neighbors: (id) => g.getNeighbors(id), maxJumps: 4, maxSystems: 2000 };
    const self = ownSpaceBelt(input);
    assert.deepStrictEqual([self.mode, self.sources, [...self.reach.entries()]], ["ready", 1,
      [[N1, 1], [N2, 2], [G1, 3], [N3, 3], [N4, 4]]], "own A1-A3/B1 never in the belt, N5 only behind own B1");
    assert.deepStrictEqual([...ownSpaceBelt({ ...input, maxJumps: 3 }).reach.keys()], [N1, N2, G1, N3]);
    const any = ownSpaceBelt({ ...input, ownSpace: { secClasses: ["highsec", "lowsec"], sovereignty: "any" } });
    assert.deepStrictEqual([...any.reach.keys()], [N1, N2, N3, N4], "any: foreign highsec G1 is own space");
    const both = ownSpaceBelt({ ...input, homeRegionIds: [R1, R2] });
    assert.deepStrictEqual([both.sources, both.reach.get(N5)], [2, 1], "B1 in a home region is a source");
    const friendly = { ...input, ownSpace: { secClasses: ["highsec", "lowsec"], sovereignty: "friendly" } };
    const fr = ownSpaceBelt({ ...friendly, isFriendly: (o) => o === GALLENTE });
    assert.deepStrictEqual([fr.mode, fr.sources, [...fr.reach.entries()]], ["ready", 1,
      [[N1, 1], [N2, 2], [N3, 3], [N4, 4]]], "friendly G1 outside the belt");
    for (const nobody of [{ ...friendly, isFriendly: () => false }, friendly]) {
      assert.deepStrictEqual(ownSpaceBelt(nobody), self, "nobody friendly = self");
    }
    assert.deepStrictEqual(ownSpaceBelt({ ...input, ownSpace: null }), { mode: "off", reason: "NO_OWN_SPACE" });
    assert.deepStrictEqual(ownSpaceBelt({ ...input, factionId: SANSHA }), { mode: "off", reason: "NO_OWN_SPACE" });
    assert.deepStrictEqual(ownSpaceBelt({ ...input, homeRegionIds: [] }), { mode: "off", reason: "NO_SOURCES" });
    const cand = { reach: self.reach, theatre: [N1], expansion: [N3], secClasses: ["nullsec"],
      getSystem: (id) => g.getSystem(id), limit: 2 };
    assert.deepStrictEqual(borderCandidates(cand), [N2, N4], "no theatre / expansion / highsec, sort (jumps, id)");
    assert.deepStrictEqual(borderCandidates({ ...cand, limit: 1 }), [N2]);
    assert.deepStrictEqual(borderCandidates({ ...cand, limit: 0 }), []);
  });

  test("E1 Amarr with the belt (pure): free system 7 jumps from the border (> 5 from the station) -> invasion "
    + "stable Sansha system beyond the theatre -> invasion (raid without hostile in captureTargets); own "
    + "influence >= reclaimMinInfluence -> "
    + "invasion; theatre system -> invasion; a pirate with default fields still captures a hostile system", () => {
    const X = 30009002;
    const Y = 30001956;
    const map = k3StaticMap({ extra: [system(X, 10000022, 20000999, "nullsec")] });
    map.systems = map.systems.map((s) => (s.id === SAMINER ? { ...s, factionId: AMARR } : s));
    map.gates.push({ fromSystemId: 30001948, toSystemId: X }, { fromSystemId: X, toSystemId: 30001948 });
    const g3 = buildUniverseGraph(map).graph;
    const index = createBorderIndex({ registry, getGraph: () => g3, settings: { enabled: true, maxBfsSystems: 2000,
      routeMaxJumps: 40, reach: { empireMaxReachJumps: 10 } } });
    const belt = index.beltOf(AMARR);
    assert.deepStrictEqual([belt.ok, belt.mode, belt.captures, belt.jumps, belt.reach.get(X), belt.reach.has(SAMINER)],
      [true, "ready", true, 10, 7, false]);
    assert.strictEqual(index.beltOf(AMARR), belt, "cached per graph and faction");
    assert.deepStrictEqual(index.beltOf(SANSHA), { ok: true, mode: "off", reason: "NO_OWN_SPACE" });
    const settingsOff = { enabled: false, maxBfsSystems: 2000, routeMaxJumps: 40, reach: { empireMaxReachJumps: 10 } };
    assert.deepStrictEqual(createBorderIndex({ registry, getGraph: () => g3, settings: settingsOff }).beltOf(AMARR),
      { ok: true, mode: "off", reason: "DISABLED" }, "strategy.borderEnabled=false -> only");
    assert.deepStrictEqual(createBorderIndex({ registry, getGraph: () => null, settings: { ...settingsOff,
      enabled: true } }).beltOf(AMARR), { ok: false, reason: "GRAPH_NOT_READY" });
    const near = dist([SAMINER], 5);
    assert.ok(!near.has(X) && !near.has(30001949) && near.has(Y), "X and 30001949 beyond the station capture range");
    const v2 = registry.getDoctrine("amarr-border-defense-v3");
    const P = { ...PARAMS, reclaimMinInfluence: 20 };
    const amarr = (controllers, sysPatch = {}) => {
      const s = snap(AMARR, { controllers, intel: [...controllers.keys()].map((id) => freshIntel(id)) });
      s.neighbors = (id) => g3.getNeighbors(id);
      s.regionOf = (id) => (g3.getSystem(id) || {}).regionId || null;
      s.doctrine = { ...s.doctrine, operationTypes: [...v2.operationTypes], ownSpace: v2.ownSpace,
        borderReachKey: v2.borderReachKey, borderTargets: true, borderCaptures: true,
        captureTargets: [...v2.captureTargets], targetSecClasses: [...v2.targetSecClasses] };
      s.border = { mode: "ready", reach: belt.reach, captures: true, candidates: borderCandidates({ reach: belt.reach,
        theatre: THEATRE, expansion: [], secClasses: v2.targetSecClasses, getSystem: (id) => g3.getSystem(id),
        limit: 64 }) };
      s.systems = s.systems.map((x) => ({ ...x, ownInfluence: 0, ...(sysPatch[x.systemId] || {}) }));
      return s;
    };
    const ownTheatre = () => new Map(THEATRE.map((id) => [id, AMARR]));
    const only = (d) => launches(d).map((l) => [l.kind, l.target.systemId]);
    const free = ownTheatre().set(X, null);
    assert.deepStrictEqual(only(decideReview(amarr(free), P)), [["invasion", X]]);
    const hostile = ownTheatre().set(Y, SANSHA);
    const noHostile = (s) => ({ ...s, doctrine: { ...s.doctrine, captureTargets: ["free", "contested"] } });
    for (let seed = 1; seed <= 5; seed += 1) {
      assert.deepStrictEqual(only(decideReview({ ...amarr(hostile), seed }, P)), [["invasion", Y]], `seed ${seed}`);
      assert.deepStrictEqual(only(decideReview({ ...noHostile(amarr(hostile)), seed }, P)), [["raid", Y]], `seed ${seed}`);
    }
    assert.deepStrictEqual(only(decideReview(noHostile(amarr(hostile, { [Y]: { ownInfluence: 19 } })), P)),
      [["raid", Y]]);
    assert.deepStrictEqual(only(decideReview(noHostile(amarr(hostile, { [Y]: { ownInfluence: 20 } })), P)),
      [["invasion", Y]]);
    assert.deepStrictEqual(only(decideReview(amarr(hostile, { [Y]: { occupationState: "OCCUPIED" } }), P)),
      [["invasion", Y]], "not STABLE -> contested");
    const theatre = ownTheatre().set(30001949, SANSHA);
    assert.deepStrictEqual(only(decideReview(amarr(theatre), P)), [["invasion", 30001949]]);
    const pc = new Map(THEATRE.map((id) => [id, SANSHA])).set(Y, AMARR);
    const pirate = snap(SANSHA, { controllers: pc, stations: [30001954], intel: [{ ...freshIntel(Y),
      controllerFactionId: AMARR }] });
    pirate.expansion = [Y];
    pirate.systems = pirate.systems.map((x) => ({ ...x, ownInfluence: 0 }));
    const facts = describe(pirate, P, new Map(), Y);
    assert.deepStrictEqual([facts.category, facts.captureAllowed], ["hostile", true]);
    assert.deepStrictEqual(only(decideReview(pirate, P)), [["invasion", Y]]);
  });

  test("D2 two empires (pure, registry v8 + border.js): Caldari and Gallente belts ready and logged; friendly "
    + "empire high/lowsec is own space: never held nor crossed, sources only on the own border; a shared "
    + "nullsec candidate controlled by the other empire is no target (category null)", () => {
    const CALDARI = 500001;
    const GALLENTE = 500004;
    const [CH, CL, GH, GL] = [30091001, 30091002, 30091003, 30091004];
    const [N1, N2, N3] = [30091011, 30091012, 30091013];
    const map = { systems: [system(CH, 10000016, 20091001, "highsec", CALDARI),
      system(CL, 10000016, 20091001, "lowsec", CALDARI), system(GH, 10000048, 20091002, "highsec", GALLENTE),
      system(GL, 10000048, 20091002, "lowsec", GALLENTE), system(N1, 10000901, 20091003, "nullsec"),
      system(N2, 10000901, 20091003, "nullsec"), system(N3, 10000901, 20091003, "nullsec")], gates: [] };
    for (const [a, b] of [[CH, CL], [CL, N1], [N1, N2], [N2, GL], [GL, GH], [GH, CH], [GL, N3]]) {
      map.gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
    }
    const g = buildUniverseGraph(map).graph;
    const lines = [];
    const index = createBorderIndex({ registry, getGraph: () => g, logger: { log: (l) => lines.push(l) },
      hostility: createHostility(),
      settings: { enabled: true, maxBfsSystems: 2000, routeMaxJumps: 40, reach: { empireMaxReachJumps: 10 } } });
    const cal = index.beltOf(CALDARI);
    const gal = index.beltOf(GALLENTE);
    assert.deepStrictEqual([cal.mode, cal.sources, cal.captures, [...cal.reach.entries()].sort((a, b) => a[0] - b[0])],
      ["ready", 1, true, [[N1, 1], [N2, 2]]], "N3 only behind friendly GL");
    assert.deepStrictEqual([gal.mode, gal.sources, gal.captures, [...gal.reach.entries()].sort((a, b) => a[0] - b[0])],
      ["ready", 1, true, [[N1, 2], [N2, 1], [N3, 1]]]);
    assert.ok(![GH, GL].some((id) => cal.reach.has(id)) && ![CH, CL].some((id) => gal.reach.has(id)));
    assert.deepStrictEqual(lines, ["strategy: 500001 border belt=2 sources=1 jumps=10 captures=true",
      "strategy: 500004 border belt=3 sources=1 jumps=10 captures=true"]);
    const doctrine = registry.getDoctrine("empire-border-defense-v2");
    const cand = (belt) => borderCandidates({ reach: belt.reach, theatre: [], expansion: [],
      secClasses: doctrine.targetSecClasses, getSystem: (id) => g.getSystem(id), limit: 64 });
    assert.deepStrictEqual([cand(cal), cand(gal)], [[N1, N2], [N2, N3, N1]], "nullsec only, sort (jumps, id)");
    const s = snap(GALLENTE, { controllers: new Map([[N1, CALDARI]]) });
    s.doctrine = { ...s.doctrine, captureTargets: [...doctrine.captureTargets] };
    const facts = describe(s, PARAMS, new Map(), N1);
    assert.deepStrictEqual([facts.hostileController, facts.category, facts.captureAllowed], [false, null, false]);
  });

  test("N1 belt slots (pure): isBorderTarget = row with no or a hostile foreign controller "
    + "borderCandidates filters by accept before the limit", () => {
    const CALDARI = 500001;
    const isHostile = (o) => o === SANSHA;
    const row = (controllerFactionId) => ({ controllerFactionId });
    assert.deepStrictEqual([isBorderTarget(undefined, AMARR, isHostile), isBorderTarget(null, AMARR, isHostile),
      isBorderTarget(row(null), AMARR, isHostile), isBorderTarget(row(AMARR), AMARR, isHostile),
      isBorderTarget(row(CALDARI), AMARR, isHostile), isBorderTarget(row(SANSHA), AMARR, isHostile)],
    [false, false, true, false, false, true]);
    const [a, b, c, d, e] = [30092001, 30092002, 30092003, 30092004, 30092005];
    const rows = new Map([[a, row(AMARR)], [b, row(CALDARI)], [c, row(SANSHA)], [d, row(null)], [e, row(SANSHA)]]);
    const input = { reach: new Map([[a, 1], [b, 1], [c, 2], [d, 2], [e, 3]]), theatre: [], expansion: [],
      secClasses: ["nullsec"], getSystem: () => ({ secClass: "nullsec", regionId: 10000901 }), limit: 2 };
    assert.deepStrictEqual(borderCandidates({ ...input, accept: (id) => isBorderTarget(rows.get(id), AMARR,
      isHostile) }), [c, d], "own a and friendly b skipped before the limit");
    assert.deepStrictEqual(borderCandidates(input), [a, b], "no accept = as before");
  });

  test("CB1 BUG confinedToBelt (pure, P3): a police doctrine picks only systems of the belt map "
    + "(supply.border), never a theatre system outside it; no belt -> NO_CANDIDATE, no throw; decideReview REVIEWED", () => {
    const [PAYE, SAGAIN] = [30001718, 30001719];
    const police = registry.getDoctrine("concord-border-police-v1");
    assert.strictEqual(police.confinedToBelt, true);
    const controllers = new Map([...THEATRE.map((id) => [id, SANSHA]), [SAGAIN, SANSHA]]);
    const beltReach = new Map([[SAGAIN, 1]]);
    const concord = (confinedToBelt) => {
      const s = snap(CONCORD, { home: PAYE, stations: [PAYE], controllers,
        intel: [...controllers.keys()].map((id) => freshIntel(id)) });
      s.doctrine = { ...s.doctrine, operationTypes: [...police.operationTypes], ownSpace: police.ownSpace,
        borderReachKey: police.borderReachKey, borderTargets: true, borderCaptures: false, captureTargets: [],
        targetSecClasses: [...police.targetSecClasses], confinedToBelt };
      s.border = { mode: "ready", reach: beltReach, captures: false, candidates: [SAGAIN] };
      return s;
    };
    const supply = (border) => ({ anchors: [PAYE], reach: new Map([[SAGAIN, 1], ...THEATRE.map((id) => [id, 2])]),
      captureReach: new Map(), frontTargets: [], border });
    const picks = (s, sup) => {
      const out = new Set();
      for (let seed = 1; seed <= 20; seed += 1) {
        const r = chooseTargetSystem(s, sup, PARAMS, createRng(seed));
        out.add(r.ok ? r.systemId : r.reason);
      }
      return [...out].sort((a, b) => String(a).localeCompare(String(b)));
    };
    assert.deepStrictEqual(picks(concord(true), supply(beltReach)), [SAGAIN], "only the belt");
    const count = (s) => chooseTargetSystem(s, supply(beltReach), PARAMS, createRng(1)).candidates;
    assert.strictEqual(count(concord(true)), 1);
    assert.ok(count(concord(false)) > 1, "theatre candidates without the confinement");
    assert.deepStrictEqual(picks(concord(true), supply(new Map())), ["NO_CANDIDATE"], "belt off -> empty map");
    assert.deepStrictEqual(picks(concord(true), supply(undefined)), ["NO_CANDIDATE"], "no belt field");
    const d = decideReview(concord(true), PARAMS);
    assert.deepStrictEqual([d.outcome, d.reason], ["REVIEWED", null]);
    for (const l of launches(d)) assert.ok(beltReach.has(l.target.systemId), JSON.stringify(l.target));
  });

  test("S1 planReturns (pure): IDLE outside a base >= returnAfterIdleMs -> LAUNCH return to the nearest "
    + "own station; below / non-return roles / refit / at a station / taken this round / no returnToBase -> never; "
    + "limit; round guards; RETURN_NO_BASE / RETURN_NO_IDLE_SINCE; a return is no front; return -> escort", () => {
    const [PAYE, SAGAIN, S1957, S1956] = [30001718, 30001719, 30001957, 30001956];
    const IDLE_MS = HOUR / 2;
    const P = { ...PARAMS, returnAfterIdleMs: IDLE_MS, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 2,
      returnFleetRoles: [...kinds.get("return").fleetRoles] };
    const idle = (id, systemId, extra = {}) => fleet(id, systemId, { fleetRole: "patrol", updatedAt: AT - IDLE_MS,
      ...extra });
    const concord = (fleets, o = {}) => {
      const s = snap(CONCORD, { home: PAYE, stations: [PAYE], fleets, ...o });
      s.doctrine = { ...s.doctrine, returnToBase: true };
      return s;
    };
    const plan = (s, params = P, used = new Set()) => planReturns(s, evaluateSupplyAndFronts(s, params), params, used);
    const back = (r) => r.intents.map((i) => [i.fleets[0].fleetId, i.originSystemId, i.target.systemId]);

    const all = [idle("f-young", SAMINER, { updatedAt: AT - IDLE_MS + 1 }), idle("f-ok", SAGAIN),
      idle("f-garrison", SAGAIN, { fleetRole: "garrison" }), idle("f-miner", SAGAIN, { fleetRole: "mining" }),
      idle("f-log", SAGAIN, { fleetRole: "logistics" }), idle("f-refit", SAGAIN, { refitPending: true }),
      idle("f-home", PAYE), idle("f-op", SAGAIN, { operationId: "op-x" }),
      idle("f-travel", SAGAIN, { state: "TRAVELLING" })];
    const r = plan(concord(all));
    assert.deepStrictEqual(r, { notes: [], intents: [{ type: "LAUNCH", kind: "return",
      target: { kind: "system", systemId: PAYE, ref: null }, originSystemId: SAGAIN,
      fleets: [{ fleetId: "f-ok", expectedVersion: 1 }], mobilize: [], dueAt: AT + 2 * HOUR }] });
    assert.deepStrictEqual(plan(concord(all)), r, "deterministic");
    const used = new Set(["f-ok"]);
    assert.deepStrictEqual(plan(concord(all), P, used).intents, [], "taken by chooseNextOperation this round");
    const fresh = new Set();
    plan(concord(all), P, fresh);
    assert.ok(fresh.has("f-ok"), "a planned return marks its fleet used");
    const noDoctrine = concord(all);
    noDoctrine.doctrine = { ...noDoctrine.doctrine, returnToBase: false };
    assert.deepStrictEqual(plan(noDoctrine), { intents: [], notes: [] });

    const three = [idle("f-c", S1957), idle("f-a", SAGAIN), idle("f-b", SAMINER)];
    assert.deepStrictEqual(back(plan(concord(three))), [["f-a", SAGAIN, PAYE], ["f-b", SAMINER, PAYE]]);
    assert.deepStrictEqual(plan(concord(three), { ...P, maxReturnsPerReview: 0 }).intents, []);
    assert.deepStrictEqual(plan({ ...concord(three), fleetsTruncated: true }).intents, []);
    assert.deepStrictEqual(plan({ ...concord(three), operationsTruncated: true }).intents, []);
    const ready = concord(three);
    assert.deepStrictEqual(planReturns({ ...ready, stationsMode: "pending" }, evaluateSupplyAndFronts(ready, P), P,
      new Set()).intents, []);
    assert.deepStrictEqual(plan(concord(three, { stations: [] })).intents, []);
    assert.deepStrictEqual(back(plan(concord([idle("t-mid", SAGAIN), idle("t-far", S1957)],
      { stations: [SAMINER, PAYE] }))), [["t-far", S1957, SAMINER], ["t-mid", SAGAIN, PAYE]]);
    assert.deepStrictEqual(plan(concord([idle("n-far", S1956)]), { ...P, maxAssemblyJumps: 2 }),
      { intents: [], notes: ["RETURN_NO_BASE"] });
    assert.deepStrictEqual(plan(concord([idle("n-old", SAGAIN, { updatedAt: undefined })])),
      { intents: [], notes: ["RETURN_NO_IDLE_SINCE"] });

    const retOp = { operationId: "op-r", version: 2, state: "ACTIVE", operationType: "return", targetSystemId: SAMINER,
      dueAt: AT + HOUR, members: 1, orderedMembers: 1 };
    const amarr = snap(AMARR, { frontLimit: 1, maxActiveFronts: 1, operations: [retOp],
      fleets: [fleet("r-travel", 30001954, { state: "TRAVELLING", operationId: "op-r" }),
        fleet("r-idle", S1956, { updatedAt: AT - IDLE_MS })] });
    amarr.doctrine = { ...amarr.doctrine, returnToBase: true };
    const d = decideReview(amarr, P);
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    assert.deepStrictEqual([d.supply.frontCount, d.supply.frontTargets], [0, []], "return opens no front");
    const offensive = launches(d).filter((l) => l.kind !== "return");
    const returns = launches(d).filter((l) => l.kind === "return");
    assert.strictEqual(offensive.length, 1, JSON.stringify(d.notes));
    const ids = launches(d).flatMap((l) => l.fleets.map((x) => x.fleetId));
    assert.strictEqual(ids.length, new Set(ids).size, "a fleet in at most one LAUNCH");
    assert.deepStrictEqual(returns.map((l) => [l.fleets[0].fleetId, l.target.systemId]), [["r-idle", SAMINER]]);

    const rk = kinds.get("return");
    assert.deepStrictEqual([rk.offensive, rk.opensFront, rk.captures, rk.objective], [false, false, false, "return"]);
    assert.strictEqual(OBJECTIVE_MAP.return, "escort");
  });

  test("D4 siege AI (pure): a fleet in its own siege is never in a LAUNCH / return and the siege is a front "
    + "planRelief picks the nearest IDLE fleets (own defenders count), RELIEF_INSUFFICIENT, no duplicate of an open "
    + "defense, the reliefLeadMs window; deterministic", () => {
    const [PAYE, SAGAIN, S1956] = [30001718, 30001719, 30001956];
    const fromSaminer = dist([SAMINER], 15);
    assert.ok(fromSaminer.get(SAGAIN) < fromSaminer.get(S1956), "fixture: Sagain nearer to Saminer");
    const SIEGE = { reliefEnabled: true, reliefLeadMs: 6 * HOUR, reliefHoldMs: HOUR, maxReliefPerReview: 1,
      fleetRoles: ["invasion", "patrol", "garrison"] };
    const P = { ...PARAMS, siege: SIEGE, returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 4,
      returnFleetRoles: [...kinds.get("return").fleetRoles] };
    const one = strengthOf(COMP, POWER);
    const old = { updatedAt: AT - HOUR };
    const besieged = (o = {}) => ({ siegeId: "sg1", stationId: "st0", systemId: SAMINER, state: "SHIELD_ASSAULT",
      phaseEndsAt: AT + HOUR, attackerFactionId: SANSHA, attackerStrength: one, ...o });
    const amarr = (o = {}) => {
      const s = snap(AMARR, { frontLimit: 2, maxActiveFronts: 2, stations: [SAMINER, PAYE],
        fleets: o.fleets || [fleet("s-hold", A_DZA8, old), fleet("d-here", SAMINER, { fleetRole: "garrison", ...old }),
          fleet("r-near", SAGAIN, { fleetRole: "patrol", ...old }), fleet("r-far", S1956, old)],
        operations: o.operations });
      s.doctrine = { ...s.doctrine, returnToBase: true };
      s.siege = { mode: "ready",
        attacking: [{ siegeId: "sg0", systemId: A_DZA8, stationId: "x", state: "ARMOR_TIMER" }], defending: o.defending || [besieged()], truncated: false };
      return s;
    };
    const d = decideReview(amarr(), P);
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    const relief = launches(d).filter((l) => l.kind === "defense");
    assert.deepStrictEqual(relief, [{ type: "LAUNCH", kind: "defense", target: { kind: "system", systemId: SAMINER,
      ref: null }, originSystemId: SAGAIN, fleets: [{ fleetId: "r-near", expectedVersion: 1 }], mobilize: [],
    dueAt: AT + 2 * HOUR }]);
    const ids = launches(d).flatMap((l) => l.fleets.map((x) => x.fleetId));
    assert.ok(!ids.includes("s-hold") && !ids.includes("d-here"), JSON.stringify(launches(d)));
    assert.strictEqual(ids.length, new Set(ids).size, "a fleet in at most one LAUNCH");
    assert.ok(d.supply.frontTargets.includes(A_DZA8), "an own siege is a front");
    assert.deepStrictEqual(decideReview(amarr(), P), d, "deterministic");
    const free = amarr();
    free.siege = null;
    assert.ok(launches(decideReview(free, P)).some((l) => l.fleets.some((x) => x.fleetId === "s-hold")));

    const plan = (s, p = P) => planRelief(s, evaluateSupplyAndFronts(s, p), p);
    assert.deepStrictEqual(plan(amarr({ defending: [besieged({ attackerStrength: 100 * one })] })),
      { intents: [], notes: ["RELIEF_INSUFFICIENT"], fleetIds: [] });
    const openDefense = [{ operationId: "op-d", version: 2, state: "ACTIVE", operationType: "defense",
      targetSystemId: SAMINER, dueAt: AT + HOUR, members: 1, orderedMembers: 1 }];
    assert.deepStrictEqual(plan(amarr({ operations: openDefense })).intents, [], "no duplicate of an open defense");
    const timer = (ms) => plan(amarr({ defending: [besieged({ state: "ARMOR_TIMER", phaseEndsAt: AT + ms })] }));
    assert.deepStrictEqual([timer(6 * HOUR + 1).intents.length, timer(6 * HOUR).intents.length], [0, 1], "lead window");
    assert.strictEqual(timer(6 * HOUR).intents[0].dueAt, AT + 7 * HOUR, "phaseEndsAt + reliefHoldMs");
    assert.deepStrictEqual(plan(amarr(), { ...P, siege: { ...SIEGE, reliefEnabled: false } }).intents, []);
    assert.deepStrictEqual(plan({ ...amarr(), siege: { mode: "off", attacking: [], defending: [] } }).intents, []);
    const k = kinds.get("defense");
    assert.deepStrictEqual([k.enabled, k.offensive, k.opensFront], [true, false, false], "only planRelief uses it");
  });

  test("HR1 hullsRequired:false: mobilizeHulls=required, empty hulls -> MOBILIZE with stationId:null, hulls:[], no NO_HULLS", () => {
    const P = { ...PARAMS, production: { ...PROD, miningNeedsHulls: false, logisticsNeedsHulls: false } };
    const s = snap(AMARR);
    s.doctrine = { ...s.doctrine, hullsRequired: false };
    s.production = prodOf([st("st0", SAMINER, { tritanium: 10000 }, {})]);
    const d = decideReview(s, P);
    assert.strictEqual(d.hullPolicy, "required", "hullPolicy should be required");
    const noHullsNotes = d.notes.filter((n) => n.startsWith("NO_HULLS"));
    assert.strictEqual(noHullsNotes.length, 0, "should not have NO_HULLS notes, got: " + JSON.stringify(d.notes));
  });

  test("HR2 faction hullsRequired:true (or missing): mobilizeHulls=required, empty hulls -> NO_HULLS, zero MOBILIZE", () => {
    const P = { ...PARAMS, production: { ...PROD, miningNeedsHulls: false, logisticsNeedsHulls: false } };
    const controllers = new Map(THEATRE.map((id) => [id, AMARR]));
    const intel = THEATRE.map((id) => freshIntel(id, 1000)).concat(freshIntel(SAMINER));
    const s = snap(SANSHA, {
      controllers,
      stations: [SAMINER],
      fleets: [],
      intel
    });
    s.doctrine = { ...s.doctrine, hullsRequired: true };
    s.production = prodOf([st("st0", SAMINER, {}, {})]);
    const d = decideReview(s, P);
    const mobilizes = d.intents.filter((i) => i.type === "MOBILIZE");
    assert.strictEqual(mobilizes.length, 0, "should not mobilize: " + JSON.stringify(d.notes));
    const noHullsNotes = d.notes.filter((n) => n.startsWith("NO_HULLS"));
    assert.ok(noHullsNotes.length > 0, "should have NO_HULLS note, got: " + JSON.stringify(d.notes));
  });

  test("HR3 createHullLedger and hullTargets: hullsRequired:false -> needs=false, policy=required, hullTargets={}", () => {
    const P = { ...PARAMS, production: { ...PROD, miningNeedsHulls: false, logisticsNeedsHulls: false } };
    const snapshots = {
      production: prodOf([st("st0", SAMINER, {}, {})]),
      doctrine: { templates: { patrol: [{ hullGroup: "frigate", count: 3 }], logistics: [{ hullGroup: "industrial", count: 2 }] }, hullsRequired: false }
    };
    const ledger = createHullLedger(snapshots, P);
    assert.strictEqual(ledger.policy, "required", "policy should be required");
    assert.strictEqual(ledger.needs("patrol"), false, "needs(patrol) should be false");
    assert.strictEqual(ledger.needs("logistics"), false, "needs(logistics) should be false");
    assert.strictEqual(ledger.needs("scout"), false, "needs(scout) should be false");

    const doctrine = { ...snapshots.doctrine };
    const targets = hullTargets(doctrine, PROD);
    assert.deepStrictEqual(targets, {}, "hullTargets should return empty object for hullsRequired:false");
  });

  test("GD1 galaxy-density reviewRowBound: earlier defaults (all modules, hulls required, 2 returns) = 803 "
    + "maxOperationsPerReview +1 = 17 + 5F, independent of mobilizations; maxMobilizationsPerReview +1 = 25", () => {
    const { reviewRowBound } = require("../../lib/strategy/reviewRows");
    const s = { maxObservationsPerReview: 8, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
      maxOperationsPerReview: 1, maxMobilizationsPerReview: 2, maxFleetsPerOperation: 4,
      maxTerritoryMarksPerReview: 8, maxUpgradesPerReview: 2, territoryTrimEnabled: true, maxReturnsPerReview: 2 };
    const m = { maxDispatchesPerReview: 3, pruneBatch: 8, maxMobilizationsPerReview: 1, maxReleasesPerReview: 2 };
    const p = { maxJobsPerReview: 8, pruneBatch: 8, mobilizeHulls: "required", miningNeedsHulls: false,
      industryEnabled: true, maxIndustryJobsPerReview: 2 };
    const u = { maxAbandonsPerReview: 1, maxFactionsPerSystem: 8 };
    const l = { maxDispatchesPerReview: 2, maxCargoItems: 12, pruneBatch: 8, maxMobilizationsPerReview: 1,
      needsHulls: false, replenishEnabled: true, maxReplenishPerReview: 2, retireEnabled: true, maxRetiresPerReview: 2 };
    const rest = [m, p, u, l, { maxBuildsPerReview: 1 }, { maxReliefPerReview: 1 },
      { maxOffersPerReview: 2, maxCancelsPerReview: 4 }];
    const bound = (o) => reviewRowBound({ ...s, ...o }, ...rest);
    assert.strictEqual(bound({}), 803);
    assert.strictEqual(bound({ maxReturnsPerReview: 3 }) - bound({}), 10);
    for (const mob of [1, 2, 3]) {
      for (const F of [4, 6]) {
        assert.strictEqual(bound({ maxOperationsPerReview: 2, maxMobilizationsPerReview: mob, maxFleetsPerOperation: F })
          - bound({ maxOperationsPerReview: 1, maxMobilizationsPerReview: mob, maxFleetsPerOperation: F }), 17 + 5 * F,
        `mob ${mob} F ${F}`);
      }
    }
    assert.strictEqual(bound({ maxOperationsPerReview: 2 }) - bound({}), 37);
    assert.strictEqual(bound({ maxMobilizationsPerReview: 3 }) - bound({}), 25);
  });

  test("GD2 galaxy-density chooseNextOperation: 2 operations, 2 fronts, 3 mobilizations, no free fleets -> "
    + "standalone MOBILIZE + sum of LAUNCH.mobilize <= 3 (one shared counter)", () => {
    const P = { ...PARAMS, maxOperationsPerReview: 2, maxMobilizationsPerReview: 3, maxFleetsPerFaction: 100 };
    const strong = THEATRE.filter((id) => id !== SAMINER).map((id) => freshIntel(id, 1e9));
    const counts = [];
    for (const intel of [[], strong]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const s = snap(AMARR, { frontLimit: 2, maxActiveFronts: 2, seed, intel });
        s.faction = { ...s.faction, resourceUnits: 1e9, reserveUnits: 1e9 };
        const d = decideReview(s, P);
        assert.strictEqual(d.outcome, "REVIEWED", String(d.reason));
        const n = d.intents.filter((i) => i.type === "MOBILIZE").length
          + launches(d).reduce((acc, i) => acc + i.mobilize.length, 0);
        assert.ok(n <= 3, `seed ${seed}: ${n} mobilizations, notes ${JSON.stringify(d.notes)}`);
        counts.push(n);
      }
    }
    assert.ok(counts.some((n) => n > 0), `the scenario mobilizes (${counts})`);
  });

  test("GD3 galaxy-density decideReview FACTION_TOUCH: row frontLimit 1, entry 2, cap 2 -> frontLimit 2 "
    + "row 2 -> no field", () => {
    const P = { ...PARAMS, frontLimitCap: 2 };
    const touchOf = (d) => d.intents.find((i) => i.type === "FACTION_TOUCH");
    const t1 = touchOf(decideReview(snap(AMARR, { frontLimit: 1, maxActiveFronts: 2 }), P));
    assert.strictEqual(t1.frontLimit, 2);
    const t2 = touchOf(decideReview(snap(AMARR, { frontLimit: 2, maxActiveFronts: 2 }), P));
    assert.ok(t2 && !("frontLimit" in t2), JSON.stringify(t2));
    const t3 = touchOf(decideReview(snap(AMARR, { frontLimit: 2, maxActiveFronts: 3 }), { ...P, frontLimitCap: 1 }));
    assert.strictEqual(t3.frontLimit, 1, "the cap wins");
  });

  test("TP4 hunt: hunters never count against strategy.maxFleetsPerFaction (chooseNextOperation, D-1)", () => {
    const P = { ...PARAMS, maxFleetsPerFaction: 2 };
    const busy = fleet("c1", SAMINER, { state: "TRAVELLING" });
    const run = (role) => {
      const s = snap(AMARR, { fleets: [busy, fleet("h1", SAMINER, { fleetRole: role }),
        fleet("h2", SAMINER, { fleetRole: role })] });
      return chooseNextOperation(s, evaluateSupplyAndFronts(s, P), P, createRng(s.seed), null);
    };
    const hunters = run("hunter");
    assert.ok(!hunters.notes.includes("FLEET_LIMIT"), JSON.stringify(hunters.notes));
    const mobs = hunters.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
    assert.ok(mobs.length > 0, JSON.stringify(hunters));
    assert.ok(run("invasion").notes.includes("FLEET_LIMIT"), "the control case hits the limit");
  });

  test("OB1 BUG idle-fleets: observationOrder ranks a standing own scout right after the fronts", () => {
    const fleets = [{ systemId: 10, state: "IDLE", fleetRole: "invasion" },
      { systemId: 20, state: "IDLE", fleetRole: "scout" },
      { systemId: 30, state: "STAGED", fleetRole: "patrol" },
      { systemId: 40, state: "TRAVELLING", fleetRole: "scout" },
      { systemId: 50, state: "IDLE" },
      { systemId: 5, state: "IDLE", fleetRole: "mining" }];
    assert.deepStrictEqual(observationOrder(fleets, [30], [10, 50], 8), [30, 20, 10, 50, 5]);
    assert.deepStrictEqual(observationOrder(fleets, [30], [10, 50], 2), [30, 20], "the limit keeps the scout system");
  });

  test("RS1 BUG idle-fleets: own IDLE scout in a stale target -> no recon on it, RECON_ON_SITE, the next target "
    + "gets the recon", () => {
    const P = { ...PARAMS, maxOperationsPerReview: 2 };
    const run = (fleets) => {
      const s = snap(AMARR, { frontLimit: 2, maxActiveFronts: 2, fleets });
      return chooseNextOperation(s, evaluateSupplyAndFronts(s, P), P, createRng(s.seed), null);
    };
    const base = run([]);
    const first = launches(base)[0];
    assert.ok(first && first.kind === "recon", JSON.stringify(base));
    const T = first.target.systemId;
    const out = run([fleet("sc1", T, { fleetRole: "scout" })]);
    assert.ok(out.notes.includes("RECON_ON_SITE"), JSON.stringify(out.notes));
    assert.strictEqual(out.notes.filter((n) => n === "RECON_ON_SITE").length, 1);
    assert.ok(!out.intents.some((i) => i.target && i.target.systemId === T), JSON.stringify(out.intents));
    const recon = launches(out);
    assert.ok(recon.length >= 1 && recon.every((l) => l.kind === "recon" && l.target.systemId !== T),
      JSON.stringify(out.intents));
    const mobs = out.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
    assert.ok(!mobs.some((m) => m.role === "scout"), "the standing scout is reused, no new scout");
  });

  test("RC1: repeat - a stale target under a recon cooldown (Amarr, not "
    + "CONCORD) gets no recon LAUNCH / MOBILIZE, RECON_COOLDOWN once, the next target gets the recon; fresh intel on "
    + "it -> as without the field; no field / empty list -> as before", () => {
    const P = { ...PARAMS, maxOperationsPerReview: 2 };
    const run = (o) => {
      const s = snap(AMARR, { frontLimit: 2, maxActiveFronts: 2, ...o.snap });
      if (o.cooldowns !== undefined) s.reconCooldowns = o.cooldowns;
      return chooseNextOperation(s, evaluateSupplyAndFronts(s, P), P, createRng(s.seed), null);
    };
    const base = run({});
    const first = launches(base)[0];
    assert.ok(first && first.kind === "recon", JSON.stringify(base));
    const T = first.target.systemId;
    assert.deepStrictEqual(run({ cooldowns: [] }), base, "empty list = no field");
    const stale = { systemId: T, observedAt: AT - 10 * HOUR, hostileFleets: 1, hostileShips: 4,
      hostileStrength: 100, hostileStations: 0, controllerFactionId: SANSHA };
    const cooled = run({ snap: { intel: [stale] }, cooldowns: [T] });
    assert.strictEqual(cooled.notes.filter((n) => n === "RECON_COOLDOWN").length, 1, JSON.stringify(cooled.notes));
    assert.ok(!cooled.intents.some((i) => i.target && i.target.systemId === T), JSON.stringify(cooled.intents));
    const recon = launches(cooled);
    assert.ok(recon.length >= 1 && recon.every((l) => l.kind === "recon" && l.target.systemId !== T),
      JSON.stringify(cooled.intents));
    const fresh = { snap: { intel: [freshIntel(T, 1e9)] } };
    const withField = run({ ...fresh, cooldowns: [T] });
    assert.deepStrictEqual(withField, run(fresh));
    assert.ok(!withField.notes.includes("RECON_COOLDOWN"));
  });

  const flgRun = (others) => {
    const P = { ...PARAMS, maxFleetsPerFaction: 24 };
    const s = snap(AMARR, { intel: THEATRE.map((id) => freshIntel(id, 0)),
      fleets: [fleet("s1", SAMINER, { fleetRole: "scout", state: "TRAVELLING" }), ...others] });
    s.faction = { ...s.faction, resourceUnits: 1e6, reserveUnits: 1e6 };
    s.doctrine = { ...s.doctrine, templates: { ...s.doctrine.templates, invasion: [{ hullGroup: "cruiser", count: 4 }] } };
    const out = chooseNextOperation(s, evaluateSupplyAndFronts(s, P), P, createRng(s.seed), null);
    const mobs = out.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
    return { out, mobs };
  };
  const flgMany = (prefix, extra) => Array.from({ length: 24 }, (_v, i) => fleet(`${prefix}${i}`, SAMINER, extra));

  test("FLG1 bug-fleet-limit-garrisons: 24 garrisons + 1 scout, fresh intel, invasion template -> "
    + "MOBILIZE of role invasion, no FLEET_LIMIT", () => {
    const { out, mobs } = flgRun(flgMany("g", { fleetRole: "garrison" }));
    assert.ok(!out.notes.includes("FLEET_LIMIT"), JSON.stringify(out.notes));
    assert.ok(mobs.some((m) => m.role === "invasion"), JSON.stringify(out));
  });

  test("FLG2 bug-fleet-limit-garrisons: 24 busy combat fleets (invasion / scout) -> still FLEET_LIMIT", () => {
    for (const role of ["invasion", "scout"]) {
      const { out, mobs } = flgRun(flgMany("c", { fleetRole: role, state: "TRAVELLING" }));
      assert.ok(out.notes.includes("FLEET_LIMIT"), `${role}: ${JSON.stringify(out.notes)}`);
      assert.deepStrictEqual(mobs, [], role);
    }
  });

  test("RF1 BUG ai-raid-fallback (A3/A4): a blocked capture (TERRITORY_LIMIT, CAPTURE_NOT_ADJACENT) of an "
    + "expansion target picked as a lost-home raid -> LAUNCH raid + the note once, no TypeError", () => {
    const F = 7;
    const H = 9;
    const HOME = 1;
    const MID = 2;
    const T = 3;
    const adj = { [HOME]: [MID], [MID]: [HOME, T], [T]: [MID] };
    const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId,
      occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, ...extra });
    const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
      faction: { status: "ACTIVE", homeSystemId: HOME, frontLimit: 1 }, entry: { homeRegionIds: [] },
      doctrine: { doctrineId: "rf1", canOccupy: true, captureTargets: ["hostile"],
        operationTypes: ["recon", "invasion", "raid"], templates: {} },
      theatre: [], expansion: [T], lostHome: { systemIds: [T] },
      neighbors: (id) => adj[id] || [], regionOf: () => null, isHostile: (x) => x === H,
      stations: [{ systemId: HOME, stationId: "st0" }],
      systems: [row(HOME, F), row(MID, null), row(T, H, { homeFactionId: F })],
      fleets: [fleet("f1", MID)], operations: [], operationsTruncated: false,
      intel: [{ ...freshIntel(T), controllerFactionId: H }], sightings: [] };
    const supplyOf = (captureRoom) => ({ frontTargets: [], frontLimit: 1, anchors: [HOME], stationSystems: [HOME],
      affordable: { resourceUnits: 1e6, reserveUnits: 1e6 }, reach: new Map([[MID, 1], [T, 2]]),
      captureReach: new Map([[MID, 1], [T, 2]]), captureRoom, border: new Map() });
    for (const [note, captureRoom, captureRequiresAdjacency] of [["TERRITORY_LIMIT", 0, false],
      ["CAPTURE_NOT_ADJACENT", null, true]]) {
      const P = { ...PARAMS, captureRequiresAdjacency };
      const r = chooseNextOperation(s, supplyOf(captureRoom), P, createRng(1), null);
      assert.deepStrictEqual(launches(r).map((i) => [i.kind, i.target.systemId, i.fleets.map((x) => x.fleetId)]),
        [["raid", T, ["f1"]]], note);
      assert.deepStrictEqual(r.notes.filter((n) => n === note), [note], JSON.stringify(r.notes));
      assert.ok(!r.notes.includes("NO_KIND"), JSON.stringify(r.notes));
    }
  });

  test("RF2 BUG captureRoom decrement: captureRoom=1 with two capture targets and maxOperationsPerReview=2 "
    + "-> first LAUNCH invasion, second is raid with TERRITORY_LIMIT or no second LAUNCH", () => {
    const F = 11;
    const H = 13;
    const HOME = 1;
    const MID = 2;
    const T1 = 3;
    const T2 = 4;
    const adj = { [HOME]: [MID], [MID]: [HOME, T1, T2], [T1]: [MID], [T2]: [MID] };
    const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId,
      occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, ...extra });
    const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
      faction: { status: "ACTIVE", homeSystemId: HOME, frontLimit: 2 }, entry: { homeRegionIds: [] },
      doctrine: { doctrineId: "rf2", canOccupy: true, captureTargets: ["hostile"],
        operationTypes: ["recon", "invasion", "raid"], templates: {} },
      theatre: [], expansion: [T1, T2], lostHome: { systemIds: [] },
      neighbors: (id) => adj[id] || [], regionOf: () => null, isHostile: (x) => x === H,
      stations: [{ systemId: HOME, stationId: "st0" }],
      systems: [row(HOME, F), row(MID, null), row(T1, H), row(T2, H)],
      fleets: [fleet("f1", MID), fleet("f2", MID)], operations: [], operationsTruncated: false,
      intel: [{ ...freshIntel(T1), controllerFactionId: H }, { ...freshIntel(T2), controllerFactionId: H }], sightings: [] };
    const supply = { frontTargets: [], frontLimit: 2, anchors: [HOME], stationSystems: [HOME],
      affordable: { resourceUnits: 1e6, reserveUnits: 1e6 }, reach: new Map([[MID, 1], [T1, 2], [T2, 2]]),
      captureReach: new Map([[MID, 1], [T1, 2], [T2, 2]]), captureRoom: 1, border: new Map() };
    const P = { ...PARAMS, maxOperationsPerReview: 2, maxFleetsPerOperation: 1 };
    const r = chooseNextOperation(s, supply, P, createRng(1), null);
    const ls = launches(r);
    assert.strictEqual(ls.length >= 1, true, "at least one launch");
    assert.strictEqual(ls[0].kind, "invasion", "first operation is invasion");
    if (ls.length === 2) {
      assert.strictEqual(ls[1].kind, "raid", "second operation is raid when captureRoom exhausted");
      assert.ok(r.notes.includes("TERRITORY_LIMIT"), "TERRITORY_LIMIT noted: " + JSON.stringify(r.notes));
    } else {
      assert.ok(r.notes.some((n) => n === "TERRITORY_LIMIT" || n.startsWith("NO_TARGET") || n === "NO_KIND"),
        "no second launch, stopped by limit: " + JSON.stringify(r.notes));
    }
    assert.ok(!(ls.length === 2 && ls[0].kind === "invasion" && ls[1].kind === "invasion"),
      "two invasions must not happen when captureRoom=1");
  });

  const CORE_F = 500003;
  const ENEMY_F = 500019;
  const CORE_SYS = 30002187;
  const OTHER_SYS = 30000001;
  const coreMap = new Map([[CORE_SYS, CORE_F]]);
  const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId,
    occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, ...extra });
  const k4Intel = (systemId, controllerFactionId) => ({ systemId, observedAt: AT, hostileFleets: 0, hostileShips: 0,
    hostileStrength: 0, hostileStations: 0, controllerFactionId });
  const PARAMS_CORE_ON = { ...PARAMS, coreRaidsAllowed: true };
  const PARAMS_CORE_OFF = { ...PARAMS, coreRaidsAllowed: false };
  const adj = { [CORE_SYS]: [OTHER_SYS], [OTHER_SYS]: [CORE_SYS] };
  const supply = { frontTargets: [], frontLimit: 2, anchors: [OTHER_SYS], stationSystems: [OTHER_SYS],
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6 }, reach: new Map([[CORE_SYS, 1], [OTHER_SYS, 1]]),
    captureReach: new Map([[CORE_SYS, 1], [OTHER_SYS, 1]]), captureRoom: 1, border: new Map() };

  test("K4a: foreign core with hostile controller -> raid (not invasion)", () => {
    const s = { v: 1, factionId: ENEMY_F, round: 1, at: AT, seed: 1,
      faction: { status: "ACTIVE", homeSystemId: OTHER_SYS, frontLimit: 2 }, entry: { homeRegionIds: [] },
      doctrine: { doctrineId: "k4a", canOccupy: true, captureTargets: ["hostile"],
        operationTypes: ["recon", "invasion", "raid"], templates: {} },
      theatre: [CORE_SYS], expansion: [], lostHome: { systemIds: [] },
      neighbors: (id) => adj[id] || [], regionOf: () => null, isHostile: (x) => x === CORE_F,
      stations: [{ systemId: OTHER_SYS, stationId: "st0" }],
      systems: [row(OTHER_SYS, ENEMY_F), row(CORE_SYS, CORE_F, { homeFactionId: CORE_F })],
      fleets: [fleet("f1", OTHER_SYS)], operations: [], operationsTruncated: false,
      intel: [k4Intel(CORE_SYS, CORE_F)], sightings: [],
      coreOwners: coreMap };
    const r = chooseNextOperation(s, supply, PARAMS_CORE_ON, createRng(1), null);
    assert.deepStrictEqual(launches(r).map((i) => [i.kind, i.target.systemId]),
      [["raid", CORE_SYS]], "coreRaidsAllowed=true -> raid on foreign core");
    const cands = countCaptureCandidates(s, supply, PARAMS_CORE_ON);
    assert.strictEqual(cands, 0, "countCaptureCandidates does not count foreign core");
  });

  test("K4b: coreRaidsAllowed:false -> foreign core not a candidate at all", () => {
    const s = { v: 1, factionId: ENEMY_F, round: 1, at: AT, seed: 2,
      faction: { status: "ACTIVE", homeSystemId: OTHER_SYS, frontLimit: 2 }, entry: { homeRegionIds: [] },
      doctrine: { doctrineId: "k4b", canOccupy: true, captureTargets: ["hostile"],
        operationTypes: ["recon", "invasion", "raid"], templates: {} },
      theatre: [CORE_SYS], expansion: [], lostHome: { systemIds: [] },
      neighbors: (id) => adj[id] || [], regionOf: () => null, isHostile: (x) => x === CORE_F,
      stations: [{ systemId: OTHER_SYS, stationId: "st0" }],
      systems: [row(OTHER_SYS, ENEMY_F), row(CORE_SYS, CORE_F, { homeFactionId: CORE_F })],
      fleets: [fleet("f1", OTHER_SYS)], operations: [], operationsTruncated: false,
      intel: [k4Intel(CORE_SYS, CORE_F)], sightings: [],
      coreOwners: coreMap };
    const r = chooseNextOperation(s, supply, PARAMS_CORE_OFF, createRng(1), null);
    assert.deepStrictEqual(launches(r), [], "coreRaidsAllowed=false -> no launch on foreign core");
  });

  test("K4c: own core is NOT facts.core (owner === factionId)", () => {
    const s = { v: 1, factionId: CORE_F, round: 1, at: AT, seed: 3,
      faction: { status: "ACTIVE", homeSystemId: CORE_SYS, frontLimit: 2 }, entry: { homeRegionIds: [] },
      doctrine: { doctrineId: "k4c", canOccupy: true, captureTargets: ["hostile"],
        operationTypes: ["recon", "invasion", "raid"], templates: {} },
      theatre: [CORE_SYS], expansion: [], lostHome: { systemIds: [] },
      neighbors: (id) => adj[id] || [], regionOf: () => null, isHostile: (x) => x === ENEMY_F,
      stations: [{ systemId: CORE_SYS, stationId: "st0" }],
      systems: [row(CORE_SYS, CORE_F), row(OTHER_SYS, ENEMY_F)],
      fleets: [fleet("f1", CORE_SYS)], operations: [], operationsTruncated: false,
      intel: [k4Intel(OTHER_SYS, ENEMY_F)], sightings: [],
      coreOwners: coreMap };
    const facts = describe(s, PARAMS_CORE_ON, new Map(), CORE_SYS);
    assert.strictEqual(facts.core, false, "own core is not facts.core");
    const cands = candidateFacts(s, PARAMS_CORE_ON, supply, usableKinds(s, PARAMS_CORE_ON),
      effectiveIntel(s), CORE_SYS, false);
    assert.strictEqual(cands, null, "own core with own controller is not a capture candidate");
  });

  test("K4d: abandonList skips captured core systems", () => {
    const u = { captured: [
      { systemId: CORE_SYS, state: "STABLE", detachedSinceAt: AT - 1e9, factorPermille: 2000, core: true },
      { systemId: OTHER_SYS, state: "STABLE", detachedSinceAt: AT - 1e9, factorPermille: 1000, core: false },
      { systemId: OTHER_SYS + 1, state: "STABLE", detachedSinceAt: AT - 1e9, factorPermille: 1000, core: false },
    ], capturedTruncated: false };
    const P = { maxAbandonsPerReview: 2 };
    const abandoned = abandonList(u, P);
    assert.deepStrictEqual(abandoned, [OTHER_SYS, OTHER_SYS + 1], "abandonList skips core system even with highest factor");
  });

  test("K4e: planTerritoryTrim skips own core system", () => {
    const adjK4e = { [OTHER_SYS]: [OTHER_SYS + 10], [OTHER_SYS + 10]: [OTHER_SYS, OTHER_SYS + 2], [OTHER_SYS + 2]: [OTHER_SYS + 10, CORE_SYS], [CORE_SYS]: [OTHER_SYS + 2] };
    const trimSnapshot = {
      v: 1, factionId: CORE_F, round: 1, at: AT, seed: 4,
      faction: { homeSystemId: OTHER_SYS },
      neighbors: (id) => adjK4e[id] || [],
      theatre: [], border: { reach: new Map() },
      trim: { mode: "ready", anchors: [OTHER_SYS], rows: [
        { systemId: CORE_SYS, state: "STABLE", capturedAt: null },
        { systemId: OTHER_SYS + 2, state: "STABLE", capturedAt: null },
      ], afterSystemId: 0, nextAfterSystemId: 0, passClean: false },
      coreOwners: coreMap };
    const params = { territoryTrimEnabled: true, startTerritoryJumps: 1, maxTrimsPerReview: 1,
      captureRangeFromStationJumps: 5, routeMaxJumps: 20, maxBfsSystems: 50 };
    const result = planTerritoryTrim(trimSnapshot, params);
    assert.deepStrictEqual(result.intents[0]?.systemIds, [OTHER_SYS + 2], "planTerritoryTrim skips own core");
  });

  test("K4f: planRoll does not select core systems (invaders)", () => {
    const { planRoll } = require("../../lib/world/invasions/rollPlanner");
    const sampled = [
      { systemId: CORE_SYS, row: row(CORE_SYS, CORE_F), core: true, liveStations: 0, observed: false, claimed: false, inTheatre: false, openBeachhead: false },
    ];
    const profiles = [{ factionId: 500026, profileId: "triglavian", eligible: true, weight: 100,
      captureRangeJumps: 3 }];
    const params = { chancePermille: 1000, maxActive: 10, maxActivePerFaction: 5,
      weightFree: 10, weightControlled: 5,
      avoidObservedSystems: false, avoidStationSystems: false, avoidCampaignTheatres: false,
      requireSovCheck: false, beachheadCaptureRangeJumps: 3 };
    const rng = createRng(42);
    const decision = planRoll({ round: 1, rollSeed: 1, sampleSeed: 2, openTotal: 0, openByFaction: new Map(),
      profiles, sampled, stationsReady: true }, params, rng);
    assert.strictEqual(decision.outcome, "NO_TARGET", "planRoll returns NO_TARGET when only core system sampled");
  });

  test("TB1 concord-empire-tribute planTribute (anti-starvation): stock = reserve -> TRIBUTE_NO_SURPLUS; surplus -> "
    + "floor(100 x surplus / 1000); the PRODUCE of the round and an open TO_SOURCE convoy are subtracted (no mineral "
    + "below reserve_k after the tribute and PRODUCE); gates (off, paid, in transit, receiver full / no room); "
    + "planLogistics: free fleet -> CONVOY_DISPATCH with tributeBucket, no fleet -> TRIBUTE_NO_FLEET without MOBILIZE",
  () => {
    const PAYE = 30001718;
    const FRIGATE = RECIPES.GROUPS.frigate.minerals;
    const KEYS = Object.keys(FRIGATE).sort();
    const PT = Object.freeze({ ratePermille: 100, periodMs: 86400000, reserveRuns: 8, minLoadVolume: 100000,
      recipientMaxMineralUnits: 20000000, recipientBuildsHulls: true, maxRecipientStations: 4 });
    const PP = Object.freeze({ maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });
    const params = { tribute: PT, production: PP };
    const reserve = Object.fromEntries(KEYS.map((k) => [k, PT.reserveRuns * FRIGATE[k]]));
    const plus = (base, n) => Object.fromEntries(KEYS.map((k) => [k, base[k] + n]));
    const recipes = { frigate: { minerals: FRIGATE } };
    const pr = (minerals) => ({ mode: "ready", recipes, truncated: false, stations: [{ stationId: "st-a", systemId: SAMINER,
      kind: "upwell", lines: 2, activeJobs: [], minerals, hulls: {} }] });
    const receiver = (o = {}) => ({ stationId: "st-c", systemId: PAYE, minerals: {}, freeRows: 256, ...o });
    const tributeOf = (o = {}) => ({ mode: "ready", bucket: 5, paid: false, recipientFactionId: CONCORD,
      recipientStations: [receiver()], recipientMineralUnits: 0, maxStockQuantity: 1e12, ...o });
    const snapOf = (o = {}) => ({ doctrine: { templates: { patrol: [{ hullGroup: "frigate", count: 3 }],
      logistics: [{ hullGroup: "industrial", count: 2 }] } }, logistics: { mode: "ready", open: o.open || [] },
    tribute: tributeOf(o.tribute) });
    const qty = (r) => (r.plan ? Object.fromEntries(r.plan.items.map((it) => [it.itemKey, it.quantity])) : null);

    const a = planTribute(snapOf(), pr({ ...reserve }), null, [], params);
    assert.deepStrictEqual([a.plan, a.notes], [null, ["TRIBUTE_NO_SURPLUS"]]);
    const b = planTribute(snapOf(), pr(plus(reserve, 10000)), null, [], params);
    assert.deepStrictEqual(qty(b), Object.fromEntries(KEYS.map((k) => [k, 1000])));
    assert.deepStrictEqual([b.plan.purpose, b.plan.source.stationId, b.plan.dest, b.plan.noMobilize, b.plan.minLoad,
      b.plan.tributeBucket, b.notes], ["TRIBUTE", "st-a", { stationId: "st-c", systemId: PAYE }, true, 100000, 5, []]);
    const stock = plus(Object.fromEntries(KEYS.map((k) => [k, reserve[k] + 2 * FRIGATE[k]])), 10000);
    const produced = { intents: [{ type: "PRODUCE", stationId: "st-a", hullGroup: "frigate", runs: 2 }] };
    const c = planTribute(snapOf(), pr(stock), produced, [], params);
    const cq = qty(c);
    for (const k of KEYS) {
      assert.ok(stock[k] - 2 * FRIGATE[k] - cq[k] >= reserve[k], `${k} below reserve after tribute + PRODUCE`);
    }
    assert.deepStrictEqual(cq, Object.fromEntries(KEYS.map((k) => [k, 1000])));
    const c2 = planTribute(snapOf(), pr(Object.fromEntries(KEYS.map((k) => [k, reserve[k] + FRIGATE[k]]))),
      { intents: [{ type: "PRODUCE", stationId: "st-a", hullGroup: "frigate", runs: 1 }] }, [], params);
    assert.deepStrictEqual(c2.notes, ["TRIBUTE_NO_SURPLUS"], "the PRODUCE of the round eats the whole surplus");
    const items = Object.fromEntries(KEYS.map((k) => [`mineral/${k}`, 10000]));
    const d = planTribute(snapOf({ open: [{ purpose: "MINERALS_TO_FACTORY", state: "TO_SOURCE", sourceStationId: "st-a",
      destStationId: "st-x", items }] }), pr(plus(reserve, 10000)), null, [], params);
    assert.deepStrictEqual(d.notes, ["TRIBUTE_NO_SURPLUS"]);
    const d2 = planTribute(snapOf({ open: [{ purpose: "MINERALS_TO_FACTORY", state: "IN_TRANSIT",
      sourceStationId: "st-a", destStationId: "st-x", items }] }), pr(plus(reserve, 10000)), null, [], params);
    assert.deepStrictEqual(qty(d2), qty(b));
    const rich = pr(plus(reserve, 10000));
    assert.deepStrictEqual(planTribute(snapOf(), rich, null, [], { production: PP, tribute: null }),
      { plan: null, notes: [] });
    assert.deepStrictEqual(planTribute(snapOf(), rich, null, [], { production: PP, tribute: { ...PT, ratePermille: 0 } }),
      { plan: null, notes: [] });
    assert.deepStrictEqual(planTribute(snapOf({ tribute: { mode: "none" } }), rich, null, [], params),
      { plan: null, notes: [] });
    assert.deepStrictEqual(planTribute(snapOf({ tribute: { paid: true } }), rich, null, [], params),
      { plan: null, notes: [] });
    assert.deepStrictEqual(planTribute(snapOf({ open: [{ purpose: "TRIBUTE", state: "IN_TRANSIT", sourceStationId: "st-a",
      destStationId: "st-c", items }] }), rich, null, [], params).notes, ["TRIBUTE_IN_TRANSIT"]);
    for (const t of [{ recipientFactionId: null }, { recipientStations: [] }]) {
      assert.deepStrictEqual(planTribute(snapOf({ tribute: t }), rich, null, [], params).notes, ["TRIBUTE_NO_RECIPIENT"]);
    }
    const full = (t) => planTribute(snapOf({ tribute: t }), rich, null, [], params);
    assert.deepStrictEqual(full({ recipientMineralUnits: PT.recipientMaxMineralUnits }).notes, ["TRIBUTE_RECIPIENT_FULL"]);
    assert.deepStrictEqual(full({ maxStockQuantity: 5000, recipientStations: [receiver({
      minerals: Object.fromEntries(KEYS.map((k) => [k, 5000])) })] }).notes, ["TRIBUTE_RECIPIENT_FULL"]);
    assert.deepStrictEqual(full({ recipientStations: [receiver({ freeRows: KEYS.length - 1 })] }).notes,
      ["TRIBUTE_RECIPIENT_FULL"]);
    const capped = full({ maxStockQuantity: 5500, recipientStations: [receiver({
      minerals: Object.fromEntries(KEYS.map((k) => [k, 5000])), freeRows: 0 })] });
    assert.deepStrictEqual(qty(capped), Object.fromEntries(KEYS.map((k) => [k, 500])), "cut to the room of the row");

    const LOG = { maxFleetsPerFaction: 3, maxOpenConvoysPerFaction: 4, maxDispatchesPerReview: 2,
      maxMobilizationsPerReview: 1, carrierCapacityM3: 60000, maxCargoItems: 12, minLoadVolume: 100000,
      factoryRunsTarget: 2, maxConvoyJumps: 20, needsHulls: false, frontStationMaxJumps: 6, maxHullConvoysPerReview: 8,
      mineralSurplusThreshold: 0, maxMineralConvoysPerReview: 2, mineralConvoyMinLoad: 1000,
      volumes: { mineral: 1, hulls: { industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } };
    const big = pr(plus(reserve, 2000000));
    const logSnap = (fleets) => ({ ...snapOf(), factionId: AMARR, faction: { status: "ACTIVE", homeSystemId: SAMINER },
      stationsMode: "ready", fleetsTruncated: false, fleets, neighbors: () => [], production: big,
      logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: { lf1: 2 }, truncated: false } });
    const P = { production: PP, logistics: LOG, tribute: PT, maxBfsSystems: 64, maxAssemblyJumps: 6,
      mobilizeResourcePerShip: 1, mobilizeReservePerShip: 0 };
    const supply = { frontTargets: [], affordable: { resourceUnits: 100000, reserveUnits: 1000 } };
    const fleet = { fleetId: "lf1", version: 4, state: "IDLE", fleetRole: "logistics", systemId: SAMINER,
      refitPending: false, composition: [{ hullGroup: "industrial", count: 2 }] };
    const sent = planLogistics(logSnap([fleet]), supply, P, { intents: [] }, null, null);
    const tribute = sent.intents.filter((i) => i.purpose === "TRIBUTE");
    assert.deepStrictEqual(tribute.map((i) => [i.type, i.fleetId, i.sourceStationId, i.destStationId, i.tributeBucket]),
      [["CONVOY_DISPATCH", "lf1", "st-a", "st-c", 5]], JSON.stringify(sent));
    assert.ok(sent.notes.includes("TRIBUTE_DISPATCHED"), JSON.stringify(sent.notes));
    const idle = planLogistics(logSnap([]), supply, P, { intents: [] }, null, null);
    assert.deepStrictEqual([idle.intents.filter((i) => i.type === "MOBILIZE").length,
      idle.notes.includes("TRIBUTE_NO_FLEET")], [0, true], JSON.stringify(idle));
  });

  test("TN1 tribute-c planTribute: recipientMaxMineralUnits 0 = no ceiling (3e9 minerals at the "
    + "receiver -> TRIBUTE plan); 20000000 -> TRIBUTE_RECIPIENT_FULL", () => {
    const FRIGATE = RECIPES.GROUPS.frigate.minerals;
    const KEYS = Object.keys(FRIGATE).sort();
    const PT = { ratePermille: 100, periodMs: 86400000, reserveRuns: 8, minLoadVolume: 100000,
      recipientMaxMineralUnits: 0, recipientBuildsHulls: false, maxRecipientStations: 4 };
    const PP = { maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] };
    const minerals = Object.fromEntries(KEYS.map((k) => [k, PT.reserveRuns * FRIGATE[k] + 10000]));
    const pr = { mode: "ready", recipes: { frigate: { minerals: FRIGATE } }, truncated: false, stations: [{
      stationId: "st-a", systemId: SAMINER, kind: "upwell", lines: 2, activeJobs: [], minerals, hulls: {} }] };
    const snap = { doctrine: { templates: { patrol: [{ hullGroup: "frigate", count: 3 }] } },
      logistics: { mode: "ready", open: [] },
      tribute: { mode: "ready", bucket: 5, paid: false, recipientFactionId: CONCORD, recipientStations: [{
        stationId: "st-c", systemId: 30001718, minerals: {}, freeRows: 256 }], recipientMineralUnits: 3e9,
      maxStockQuantity: 1e12 } };
    const open = planTribute(snap, pr, null, [], { tribute: PT, production: PP });
    assert.deepStrictEqual([open.plan && open.plan.purpose, open.notes], ["TRIBUTE", []], JSON.stringify(open));
    const capped = planTribute(snap, pr, null, [], { tribute: { ...PT, recipientMaxMineralUnits: 20000000 },
      production: PP });
    assert.deepStrictEqual([capped.plan, capped.notes], [null, ["TRIBUTE_RECIPIENT_FULL"]]);
  });

  test("TD1 tribute dispatch priority: 2 CONSTRUCTION mineral plans + the tribute "
    + "plan, maxDispatchesPerReview 2, 2 free haulers: reserve off -> both minerals sent, TRIBUTE_DISPATCH_LIMIT; "
    + "reserve on -> 1 mineral convoy + the tribute (TRIBUTE_DISPATCHED); room 0 -> both limit notes; tribute off -> "
    + "the reserve flag changes nothing", () => {
    const PAYE = 30001718;
    const FRIGATE = RECIPES.GROUPS.frigate.minerals;
    const KEYS = Object.keys(FRIGATE).sort();
    const PT = { ratePermille: 100, periodMs: 86400000, reserveRuns: 8, minLoadVolume: 100000,
      recipientMaxMineralUnits: 20000000, recipientBuildsHulls: true, maxRecipientStations: 4 };
    const PP = { maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] };
    const LOG = { maxFleetsPerFaction: 3, maxOpenConvoysPerFaction: 4, maxDispatchesPerReview: 2,
      maxMobilizationsPerReview: 1, carrierCapacityM3: 60000, maxCargoItems: 12, minLoadVolume: 100000,
      factoryRunsTarget: 2, maxConvoyJumps: 20, needsHulls: false, frontStationMaxJumps: 6, maxHullConvoysPerReview: 8,
      mineralSurplusThreshold: 0, maxMineralConvoysPerReview: 2, mineralConvoyMinLoad: 1000,
      volumes: { mineral: 1, hulls: { industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } };
    const minerals = Object.fromEntries(KEYS.map((k) => [k, PT.reserveRuns * FRIGATE[k] + 2000000]));
    const production = { mode: "ready", recipes: { frigate: { minerals: FRIGATE } }, truncated: false, stations: [{
      stationId: "st-a", systemId: SAMINER, kind: "upwell", lines: 2, activeJobs: [], minerals, hulls: {} }] };
    const build = (stationId, systemId) => ({ stationId, systemId, state: "SUPPLYING",
      remaining: { [`mineral/${KEYS[0]}`]: 200000 } });
    const fleet = (fleetId) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "logistics", systemId: SAMINER,
      refitPending: false, composition: [{ hullGroup: "industrial", count: 2 }] });
    const snapOf = (open = [], fleets = [fleet("lf1"), fleet("lf2")]) => ({ factionId: AMARR,
      faction: { status: "ACTIVE", homeSystemId: SAMINER },
      doctrine: { templates: { patrol: [{ hullGroup: "frigate", count: 3 }],
        logistics: [{ hullGroup: "industrial", count: 2 }] } },
      stationsMode: "ready", fleetsTruncated: false, fleets, neighbors: () => [],
      production, construction: { mode: "ready", open: [build("site-1", 30001719), build("site-2", 30001720)] },
      logistics: { mode: "ready", open, busyFleetIds: [], carriers: { lf1: 2, lf2: 2 }, truncated: false },
      tribute: { mode: "ready", bucket: 5, paid: false, recipientFactionId: CONCORD, recipientStations: [{
        stationId: "st-c", systemId: PAYE, minerals: {}, freeRows: 256 }], recipientMineralUnits: 0,
      maxStockQuantity: 1e12 } });
    const run = (reserve, o = {}) => planLogistics(o.snap || snapOf(), { frontTargets: [],
      affordable: { resourceUnits: 100000, reserveUnits: 1000 } }, { production: PP,
      logistics: { ...LOG, ...(o.log || {}), tributeReserveSlot: reserve }, tribute: o.tribute === undefined ? PT : o.tribute,
      maxBfsSystems: 64, maxAssemblyJumps: 6, mobilizeResourcePerShip: 1, mobilizeReservePerShip: 0 },
    { intents: [] }, null, null);
    const sent = (r) => r.intents.filter((i) => i.type === "CONVOY_DISPATCH").map((i) => [i.purpose, i.fleetId]);
    const tn = (r) => r.notes.filter((n) => n.startsWith("TRIBUTE_"));

    const off = run(false);
    assert.deepStrictEqual([sent(off), tn(off)], [[["CONSTRUCTION", "lf1"], ["CONSTRUCTION", "lf2"]],
      ["TRIBUTE_DISPATCH_LIMIT"]], JSON.stringify(off));
    const on = run(true);
    assert.deepStrictEqual([sent(on), tn(on)], [[["CONSTRUCTION", "lf1"], ["TRIBUTE", "lf2"]],
      ["TRIBUTE_DISPATCHED"]], JSON.stringify(on));
    assert.strictEqual(on.intents.find((i) => i.purpose === "TRIBUTE").tributeBucket, 5);
    const full = Array.from({ length: 4 }, (_, n) => ({ purpose: "MINERALS_TO_FACTORY", state: "IN_TRANSIT",
      sourceStationId: "st-a", destStationId: `st-x${n}`, items: {} }));
    for (const reserve of [false, true]) {
      const zero = run(reserve, { snap: snapOf(full) });
      assert.deepStrictEqual([sent(zero), zero.notes.includes("LOGISTICS_CONVOY_LIMIT"), tn(zero)],
        [[], true, ["TRIBUTE_DISPATCH_LIMIT"]], JSON.stringify(zero));
    }
    const a = run(false, { tribute: null });
    const b = run(true, { tribute: null });
    assert.deepStrictEqual(b, a);
    assert.deepStrictEqual([sent(a), tn(a)], [[["CONSTRUCTION", "lf1"], ["CONSTRUCTION", "lf2"]], []]);

    const one = { log: { maxDispatchesPerReview: 1 } };
    const mob = (r) => r.intents.filter((i) => i.type === "MOBILIZE").length;
    for (const reserve of [false, true]) {
      const none = run(reserve, { ...one, snap: snapOf([], []) });
      assert.deepStrictEqual([mob(none), sent(none), tn(none)], [1, [], ["TRIBUTE_NO_FLEET"]], JSON.stringify(none));
    }
    const lone = (reserve) => run(reserve, { ...one, snap: snapOf([], [fleet("lf1")]) });
    assert.deepStrictEqual([sent(lone(true)), tn(lone(true))], [[["TRIBUTE", "lf1"]], ["TRIBUTE_DISPATCHED"]]);
    assert.deepStrictEqual([sent(lone(false)), tn(lone(false))],
      [[["CONSTRUCTION", "lf1"]], ["TRIBUTE_DISPATCH_LIMIT"]]);
    for (const snap of [snapOf([], []), snapOf([], [fleet("lf1")])]) {
      assert.deepStrictEqual(run(true, { ...one, snap, tribute: null }), run(false, { ...one, snap, tribute: null }));
    }
  });

  test("PH2: housekeeping observes a system whose only own fleet is MATERIALIZED (player hunt)",
    () => {
    const fleets = [{ systemId: 30000142, state: "MATERIALIZED" }, { systemId: 30000144, state: "TRAVELLING" }];
    assert.deepStrictEqual(observationOrder(fleets, [], [], 8), [30000142]);
  });

  test("BFM1 bfs memo (neighbors.bfsMemo): deepStrictEqual with the plain bfs for 6 "
    + "combinations (start order, duplicates, maxJumps, maxSystems), a hit returns a copy, through bypasses, the "
    + "bfsMemoMax limit clears", () => {
    const nb = (id) => (id >= 100 ? [id - 100] : [id === 1 ? 12 : id - 1, id === 12 ? 1 : id + 1, 100 + id]);
    let calls = 0;
    const memoNb = (id) => {
      calls += 1;
      return nb(id);
    };
    memoNb.bfsMemo = new Map();
    memoNb.bfsMemoMax = 4;
    const combos = [[[1], 3, 50], [[5, 1], 2, 50], [[1, 5, 1], 2, 50], [[1, 5], 3, 50], [[3], 4, 6], [[7, 3, 3], 1, 2]];
    for (const [starts, maxJumps, maxSystems] of combos) {
      const plain = bfs(starts, nb, { maxJumps, maxSystems });
      assert.deepStrictEqual(bfs(starts, memoNb, { maxJumps, maxSystems }), plain, JSON.stringify(starts));
      assert.deepStrictEqual([...bfs(starts, memoNb, { maxJumps, maxSystems })], [...plain], "hit, same order");
    }
    assert.strictEqual(memoNb.bfsMemo.size, 1);
    let before = calls;
    const hit = bfs([3], memoNb, { maxJumps: 4, maxSystems: 6 });
    assert.ok(calls > before, "cleared key: computed again");
    hit.set(999, 0);
    hit.delete(3);
    before = calls;
    const again = bfs([3], memoNb, { maxJumps: 4, maxSystems: 6 });
    assert.strictEqual(calls, before, "a hit reads no neighbours");
    assert.deepStrictEqual(again, bfs([3], nb, { maxJumps: 4, maxSystems: 6 }), "mutating a result changes nothing");
    const through = (id) => id !== 2;
    const sizeBefore = memoNb.bfsMemo.size;
    assert.deepStrictEqual(bfs([1], memoNb, { maxJumps: 3, maxSystems: 50, through }),
      bfs([1], nb, { maxJumps: 3, maxSystems: 50, through }));
    assert.strictEqual(memoNb.bfsMemo.size, sizeBefore, "through: never stored");
    const off = Object.assign((id) => nb(id), { bfsMemo: new Map(), bfsMemoMax: 0 });
    bfs([1], off, { maxJumps: 2, maxSystems: 50 });
    assert.strictEqual(off.bfsMemo.size, 0, "bfsMemoMax 0 = no memo");
  });

  test("BFM2 perf-review-cleanups: bfsMemoMaxSystems bounds the systems of all stored results "
    + "clear when the next would pass it, a result above it not stored, results unchanged; config default + clamp", () => {
    const nb = (id) => (id >= 100 ? [id - 100] : [id === 1 ? 12 : id - 1, id === 12 ? 1 : id + 1, 100 + id]);
    const A = { maxJumps: 1, maxSystems: 50 };
    const B = { maxJumps: 2, maxSystems: 50 };
    const sizeA = bfs([1], nb, A).size;
    const sizeB = bfs([5], nb, B).size;
    assert.deepStrictEqual([sizeA, sizeB], [4, 8]);
    const memoNb = Object.assign((id) => nb(id), { bfsMemo: new Map(), bfsMemoMax: 100,
      bfsMemoMaxSystems: sizeA + sizeB - 1 });
    assert.deepStrictEqual(bfs([1], memoNb, A), bfs([1], nb, A));
    assert.strictEqual(memoNb.bfsMemo.size, 1);
    assert.deepStrictEqual(bfs([5], memoNb, B), bfs([5], nb, B));
    assert.deepStrictEqual([...memoNb.bfsMemo.keys()], ["2|50|5"]);
    assert.deepStrictEqual(bfs([2], memoNb, { maxJumps: 0, maxSystems: 50 }), new Map([[2, 0]]));
    assert.strictEqual(memoNb.bfsMemo.size, 2);
    const big = { maxJumps: 6, maxSystems: 50 };
    assert.ok(bfs([1], nb, big).size > sizeA + sizeB - 1);
    assert.deepStrictEqual(bfs([1], memoNb, big), bfs([1], nb, big));
    assert.ok(![...memoNb.bfsMemo.keys()].includes("6|50|1"), [...memoNb.bfsMemo.keys()].join(","));
    const entriesOnly = Object.assign((id) => nb(id), { bfsMemo: new Map(), bfsMemoMax: 100 });
    bfs([1], entriesOnly, big);
    bfs([5], entriesOnly, B);
    assert.strictEqual(entriesOnly.bfsMemo.size, 2);

    const config = require("../../config");
    const MOD_DIR = path.join(path.sep, "repo", "mods", "livingNewEden");
    const cfg = (v) => config.resolveConfig({ modDir: MOD_DIR,
      env: v === undefined ? {} : { EVEJS_LNE_STRATEGY_BFS_MEMO_MAX_SYSTEMS: v } }).config.strategy.bfsMemoMaxSystems;
    assert.deepStrictEqual([cfg(), cfg("10"), cfg("99999999"), cfg("300000")], [250000, 1000, 10000000, 300000]);
  });
};
