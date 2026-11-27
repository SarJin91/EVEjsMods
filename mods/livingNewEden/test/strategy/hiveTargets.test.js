"use strict";

const assert = require("node:assert");

const { decideReview } = require("../../lib/strategy/ai");
const { candidateFacts, attackKind, describe, usableKinds, effectiveIntel, countCaptureCandidates,
  chooseTargetSystem } = require("../../lib/strategy/ai/targeting");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { planPatrols } = require("../../lib/strategy/ai/patrol");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_VERSION, TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createRng } = require("../../lib/util/rng");
const { createManualClock } = require("../../lib/util/clock");
const { createIdGenerator } = require("../../lib/util/ids");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { resolveConfig } = require("../../config");
const path = require("node:path");
const SANSHA = 500019;

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const HIVE = 500025;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const WING = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const HIVE_P = Object.freeze({ maxFleets: 20, fleetsPerNode: 1, maxFrontsPerAttacker: 1, assumedGarrisonFleets: 2,
  captureSlowFactor: 3, assumedGarrisonStrength: 0 });

const BASE = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 15,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 3, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 12, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6, routeMaxJumps: 40,
  maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true });
const ON = Object.freeze({ ...BASE, hive: HIVE_P });
const OFF_P = Object.freeze({ ...BASE, hive: null });

const DOCTRINE = (() => {
  const entry = FACTIONS_V1.find((x) => x.factionId === 500010);
  return { ...DOCTRINES_V1.find((x) => x.doctrineId === entry.doctrineId), expandsBeyondTheatre: true };
})();

const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0, ...extra });
const intelOf = (systemId, controllerFactionId, hostileStrength = 0) => ({ systemId, observedAt: AT - HOUR,
  hostileFleets: 0, hostileShips: 0, hostileStrength, hostileStations: 0, controllerFactionId });
const wing = (fleetId, systemId, extra = {}) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId,
  refitPending: false, shipCount: 6, strength: strengthOf(WING, POWER), operationId: null, legSeq: 0, homeSystemId: 5,
  updatedAt: AT - HOUR, ...extra });

function snap(o) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 5, doctrineId: DOCTRINE.doctrineId,
      resourceUnits: o.resources === undefined ? 100000 : o.resources,
      reserveUnits: o.resources === undefined ? 10000 : o.resources, frontLimit: 6, version: 1 },
    entry: { kind: DOCTRINE.kind, maxActiveFronts: 6, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: o.doctrine || DOCTRINE, theatre: o.theatre || [], expansion: o.expansion || [],
    raidTargets: o.raidTargets || [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 12), regionOf: () => null,
    isHostile: (x) => x === HOSTILE || x === HIVE, isPlaying: () => true,
    ...(o.hive === true ? { isHive: (c) => c === HIVE } : {}),
    ...(o.hiveFrontIds ? { hiveFrontIds: o.hiveFrontIds } : {}),
    stationsMode: "ready", stations: [{ systemId: 5, stationId: "st5" }], captureAnchors: [5],
    systems: [row(5, F), ...o.systems], fleets: o.fleets || [wing("w1", 5), wing("w2", 5), wing("w3", 5)],
    fleetsTruncated: false, operations: o.operations || [], operationsTruncated: false, intel: o.intel || [],
    sightings: [], occupations: [], territory: [], territoryTruncated: false, capturedIds: o.capturedIds || [],
    footholds: [] };
}
const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);
const factsOf = (s, params, id, captureOnly = false) => candidateFacts(s, params, evaluateSupplyAndFronts(s, params),
  usableKinds(s, params), effectiveIntel(s), id, captureOnly);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("HT1b readSnapshot on a real store (hive on): a hive system without an own neighbour is not "
    + "in expansion / raidTargets of Sansha, with the own XZ-SKZ next to it it is; snapshot.isHive and hiveFrontIds; "
    + "hive off -> neither field changes the snapshot (isHive false, no hiveFrontIds)", async () => {
    const MAL = [30001051, 30001052, 30001053, 30001054, 30001055];
    const XZ = 30004932;
    const graph = (() => {
      const map = k3StaticMap({ extra: MAL.map((id) => system(id, 10000013, 20000150, "nullsec")) });
      const link = (a, b) => map.gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
      link(XZ, MAL[0]);
      for (let i = 1; i < MAL.length; i += 1) link(MAL[i - 1], MAL[i]);
      const built = buildUniverseGraph(map);
      assert.ok(built.ok);
      return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 })
        .publicApi });
    })();
    const run = (env, xzController) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map([...R.THEATRE.map((id) => [id, SANSHA]), ...MAL.map((id) => [id, HIVE]),
        [XZ, xzController]]);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(73) }), graph, controllers };
      let seen = null;
      const hooks = { beforeEffect: (d, s) => {
        if (d.factionId === SANSHA && seen === null) seen = s;
        return d;
      } };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
        EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA), EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
        EVEJS_LNE_STRATEGY_TARGET_PASSIVE_CONTROLLERS: "1", ...env }, { hooks });
      await R.passesAt(e, shared, R.START_MS + R.I);
      e.strategy.stop("test");
      assert.ok(seen, "Sansha reviewed");
      return seen;
    });
    const scanned = (s) => [...s.expansion, ...(s.raidTargets || [])].filter((id) => MAL.includes(id));
    const ON_ENV = { EVEJS_LNE_HIVE_ENABLED: "1", EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: `${SANSHA},${HIVE}` };
    const sealed = await run(ON_ENV, null);
    assert.deepStrictEqual(scanned(sealed), [], JSON.stringify(sealed.expansion));
    assert.deepStrictEqual([sealed.isHive(HIVE), sealed.isHive(SANSHA), sealed.hiveFrontIds], [true, false, []]);
    const open = await run(ON_ENV, SANSHA);
    assert.deepStrictEqual(scanned(open), [MAL[0]], JSON.stringify(open.expansion));
    const off = await run({}, SANSHA);
    assert.deepStrictEqual([off.isHive(HIVE), "hiveFrontIds" in off], [false, false]);
    assert.ok(scanned(off).includes(MAL[0]), JSON.stringify(off.expansion));
    assert.ok(scanned(await run({}, null)).includes(MAL[0]));

    const paramsOf = (env) => {
      const config = resolveConfig({ modDir: path.resolve(__dirname, "..", ".."),
        env: { EVEJS_DATA_ROOT: "x", ...env } }).config;
      const st = config.strategy;
      const built = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
        operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: st.maxRegistryFactions,
        maxCampaignSystems: st.maxCampaignSystems, maxShipsPerFleet: config.fleets.maxShipsPerFleet,
        maxCompositionEntries: config.fleets.maxCompositionEntries, maxResourceUnits: st.maxResourceUnits,
        activeCampaignIds: [], enabledFlags: config.hive.enabled === true ? ["hive"] : [] });
      assert.ok(built.ok, JSON.stringify(built));
      const powerTable = buildPowerTable(expandStrengthGroups(GROUPS));
      const svc = createReviewService({ config, registry: built.registry, powerTable, kinds,
        strategyRepository: { limits: { maxResourceUnits: st.maxResourceUnits } } });
      return { params: svc.params, config, powerTable, doctrine: built.registry.getDoctrine("rogue-hive-v1") };
    };
    const on = paramsOf({ EVEJS_LNE_HIVE_ENABLED: "1" });
    const patrol = on.doctrine.templates.patrol.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count }));
    const one = strengthOf(patrol, on.powerTable);
    assert.ok(one > 0, `patrol strength ${one}`);
    assert.strictEqual(on.params.hive.assumedGarrisonStrength, on.config.hive.assumedGarrisonFleets * one);
    assert.ok(on.params.hive.assumedGarrisonStrength > 0);
    assert.strictEqual(paramsOf({}).params.hive, null, "hive off -> params.hive null");
  });

  test("HT1: a hive system without an own neighbour is no candidate (also in a theatre), with one it is a "
    + "capture; no raid by attackKind or by a blocked capture; countCaptureCandidates skips the hive", () => {
    const systems = [row(6, HIVE), row(8, HIVE)];
    const intel = [intelOf(6, HIVE), intelOf(8, HIVE)];
    const exp = snap({ hive: true, systems, expansion: [6, 8], intel });
    assert.strictEqual(factsOf(exp, ON, 8, true), null, "8: neighbours 7 / 9 are not own");
    assert.strictEqual(factsOf(exp, ON, 6, true).hive, true, "6: next to the own 5");
    assert.deepStrictEqual(launches(decideReview(exp, ON)), [["invasion", 6]]);
    const th = (hive) => snap({ hive, systems, theatre: [8], intel });
    assert.strictEqual(factsOf(th(true), ON, 8), null);
    assert.notStrictEqual(factsOf(th(false), OFF_P, 8), null);
    const full = { maxCapturedSystemsPerFaction: 0 };
    const blockedOff = decideReview(snap({ systems: [row(6, HIVE)], expansion: [6], raidTargets: [6], intel }),
      { ...OFF_P, ...full });
    assert.deepStrictEqual(launches(blockedOff), [["raid", 6]], JSON.stringify(blockedOff.notes));
    const blockedOn = decideReview(snap({ hive: true, systems: [row(6, HIVE)], expansion: [6], raidTargets: [6],
      intel }), { ...ON, ...full });
    assert.deepStrictEqual(launches(blockedOn), [], JSON.stringify(blockedOn.notes));
    assert.ok(!blockedOn.intents.some((i) => i.kind === "raid"));
    const s6 = snap({ hive: true, systems: [row(6, HIVE)], intel });
    const sup = { ...evaluateSupplyAndFronts(s6, ON), captureRoom: 0 };
    const blocked = new Set();
    const f6 = describe(s6, ON, effectiveIntel(s6), 6);
    assert.strictEqual(attackKind(usableKinds(s6, ON), sup, f6, 6, { snapshot: s6, params: ON, blocked }), null);
    assert.deepStrictEqual([...blocked], ["TERRITORY_LIMIT"]);
    const cc = snap({ hive: true, systems: [row(6, HIVE), row(4, null)], expansion: [6, 4],
      intel: [...intel, intelOf(4, null)] });
    assert.strictEqual(countCaptureCandidates(cc, evaluateSupplyAndFronts(cc, ON), ON), 1);
    const ccOff = snap({ systems: [row(6, HIVE), row(4, null)], expansion: [6, 4], intel: [...intel, intelOf(4, null)] });
    assert.strictEqual(countCaptureCandidates(ccOff, evaluateSupplyAndFronts(ccOff, OFF_P), OFF_P), 2);
  });

  test("HT2: two hive candidates and 3 slots -> one operation on hive space; a skipped target "
    + "(INSUFFICIENT_FORCE) does not block the second; an open operation on hiveFrontIds blocks a new hive target", () => {
    const systems = [row(4, HIVE), row(6, HIVE)];
    const intel = [intelOf(4, HIVE), intelOf(6, HIVE)];
    const one = decideReview(snap({ hive: true, systems, expansion: [4, 6], intel }), ON);
    assert.deepStrictEqual(launches(one), [["invasion", 4]], JSON.stringify(one.notes));
    const w1 = wing("w1", 5);
    const strong = decideReview(snap({ hive: true, systems: [...systems, row(3, F)], expansion: [4, 6], resources: 0,
      fleets: [w1], intel: [intelOf(4, HIVE, w1.strength), intelOf(6, HIVE)] }), ON);
    assert.deepStrictEqual(launches(strong), [["invasion", 6]], JSON.stringify(strong.notes));
    assert.ok(strong.notes.includes("INSUFFICIENT_FORCE"), JSON.stringify(strong.notes));
    const op = { operationId: "op1", version: 1, state: "ACTIVE", operationType: "invasion", objective: "capture",
      originSystemId: 5, targetSystemId: 10, dueAt: AT + HOUR, members: 1, orderedMembers: 1 };
    const fronted = decideReview(snap({ hive: true, systems, expansion: [4, 6], intel, operations: [op],
      hiveFrontIds: [10] }), ON);
    assert.deepStrictEqual(launches(fronted).filter(([, id]) => id === 4 || id === 6), [], JSON.stringify(fronted.notes));
    const free = decideReview(snap({ hive: true, systems, expansion: [4, 6], intel, operations: [op] }), ON);
    assert.deepStrictEqual(launches(free), [["invasion", 4]], JSON.stringify(free.notes));
  });

  test("HT3: a free system 4 jumps farther beats a hive system (v7); enemyStrength has "
    + "assumedGarrisonStrength; the capture of a hive system has dueAt = at + attackWindowMs x 3; a patrol sortie of "
    + "another faction skips a hive system", () => {
    assert.deepStrictEqual([TARGET_SCORING_VERSION, TARGET_SCORING_V1.hiveControlled], [10, -100]);
    const systems = [row(6, HIVE), row(9, F), row(10, null)];
    const intel = [intelOf(6, HIVE), intelOf(10, null)];
    const pick = (hive, params) => {
      const s = snap({ hive, systems, expansion: [6, 10], intel });
      return chooseTargetSystem(s, evaluateSupplyAndFronts(s, params), params, createRng(5)).systemId;
    };
    assert.strictEqual(pick(true, ON), 10);
    assert.strictEqual(pick(false, OFF_P), 6, "hostileControlled 350 without the hive");

    const P2 = { ...ON, hive: { ...HIVE_P, assumedGarrisonStrength: 5000 } };
    const s = snap({ hive: true, systems: [row(6, HIVE)], intel: [intelOf(6, HIVE, 100)] });
    assert.strictEqual(describe(s, P2, effectiveIntel(s), 6).enemyStrength
      - describe(s, ON, effectiveIntel(s), 6).enemyStrength, 5000);

    const d = decideReview(snap({ hive: true, systems: [row(6, HIVE)], expansion: [6], intel }), ON);
    const inv = d.intents.find((i) => i.type === "LAUNCH" && i.kind === "invasion");
    assert.ok(inv, JSON.stringify(d.notes));
    assert.strictEqual(inv.dueAt, AT + Math.round(ON.attackWindowMs * HIVE_P.captureSlowFactor));
    const plain = decideReview(snap({ systems: [row(6, HOSTILE)], expansion: [6], intel: [intelOf(6, HOSTILE)] }), ON);
    assert.strictEqual(plain.intents.find((i) => i.kind === "invasion").dueAt, AT + ON.attackWindowMs);

    const PP = { ...ON, patrol: { windowMs: HOUR, idleMs: 0, minShips: 1, garrisonMaxJumps: 4, scoutMaxJumps: 4,
      maxGarrisonsPerPost: 2, maxOpenPickets: 0, scoutReserve: 0, roleMaxJumps: 4, roleMaxEnemyRatio: 1,
      garrisonFleetsTarget: 1 } };
    const sortie = (rows) => {
      const x = snap({ hive: true, systems: rows, fleets: [wing("p1", 5, { fleetRole: "patrol",
        updatedAt: AT - 2 * HOUR })] });
      return planPatrols(x, evaluateSupplyAndFronts(x, PP), PP, new Set(), 3, {}).intents
        .map((i) => [i.kind, i.target.systemId]);
    };
    assert.deepStrictEqual(sortie([row(6, HIVE)]), []);
    assert.deepStrictEqual(sortie([row(6, HIVE), row(3, HOSTILE)]), [["patrol", 3]]);
  });

  test("HT4 off = today: params.hive null and isHive false -> decideReview deepStrictEqual to the snapshot without "
    + "hive fields (a hive-controlled row is an ordinary hostile system)", () => {
    const cases = [
      { systems: [row(6, HIVE), row(8, HIVE)], expansion: [6, 8], intel: [intelOf(6, HIVE), intelOf(8, HIVE)] },
      { systems: [row(6, HIVE)], theatre: [6], raidTargets: [6], intel: [intelOf(6, HIVE)] },
      { systems: [row(6, HIVE), row(9, F), row(10, null)], expansion: [6, 10],
        intel: [intelOf(6, HIVE), intelOf(10, null)] },
    ];
    for (const c of cases) {
      const today = decideReview(snap(c), BASE);
      const off = decideReview({ ...snap(c), isHive: () => false }, OFF_P);
      assert.deepStrictEqual(off, today, JSON.stringify(c.systems));
      assert.ok(launches(today).length > 0, JSON.stringify(today.notes));
    }
  });
};
