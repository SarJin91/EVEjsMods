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
const { campPoint } = require("../../lib/garrisonPatrol/policy");
const { TRIGGER_LNE } = require("../../lib/garrisonPatrol/schema");
const { createGarrisonStep, COUNTER_NAMES, GARRISON_STEP_METHODS } = require("../../lib/materialization/garrisonStep");
const { createPhysicalBudget } = require("../../lib/materialization/physicalBudget");
const { createLossTracker } = require("../../lib/materialization/lossTracker");
const { startWorld, createUnavailableWorld } = require("../../lib/world");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const SYS = 30001990;
const SYS2 = 30001991;
const PIRATE = 500019;
const EMPIRE = 500001;
const POLICE = 500006;
const KINDS = Object.freeze({ [PIRATE]: "pirate", [EMPIRE]: "empire", [POLICE]: "police" });
const LIMITS = Object.freeze({ maxVirtualFleets: 50, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxFleetsPerOperation: 16, maxJsonBytes: 4096, maxListLimit: 500 });
const pos = (x) => ({ x, y: 0, z: 0 });
const GATE = Object.freeze({ kind: "stargate", itemId: 50000001, position: pos(2e10), toSystemId: SYS2 });
const OBJECTS = Object.freeze([{ kind: "sun", itemId: 40000001, position: pos(0), radius: 5e8 },
  { kind: "station", itemId: 60000001, position: pos(1e10) }, GATE,
  { kind: "asteroidBelt", itemId: 40000002, position: pos(3e10) }]);
const AT_GATE = pos(2e10 - 3000);
const FAR_FROM_GATES = pos(2e10 - 400000);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-gd-"));
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
  const w = { npc: new Map(), players: [], calls: [], nextId: 7001, spawns: [], noProfile: new Set() };
  const copy = (o) => ({ ...o, position: { ...o.position } });
  w.scene = {
    listSystemObjects(sys, kinds) {
      w.calls.push(["listSystemObjects", sys, [...kinds]]);
      return { ok: true, objects: OBJECTS.filter((o) => kinds.includes(o.kind)).map(copy) };
    },
    readPlayerShips(sys) {
      w.calls.push(["readPlayerShips", sys]);
      return { ok: true, ships: w.players.filter((p) => p.systemId === sys && p.state === "space")
        .map((p) => ({ characterId: p.characterId, entityId: p.entityId, position: { ...p.position }, inWarp: false,
          cloaked: false, capsule: false, warpTarget: p.warpTarget ? { ...p.warpTarget } : null,
          warpTargetEntityId: p.warpTargetEntityId || null })) };
    },
    readShips(sys, ids) {
      w.calls.push(["readShips", sys]);
      return { ok: true, ships: ids.filter((id) => w.npc.has(id))
        .map((id) => ({ entityId: id, position: { ...w.npc.get(id).position }, inWarp: false })) };
    },
    warpShips(sys, ids) {
      w.calls.push(["warpShips", [...ids]]);
      return { ok: true, warped: ids.length, failed: [] };
    },
    setSearch(sys, ids) {
      w.calls.push(["setSearch", [...ids]]);
      return { ok: true, failed: [] };
    },
    attackTargets(sys, ids, targets) {
      w.calls.push(["attackTargets", [...ids], [...targets]]);
      return { ok: true, failed: [] };
    },
    readAggressors(sys) {
      w.calls.push(["readAggressors", sys]);
      return { ok: true, aggressors: [] };
    },
  };
  w.npcSpawn = {
    resolveProfiles(reqs, o) {
      w.calls.push(["resolveProfiles", o.seedPrefix]);
      if ([...w.noProfile].some((id) => o.seedPrefix.includes(`${id}:`))) return { ok: false, reason: "NO_PROFILE" };
      return { ok: true, profiles: reqs.map((r) => `p_${r.factionId}_${r.hullGroup}`) };
    },
    isSceneLoaded: (sys) => sys === SYS,
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
  w.player = (characterId, position) => {
    const p = { characterId, entityId: 1000000 + characterId, systemId: SYS, state: "space", position };
    w.players = w.players.filter((x) => x.characterId !== characterId).concat([p]);
    return p;
  };
  w.graph = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (id === SYS2
    ? { secClass: "lowsec", factionId: EMPIRE } : { secClass: "nullsec", factionId: null }) } }) };
  return w;
}

function baseConfig(gp) {
  const c = JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  c.enabled = true;
  c.modules = { ...c.modules, fleets: { ...(c.modules && c.modules.fleets), enabled: true } };
  c.playerHunt = { ...c.playerHunt, enabled: false };
  c.garrisonPatrol = { ...c.garrisonPatrol, enabled: true, warpStartGraceMs: 0, maxCampsPerSystem: 0,
    maxPerSystem: 4, ...(gp || {}) };
  return c;
}

function setup(opened, gp, extraDeps) {
  const clock = createManualClock(START_MS);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const ids = createIdGenerator({ clock, rng: createRng(7) });
  const fleets = createFleetRepository({ journal, clock, ids, worldSeed: opened.worldSeed, limits: LIMITS });
  const config = baseConfig(gp);
  const lines = [];
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const w = fakeWorld();
  const started = startPlayerHunt({ config, persistence, clock, getFleets: () => ({ repository: fleets }),
    logger: { log: () => {} } });
  assert.ok(started.ok, JSON.stringify(started));
  const claims = [];
  const ph = { ...started.playerHunt, claimInTx: (db, req) => {
    claims.push({ ...req });
    return started.playerHunt.claimInTx(db, req);
  }, approachInTx: (db, req) => (typeof env.approach === "function" ? env.approach(db, req)
    : started.playerHunt.approachInTx(db, req)) };
  const env = { clock, fleets, config, lines, w, claims, standings: new Map(), admit: { LIVE: true, OPERATIONAL: false },
    controller: PIRATE };
  const tracker = createLossTracker({ maxPending: 40 });
  env.budget = createPhysicalBudget({ limits: { perSystem: 20, global: 40 }, clock });
  env.step = createGarrisonStep({ store: opened.store, clock, npcSpawn: w.npcSpawn, budget: env.budget,
    settings: config.garrisonPatrol, huntSettings: config.playerHunt, maxRetargetsPerPass: 64,
    getPlayerHunt: () => ph, getFactionKind: (f) => KINDS[f] || null,
    getFleets: () => ({ repository: fleets }), getGraph: () => w.graph, getHuntScene: () => w.scene,
    getWorld: () => ({ getControlState: (id) => (env.controlFails ? { ok: false, reason: "WORLD_READ_FAILED" }
      : { ok: true, system: { systemId: id, controllerFactionId: env.controller } }) }),
    readStanding: (c, f) => ({ ok: true, standing: env.standings.has(`${c}:${f}`) ? env.standings.get(`${c}:${f}`)
      : -10 }),
    lossTracker: tracker, lossImportOn: true,
    despawnAll: (sys, list) => (list.length > 0 ? w.npcSpawn.despawn(sys, list) : null),
    admits: (wc) => env.admit[wc] === true, excludedFactionIds: [500018], worldSeed: opened.worldSeed,
    logger: { log: (l) => lines.push(l) },
    ...(typeof extraDeps === "function" ? extraDeps(fleets) : extraDeps || {}) });
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
    env.step.step(now, env.presence, out, 64);
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
      fleetRole: "garrison", composition: [{ hullGroup: "cruiser", count: 3 }], ...extra }, key));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    return r.fleetId;
  };
  env.stagedFleet = (key, operationType, objective, extra = {}) => {
    const fleetId = env.newFleet(key, { homeSystemId: SYS2, ...extra });
    const op = env.tx((db) => fleets.createOperation(db, { operationType, factionId: PIRATE, originSystemId: SYS2,
      targetSystemId: SYS, objective, dueAt: START_MS + 7200000, fleets: [{ fleetId, expectedVersion: 1 }] },
    `${key}:op`));
    assert.ok(op.ok, JSON.stringify(op));
    assert.ok(env.tx((db) => fleets.transitionOperation(db, { operationId: op.operationId, expectedVersion: 1,
      from: "PLANNED", to: "ACTIVE" }, `${key}:active`)).ok);
    const planned = env.fleet(fleetId);
    assert.ok(env.tx((db) => fleets.transition(db, { fleetId, expectedVersion: planned.version, from: "PLANNED",
      to: "STAGED" }, `${key}:stage`)).ok);
    return fleetId;
  };
  env.rows = () => env.tx((db) => db.prepare("SELECT hunt_id, fleet_id, state, mode, character_id FROM "
    + "world_player_hunts ORDER BY started_at, hunt_id").all());
  env.counters = () => env.step.getStatus().counters;
  return env;
}

const pick = (c, names) => names.map((n) => c[n]);

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("GDF2 gate defense T2: an arrival 3 km from the gate of a PIRATE system -> GATE_CAMP claim (STAGED patrol "
    + "fleet unstaged first, shipCount desc) at campPoint, governor OPERATIONAL off; defenseFleetsPerGate 2 -> the "
    + "second fleet at the next pass, not the third; a later arrival -> defenseGateFull", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { defenseFleetsPerGate: 2 });
      const G = env.config.garrisonPatrol;
      const staged = env.stagedFleet("gd2-s", "patrol", "patrol", { composition: [{ hullGroup: "cruiser", count: 5 }] });
      const idleA = env.newFleet("gd2-a");
      const idleB = env.newFleet("gd2-b");
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      assert.deepStrictEqual(env.claims.map((c) => [c.fleetId, c.mode, c.unstage]), [[staged, "GATE_CAMP", true]]);
      assert.deepStrictEqual(env.rows().map((r) => [r.mode, r.state, r.character_id]), [["GATE_CAMP", "LIVE", 101]]);
      const point = campPoint(GATE, G.campStandoffMeters);
      assert.ok(env.w.spawns.length === 5 && env.w.spawns.every((s) => JSON.stringify(s.anchorDescriptor.position)
        === JSON.stringify(point)), "the defense spawns at campPoint of the arrival gate");
      assert.strictEqual(env.fleet(staged).state, "MATERIALIZED");
      assert.strictEqual(env.fleet(staged).operationId, null);
      const [entry] = env.step.getStatus().list;
      assert.deepStrictEqual([entry.defense, entry.campGate, entry.mode], ["arrival", GATE.itemId, "GATE_CAMP"]);
      assert.deepStrictEqual(pick(env.counters(), ["defenseArrivals", "defenseStarted", "defenseUnstaged", "started",
        "startedCamp", "refusedGovernor"]), [1, 1, 1, 1, 1, 2], "the old path: OPERATIONAL refused at both passes");
      assert.strictEqual(env.step.getStatus().arrivals, 1, "the gate has room and fleets are left");
      env.pass(1000);
      const second = [idleA, idleB].sort()[0];
      assert.deepStrictEqual(env.claims.map((c) => [c.fleetId, Object.prototype.hasOwnProperty.call(c, "unstage")]),
        [[staged, true], [second, false]]);
      assert.strictEqual(env.step.getStatus().arrivals, 0, "the gate is full -> the arrival is done");
      env.pass(1000);
      assert.strictEqual(env.claims.length, 2, "no third fleet");
      env.w.player(102, AT_GATE);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseArrivals", "defenseGateFull", "defenseStarted"]), [2, 1, 2]);
      assert.ok(env.lines.some((l) => l.includes(`defense arrival gate=${GATE.itemId} system=${SYS} trigger=101`)
        && l.includes("unstaged=1")), env.lines.join("\n"));
    });
  });

  needsDriver("GDF3 gate defense T3: the governor refuses LIVE for 2 passes -> the arrival waits, then starts; refused "
    + "longer than defenseArrivalWindowMs -> defenseExpired, zero claimInTx; a character of the first pass is not an "
    + "arrival", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("gd3");
      env.pass(0);
      env.admit.LIVE = false;
      env.w.player(101, AT_GATE);
      env.pass(1000);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseArrivals", "defenseRefusedGovernor"]), [1, 2]);
      assert.strictEqual(env.claims.length, 0);
      env.admit.LIVE = true;
      env.pass(1000);
      assert.deepStrictEqual(env.claims.map((c) => c.mode), ["GATE_CAMP"]);
      assert.strictEqual(env.counters().defenseStarted, 1);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      const G = env.config.garrisonPatrol;
      env.newFleet("gd3-exp");
      env.pass(0);
      env.admit.LIVE = false;
      env.w.player(101, AT_GATE);
      env.pass(1000);
      env.pass(G.defenseArrivalWindowMs + 1);
      env.admit.LIVE = true;
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseExpired", "defenseStarted"]), [1, 0]);
      assert.strictEqual(env.claims.length, 0);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("gd3-seed");
      env.w.player(101, AT_GATE);
      env.pass(0);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseArrivals", "defenseStarted"]), [0, 0]);
      assert.strictEqual(env.claims.length, 0);
    });
  });

  needsDriver("GDF4 gate defense T4: neutral player in an empire system -> defenseNotHostile; a police controller -> "
    + "defenseNotOwner and the old path PATROL; 400 km from the gates -> defenseNoGate; defenseEnabled false -> the "
    + "calls of the pass before", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.controller = EMPIRE;
      env.standings.set(`101:${EMPIRE}`, 0);
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseNotHostile", "defenseStarted"]), [1, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { startDelayMs: 0 });
      env.controller = POLICE;
      env.admit.OPERATIONAL = true;
      env.newFleet("gd4-police");
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      assert.strictEqual(env.counters().defenseNotOwner, 1);
      assert.deepStrictEqual(env.claims.map((c) => [c.mode, Object.prototype.hasOwnProperty.call(c, "unstage")]),
        [["PATROL", false]], "the old path starts its patrol as before");
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("gd4-far");
      env.pass(0);
      env.w.player(101, FAR_FROM_GATES);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseNoGate", "defenseStarted"]), [1, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { defenseEnabled: false, startDelayMs: 0 });
      env.admit.OPERATIONAL = true;
      env.newFleet("gd4-off");
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      env.pass(1000);
      const huntId = env.rows()[0].hunt_id;
      assert.deepStrictEqual(env.w.calls.map((c) => c[0]), ["listSystemObjects", "resolveProfiles",
        "readPlayerShips", "spawnShip", "spawnShip", "spawnShip", "publish", "readPlayerShips", "readShips",
        "readAggressors", "attackTargets", "attackTargets", "attackTargets"]);
      assert.deepStrictEqual(env.w.calls[0], ["listSystemObjects", SYS, ["sun", "stargate", "station"]]);
      assert.deepStrictEqual(env.w.calls[1], ["resolveProfiles", huntId]);
      assert.ok(COUNTER_NAMES.filter((n) => n.startsWith("defense")).every((n) => env.counters()[n] === 0));
      assert.deepStrictEqual([env.step.getStatus().arrivals, env.claims.map((c) => c.mode)], [0, ["PATROL"]]);
    });
  });

  needsDriver("GDF6: the biggest fleet refused NO_PROFILE -> the next free fleet starts in "
    + "the same pass, the refused one is never tried again for the arrival; attempts apart from starts; a failed read "
    + "of the world controller -> readFailed, the arrival waits (no SDE fallback)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { defenseFleetsPerGate: 2 });
      const big = env.newFleet("gd6-big", { composition: [{ hullGroup: "cruiser", count: 5 }] });
      const small = env.newFleet("gd6-small");
      env.w.noProfile.add(big);
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      assert.deepStrictEqual(env.claims.map((c) => [c.fleetId, c.mode]), [[small, "GATE_CAMP"]]);
      assert.deepStrictEqual(pick(env.counters(), ["defenseAttempts", "defenseStarted", "defenseSkippedProfile",
        "refusedProfile"]), [2, 1, 1, 1]);
      assert.strictEqual(env.step.getStatus().arrivals, 0, "no fleet left but the refused one -> the arrival is done");
      env.w.player(102, AT_GATE);
      env.pass(1000);
      env.pass(1000);
      assert.strictEqual(env.claims.length, 1);
      assert.strictEqual(env.counters().refusedProfile, 2, "a new arrival tries the big fleet once, then none left");
      assert.strictEqual(env.counters().defenseNoFleet, 1);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("gd6-read");
      env.pass(0);
      env.controlFails = true;
      env.w.player(101, AT_GATE);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["readFailed", "defenseNotOwner", "defenseAttempts"]), [1, 0, 0]);
      assert.strictEqual(env.step.getStatus().arrivals, 1);
      env.controlFails = false;
      env.pass(1000);
      assert.deepStrictEqual(env.claims.map((c) => c.mode), ["GATE_CAMP"]);
    });
  });

  needsDriver("GDF5 gate defense T5: ctx.world facades have getControlState, COUNTER_NAMES has the defense counters, "
    + "defaults and ranges of the new keys, GARRISON_STEP_METHODS unchanged", () => {
    withStore(driver, (opened) => {
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
      const config = baseConfig();
      config.modules = { ...config.modules, world: { ...(config.modules && config.modules.world), enabled: true } };
      const world = startWorld({ config, persistence: { ok: true, store: opened.store, journal }, clock });
      assert.ok(world.ok, JSON.stringify(world));
      const facade = world.world;
      assert.strictEqual(typeof facade.getControlState, "function");
      assert.strictEqual(facade.getControlState(SYS).ok, true);
      assert.strictEqual(typeof createUnavailableWorld("x").getControlState, "function");
      if (typeof facade.stop === "function") facade.stop();
    });
    for (const n of ["defenseArrivals", "defenseStarted", "defenseUnstaged", "defenseRefusedGovernor", "defenseExpired",
      "defenseNoGate", "defenseNotOwner", "defenseNotHostile", "defenseGateFull", "defenseNoFleet"]) {
      assert.ok(COUNTER_NAMES.includes(n), n);
    }
    assert.deepStrictEqual([...GARRISON_STEP_METHODS], ["stepPending", "step", "getStatus", "stop", "addLiveLosses",
      "relationGroups"]);
    const r = resolveConfig({ modDir: MOD_DIR, env: {} });
    const gp = r.config.garrisonPatrol;
    assert.deepStrictEqual([gp.defenseEnabled, gp.defenseRoles, gp.defenseUnstageOperationTypes, gp.defenseKinds,
      gp.defenseTrigger, gp.defenseArrivalMatchMeters, gp.defenseArrivalWindowMs, gp.defenseFleetsPerGate,
      gp.defenseMaxNewPerPass, gp.defenseWorkClass], [true, "garrison,patrol,invasion,hunter", "patrol,reinforce",
      "pirate,empire,invader,hive", "hostile", 50000, 20000, 2, 1, "LIVE"]);
    assert.strictEqual(gp.defenseMaxAttemptsPerPass, 3);
    assert.ok(!r.warnings.some((w) => w.includes("defense")), "defaults: no defense warning");
    const env = { EVEJS_LNE_GARRISON_PATROL_DEFENSE_ARRIVAL_MATCH_METERS: "1",
      EVEJS_LNE_GARRISON_PATROL_DEFENSE_FLEETS_PER_GATE: "9", EVEJS_LNE_GARRISON_PATROL_DEFENSE_KINDS: "dragon",
      EVEJS_LNE_GARRISON_PATROL_DEFENSE_WORK_CLASS: "SHED", EVEJS_LNE_GARRISON_PATROL_DEFENSE_TRIGGER: "x",
      EVEJS_LNE_GARRISON_PATROL_DEFENSE_UNSTAGE_OPERATION_TYPES: "none",
      EVEJS_LNE_GARRISON_PATROL_DEFENSE_ENABLED: "1" };
    const bad = resolveConfig({ modDir: MOD_DIR, env });
    const b = bad.config.garrisonPatrol;
    assert.deepStrictEqual([b.defenseArrivalMatchMeters, b.defenseFleetsPerGate, b.defenseKinds, b.defenseWorkClass,
      b.defenseTrigger, b.defenseUnstageOperationTypes], [5000, 4, "pirate,empire,invader,hive", "LIVE", "hostile",
      "none"]);
    assert.ok(bad.warnings.some((w) => w.includes("defenseEnabled without garrisonPatrol.enabled")),
      bad.warnings.join("\n"));
  });

  const GATE_Y = Object.freeze({ kind: "stargate", itemId: 50000002, position: pos(-2e10), toSystemId: SYS2 });
  const GATE_Z = Object.freeze({ kind: "stargate", itemId: 50000003, position: { x: 0, y: 0, z: 2e10 },
    toSystemId: SYS2 });
  const exitScene = (env) => {
    const { scene } = env.w;
    const list = scene.listSystemObjects;
    scene.listSystemObjects = (sys, kinds) => {
      const r = list(sys, kinds);
      if (kinds.includes("stargate")) r.objects.push(...[GATE_Y, GATE_Z].map((g) => ({ ...g, position: { ...g.position } })));
      return r;
    };
    scene.warpShips = (sys, ids, point) => {
      env.w.calls.push(["warpShips", [...ids], { ...point }]);
      return { ok: true, warped: ids.length, failed: [] };
    };
    const readShips = scene.readShips;
    scene.readShips = (sys, ids) => {
      const r = readShips(sys, ids);
      return { ...r, ships: r.ships.map((s) => ({ ...s, inWarp: env.npcInWarp === true })) };
    };
  };
  const warpTo = (env, characterId, position, gate) => {
    const p = env.w.player(characterId, position);
    p.warpTargetEntityId = gate ? gate.itemId : null;
    return p;
  };

  needsDriver("GDX3: a defense LIVE on X, a free fleet, a hostile player warps to Y -> GATE_CAMP "
    + "claim spawned at campPoint(Y), defense exit; 3 more passes of the same warp -> no claim (cooldown); a second "
    + "player warping to Y -> defenseExitCovered", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { defenseFleetsPerGate: 1 });
      exitScene(env);
      const G = env.config.garrisonPatrol;
      const big = env.newFleet("gx3-big", { composition: [{ hullGroup: "cruiser", count: 5 }] });
      const small = env.newFleet("gx3-small");
      env.newFleet("gx3-third");
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      assert.deepStrictEqual(env.claims.map((c) => c.fleetId), [big]);
      warpTo(env, 101, AT_GATE, GATE_Y);
      const spawned = env.w.spawns.length;
      env.pass(1000);
      assert.deepStrictEqual(env.claims.map((c) => [c.fleetId, c.mode]), [[big, "GATE_CAMP"], [small, "GATE_CAMP"]]);
      const point = JSON.stringify(campPoint(GATE_Y, G.campStandoffMeters));
      assert.ok(env.w.spawns.length === spawned + 3 && env.w.spawns.slice(spawned)
        .every((s) => JSON.stringify(s.anchorDescriptor.position) === point), "the exit defense spawns at campPoint(Y)");
      const exit = env.step.getStatus().list.find((x) => x.fleetId === small);
      assert.deepStrictEqual([exit.defense, exit.campGate, exit.relocations, exit.relocateTo],
        ["exit", GATE_Y.itemId, 0, null]);
      assert.deepStrictEqual(pick(env.counters(), ["defenseExitSeen", "defenseExitStarted", "defenseStarted"]),
        [1, 1, 2]);
      assert.ok(env.lines.some((l) => l.includes(`defense exit gate=${GATE_Y.itemId} system=${SYS} trigger=101`)),
        env.lines.join("\n"));
      env.pass(1000);
      env.pass(1000);
      env.pass(1000);
      assert.strictEqual(env.claims.length, 2, "one decision per warp (cooldown)");
      assert.deepStrictEqual(pick(env.counters(), ["defenseExitSeen", "defenseExitCovered"]), [1, 0]);
      warpTo(env, 102, FAR_FROM_GATES, GATE_Y);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseExitSeen", "defenseExitCovered"]), [2, 1]);
      assert.strictEqual(env.claims.length, 2);
      assert.strictEqual(env.step.getStatus().exits, 2);
    });
  });

  needsDriver("GDX4: no free fleet -> the CAMP_HOLD defense relocates (campGate Y at once), warp to "
    + "campPoint(Y) at the next pass, landed -> CAMP_HOLD; an ENGAGED camp is not relocated; after 2 relocations the "
    + "third gate -> defenseExitNoFleet", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      exitScene(env);
      const G = env.config.garrisonPatrol;
      env.newFleet("gx4");
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      assert.strictEqual(env.claims.length, 1);
      const fly = (gate, n) => {
        warpTo(env, 101, FAR_FROM_GATES, gate);
        env.pass(1000);
        assert.strictEqual(env.counters().defenseRelocated, n);
        assert.deepStrictEqual(pick(env.step.getStatus().list[0], ["campGate", "relocateTo", "relocations"]),
          [gate.itemId, gate.itemId, n]);
        env.pass(1000);
        const warp = env.w.calls.filter((c) => c[0] === "warpShips").pop();
        assert.deepStrictEqual(warp[2], campPoint(gate, G.campStandoffMeters));
        assert.deepStrictEqual(pick(env.step.getStatus().list[0], ["phase", "relocateTo"]), ["CAMP_WARP", null]);
        env.npcInWarp = true;
        env.pass(1000);
        env.npcInWarp = false;
        env.pass(1000);
        assert.deepStrictEqual(pick(env.step.getStatus().list[0], ["phase", "campGate"]), ["CAMP_HOLD", gate.itemId]);
        assert.strictEqual(env.counters().defenseRelocateLanded, n);
      };
      fly(GATE_Y, 1);
      fly(GATE_Z, 2);
      warpTo(env, 101, FAR_FROM_GATES, GATE);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseRelocated", "defenseExitNoFleet", "defenseRelocateFailed"]),
        [2, 1, 0]);
      assert.strictEqual(env.step.getStatus().list[0].campGate, GATE_Z.itemId);
      assert.strictEqual(env.claims.length, 1);
      assert.ok(env.lines.some((l) => l.includes(`relocate gate=${GATE_Y.itemId} system=${SYS}`)),
        env.lines.join("\n"));
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      exitScene(env);
      env.newFleet("gx4-engaged");
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      warpTo(env, 101, AT_GATE, GATE_Y);
      env.pass(1000);
      assert.strictEqual(env.step.getStatus().list[0].phase, "ENGAGED");
      assert.deepStrictEqual(pick(env.counters(), ["defenseRelocated", "defenseExitNoFleet"]), [0, 1]);
      assert.strictEqual(env.step.getStatus().list[0].campGate, GATE.itemId);
    });
  });

  needsDriver("GDX5: defaults and ranges of the 4 keys, the 7 counters, defenseExitEnabled false -> "
    + "the calls of an enabled exit defense without a player in warp, GARRISON_STEP_METHODS unchanged", () => {
    const gp = resolveConfig({ modDir: MOD_DIR, env: {} }).config.garrisonPatrol;
    assert.deepStrictEqual([gp.defenseExitEnabled, gp.defenseExitMatchMeters, gp.defenseMaxRelocations,
      gp.defenseExitCooldownMs], [true, 100000, 2, 30000]);
    const b = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_GARRISON_PATROL_DEFENSE_EXIT_ENABLED: "0",
      EVEJS_LNE_GARRISON_PATROL_DEFENSE_EXIT_MATCH_METERS: "1", EVEJS_LNE_GARRISON_PATROL_DEFENSE_MAX_RELOCATIONS: "99",
      EVEJS_LNE_GARRISON_PATROL_DEFENSE_EXIT_COOLDOWN_MS: "1" } }).config.garrisonPatrol;
    assert.deepStrictEqual([b.defenseExitEnabled, b.defenseExitMatchMeters, b.defenseMaxRelocations,
      b.defenseExitCooldownMs], [false, 10000, 8, 5000]);
    for (const n of ["defenseExitSeen", "defenseExitStarted", "defenseExitCovered", "defenseExitNoFleet",
      "defenseRelocated", "defenseRelocateLanded", "defenseRelocateFailed"]) assert.ok(COUNTER_NAMES.includes(n), n);
    assert.deepStrictEqual([...GARRISON_STEP_METHODS], ["stepPending", "step", "getStatus", "stop", "addLiveLosses",
      "relationGroups"]);
    const run = (gpExtra, warping) => withStore(driver, (opened) => {
      const env = setup(opened, gpExtra);
      exitScene(env);
      env.newFleet("gx5");
      env.pass(0);
      env.w.player(101, AT_GATE);
      env.pass(1000);
      if (warping) warpTo(env, 101, AT_GATE, GATE_Y);
      env.pass(1000);
      env.pass(1000);
      return { calls: env.w.calls, exits: COUNTER_NAMES.filter((n) => n.startsWith("defenseExit"))
        .map((n) => env.counters()[n]) };
    });
    const off = run({ defenseExitEnabled: false }, true);
    const on = run({}, false);
    assert.deepStrictEqual(off.calls, on.calls);
    assert.strictEqual(off.calls.filter((c) => c[0] === "listSystemObjects").length, 1);
    assert.deepStrictEqual([off.exits, on.exits], [[0, 0, 0, 0], [0, 0, 0, 0]]);
  });

  const ENEMY = 500010;
  const ALLY = 500011;
  const L1 = 9001;
  const L2 = 9002;
  const lneEnv = (opened, gp) => {
    const lne = { groups: [], calls: 0 };
    const reads = { n: 0 };
    const env = setup(opened, gp, (fleets) => ({
      getLneGroups: () => {
        lne.calls += 1;
        return lne.groups;
      },
      isFactionEnemy: (f, g) => g === ENEMY && f !== g,
      getFleets: () => ({ repository: { ...fleets, listFleetsInSystem: (...a) => {
        reads.n += 1;
        return fleets.listFleetsInSystem(...a);
      } } }) }));
    Object.assign(env, { lne, reads });
    env.group = (groupId, factionId, position, source = "hunt") => {
      env.w.npc.set(L1, { systemId: SYS, position });
      env.w.npc.set(L2, { systemId: SYS, position: { ...position, y: 500 } });
      lne.groups = [{ systemId: SYS, factionId, entityIds: [L2, L1], source, groupId }];
    };
    env.w.player(101, FAR_FROM_GATES);
    env.pass(0);
    return env;
  };

  needsDriver("GD-L1 gem: a hostile hunt group 20 km from the gate of a PIRATE system with a player -> a "
    + "defense camp on that gate (defense lne, log group=); the next pass -> no new start (done)", () => {
    withStore(driver, (opened) => {
      const env = lneEnv(opened);
      const G = env.config.garrisonPatrol;
      env.newFleet("gl1-a");
      env.newFleet("gl1-b");
      env.group("hunt-h1", ENEMY, pos(2e10 - 20000));
      env.pass(1000);
      assert.deepStrictEqual(env.claims.map((c) => [c.mode, c.characterId]), [["GATE_CAMP", 101]]);
      const [entry] = env.step.getStatus().list;
      assert.deepStrictEqual([entry.defense, entry.campGate], ["lne", GATE.itemId]);
      const point = JSON.stringify(campPoint(GATE, G.campStandoffMeters));
      assert.ok(env.w.spawns.length === 3 && env.w.spawns.every((s) => JSON.stringify(s.anchorDescriptor.position)
        === point), "the defense spawns at campPoint of the gate of the group");
      assert.ok(env.lines.some((l) => l.includes(`defense lne gate=${GATE.itemId} group=hunt-h1 system=${SYS}`)),
        env.lines.join("\n"));
      assert.deepStrictEqual(pick(env.counters(), ["defenseLneSeen", "defenseLneStarted", "defenseStarted"]),
        [1, 1, 1]);
      env.pass(1000);
      env.pass(1000);
      assert.strictEqual(env.claims.length, 1, "one decision per group");
      assert.deepStrictEqual(pick(env.counters(), ["defenseLneSeen", "defenseLneStarted", "defenseLneCovered"]),
        [1, 1, 0]);
      assert.strictEqual(env.step.getStatus().lneDefense, 1);
      env.lne.groups = [];
      env.pass(1000);
      assert.strictEqual(env.step.getStatus().lneDefense, 0, "the group is gone -> the entry is dropped");
    });
  });

  needsDriver("GD-L2 gem: an ally group, a group of the own faction, an owner kind outside defenseKinds "
    + "-> zero starts and zero fleet reads", () => {
    withStore(driver, (opened) => {
      const env = lneEnv(opened);
      env.newFleet("gl2-a");
      env.group("hunt-a", ALLY, pos(2e10 - 20000));
      env.lne.groups.push({ systemId: SYS, factionId: PIRATE, entityIds: [9003], source: "patrol", groupId: "own" });
      env.w.npc.set(9003, { systemId: SYS, position: pos(2e10 - 20000) });
      env.pass(1000);
      env.pass(1000);
      assert.deepStrictEqual([env.claims.length, env.reads.n, env.counters().defenseLneSeen], [0, 0, 0]);
      assert.strictEqual(env.step.getStatus().lneDefense, 2);
    });
    withStore(driver, (opened) => {
      const env = lneEnv(opened);
      env.controller = POLICE;
      env.newFleet("gl2-p");
      env.group("hunt-p", ENEMY, pos(2e10 - 20000));
      env.pass(1000);
      assert.deepStrictEqual([env.claims.length, env.reads.n, env.counters().defenseLneSeen], [0, 0, 0]);
    });
  });

  needsDriver("GD-L3 gem: no free fleet, a defense camp on another gate -> relocation to the gate of the "
    + "group; a group far from the gates -> pending (defenseLneNoGate once), after defenseArrivalWindowMs -> done "
    + "(defenseLneExpired)", () => {
    withStore(driver, (opened) => {
      const env = lneEnv(opened);
      exitScene(env);
      env.newFleet("gl3");
      env.w.player(102, AT_GATE);
      env.pass(1000);
      assert.deepStrictEqual(env.step.getStatus().list.map((x) => [x.defense, x.campGate]),
        [["arrival", GATE.itemId]]);
      env.w.player(102, FAR_FROM_GATES);
      env.group("hunt-h3", ENEMY, pos(-2e10 + 20000));
      env.pass(1000);
      assert.deepStrictEqual(pick(env.step.getStatus().list[0], ["campGate", "relocateTo", "relocations"]),
        [GATE_Y.itemId, GATE_Y.itemId, 1]);
      assert.deepStrictEqual(pick(env.counters(), ["defenseLneSeen", "defenseLneRelocated", "defenseLneNoFleet"]),
        [1, 1, 0]);
      assert.strictEqual(env.claims.length, 1);
    });
    withStore(driver, (opened) => {
      const env = lneEnv(opened);
      const G = env.config.garrisonPatrol;
      env.newFleet("gl3-far");
      env.group("hunt-far", ENEMY, FAR_FROM_GATES);
      env.pass(1000);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseLneSeen", "defenseLneNoGate", "defenseLneExpired"]),
        [1, 1, 0]);
      env.pass(G.defenseArrivalWindowMs + 1);
      env.pass(1000);
      assert.deepStrictEqual(pick(env.counters(), ["defenseLneNoGate", "defenseLneExpired"]), [1, 1]);
      assert.strictEqual(env.claims.length, 0);
    });
  });

  needsDriver("GD-L4 gem: defenseLneEnabled false -> getLneGroups not called in stepNew; defaults and "
    + "ranges of the 2 keys, the 7 counters, TRIGGER_LNE, the warning without lneTargetsEnabled", () => {
    withStore(driver, (opened) => {
      const env = lneEnv(opened, { defenseLneEnabled: false });
      env.newFleet("gl4");
      env.group("hunt-h4", ENEMY, pos(2e10 - 20000));
      env.pass(1000);
      env.pass(1000);
      assert.deepStrictEqual([env.lne.calls, env.claims.length, env.reads.n], [0, 0, 0]);
    });
    const gp = resolveConfig({ modDir: MOD_DIR, env: {} }).config.garrisonPatrol;
    assert.deepStrictEqual([gp.defenseLneEnabled, gp.defenseLneMatchMeters], [true, 100000]);
    const b = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_GARRISON_PATROL_DEFENSE_LNE_MATCH_METERS: "1" } })
      .config.garrisonPatrol;
    assert.strictEqual(b.defenseLneMatchMeters, 10000);
    for (const n of ["defenseLneSeen", "defenseLneStarted", "defenseLneCovered", "defenseLneRelocated",
      "defenseLneNoGate", "defenseLneNoFleet", "defenseLneExpired"]) assert.ok(COUNTER_NAMES.includes(n), n);
    assert.strictEqual(TRIGGER_LNE, "lne");
    const w = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_GARRISON_PATROL_ENABLED: "1",
      EVEJS_LNE_GARRISON_PATROL_LNE_TARGETS_ENABLED: "0" } });
    assert.ok(w.warnings.some((x) => x.includes("defenseLneEnabled without garrisonPatrol.lneTargetsEnabled")),
      w.warnings.join("\n"));
  });
};

module.exports.harness = { loadDriver, withStore, setup, pick, SYS, SYS2, PIRATE, GATE, AT_GATE, START_MS, MOD_DIR };
