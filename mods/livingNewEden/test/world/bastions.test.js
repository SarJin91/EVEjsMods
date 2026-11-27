"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { harness: H } = require("../battle/settlement.test");
const { S } = require("../graph/fixtures/routeMap.fixture");
const { resolveConfig } = require("../../config");
const core = require("../../lib/world/core");
const { NPC_SOV_SYSTEMS } = require("../../lib/world/core/npcSovData");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const M = require("../../lib/world/occupation/machine");
const { startOccupation } = require("../../lib/world/occupation");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createBastionReconcile } = require("../../lib/world/bastions/reconcileService");
const { buildNpcSovCatalog } = require("../../tools/npcSov/buildNpcSovCatalog.lib");
const { candidateFacts, usableKinds, effectiveIntel } = require("../../lib/strategy/ai/targeting");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
const SOE = 500016;
const THUKKER = 500015;
const CALDARI = 500001;
const GURISTAS = 500010;
const SERPENTIS = 500020;
const J_CIJV = 30001977;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const COMP = Object.freeze([{ hullGroup: "cruiser", typeId: null, count: 3 }]);

let cachedConfig = null;
function configOf() {
  if (cachedConfig) return cachedConfig;
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: path.dirname(os.tmpdir()) } });
  assert.deepStrictEqual(r.errors || [], []);
  cachedConfig = r.config;
  return cachedConfig;
}

const SETTINGS = Object.freeze({ enabled: true, kinds: ["neutral", "unregistered"], excludeFactionIds: [500018],
  skipForeignHomeRegions: true, maxSystems: 16 });

const fixtureIndex = (systemId) => Object.freeze({ version: 1, enabled: true, systems: new Map([[systemId, SOE]]),
  stations: new Map(), byFaction: new Map(), issues: [], bastions: new Map([[systemId, SOE]]), bastionIssues: [] });

function seedSystem(env, repo, systemId, controller, influence) {
  env.tx((db) => {
    const r = repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: controller },
      influence: Object.entries(influence).map(([f, s]) => ({ factionId: Number(f), influenceScore: s })) },
    `world:seed:v1:${systemId}`);
    assert.ok(r.ok, JSON.stringify(r));
    const h = repo.setHomeInTx(db, systemId, controller);
    assert.ok(h.ok, JSON.stringify(h));
  });
}

function bootOccupation(opened, shared, coreIndex, config) {
  const env = H.boot(opened, shared);
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const or = startOccupation({ config: config || configOf(), persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => ({ getMode: () => "off" }),
    nowMs: () => 0, coreIndex });
  assert.ok(or.ok, JSON.stringify(or));
  return { env, repo, occ: or.occupation };
}

const systemOf = (env, repo, id) => env.tx((db) => repo.getSystem(db, id, { includeInfluence: true })).system;

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const BASE = 20;
const KINDS = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 5, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR,
  kinds: KINDS.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6, routeMaxJumps: 40,
  claimFrontGraceMs: 0, maxScoutsPerFaction: 4, maxRaidFronts: 2, coreRaidsAllowed: true });
const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0 });
function snap(extra) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: BASE, resourceUnits: 100000, reserveUnits: 10000, frontLimit: 6 },
    entry: { maxActiveFronts: 6, homeRegionIds: [] },
    doctrine: { doctrineId: "sf", canOccupy: true, reachJumps: 10, operationTypes: ["recon", "invasion", "raid"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], invasion: COMP,
        patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: [21], expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE, stationsMode: "ready", stations: [{ systemId: BASE, stationId: "st20" }],
    captureAnchors: [BASE], systems: [row(BASE, F), row(21, HOSTILE)],
    fleets: [{ fleetId: "inv1", version: 2, state: "IDLE", fleetRole: "invasion", systemId: BASE, refitPending: false,
      shipCount: 3, strength: strengthOf(COMP, POWER), operationId: null, legSeq: 0, homeSystemId: BASE,
      updatedAt: AT - HOUR }],
    fleetsTruncated: false, operations: [], operationsTruncated: false,
    intel: [{ systemId: 21, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0, hostileStrength: 0,
      hostileStations: 0, controllerFactionId: HOSTILE }],
    sightings: [], occupations: [], territory: [], territoryTruncated: false, capturedIds: [], footholds: [],
    ...extra };
}
const factsOf = (s) => candidateFacts(s, PARAMS, evaluateSupplyAndFronts(s, PARAMS), usableKinds(s, PARAMS),
  effectiveIntel(s), 21, false);

module.exports = ({ test, skip }) => {
  test("B1 selectBastions: neutral / unregistered kept; foreign home, exclusion, kind, core conflict, limit, off", () => {
    const catalog = [[J_CIJV, SOE, 10000023], [30000900, THUKKER, 10000011], [30000901, THUKKER, 10000011],
      [30004493, 500014, 10000057], [30002004, 500018, 10000023], [30001261, GURISTAS, 10000015],
      [30003268, CALDARI, 10000041], [30009001, 500999, 10009999]];
    const out = core.selectBastions(catalog, FACTIONS_V1, SETTINGS, new Map([[30000901, SERPENTIS]]));
    assert.deepStrictEqual([...out.systems], [[J_CIJV, SOE], [30000900, THUKKER], [30009001, 500999]]);
    assert.deepStrictEqual([...out.byFaction], [[SOE, 1], [THUKKER, 1], [500999, 1]]);
    assert.deepStrictEqual(out.skipped, { kind: 2, excluded: 1, foreignHome: 1, foreignStation: 0, core: 1 });
    assert.deepStrictEqual(out.issues, [`bastion:30000901: core ${SERPENTIS} wins over ${THUKKER}`]);
    const over = core.selectBastions(catalog, FACTIONS_V1, { ...SETTINGS, maxSystems: 2 }, new Map());
    assert.deepStrictEqual([over.systems.size, over.byFaction.size, over.issues], [0, 0, ["BASTIONS_OVER_LIMIT n=4 max=2"]]);
    const off = core.selectBastions(catalog, FACTIONS_V1, { ...SETTINGS, enabled: false }, new Map());
    assert.deepStrictEqual([off.systems.size, off.issues], [0, []]);
  });

  test("B2 getCoreIndex on npcSovData: J-CIJV -> SoE, no Outer Ring, cores only in coreSystemIds; bastions alone; "
    + "a foreign bastion is never a candidate with coreRaidsAllowed", () => {
    const config = configOf();
    const idx = core.getCoreIndex(config);
    assert.strictEqual(idx.systems.get(J_CIJV), SOE);
    assert.strictEqual(idx.bastions.get(J_CIJV), SOE);
    assert.strictEqual(idx.bastions.has(30004518), false, "Outer Ring = Serpentis home");
    assert.strictEqual(idx.systems.get(30004518), SERPENTIS, "the core stays");
    assert.strictEqual(idx.bastions.size, 238);
    assert.deepStrictEqual([...idx.bastionByFaction].sort((a, b) => a[0] - b[0]),
      [[500005, 123], [THUKKER, 101], [SOE, 7], [500017, 7]]);
    const nullsec = new Set(NPC_SOV_SYSTEMS.map((r) => r[0]));
    assert.ok([...idx.bastions.keys()].every((id) => nullsec.has(id)), "nullsec catalog only");
    assert.ok(!NPC_SOV_SYSTEMS.some((r) => r[0] === 30002187), "Amarr hq (highsec) is not in the catalog");
    const cores = core.coreSystemIds(idx);
    assert.deepStrictEqual(cores, core.coresFor(config).flatMap((c) => c.systemIds).sort((a, b) => a - b));
    assert.ok(!cores.includes(J_CIJV));
    const alone = core.getCoreIndex({ ...config, world: { ...config.world, coreProtectionEnabled: false } });
    assert.deepStrictEqual([alone.enabled, alone.byFaction.size, alone.systems.size, alone.bastions.size],
      [true, 0, 238, 238]);
    const none = core.getCoreIndex({ ...config, world: { ...config.world, coreProtectionEnabled: false,
      npcSovBastionsEnabled: false } });
    assert.strictEqual(none, core.EMPTY_CORE_INDEX);
    const coreOnly = factsOf(snap({ coreOwners: new Map([[21, HOSTILE]]) }));
    assert.ok(coreOnly !== null && coreOnly.core === true, "core without bastion stays a candidate");
    assert.strictEqual(factsOf(snap({ coreOwners: new Map([[21, HOSTILE]]),
      bastionOwners: new Map([[21, HOSTILE]]) })), null);
  });

  test("B3 planBastionRestore: J-CIJV under Caldari -> SoE baseline, foreign floor; INVASION -> STABLE seq+1; NOOP", () => {
    const params = { stableBaselineScore: 60, stableForeignFloorScore: 0 };
    const view = { state: "STABLE", controller: CALDARI, home: CALDARI, occupier: null, capturedAt: AT - 9 * HOUR,
      detachedSinceAt: null, seq: 4, sinceAt: AT - 10 * HOUR, evaluatedAt: AT - HOUR, at: AT,
      influence: new Map([[GURISTAS, { score: 100 }], [CALDARI, { score: 39.5 }], [SOE, { score: 0 }]]) };
    const r = M.planBastionRestore(view, SOE, params);
    assert.strictEqual(r.outcome, "RESTORED");
    assert.deepStrictEqual(r.evaluation.statePatch, { controllerFactionId: SOE, occupationState: "STABLE",
      occupierFactionId: null, capturedAt: null, detachedSinceAt: null, phaseDueAt: null, influenceEvaluatedAt: AT,
      previousControllerFactionId: CALDARI });
    assert.deepStrictEqual(r.evaluation.influence, [{ factionId: CALDARI, influenceScore: 0 },
      { factionId: GURISTAS, influenceScore: 0 }, { factionId: SOE, influenceScore: 60 }]);
    assert.deepStrictEqual([r.evaluation.controllerChanged, r.evaluation.homeChanged, r.evaluation.notes],
      [true, true, ["BASTION_RESTORED"]]);
    const inv = M.planBastionRestore({ ...view, state: "INVASION", occupier: GURISTAS, capturedAt: null }, SOE, params);
    const p = inv.evaluation.statePatch;
    assert.deepStrictEqual([p.occupationState, p.phaseSeq, p.occupierFactionId], ["STABLE", 5, null]);
    for (const e of [r, inv]) {
      const s = e.evaluation.statePatch;
      assert.strictEqual(M.checkInvariants({ state: s.occupationState, controller: s.controllerFactionId,
        occupier: s.occupierFactionId, capturedAt: s.capturedAt, detachedSinceAt: s.detachedSinceAt }), null);
    }
    const drifted = { ...view, controller: SOE, home: SOE, capturedAt: null,
      influence: new Map([[GURISTAS, { score: 100 }], [SOE, { score: 0 }]]) };
    const fix = M.planBastionRestore(drifted, SOE, params);
    assert.deepStrictEqual(fix, { ok: true, outcome: "RESTORED", evaluation: { to: "STABLE",
      statePatch: { influenceEvaluatedAt: AT }, influence: [{ factionId: GURISTAS, influenceScore: 0 },
        { factionId: SOE, influenceScore: 60 }], notes: ["BASTION_INFLUENCE_RESTORED"], controllerChanged: false,
      homeChanged: false } });
    const done = M.planBastionRestore({ ...drifted, influence: new Map([[GURISTAS, { score: 0 }],
      [SOE, { score: 60 }]]) }, SOE, params);
    assert.deepStrictEqual(done, { ok: true, outcome: "NOOP", evaluation: null });
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("B4 restoreBastionInTx: one write then NOOP, foreign IDLE garrison -> invasion, signal CORE_PROTECTED", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, repo, occ } = bootOccupation(reopen(), shared, fixtureIndex(S.N0));
      seedSystem(env, repo, S.N0, CALDARI, { [GURISTAS]: 100, [CALDARI]: 39.5, [SOE]: 0 });
      const fleetId = H.newFleet(env, "b4", CALDARI, COMP);
      const fleet = env.tx((db) => env.fleets.repository.getFleet(db, fleetId)).fleet;
      env.tx((db) => assert.ok(env.fleets.repository.reassignRole(db, { fleetId, expectedVersion: fleet.version,
        from: "invasion", to: "garrison" }, "b4:garrison").ok));
      const at = shared.clock.now();
      const first = env.tx((db) => occ.restoreBastionInTx(db, { systemId: S.N0, factionId: SOE, at },
        `world:bastion:v1:${S.N0}`));
      assert.deepStrictEqual([first.ok, first.outcome, first.previousControllerFactionId, first.garrisonReleased],
        [true, "RESTORED", CALDARI, 1], JSON.stringify(first));
      const sys = systemOf(env, repo, S.N0);
      assert.deepStrictEqual([sys.controllerFactionId, sys.homeFactionId, sys.occupationState, sys.capturedAt],
        [SOE, SOE, "STABLE", null]);
      assert.deepStrictEqual(sys.influence.map((i) => [i.factionId, i.influenceScore]),
        [[CALDARI, 0], [GURISTAS, 0], [SOE, 60]]);
      assert.strictEqual(env.tx((db) => env.fleets.repository.getFleet(db, fleetId)).fleet.fleetRole, "invasion");
      const again = env.tx((db) => occ.restoreBastionInTx(db, { systemId: S.N0, factionId: SOE, at },
        `world:bastion:v1:${S.N0}`));
      assert.deepStrictEqual([again.ok, again.outcome], [true, "NOOP"]);
      assert.strictEqual(systemOf(env, repo, S.N0).version, sys.version, "NOOP writes nothing");
      const sig = env.tx((db) => occ.signalInTx(db, { systemId: S.N0, factionId: CALDARI, signal: "RECON", at },
        "b4:signal"));
      assert.deepStrictEqual([sig.ok, sig.reason], [false, "CORE_PROTECTED"]);
    }));

  needsDriver("B5 reconcile: restored 1 then 0, drift without a write, the real facade has restoreBastionInTx", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, repo, occ } = bootOccupation(reopen(), shared, fixtureIndex(S.N5));
      assert.ok(Object.keys(occ).includes("restoreBastionInTx"), Object.keys(occ).join(","));
      seedSystem(env, repo, S.N5, CALDARI, { [CALDARI]: 60 });
      const settings = { enabled: true, intervalMs: 6 * HOUR, delayMs: 60000, pageRows: 32 };
      const reconcileWith = (factionId) => createBastionReconcile({ scheduler: env.scheduler,
        getOccupation: () => occ, coreIndex: fixtureIndex(S.N5), settings, clock: shared.clock,
        getGraph: () => ({ getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ id, secClass: "nullsec",
          factionId }) } }) }) });
      const pass = (rec, bucket) => {
        const h = rec.handler({ payload: { bucket, after: "0" } }, { now: shared.clock.now() });
        assert.strictEqual(h.ok, true, JSON.stringify(h));
        env.tx((db) => assert.deepStrictEqual(h.effect(db), { ok: true }));
        h.onCommitted();
        return rec.getStatus();
      };
      const drifted = reconcileWith(CALDARI);
      const before = systemOf(env, repo, S.N5).version;
      assert.deepStrictEqual([pass(drifted, 1).drift, pass(drifted, 1).restored], [1, 0]);
      assert.strictEqual(systemOf(env, repo, S.N5).version, before, "drift writes nothing");
      const rec = reconcileWith(SOE);
      assert.deepStrictEqual([pass(rec, 1).restored, pass(rec, 2).restored, rec.getStatus().noop], [1, 1, 1]);
      assert.strictEqual(systemOf(env, repo, S.N5).controllerFactionId, SOE);
      const off = createBastionReconcile({ scheduler: env.scheduler, getOccupation: () => occ,
        coreIndex: fixtureIndex(S.N5), settings: { ...settings, enabled: false }, clock: shared.clock });
      assert.deepStrictEqual(off.handler({ payload: { bucket: 3, after: "0" } }, { now: 1 }),
        { ok: true, outcome: "DISABLED" });
      assert.deepStrictEqual(off.bootstrap(), { ok: true, enqueued: false });
    }));

  needsDriver("B7 battle consequence in a bastion -> BASTION_FROZEN (version unchanged, battleBastionFrozen); "
    + "occupation.bastionBattleInfluenceFrozen=false -> INFLUENCE", async () => {
    const run = (config) => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, repo, occ } = bootOccupation(reopen(), shared, fixtureIndex(S.N5), config);
      try {
        seedSystem(env, repo, S.N5, SOE, { [SOE]: 60, [GURISTAS]: 0 });
        const v0 = systemOf(env, repo, S.N5).version;
        const settled = { battleId: "b7:b1", systemId: S.N5, at: shared.clock.now(), outcome: "A_WIN",
          winnerSide: "A", winnerFactionId: GURISTAS, sides: { A: { factionId: GURISTAS }, B: { factionId: SOE } } };
        const r = env.tx((db) => occ.consequence.apply(db, settled, "b7:ck"));
        return [r.ok, r.outcome, systemOf(env, repo, S.N5).version === v0,
          occ.getStatus().counters.battleBastionFrozen];
      } finally {
        occ.stop("test");
      }
    });
    assert.deepStrictEqual(await run(null), [true, "BASTION_FROZEN", true, 1]);
    const off = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: path.dirname(os.tmpdir()),
      EVEJS_LNE_OCCUPATION_BASTION_BATTLE_INFLUENCE_FROZEN: "false" } });
    assert.deepStrictEqual(off.errors || [], []);
    assert.deepStrictEqual(await run(off.config), [true, "INFLUENCE", false, 0]);
  });

  test("B6 vendor facts (factionID inheritance, NPC sov rule) + buildNpcSovCatalog on an inheritance fixture", () => {
    const creator = fs.readFileSync(path.join(REPO_ROOT, "tools", "DatabaseCreator", "database-creator.js"), "utf8");
    assert.ok(creator.includes("factionID: toInt(raw.factionID, toInt(constellation.factionID, "
      + "toInt(region.factionID, 0))),"), "database-creator.js factionID inheritance changed - rebuild the catalog");
    const rules = fs.readFileSync(path.join(REPO_ROOT, "server", "src", "services", "sovereignty",
      "sovSystemRules.js"), "utf8");
    const fn = rules.slice(rules.indexOf("function isSovereigntyClaimableSolarSystem"));
    assert.ok(fn.slice(0, fn.indexOf("\n}")).includes("normalizePositiveInteger(solarSystem.factionID, 0)"),
      "sovSystemRules.js NPC sov rule changed - rebuild the catalog");
    const inputs = { sde: { buildNumber: 1, releaseDate: "x" },
      systems: [{ systemId: 30000005, regionId: 10, constellationId: 20, securityStatus: -0.2, factionId: 7 },
        { systemId: 30000004, regionId: 10, constellationId: 20, securityStatus: -0.5 },
        { systemId: 30000003, regionId: 10, constellationId: 21, securityStatus: 0 },
        { systemId: 30000002, regionId: 10, constellationId: 20, securityStatus: 0.1 },
        { systemId: 31000001, regionId: 10, constellationId: 20, securityStatus: -1 },
        { systemId: 30000001, regionId: 11, constellationId: 22, securityStatus: -0.3 }],
      constellations: [{ constellationId: 20, factionId: 8 }, { constellationId: 21 }, { constellationId: 22 }],
      regions: [{ regionId: 10, factionId: 9 }, { regionId: 11 }] };
    const a = buildNpcSovCatalog(inputs);
    assert.ok(a.ok, JSON.stringify(a));
    assert.deepStrictEqual(a.rows, [[30000003, 9, 10], [30000004, 8, 10], [30000005, 7, 10]]);
    assert.strictEqual(buildNpcSovCatalog({ ...inputs, systems: [...inputs.systems].reverse() }).source, a.source);
    assert.ok(a.source.includes("Object.freeze([30000004, 8, 10]),"));
    assert.strictEqual(buildNpcSovCatalog({ sde: null }).ok, false);
  });
};
