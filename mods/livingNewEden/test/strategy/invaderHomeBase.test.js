"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { footholdsOf } = require("../../lib/runtime/services");
const { markFootholdHolders } = require("../../lib/strategy/ai/footholdHold");
const { expansionCandidates } = require("../../lib/strategy/ai/expansion");
const { decideReview } = require("../../lib/strategy/ai");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { createHostility } = require("../../lib/battle/data/hostility");
const { createOccupationService } = require("../../lib/world/occupation/occupationService");
const { resolveConfig } = require("../../config");
const { harness: R } = require("../world/occupationRepel.test");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const DTH = 500029;
const ZARZAKH = 30100000;
const HOSTILE = 9;

function oldFootholdsOf(ctx, tx, f) {
  const a = ctx.invasions && typeof ctx.invasions.listFootholdsInTx === "function"
    ? ctx.invasions.listFootholdsInTx(tx, f) : { ok: true, footholds: [] };
  const h = ctx.strategy && ctx.strategy.hive;
  if (!a || !a.ok || !h || typeof h.listNodesInTx !== "function") return a;
  const b = h.listNodesInTx(tx, f);
  return b && b.ok ? { ok: true, footholds: [...a.footholds, ...b.footholds] } : b;
}

function ctxOf(o = {}) {
  const reads = { world: 0 };
  const entry = o.entry === undefined ? { kind: "invader", hqSystemId: ZARZAKH } : o.entry;
  const ctx = {
    config: { invasions: { homeBaseEnabled: o.flag, homeCaptureRangeJumps: o.jumps === undefined ? 3 : o.jumps },
      graph: { routeMaxJumps: o.routeMaxJumps === undefined ? 40 : o.routeMaxJumps } },
    invasions: o.invasions === undefined ? { listFootholdsInTx: () => ({ ok: true, footholds: [{ systemId: 7, jumps: 3 }] }) }
      : o.invasions,
    strategy: { registry: { getFaction: () => entry }, hive: o.hive || null },
    world: { repository: { getSystem: (tx, id, opts) => {
      reads.world += 1;
      assert.deepStrictEqual(opts, { includeInfluence: false });
      if (o.read) return o.read;
      return { ok: true, system: { systemId: id, controllerFactionId: o.controller === undefined ? DTH : o.controller } };
    } } },
  };
  return { ctx, reads };
}

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 15,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 12, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: buildPowerTable(GROUPS), frontLimitCap: 6,
  routeMaxJumps: 40, maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true,
  footholdHold: { minFleets: 1 } });

const HOME = 1;
const VERTS = new Map([[1, { secClass: "other", regionId: 10001000 }], [2, { secClass: "nullsec", regionId: 77 }],
  [3, { secClass: "nullsec", regionId: 77 }]]);
const NEIGH = { 1: [2, 3], 2: [1], 3: [1] };
const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0 });
const intelOf = (systemId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
  hostileStrength: 0, hostileStations: 0, controllerFactionId: HOSTILE });

function dthSnap(footholds, expansion) {
  const d = DOCTRINES_V1.find((x) => x.doctrineId === "deathless-invader-v1");
  return { v: 1, factionId: DTH, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: HOME, doctrineId: d.doctrineId, resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 6, version: 1 },
    entry: { kind: "invader", maxActiveFronts: 1, allies: [], homeRegionIds: [10001000], ownerCorporationId: 1 },
    doctrine: d, theatre: [], expansion, raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => NEIGH[id] || [], regionOf: (id) => (VERTS.get(id) || {}).regionId || null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [], captureAnchors: [],
    systems: [row(1, DTH), row(2, HOSTILE), row(3, HOSTILE)], fleets: [], fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: [intelOf(2), intelOf(3)], sightings: [], occupations: [],
    territory: [], territoryTruncated: false, capturedIds: [1], footholds };
}
const scan = (footholds) => expansionCandidates({ enabled: true, stationSystems: [], theatre: [],
  neighbors: (id) => NEIGH[id] || [], getSystem: (id) => VERTS.get(id) || null, jumps: 15, maxSystems: 2000,
  limit: 8, groups: footholds.map((fh) => ({ starts: [fh.systemId], jumps: fh.jumps })) });

module.exports = ({ test, skip }) => {
  test("HB1 flag off (false / absent) -> footholdsOf = the old code for footholds, hive nodes, refusals and "
    + "no invasions; zero world reads", () => {
    const hive = { listNodesInTx: () => ({ ok: true, footholds: [{ systemId: 20, jumps: 10 }] }) };
    const variants = [{}, { hive }, { invasions: null }, { invasions: { listFootholdsInTx: () => ({ ok: false,
      reason: "X" }) } }, { hive: { listNodesInTx: () => ({ ok: false, reason: "H" }) } }];
    for (const flag of [false, undefined]) {
      for (const v of variants) {
        const { ctx, reads } = ctxOf({ ...v, flag });
        assert.deepStrictEqual(footholdsOf(ctx, {}, DTH), oldFootholdsOf(ctx, {}, DTH), JSON.stringify(v));
        assert.strictEqual(reads.world, 0);
      }
    }
    const cfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
    assert.deepStrictEqual([cfg.invasions.homeBaseEnabled, cfg.invasions.homeCaptureRangeJumps], [false, 3]);
  });

  test("HB2 flag on: controlled HQ -> {30100000, 3, home}; foreign HQ, no hq (Sleepers), not an invader or a "
    + "refused read -> no home entry; jumps clamped to graph.routeMaxJumps; config warning without review footholds", () => {
    const fh = { systemId: 7, jumps: 3 };
    assert.deepStrictEqual(footholdsOf(ctxOf({ flag: true }).ctx, {}, DTH),
      { ok: true, footholds: [fh, { systemId: ZARZAKH, jumps: 3, home: true }] });
    for (const o of [{ controller: 500010 }, { controller: null }, { entry: { kind: "invader", hqSystemId: null } },
      { entry: { kind: "pirate", hqSystemId: ZARZAKH } }, { entry: null }, { read: { ok: false, reason: "TX" } }]) {
      assert.deepStrictEqual(footholdsOf(ctxOf({ flag: true, ...o }).ctx, {}, DTH), { ok: true, footholds: [fh] },
        JSON.stringify(o));
    }
    assert.deepStrictEqual(footholdsOf(ctxOf({ flag: true, jumps: 5, routeMaxJumps: 2 }).ctx, {}, DTH).footholds[1],
      { systemId: ZARZAKH, jumps: 2, home: true });
    const on = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_INVASIONS_HOME_BASE_ENABLED: "1" } });
    assert.ok(on.warnings.some((w) => w.startsWith("invasions.homeBaseEnabled without invasions.reviewFootholdsEnabled")),
      JSON.stringify(on.warnings));
    const both = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_INVASIONS_HOME_BASE_ENABLED: "1", EVEJS_LNE_INVASIONS_REVIEW_FOOTHOLDS_ENABLED: "1" } });
    assert.ok(!both.warnings.some((w) => w.startsWith("invasions.homeBaseEnabled")), JSON.stringify(both.warnings));
  });

  test("HB3 Deathless with the home only: expansion candidates 2, 3 and a MOBILIZE / LAUNCH; without the home "
    + "-> no candidates and no MOBILIZE / LAUNCH", () => {
    const home = [{ systemId: HOME, jumps: 3, home: true }];
    assert.deepStrictEqual(scan(home), [2, 3]);
    assert.deepStrictEqual(scan([]), []);
    const on = decideReview(dthSnap(home, scan(home)), PARAMS);
    assert.strictEqual(on.outcome, "REVIEWED", on.reason);
    assert.ok(on.intents.some((i) => i.type === "MOBILIZE" || i.type === "LAUNCH"), JSON.stringify(on));
    const noAnchor = decideReview(dthSnap([], scan(home)), PARAMS);
    const off = decideReview(dthSnap([], scan([])), PARAMS);
    for (const d of [noAnchor, off]) {
      assert.ok(!d.intents.some((i) => i.type === "MOBILIZE" || i.type === "LAUNCH"), JSON.stringify(d));
      assert.ok(d.notes.some((n) => n.startsWith("NO_TARGET")), JSON.stringify(d.notes));
    }
  });

  test("HB4 markFootholdHolders with the home alone -> zero pins and no notes", () => {
    const fleet = (fleetId) => ({ fleetId, state: "IDLE", fleetRole: "invasion", systemId: HOME, refitPending: false,
      strength: 10, operationId: null });
    const s = { ...dthSnap([{ systemId: HOME, jumps: 3, home: true }], []), fleets: [fleet("d1"), fleet("d2")] };
    const pseudo = new Map();
    assert.deepStrictEqual(markFootholdHolders(s, PARAMS, pseudo), []);
    assert.strictEqual(pseudo.size, 0);
    assert.deepStrictEqual(markFootholdHolders({ ...s, footholds: [{ systemId: HOME, jumps: 3 }] }, PARAMS, new Map()),
      ["FOOTHOLD_HOLD"]);
  });

  const driver = H.loadDriver();
  const run = driver.ok ? test : (name) => skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  run("HB5 occupation readView: the home N7 of Deathless (2 jumps from N5) -> inRange true with the flag "
    + "false without", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = R.bootRepel(reopen(), shared);
    const seed = (systemId, controllerFactionId) => assert.ok(env.tx((db) => env.repo.applyChange(db, { systemId,
      expectedVersion: 0, reason: "SEED_CONTROL", state: { securityClass: "nullsec", controllerFactionId },
      influence: [{ factionId: controllerFactionId, influenceScore: 60 }] }, `world:seed:v1:${systemId}`)).ok);
    seed(H.S.N5, 500003);
    seed(H.S.N7, DTH);
    const inRangeOf = (flag) => {
      const ctx = { config: { invasions: { homeBaseEnabled: flag, homeCaptureRangeJumps: 3 },
        graph: { routeMaxJumps: 40 } }, invasions: { listFootholdsInTx: () => ({ ok: true, footholds: [] }) },
      strategy: { registry: { getFaction: () => ({ kind: "invader", hqSystemId: H.S.N7 }) }, hive: null },
      world: { repository: env.repo } };
      const svc = createOccupationService({ store: env.store, journal: env.journal, repository: env.repo,
        fleets: env.fleets, scheduler: env.scheduler, clock: shared.clock, config: env.config,
        hostility: createHostility(), powerTable: buildPowerTable(expandStrengthGroups(GROUPS)),
        getStations: () => null, graph: { getGraph: () => ({ ok: true, graph: shared.graph }) },
        footholdsOf: (tx, f) => footholdsOf(ctx, tx, f), getCaptureBelt: () => ({ ok: true, mode: "off" }) });
      return env.tx((db) => {
        const r = svc.readView(db, H.S.N5, shared.clock.now(), [DTH]);
        assert.ok(r.ok, JSON.stringify(r));
        return r.view.inRange(DTH);
      });
    };
    assert.deepStrictEqual([inRangeOf(true), inRangeOf(false)], [true, false]);
  }));
};
