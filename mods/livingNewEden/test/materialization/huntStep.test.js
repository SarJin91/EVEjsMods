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
const { sweepOrder, scanRoll, pickCandidate } = require("../../lib/playerHunt/policy");
const { decideHuntStep } = require("../../lib/playerHunt/phases");
const { createHuntStep, COUNTER_NAMES } = require("../../lib/materialization/huntStep");
const { createUnavailableOfficerSpawns } = require("../../lib/officers");
const { createPhysicalBudget } = require("../../lib/materialization/physicalBudget");
const { createLossTracker } = require("../../lib/materialization/lossTracker");
const { buildLeg } = require("../../lib/fleets/travel");
const { resolveConfig, SCHEMA } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const SYS = 30000142;
const SYS2 = 30000144;
const PIRATE = 500019;
const EMPIRE = 500001;
const KINDS = Object.freeze({ [PIRATE]: "pirate", [EMPIRE]: "empire" });
const LIMITS = Object.freeze({ maxVirtualFleets: 50, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxFleetsPerOperation: 16, maxJsonBytes: 4096, maxListLimit: 500 });
const COMP3 = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);
const COMP_SCAN = Object.freeze([{ hullGroup: "cruiser", count: 2 }, { hullGroup: "ewar", count: 1 }]);
const pos = (x) => ({ x, y: 0, z: 0 });
const OBJECTS = Object.freeze([{ kind: "stargate", itemId: 50000001, position: pos(0) },
  { kind: "station", itemId: 60000001, position: pos(1e10) }, { kind: "planet", itemId: 40000001, position: pos(2e10) }]);
const FAR = pos(9e11);
const SYS3 = 30000145;
const JUMP_MS = 60000;
const GATE_BACK = 50000012;
const OBJECTS_SYS2 = Object.freeze([{ kind: "station", itemId: 60000011, position: pos(3e10) },
  { kind: "stargate", itemId: 50000011, position: pos(4e10), toSystemId: SYS3 },
  { kind: "stargate", itemId: GATE_BACK, position: pos(5e10), toSystemId: SYS }]);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hc-"));
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
  const w = { loaded: new Set([SYS, SYS2]), npc: new Map(), players: [], aggressors: new Map(), calls: [],
    nextId: 7001, spawnFail: null, tracker: null, keep: [], dormant: new Set(),
    objects: new Map(), routes: new Map(),
    inWarp: new Set(), vendorOrders: new Map(), profileOf: new Map() };
  const objectsOf = (sys) => w.objects.get(sys) || OBJECTS;
  w.neighbors = new Map();
  w.secClass = new Map();
  w.graph = { getGraph: () => ({ ok: true, graph: { findRoute(from, to) {
    w.calls.push(["findRoute", from, to]);
    const jumps = w.routes.get(`${from}:${to}`);
    return jumps ? { ok: true, jumps, route: [from, to] } : { ok: false, reason: "UNREACHABLE" };
  },
  getNeighbors: (id) => w.neighbors.get(id) || [],
  getSystem: (id) => ({ systemId: id, secClass: w.secClass.get(id) || "nullsec" }) } }) };
  const sleep = () => {
    for (const id of w.dormant) w.npc.delete(id);
    w.dormant.clear();
  };
  const copy = (p) => ({ ...p, position: { ...p.position } });
  w.scene = {
    listSystemObjects(sys, kinds) {
      w.calls.push(["listSystemObjects", sys, [...kinds]]);
      return { ok: true, objects: objectsOf(sys).filter((o) => kinds.includes(o.kind)).map(copy) };
    },
    readPlayerShips(sys) {
      w.calls.push(["readPlayerShips", sys]);
      if (!w.loaded.has(sys)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, ships: w.players.filter((p) => p.systemId === sys && p.state === "space")
        .map((p) => ({ characterId: p.characterId, entityId: p.entityId, position: { ...p.position },
          signatureRadius: p.signatureRadius === undefined ? 100 : p.signatureRadius, inWarp: p.inWarp === true,
          cloaked: p.cloaked === true, capsule: p.capsule === true,
          ...(p.aligning !== undefined ? { aligning: p.aligning === true } : {}),
          ...(p.typeId !== undefined ? { typeId: p.typeId, groupId: p.groupId === undefined ? null : p.groupId }
            : {}) })) };
    },
    readShips(sys, ids) {
      w.calls.push(["readShips", sys]);
      sleep();
      return { ok: true, ships: ids.filter((id) => w.npc.has(id))
        .map((id) => ({ entityId: id, position: { ...w.npc.get(id).position }, inWarp: w.inWarp.has(id),
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
        if (w.vendorOrders.has(id)) w.vendorOrders.set(id, { attackTargetId: targets[0], weapons: true });
      }
      return { ok: true, failed: [] };
    },
    readAggressors(sys, ids) {
      w.calls.push(["readAggressors", sys]);
      return { ok: true, aggressors: ids.filter((id) => w.aggressors.has(id)).map((id) => {
        const a = w.aggressors.get(id);
        return a && typeof a === "object" ? { entityId: id, ...a, aggressorPosition: { ...a.aggressorPosition } }
          : { entityId: id, aggressorId: a };
      }) };
    },
    explainShips(sys, ids) {
      w.calls.push(["explainShips", sys]);
      return { ok: true, ships: ids.map((id) => ({ entityId: id, inScene: w.npc.has(id), controller: false })) };
    },
    armNpcCombat(sys, ids) {
      w.calls.push(["armNpcCombat", sys, [...ids]]);
      return w.armResult || { ok: true, armed: ids.length, already: 0, failed: [] };
    },
  };
  w.npcSpawn = {
    resolveProfiles(reqs, o) {
      w.calls.push(["resolveProfiles", o.seedPrefix]);
      return { ok: true, profiles: reqs.map((r) => `p_${r.factionId}_${r.hullGroup}`) };
    },
    isSceneLoaded: (sys) => w.loaded.has(sys),
    spawnShip(sys, spec) {
      w.calls.push(["spawnShip", { ...spec.anchorDescriptor }, spec.behavior, spec.spawnDistanceMeters]);
      if (w.spawnFail && w.spawnFail()) return { ok: false, reason: "SPAWN_FAILED", detail: "boom" };
      const o = objectsOf(sys).find((x) => x.itemId === spec.anchorDescriptor.itemID);
      const id = w.nextId;
      w.nextId += 1;
      w.profileOf.set(id, spec.profileId);
      w.npc.set(id, { systemId: sys, position: { ...o.position } });
      w.keep.push(spec.keepMaterialized);
      if (spec.keepMaterialized !== true) w.dormant.add(id);
      return { ok: true, entityId: id };
    },
    publish(sys, ids) {
      w.calls.push(["publish", [...ids]]);
      return { ok: true, published: ids.length, missing: 0 };
    },
    despawn(sys, ids) {
      w.calls.push(["despawn", [...ids]]);
      let removed = 0;
      for (const id of ids) if (w.npc.delete(id)) removed += 1;
      return { ok: true, removed, missing: ids.length - removed };
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
  return w;
}

function baseConfig(ph) {
  const c = JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  c.enabled = true;
  c.modules = { ...c.modules, fleets: { ...(c.modules && c.modules.fleets), enabled: true } };
  c.playerHunt = { ...c.playerHunt, enabled: true, noticeDelayMs: 0, warpStartGraceMs: 0, ...(ph || {}) };
  return c;
}

function setup(opened, opts = {}) {
  const clock = createManualClock(START_MS);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const ids = createIdGenerator({ clock, rng: createRng(7) });
  const fleets = createFleetRepository({ journal, clock, ids, worldSeed: opened.worldSeed, limits: LIMITS });
  const config = baseConfig(opts.ph);
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const w = fakeWorld();
  w.travel = { planInTx(db, input, key) {
    w.calls.push(["planInTx", input.fleetId, input.targetSystemId]);
    const f = fleets.getFleet(db, input.fleetId).fleet;
    const jumps = w.routes.get(`${f.currentSystemId}:${input.targetSystemId}`);
    if (!jumps) return { ok: false, reason: "UNREACHABLE" };
    const built = buildLeg({ systems: [f.currentSystemId, input.targetSystemId], departAt: input.at,
      jumpMs: JUMP_MS * jumps, graphVersion: 1, mode: "travel", observed: true });
    assert.ok(built.ok, JSON.stringify(built));
    const moved = fleets.transition(db, { fleetId: f.fleetId, expectedVersion: f.version, from: f.state,
      to: "TRAVELLING", patch: { targetSystemId: input.targetSystemId, route: built.leg, routeGraphVersion: 1,
        nextActionAt: built.leg.arriveAt, legSeq: f.legSeq + 1 } }, key);
    if (!moved.ok) return moved;
    return { ok: true, duplicate: moved.duplicate === true, arriveAt: built.leg.arriveAt, jumps,
      version: moved.version };
  } };
  const startPh = () => {
    const r = startPlayerHunt({ config, persistence, clock,
      getFleets: () => ({ repository: fleets, travel: w.travel }), logger,
      getOccupation: () => env.occupation || null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.playerHunt;
  };
  const standings = new Map();
  const reads = [];
  const env = { clock, fleets, config, lines, w, standings, reads, ph: startPh(), gov: { admits: true }, hooks: {},
    fleetReads: 0, approachReads: 0, scanReads: 0, battleShips: new Set(), lneReads: 0, enemies: new Set() };
  const stepRepo = { ...fleets, getFleet: (db, id) => {
    env.fleetReads += 1;
    return fleets.getFleet(db, id);
  },
  listFleetsInSystems: (db, list, o) => {
    env.approachReads += 1;
    return fleets.listFleetsInSystems(db, list, o);
  },
  listFleetsInSystem: (db, id, o) => {
    env.scanReads += 1;
    return fleets.listFleetsInSystem(db, id, o);
  } };
  const makeStep = () => {
    const tracker = createLossTracker({ maxPending: 40 });
    w.tracker = tracker;
    const budget = createPhysicalBudget({ limits: { perSystem: opts.perSystem || 20, global: 40 }, clock });
    env.budget = budget;
    env.step = createHuntStep({ store: opened.store, clock, npcSpawn: w.npcSpawn, budget,
      settings: config.playerHunt, maxRetargetsPerPass: 64, getPlayerHunt: () => env.ph,
      getFactionKind: (f) => KINDS[f] || null, getFleets: () => ({ repository: stepRepo, travel: w.travel }),
      getGraph: () => w.graph, getHuntScene: () => w.scene, readStanding: (c, f) => {
        reads.push([clock.now(), c, f]);
        return { ok: true, found: true, standing: standings.has(`${c}:${f}`) ? standings.get(`${c}:${f}`) : 0 };
      }, lossTracker: tracker, lossImportOn: opts.lossImportOn !== false,
      despawnAll: (sys, list) => (list.length > 0 ? w.npcSpawn.despawn(sys, list) : null),
      admits: () => env.gov.admits,
      excludedFactionIds: [500018], logger, hooks: env.hooks,
      getOwnedShipIds: () => env.battleShips,
      getOccupation: () => env.occupation || null,
      getNotices: () => env.notices || null,
      ...(opts.officers ? { getOfficerSpawns: () => env.officers || null } : {}),
      ...(opts.lne ? { getLneGroups: () => {
        env.lneReads += 1;
        return env.lneGroups || [];
      }, isFactionEnemy: (f, g) => env.enemies.has(`${f}:${g}`) } : {}),
      ...(opts.deps || {}) });
  };
  makeStep();
  env.restart = () => {
    env.ph.stop();
    env.ph = startPh();
    w.npc.clear();
    makeStep();
  };
  const presence = {
    observedSystems: () => [...new Set(w.players.map((p) => p.systemId))].sort((a, b) => a - b),
    getSystemPresence: (id) => {
      const chars = w.players.filter((p) => p.systemId === id).map((p) => ({ characterId: p.characterId,
        name: `Pilot ${p.characterId}`, state: p.state }));
      return { systemId: id, space: chars.filter((c) => c.state === "space").length, characters: chars };
    },
  };
  env.pass = (dt = 0) => {
    clock.advance(dt);
    const now = clock.now();
    const out = { refused: {}, huntsStarted: [], huntsEnded: [] };
    env.step.stepPending(now, out);
    const r = env.step.step(now, presence, out, 64);
    out.aborted = r.aborted;
    return out;
  };
  env.tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  env.fleet = (fleetId) => env.tx((db) => fleets.getFleet(db, fleetId)).fleet;
  env.arrive = (fleetId, sys) => env.tx((db) => {
    const f = fleets.getFleet(db, fleetId).fleet;
    const s = fleets.transition(db, { fleetId, expectedVersion: f.version, from: "TRAVELLING", to: "STAGED",
      patch: { currentSystemId: sys, route: null, routeGraphVersion: null, nextActionAt: null } },
    `test:arrive:${fleetId}:${f.legSeq}`);
    assert.ok(s.ok, JSON.stringify(s));
    const i = fleets.transition(db, { fleetId, expectedVersion: s.version, from: "STAGED", to: "IDLE" },
      `test:idle:${fleetId}:${f.legSeq}`);
    assert.ok(i.ok, JSON.stringify(i));
    return i;
  });
  env.newFleet = (key, factionId, extra = {}) => {
    const r = env.tx((db) => fleets.createFleet(db, { factionId, currentSystemId: SYS, homeSystemId: SYS,
      fleetRole: "patrol", composition: COMP3, ...extra }, key));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    return r.fleetId;
  };
  env.rows = () => env.tx((db) => db.prepare("SELECT hunt_id, state, end_reason, character_id, standing, seed, "
    + "mode, members_json FROM world_player_hunts ORDER BY started_at, hunt_id").all());
  env.journalRows = () => env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n);
  env.counters = () => env.step.getStatus().counters;
  env.live = () => env.step.getStatus().hunts.filter((h) => h.state === "LIVE");
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("HC1 start by standing: flag off = no adapter call, no write; friendly / neutral-empire never "
    + "hostile and neutral-pirate hunted; one standing read per pair per pass; loss import off = one log line", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { enabled: false } });
      env.newFleet("hc1-off", PIRATE);
      env.w.player(102);
      const before = env.journalRows();
      for (let i = 0; i < 3; i += 1) env.pass(60000);
      assert.deepStrictEqual([env.w.calls, env.reads, env.rows()], [[], [], []], "flag off: nothing");
      assert.strictEqual(env.journalRows(), before);
      assert.deepStrictEqual(COUNTER_NAMES.filter((n) => env.counters()[n] !== 0), []);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      const fleetId = env.newFleet("hc1-emp", EMPIRE);
      env.newFleet("hc1-emp2", EMPIRE);
      env.standings.set(`101:${EMPIRE}`, 5);
      env.standings.set(`102:${EMPIRE}`, 0);
      env.w.player(101);
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual(env.rows(), [], "friendly (+5) and neutral for an empire: no hunt");
      assert.strictEqual(env.counters().refusedStanding, 1);
      assert.deepStrictEqual(env.reads.map((r) => [r[1], r[2]]), [[101, EMPIRE], [102, EMPIRE]], "one read per pair");
      env.standings.set(`103:${EMPIRE}`, -5);
      env.w.player(103);
      env.pass(1000);
      const rows = env.rows();
      assert.deepStrictEqual(rows.map((r) => [r.state, r.character_id, r.standing]), [["LIVE", 103, -5]]);
      assert.strictEqual(env.fleet(fleetId).state, "MATERIALIZED");
      const perPass = new Map();
      for (const [at, c, f] of env.reads) {
        const k = `${at}:${c}:${f}`;
        perPass.set(k, (perPass.get(k) || 0) + 1);
      }
      assert.ok([...perPass.values()].every((n) => n === 1), "cache: one read per (character, faction) per pass");
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("hc1-pir", PIRATE);
      env.standings.set(`101:${PIRATE}`, 6);
      env.w.player(101);
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.character_id, r.standing]), [["LIVE", 102, 0]],
        "a neutral player is hunted by a pirate faction (neutralPolicy pirate:hostile)");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { lossImportOn: false });
      env.newFleet("hc1-noloss", PIRATE);
      env.w.player(102);
      env.pass(1000);
      env.pass(1000);
      assert.deepStrictEqual([env.rows(), env.w.calls], [[], []], "P8 /: no hunt without the loss import");
      assert.strictEqual(env.lines.filter((l) => l.includes("battle.liveLossImport off")).length, 1);
    });
  });

  needsDriver("HC2 fictional scene: sweepOrder objects with objectDwellMs, quarry on grid -> attackTargets "
    + "(a friendly player on grid is no target); the friendly attacker gets the attacked ship; reacquire -> "
    + "search before warp", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { sweepRetargetEnabled: false } });
      const S = env.config.playerHunt;
      env.newFleet("hc2", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.standings.set(`101:${PIRATE}`, 6);
      env.pass(0);
      assert.deepStrictEqual(env.rows(), [], "nobody in space: no hunt");
      const quarry = env.w.player(103);
      const friend = env.w.player(101);
      env.pass(0);
      const [row] = env.rows();
      assert.strictEqual(row.state, "LIVE");
      const order = sweepOrder(OBJECTS, ["stargate", "station", "asteroidBelt", "planet"], row.seed)
        .map((o) => OBJECTS.find((x) => x.itemId === o.itemId));
      const spawns = env.w.calls.filter((c) => c[0] === "spawnShip");
      assert.deepStrictEqual(spawns, [0, 1, 2].map(() => ["spawnShip", { kind: order[0].kind,
        itemID: order[0].itemId }, "search", S.landingSpreadMeters]), "anchor = first object, behaviour search");
      assert.deepStrictEqual(env.budget.getStatus().reservedByOwnerKind, { fleet: 3 });
      const ships = [...env.w.npc.keys()];
      quarry.position = { ...order[2].position, x: order[2].position.x + 1000 };
      friend.position = { ...order[2].position, x: order[2].position.x + 2000 };

      env.pass(S.objectDwellMs - 1);
      assert.strictEqual(env.w.count("warpShips"), 0, "before objectDwellMs: no warp");
      env.pass(1);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "warpShips").map((c) => c[2]), [order[1].position]);
      env.pass(1000);
      env.pass(S.objectDwellMs);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "warpShips").map((c) => c[2]),
        [order[1].position, order[2].position]);
      assert.strictEqual(env.w.count("setSearch"), 0, "spawned in search: no search order before a fight");
      assert.strictEqual(env.w.count("attackTargets"), 0);
      env.pass(1000);
      const attacks = () => env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => [c[1][0], c[2][0]]);
      assert.deepStrictEqual(attacks(), ships.map((s) => [s, quarry.entityId]), "only the quarry, not the friend");
      assert.strictEqual(env.counters().engaged, 1);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");

      env.w.aggressors.set(ships[1], friend.entityId);
      env.pass(1000);
      assert.deepStrictEqual(attacks().slice(3), [[ships[1], friend.entityId]]);
      assert.strictEqual(env.counters().retaliated, 1);
      env.pass(1000);
      assert.strictEqual(attacks().length, 4, "no churn while the targets stay");

      quarry.position = FAR;
      friend.position = FAR;
      env.pass(1000);
      const n = env.w.calls.length;
      env.pass(S.reacquireGraceMs);
      const tail = env.w.calls.slice(n).filter((c) => c[0] === "setSearch" || c[0] === "warpShips");
      assert.deepStrictEqual(tail.map((c) => c[0]), ["setSearch", "warpShips"], "07b INFO-2: search -> warp");
      assert.deepStrictEqual(tail[1][2], order[0].position, "wraps to the first object");
      assert.strictEqual(env.counters().objectsVisited, 3);
    });
  });

  needsDriver("HC3 losses: killmail of 1 of 3 ships -> markDestroyedInTx once (duplicate ignored) "
    + "TARGET_GONE -> fleet IDLE with 2 ships; every ship destroyed -> WIPED, fleet DESTROYED", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      const S = env.config.playerHunt;
      const fleetId = env.newFleet("hc3a", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      const quarry = env.w.player(103);
      env.pass(0);
      const ships = [...env.w.npc.keys()];
      env.w.kill(ships[0]);
      env.w.tracker.note({ itemID: ships[0] }, { success: true });
      env.w.tracker.note({ itemID: 424242 }, { success: true });
      env.pass(1000);
      assert.strictEqual(env.counters().lossImported, 1);
      const lossKeys = () => env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal "
        + "WHERE idempotency_key LIKE 'phunt:%:loss:%'").get().n);
      assert.strictEqual(lossKeys(), 1);
      assert.deepStrictEqual(JSON.parse(env.rows()[0].members_json).map((m) => m.state),
        ["DESTROYED", "SPAWNED", "SPAWNED"]);
      quarry.state = "docked";
      env.pass(1000);
      env.pass(S.exitGraceMs - 1);
      assert.strictEqual(env.rows()[0].state, "LIVE", "inside exitGraceMs");
      env.pass(1);
      const [row] = env.rows();
      assert.deepStrictEqual([row.state, row.end_reason], ["ENDED", "TARGET_GONE"]);
      const f = env.fleet(fleetId);
      assert.deepStrictEqual([f.state, f.shipCount], ["IDLE", 2]);
      assert.strictEqual(lossKeys(), 1, "one loss, one key");
      assert.deepStrictEqual([env.budget.getStatus().reservedShips, env.w.npc.size], [0, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      const fleetId = env.newFleet("hc3b", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(0);
      for (const id of [...env.w.npc.keys()]) env.w.kill(id);
      const out = env.pass(1000);
      assert.strictEqual(env.counters().lossImported, 3);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "WIPED"]]);
      assert.deepStrictEqual(out.huntsEnded.length, 1);
      assert.strictEqual(env.fleet(fleetId).state, "DESTROYED");
      assert.strictEqual(env.budget.getStatus().reservedShips, 0);
    });
  });

  needsDriver("CMN1: a hunt with a titan - its attack order carries capitalIds "
    + "[titan] (no chase / orbit of a subcap), a subcap keeps the 3-argument call", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("cmn1", PIRATE, { composition: [{ hullGroup: "cruiser", count: 2 },
        { hullGroup: "titan", typeId: 42241, count: 1 }] });
      env.standings.set(`103:${PIRATE}`, -6);
      const quarry = env.w.player(103);
      env.pass(0);
      const ships = [...env.w.npc.keys()];
      const titan = ships.find((id) => env.w.profileOf.get(id) === `p_${PIRATE}_titan`);
      assert.ok(titan !== undefined, JSON.stringify([...env.w.profileOf]));
      quarry.position = { ...env.w.npc.get(ships[0]).position };
      env.pass(1000);
      const attacks = env.w.calls.filter((c) => c[0] === "attackTargets");
      assert.deepStrictEqual(attacks.map((c) => c.slice(1)), ships.map((s) => (s === titan
        ? [[s], [quarry.entityId], [titan]] : [[s], [quarry.entityId]])));
    });
  });

  needsDriver("HB1 hunt ships do not shoot: an attack order the vendor dropped (no order / weapons off) "
    + "is given again once (orderLost + log line), no churn while the vendor holds it; addLiveLosses per fleet", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      const fleetId = env.newFleet("hb1", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      const quarry = env.w.player(103);
      env.pass(0);
      const ships = [...env.w.npc.keys()];
      for (const s of ships) env.w.vendorOrders.set(s, { attackTargetId: 0, weapons: false });
      quarry.position = { ...env.w.npc.get(ships[0]).position };
      env.pass(1000);
      const attacks = () => env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => [c[1][0], c[2][0]]);
      assert.deepStrictEqual(attacks(), ships.map((s) => [s, quarry.entityId]));
      assert.ok(env.lines.some((l) => l.includes("attack ships=3 ordered=3")), env.lines.join(" | "));
      env.pass(1000);
      assert.strictEqual(attacks().length, 3, "the vendor holds the orders: no new order");
      env.w.vendorOrders.set(ships[1], { attackTargetId: 0, weapons: false });
      env.pass(1000);
      assert.deepStrictEqual(attacks().slice(3), [[ships[1], quarry.entityId]], "the lost order again");
      assert.strictEqual(env.counters().orderLost, 1);
      assert.ok(env.lines.some((l) => l.includes(`order lost (1) [${ships[1]}:want=${quarry.entityId}:vendor=0`)));
      env.pass(1000);
      assert.strictEqual(attacks().length, 4, "no churn after the new order");
      env.w.vendorOrders.set(ships[0], { attackTargetId: quarry.entityId, weapons: true, leashMeters: 150000,
        homeDistanceMeters: 200000, beyondLeash: true });
      env.pass(1000);
      env.pass(1000);
      const leashLines = env.lines.filter((l) => l.includes("beyondLeash=true"));
      assert.deepStrictEqual(leashLines.length, 1, env.lines.join(" | "));
      assert.ok(leashLines[0].includes(`[${ships[0]}:home=200000:leash=150000]`), leashLines[0]);
      assert.strictEqual(attacks().length, 4, "beyondLeash alone is not a lost order");
      assert.deepStrictEqual([...env.step.addLiveLosses(new Map())], [], "no loss yet");
      env.w.kill(ships[2]);
      env.pass(1000);
      assert.deepStrictEqual([...env.step.addLiveLosses(new Map([[fleetId, 1]]))], [[fleetId, 2]],
        "the imported loss of the open hunt, added to the map");
    });
  });

  needsDriver("HC4 exits: TARGET_GONE + cooldown per (character, faction), TIMEOUT, SCENE_GONE; hook after "
    + "claim -> next pass SPAWN_FAILED rollback; spawn error -> rollback in the pass; restart -> RESTART", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      const S = env.config.playerHunt;
      const fleetId = env.newFleet("hc4a", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      const quarry = env.w.player(103);
      env.pass(0);
      quarry.state = "docked";
      env.pass(1000);
      env.pass(S.exitGraceMs);
      assert.deepStrictEqual(env.rows().map((r) => r.end_reason), ["TARGET_GONE"]);
      assert.strictEqual(env.budget.getStatus().reservedShips, 0);
      quarry.state = "space";
      env.pass(1000);
      assert.strictEqual(env.rows().length, 1, "cooldownMs per (character, faction)");
      assert.strictEqual(env.counters().refusedCooldown, 1);
      env.pass(S.cooldownMs);
      const rows = env.rows();
      assert.deepStrictEqual(rows.map((r) => r.state), ["ENDED", "LIVE"]);
      assert.notStrictEqual(rows[0].hunt_id, rows[1].hunt_id, "a new hunt has a new id (fleet version)");
      env.pass(S.maxDurationMs);
      assert.deepStrictEqual(env.rows().map((r) => r.end_reason), ["TARGET_GONE", "TIMEOUT"]);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { cooldownMs: 0 } });
      const fleetId = env.newFleet("hc4b", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      let abort = true;
      env.hooks.afterHuntClaim = () => !abort;
      assert.strictEqual(env.pass(0).aborted, true, "simulated death right after tx A");
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["CLAIMED"]);
      assert.deepStrictEqual([env.fleet(fleetId).state, env.w.count("spawnShip")], ["MATERIALIZED", 0]);
      abort = false;
      env.gov.admits = false;
      env.pass(1000);
      const first = env.rows()[0];
      assert.deepStrictEqual([first.state, first.end_reason], ["ENDED", "SPAWN_FAILED"]);
      assert.deepStrictEqual([env.counters().spawnFailed, env.fleet(fleetId).state], [1, "IDLE"]);
      assert.strictEqual(env.budget.getStatus().reservedShips, 0);
      let n = 0;
      env.w.spawnFail = () => {
        n += 1;
        return n === 2;
      };
      env.gov.admits = true;
      env.pass(1000);
      assert.strictEqual(env.w.count("despawn"), 1);
      const second = env.rows();
      assert.ok(second.every((r) => r.state === "ENDED"), JSON.stringify(second));
      assert.strictEqual(env.counters().spawnFailed >= 2, true);
      assert.deepStrictEqual([env.fleet(fleetId).state, env.w.npc.size, env.budget.getStatus().reservedShips],
        ["IDLE", 0, 0]);
      env.w.spawnFail = null;
      env.pass(1000);
      assert.strictEqual(env.rows().at(-1).state, "LIVE");
      env.w.loaded.delete(SYS);
      env.pass(1000);
      assert.strictEqual(env.rows().at(-1).end_reason, "SCENE_GONE");
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      const fleetId = env.newFleet("hc4c", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(0);
      assert.strictEqual(env.rows()[0].state, "LIVE");
      env.clock.advance(5000);
      env.restart();
      const [row] = env.rows();
      assert.deepStrictEqual([row.state, row.end_reason], ["ENDED", "RESTART"]);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
      assert.ok(env.lines.some((l) => l.startsWith("playerHunt: running enabled=true recovered=1")));
      assert.strictEqual(env.step.getStatus().active, 0, "the new boot owns nothing of the old one");
    });
  });

  needsDriver("HC6 limits: maxNewHuntsPerPass, maxHuntsPerSystem, maxActiveHunts, noticeDelayMs, the budget "
    + "shared with battles (battles first), governor; status hunts", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { maxActiveHunts: 2, maxHuntsPerSystem: 1, maxNewHuntsPerPass: 1,
        noticeDelayMs: 60000 } });
      env.newFleet("hc6-1", PIRATE);
      env.newFleet("hc6-2", PIRATE);
      env.newFleet("hc6-3", PIRATE, { currentSystemId: SYS2, homeSystemId: SYS2 });
      env.w.player(103);
      env.w.player(104, { systemId: SYS2 });
      env.pass(0);
      env.pass(59999);
      assert.deepStrictEqual(env.rows(), [], "noticeDelayMs");
      env.gov.admits = false;
      env.pass(1);
      assert.deepStrictEqual([env.rows(), env.counters().refusedGovernor], [[], 1]);
      env.gov.admits = true;
      env.pass(1000);
      assert.strictEqual(env.rows().length, 1, "maxNewHuntsPerPass 1");
      env.pass(1000);
      assert.deepStrictEqual(env.live().map((h) => h.systemId).sort(), [SYS, SYS2]);
      const st = env.step.getStatus();
      assert.deepStrictEqual([st.active, st.ships, st.enabled, st.lossImport], [2, 6, true, "on"]);
      env.config.playerHunt.maxHuntsPerSystem = 2;
      env.pass(1000);
      assert.strictEqual(env.rows().length, 2, "maxActiveHunts 2");
      env.config.playerHunt.maxHuntsPerSystem = 1;
      env.config.playerHunt.maxActiveHunts = 3;
      env.pass(1000);
      assert.strictEqual(env.rows().length, 2, "maxHuntsPerSystem 1");
      env.config.playerHunt.maxHuntsPerSystem = 2;
      env.pass(1000);
      assert.deepStrictEqual(env.live().map((h) => h.systemId).sort(), [SYS, SYS, SYS2]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { perSystem: 4 });
      env.newFleet("hc6-b", PIRATE);
      env.w.player(103);
      assert.strictEqual(env.budget.reserve({ reservationId: "mat:battle:b1:1", ownerKind: "battle", ownerId: "b1",
        systemId: SYS, shipCount: 2 }).ok, true);
      env.pass(1000);
      assert.deepStrictEqual([env.rows(), env.counters().refusedBudget, env.w.count("spawnShip")], [[], 1, 0]);
      env.budget.release("mat:battle:b1:1");
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
      assert.deepStrictEqual(env.budget.getStatus().reservedByOwnerKind, { fleet: 3 });
    });
  });

  const rollParams = (S) => ({ basePermille: S.scanBasePermille, minPermille: S.scanMinPermille,
    maxPermille: S.scanMaxPermille, refSignatureM: S.scanRefSignatureM });
  const firstHit = (seed, sig, S, max) => {
    for (let c = 0; c < max; c += 1) if (scanRoll(seed, c, sig, rollParams(S)).found) return c;
    return -1;
  };
  const SCAN_SIG = 40;

  function scanToEngaged(env) {
    const S = env.config.playerHunt;
    env.newFleet("sd-scan", PIRATE, { composition: COMP_SCAN });
    env.standings.set(`103:${PIRATE}`, -6);
    const quarry = env.w.player(103, { signatureRadius: SCAN_SIG });
    env.pass(0);
    const [row] = env.rows();
    assert.deepStrictEqual([row.state, row.mode], ["LIVE", "SCAN"], "hasScanner -> mode SCAN in the row");
    assert.strictEqual(env.live()[0].phase, "SCAN", "stays at the first object and scans");
    const ships = [...env.w.npc.keys()];
    const hit = firstHit(row.seed, SCAN_SIG, S, S.maxScanCycles);
    assert.ok(hit >= 1, `the seed of the test gives misses before the hit (hit cycle ${hit})`);
    env.pass(S.scanCycleMs - 1);
    assert.strictEqual(env.counters().scanCycles, 0, "before scanCycleMs: no cycle ends");
    env.pass(1);
    for (let c = 1; c < hit; c += 1) env.pass(S.scanCycleMs);
    assert.deepStrictEqual([env.counters().scanCycles, env.counters().scanHits, env.w.count("warpShips")],
      [hit, 0, 0], "k cycles missed, no warp");
    env.pass(S.scanCycleMs);
    assert.deepStrictEqual([env.counters().scanCycles, env.counters().scanHits], [hit + 1, 1]);
    const warps = env.w.calls.filter((c) => c[0] === "warpShips");
    assert.deepStrictEqual(warps.map((c) => [c[1], c[2]]), [[ships, { x: FAR.x - S.warpInDistanceMeters, y: 0,
      z: 0 }]]);
    assert.strictEqual(env.live()[0].phase, "WARP_TO_TARGET");
    assert.strictEqual(env.counters().objectsVisited, 0, "a warp on the quarry is no object visit");
    env.pass(1000);
    return { quarry, ships, hit, row };
  }

  needsDriver("SD1 SCAN: fleet with ewar, N missed cycles, the hit -> warp on the quarry -> attackTargets "
    + "same seed + signature -> same hit cycle", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { maxScanCycles: 200 } });
      const S = env.config.playerHunt;
      const { quarry, ships, hit, row } = scanToEngaged(env);
      const attacks = env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => [c[1][0], c[2][0]]);
      assert.deepStrictEqual(attacks, ships.map((s) => [s, quarry.entityId]));
      const st = env.step.getStatus().hunts[0];
      assert.deepStrictEqual([st.mode, st.phase, st.alive, st.ships, st.scanCycle, st.quarryName, st.factionId],
        ["SCAN", "ENGAGED", 3, 3, hit + 1, "Pilot 103", PIRATE]);

      const replay = () => {
        let e = { phase: "SCAN", phaseSince: 0, objects: [], objectIndex: 0, visited: 1, liveSince: 0,
          quarryAbsentSince: null, noTargetSince: null, mode: "SCAN", seed: row.seed, scanCycle: 0 };
        const facts = (now) => ({ now, sceneLoaded: true, ownAlive: [{ entityId: 1, inWarp: false, position: pos(0) }],
          hostilesOnGrid: [], quarry: { state: "space", ship: { entityId: 9, capsule: false, position: FAR,
            signatureRadius: SCAN_SIG, inWarp: false, cloaked: false } } });
        for (let i = 1; i <= S.maxScanCycles; i += 1) {
          const d = decideHuntStep(e, facts(i * S.scanCycleMs), { ...S, maxDurationMs: Number.MAX_SAFE_INTEGER });
          if (d.scan && d.scan.found) return d.scan.cycle;
          e = { ...e, ...d };
        }
        return -1;
      };
      assert.deepStrictEqual([replay(), replay()], [hit, hit]);
    });
  });

  needsDriver("SD2 SCAN: a cloaked quarry is never hit (no roll) -> maxScanCycles -> NOT_FOUND, fleet IDLE",
    () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { maxScanCycles: 3 } });
      const S = env.config.playerHunt;
      const fleetId = env.newFleet("sd2", PIRATE, { composition: COMP_SCAN });
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103, { cloaked: true, signatureRadius: 10000 });
      env.pass(0);
      const [row] = env.rows();
      assert.ok(firstHit(row.seed, 10000, S, 3) >= 0, "a roll would have hit");
      env.pass(S.scanCycleMs);
      env.pass(S.scanCycleMs);
      assert.strictEqual(env.rows()[0].state, "LIVE");
      env.pass(S.scanCycleMs);
      const [done] = env.rows();
      assert.deepStrictEqual([done.state, done.end_reason], ["ENDED", "NOT_FOUND"]);
      assert.deepStrictEqual([env.counters().scanCycles, env.counters().scanHits, env.w.count("warpShips")], [3, 0, 0]);
      assert.deepStrictEqual([env.fleet(fleetId).state, env.w.npc.size, env.budget.getStatus().reservedShips],
        ["IDLE", 0, 0]);
    });
  });

  needsDriver("SD3 SCAN: the quarry leaves the grid after the fight -> reacquireGraceMs -> setSearch -> SCAN "
    + "(a new cycle, no warp to an object)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { maxScanCycles: 200 } });
      const S = env.config.playerHunt;
      const { quarry, hit } = scanToEngaged(env);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
      quarry.position = pos(5e11);
      env.pass(1000);
      const n = env.w.calls.length;
      env.pass(S.reacquireGraceMs);
      const tail = env.w.calls.slice(n).map((c) => c[0]).filter((c) => c === "setSearch" || c === "warpShips");
      assert.deepStrictEqual(tail, ["setSearch"], "search, no warp to an object");
      assert.strictEqual(env.live()[0].phase, "SCAN");
      env.pass(S.scanCycleMs);
      assert.strictEqual(env.counters().scanCycles, hit + 2, "a new cycle (cycle numbers go on)");
      assert.strictEqual(env.live()[0].scanCycle, hit + 2);
    });
  });

  needsDriver("HW4 scan hit, no ship ever seen in warp: WARP_TO_TARGET holds for warpStartGraceMs (no new scan "
    + "cycle, no second warp), then SCAN with warpNoStart 1", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { maxScanCycles: 200, warpStartGraceMs: 6000 } });
      const S = env.config.playerHunt;
      env.newFleet("hw4", PIRATE, { composition: COMP_SCAN });
      env.standings.set(`103:${PIRATE}`, -6);
      const quarry = env.w.player(103, { signatureRadius: SCAN_SIG });
      env.pass(0);
      const [row] = env.rows();
      const hit = firstHit(row.seed, SCAN_SIG, S, S.maxScanCycles);
      assert.ok(hit >= 0, `a hit within the cycles (${hit})`);
      for (let c = 0; c <= hit; c += 1) env.pass(S.scanCycleMs);
      assert.deepStrictEqual([env.live()[0].phase, env.counters().scanHits, env.w.count("warpShips")],
        ["WARP_TO_TARGET", 1, 1]);
      quarry.position = pos(5e11);
      const cycles = env.counters().scanCycles;
      env.pass(2000);
      env.pass(2000);
      env.pass(S.warpStartGraceMs - 4000 - 1);
      assert.deepStrictEqual([env.live()[0].phase, env.counters().scanCycles, env.counters().warpNoStart,
        env.w.count("warpShips")], ["WARP_TO_TARGET", cycles, 0, 1], "inside the grace: no cycle, no second warp");
      env.pass(1);
      assert.deepStrictEqual([env.live()[0].phase, env.counters().scanCycles, env.counters().warpNoStart,
        env.w.count("warpShips")], ["SCAN", cycles, 1, 1], "grace over: SCAN, warpNoStart");
    });
  });

  needsDriver("HC7 BUG player-hunt-wiped-on-spawn: hunters spawn keepMaterialized (the simulated vendor "
    + "dormancy leaves them alone); never seen -> SPAWN_NOT_VISIBLE with the diagnostic line; seen then gone -> WIPED",
  () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("hc7a", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(0);
      env.pass(1000);
      assert.deepStrictEqual(env.w.keep, [true, true, true]);
      assert.deepStrictEqual([env.rows()[0].state, env.live()[0].alive, env.counters().spawnNotVisible],
        ["LIVE", 3, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      const fleetId = env.newFleet("hc7b", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(0);
      const ships = [...env.w.npc.keys()];
      env.w.npc.clear();
      env.pass(1000);
      const [row] = env.rows();
      assert.deepStrictEqual([row.state, row.end_reason], ["ENDED", "SPAWN_NOT_VISIBLE"]);
      assert.deepStrictEqual([env.counters().spawnNotVisible, env.counters().ended], [1, 1]);
      const line = env.lines.find((l) => l.includes("spawn not visible"));
      assert.ok(line, env.lines.join("\n"));
      assert.ok(line.includes(`spawned=[${ships.join(",")}]`) && line.includes("read=[]"), line);
      assert.ok(line.includes(`explain=${ships.map((id) => `${id}:scene=0,ctl=0`).join(";")}`), line);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
      assert.strictEqual(env.budget.getStatus().reservedShips, 0);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("hc7c", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(0);
      env.pass(1000);
      assert.strictEqual(env.rows()[0].state, "LIVE");
      env.w.npc.clear();
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "WIPED"]]);
      assert.strictEqual(env.counters().spawnNotVisible, 0);
    });
  });

  function engageThenJump(env) {
    const fleetId = env.newFleet("hcp", PIRATE);
    env.standings.set(`103:${PIRATE}`, -6);
    env.w.player(103);
    env.pass(1000);
    assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
    const lead = env.w.npc.get([...env.w.npc.keys()][0]);
    env.w.player(103, { position: { ...lead.position } });
    env.pass(1000);
    assert.strictEqual(env.live()[0].phase, "ENGAGED");
    env.w.objects.set(SYS2, OBJECTS_SYS2);
    env.w.routes.set(`${SYS}:${SYS2}`, 1);
    env.w.player(103, { systemId: SYS2 });
    return fleetId;
  }

  needsDriver("HC-P1 pursuit: quarry out of SYS and in space of SYS2 after a contact -> PURSUIT in the same "
    + "pass (ships despawned in SYS, fleet TRAVELLING, 1 pursuit); no spawn and no fleet read before arriveAt; IDLE in "
    + "SYS2 -> new LIVE hunt anchored at the gate back to SYS despite cooldownMs / noticeDelayMs; flag off = "
    + "TARGET_GONE after exitGraceMs", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { pursuitEnabled: true, objectKinds: "station,stargate,asteroidBelt,planet" } });
      const fleetId = engageThenJump(env);
      const shipsX = [...env.w.npc.keys()];
      const t = env.clock.now() + 1000;
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "PURSUIT"]]);
      assert.ok(env.w.calls.some((c) => c[0] === "despawn" && c[1].join(",") === shipsX.join(",")), "despawn in SYS");
      assert.strictEqual(env.w.npc.size, 0);
      const st = env.step.getStatus();
      assert.strictEqual(st.ships, 0, "no ship of the pursuit outside the system of the player");
      assert.strictEqual(st.pursuits.length, 1);
      const p = st.pursuits[0];
      assert.deepStrictEqual([p.fleetId, p.fromSystemId, p.targetSystemId, p.hops, p.characterId, p.arriveAt],
        [fleetId, SYS, SYS2, 1, 103, t + JUMP_MS]);
      assert.strictEqual(env.counters().pursuitStarted, 1);
      const f = env.fleet(fleetId);
      assert.deepStrictEqual([f.state, f.operationId], ["TRAVELLING", p.operationId]);

      env.config.playerHunt.noticeDelayMs = 600000;
      const spawns = env.w.count("spawnShip");
      const reads = env.fleetReads;
      while (env.clock.now() + 10000 < p.arriveAt) env.pass(10000);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.fleetReads], [spawns, reads]);

      env.arrive(fleetId, SYS2);
      env.pass(p.arriveAt - env.clock.now());
      const spawnCalls = env.w.calls.filter((c) => c[0] === "spawnShip");
      assert.deepStrictEqual(spawnCalls[spawnCalls.length - 1][1], { kind: "stargate", itemID: GATE_BACK });
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.character_id]), [["ENDED", 103], ["LIVE", 103]],
        "a new hunt on the same character within cooldownMs");
      assert.ok(env.clock.now() - t < env.config.playerHunt.cooldownMs);
      assert.strictEqual(env.live()[0].systemId, SYS2);
      assert.strictEqual(env.counters().pursuitRematerialized, 1);
      assert.strictEqual(env.step.getStatus().pursuits.length, 0);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      engageThenJump(env);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"], "flag off: no pursuit");
      env.pass(env.config.playerHunt.exitGraceMs);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "TARGET_GONE"]]);
      assert.deepStrictEqual([env.w.count("planInTx"), env.w.count("findRoute"), env.counters().pursuitStarted],
        [0, 0, 0]);
    });
  });

  needsDriver("HC-P2 pursuit after the arrival: the quarry one jump further -> pursueNextInTx hop 2; the quarry "
    + "docked in the target -> pursuitArrivalWaitMs -> pursuitGaveUp, the fleet untouched", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { pursuitEnabled: true } });
      const fleetId = engageThenJump(env);
      env.pass(1000);
      const p = env.step.getStatus().pursuits[0];
      env.w.routes.set(`${SYS2}:${SYS3}`, 1);
      env.w.player(103, { systemId: SYS3 });
      env.arrive(fleetId, SYS2);
      env.pass(p.arriveAt - env.clock.now());
      const q = env.step.getStatus().pursuits[0];
      assert.deepStrictEqual([q.hops, q.fromSystemId, q.targetSystemId, q.chainId], [2, SYS2, SYS3, p.chainId]);
      assert.notStrictEqual(q.operationId, p.operationId);
      assert.strictEqual(env.counters().pursuitHops, 1);
      const f = env.fleet(fleetId);
      assert.deepStrictEqual([f.state, f.operationId, f.targetSystemId], ["TRAVELLING", q.operationId, SYS3]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { pursuitEnabled: true } });
      const fleetId = engageThenJump(env);
      env.pass(1000);
      const p = env.step.getStatus().pursuits[0];
      env.w.player(103, { systemId: SYS2, state: "docked" });
      env.arrive(fleetId, SYS2);
      const before = env.fleet(fleetId);
      const spawns = env.w.count("spawnShip");
      env.pass(p.arriveAt - env.clock.now());
      assert.strictEqual(env.step.getStatus().pursuits.length, 1, "waits");
      env.pass(env.config.playerHunt.pursuitArrivalWaitMs);
      assert.strictEqual(env.counters().pursuitGaveUp, 1);
      assert.strictEqual(env.step.getStatus().pursuits.length, 0);
      const after = env.fleet(fleetId);
      assert.deepStrictEqual([after.state, after.version, after.currentSystemId], ["IDLE", before.version, SYS2]);
      assert.strictEqual(env.w.count("spawnShip"), spawns);
    });
  });

  const OBJECTS_EXIT_FAR = Object.freeze([{ kind: "stargate", itemId: 50000001, position: pos(0), toSystemId: SYS3 },
    { kind: "station", itemId: 60000001, position: pos(1e10) }, { kind: "planet", itemId: 40000001, position: pos(2e10) },
    { kind: "stargate", itemId: 50000002, position: pos(3e10), toSystemId: 30000146 }]);
  const OBJECTS_EXIT_SYS2 = Object.freeze([{ kind: "stargate", itemId: 50000001, position: pos(0), toSystemId: SYS3 },
    { kind: "station", itemId: 60000001, position: pos(1e10) },
    { kind: "stargate", itemId: 50000003, position: pos(3e10), toSystemId: SYS2 }]);
  const EXIT_COUNTERS = Object.freeze(["exitStarted", "exitLanded", "exitForced", "retreated", "returnStarted",
    "returnRefused"]);
  const countersOf = (env, names) => names.map((n) => env.counters()[n]);

  function retreatScene(env, onGrid) {
    env.w.objects.set(SYS, OBJECTS_EXIT_FAR);
    env.w.routes.set(`${SYS}:${SYS2}`, 2);
    const fleetId = env.newFleet("px", PIRATE, { homeSystemId: SYS2 });
    env.standings.set(`103:${PIRATE}`, -6);
    env.w.player(103);
    env.pass(1000);
    assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
    const ships = [...env.w.npc.keys()];
    const lead = { ...env.w.npc.get(ships[0]).position };
    if (onGrid) {
      env.w.player(103, { position: { ...lead } });
      env.pass(1000);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
    }
    env.w.kill(ships[1]);
    env.w.kill(ships[2]);
    return { fleetId, ships, lead };
  }

  needsDriver("PX3 retreat: 2 of 3 lost with the quarry on grid -> search, warp to the gate "
    + "station farthest from the quarry, no despawn while in warp; landed -> despawn + endWithReturnInTx home; "
    + "nobody on grid -> despawn in the same pass", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { exitEnabled: true, retreatEnabled: true } });
      const { fleetId, ships, lead } = retreatScene(env, true);
      const far = OBJECTS_EXIT_FAR.filter((o) => o.kind !== "planet")
        .map((o) => ({ o, d: ((o.position.x - lead.x) ** 2) + ((o.position.y - lead.y) ** 2) }))
        .sort((a, b) => b.d - a.d)[0].o;
      const n = env.w.calls.length;
      env.pass(1000);
      const tail = env.w.calls.slice(n).filter((c) => ["setSearch", "warpShips", "despawn"].includes(c[0]));
      assert.deepStrictEqual(tail.map((c) => c[0]), ["setSearch", "warpShips"], "search -> warp, no despawn");
      assert.deepStrictEqual(tail[1][2], far.position);
      assert.deepStrictEqual([env.live()[0].phase, env.live()[0].exitReason], ["EXITING", "RETREATED"]);
      assert.ok(env.lines.some((l) => l.includes(`exiting RETREATED via ${far.kind}:${far.itemId}`)));
      env.w.inWarp.add(ships[0]);
      env.pass(1000);
      assert.deepStrictEqual([env.w.count("despawn"), env.rows()[0].state], [0, "LIVE"], "in warp: still in space");
      env.w.inWarp.clear();
      env.pass(1000);
      assert.strictEqual(env.w.count("despawn"), 1);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "RETREATED"]]);
      const f = env.fleet(fleetId);
      assert.deepStrictEqual([f.state, f.targetSystemId, f.shipCount], ["TRAVELLING", SYS2, 1]);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "planInTx").map((c) => c[2]), [SYS2]);
      assert.deepStrictEqual(countersOf(env, EXIT_COUNTERS), [1, 1, 0, 1, 1, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { exitEnabled: true, retreatEnabled: true } });
      const { fleetId } = retreatScene(env, false);
      env.pass(1000);
      assert.deepStrictEqual([env.w.count("warpShips"), env.w.count("despawn")], [0, 1], "nobody watches: at once");
      assert.deepStrictEqual(env.rows().map((r) => r.end_reason), ["RETREATED"]);
      assert.strictEqual(env.fleet(fleetId).state, "TRAVELLING");
      assert.deepStrictEqual(countersOf(env, EXIT_COUNTERS), [0, 0, 0, 1, 1, 0]);
    });
  });

  needsDriver("PX4 flags off: TARGET_GONE despawns in place with a player on grid (no exit "
    + "objects read, no new counter); exit + pursuit with a watcher: warp to the gate to the pursuit target, then "
    + "pursueInTx", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("px4a", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.standings.set(`101:${PIRATE}`, 6);
      const quarry = env.w.player(103);
      env.pass(1000);
      const lead = { ...env.w.npc.get([...env.w.npc.keys()][0]).position };
      env.w.player(101, { position: lead });
      quarry.state = "docked";
      env.pass(1000);
      env.pass(env.config.playerHunt.exitGraceMs);
      assert.deepStrictEqual(env.rows().map((r) => r.end_reason), ["TARGET_GONE"]);
      assert.deepStrictEqual([env.w.count("warpShips"), env.w.count("despawn")], [0, 1]);
      assert.strictEqual(env.w.calls.filter((c) => c[0] === "listSystemObjects"
        && c[2].join(",") === "stargate,station").length, 0);
      assert.deepStrictEqual(countersOf(env, EXIT_COUNTERS), [0, 0, 0, 0, 0, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { exitEnabled: true, pursuitEnabled: true } });
      env.w.objects.set(SYS, OBJECTS_EXIT_SYS2);
      env.standings.set(`101:${PIRATE}`, 6);
      engageThenJump(env);
      const lead = { ...env.w.npc.get([...env.w.npc.keys()][0]).position };
      env.w.player(101, { position: lead });
      const n = env.w.calls.length;
      env.pass(1000);
      const tail = env.w.calls.slice(n).filter((c) => c[0] === "setSearch" || c[0] === "warpShips");
      assert.deepStrictEqual(tail.map((c) => c[0]), ["setSearch", "warpShips"]);
      assert.deepStrictEqual(tail[1][2], OBJECTS_EXIT_SYS2[2].position, "the gate to the pursuit target");
      assert.deepStrictEqual([env.rows()[0].state, env.live()[0].phase, env.w.count("planInTx")],
        ["LIVE", "EXITING", 0]);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "PURSUIT"]]);
      assert.deepStrictEqual([env.counters().pursuitStarted, env.counters().exitForced, env.w.count("planInTx")],
        [1, 1, 1]);
    });
  });

  needsDriver("PX5 (): 1 of 3 spawned ships visible (2 never seen) with the quarry on grid "
    + "-> no RETREATED, ENGAGED; the exit station on the grid of the lead ship -> RETREATED at once without a warp, "
    + "exitLanded (not exitStarted / exitForced)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { exitEnabled: true, retreatEnabled: true } });
      env.newFleet("px5a", PIRATE, { homeSystemId: SYS2 });
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
      const ships = [...env.w.npc.keys()];
      env.w.npc.delete(ships[1]);
      env.w.npc.delete(ships[2]);
      env.w.player(103, { position: { ...env.w.npc.get(ships[0]).position } });
      env.pass(1000);
      env.pass(1000);
      assert.deepStrictEqual([env.rows()[0].state, env.live()[0].phase], ["LIVE", "ENGAGED"]);
      assert.deepStrictEqual(countersOf(env, EXIT_COUNTERS), [0, 0, 0, 0, 0, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { exitEnabled: true, retreatEnabled: true } });
      env.w.objects.set(SYS, [{ kind: "station", itemId: 60000001, position: pos(0) }]);
      env.w.routes.set(`${SYS}:${SYS2}`, 2);
      const fleetId = env.newFleet("px5b", PIRATE, { homeSystemId: SYS2 });
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(1000);
      const ships = [...env.w.npc.keys()];
      env.w.player(103, { position: { ...env.w.npc.get(ships[0]).position } });
      env.pass(1000);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
      env.w.kill(ships[1]);
      env.w.kill(ships[2]);
      env.pass(1000);
      assert.strictEqual(env.w.count("warpShips"), 0, "on grid: no warp");
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "RETREATED"]]);
      assert.strictEqual(env.fleet(fleetId).state, "TRAVELLING");
      assert.deepStrictEqual(countersOf(env, EXIT_COUNTERS), [0, 1, 0, 1, 1, 0]);
    });
  });

  const CAMP_ON = Object.freeze({ dockCampEnabled: true, returnHomeEnabled: true });
  const CAMP_COUNTERS = Object.freeze(["campStarted", "campEngaged", "campEnded", "returnStarted"]);
  const NEAR_STATION = pos(1e10 + 5000);

  function dockScene(env) {
    env.w.routes.set(`${SYS}:${SYS2}`, 2);
    const fleetId = env.newFleet("hcc", PIRATE, { homeSystemId: SYS2 });
    env.standings.set(`103:${PIRATE}`, -6);
    env.w.player(103, { position: { ...NEAR_STATION } });
    env.pass(1000);
    env.pass(1000);
    assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
    env.w.player(103, { position: { ...NEAR_STATION }, state: "docked" });
    const n = env.w.calls.length;
    env.pass(1000);
    const tail = env.w.calls.slice(n).filter((c) => c[0] === "setSearch" || c[0] === "warpShips");
    assert.deepStrictEqual(tail.map((c) => c[0]), ["setSearch", "warpShips"]);
    assert.deepStrictEqual(tail[1][2], pos(1e10), "the station nearest to the last position");
    assert.strictEqual(env.live()[0].phase, "CAMP");
    assert.ok(env.lines.some((l) => l.includes("camping station 60000001")));
    return fleetId;
  }

  needsDriver("PC3 camp: quarry docked -> search + warp to its station, no end after exitGraceMs "
    + "dockCampMs -> despawn + endWithReturnInTx(TARGET_DOCKED) home; undock on grid -> attack (campEngaged)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: CAMP_ON });
      const fleetId = dockScene(env);
      env.pass(env.config.playerHunt.exitGraceMs + 1000);
      assert.deepStrictEqual([env.rows()[0].state, env.live()[0].phase], ["LIVE", "CAMP"], "no exitGraceMs");
      env.pass(env.config.playerHunt.dockCampMs);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "TARGET_DOCKED"]]);
      assert.strictEqual(env.w.count("despawn"), 1);
      assert.deepStrictEqual([env.fleet(fleetId).state, env.fleet(fleetId).targetSystemId], ["TRAVELLING", SYS2]);
      assert.deepStrictEqual(countersOf(env, CAMP_COUNTERS), [1, 0, 1, 1]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: CAMP_ON });
      dockScene(env);
      const quarry = env.w.player(103, { position: pos(1e10) });
      env.pass(1000);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
      const attack = env.w.calls.filter((c) => c[0] === "attackTargets").pop();
      assert.deepStrictEqual(attack[2], [quarry.entityId]);
      assert.deepStrictEqual(countersOf(env, CAMP_COUNTERS), [1, 1, 0, 0]);
    });
  });

  needsDriver("PC4 pursuit gave up with a fleet without home -> returnHomeInTx to the first system of the "
    + "chain; a new hunt on the same character within pursuitChainCooldownMs -> no pursuit, TARGET_GONE", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { pursuitEnabled: true, returnHomeEnabled: true, cooldownMs: 0,
        pursuitChainCooldownMs: 600000 } });
      const fleetId = env.newFleet("pc4", PIRATE, { homeSystemId: null });
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(1000);
      env.w.player(103, { position: { ...env.w.npc.get([...env.w.npc.keys()][0]).position } });
      env.pass(1000);
      env.w.objects.set(SYS2, OBJECTS_SYS2);
      env.w.routes.set(`${SYS}:${SYS2}`, 1);
      env.w.routes.set(`${SYS2}:${SYS}`, 1);
      env.w.player(103, { systemId: SYS2 });
      env.pass(1000);
      const p = env.step.getStatus().pursuits[0];
      env.w.player(103, { systemId: SYS2, state: "docked" });
      env.arrive(fleetId, SYS2);
      env.pass(p.arriveAt - env.clock.now());
      env.pass(env.config.playerHunt.pursuitArrivalWaitMs);
      assert.deepStrictEqual([env.counters().pursuitGaveUp, env.counters().returnStarted], [1, 1]);
      const f = env.fleet(fleetId);
      assert.deepStrictEqual([f.state, f.targetSystemId], ["TRAVELLING", SYS]);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "planInTx").map((c) => c[2]), [SYS2, SYS]);

      env.newFleet("pc4b", PIRATE);
      env.w.player(103, { systemId: SYS, state: "space", position: FAR });
      env.pass(1000);
      assert.deepStrictEqual(env.live().map((h) => h.systemId), [SYS]);
      env.w.player(103, { position: { ...env.w.npc.get([...env.w.npc.keys()][0]).position } });
      env.pass(1000);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
      env.w.player(103, { systemId: SYS2 });
      env.pass(1000);
      env.pass(env.config.playerHunt.exitGraceMs);
      assert.strictEqual(env.rows().pop().end_reason, "TARGET_GONE");
      assert.deepStrictEqual([env.counters().pursuitStarted, env.w.count("planInTx")], [1, 2]);
    });
  });

  needsDriver("PHA2 BUG pursuit-hunt-does-not-attack: a neutral (standing 0) player in align on the grid of a "
    + "pirate hunt -> attackTargets with its entityId", () => {
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("pha2", PIRATE);
      const quarry = env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.standing]), [["LIVE", 0]]);
      const ships = [...env.w.npc.keys()];
      const lead = env.w.npc.get(ships[0]).position;
      quarry.position = { ...lead, x: lead.x + 1000 };
      quarry.aligning = true;
      env.pass(1000);
      const attacks = env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => [c[1][0], c[2][0]]);
      assert.deepStrictEqual(attacks, ships.map((s) => [s, quarry.entityId]));
    });
  });

  needsDriver("PN2 NPC aggressor of another faction on grid -> attack in the same pass "
    + "ENGAGED, npcTargeted/npcRetaliated; same faction / unknown / battle or hunt ship / off grid / in warp / not npc "
    + "-> no order; flag off -> as before; OUTNUMBERED counts it; d-scan: the first warp goes to the object nearest "
    + "the quarry", () => {
    const NPC_COUNTERS = ["npcTargeted", "npcRetaliated", "retaliated", "dscanRanked"];
    const npcAt = (where, id, factionId, extra = {}) => ({ aggressorId: id, aggressorKind: "npc",
      aggressorFactionId: factionId, aggressorPosition: { ...where, x: where.x + 1000 }, aggressorInWarp: false,
      ...extra });
    const attacks = (env) => env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => [c[1][0], c[2][0]]);
    const liveHunt = (env, key) => {
      env.newFleet(key, PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
      const ships = [...env.w.npc.keys()];
      return { ships, lead: { ...env.w.npc.get(ships[0]).position } };
    };
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { npcAggressorsEnabled: true } });
      const { ships, lead } = liveHunt(env, "pn2a");
      for (const [why, rec] of [["same faction (assist)", npcAt(lead, 9001, PIRATE)],
        ["unknown faction", npcAt(lead, 9002, null)], ["LIVE battle ship", npcAt(lead, 9003, EMPIRE)],
        ["hunt ship", npcAt(lead, ships[2], EMPIRE)], ["off grid", npcAt(lead, 9004, EMPIRE, { aggressorPosition: FAR })],
        ["in warp", npcAt(lead, 9005, EMPIRE, { aggressorInWarp: true })],
        ["not an npc", npcAt(lead, 9006, EMPIRE, { aggressorKind: "other" })]]) {
        env.battleShips = new Set([9003]);
        env.w.aggressors.set(ships[0], rec);
        env.pass(1000);
        assert.deepStrictEqual(attacks(env), [], why);
      }
      env.w.aggressors.set(ships[0], npcAt(lead, 9007, EMPIRE));
      env.pass(1000);
      assert.deepStrictEqual(attacks(env), ships.map((s) => [s, 9007]), "every ship on the NPC in this pass");
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
      env.pass(1000);
      assert.strictEqual(attacks(env).length, 3, "no churn");
      assert.deepStrictEqual(countersOf(env, NPC_COUNTERS), [1, 1, 0, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      const { ships, lead } = liveHunt(env, "pn2b");
      env.w.aggressors.set(ships[0], npcAt(lead, 9007, EMPIRE));
      env.pass(1000);
      assert.deepStrictEqual([attacks(env), env.live()[0].phase], [[], "SWEEP_DWELL"], "flag off: as before");
      assert.deepStrictEqual(countersOf(env, NPC_COUNTERS), [0, 0, 0, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { npcAggressorsEnabled: true, retreatEnabled: true, retreatLossPermille: 1000,
        retreatOutnumberPermille: 2000 } });
      const { ships, lead } = retreatScene(env, true);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"], "1 target / 1 hunter: no retreat");
      env.w.aggressors.set(ships[0], npcAt(lead, 9008, EMPIRE));
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "RETREATED"]]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { dscanEnabled: true } });
      env.newFleet("pn2d", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      const q = pos(2e10 + 5e8);
      env.w.player(103, { position: q });
      env.pass(1000);
      const [row] = env.rows();
      const order = sweepOrder(OBJECTS, ["stargate", "station", "asteroidBelt", "planet"], row.seed)
        .map((o) => OBJECTS.find((x) => x.itemId === o.itemId));
      const spawn = env.w.calls.find((c) => c[0] === "spawnShip");
      assert.deepStrictEqual(spawn[1], { kind: order[0].kind, itemID: order[0].itemId }, "anchor unchanged");
      const nearest = order.slice(1).sort((a, b) => Math.abs(a.position.x - q.x) - Math.abs(b.position.x - q.x))[0];
      env.pass(env.config.playerHunt.objectDwellMs);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "warpShips").map((c) => c[2]), [nearest.position]);
      assert.notStrictEqual(nearest, order[1], "the case shows the d-scan order");
      assert.strictEqual(env.counters().dscanRanked, 1);
    });
  });

  const GARRISON_SHIP = 9101;
  const LNE_COUNTERS = ["lneRetaliated", "lneArmed", "lneArmFailed", "lneArmDeferred", "npcTargeted"];
  const lneScene = (opened, ph) => {
    const env = setup(opened, { lne: true, ph });
    env.lneGroups = [{ systemId: SYS, factionId: EMPIRE, entityIds: [GARRISON_SHIP], source: "patrol" }];
    env.newFleet("hl", PIRATE);
    env.standings.set(`103:${PIRATE}`, -6);
    env.w.player(103);
    env.pass(1000);
    assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
    const ships = [...env.w.npc.keys()];
    const lead = env.w.npc.get(ships[0]).position;
    env.w.aggressors.set(ships[0], { aggressorId: GARRISON_SHIP, aggressorKind: "npc", aggressorFactionId: null,
      aggressorPosition: { ...lead, x: lead.x + 1000 }, aggressorInWarp: false });
    return { env, ships };
  };
  const lneAttacks = (env) => env.w.calls.filter((c) => c[0] === "attackTargets").map((c) => [c[1][0], c[2][0]]);
  const armCalls = (env) => env.w.calls.filter((c) => c[0] === "armNpcCombat").map((c) => c[2]);

  needsDriver("HL1 gem an LNE aggressor of an enemy faction -> armed (own + aggressor), attack "
    + "order, lneRetaliated 1 (no second arm); an allied faction -> no target", () => {
    withStore(driver, (opened) => {
      const { env, ships } = lneScene(opened);
      env.enemies.add(`${PIRATE}:${EMPIRE}`);
      env.pass(1000);
      assert.deepStrictEqual(armCalls(env), [[...ships, GARRISON_SHIP]]);
      assert.deepStrictEqual(lneAttacks(env), ships.map((s) => [s, GARRISON_SHIP]));
      env.pass(1000);
      assert.deepStrictEqual(armCalls(env).length, 1, "armed once");
      assert.deepStrictEqual(countersOf(env, LNE_COUNTERS), [1, ships.length + 1, 0, 0, 0]);
      assert.strictEqual(env.step.relationGroups()[0].groupId, env.rows()[0].hunt_id);
    });
    withStore(driver, (opened) => {
      const { env } = lneScene(opened);
      env.pass(1000);
      assert.deepStrictEqual([lneAttacks(env), armCalls(env)], [[], []], "ally: no target");
      assert.deepStrictEqual(countersOf(env, LNE_COUNTERS), [0, 0, 0, 0, 0]);
    });
  });

  needsDriver("HL2 gem playerHunt.lneRetaliationEnabled false -> the LNE aggressor ignored as before, zero "
    + "getLneGroups / armNpcCombat", () => {
    withStore(driver, (opened) => {
      const { env } = lneScene(opened, { lneRetaliationEnabled: false });
      env.enemies.add(`${PIRATE}:${EMPIRE}`);
      env.pass(1000);
      assert.deepStrictEqual([lneAttacks(env), armCalls(env), env.lneReads], [[], [], 0]);
    });
  });

  needsDriver("HL3 gem armNpcCombat fails the aggressor -> no order on it, lneArmFailed 1", () => {
    withStore(driver, (opened) => {
      const { env, ships } = lneScene(opened);
      env.enemies.add(`${PIRATE}:${EMPIRE}`);
      env.w.armResult = { ok: true, armed: ships.length, already: 0, failed: [GARRISON_SHIP] };
      env.pass(1000);
      assert.deepStrictEqual(lneAttacks(env), []);
      assert.deepStrictEqual(countersOf(env, LNE_COUNTERS), [0, ships.length, 1, 0, 0]);
    });
  });

  const APPROACH = Object.freeze({ pursuitEnabled: true, approachEnabled: true,
    objectKinds: "station,stargate,asteroidBelt,planet" });
  function approachScene(env) {
    env.w.objects.set(SYS2, OBJECTS_SYS2);
    env.w.neighbors.set(SYS2, [SYS3, SYS]);
    env.w.neighbors.set(SYS, [SYS2]);
    env.w.routes.set(`${SYS}:${SYS2}`, 1);
    env.standings.set(`103:${PIRATE}`, -6);
    env.w.player(103, { systemId: SYS2 });
  }

  needsDriver("AP3/AP4 approach: no fleet in SYS2, an IDLE candidate 1 jump away -> refusedNoCandidate "
    + "approachStarted, pursuits entry kind approach hops 1, fleet TRAVELLING; the arrival -> LIVE hunt anchored at the "
    + "gate back to SYS (pursuitRematerialized); approachEnabled off = zero approach reads", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: APPROACH });
      approachScene(env);
      const fleetId = env.newFleet("ap3", PIRATE);
      const t = env.clock.now() + 1000;
      env.pass(1000);
      assert.deepStrictEqual([env.counters().refusedNoCandidate, env.counters().approachStarted, env.approachReads],
        [1, 1, 1]);
      const st = env.step.getStatus();
      assert.strictEqual(st.pursuits.length, 1);
      const p = st.pursuits[0];
      assert.deepStrictEqual([p.kind, p.fleetId, p.fromSystemId, p.targetSystemId, p.hops, p.characterId, p.arriveAt],
        ["approach", fleetId, SYS, SYS2, 1, 103, t + JUMP_MS]);
      assert.ok(p.chainId.startsWith(`apr:${fleetId}:`), p.chainId);
      const f = env.fleet(fleetId);
      assert.deepStrictEqual([f.state, f.operationId, f.targetSystemId], ["TRAVELLING", p.operationId, SYS2]);
      assert.strictEqual(env.w.count("spawnShip"), 0, "no ship outside the system of the player");

      env.arrive(fleetId, SYS2);
      env.pass(p.arriveAt - env.clock.now());
      const spawnCalls = env.w.calls.filter((c) => c[0] === "spawnShip");
      assert.ok(spawnCalls.length > 0);
      assert.deepStrictEqual(spawnCalls[spawnCalls.length - 1][1], { kind: "stargate", itemID: GATE_BACK });
      assert.deepStrictEqual([env.counters().started, env.counters().pursuitRematerialized], [1, 1]);
      assert.deepStrictEqual(env.live().map((h) => [h.systemId, h.characterId, h.fleetId]), [[SYS2, 103, fleetId]]);
      assert.strictEqual(env.step.getStatus().pursuits.length, 0);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...APPROACH, approachEnabled: false } });
      approachScene(env);
      const fleetId = env.newFleet("ap3-off", PIRATE);
      env.pass(1000);
      env.pass(120000);
      assert.ok(env.counters().refusedNoCandidate >= 1);
      assert.deepStrictEqual([env.approachReads, env.counters().approachStarted, env.counters().approachNoCandidate,
        env.counters().approachRefused, env.step.getStatus().pursuits.length], [0, 0, 0, 0, 0]);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
    });
  });

  needsDriver("AP5 approach limits: approachNoCandidate throttles the system for approachRetryMs (0 reads); an "
    + "approach on the way -> no second; cooldown (character, faction) and a friendly standing block it", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: APPROACH });
      approachScene(env);
      env.pass(1000);
      assert.deepStrictEqual([env.approachReads, env.counters().approachNoCandidate], [1, 1]);
      assert.strictEqual(env.step.getStatus().lastRefusal.reason, "APPROACH_NO_CANDIDATE");
      env.pass(1000);
      assert.deepStrictEqual([env.approachReads, env.counters().approachNoCandidate], [1, 1], "throttled");
      env.pass(env.config.playerHunt.approachRetryMs);
      assert.deepStrictEqual([env.approachReads, env.counters().approachNoCandidate], [2, 2]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: APPROACH });
      approachScene(env);
      env.newFleet("ap5-a", PIRATE);
      env.newFleet("ap5-b", PIRATE);
      env.pass(1000);
      env.pass(1000);
      env.pass(env.config.playerHunt.approachRetryMs);
      assert.deepStrictEqual([env.counters().approachStarted, env.approachReads, env.step.getStatus().pursuits.length],
        [1, 1, 1], "one approach to SYS2 at a time");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: APPROACH });
      approachScene(env);
      const fleetId = env.newFleet("ap5-cool", PIRATE);
      const c = env.tx((db) => env.ph.claimInTx(db, { fleetId, expectedVersion: 1, characterId: 103, systemId: SYS,
        mode: "SWEEP", standing: -6, at: env.clock.now() }));
      assert.ok(c.ok, JSON.stringify(c));
      assert.ok(env.tx((db) => env.ph.endInTx(db, { huntId: c.huntId, at: env.clock.now(), reason: "TARGET_GONE" })).ok);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
      env.pass(1000);
      assert.deepStrictEqual([env.counters().approachStarted, env.counters().approachNoCandidate,
        env.counters().refusedCooldown], [0, 1, 0]);
      assert.strictEqual(env.step.getStatus().lastRefusal.reason, "APPROACH_COOLDOWN");
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: APPROACH });
      approachScene(env);
      env.standings.set(`103:${PIRATE}`, 6);
      const fleetId = env.newFleet("ap5-friend", PIRATE);
      env.pass(1000);
      assert.deepStrictEqual([env.counters().approachStarted, env.counters().approachNoCandidate,
        env.counters().refusedStanding], [0, 1, 0]);
      assert.strictEqual(env.step.getStatus().lastRefusal.reason, "APPROACH_STANDING");
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
    });
  });

  const CLAIM_ON = Object.freeze({ claimHuntsEnabled: true, claimMaxShips: 16 });

  function claimScene(env, holderShips) {
    const other = env.newFleet("ch-other", EMPIRE, { composition: [{ hullGroup: "cruiser", count: 5 }] });
    const holder = env.newFleet("ch-holder", PIRATE, { fleetRole: "invasion", homeSystemId: SYS2,
      composition: [{ hullGroup: "cruiser", count: holderShips }] });
    assert.ok(other < holder, `${other} < ${holder}`);
    const op = env.tx((db) => env.fleets.createOperation(db, { operationType: "invasion", factionId: PIRATE,
      originSystemId: SYS2, targetSystemId: SYS, objective: "capture", dueAt: START_MS + 7200000,
      fleets: [{ fleetId: holder, expectedVersion: 1 }] }, "test:ch:op"));
    assert.ok(op.ok, JSON.stringify(op));
    assert.ok(env.tx((db) => env.fleets.transitionOperation(db, { operationId: op.operationId, expectedVersion: 1,
      from: "PLANNED", to: "ACTIVE" }, "test:ch:active")).ok);
    const planned = env.fleet(holder);
    assert.ok(env.tx((db) => env.fleets.transition(db, { fleetId: holder, expectedVersion: planned.version,
      from: "PLANNED", to: "STAGED" }, "test:ch:stage")).ok);
    const repels = [];
    env.occupation = {
      claimOfInTx: (db, systemId) => ({ ok: true, claim: systemId === SYS
        ? { systemId, state: "INVASION", occupierFactionId: PIRATE, phaseSeq: 3 } : null }),
      applyPlayerRepelInTx: (db, req, key) => {
        repels.push([req.huntId, req.factionId, key]);
        return { ok: true, outcome: "APPLIED" };
      },
    };
    const real = env.ph;
    const claims = [];
    env.ph = { ...real, claimInTx: (db, req) => {
      claims.push({ ...req });
      return real.claimInTx(db, req);
    } };
    env.standings.set(`103:${PIRATE}`, -6);
    env.standings.set(`103:${EMPIRE}`, -6);
    env.w.player(103);
    return { other, holder, operationId: op.operationId, claims, repels };
  }

  const opStateOf = (env, operationId) => env.tx((db) => env.fleets.getOperation(db, operationId)).operation.state;
  const huntFleets = (env) => env.step.getStatus().hunts.map((h) => [h.fleetId, h.claim]);

  needsDriver("CH3 pump: INVASION of P with its holder STAGED 14 ships and a hostile "
    + "player -> claim hunt of the holder (unstage true, claimStarted 1) before the other faction with the smaller "
    + "fleetId; claimHuntsEnabled=false -> the plain hunt of the other faction; holder 20 ships -> claimRefusedSize",
  () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: CLAIM_ON });
      const sc = claimScene(env, 14);
      env.pass(1000);
      assert.deepStrictEqual(huntFleets(env), [[sc.holder, true]]);
      assert.deepStrictEqual(sc.claims.map((c) => [c.fleetId, c.unstage]), [[sc.holder, true]]);
      assert.deepStrictEqual([env.counters().claimStarted, env.counters().claimUnstaged, env.counters().started],
        [1, 1, 1]);
      const f = env.fleet(sc.holder);
      assert.deepStrictEqual([f.state, f.operationId], ["MATERIALIZED", null]);
      assert.strictEqual(opStateOf(env, sc.operationId), "ACTIVE");
      assert.strictEqual(env.w.count("spawnShip"), 14);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
      assert.strictEqual(env.fleet(sc.other).state, "IDLE");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...CLAIM_ON, claimHuntsEnabled: false } });
      const sc = claimScene(env, 14);
      env.pass(1000);
      assert.deepStrictEqual(huntFleets(env), [[sc.other, false]], "off: the plain path");
      assert.deepStrictEqual(sc.claims.map((c) => [c.fleetId, Object.prototype.hasOwnProperty.call(c, "unstage")]),
        [[sc.other, false]]);
      assert.deepStrictEqual([env.counters().claimStarted, env.fleet(sc.holder).state], [0, "STAGED"]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...CLAIM_ON, oversizeDetachmentEnabled: false } });
      const sc = claimScene(env, 20);
      env.pass(1000);
      assert.deepStrictEqual(huntFleets(env), [[sc.other, false]], "holder above claimMaxShips: the plain path");
      assert.deepStrictEqual([env.counters().claimRefusedSize, env.counters().claimStarted], [1, 0]);
      assert.deepStrictEqual([env.fleet(sc.holder).state, opStateOf(env, sc.operationId)], ["STAGED", "ACTIVE"]);
    });
  });

  needsDriver("CH4 claim hunt: 7 of 14 lost at claimRepelLossPermille 500 -> "
    + "RETREATED and endWithReturnInTx to the fleet home with retreatEnabled=false, repelApplied 1; the quarry in the "
    + "next system with pursuitEnabled -> no PURSUIT (TARGET_GONE)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...CLAIM_ON, claimRepelLossPermille: 500 } });
      assert.strictEqual(env.config.playerHunt.retreatEnabled, false);
      env.w.routes.set(`${SYS}:${SYS2}`, 2);
      const sc = claimScene(env, 14);
      env.standings.set(`103:${EMPIRE}`, 0);
      env.pass(1000);
      assert.deepStrictEqual(huntFleets(env), [[sc.holder, true]]);
      env.pass(1000);
      const ships = [...env.w.npc.keys()];
      for (const id of ships.slice(0, 7)) env.w.kill(id);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "RETREATED"]]);
      const f = env.fleet(sc.holder);
      assert.deepStrictEqual([f.state, f.targetSystemId, f.shipCount], ["TRAVELLING", SYS2, 7]);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "planInTx").map((c) => c[2]), [SYS2]);
      assert.deepStrictEqual([env.counters().retreated, env.counters().returnStarted, env.counters().repelApplied,
        env.counters().repelRefused], [1, 1, 1, 0]);
      assert.deepStrictEqual(sc.repels.map((r) => r[1]), [PIRATE]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...CLAIM_ON, pursuitEnabled: true } });
      const sc = claimScene(env, 14);
      env.standings.set(`103:${EMPIRE}`, 0);
      env.pass(1000);
      assert.deepStrictEqual(huntFleets(env), [[sc.holder, true]]);
      const lead = env.w.npc.get([...env.w.npc.keys()][0]);
      env.w.player(103, { position: { ...lead.position } });
      env.pass(1000);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
      env.w.objects.set(SYS2, OBJECTS_SYS2);
      env.w.routes.set(`${SYS}:${SYS2}`, 1);
      env.w.player(103, { systemId: SYS2 });
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"], "a claim hunt never pursues");
      env.pass(env.config.playerHunt.exitGraceMs);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "TARGET_GONE"]]);
      assert.deepStrictEqual([env.counters().pursuitStarted, env.w.count("findRoute"), env.w.count("planInTx")],
        [0, 0, 0]);
      assert.deepStrictEqual([env.fleet(sc.holder).state, env.counters().repelApplied, env.counters().repelRefused],
        ["IDLE", 0, 0], "no losses: no repel, a quiet refusal");
    });
  });

  function countReturns(env) {
    const calls = [];
    const real = env.ph;
    env.ph = { ...real, endWithReturnInTx: (db, req) => {
      calls.push(req.reason);
      return real.endWithReturnInTx(db, req);
    } };
    return calls;
  }

  needsDriver("CH6 claim hunt with returnHomeEnabled: TARGET_GONE -> no "
    + "endWithReturnInTx, MATERIALIZED -> IDLE in its system; RETREATED -> still home (TRAVELLING to SYS2)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...CLAIM_ON, returnHomeEnabled: true } });
      env.w.routes.set(`${SYS}:${SYS2}`, 2);
      const sc = claimScene(env, 14);
      env.standings.set(`103:${EMPIRE}`, 0);
      const returns = countReturns(env);
      env.pass(1000);
      assert.deepStrictEqual(huntFleets(env), [[sc.holder, true]]);
      const lead = env.w.npc.get([...env.w.npc.keys()][0]);
      env.w.player(103, { position: { ...lead.position } });
      env.pass(1000);
      env.w.player(103, { systemId: SYS2 });
      env.pass(1000);
      env.pass(env.config.playerHunt.exitGraceMs);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "TARGET_GONE"]]);
      const f = env.fleet(sc.holder);
      assert.deepStrictEqual([f.state, f.currentSystemId], ["IDLE", SYS]);
      assert.deepStrictEqual([returns.length, env.counters().returnStarted, env.w.count("planInTx")], [0, 0, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...CLAIM_ON, returnHomeEnabled: true, claimRepelLossPermille: 500 } });
      env.w.routes.set(`${SYS}:${SYS2}`, 2);
      const sc = claimScene(env, 14);
      env.standings.set(`103:${EMPIRE}`, 0);
      const returns = countReturns(env);
      env.pass(1000);
      env.pass(1000);
      for (const id of [...env.w.npc.keys()].slice(0, 7)) env.w.kill(id);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "RETREATED"]]);
      const f = env.fleet(sc.holder);
      assert.deepStrictEqual([f.state, f.targetSystemId], ["TRAVELLING", SYS2]);
      assert.deepStrictEqual([returns, env.counters().returnStarted], [["RETREATED"], 1]);
    });
  });

  needsDriver("CH7 repel refusal REPEL_DISABLED -> repelRefused 0 (quiet) "
    + "REPEL_FAILED -> repelRefused 1", () => {
    for (const [reason, refused] of [["REPEL_DISABLED", 0], ["REPEL_FAILED", 1]]) {
      withStore(driver, (opened) => {
        const env = setup(opened, { ph: { ...CLAIM_ON, claimRepelLossPermille: 500 } });
        env.w.routes.set(`${SYS}:${SYS2}`, 2);
        claimScene(env, 14);
        env.standings.set(`103:${EMPIRE}`, 0);
        env.occupation = { ...env.occupation, applyPlayerRepelInTx: () => ({ ok: false, reason }) };
        env.pass(1000);
        env.pass(1000);
        for (const id of [...env.w.npc.keys()].slice(0, 7)) env.w.kill(id);
        env.pass(1000);
        assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "RETREATED"]]);
        assert.deepStrictEqual([env.counters().repelApplied, env.counters().repelRefused], [0, refused], reason);
      });
    }
  });

  needsDriver("CH8 plain hunt of the pretender, 1 loss, then PURSUIT in the "
    + "pump -> the repel of pursueInTx is counted (repelApplied 1)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { pursuitEnabled: true, claimRepelLossPermille: 1 } });
      const repels = [];
      env.occupation = {
        claimOfInTx: (db, systemId) => ({ ok: true, claim: systemId === SYS
          ? { systemId, state: "INVASION", occupierFactionId: PIRATE, phaseSeq: 3 } : null }),
        applyPlayerRepelInTx: (db, req, key) => {
          repels.push([req.huntId, key]);
          return { ok: true, outcome: "APPLIED" };
        },
      };
      env.newFleet("ch8", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(1000);
      const ships = [...env.w.npc.keys()];
      env.w.player(103, { position: { ...env.w.npc.get(ships[0]).position } });
      env.pass(1000);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
      env.w.kill(ships[1]);
      env.pass(1000);
      env.w.objects.set(SYS2, OBJECTS_SYS2);
      env.w.routes.set(`${SYS}:${SYS2}`, 1);
      env.w.player(103, { systemId: SYS2 });
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "PURSUIT"]]);
      assert.deepStrictEqual([env.counters().pursuitStarted, env.counters().repelApplied,
        env.counters().repelRefused, repels.length], [1, 1, 0, 1]);
    });
  });

  needsDriver("SZ3 scale: a frigate quarry -> 2 of 5 ships spawned, budget 2 "
    + "members_json 2, claimInTx maxMembers 2, scaled 1; a capsule -> 1 ship and SWEEP from the detachment (SCAN fleet); "
    + "no hull data -> scaleDefaultShips + scaleUnknownHull; a claim hunt is not scaled; flag off -> the claim request "
    + "without maxMembers and every ship", () => {
    const recordClaims = (env) => {
      const real = env.ph;
      const claims = [];
      env.ph = { ...real, claimInTx: (db, req) => {
        claims.push({ ...req });
        return real.claimInTx(db, req);
      } };
      return claims;
    };
    const SCALE = Object.freeze({ scaleEnabled: true });
    const FIVE = Object.freeze([{ hullGroup: "cruiser", count: 5 }]);
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: SCALE });
      const claims = recordClaims(env);
      env.newFleet("sz3-frig", PIRATE, { composition: FIVE });
      env.w.player(102, { typeId: 587, groupId: 25 });
      env.pass(1000);
      assert.strictEqual(env.w.count("spawnShip"), 2);
      assert.strictEqual(env.budget.getStatus().reservedShips, 2);
      const rows = env.rows();
      assert.deepStrictEqual(rows.map((r) => [r.state, r.mode, JSON.parse(r.members_json).length]), [["LIVE", "SWEEP", 2]]);
      assert.deepStrictEqual(claims.map((c) => c.maxMembers), [2]);
      assert.deepStrictEqual([env.counters().scaled, env.counters().scaleUnknownHull, env.counters().started], [1, 0, 1]);
      assert.ok(env.lines.some((l) => l.includes(" ships=2/5 ")), env.lines.join(" | "));
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: SCALE });
      env.newFleet("sz3-pod", PIRATE, { composition: COMP_SCAN });
      env.w.player(102, { typeId: 670, groupId: 29, capsule: true });
      env.pass(1000);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.rows().map((r) => r.mode)], [1, ["SWEEP"]],
        "The ewar of the fleet is not in the detachment of 1");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: SCALE });
      env.newFleet("sz3-unknown", PIRATE, { composition: FIVE });
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.counters().scaleUnknownHull, env.counters().scaled],
        [env.config.playerHunt.scaleDefaultShips, 1, 1]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...SCALE, ...CLAIM_ON } });
      const sc = claimScene(env, 14);
      env.w.player(103, { typeId: 587, groupId: 25 });
      env.pass(1000);
      assert.deepStrictEqual(huntFleets(env), [[sc.holder, true]]);
      assert.strictEqual(env.w.count("spawnShip"), 14, "A claim hunt is not scaled");
      assert.deepStrictEqual([sc.claims.map((c) => Object.prototype.hasOwnProperty.call(c, "maxMembers")),
        env.counters().scaled, env.counters().scaleUnknownHull], [[false], 0, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      assert.strictEqual(env.config.playerHunt.scaleEnabled, false);
      const claims = recordClaims(env);
      env.newFleet("sz3-off", PIRATE, { composition: FIVE });
      env.w.player(102, { typeId: 587, groupId: 25 });
      env.pass(1000);
      assert.strictEqual(env.w.count("spawnShip"), 5);
      assert.deepStrictEqual(claims.map((c) => Object.keys(c).sort()), [["at", "characterId", "expectedVersion",
        "fleetId", "mode", "standing", "systemId"]]);
      assert.strictEqual(env.w.count("readPlayerShips"), 1, "flag off: no player read for the scale");
      assert.deepStrictEqual([env.counters().scaled, env.counters().scaleUnknownHull], [0, 0]);
      assert.ok(env.lines.some((l) => l.includes(" ships=5 objects=")), env.lines.join(" | "));
    });
  });

  const recordClaimRequests = (env) => {
    const real = env.ph;
    const claims = [];
    env.ph = { ...real, claimInTx: (db, req) => {
      claims.push({ ...req });
      return real.claimInTx(db, req);
    } };
    return claims;
  };

  needsDriver("OV1: a fleet of 14 -> a hunt of 10 (members_json 10, claimInTx "
    + "maxMembers 10, detachmentOversize 1, scaled 0); the larger fleet stays the first candidate "
    + "oversizeDetachmentEnabled=false -> no candidate, nothing spawned", () => {
    const FOURTEEN = Object.freeze([{ hullGroup: "cruiser", count: 14 }]);
    withStore(driver, (opened) => {
      const env = setup(opened);
      assert.deepStrictEqual([env.config.playerHunt.oversizeDetachmentEnabled, env.config.playerHunt.maxShipsPerHunt],
        [true, 10]);
      const claims = recordClaimRequests(env);
      env.newFleet("ov1-big", PIRATE, { composition: FOURTEEN });
      env.w.player(102);
      env.pass(1000);
      assert.strictEqual(env.w.count("spawnShip"), 10);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, JSON.parse(r.members_json).length]), [["LIVE", 10]]);
      assert.deepStrictEqual(claims.map((c) => c.maxMembers), [10]);
      assert.deepStrictEqual([env.counters().detachmentOversize, env.counters().scaled, env.counters().started],
        [1, 0, 1]);
      const opts = { roles: ["patrol"], maxShips: 10, oversizeOk: true, factionKindOf: () => "pirate" };
      const f = (fleetId, shipCount) => ({ fleetId, factionId: PIRATE, state: "IDLE", operationId: null,
        refitPending: false, fleetRole: "patrol", shipCount });
      assert.strictEqual(pickCandidate([f("a", 5), f("b", 14)], opts).fleetId, "b");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { oversizeDetachmentEnabled: false } });
      env.newFleet("ov1-off", PIRATE, { composition: FOURTEEN });
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.rows().length, env.counters().detachmentOversize,
        env.counters().started], [0, 0, 0, 0]);
    });
  });

  needsDriver("OV3: a fleet of 14 hunts with 10 in its own system only - the quarry "
    + "jumps after a contact -> no pursuit (TARGET_GONE path); 1 jump away it never approaches (approachStarted 0)", () => {
    const FOURTEEN = Object.freeze([{ hullGroup: "cruiser", count: 14 }]);
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { pursuitEnabled: true, objectKinds: "station,stargate,asteroidBelt,planet" } });
      const fleetId = env.newFleet("ov3", PIRATE, { composition: FOURTEEN });
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(1000);
      assert.deepStrictEqual([env.rows().map((r) => r.state), env.w.count("spawnShip")], [["LIVE"], 10]);
      const lead = env.w.npc.get([...env.w.npc.keys()][0]);
      env.w.player(103, { position: { ...lead.position } });
      env.pass(1000);
      assert.strictEqual(env.live()[0].phase, "ENGAGED");
      env.w.objects.set(SYS2, OBJECTS_SYS2);
      env.w.routes.set(`${SYS}:${SYS2}`, 1);
      env.w.player(103, { systemId: SYS2 });
      env.pass(1000);
      assert.deepStrictEqual([env.counters().pursuitStarted, env.step.getStatus().pursuits.length], [0, 0]);
      assert.notStrictEqual(env.fleet(fleetId).state, "TRAVELLING");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: APPROACH });
      approachScene(env);
      const fleetId = env.newFleet("ov3-ap", PIRATE, { composition: FOURTEEN });
      env.pass(1000);
      assert.deepStrictEqual([env.counters().approachStarted, env.step.getStatus().pursuits.length,
        env.w.count("spawnShip")], [0, 0, 0]);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
      const small = env.newFleet("ov3-ok", PIRATE, { composition: [{ hullGroup: "cruiser", count: 10 }] });
      env.pass(env.config.playerHunt.approachRetryMs);
      assert.deepStrictEqual([env.counters().approachStarted, env.fleet(small).state], [1, "TRAVELLING"]);
    });
  });

  needsDriver("OV2: a claim holder of 20 ships hunts with 16 (claimMaxShips): "
    + "claimInTx maxMembers 16 and unstage, claimRefusedSize 0, detachmentOversize 1", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: CLAIM_ON });
      const sc = claimScene(env, 20);
      env.pass(1000);
      assert.deepStrictEqual(huntFleets(env), [[sc.holder, true]]);
      assert.strictEqual(env.w.count("spawnShip"), 16);
      assert.deepStrictEqual(sc.claims.map((c) => [c.fleetId, c.unstage, c.maxMembers]), [[sc.holder, true, 16]]);
      assert.deepStrictEqual(env.rows().map((r) => JSON.parse(r.members_json).length), [16]);
      assert.deepStrictEqual([env.counters().claimRefusedSize, env.counters().claimStarted,
        env.counters().detachmentOversize], [0, 1, 1]);
    });
  });

  needsDriver("HSEAT1 hunt-seats: a scaled hunt (2 of 5 in space) reports the 3 held-back ships "
    + "in addLiveLosses (Local shows the pilots of the detachment); a kill adds 1; unscaled -> nothing", () => {
    const FIVE = Object.freeze([{ hullGroup: "cruiser", count: 5 }]);
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { scaleEnabled: true } });
      const fleetId = env.newFleet("hseat1", PIRATE, { composition: FIVE });
      env.w.player(102, { typeId: 587, groupId: 25 });
      env.pass(1000);
      assert.strictEqual(env.w.count("spawnShip"), 2);
      assert.deepStrictEqual([...env.step.addLiveLosses(new Map())], [[fleetId, 3]], "5 ships - detachment of 2");
      env.w.kill([...env.w.npc.keys()][0]);
      env.pass(1000);
      assert.deepStrictEqual([...env.step.addLiveLosses(new Map())], [[fleetId, 4]], "held back 3 + lost 1");
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.newFleet("hseat1-off", PIRATE, { composition: FIVE });
      env.w.player(102, { typeId: 587, groupId: 25 });
      env.pass(1000);
      assert.strictEqual(env.w.count("spawnShip"), 5);
      assert.deepStrictEqual([...env.step.addLiveLosses(new Map())], [], "every ship in space: nothing held back");
    });
  });

  needsDriver("SZ6solo-hunt-warning: two players in the system -> the scale from the ship of the quarry "
    + "(frigate, 2 ships), not from the other player (battleship)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { scaleEnabled: true } });
      env.newFleet("sz6", PIRATE, { composition: [{ hullGroup: "cruiser", count: 5 }] });
      env.standings.set(`101:${PIRATE}`, 6);
      env.w.player(101, { typeId: 638, groupId: 27 });
      env.w.player(102, { typeId: 587, groupId: 25 });
      env.pass(1000);
      assert.deepStrictEqual([env.live().map((h) => h.characterId), env.w.count("spawnShip"), env.counters().scaled],
        [[102], 2, 1]);
    });
  });

  needsDriver("SZ7: claimInTx returns the detachment in another order -> MEMBERS_MISMATCH "
    + "no spawn, the hunt rolled back (SPAWN_FAILED, fleet IDLE)", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { scaleEnabled: true } });
      const real = env.ph;
      env.ph = { ...real, claimInTx: (db, req) => {
        const c = real.claimInTx(db, req);
        return c && c.ok === true && Array.isArray(c.members) ? { ...c, members: [...c.members].reverse() } : c;
      } };
      const fleetId = env.newFleet("sz7", PIRATE, { composition: [{ hullGroup: "cruiser", count: 5 }] });
      env.w.player(102, { typeId: 587, groupId: 25 });
      const out = env.pass(1000);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.counters().spawnFailed, env.counters().started,
        out.refused["hunt:MEMBERS_MISMATCH"]], [0, 1, 0, 1]);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.end_reason]), [["ENDED", "SPAWN_FAILED"]]);
      assert.strictEqual(env.fleet(fleetId).state, "IDLE");
    });
  });

  const WARN = Object.freeze({ warningEnabled: true });
  function fakeNotices() {
    const n = { calls: [], sent: 0, keys: new Set() };
    n.sendUrgent = (ev, now) => {
      n.calls.push({ ...ev, now });
      const key = `${ev.eventKey}|${ev.characterId}`;
      if (n.keys.has(key)) return { ok: true, sent: false, duplicate: true };
      n.keys.add(key);
      n.sent += 1;
      return { ok: true, sent: true, duplicate: false };
    };
    return n;
  }
  const warningsOf = (env) => env.step.getStatus().warnings.map((w) => [w.systemId, w.characterId, w.delivered]);

  needsDriver("HWN1 warning: noticeDelayMs passed -> 1 sendUrgent, 0 spawnShip "
    + "the spawn only after warningLeadMs (warningSpawned); the quarry docks before the lead -> no spawn, warningGone; "
    + "flag off -> spawn at once and zero notices calls", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...WARN, maxHuntsPerSystem: 1 } });
      const notices = fakeNotices();
      env.notices = notices;
      const S = env.config.playerHunt;
      const fleetId = env.newFleet("hwn1", PIRATE);
      env.w.player(102);
      env.w.player(104);
      env.pass(1000);
      assert.deepStrictEqual([notices.calls.length, env.w.count("spawnShip"), env.rows().length], [1, 0, 0]);
      const c = notices.calls[0];
      assert.deepStrictEqual([c.eventKey, c.characterId, c.kind, c.systemId, c.factionId, c.at],
        [`phwarn:102:${Math.floor(c.now / S.warningRepeatMs)}`, 102, "HUNT_WARNING", SYS, PIRATE, c.now]);
      assert.deepStrictEqual(env.step.getStatus().warnings.map((w) => [w.factionId, w.fleetId, w.warnedAt]),
        [[PIRATE, fleetId, c.now]]);
      assert.deepStrictEqual([warningsOf(env), env.counters().warningSent], [[[SYS, 102, "sent"]], 1]);
      env.pass(S.warningLeadMs - 1);
      assert.deepStrictEqual([env.w.count("spawnShip"), notices.calls.length], [0, 1], "before warningLeadMs");
      env.pass(1);
      assert.deepStrictEqual(env.rows().map((r) => [r.state, r.character_id]), [["LIVE", 102]]);
      assert.deepStrictEqual([env.counters().warningSpawned, env.counters().started, warningsOf(env),
        notices.calls.length], [1, 1, [], 1]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: WARN });
      env.notices = fakeNotices();
      env.newFleet("hwn1-gone", PIRATE);
      const p = env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual(warningsOf(env), [[SYS, 102, "sent"]]);
      p.state = "docked";
      env.pass(1000);
      env.pass(env.config.playerHunt.warningLeadMs);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.rows().length, warningsOf(env),
        env.counters().warningGone, env.counters().warningSpawned], [0, 0, [], 1, 0]);
      p.state = "space";
      env.pass(1000);
      assert.deepStrictEqual([warningsOf(env), env.notices.calls.length, env.counters().warningSuppressed],
        [[[SYS, 102, "suppressed"]], 1, 1]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: WARN });
      env.notices = fakeNotices();
      env.newFleet("hwn1-lapse-p", PIRATE);
      env.newFleet("hwn1-lapse-e", EMPIRE);
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual(env.step.getStatus().warnings.map((w) => w.factionId), [PIRATE]);
      env.standings.set(`102:${PIRATE}`, 6);
      env.standings.set(`102:${EMPIRE}`, -6);
      env.pass(env.config.playerHunt.warningLeadMs);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.counters().warningLapsed,
        env.step.getStatus().warnings.map((w) => [w.factionId, w.delivered])], [0, 1, [[EMPIRE, "suppressed"]]]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: WARN });
      env.notices = fakeNotices();
      env.newFleet("hwn1-grace", PIRATE);
      env.w.player(102);
      env.pass(1000);
      env.gov.admits = false;
      const S = env.config.playerHunt;
      env.pass(S.warningLeadMs + S.warningGraceMs + 1);
      env.gov.admits = true;
      env.pass(0);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.counters().warningLapsed, warningsOf(env),
        env.notices.calls.length], [0, 1, [[SYS, 102, "suppressed"]], 1]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...WARN, warningMaxPerPass: 0 } });
      env.notices = fakeNotices();
      env.newFleet("hwn1-zero", PIRATE);
      env.w.player(102);
      env.pass(1000);
      env.pass(env.config.playerHunt.warningLeadMs);
      assert.deepStrictEqual([env.notices.calls.length, warningsOf(env), env.w.count("spawnShip")], [0, [], 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      assert.strictEqual(env.config.playerHunt.warningEnabled, false, "default off");
      const notices = fakeNotices();
      env.notices = notices;
      env.newFleet("hwn1-off", PIRATE);
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual([env.live().length, notices.calls.length, warningsOf(env)], [1, 0, []]);
    });
  });

  needsDriver("HWN2 restart: a new huntStep with the same notices -> the same "
    + "bucket gives duplicate (no second mail), the spawn after warningLeadMs; no notices -> warningUndelivered, the "
    + "spawn after warningLeadMs; config keys and the warning without notices.enabled", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: WARN });
      const notices = fakeNotices();
      env.notices = notices;
      env.newFleet("hwn2", PIRATE);
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual([notices.sent, warningsOf(env)], [1, [[SYS, 102, "sent"]]]);
      env.restart();
      env.pass(1000);
      assert.deepStrictEqual([notices.calls.length, notices.sent, warningsOf(env), env.w.count("spawnShip")],
        [2, 1, [[SYS, 102, "duplicate"]], 0]);
      assert.strictEqual(notices.calls[1].eventKey, notices.calls[0].eventKey);
      env.pass(env.config.playerHunt.warningLeadMs);
      assert.deepStrictEqual([env.live().map((h) => h.characterId), env.counters().warningSpawned, notices.sent],
        [[102], 1, 1]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...WARN, maxActiveHunts: 1 } });
      env.newFleet("hwn2-none", PIRATE);
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual([warningsOf(env), env.counters().warningUndelivered, env.w.count("spawnShip")],
        [[[SYS, 102, "undelivered"]], 1, 0]);
      env.pass(env.config.playerHunt.warningLeadMs);
      assert.deepStrictEqual([env.live().map((h) => h.characterId), env.counters().warningSpawned], [[102], 1]);
    });
    const keys = ["warningEnabled", "warningLeadMs", "warningGraceMs", "warningRepeatMs", "warningMaxPerPass"];
    const rows = keys.map((k) => SCHEMA.find((row) => row.key === `playerHunt.${k}`));
    assert.deepStrictEqual(rows.map((row) => row && [row.type, row.default, row.min, row.max]), [
      ["boolean", false, undefined, undefined], ["integer", 60000, 0, 600000], ["integer", 60000, 0, 600000],
      ["integer", 900000, 0, 86400000], ["integer", 1, 0, 8]]);
    const text = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    for (const row of rows) assert.ok(text.includes(`# ${row.env}=`), row.env);
    const resolve = (e) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...e } }).warnings
      .filter((w) => w.startsWith("playerHunt.warningEnabled"));
    assert.deepStrictEqual([resolve({}).length, resolve({ EVEJS_LNE_PLAYER_HUNT_WARNING_ENABLED: "1" }).length,
      resolve({ EVEJS_LNE_PLAYER_HUNT_WARNING_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "1" }).length], [0, 1, 0]);
  });

  needsDriver("HWN3 approach: the mail at approachStarted (no warnings slot); the arrival "
    + "waits for warningLeadMs (WARNING_LEAD, no giveUp, no second warning for the fleet IDLE there), then the hunt",
  () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...APPROACH, ...WARN, warningLeadMs: 2 * JUMP_MS } });
      approachScene(env);
      const notices = fakeNotices();
      env.notices = notices;
      const fleetId = env.newFleet("hwn3", PIRATE);
      env.pass(1000);
      const p = env.step.getStatus().pursuits[0];
      assert.deepStrictEqual([env.counters().approachStarted, notices.calls.map((c) => [c.characterId, c.systemId,
        c.factionId]), warningsOf(env)], [1, [[103, SYS2, PIRATE]], []]);
      env.arrive(fleetId, SYS2);
      env.pass(p.arriveAt - env.clock.now());
      const wait = env.config.playerHunt.pursuitArrivalWaitMs;
      env.pass(wait);
      assert.deepStrictEqual([env.w.count("spawnShip"), env.step.getStatus().pursuits.length, notices.calls.length,
        warningsOf(env), env.counters().pursuitGaveUp], [0, 1, 1, [], 0]);
      env.pass(JUMP_MS - wait);
      assert.deepStrictEqual([env.live().map((h) => [h.systemId, h.fleetId]), env.counters().pursuitRematerialized,
        notices.calls.length], [[[SYS2, fleetId]], 1, 1]);
    });
  });

  needsDriver("HWN4: a refused start keeps the warning (same warnedAt, spawn "
    + "after the release); the warned fleet first; warningMaxPerPass used up -> no more candidate reads unless an "
    + "approach can still start", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: WARN, perSystem: 4 });
      env.notices = fakeNotices();
      env.newFleet("hwn4-budget", PIRATE);
      env.w.player(102);
      env.pass(1000);
      const warnedAt = env.step.getStatus().warnings[0].warnedAt;
      assert.strictEqual(env.budget.reserve({ reservationId: "mat:battle:b1:1", ownerKind: "battle", ownerId: "b1",
        systemId: SYS, shipCount: 2 }).ok, true);
      env.pass(env.config.playerHunt.warningLeadMs);
      assert.deepStrictEqual([env.counters().refusedBudget, env.w.count("spawnShip"), warningsOf(env),
        env.step.getStatus().warnings.map((w) => w.warnedAt)], [1, 0, [[SYS, 102, "sent"]], [warnedAt]]);
      env.budget.release("mat:battle:b1:1");
      env.pass(1000);
      assert.deepStrictEqual([env.live().map((h) => h.characterId), env.counters().warningSpawned,
        env.counters().warningSuppressed, env.notices.calls.length], [[102], 1, 0, 1]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: WARN });
      env.notices = fakeNotices();
      const [low, high] = [env.newFleet("hwn4-a", PIRATE), env.newFleet("hwn4-b", PIRATE)]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const move = (from, to) => env.tx((db) => {
        const f = env.fleets.getFleet(db, low).fleet;
        const r = env.fleets.transition(db, { fleetId: low, expectedVersion: f.version, from, to,
          ...(to === "REFITTING" ? { patch: { nextActionAt: env.clock.now() + 3600000 } } : {}) },
        `hwn4:${from}:${to}`);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r;
      });
      move("IDLE", "REFITTING");
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual(env.step.getStatus().warnings.map((w) => w.fleetId), [high]);
      move("REFITTING", "IDLE");
      env.pass(env.config.playerHunt.warningLeadMs);
      assert.deepStrictEqual(env.live().map((h) => [h.characterId, h.fleetId]), [[102, high]]);
      assert.strictEqual(env.fleet(low).state, "IDLE");
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...WARN, maxNewHuntsPerPass: 4, maxActiveHunts: 4 } });
      env.notices = fakeNotices();
      env.newFleet("hwn4-reads", PIRATE);
      env.w.player(102);
      env.w.player(103, { systemId: SYS2 });
      env.pass(1000);
      assert.deepStrictEqual([warningsOf(env), env.scanReads, env.counters().refusedNoCandidate],
        [[[SYS, 102, "sent"]], 1, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...WARN, warningMaxPerPass: 0 } });
      env.notices = fakeNotices();
      env.newFleet("hwn4-zero", PIRATE);
      env.w.player(102);
      env.pass(1000);
      assert.deepStrictEqual([env.scanReads, warningsOf(env)], [0, []]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...APPROACH, ...WARN, warningMaxPerPass: 0 } });
      approachScene(env);
      env.notices = fakeNotices();
      env.newFleet("hwn4-approach", PIRATE);
      env.pass(1000);
      assert.deepStrictEqual([env.scanReads, env.counters().approachStarted, env.notices.calls.length], [1, 1, 1]);
    });
  });

  needsDriver("HWN5 low-sweep-3: warningMaxPerPass 0 and approachMaxPerPass 1 "
    + "used up in SYS2 -> SYS3 (a player, no candidate) is not read", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { ...APPROACH, ...WARN, warningMaxPerPass: 0, approachMaxPerPass: 1,
        maxNewHuntsPerPass: 4, maxActiveHunts: 4 } });
      approachScene(env);
      env.w.loaded.add(SYS3);
      env.w.player(104, { systemId: SYS3 });
      env.notices = fakeNotices();
      env.newFleet("hwn5-approach", PIRATE);
      env.pass(1000);
      assert.deepStrictEqual([env.scanReads, env.counters().approachStarted, env.counters().refusedNoCandidate],
        [1, 1, 1]);
    });
  });

  test("SZ5 config: scale keys in SCHEMA, a bad scaleTable ignored with a warning "
    + "a row above maxShipsPerHunt warns only with scaleEnabled; the default config has no scale warning", () => {
    const rows = ["playerHunt.scaleEnabled", "playerHunt.scaleTable", "playerHunt.scaleDefaultShips"]
      .map((k) => SCHEMA.find((row) => row.key === k));
    assert.deepStrictEqual(rows.map((row) => row && [row.type, row.env, row.min, row.max]), [
      ["boolean", "EVEJS_LNE_PLAYER_HUNT_SCALE_ENABLED", undefined, undefined],
      ["string", "EVEJS_LNE_PLAYER_HUNT_SCALE_TABLE", undefined, undefined],
      ["integer", "EVEJS_LNE_PLAYER_HUNT_SCALE_DEFAULT_SHIPS", 1, 64]]);
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    const scaleWarn = (r) => r.warnings.filter((w) => w.includes("playerHunt.scaleTable")
      || w.includes("PLAYER_HUNT_SCALE_TABLE"));
    const def = resolve({});
    assert.deepStrictEqual([def.config.playerHunt.scaleEnabled, scaleWarn(def)], [false, []]);
    const bad = resolve({ EVEJS_LNE_PLAYER_HUNT_SCALE_TABLE: "frigate:0" });
    assert.strictEqual(bad.config.playerHunt.scaleTable, rows[1].default);
    assert.strictEqual(scaleWarn(bad).length, 1, bad.warnings.join(" | "));
    const big = { EVEJS_LNE_PLAYER_HUNT_MAX_SHIPS_PER_HUNT: "6" };
    assert.deepStrictEqual(scaleWarn(resolve(big)), [], "scale off: no warning");
    assert.deepStrictEqual(scaleWarn(resolve({ ...big, EVEJS_LNE_PLAYER_HUNT_SCALE_ENABLED: "1" })),
      ["playerHunt.scaleTable battleship:8,capital:10 above playerHunt.maxShipsPerHunt=6 - cut to 6"]);
  });

  test("CH5 config: claimHuntsEnabled / claimMaxShips in SCHEMA and.env.example "
    + "clamp 1..64, warning claimMaxShips > limits.maxLiveMaterializationsPerSystem (materialization on only)", () => {
    const rows = ["playerHunt.claimHuntsEnabled", "playerHunt.claimMaxShips"]
      .map((k) => SCHEMA.find((row) => row.key === k));
    assert.deepStrictEqual(rows.map((row) => row && [row.type, row.default, row.env]), [
      ["boolean", false, "EVEJS_LNE_PLAYER_HUNT_CLAIM_HUNTS_ENABLED"],
      ["integer", 16, "EVEJS_LNE_PLAYER_HUNT_CLAIM_MAX_SHIPS"]]);
    const text = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    for (const row of rows) assert.ok(text.includes(`# ${row.env}=`), row.env);
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    const W = "playerHunt.claimMaxShips=";
    const warned = (r) => r.warnings.some((w) => w.startsWith(W));
    assert.deepStrictEqual([resolve({ EVEJS_LNE_PLAYER_HUNT_CLAIM_MAX_SHIPS: "100" }).config.playerHunt.claimMaxShips,
      resolve({ EVEJS_LNE_PLAYER_HUNT_CLAIM_MAX_SHIPS: "0" }).config.playerHunt.claimMaxShips], [64, 1]);
    const def = resolve({});
    assert.deepStrictEqual([def.config.playerHunt.claimHuntsEnabled, def.config.playerHunt.claimMaxShips, warned(def)],
      [false, 16, false]);
    const big = { EVEJS_LNE_PLAYER_HUNT_CLAIM_MAX_SHIPS: "40", EVEJS_LNE_MAX_LIVE_MATERIALIZATIONS_PER_SYSTEM: "32" };
    assert.strictEqual(warned(resolve(big)), false, "materialization off: no warning");
    const on = resolve({ ...big, EVEJS_LNE_MATERIALIZATION_ENABLED: "1" });
    assert.ok(on.warnings.some((w) => w.startsWith(`${W}40 above limits.maxLiveMaterializationsPerSystem=32`)),
      on.warnings.join(" | "));
    assert.strictEqual(warned(resolve({ EVEJS_LNE_MATERIALIZATION_ENABLED: "1" })), false, "16 <= 48: no warning");
  });

  needsDriver("HT-A1 hunt-sweep-anomalies default objectKinds: the anchor is no anomaly, the anomaly "
    + "nearest the quarry is the first warp, anomaliesInSweep 1; only anomalies -> NO_ANCHOR before the claim", () => {
    const A1 = { kind: "anomaly", itemId: 7101, position: pos(3e10), family: "combat" };
    const A2 = { kind: "anomaly", itemId: 7102, position: pos(2.5e10), family: "ore" };
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { dscanEnabled: true } });
      assert.strictEqual(resolveConfig({ modDir: MOD_DIR, env: {} }).config.playerHunt.objectKinds,
        "stargate,station,asteroidBelt,planet,anomaly");
      assert.strictEqual(env.config.playerHunt.maxAnomaliesPerHunt, 8);
      env.w.objects.set(SYS, [...OBJECTS, A1, A2]);
      env.newFleet("hta1", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103, { position: pos(2.6e10) });
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
      const spawn = env.w.calls.find((c) => c[0] === "spawnShip");
      assert.notStrictEqual(spawn[1].kind, "anomaly", "the anchor is a static object");
      assert.strictEqual(env.counters().anomaliesInSweep, 1);
      env.pass(env.config.playerHunt.objectDwellMs);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "warpShips").map((c) => c[2]), [A2.position]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      env.w.objects.set(SYS, [A1, A2]);
      env.newFleet("hta1b", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      const out = env.pass(1000);
      assert.deepStrictEqual([env.rows(), out.refused["hunt:NO_ANCHOR"] > 0, env.w.count("spawnShip")], [[], true, 0]);
      assert.ok(env.counters().refusedObjects >= 1);
      assert.strictEqual(env.counters().anomaliesInSweep, 0);
    });
  });

  needsDriver("HT-R1: dscan off - the anomaly nearest the quarry is in the eight "
    + "despite the highest itemId; the quarry moves to an anomaly cut from the sweep -> the next warp goes there", () => {
    const far = Array.from({ length: 9 }, (_, i) => ({ kind: "anomaly", itemId: 7101 + i, position: pos(3e10 + (i * 1e10)),
      family: "combat" }));
    const LNE = { kind: "anomaly", itemId: 6800000000123, position: pos(2.6e10), family: "combat" };
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { sweepRetargetEnabled: false } });
      assert.strictEqual(env.config.playerHunt.dscanEnabled, false);
      env.w.objects.set(SYS, [...OBJECTS, ...far, LNE]);
      env.newFleet("htr1", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103, { position: pos(2.6e10 + 1e6) });
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
      env.pass(env.config.playerHunt.objectDwellMs);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "warpShips").map((c) => c[2]), [LNE.position]);
      assert.strictEqual(env.counters().sweepRetargets, 0);
    });
    withStore(driver, (opened) => {
      const env = setup(opened);
      assert.strictEqual(env.config.playerHunt.sweepRetargetEnabled, true);
      env.w.objects.set(SYS, [...OBJECTS, ...far]);
      env.newFleet("htr1b", PIRATE);
      env.standings.set(`103:${PIRATE}`, -6);
      env.w.player(103);
      env.pass(1000);
      assert.deepStrictEqual(env.rows().map((r) => r.state), ["LIVE"]);
      env.w.player(103, { position: pos(3e10 + 1000) });
      env.pass(env.config.playerHunt.objectDwellMs);
      assert.deepStrictEqual(env.w.calls.filter((c) => c[0] === "warpShips").map((c) => c[2]), [far[0].position]);
      assert.deepStrictEqual([env.counters().sweepRetargets, env.counters().objectsVisited], [1, 1]);
    });
  });

  needsDriver("GFS2: returnHomeEnabled off - a pursuit gave up in SYS2 -> returnHomeInTx to the "
    + "home SYS (returnAfterPursuit); a rematerialized chain hunt ends (quarry gone) -> endWithReturnInTx home", () => {
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { pursuitEnabled: true } });
      assert.strictEqual(env.config.playerHunt.returnHomeEnabled, false);
      const fleetId = engageThenJump(env);
      env.pass(1000);
      const p = env.step.getStatus().pursuits[0];
      env.w.routes.set(`${SYS2}:${SYS}`, 1);
      env.w.player(103, { systemId: SYS2, state: "docked" });
      env.arrive(fleetId, SYS2);
      env.pass(p.arriveAt - env.clock.now());
      env.pass(env.config.playerHunt.pursuitArrivalWaitMs);
      assert.deepStrictEqual([env.counters().pursuitGaveUp, env.counters().returnStarted,
        env.counters().returnAfterPursuit], [1, 1, 1]);
      const f = env.fleet(fleetId);
      assert.deepStrictEqual([f.state, f.targetSystemId], ["TRAVELLING", SYS]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { ph: { pursuitEnabled: true } });
      const fleetId = engageThenJump(env);
      env.pass(1000);
      const p = env.step.getStatus().pursuits[0];
      env.w.routes.set(`${SYS2}:${SYS}`, 1);
      env.arrive(fleetId, SYS2);
      env.pass(p.arriveAt - env.clock.now());
      assert.deepStrictEqual(env.live().map((h) => h.systemId), [SYS2]);
      env.w.players = env.w.players.filter((x) => x.characterId !== 103);
      env.pass(1000);
      env.pass(env.config.playerHunt.exitGraceMs);
      env.pass(env.config.playerHunt.exitGraceMs);
      const last = env.rows()[env.rows().length - 1];
      assert.strictEqual(last.state, "ENDED", JSON.stringify(env.rows()));
      assert.deepStrictEqual([env.counters().returnStarted, env.counters().returnAfterPursuit], [1, 1]);
      const f = env.fleet(fleetId);
      assert.deepStrictEqual([f.state, f.targetSystemId], ["TRAVELLING", SYS]);
    });
  });

  function engageAtAnchor(env) {
    env.newFleet("ofh", PIRATE);
    env.standings.set(`103:${PIRATE}`, -6);
    const quarry = env.w.player(103);
    env.pass(0);
    const anchor = env.w.calls.find((c) => c[0] === "spawnShip")[1].itemID;
    const o = OBJECTS.find((x) => x.itemId === anchor);
    quarry.position = { ...o.position, x: o.position.x + 1000 };
    env.pass(1000);
    assert.strictEqual(env.live()[0].phase, "ENGAGED");
    for (let i = 0; i < 3; i += 1) env.pass(1000);
    assert.strictEqual(env.live()[0].phase, "ENGAGED", "still on the quarry");
    return { calls: env.w.calls, rows: env.rows() };
  }
  const fakeOfficers = (env, result) => {
    const calls = [];
    env.officers = { tryHunt: (i) => {
      calls.push({ ...i, at: env.clock.now() });
      if (result instanceof Error) throw result;
      return result;
    } };
    return calls;
  };

  needsDriver("OFH1: the first ENGAGED pass with the quarry on grid calls tryHunt once "
    + "({huntId, systemId, characterId, factionId}); later ENGAGED passes do not; officerSpawned / officerRefused; "
    + "a missed roll / flags off count nothing; the real stub off / stopped is quiet, unavailable counts", () => {
    const stub = (why) => createUnavailableOfficerSpawns(why).tryHunt({});
    for (const [result, spawned, refused] of [[{ ok: true, spawned: true, entityIds: [1] }, 1, 0],
      [{ ok: false, reason: "SYSTEM_NOT_ELIGIBLE" }, 0, 1], [{ ok: false, reason: "CHANCE_MISS" }, 0, 0],
      [stub("OFFICER_SPAWNS_DISABLED"), 0, 0], [stub("stopped"), 0, 0], [stub("OFFICER_SPAWNS_UNAVAILABLE"), 0, 1],
      [{ ok: false, reason: "SOURCE_DISABLED" }, 0, 0]]) {
      withStore(driver, (opened) => {
        const env = setup(opened, { officers: true });
        const calls = fakeOfficers(env, result);
        const { rows } = engageAtAnchor(env);
        const st = env.step.getStatus().hunts[0];
        assert.deepStrictEqual(calls.map(({ at, ...i }) => i), [{ huntId: rows[0].hunt_id, systemId: SYS,
          characterId: 103, factionId: PIRATE }], `one roll (${result.reason || "ok"})`);
        assert.strictEqual(calls[0].at, START_MS + 1000, "at the first ENGAGED pass");
        assert.strictEqual(st.factionId, PIRATE);
        assert.deepStrictEqual([env.counters().officerSpawned, env.counters().officerRefused], [spawned, refused]);
      });
    }
  });

  needsDriver("OFH2: no dep / null / a throwing tryHunt -> the same calls and rows as "
    + "without the officer, officerRefused + log line only for the throw; ENGAGED after a scan hit rolls at the "
    + "landing, not at the scan hit", () => {
    const base = withStore(driver, (opened) => engageAtAnchor(setup(opened)));
    withStore(driver, (opened) => {
      const env = setup(opened, { officers: true });
      env.officers = null;
      assert.deepStrictEqual(engageAtAnchor(env), base, "null: same actions");
      assert.deepStrictEqual([env.counters().officerSpawned, env.counters().officerRefused], [0, 0]);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { officers: true });
      const calls = fakeOfficers(env, new Error("boom"));
      assert.deepStrictEqual(engageAtAnchor(env), base, "throw: same actions");
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual([env.counters().officerSpawned, env.counters().officerRefused], [0, 1]);
      assert.strictEqual(env.lines.filter((l) => l.includes("officer roll threw - boom")).length, 1);
    });
    withStore(driver, (opened) => {
      const env = setup(opened, { officers: true, ph: { maxScanCycles: 200 } });
      const calls = fakeOfficers(env, { ok: false, reason: "CHANCE_MISS" });
      const { hit } = scanToEngaged(env);
      assert.ok(hit >= 1 && env.counters().scanHits === 1, "a scan hit before the landing");
      assert.deepStrictEqual(calls.map((c) => c.at), [env.clock.now()], "only the landing pass on the quarry");
      env.pass(1000);
      assert.strictEqual(calls.length, 1);
    });
  });

  test("OFH3: materialization/index.js hands deps.getOfficerSpawns to the hunt deps "
    + "not to the garrison patrol", () => {
    const src = fs.readFileSync(path.join(MOD_DIR, "lib", "materialization", "index.js"), "utf8");
    const block = (head) => {
      const at = src.indexOf(head);
      assert.ok(at >= 0, head);
      return src.slice(at, src.indexOf(": null;", at));
    };
    assert.match(block("const hunt = "), /getOfficerSpawns: deps\.getOfficerSpawns,/);
    assert.doesNotMatch(block("const patrol = "), /getOfficerSpawns/);
  });
};

module.exports.harness = { loadDriver, withStore, setup, PIRATE, SYS, START_MS };
