"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { createPlayerActivityRepository } = require("../../lib/strategy/playerActivityRepository");
const { createPlayerActivityService } = require("../../lib/strategy/playerActivity");
const { chooseTargetSystem } = require("../../lib/strategy/ai/targeting");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { planGarrisonReinforce, interiorPostsOf } = require("../../lib/strategy/ai/garrison");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_VERSION, TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createRng } = require("../../lib/util/rng");
const { observeKill } = require("../../lib/adapter/killObservation");
const killObservation = require("../../lib/adapter/killObservation");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const AT = 1760000000000;
const HOUR = 3600000;
const WINDOW = 6 * HOUR;
const F = 7;
const HOSTILE = 9;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);

const rowsOf = (tx) => tx((db) => db.prepare("SELECT faction_id AS f, system_id AS s, kills, first_at AS first, "
  + "last_at AS last, last_victim_id AS v FROM world_faction_player_activity ORDER BY faction_id, system_id").all()
  .map((r) => ({ f: Number(r.f), s: Number(r.s), kills: Number(r.kills), first: Number(r.first),
    last: Number(r.last), v: r.v === null ? null : Number(r.v) })));

const DOCTRINE = (() => {
  const entry = FACTIONS_V1.find((x) => x.factionId === 500010);
  return { ...DOCTRINES_V1.find((x) => x.doctrineId === entry.doctrineId) };
})();
const WING = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const TARGET_PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 15,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 3, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 12, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6, routeMaxJumps: 40,
  maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true, hive: null });
const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0 });
const intelOf = (systemId, controllerFactionId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0,
  hostileShips: 0, hostileStrength: 0, hostileStations: 0, controllerFactionId });
const wing = (fleetId) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId: 5,
  refitPending: false, shipCount: 6, strength: strengthOf(WING, POWER), operationId: null, legSeq: 0, homeSystemId: 5,
  updatedAt: AT - HOUR });
function targetSnap(playerActivity) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 5, doctrineId: DOCTRINE.doctrineId, resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 6, version: 1 },
    entry: { kind: DOCTRINE.kind, maxActiveFronts: 6, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: DOCTRINE, theatre: [6, 8], expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 12), regionOf: () => null,
    isHostile: (x) => x === HOSTILE, isPlaying: () => true,
    stationsMode: "ready", stations: [{ systemId: 5, stationId: "st5" }], captureAnchors: [5],
    systems: [row(5, F), row(6, HOSTILE), row(8, HOSTILE)], fleets: [wing("w1"), wing("w2")],
    fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [intelOf(6, HOSTILE), intelOf(8, HOSTILE)],
    sightings: [], occupations: [], territory: [], territoryTruncated: false, capturedIds: [], footholds: [],
    ...(playerActivity ? { playerActivity } : {}) };
}

const GARRISON = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);
const GARRISON_PARAMS = Object.freeze({ ...TARGET_PARAMS, maxAssemblyJumps: 8, garrison: { maxPerReview: 1 } });
function garrisonSnap(posts, playerActivity) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "ga", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "ga", canOccupy: true, reachJumps: 30, operationTypes: ["recon", "raid", "reinforce"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], garrison: GARRISON } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [...posts.map((id) => row(id, F)), row(20, F)],
    fleets: [], fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], sightings: [],
    territory: posts.map((systemId) => ({ systemId, detachedSinceAt: null })), territoryTruncated: false,
    ...(playerActivity ? { playerActivity } : {}) };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const txOf = (opened) => (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };

  needsDriver("PA1 repository: series in the window +1, kills cap, duplicate (at + victimId), new series after the "
    + "window, the oldest row evicted at the limit; a reopened store lists the same rows", () =>
    H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const tx = txOf(opened);
      const counts = [];
      const limits = { playerActivityWindowMs: WINDOW, playerActivityMaxKills: 3, maxPlayerActivityRowsPerFaction: 2 };
      const repo = createPlayerActivityRepository({ limits, onCount: (name) => counts.push(name) });
      assert.deepStrictEqual(Object.keys(repo), ["recordKillInTx", "listActive", "limits"]);
      const rec = (f, s, at, victimId) => tx((db) => repo.recordKillInTx(db, { factionId: f, systemId: s, at,
        victimId }));
      assert.deepStrictEqual(rec(F, 100, AT, 11), { ok: true, record: { kills: 1, firstAt: AT, lastAt: AT },
        evicted: 0 });
      assert.deepStrictEqual(rec(F, 100, AT + HOUR, 12).record, { kills: 2, firstAt: AT, lastAt: AT + HOUR });
      const dup = rec(F, 100, AT + HOUR, 12);
      assert.deepStrictEqual([dup.ok, dup.duplicate, dup.record.kills], [true, true, 2]);
      rec(F, 100, AT + HOUR, 13);
      assert.deepStrictEqual(rec(F, 100, AT + 2 * HOUR, 14).record, { kills: 3, firstAt: AT, lastAt: AT + 2 * HOUR },
        "cap 3");
      const late = AT + 2 * HOUR + WINDOW + 1;
      assert.deepStrictEqual(rec(F, 100, late, 15).record, { kills: 1, firstAt: late, lastAt: late }, "new series");
      rec(F, 101, AT + HOUR, null);
      const ev = rec(F, 102, late, 16);
      assert.deepStrictEqual([ev.ok, ev.evicted], [true, 1]);
      assert.deepStrictEqual(rowsOf(tx).map((r) => [r.s, r.kills, r.v]), [[100, 1, 15], [102, 1, 16]]);
      assert.deepStrictEqual(tx((db) => repo.recordKillInTx(db, { factionId: 0, systemId: 1, at: 0 })).reason,
        "INVALID_INPUT");
      assert.deepStrictEqual(repo.recordKillInTx({}, { factionId: F, systemId: 1, at: 0 }).reason, "TX_REQUIRED");
      assert.deepStrictEqual([counts.filter((n) => n === "strategy.playerActivity.recorded").length,
        counts.filter((n) => n === "strategy.playerActivity.duplicate").length,
        counts.filter((n) => n === "strategy.playerActivity.evicted").length], [7, 1, 1]);
      const listed = tx((db) => repo.listActive(db, F, late, 64));
      assert.deepStrictEqual(listed, { ok: true, items: [{ systemId: 100, kills: 1 }, { systemId: 102, kills: 1 }] });
      assert.deepStrictEqual(tx((db) => repo.listActive(db, F, late + WINDOW + 1, 64)).items, [], "window over");

      opened.store.close("restart");
      const again = reopen();
      const fresh = createPlayerActivityRepository({ limits });
      assert.deepStrictEqual(txOf(again)((db) => fresh.listActive(db, F, late, 64)), listed);
    }));

  needsDriver("PA2 service: off / not rewardable / inactive faction / no world row -> skipped without a row; a valid "
    + "kill -> a row; a throwing repository -> ok:false + failed, nothing thrown", () =>
    H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const tx = txOf(opened);
      const counts = [];
      const telemetry = { hooks: { onCount: (name) => counts.push(name) } };
      const limits = { playerActivityWindowMs: WINDOW, playerActivityMaxKills: 50, maxPlayerActivityRowsPerFaction: 64 };
      const repository = createPlayerActivityRepository({ limits });
      const worldRows = new Set([100]);
      const world = { repository: { getSystem: (t, id, opts) => {
        assert.deepStrictEqual(opts, { includeInfluence: false });
        return { ok: true, system: worldRows.has(id) ? { systemId: id } : null };
      } } };
      const registry = { isActive: (f) => f === F };
      const on = { strategy: { playerActivityEnabled: true } };
      const make = (config, repo = repository) => createPlayerActivityService({ store: opened.store, repository: repo,
        world, registry, config, telemetry, logger: { log() {} } });
      const kill = (over = {}) => ({ characterId: 90000001, victimFactionId: F, systemId: 100, atMs: AT, victimId: 5,
        rewardable: true, ...over });
      const service = make(on);
      assert.deepStrictEqual(Object.keys(service), ["onNpcKill"]);
      assert.deepStrictEqual(make({ strategy: { playerActivityEnabled: false } }).onNpcKill(kill()),
        { ok: true, skipped: "DISABLED" });
      assert.deepStrictEqual(service.onNpcKill(kill({ rewardable: undefined })), { ok: true, skipped: "NOT_REWARDABLE" });
      assert.deepStrictEqual(service.onNpcKill(kill({ victimFactionId: 8 })), { ok: true, skipped: "INACTIVE_FACTION" });
      assert.deepStrictEqual(service.onNpcKill(kill({ systemId: 200 })), { ok: true, skipped: "NO_ROW" });
      assert.deepStrictEqual(rowsOf(tx), []);
      assert.deepStrictEqual(service.onNpcKill(kill()), { ok: true, record: { kills: 1, firstAt: AT, lastAt: AT },
        evicted: 0 });
      assert.deepStrictEqual(rowsOf(tx).map((r) => [r.f, r.s, r.kills, r.v]), [[F, 100, 1, 5]]);
      const broken = make(on, { recordKillInTx() {
        throw new Error("boom");
      } });
      const r = broken.onNpcKill(kill({ atMs: AT + 1 }));
      assert.deepStrictEqual([r.ok, r.reason], [false, "TX_FAILED"]);
      const refused = make(on, { recordKillInTx: () => ({ ok: false, reason: "VERSION_CONFLICT" }) });
      assert.deepStrictEqual(refused.onNpcKill(kill({ atMs: AT + 2 })).reason, "PLAYER_ACTIVITY_TX_FAILED");
      assert.deepStrictEqual(rowsOf(tx).map((x) => x.kills), [1], "failures wrote nothing");
      assert.deepStrictEqual([counts.filter((n) => n === "strategy.playerActivity.skipped").length,
        counts.filter((n) => n === "strategy.playerActivity.failed").length], [4, 2]);
    }));

  test("PA3 acceptance criterion: a player attacking the front changes the target - A (nearer) without activity, B with 10 "
    + "kills on A; weights v8 [8, -40, -400]", () => {
    assert.deepStrictEqual([TARGET_SCORING_VERSION, TARGET_SCORING_V1.playerActivityPerKill,
      TARGET_SCORING_V1.playerActivityCap], [10, -40, -400]);
    const pick = (activity) => {
      const s = targetSnap(activity);
      const r = chooseTargetSystem(s, evaluateSupplyAndFronts(s, TARGET_PARAMS), TARGET_PARAMS, createRng(5));
      assert.ok(r.ok, JSON.stringify(r));
      return r.systemId;
    };
    assert.strictEqual(pick(null), 6, "v7 order: the nearer A");
    assert.strictEqual(pick([{ systemId: 6, kills: 10 }]), 8, "10 player kills on A -> B");
    assert.strictEqual(pick([{ systemId: 6, kills: 1 }]), 6, "one kill does not outweigh 2 jumps and a neighbour");
  });

  test("PA4 defence: one slot -> the hot post (kills >= hotMinKills) before the nearer one; interiorPostsOf keeps the "
    + "garrison of a hot post", () => {
    const plan = (activity, hot) => planGarrisonReinforce({ snapshot: garrisonSnap([22, 25], activity),
      supply: { stationSystems: [20] }, params: { ...GARRISON_PARAMS, playerActivity: hot ? { hotMinKills: 3 } : null },
      ledger: null, slots: { operations: 1, mobilizations: 1 }, budget: { resourceUnits: 1e6, reserveUnits: 1e6 } })
      .intents.map((i) => i.target.systemId);
    assert.deepStrictEqual(plan(null, true), [22], "nearer to the station");
    assert.deepStrictEqual(plan([{ systemId: 25, kills: 3 }], true), [25], "hot post first");
    assert.deepStrictEqual(plan([{ systemId: 25, kills: 2 }], true), [22], "below hotMinKills");
    assert.deepStrictEqual(plan([{ systemId: 25, kills: 9 }], false), [22], "feature off: params.playerActivity null");
    const P = { ...GARRISON_PARAMS, playerActivity: { hotMinKills: 3 } };
    assert.deepStrictEqual([...interiorPostsOf(garrisonSnap([19, 21, 22]), P)], [21]);
    assert.deepStrictEqual([...interiorPostsOf(garrisonSnap([19, 21, 22], [{ systemId: 21, kills: 3 }]), P)], []);
  });

  test("PA5 bridge: three listeners, playerActivity gets the navy kill, one throwing listener blocks no other; vendor "
    + "fact (module object call); GAME_MODULES consumer; loader hook wraps with the flag alone", () => {
    const got = { liberation: [], standings: [], playerActivity: [], frontJobs: [] };
    const listener = (name, throws) => ({ onNpcKill(k) {
      got[name].push(k);
      if (throws) throw new Error(`${name} boom`);
      return { ok: true };
    } });
    const deps = (throwing) => ({ resolveVictimFactionID: () => 500010,
      getLiberation: () => listener("liberation", throwing === "liberation"),
      getStandings: () => listener("standings", throwing === "standings"),
      getPlayerActivity: () => listener("playerActivity", false),
      getFrontJobs: () => listener("frontJobs", throwing === "frontJobs"),
      isNavyVictim: (e) => e.navy === true, navyKillsLiberate: () => false });
    const out = observeKill(null, { systemID: 5, itemID: 77 }, 1, { nowMs: 9 }, deps("standings"));
    assert.deepStrictEqual(Object.keys(out.results), ["liberation", "standings", "playerActivity", "frontJobs"]);
    assert.deepStrictEqual([out.results.standings.reason, out.results.playerActivity], ["LISTENER_THREW", { ok: true }]);
    observeKill(null, { systemID: 5, itemID: 78, navy: true }, 1, { nowMs: 9 }, deps("liberation"));
    assert.deepStrictEqual(got.playerActivity.map((k) => [k.victimId, k.navy === true, k.rewardable]),
      [[77, false, true], [78, true, true]]);
    assert.deepStrictEqual(got.liberation.map((k) => k.victimId), [77], "navy skips liberation, not playerActivity");
    const fj = observeKill(null, { systemID: 5, itemID: 79 }, 1, { nowMs: 9 }, deps("frontJobs"));
    assert.deepStrictEqual([fj.results.liberation, fj.results.standings, fj.results.playerActivity,
      fj.results.frontJobs.reason], [{ ok: true }, { ok: true }, { ok: true }, "LISTENER_THREW"]);
    assert.deepStrictEqual(got.frontJobs.map((k) => [k.victimId, k.navy === true]), [[77, false], [78, true], [79, false]],
      "navy reaches frontJobs");

    const tracker = fs.readFileSync(path.join(SERVER_SRC, "space", "combat", "killmailTracker.js"), "utf8");
    assert.ok(/factionKillStanding\.recordNpcFactionStandingLoss\(/.test(tracker), "call through the module object");
    assert.ok(!/\{[^}]*\brecordNpcFactionStandingLoss\b[^}]*\}\s*=\s*require/.test(tracker), "no destructuring");
    const entry = GAME_MODULES.find((m) => m.path === "services/character/factionKillStandingRuntime");
    const seam = entry.symbols.find((s) => s.name === "recordNpcFactionStandingLoss");
    assert.deepStrictEqual([seam.consumers.includes("playerActivity"), seam.consumers.includes("frontJobs"), seam.wrap,
      seam.firstLoad], [true, true, true, true]);

    const { buildHooks } = require("../../loader");
    const silent = { log() {}, debug() {}, logError() {} };
    const wrapped = (config) => {
      const ctx = { logger: silent, state: { configResult: { ok: true, config } } };
      const original = () => null;
      const exportsObj = { recordNpcFactionStandingLoss: original, resolveVictimFactionID: () => 0 };
      buildHooks(ctx).find((h) => h.name === "npcKillLiberation").run(exportsObj, "factionKillStandingRuntime", null);
      return exportsObj.recordNpcFactionStandingLoss !== original;
    };
    const only = (flag, strategyOn = true) => ({ enabled: true, modules: { world: { enabled: false },
      strategy: { enabled: strategyOn } }, strategy: { playerActivityEnabled: flag } });
    const jobsOnly = (flag) => ({ enabled: true, modules: { world: { enabled: true }, strategy: { enabled: false } },
      occupation: { enabled: true }, liberation: { enabled: false }, frontJobs: { enabled: flag } });
    try {
      assert.deepStrictEqual([wrapped(only(true)), wrapped(only(false)), wrapped(only(true, false))],
        [true, false, false]);
      assert.deepStrictEqual([wrapped(jobsOnly(true)), wrapped(jobsOnly(false))], [true, false]);
    } finally {
      killObservation.setNavyKillsLiberate(false);
    }
  });
};
