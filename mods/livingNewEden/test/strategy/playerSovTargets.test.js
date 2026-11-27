"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { chooseNextOperation } = require("../../lib/strategy/ai/operations");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { chooseTargetSystem } = require("../../lib/strategy/ai/targeting");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createRng } = require("../../lib/util/rng");
const { createPlayerSovSiege } = require("../../lib/world/playerSov/siege");
const { createPlayerSovClockRepository } = require("../../lib/world/playerSov/clock");
const { createOwnerOnline } = require("../../lib/world/playerSov/ownerOnline");
const { createPlayerSovRepository } = require("../../lib/world/playerSov/repository");
const { createJournal } = require("../../lib/persistence/journal");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const BASE = 20;
const T = 22;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const WING = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 5, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6, routeMaxJumps: 40,
  claimFrontGraceMs: 0 });
const ON = Object.freeze({ ...PARAMS, playerSov: Object.freeze({ targetPremium: 20, maxSiegesPerFaction: 2 }) });

const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0 });
const intelOf = (systemId, controllerFactionId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0,
  hostileShips: 0, hostileStrength: 0, hostileStations: 0, controllerFactionId });
const fleet = (fleetId, systemId) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId,
  refitPending: false, shipCount: 6, strength: strengthOf(WING, POWER), operationId: null, legSeq: 0,
  homeSystemId: BASE, updatedAt: AT - HOUR });

function snap(o = {}) {
  const controller = o.controller === undefined ? null : o.controller;
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: BASE, resourceUnits: 100000, reserveUnits: 10000, frontLimit: 6 },
    entry: { maxActiveFronts: 6, homeRegionIds: [] },
    doctrine: { doctrineId: "ps", canOccupy: true, reachJumps: 10,
      operationTypes: o.operationTypes || ["recon", "invasion", "raid"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], invasion: WING, patrol: WING } },
    theatre: [T], expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [{ systemId: BASE, stationId: "st20" }], captureAnchors: [BASE],
    systems: [row(BASE, F), row(T, controller)], fleets: [fleet("inv1", BASE), fleet("inv2", BASE)],
    fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [intelOf(T, controller)],
    sightings: [], occupations: [], territory: [], territoryTruncated: false, capturedIds: [], footholds: [] };
  if (o.claim) {
    s.playerSov = new Map([[T, { hostile: true, ownerSeen: true, siegedByOther: false, siegedBySelf: false,
      ...o.claim }]]);
    s.playerSovSieges = o.sieges || 0;
  }
  return s;
}

const run = (s, P) => chooseNextOperation(s, evaluateSupplyAndFronts(s, P), P, createRng(5), null);
const launches = (out) => out.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);
const psNotes = (out) => out.notes.filter((n) => n.startsWith("PLAYER_SOV_"));

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_PLAYER_SOV_ENABLED: "1",
    ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

module.exports = ({ test, skip }) => {
  test("PST1 hostile seen owner -> LAUNCH invasion, score + targetPremium; friendly -> PLAYER_SOV_FRIENDLY, no "
    + "target; a raid-only kind on a player system -> PLAYER_SOV_NO_CAPTURE (without playerSov: the raid)", () => {
    const pick = (s, P) => chooseTargetSystem(s, evaluateSupplyAndFronts(s, P), P, createRng(5));
    const plain = pick(snap(), PARAMS);
    const hostile = pick(snap({ claim: {} }), ON);
    assert.deepStrictEqual([hostile.systemId, hostile.score], [T, plain.score + 20]);
    const out = run(snap({ claim: {} }), ON);
    assert.deepStrictEqual([launches(out), psNotes(out)], [[["invasion", T]], []], JSON.stringify(out.notes));
    const friendly = run(snap({ claim: { hostile: false } }), ON);
    assert.deepStrictEqual([launches(friendly), psNotes(friendly)], [[], ["PLAYER_SOV_FRIENDLY"]]);
    assert.ok(friendly.notes.includes("NO_TARGET:NO_CANDIDATE"), JSON.stringify(friendly.notes));
    const raidOnly = { controller: HOSTILE, operationTypes: ["recon", "raid"] };
    assert.deepStrictEqual(launches(run(snap(raidOnly), PARAMS)), [["raid", T]]);
    const noCapture = run(snap({ ...raidOnly, claim: {} }), ON);
    assert.deepStrictEqual([launches(noCapture), psNotes(noCapture)], [[], ["PLAYER_SOV_NO_CAPTURE"]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PST2 listForReviewInTx on a migrated store (hostile, ownerSeen with memory per corporation, busy / own "
    + "siege, siegesOfFaction, targetOwnerSeenMs 0) + skips INACTIVE / BUSY / LIMIT (own siege goes on, 0 = always), "
    + "module off = the review without the field", () => H.withStore(driver, async (reopen) => {
    const { store } = reopen();
    const SANSHA = 500019;
    const AMARR = 500003;
    const t = 100 * HOUR;
    const corps = [98000001, 98000002, 98000003];
    const activity = new Map([[corps[0], { ok: true, onlineNow: false, lastSeenMs: t - HOUR }],
      [corps[1], { ok: true, onlineNow: false, lastSeenMs: t - 72 * HOUR }]]);
    const calls = [];
    const adapter = { playerStructures: { readOwnerFace: () => ({ ok: true, ceoId: 8, npc: false }),
      readOwnerActivity: (corpId, opts) => {
        calls.push([corpId, opts.maxMembers]);
        return activity.get(corpId) || { ok: false, reason: "SEAM_ERROR" };
      } },
    readCharacterStanding: () => ({ ok: true, standing: -10 }) };
    const repo = createPlayerSovRepository();
    const siegeOf = (config) => createPlayerSovSiege({ journal: createJournal({ clock: { now: () => t },
      maxPayloadBytes: 8192, maxRows: 500 }), getPlayerSov: () => ({ getRepository: () => repo }),
    clockRepo: createPlayerSovClockRepository(), adapter, getRegistry: () => ({ getFaction: () => ({ kind: "pirate" }) }),
    getPresence: () => null, config, ownerOnline: createOwnerOnline({ getPresence: () => null, adapter, config }) });
    const tx = (fn) => {
      const r = store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const plan = [[30004001, corps[0], null, null], [30004002, corps[1], AMARR, null], [30004003, corps[2], SANSHA, null],
      [30004004, corps[0], SANSHA, "REINFORCED"]];
    tx((db) => {
      for (const [i, [systemId, corpId, attacker, last]] of plan.entries()) {
        let c = repo.insertClaim(db, { systemId, allianceId: 99000001 + i, corpId, hubItemId: 1700000001 + i,
          origin: "MIRROR", state: "HELD", at: t - HOUR }).claim;
        if (attacker) c = repo.transition(db, { claim: c, to: "SIEGED", at: t - HOUR, attackerFactionId: attacker }).claim;
        if (last) repo.transition(db, { claim: c, to: last, at: t - HOUR, reinforcedUntil: t + HOUR });
      }
      return { ok: true };
    });
    const config = configOf();
    const siege = siegeOf(config);
    const read = tx((db) => siege.listForReviewInTx(db, SANSHA, t));
    const view = (r) => [...r.bySystem].map(([id, x]) => [id, x.hostile, x.ownerSeen, x.siegedByOther, x.siegedBySelf]);
    assert.deepStrictEqual([read.ok, read.siegesOfFaction, view(read)], [true, 2, [
      [30004001, true, true, false, false], [30004002, true, false, true, false],
      [30004003, true, false, false, true], [30004004, true, true, false, true]]]);
    assert.deepStrictEqual(calls, corps.map((c) => [c, config.playerSov.ownerMembersMax]));
    tx((db) => siege.listForReviewInTx(db, SANSHA, t + 1000));
    assert.strictEqual(calls.length, 3, "memory per corporation for reconcileMs");
    const always = tx((db) => siegeOf(configOf({ EVEJS_LNE_PLAYER_SOV_TARGET_OWNER_SEEN_MS: "0" }))
      .listForReviewInTx(db, SANSHA, t));
    assert.deepStrictEqual([view(always).map((x) => x[2]), calls.length], [[true, true, true, true], 3]);

    for (const [claim, sieges, P, note] of [[{ ownerSeen: false }, 0, ON, "PLAYER_SOV_INACTIVE"],
      [{ siegedByOther: true }, 0, ON, "PLAYER_SOV_BUSY"], [{}, 2, ON, "PLAYER_SOV_LIMIT"],
      [{ siegedBySelf: true }, 2, { ...ON, playerSov: { targetPremium: 20, maxSiegesPerFaction: 0 } },
        "PLAYER_SOV_LIMIT"]]) {
      const out = run(snap({ claim, sieges }), P);
      assert.deepStrictEqual([launches(out), psNotes(out)], [[], [note]], JSON.stringify(claim));
    }
    assert.deepStrictEqual(launches(run(snap({ claim: { siegedBySelf: true }, sieges: 2 }), ON)), [["invasion", T]]);
    assert.deepStrictEqual(run(snap({ claim: { hostile: false } }), { ...PARAMS, playerSov: null }), run(snap(), PARAMS));
  }));

  test("PST3 the siege limit counts an open invasion on the way (no siege row yet) and a LAUNCH of the same "
    + "review: 1 row + 1 pending = max 2 -> PLAYER_SOV_LIMIT", () => {
    const T2 = 24;
    const two = (o) => {
      const s = snap({ claim: {}, sieges: 1 });
      s.theatre.push(T2);
      s.systems.push(row(T2, null));
      s.intel.push(intelOf(T2, null));
      s.playerSov.set(T2, { hostile: true, ownerSeen: true, siegedByOther: false, siegedBySelf: false });
      return Object.assign(s, o);
    };
    const same = run(two({}), { ...ON, maxOperationsPerReview: 2 });
    assert.strictEqual(launches(same).length, 1, JSON.stringify(same.notes));
    assert.deepStrictEqual(psNotes(same), ["PLAYER_SOV_LIMIT"], JSON.stringify(same.notes));
    const op = { operationId: "op-t2", version: 1, state: "ACTIVE", operationType: "invasion", objective: "capture",
      originSystemId: BASE, targetSystemId: T2, dueAt: AT + HOUR, members: 1, orderedMembers: 1 };
    const flying = run(two({ operations: [op] }), ON);
    assert.deepStrictEqual([launches(flying), psNotes(flying)], [[], ["PLAYER_SOV_LIMIT"]], JSON.stringify(flying.notes));
    const raid = run(two({ operations: [{ ...op, operationType: "raid", objective: "raid" }] }), ON);
    assert.deepStrictEqual(launches(raid), [["invasion", T]], JSON.stringify(raid.notes));
  });

  needsDriver("PST4 wiring: startStrategy -> reviewService -> getPlayerSovSiege().listForReviewInTx "
    + "-> snapshot.playerSov / playerSovSieges on a migrated store", () => H.withStore(driver, async (reopen) => {
    const R = require("./review.test").harness;
    const { createManualClock } = require("../../lib/util/clock");
    const { createIdGenerator } = require("../../lib/util/ids");
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(59) }), graph: R.graphOf(),
      controllers: new Map() };
    const seen = { s: null };
    const hooks = { beforeEffect: (d, s) => {
      if (seen.s === null && d.factionId === R.SANSHA) seen.s = s;
      return d;
    } };
    const holder = { siege: null };
    const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PLAYER_SOV_ENABLED: "1" },
    { hooks, getPlayerSovSiege: () => holder.siege });
    const adapter = { playerStructures: { readOwnerFace: () => ({ ok: true, ceoId: 8, npc: false }),
      readOwnerActivity: () => ({ ok: true, onlineNow: true, lastSeenMs: R.START_MS }) },
    readCharacterStanding: () => ({ ok: true, standing: -10 }) };
    const repo = createPlayerSovRepository();
    holder.siege = createPlayerSovSiege({ journal: e.journal, getPlayerSov: () => ({ getRepository: () => repo }),
      clockRepo: createPlayerSovClockRepository(), adapter, getRegistry: () => ({ getFaction: () => ({ kind: "pirate" }) }),
      getPresence: () => null, config: e.config, ownerOnline: createOwnerOnline({ getPresence: () => null, adapter,
        config: e.config }) });
    const sys = R.THEATRE[0];
    e.tx((db) => repo.insertClaim(db, { systemId: sys, allianceId: 99000001, corpId: 98000001,
      hubItemId: 1700000001, origin: "MIRROR", state: "HELD", at: R.START_MS - HOUR }));
    await R.passesAt(e, shared, R.START_MS + R.I);
    e.strategy.stop("test");
    assert.ok(seen.s, "a Sansha review read its snapshot");
    assert.ok(seen.s.playerSov instanceof Map, "snapshot.playerSov");
    assert.deepStrictEqual([{ ...seen.s.playerSov.get(sys) }, seen.s.playerSovSieges],
      [{ hostile: true, ownerSeen: true, siegedByOther: false, siegedBySelf: false }, 0]);
  }));
};
