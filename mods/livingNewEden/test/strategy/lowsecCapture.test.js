"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createManualClock } = require("../../lib/util/clock");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { decideReview } = require("../../lib/strategy/ai");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { describe } = require("../../lib/strategy/ai/targeting");
const { borderCandidates } = require("../../lib/strategy/ai/border");
const { createBorderIndex } = require("../../lib/strategy/border");
const { lowsecIdsOf, LOWSEC_PARAM_KEYS } = require("../../lib/strategy/reviewService");
const { resolveConfig } = require("../../config");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AMARR = 500003;
const SANSHA = 500019;
const SAMINER = 30001721;
const SAGAIN = 30001719;
const AT = 1760000000000;
const HOUR = 3600000;

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
const THEATRE = [...registry.getCampaign("k3-stain").systemIds].sort((a, b) => a - b);
const hostility = createHostility();
const CAPTURING = new Set(kinds.list.filter((k) => k.captures === true).map((k) => k.kind));
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
  maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
  reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
  maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: buildPowerTable(GROUPS),
  frontLimitCap: 2, routeMaxJumps: 40, reclaimMinInfluence: 20 });

function amarrSnap(g, controllers, sysPatch) {
  const entry = registry.getFaction(AMARR);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const ids = [...new Set([...THEATRE, ...controllers.keys(), SAMINER])].sort((a, b) => a - b);
  return {
    v: 1, factionId: AMARR, round: 7, at: AT, seed: 12345,
    faction: { status: "ACTIVE", homeSystemId: entry.hqSystemId, doctrineId: doctrine.doctrineId, resourceUnits: 20000,
      reserveUnits: 300, frontLimit: 1, version: 3 },
    entry: { kind: entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
      homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: true, operationTypes: [...doctrine.operationTypes],
      reachJumps: doctrine.reachJumps, templates: doctrine.templates, ownSpace: doctrine.ownSpace,
      borderReachKey: doctrine.borderReachKey, borderTargets: true, borderCaptures: true,
      captureTargets: ["free", "contested"], targetSecClasses: ["lowsec", "nullsec"] },
    theatre: THEATRE,
    neighbors: (id) => g.getNeighbors(id),
    regionOf: (id) => (g.getSystem(id) || {}).regionId || null,
    isHostile: (x) => x !== AMARR && !entry.allies.includes(x) && hostility(AMARR, x),
    stationsMode: "ready", stations: [{ systemId: SAMINER, stationId: "st0" }],
    systems: ids.map((systemId) => ({ systemId, controllerFactionId: controllers.has(systemId)
      ? controllers.get(systemId) : null, occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0,
    observed: false, ownInfluence: 0, ...(sysPatch[systemId] || {}) })),
    fleets: [], fleetsTruncated: false, operations: [], operationsTruncated: false,
    intel: [...controllers.keys()].map((systemId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0,
      hostileShips: 0, hostileStrength: 0, hostileStations: 0, controllerFactionId: controllers.get(systemId) })),
    sightings: [],
  };
}

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("LC1 (pure): a test doctrine with lowsec belt targets - captureEnabled=true -> invasion of the lowsec "
    + "candidate (free and contested); false -> captureAllowed false, no capturing LAUNCH on a lowsec system, a "
    + "contested hostile one gets the raid fallback; config default false, env reaches the AI param", () => {
    assert.deepStrictEqual(LOWSEC_PARAM_KEYS, { lowsecCaptureEnabled: "captureEnabled" });
    assert.strictEqual(configOf({}).lowsec.captureEnabled, false);
    assert.strictEqual(configOf({ EVEJS_LNE_LOWSEC_CAPTURE_ENABLED: "1" }).lowsec.captureEnabled, true);
    const X = 30009002;
    const map = k3StaticMap({ extra: [system(X, 10000022, 20000999, "lowsec")] });
    map.systems = map.systems.map((s) => (s.id === SAMINER ? { ...s, factionId: AMARR } : s));
    map.gates.push({ fromSystemId: 30001948, toSystemId: X }, { fromSystemId: X, toSystemId: 30001948 });
    const g = buildUniverseGraph(map).graph;
    const belt = createBorderIndex({ registry, getGraph: () => g, settings: { enabled: true, maxBfsSystems: 2000,
      routeMaxJumps: 40, reach: { empireMaxReachJumps: 10 } } }).beltOf(AMARR);
    assert.deepStrictEqual([belt.mode, belt.reach.has(X)], ["ready", true]);
    const ownTheatre = () => new Map(THEATRE.map((id) => [id, AMARR]));
    const build = (controllers, sysPatch, captureEnabled) => {
      const s = amarrSnap(g, controllers, sysPatch);
      s.border = { mode: "ready", reach: belt.reach, captures: true, candidates: borderCandidates({ reach: belt.reach,
        theatre: THEATRE, expansion: [], secClasses: s.doctrine.targetSecClasses, getSystem: (id) => g.getSystem(id),
        limit: 64 }) };
      s.lowsecIds = lowsecIdsOf({ captureEnabled, theatre: s.theatre, expansion: [],
        borderCandidates: s.border.candidates, getSystem: (id) => g.getSystem(id) });
      return s;
    };
    const only = (d) => d.intents.filter((i) => i.type === "LAUNCH").map((l) => [l.kind, l.target.systemId]);
    const lowsecCaptures = (d) => only(d).filter(([kind, id]) => CAPTURING.has(kind)
      && (g.getSystem(id) || {}).secClass === "lowsec");
    const free = ownTheatre().set(X, null);
    const contested = ownTheatre().set(X, SANSHA);
    const patch = { [X]: { occupationState: "OCCUPIED" } };
    const freeOn = build(free, {}, true);
    assert.deepStrictEqual([freeOn.border.candidates.includes(X), freeOn.lowsecIds.size], [true, 0]);
    assert.deepStrictEqual(only(decideReview(freeOn, PARAMS)), [["invasion", X]]);
    assert.deepStrictEqual(only(decideReview(build(contested, patch, true), PARAMS)), [["invasion", X]]);
    const freeOff = build(free, {}, false);
    assert.deepStrictEqual([...freeOff.lowsecIds].sort((a, b) => a - b), [SAGAIN, X]);
    assert.strictEqual(describe(freeOff, PARAMS, new Map(), X).captureAllowed, false);
    for (let seed = 1; seed <= 5; seed += 1) {
      const d = decideReview({ ...freeOff, seed }, PARAMS);
      assert.deepStrictEqual([lowsecCaptures(d), only(d).some(([, id]) => id === X)], [[], false], `seed ${seed}`);
      const c = decideReview({ ...build(contested, patch, false), seed }, PARAMS);
      assert.deepStrictEqual([lowsecCaptures(c), only(c)], [[], [["raid", X]]], `contested seed ${seed}`);
    }
  });

  needsDriver("LC2 REGISTRY_DATA_V1 k3 review (readSnapshot): the decisions with lowsec.captureEnabled=false "
    + "and true are deepStrictEqual over 4 review rounds; the flag reaches snapshot.lowsecIds (CONCORD belt Sagain "
    + "with false, empty with true)", async () => {
    const run = (flag) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(23) }), graph: R.graphOf(),
        controllers: new Map([...R.THEATRE.map((id) => [id, R.SANSHA]), [SAGAIN, R.SANSHA]]) };
      const decisions = [];
      const lowsec = new Map();
      const hooks = { beforeEffect: (d, snapshot) => {
        decisions.push(JSON.parse(JSON.stringify({ f: d.factionId, round: snapshot.round, d })));
        const ids = lowsec.get(d.factionId) || new Set();
        for (const id of snapshot.lowsecIds) ids.add(id);
        lowsec.set(d.factionId, ids);
        return d;
      } };
      const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_LOWSEC_CAPTURE_ENABLED: flag,
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" }, { hooks });
      assert.strictEqual(env.config.lowsec.captureEnabled, flag === "1");
      for (let k = 1; k <= 4; k += 1) await R.passesAt(env, shared, R.START_MS + k * R.I);
      env.strategy.stop("test");
      env.stations.stop("test");
      return { decisions, lowsec: [...lowsec.entries()].map(([f, s]) => [f, [...s].sort((a, b) => a - b)])
        .sort((a, b) => a[0] - b[0]) };
    });
    const off = await run("0");
    const on = await run("1");
    assert.ok(off.decisions.length >= 8, `reviews ran: ${off.decisions.length}`);
    assert.deepStrictEqual(off.decisions, on.decisions);
    assert.deepStrictEqual(on.lowsec.filter(([, ids]) => ids.length > 0), [], "captureEnabled=true -> empty");
    assert.deepStrictEqual(off.lowsec.filter(([, ids]) => ids.length > 0), [[R.CONCORD, [SAGAIN]]],
      "captureEnabled=false -> the lowsec belt candidate of CONCORD");
  });

  needsDriver("LC4 (variant A): the reclaim of an own lost lowsec home stays allowed with "
    + "lowsec.captureEnabled=false - Sagain (lowsec) in lostHome of Amarr (home_faction_id Amarr, controller null "
    + "after a liberation) is not in snapshot.lowsecIds and the review launches an invasion of it", async () => {
    const decisions = [];
    await H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map(R.THEATRE.map((id) => [id, R.SANSHA]));
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(29) }), graph: R.graphOf(), controllers };
      const rowOf = (id) => (id === SAGAIN
        ? { systemId: id, controllerFactionId: null, homeFactionId: AMARR, occupationState: "STABLE",
          occupierFactionId: null, influence: [] }
        : { systemId: id, controllerFactionId: controllers.get(id), occupationState: "STABLE", influence: [] });
      const world = { repository: { limits: { maxBatchReadIds: 8 }, getChangeCount: () => 0,
        getSystem: (tx, id) => ({ ok: true, system: controllers.has(id) || id === SAGAIN ? rowOf(id) : null }),
        getSystems: (tx, ids) => ({ ok: true, systems: ids.filter((id) => controllers.has(id) || id === SAGAIN)
          .map(rowOf), missing: [] }),
        listByOccupier: () => ({ ok: true, systems: [] }),
        listControlledByFaction: () => ({ ok: true, systems: [] }),
        countControlledByFaction: () => ({ ok: true, count: 0 }),
        listThreatened: () => ({ ok: true, systems: [] }),
        listLostHome: (tx, f, opts) => ({ ok: true, systems: f === AMARR && (opts.afterSystemId || 0) < SAGAIN
          ? [rowOf(SAGAIN)] : [], nextAfterSystemId: null }) } };
      const hooks = { beforeEffect: (d, snapshot) => {
        if (d.factionId === AMARR) {
          decisions.push({ lostHome: [...snapshot.lostHome.systemIds], lowsec: [...snapshot.lowsecIds],
            launches: d.intents.filter((i) => i.type === "LAUNCH").map((l) => [l.kind, l.target.systemId]) });
        }
        return d;
      } };
      const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(AMARR),
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" }, { world, hooks });
      assert.strictEqual(env.config.lowsec.captureEnabled, false);
      for (let k = 1; k <= 4; k += 1) await R.passesAt(env, shared, R.START_MS + k * R.I);
      env.strategy.stop("test");
      env.stations.stop("test");
    });
    assert.ok(decisions.length >= 1, `Amarr reviews: ${decisions.length}`);
    for (const d of decisions) {
      assert.deepStrictEqual([d.lostHome.includes(SAGAIN), d.lowsec.includes(SAGAIN)], [true, false]);
    }
    assert.ok(decisions.some((d) => d.launches.some(([kind, id]) => kind === "invasion" && id === SAGAIN)),
      "invasion of the lost lowsec home with captureEnabled=false");
  });

  needsDriver("LC5: a LAUNCH (recon) of Amarr (canOccupy) on a lowsec target - with "
    + "captureEnabled=false the effect gives SKIPPED_LOWSEC without occupation.signalInTx and counts lowsecSkipped; "
    + "with true the RECON signal goes to the occupation machine", async () => {
    const lowTheatre = new Set(R.THEATRE);
    const run = (flag) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(31) }), graph: R.graphOf(),
        controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
      const signals = [];
      const occupation = { getStatus: () => ({ state: "ready" }), count() {}, noteRefusal() {},
        markDetachedInTx: () => ({ ok: true, changed: false }), territoryUpkeepFactor: () => 1,
        signalInTx(tx, spec) {
          signals.push([spec.signal, spec.systemId]);
          return { ok: true, outcome: "STARTED", drift: 0 };
        } };
      const recon = [];
      const hooks = { beforeEffect: (d, snapshot) => {
        const targets = d.intents.filter((l) => l.type === "LAUNCH" && l.kind === "recon").map((l) => l.target.systemId);
        assert.strictEqual(snapshot.lowsecIds.size, 0, "REGISTRY_DATA_V1: no lowsec candidate of Amarr");
        for (const id of lowsecIdsOf({ captureEnabled: flag === "1", theatre: [], expansion: [],
          borderCandidates: targets, getSystem: () => ({ secClass: "lowsec" }) })) snapshot.lowsecIds.add(id);
        for (const id of targets) recon.push([id, snapshot.lowsecIds.has(id)]);
        return d;
      } };
      const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(AMARR),
        EVEJS_LNE_STRATEGY_TARGET_PASSIVE_CONTROLLERS: "1",
        EVEJS_LNE_LOWSEC_CAPTURE_ENABLED: flag, EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" }, { occupation, hooks });
      assert.strictEqual(env.config.lowsec.captureEnabled, flag === "1");
      for (let k = 1; k <= 2; k += 1) await R.passesAt(env, shared, R.START_MS + k * R.I);
      const counters = env.strategy.getStatus().ai.review.counters;
      env.strategy.stop("test");
      env.stations.stop("test");
      const occ = env.lines.filter((l) => / launch recon /.test(l)).map((l) => (/ occ=(\S+)/.exec(l) || [])[1]);
      return { recon, signals, occ, lowsecSkipped: counters.lowsecSkipped };
    });
    const off = await run("0");
    assert.ok(off.recon.length >= 1 && off.recon.every(([id, low]) => lowTheatre.has(id) && low === true),
      JSON.stringify(off.recon));
    assert.deepStrictEqual([off.signals, off.occ, off.lowsecSkipped],
      [[], off.recon.map(() => "SKIPPED_LOWSEC"), off.recon.length]);
    const on = await run("1");
    assert.ok(on.recon.length >= 1 && on.recon.every(([id, low]) => lowTheatre.has(id) && low === false),
      JSON.stringify(on.recon));
    assert.deepStrictEqual([on.signals, on.occ, on.lowsecSkipped],
      [on.recon.map(([id]) => ["RECON", id]), on.recon.map(() => "STARTED"), 0]);
  });
};
