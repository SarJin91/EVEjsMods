"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createFleetRepository } = require("../../lib/fleets/fleetRepository");
const { startPlayerHunt } = require("../../lib/playerHunt");
const { patrolRoute, standoffPoint, campPoint } = require("../../lib/garrisonPatrol/policy");
const { createGarrisonStep, GARRISON_STEP_METHODS } = require("../../lib/materialization/garrisonStep");
const { createHuntStep } = require("../../lib/materialization/huntStep");
const { createPhysicalBudget } = require("../../lib/materialization/physicalBudget");
const { createLossTracker } = require("../../lib/materialization/lossTracker");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const SYS = 30001990;
const SYS2 = 30001991;
const PIRATE = 500019;
const KINDS = Object.freeze({ [PIRATE]: "pirate" });
const LIMITS = Object.freeze({ maxVirtualFleets: 50, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxFleetsPerOperation: 16, maxJsonBytes: 4096, maxListLimit: 500 });
const COMP3 = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);
const pos = (x) => ({ x, y: 0, z: 0 });
const SUN_RADIUS = 5e8;
const OBJECTS = Object.freeze([{ kind: "sun", itemId: 40000001, position: pos(0), radius: SUN_RADIUS },
  { kind: "station", itemId: 60000001, position: pos(1e10) },
  { kind: "stargate", itemId: 50000001, position: pos(2e10), toSystemId: SYS2 },
  { kind: "asteroidBelt", itemId: 40000002, position: pos(3e10) }]);
const FAR = pos(9e11);
const KINDS_ROUTE = ["sun", "stargate", "station"];
const pointOf = (o, G) => (o.kind === "stargate" ? campPoint(o, G.campStandoffMeters)
  : standoffPoint(o, G.objectClearanceMeters));

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-gs-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return fn(opened);
  } finally {
    if (store) store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function fakeWorld() {
  const w = { loaded: new Set([SYS]), npc: new Map(), players: [], aggressors: new Map(), calls: [], nextId: 7001,
    tracker: null, spawns: [], vendorOrders: new Map(), armFail: new Set(), armed: new Set() };
  const copy = (o) => ({ ...o, position: { ...o.position } });
  w.scene = {
    listSystemObjects(sys, kinds) {
      w.calls.push(["listSystemObjects", sys, [...kinds]]);
      return { ok: true, objects: OBJECTS.filter((o) => kinds.includes(o.kind)).map(copy) };
    },
    readPlayerShips(sys) {
      w.calls.push(["readPlayerShips", sys]);
      if (!w.loaded.has(sys)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, ships: w.players.filter((p) => p.systemId === sys && p.state === "space")
        .map((p) => ({ characterId: p.characterId, entityId: p.entityId, position: { ...p.position },
          inWarp: p.inWarp === true, cloaked: p.cloaked === true, jumpCloaked: p.jumpCloaked === true,
          capsule: p.capsule === true })) };
    },
    readShips(sys, ids) {
      w.calls.push(["readShips", sys]);
      return { ok: true, ships: ids.filter((id) => w.npc.has(id))
        .map((id) => ({ entityId: id, position: { ...w.npc.get(id).position }, inWarp: false,
          ...(w.vendorOrders.has(id) ? { vendorOrder: { ...w.vendorOrders.get(id) } } : {}) })) };
    },
    warpShips(sys, ids, point) {
      w.calls.push(["warpShips", [...ids], { ...point }]);
      for (const id of ids) if (w.npc.has(id)) w.npc.get(id).position = { ...point };
      return { ok: true, warped: ids.length, failed: [] };
    },
    setSearch(sys, ids) {
      w.calls.push(["setSearch", [...ids]]);
      return { ok: true, failed: [] };
    },
    attackTargets(sys, ids, targets, ...rest) {
      w.calls.push(["attackTargets", [...ids], [...targets],
        ...rest.map((o) => (o && o.capitalIds instanceof Set ? [...o.capitalIds] : o))]);
      for (const id of ids) {
        const lock = w.lockOrders === true ? { keepLock: true, allowWeapons: true } : {};
        if (w.vendorOrders.has(id)) w.vendorOrders.set(id, { attackTargetId: targets[0], weapons: true, ...lock });
      }
      return { ok: true, failed: [] };
    },
    readAggressors(sys, ids) {
      w.calls.push(["readAggressors", sys]);
      return { ok: true, aggressors: ids.filter((id) => w.aggressors.has(id)).map((id) => {
        const aggressorId = w.aggressors.get(id);
        const npc = w.npc.get(aggressorId);
        return { entityId: id, aggressorId, ...(npc ? { aggressorKind: "npc", aggressorFactionId: null,
          aggressorPosition: { ...npc.position }, aggressorInWarp: false } : {}) };
      }) };
    },
    armNpcCombat(sys, ids) {
      w.calls.push(["armNpcCombat", sys, [...ids]]);
      const failed = ids.filter((id) => w.armFail.has(id));
      const ok = ids.filter((id) => !w.armFail.has(id));
      const armed = ok.filter((id) => !w.armed.has(id));
      for (const id of ok) w.armed.add(id);
      return { ok: true, armed: armed.length, already: ok.length - armed.length, failed };
    },
  };
  w.npcSpawn = {
    resolveProfiles(reqs, o) {
      w.calls.push(["resolveProfiles", o.seedPrefix]);
      return { ok: true, profiles: reqs.map((r) => `p_${r.factionId}_${r.hullGroup}`) };
    },
    isSceneLoaded: (sys) => w.loaded.has(sys),
    spawnShip(sys, spec) {
      w.calls.push(["spawnShip"]);
      w.spawns.push(spec);
      const id = w.nextId;
      w.nextId += 1;
      w.npc.set(id, { systemId: sys, position: { ...spec.anchorDescriptor.position } });
      return { ok: true, entityId: id };
    },
    publish(sys, ids) {
      w.calls.push(["publish", [...ids]]);
      return { ok: true, published: ids.length, missing: 0 };
    },
    despawn(sys, ids) {
      w.calls.push(["despawn", [...ids]]);
      for (const id of ids) w.npc.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
  };
  w.kill = (id) => {
    w.npc.delete(id);
    w.tracker.note({ itemID: id }, { success: true });
  };
  w.player = (characterId, extra) => {
    const p = { characterId, entityId: 1000000 + characterId, systemId: SYS, state: "space", position: FAR,
      ...extra };
    w.players = w.players.filter((x) => x.characterId !== characterId).concat([p]);
    return p;
  };
  w.count = (name) => w.calls.filter((c) => c[0] === name).length;
  w.graph = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (id === SYS2
    ? { secClass: "lowsec", factionId: 500001 } : { secClass: "nullsec", factionId: null }) } }) };
  return w;
}

function baseConfig(gp, ph) {
  const c = JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  c.enabled = true;
  c.modules = { ...c.modules, fleets: { ...(c.modules && c.modules.fleets), enabled: true } };
  c.playerHunt = { ...c.playerHunt, enabled: false, ...(ph || {}) };
  c.garrisonPatrol = { ...c.garrisonPatrol, enabled: true, warpStartGraceMs: 0, maxCampsPerSystem: 0,
    ...(gp || {}) };
  return c;
}

function setup(opened, opts = {}) {
  const clock = createManualClock(START_MS);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const ids = createIdGenerator({ clock, rng: createRng(7) });
  const fleets = createFleetRepository({ journal, clock, ids, worldSeed: opened.worldSeed, limits: LIMITS });
  const config = baseConfig(opts.gp, opts.ph);
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const w = fakeWorld();
  const startPh = () => {
    const r = startPlayerHunt({ config, persistence, clock, getFleets: () => ({ repository: fleets }), logger });
    assert.ok(r.ok, JSON.stringify(r));
    return r.playerHunt;
  };
  const env = { clock, fleets, config, lines, w, standings: new Map(), ph: startPh(), hooks: {}, txCount: 0,
    seamCalls: 0, crews: opts.crews || null };
  const store = { transaction: (name, fn) => {
    env.txCount += 1;
    return opened.store.transaction(name, fn);
  } };
  const makeStep = () => {
    const tracker = createLossTracker({ maxPending: 40 });
    w.tracker = tracker;
    env.budget = createPhysicalBudget({ limits: { perSystem: 20, global: 40 }, clock });
    env.step = createGarrisonStep({ store, clock, npcSpawn: w.npcSpawn, budget: env.budget,
      settings: config.garrisonPatrol, huntSettings: config.playerHunt, maxRetargetsPerPass: 64,
      getPlayerHunt: () => env.ph, getFactionKind: (f) => KINDS[f] || null,
      getFleets: () => ({ repository: fleets }), getGraph: () => w.graph,
      getHuntScene: () => {
        env.seamCalls += 1;
        return w.scene;
      },
      readStanding: (c, f) => ({ ok: true, standing: env.standings.get(`${c}:${f}`) || 0 }),
      lossTracker: tracker, lossImportOn: true,
      despawnAll: (sys, list) => (list.length > 0 ? w.npcSpawn.despawn(sys, list) : null),
      admits: () => true, excludedFactionIds: [500018], worldSeed: opened.worldSeed,
      getCrews: () => env.crews, logger, hooks: env.hooks, ...(opts.deps || {}) });
  };
  makeStep();
  env.restart = () => {
    clock.advance(1);
    env.ph.stop();
    env.ph = startPh();
    w.npc.clear();
    makeStep();
  };
  env.presence = {
    observedSystems: () => [...new Set(w.players.map((p) => p.systemId))].sort((a, b) => a - b),
    getSystemPresence: (id) => {
      const chars = w.players.filter((p) => p.systemId === id).map((p) => ({ characterId: p.characterId,
        state: p.state }));
      if (chars.length === 0) return null;
      return { systemId: id, space: chars.filter((c) => c.state === "space").length,
        docked: chars.filter((c) => c.state === "docked").length, characters: chars };
    },
  };
  env.pass = (dt = 0) => {
    clock.advance(dt);
    const now = clock.now();
    const out = { refused: {} };
    env.step.stepPending(now, out);
    out.aborted = env.step.step(now, env.presence, out, 64).aborted;
    return out;
  };
  env.tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  env.fleet = (fleetId) => env.tx((db) => fleets.getFleet(db, fleetId)).fleet;
  env.newFleet = (key, extra = {}) => {
    const r = env.tx((db) => fleets.createFleet(db, { factionId: PIRATE, currentSystemId: SYS, homeSystemId: SYS,
      fleetRole: "garrison", composition: COMP3, ...extra }, key));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    return r.fleetId;
  };
  env.rows = () => env.tx((db) => db.prepare("SELECT hunt_id, fleet_id, state, end_reason, character_id, seed, mode "
    + "FROM world_player_hunts ORDER BY started_at, hunt_id").all());
  env.counters = () => env.step.getStatus().counters;
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("GS1 garrison patrol: a player in space for startDelayMs -> PATROL LIVE (hunts off), fleet MATERIALIZED, "
    + "spawn outside the sun, warp to the next object after objectDwellMs, a hostile on grid -> attackTargets", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      const G = env.config.garrisonPatrol;
      const fleetId = env.newFleet("gs1");
      const player = env.w.player(101, { position: pos(0) });
      env.pass(0);
      assert.deepStrictEqual(env.rows(), [], "before startDelayMs: no patrol");
      env.pass(G.startDelayMs);
      const [row] = env.rows();
      assert.deepStrictEqual([row.mode, row.state, row.character_id], ["PATROL", "LIVE", 101]);
      assert.strictEqual(env.fleet(fleetId).state, "MATERIALIZED");
      const spawn = env.w.spawns[0];
      assert.deepStrictEqual([spawn.anchorDescriptor, spawn.behavior, spawn.keepMaterialized, spawn.ownerId],
        [{ kind: "coordinates", position: pos(SUN_RADIUS + G.objectClearanceMeters) }, "search", true, undefined]);
      assert.ok(spawn.anchorDescriptor.position.x > SUN_RADIUS, "outside the sun");
      assert.strictEqual(env.w.spawns.length, 3);
      assert.strictEqual(env.counters().crewFallback, 1, "no crews -> fallback");
      assert.deepStrictEqual(env.budget.getStatus().reservedByOwnerKind, { fleet: 3 });
      const route = patrolRoute(OBJECTS, KINDS_ROUTE, row.seed);
      assert.strictEqual(route[0].kind, "sun");
      env.pass(G.objectDwellMs - 1);
      assert.strictEqual(env.w.count("warpShips"), 0, "before objectDwellMs: no warp");
      env.pass(1);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "warpShips").map((c) => c[2]),
        [pointOf(route[1], G)]);
      player.position = { ...pointOf(route[1], G) };
      env.pass(1000);
      const attacks = env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => c[2][0]);
      assert.deepStrictEqual(attacks, [player.entityId, player.entityId, player.entityId]);
      assert.strictEqual(env.step.getStatus().list[0].phase, "ENGAGED");
      assert.deepStrictEqual([env.counters().started, env.counters().startedPatrol, env.counters().engaged], [1, 1, 1]);
    });
  });

  needsDriver("CMN2: a garrison patrol with a titan - its attack order carries "
    + "capitalIds [titan] (no chase / orbit of a subcap), a subcap keeps the 3-argument call", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { startDelayMs: 0 } });
      env.newFleet("cmn2", { composition: [{ hullGroup: "cruiser", count: 2 },
        { hullGroup: "titan", typeId: 42241, count: 1 }] });
      const player = env.w.player(101);
      env.pass(0);
      const ships = [...env.w.npc.keys()];
      assert.strictEqual(ships.length, 3);
      const titan = ships[env.w.spawns.findIndex((s) => s.profileId === `p_${PIRATE}_titan`)];
      assert.ok(titan !== undefined, JSON.stringify(env.w.spawns.map((s) => s.profileId)));
      player.position = { ...env.w.npc.get(ships[0]).position };
      env.pass(1000);
      const attacks = env.w.calls.filter((c) => c[0] === "attackTargets");
      assert.deepStrictEqual(attacks.map((c) => c.slice(1)), ships.map((s) => (s === titan
        ? [[s], [player.entityId], [titan]] : [[s], [player.entityId]])));
    });
  });

  needsDriver("GSB1 garrison patrol (copy of huntStep): a dropped attack order is given again once "
    + "(orderLost), no churn while the vendor holds it; addLiveLosses per fleet", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { startDelayMs: 0 } });
      const fleetId = env.newFleet("gsb1");
      const player = env.w.player(101);
      env.pass(0);
      const ships = [...env.w.npc.keys()];
      assert.strictEqual(ships.length, 3);
      for (const s of ships) env.w.vendorOrders.set(s, { attackTargetId: 0, weapons: false });
      player.position = { ...env.w.npc.get(ships[0]).position };
      env.pass(1000);
      const attacks = () => env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => [c[1][0], c[2][0]]);
      assert.deepStrictEqual(attacks(), ships.map((s) => [s, player.entityId]));
      env.pass(1000);
      assert.strictEqual(attacks().length, 3, "the vendor holds the orders");
      env.w.vendorOrders.set(ships[2], { attackTargetId: 0, weapons: true });
      env.pass(1000);
      assert.deepStrictEqual(attacks().slice(3), [[ships[2], player.entityId]]);
      assert.strictEqual(env.counters().orderLost, 1);
      env.pass(1000);
      assert.strictEqual(attacks().length, 4, "no churn");
      env.w.kill(ships[0]);
      env.pass(1000);
      assert.deepStrictEqual([...env.step.addLiveLosses(new Map())], [[fleetId, 1]]);
    });
  });

  needsDriver("GSL1: with attackLockOn an attack order the vendor holds without keepLock "
    + "allowWeapons is lost and given again; with the lock fields no churn (flag off: GSB1)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { startDelayMs: 0 }, deps: { attackLockOn: true } });
      env.newFleet("gsl1");
      const player = env.w.player(101);
      env.pass(0);
      const ships = [...env.w.npc.keys()];
      assert.strictEqual(ships.length, 3);
      for (const s of ships) env.w.vendorOrders.set(s, { attackTargetId: 0, weapons: false });
      player.position = { ...env.w.npc.get(ships[0]).position };
      env.pass(1000);
      assert.strictEqual(env.w.count("attackTargets"), 3);
      env.pass(1000);
      assert.deepStrictEqual([env.counters().orderLost, env.w.count("attackTargets")], [3, 6], "no lock -> lost");
      assert.ok(env.lines.some((l) => l.includes(":lock=false")), env.lines.join("\n"));
      env.w.lockOrders = true;
      env.pass(1000);
      assert.deepStrictEqual([env.counters().orderLost, env.w.count("attackTargets")], [6, 9]);
      env.pass(1000);
      env.pass(1000);
      assert.deepStrictEqual([env.counters().orderLost, env.w.count("attackTargets")], [6, 9], "locked: no churn");
    });
  });

  needsDriver("GCE1: a GATE_CAMP orders the attack on a hostile player in the jump cloak "
    + "another cloak, warp, capsule, a PATROL and the flag off not; a dropped order on the cloaked player is given "
    + "again at the next pass without orderLost", () => {
    const run = (gp, extra, after) => {
      let out = null;
      withStore(driver, (opened) => {
        const env = setup(opened, { gp: { startDelayMs: 0, maxCampsPerSystem: 1, campPermilleByKind: "pirate:1000",
          ...gp } });
        env.newFleet("gce1");
        const player = env.w.player(101);
        env.pass(0);
        const ships = [...env.w.npc.keys()];
        for (const s of ships) env.w.vendorOrders.set(s, { attackTargetId: 0, weapons: false });
        Object.assign(player, extra, { position: { ...env.w.npc.get(ships[0]).position } });
        env.pass(1000);
        out = { mode: env.rows()[0].mode, attacks: env.w.count("attackTargets") };
        if (after) after(env, ships);
      });
      return out;
    };
    const jump = { cloaked: true, jumpCloaked: true };
    assert.deepStrictEqual(run({}, jump, (env, ships) => {
      for (const s of ships) env.w.vendorOrders.set(s, { attackTargetId: 0, weapons: true });
      env.pass(1000);
      assert.deepStrictEqual([env.counters().orderLost, env.w.count("attackTargets")], [0, 6]);
      assert.ok(!env.lines.some((l) => l.includes("order lost")), env.lines.join("\n"));
      env.pass(1000);
      assert.strictEqual(env.w.count("attackTargets"), 6, "the vendor holds the orders: no churn");
    }), { mode: "GATE_CAMP", attacks: 3 });
    assert.deepStrictEqual(run({}, { cloaked: true }), { mode: "GATE_CAMP", attacks: 0 }, "another cloak");
    assert.deepStrictEqual(run({}, { ...jump, inWarp: true }), { mode: "GATE_CAMP", attacks: 0 }, "warp");
    assert.deepStrictEqual(run({}, { ...jump, capsule: true }), { mode: "GATE_CAMP", attacks: 0 }, "capsule");
    assert.deepStrictEqual(run({ campCloakOrderEnabled: false }, jump), { mode: "GATE_CAMP", attacks: 0 }, "flag off");
    assert.deepStrictEqual(run({ maxCampsPerSystem: 0 }, jump), { mode: "PATROL", attacks: 0 }, "patrol");
    assert.deepStrictEqual(run({ maxCampsPerSystem: 0 }, {}), { mode: "PATROL", attacks: 3 }, "patrol, no cloak");
  });

  needsDriver("GS2 garrison patrol losses once: killmail -> markDestroyedInTx, exitGraceMs -> UNOBSERVED, fleet IDLE "
    + "with ship_count - 1, a second endInTx is a duplicate; crews owner on the spawn and the loss in the end tx", () => {
    withStore(driver, (opened) => {
      const crewCalls = [];
      const crews = { getStatus: () => ({ state: "running" }),
        seatsForMaterializationInTx: (db, req) => ({ ok: true, unmatched: 0, seats: req.members.map((m, i) => ({
          memberKey: m.memberKey, characterId: 9000 + i, ownerId: 98000001 })) }),
        recordLiveLossInTx: (db, req, key) => {
          crewCalls.push([db.inTransaction === true, req.fleetId, req.characterIds, key]);
          return { ok: true, duplicate: false, lost: req.characterIds.length };
        } };
      const env = setup(opened, { gp: { startDelayMs: 0 }, crews });
      const G = env.config.garrisonPatrol;
      const fleetId = env.newFleet("gs2");
      env.w.player(101);
      env.pass(0);
      const [row] = env.rows();
      assert.strictEqual(row.state, "LIVE");
      assert.ok(env.w.spawns.every((s) => s.ownerId === 98000001), "The owner of the crew seat");
      const ships = [...env.w.npc.keys()];
      env.w.kill(ships[0]);
      env.pass(1000);
      assert.strictEqual(env.counters().lossImported, 1);
      env.w.players = [];
      env.pass(1000);
      env.pass(G.exitGraceMs - 1);
      assert.strictEqual(env.rows()[0].state, "LIVE", "before exitGraceMs: no end");
      env.pass(1);
      const ended = env.rows()[0];
      assert.deepStrictEqual([ended.state, ended.end_reason], ["ENDED", "UNOBSERVED"]);
      const fleet = env.fleet(fleetId);
      assert.deepStrictEqual([fleet.state, fleet.shipCount, fleet.fleetRole], ["IDLE", 2, "garrison"]);
      assert.deepStrictEqual(crewCalls, [[true, fleetId, [9000], `${row.hunt_id}:liveLoss:v1`]]);
      assert.deepStrictEqual(env.w.npc.size, 0, "despawned");
      assert.strictEqual(env.budget.getStatus().reservedShips, 0);
      const again = env.tx((db) => env.ph.endInTx(db, { huntId: row.hunt_id, at: env.clock.now(),
        reason: "UNOBSERVED" }));
      assert.strictEqual(again.duplicate, true);
      assert.strictEqual(env.fleet(fleetId).shipCount, 2, "no second applyLosses");
    });
  });

  needsDriver("GS3 garrison patrol restart: a LIVE row of a previous boot ends RESTART (playerHunt.enabled false), the "
    + "fleet IDLE, a new patrol with another huntId; a throw after tx A -> stepPending rollback SPAWN_FAILED", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { startDelayMs: 0 } });
      const fleetId = env.newFleet("gs3");
      env.w.player(101);
      env.pass(0);
      const first = env.rows()[0].hunt_id;
      env.restart();
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "RESTART"]]);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
      assert.deepStrictEqual(env.step.getStatus().list, [], "no entry of the previous boot");
      env.pass(0);
      const rows = env.rows();
      assert.strictEqual(rows.length, 2);
      assert.notStrictEqual(rows[1].hunt_id, first);
      assert.strictEqual(rows[1].state, "LIVE");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { startDelayMs: 0 } });
      const fleetId = env.newFleet("gs3-hook");
      env.w.player(101);
      env.hooks.afterPatrolClaim = () => false;
      assert.strictEqual(env.pass(0).aborted, true);
      assert.strictEqual(env.rows()[0].state, "CLAIMED");
      assert.strictEqual(env.budget.getStatus().reservedShips, 3);
      delete env.hooks.afterPatrolClaim;
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "SPAWN_FAILED"]]);
      assert.strictEqual(env.budget.getStatus().reservedShips, 0, "no orphan in the budget");
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
      assert.strictEqual(env.w.count("spawnShip"), 0);
    });
  });

  needsDriver("GS4 no double spawn: the hunt step does not take a patrolling fleet, two passes claim once; "
    + "maxCampsPerSystem 1 with two pirate fleets -> 1 GATE_CAMP at campPoint + 1 PATROL", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { startDelayMs: 0, maxCampsPerSystem: 1, maxNewPerPass: 2,
        campPermilleByKind: "pirate:1000" }, ph: { enabled: true, roles: "garrison", noticeDelayMs: 0 } });
      const G = env.config.garrisonPatrol;
      env.newFleet("gs4-a");
      env.newFleet("gs4-b");
      env.w.player(101);
      env.pass(0);
      const rows = env.rows();
      assert.deepStrictEqual(rows.map((r) => r.mode).sort(), ["GATE_CAMP", "PATROL"]);
      const gate = OBJECTS.find((o) => o.kind === "stargate");
      assert.ok(env.w.spawns.some((s) => JSON.stringify(s.anchorDescriptor.position)
        === JSON.stringify(campPoint(gate, G.campStandoffMeters))), "the camp spawns at campPoint");
      const hunt = createHuntStep({ store: opened.store, clock: env.clock, npcSpawn: env.w.npcSpawn,
        budget: env.budget, settings: env.config.playerHunt, maxRetargetsPerPass: 64, getPlayerHunt: () => env.ph,
        getFactionKind: (f) => KINDS[f] || null, getFleets: () => ({ repository: env.fleets }),
        getHuntScene: () => env.w.scene, readStanding: () => ({ ok: true, standing: -10 }),
        lossTracker: createLossTracker({ maxPending: 40 }), lossImportOn: true, despawnAll: () => null,
        admits: () => true, excludedFactionIds: [500018] });
      hunt.step(env.clock.now(), env.presence, { refused: {} }, 64);
      assert.strictEqual(hunt.getStatus().counters.refusedNoCandidate, 1);
      env.pass(G.scanIntervalMs);
      assert.strictEqual(env.rows().length, 2, "no second claim");
      assert.strictEqual(env.counters().started, 2);
      assert.deepStrictEqual([env.counters().startedCamp, env.counters().startedPatrol], [1, 1]);
    });
  });

  needsDriver("GS5 garrisonPatrol.enabled false: zero adapter calls, zero transactions; the methods of the real "
    + "facade", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { enabled: false, startDelayMs: 0 } });
      env.newFleet("gs5");
      env.w.player(101);
      for (let i = 0; i < 3; i += 1) env.pass(20000);
      assert.deepStrictEqual([env.w.calls, env.txCount, env.seamCalls, env.rows()], [[], 0, 0, []]);
      assert.deepStrictEqual(Object.keys(env.step), [...GARRISON_STEP_METHODS]);
      assert.strictEqual(env.step.getStatus().enabled, false);
    });
  });

  needsDriver("GFS1: a garrison fleet away from home in a system its faction does not own -> no "
    + "patrol (refusedForeignSystem); the same fleet in a system of its faction (SDE) -> PATROL as before", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      const G = env.config.garrisonPatrol;
      const fleetId = env.newFleet("gfs1-a", { homeSystemId: SYS2 });
      env.w.player(101);
      env.pass(0);
      env.pass(G.startDelayMs);
      assert.deepStrictEqual(env.rows(), []);
      assert.deepStrictEqual([env.counters().refusedForeignSystem, env.counters().started, env.w.spawns.length],
        [1, 0, 0]);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      const G = env.config.garrisonPatrol;
      env.w.graph = { getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec",
        factionId: PIRATE }) } }) };
      const fleetId = env.newFleet("gfs1-b", { homeSystemId: SYS2 });
      env.w.player(101);
      env.pass(0);
      env.pass(G.startDelayMs);
      assert.deepStrictEqual(env.rows().map((r) => [r.fleet_id, r.mode, r.state]), [[fleetId, "PATROL", "LIVE"]]);
      assert.deepStrictEqual([env.counters().refusedForeignSystem, env.counters().started], [0, 1]);
    });
  });

  needsDriver("GSR1: PATROL spawns at the route object nearest the player (a gate = its "
    + "campPoint on the sun side), default objectKinds without belts; maxRouteObjects trims the rotated route", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { startDelayMs: 0 } });
      const G = env.config.garrisonPatrol;
      assert.deepStrictEqual([G.objectKinds, G.maxRouteObjects], ["sun,stargate,station", 8]);
      env.newFleet("gsr1-a");
      env.w.player(101);
      env.pass(0);
      const gate = OBJECTS.find((o) => o.kind === "stargate");
      assert.deepStrictEqual(env.w.spawns.map((s) => s.anchorDescriptor.position),
        [0, 1, 2].map(() => campPoint(gate, G.campStandoffMeters)));
      assert.deepStrictEqual(env.step.getStatus().list.map((x) => [x.mode, x.objects]), [["PATROL", 3]]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { gp: { startDelayMs: 0, maxRouteObjects: 2 } });
      const G = env.config.garrisonPatrol;
      env.newFleet("gsr1-b");
      const station = OBJECTS.find((o) => o.kind === "station");
      env.w.player(101, { position: { ...station.position } });
      env.pass(0);
      assert.deepStrictEqual(env.w.spawns[0].anchorDescriptor.position,
        standoffPoint(station, G.objectClearanceMeters));
      assert.deepStrictEqual(env.step.getStatus().list.map((x) => x.objects), [2]);
    });
  });

  const ENEMY = 500010;
  const ALLY = 500011;
  const E1 = 8001;
  const E2 = 8002;
  const A1 = 8003;
  const O1 = 8004;
  const B1 = 8005;

  function lneScene(opened, { own = true, gp = {}, deps = true } = {}) {
    const lne = { groups: [], calls: 0 };
    const env = setup(opened, { gp: { startDelayMs: 0, ...gp }, deps: deps ? {
      getLneGroups: () => {
        lne.calls += 1;
        return lne.groups;
      },
      isFactionEnemy: (f, g) => f === PIRATE && g === ENEMY } : {} });
    env.lne = lne;
    if (own) {
      env.w.graph = { getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec",
        factionId: PIRATE }) } }) };
    }
    env.newFleet("gl");
    env.player = env.w.player(101);
    env.pass(0);
    env.ships = [...env.w.npc.keys()];
    assert.strictEqual(env.ships.length, 3);
    const lead = env.w.npc.get(env.ships[0]).position;
    const near = (dx) => ({ systemId: SYS, position: { x: lead.x + dx, y: 0, z: 0 } });
    for (const [id, dx] of [[E1, 1000], [A1, 2000], [O1, 3000], [B1, 4000]]) env.w.npc.set(id, near(dx));
    env.w.npc.set(E2, { systemId: SYS, position: pos(8e11) });
    lne.groups = [{ systemId: SYS, factionId: ENEMY, entityIds: [E1, E2], source: "hunt", groupId: "h1" },
      { systemId: SYS, factionId: ALLY, entityIds: [A1], source: "hunt", groupId: "h2" },
      { systemId: SYS, factionId: PIRATE, entityIds: [O1], source: "patrol", groupId: "p1" },
      { systemId: SYS, factionId: ENEMY, entityIds: [B1], source: "battle", groupId: null }];
    env.attacks = () => env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => [c[1][0], c[2][0]]);
    env.arms = () => env.w.calls.filter((c) => c[0] === "armNpcCombat").map((c) => c[2]);
    return env;
  }

  needsDriver("GL1 gem: a patrol in a system of its faction targets the enemy LNE ship on the grid of the "
    + "lead (armed with the own ships first), not the off-grid one, the ally, the own faction or a battle ship", () => {
    withStore(driver, (opened) => {
      const env = lneScene(opened);
      env.pass(1000);
      assert.deepStrictEqual(env.arms(), [[...env.ships, E1]]);
      assert.deepStrictEqual(env.attacks(), env.ships.map((s) => [s, E1]));
      assert.strictEqual(env.step.getStatus().list[0].phase, "ENGAGED");
      assert.deepStrictEqual([env.counters().lneArmed, env.counters().lneTargeted, env.counters().lneArmFailed],
        [4, 1, 0]);
      env.pass(1000);
      assert.strictEqual(env.arms().length, 1, "armed ids are not armed again");
      assert.strictEqual(env.counters().lneTargeted, 1, "first time only");
      assert.strictEqual(env.lne.calls, 3, "one getLneGroups per pass");
    });
  });

  needsDriver("GL2 gem: outside a system of its faction an enemy LNE ship on grid is no target; as an npc "
    + "aggressor of a patrol ship it is the target of this pass (lneRetaliated)", () => {
    withStore(driver, (opened) => {
      const env = lneScene(opened, { own: false });
      env.pass(1000);
      assert.deepStrictEqual([env.arms(), env.attacks()], [[], []]);
      env.w.aggressors.set(env.ships[0], E1);
      env.pass(1000);
      assert.deepStrictEqual(env.arms(), [[...env.ships, E1]]);
      assert.deepStrictEqual(env.attacks(), env.ships.map((s) => [s, E1]));
      assert.deepStrictEqual([env.counters().lneRetaliated, env.counters().retaliated], [1, 1]);
    });
  });

  needsDriver("GL3 gem: a target in failed of armNpcCombat gets no order (lneArmFailed), a failed own ship "
    + "still attacks the player; lneArmMaxPerPass 0 -> no LNE target (lneArmDeferred), the player target unchanged", () => {
    withStore(driver, (opened) => {
      const env = lneScene(opened);
      env.player.position = { ...env.w.npc.get(env.ships[0]).position };
      env.w.armFail = new Set([E1, env.ships[2]]);
      env.pass(1000);
      assert.deepStrictEqual(env.arms(), [[...env.ships, E1]]);
      assert.deepStrictEqual(env.attacks(), env.ships.map((s) => [s, env.player.entityId]));
      assert.deepStrictEqual([env.counters().lneArmFailed, env.counters().lneArmed], [1, 2]);
    });
    withStore(driver, (opened) => {
      const env = lneScene(opened, { gp: { lneArmMaxPerPass: 0 } });
      env.player.position = { ...env.w.npc.get(env.ships[0]).position };
      env.pass(1000);
      assert.deepStrictEqual(env.arms(), []);
      assert.deepStrictEqual(env.attacks(), env.ships.map((s) => [s, env.player.entityId]));
      assert.deepStrictEqual([env.counters().lneArmDeferred, env.counters().lneTargeted], [1, 0]);
    });
  });

  needsDriver("GL4 gem: lneTargetsEnabled false or no getLneGroups -> zero getLneGroups and armNpcCombat calls "
    + "relationGroups() carries groupId = huntId", () => {
    withStore(driver, (opened) => {
      const env = lneScene(opened, { gp: { lneTargetsEnabled: false } });
      env.pass(1000);
      assert.deepStrictEqual([env.lne.calls, env.arms(), env.attacks()], [0, [], []]);
      const [g] = env.step.relationGroups();
      assert.strictEqual(g.groupId, env.step.getStatus().list[0].huntId);
    });
    withStore(driver, (opened) => {
      const env = lneScene(opened, { deps: false });
      env.pass(1000);
      assert.deepStrictEqual([env.lne.calls, env.arms(), env.attacks()], [0, [], []]);
    });
  });
};

module.exports.helpers = { loadDriver, withStore, setup, PIRATE, SYS, pos };
