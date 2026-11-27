"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { startFleetExposure, FLEET_EXPOSURE_METHODS } = require("../../lib/fleetExposure");
const { createSentryHoldStep } = require("../../lib/materialization/sentryHoldStep");
const { createSentryStep } = require("../../lib/materialization/sentryStep");
const { createMaterializationService } = require("../../lib/materialization/service");
const { createPhysicalBudget } = require("../../lib/materialization/physicalBudget");
const { createLossTracker } = require("../../lib/materialization/lossTracker");
const { createSentryService } = require("../../lib/sentries/service");
const { FACADE_METHODS: SENTRY_FACADE_METHODS } = require("../../lib/sentries/index");
const SS = require("../../lib/sentries/schema");
const { SEAM_METHODS: HUNT_SCENE_METHODS } = require("../../lib/adapter/huntScene");
const { SEAM_METHODS: NPC_SPAWN_METHODS } = require("../../lib/adapter/npcSpawn");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const GROUPS = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(undefined));
const { S, FACTION_A } = H;
const SYS = S.N0;
const OTHER = S.N6;
const CHAR = 90000001;
const FRIEND = 90000002;
const PLAYER_SHIP = 1090000001;
const CRUISERS3 = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);
const pos = (x) => ({ x, y: 0, z: 0 });
const STATION = Object.freeze({ kind: "station", itemId: 60000001, position: pos(4000000) });
const THRESHOLDS = Object.freeze({ hostileMax: -5, friendlyMin: 5 });
const STANDING = new Map([[`${CHAR}:${FACTION_A}`, -6], [`${FRIEND}:${FACTION_A}`, 6]]);
const HOSTILITY = Object.freeze({
  readStanding: (c, f) => (STANDING.has(`${c}:${f}`) ? { ok: true, standing: STANDING.get(`${c}:${f}`) }
    : { ok: false, reason: "NO_ROW" }),
  getFactionKind: () => "pirate",
  thresholds: THRESHOLDS,
  neutralPolicy: Object.freeze({}),
  isFactionEnemy: () => false,
});
const WARNING_MS = DEFAULTS.sentries.liveHold.warningMs;
const PUMP_MS = 2000;

function sentryRows(over = []) {
  const row = (itemId, characterId, extra = {}) => ({ sentryId: `sp-${itemId}`, itemId, typeId: 340501,
    ownerKind: "player", factionId: null, characterId, systemId: SYS, state: SS.ACTIVE, armedAt: 0, ...extra });
  return over.length > 0 ? over.map((o) => row(o.itemId, o.characterId, o.extra || {}))
    : [row(7100, FRIEND), row(7101, CHAR), row(7102, CHAR)];
}

function recording(obj, name, log) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    out[k] = typeof v !== "function" ? v : (...args) => {
      log.push([name, k]);
      return v.apply(obj, args);
    };
  }
  return out;
}

function fakeWorld() {
  const w = { loaded: new Set([SYS, OTHER]), npc: new Map(), players: [], nextId: 8001, calls: [],
    sentryAlive: new Map([[7100, true], [7101, true], [7102, true]]), tracker: null, beforePublish: null };
  const sentryPos = (itemId) => pos((itemId - 7100) * 1000);
  w.scene = {
    listSystemObjects(sys, kinds) {
      w.calls.push(["listSystemObjects", sys, [...kinds]]);
      return { ok: true, objects: [STATION].filter((o) => kinds.includes(o.kind)).map((o) => ({ ...o,
        position: { ...o.position } })) };
    },
    readPlayerShips(sys) {
      w.calls.push(["readPlayerShips", sys]);
      if (!w.loaded.has(sys)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, ships: w.players.filter((p) => p.systemId === sys).map((p) => ({ characterId: p.characterId,
        entityId: p.entityId, position: pos(0), signatureRadius: 100, inWarp: false, aligning: false, cloaked: false,
        jumpCloaked: false, capsule: false, typeId: null, groupId: null, warpTarget: null, warpTargetEntityId: null })) };
    },
    readShips(sys, ids) {
      w.calls.push(["readShips", sys]);
      return { ok: true, ships: ids.filter((id) => w.npc.has(id))
        .map((id) => ({ entityId: id, position: { ...w.npc.get(id).position }, inWarp: false })) };
    },
    warpShips(sys, ids, point, opts) {
      w.calls.push(["warpShips", [...ids], { ...point }, opts && opts.spreadMeters]);
      for (const id of ids) if (w.npc.has(id)) w.npc.get(id).position = { ...point };
      return { ok: true, warped: ids.length, failed: [] };
    },
  };
  w.npcSpawn = {
    resolveProfiles(reqs, o) {
      w.calls.push(["resolveProfiles", { ...o }]);
      return { ok: true, profiles: reqs.map((r) => `p_${r.hullGroup}`) };
    },
    isSceneLoaded: (sys) => w.loaded.has(sys),
    spawnShip(sys, spec) {
      w.calls.push(["spawnShip", sys, { ...spec.anchorDescriptor }, spec.behavior, spec.spawnDistanceMeters]);
      const a = spec.anchorDescriptor;
      if (a.kind !== "entity" || w.sentryAlive.get(a.itemID) !== true) {
        return { ok: false, reason: "SPAWN_FAILED", detail: "ANCHOR_NOT_FOUND" };
      }
      const id = w.nextId;
      w.nextId += 1;
      const at = sentryPos(a.itemID);
      w.npc.set(id, { systemId: sys, position: { x: at.x + spec.spawnDistanceMeters, y: 0, z: 0 } });
      return { ok: true, entityId: id };
    },
    publish(sys, ids) {
      w.calls.push(["publish", [...ids]]);
      if (typeof w.beforePublish === "function") w.beforePublish();
      return { ok: true, published: ids.length, missing: 0 };
    },
    despawn(sys, ids) {
      w.calls.push(["despawn", [...ids]]);
      let removed = 0;
      for (const id of ids) if (w.npc.delete(id)) removed += 1;
      return { ok: true, removed, missing: ids.length - removed };
    },
  };
  const view = (itemId) => ({ itemId, typeId: 340501, position: sentryPos(itemId), maxRangeM: 100000, targetId: null,
    active: false, alive: w.sentryAlive.get(itemId) === true, incapacitated: false, inScene: true, gone: false });
  w.sentrySeam = {
    readSentryScene(sys, itemIds, lneIds) {
      w.calls.push(["readSentryScene", sys, [...itemIds], [...lneIds]]);
      if (!w.loaded.has(sys)) return { ok: true, loaded: false, sentries: [], players: [], positions: new Map() };
      const positions = new Map(lneIds.filter((id) => w.npc.has(id)).map((id) => [id, { ...w.npc.get(id).position }]));
      return { ok: true, loaded: true, sentries: itemIds.map(view), positions,
        players: w.players.filter((p) => p.systemId === sys).map((p) => ({ characterId: p.characterId,
          entityId: p.entityId, position: pos(0) })) };
    },
    engage(sys, itemId, targetId) {
      w.calls.push(["engage", itemId, targetId]);
      return { ok: true, pending: false, alreadyActive: false };
    },
    release(sys, itemId, reason) {
      w.calls.push(["release", itemId, reason]);
      return { ok: true, stopped: true };
    },
    applySentryDamage(itemId, hp) {
      w.calls.push(["damage", itemId, hp]);
      return { ok: true, destroyed: false, layer: "shield" };
    },
  };
  w.kill = (id) => {
    w.npc.delete(id);
    w.tracker.note({ itemID: id }, { success: true });
  };
  w.player = (systemId) => {
    w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId }];
  };
  w.of = (name) => w.calls.filter((c) => c[0] === name);
  return w;
}

function sentryConfig(over = {}) {
  const se = DEFAULTS.sentries;
  return { ...DEFAULTS, sentries: { ...se, enabled: true, battle: { ...se.battle, enabled: true },
    liveHold: { ...se.liveHold, enabled: true, ...(over.liveHold || {}) }, live: { ...se.live, ...(over.live || {}) } } };
}

function bootBase(reopen, opts = {}) {
  const shared = H.sharedOf();
  const opened = reopen();
  const env = H.boot(opened, shared);
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const cfg = sentryConfig(opts);
  const fxConfig = { ...H.CONFIG, fleetExposure: { enabled: false }, sentries: cfg.sentries };
  const startFx = () => startFleetExposure({ config: fxConfig, persistence: { ok: true, store: env.store,
    journal: env.journal }, clock: shared.clock, getFleets: () => env.fleets, telemetry: null, logger });
  const fx = startFx();
  assert.ok(fx.ok, JSON.stringify(fx));
  const rows = sentryRows(opts.sentries || []);
  const battleCalls = [];
  const battle = { getStatus: () => ({ state: "ready" }),
    createFixedDefenseBattleInTx(tx, spec, key) {
      battleCalls.push({ spec, key });
      return { ok: true, duplicate: false, battleId: `b-${battleCalls.length}` };
    } };
  const presenceOfService = { distance: 0 };
  const sentries = createSentryService({ store: env.store, config: cfg, clock: shared.clock, journal: env.journal,
    seam: { readSentryItem: () => ({ ok: true, item: { hp: 500000, destroyed: false, incapacitated: false } }),
      readSentryCombat: () => ({ ok: true, dps: 67.7, signature: 6000, designSig: 125 }),
      readAmmo: () => ({ ok: true, units: 50, capacityUnits: 100 }) },
    repository: { listActive: () => ({ ok: true, sentries: rows, truncated: false }) },
    scheduler: { enqueue: () => ({ ok: true }) }, fleetRepository: env.fleets.repository,
    getPresence: () => ({ distanceToObserved: () => ({ ok: true, distance: presenceOfService.distance }) }),
    groups: GROUPS, hostility: HOSTILITY, getBattle: () => battle, getOwnerOnline: opts.getOwnerOnline });
  assert.ok(sentries.rebuildArmed().ok);
  return { shared, opened, env, lines, logger, cfg, fx: fx.fleetExposure, startFx, sentries, battleCalls,
    presenceOfService };
}

function setup(reopenOrBase, opts = {}) {
  const base = typeof reopenOrBase === "function" ? bootBase(reopenOrBase, opts) : reopenOrBase;
  const { shared, env, logger, cfg } = base;
  const clock = shared.clock;
  const w = fakeWorld();
  const log = [];
  const tracker = createLossTracker({ maxPending: 40 });
  w.tracker = tracker;
  const budget = createPhysicalBudget({ limits: opts.budget || { perSystem: 48, global: 120 }, clock });
  const gov = { admits: true, asked: 0 };
  const names = [];
  const telemetry = { count: (name) => names.push(name), observe() {} };
  const settings = { ...cfg.sentries.liveHold, ...(opts.settings || {}) };
  const rec = opts.record === true;
  const scene = rec ? recording(w.scene, "scene", log) : w.scene;
  const npcSpawn = rec ? recording(w.npcSpawn, "npcSpawn", log) : w.npcSpawn;
  const sentrySeam = rec ? recording(w.sentrySeam, "sentrySeam", log) : w.sentrySeam;
  const fx = rec ? recording(base.fx, "fleetExposure", log) : base.fx;
  const sentries = rec ? recording(base.sentries, "sentries", log) : base.sentries;
  const repo = rec ? recording(env.fleets.repository, "fleets", log) : env.fleets.repository;
  const step = createSentryHoldStep({ store: env.store, clock, npcSpawn, budget, lossTracker: tracker,
    lossImportOn: true, despawnAll: (sys, ids) => npcSpawn.despawn(sys, ids),
    admits: () => {
      gov.asked += 1;
      return gov.admits;
    },
    getFleetExposure: () => fx, getFleets: () => (opts.grid ? { repository: repo, grid: opts.grid }
      : { repository: repo }), getSentries: () => sentries, gridEnabled: Boolean(opts.grid),
    getSentrySeam: () => sentrySeam, getHuntScene: () => scene,
    hostility: { ...HOSTILITY, maxReads: cfg.sentries.live.maxStandingReadsPerPass }, strengthGroups: GROUPS,
    settings, retreatLossPermille: cfg.sentries.battle.attackerRetreatLossPermille, exitGraceMs: 30000, telemetry,
    logger,
    spawnBackoff: opts.spawnBackoff });
  const sentryStep = createSentryStep({ getSentries: () => base.sentries, getSeam: () => w.sentrySeam,
    readStanding: HOSTILITY.readStanding, getFactionKind: HOSTILITY.getFactionKind, thresholds: THRESHOLDS,
    neutralPolicy: HOSTILITY.neutralPolicy, isFactionEnemy: HOSTILITY.isFactionEnemy,
    relationGroups: () => step.relationGroups(), settings: cfg.sentries.live, pumpMs: PUMP_MS,
    strengthGroups: GROUPS });
  const presence = {
    observedSystems: () => [...new Set(w.players.map((p) => p.systemId))].sort((a, b) => a - b),
    getSystemPresence: (id) => ({ systemId: id, space: w.players.filter((p) => p.systemId === id).length }),
  };
  const pass = (dt = 0) => {
    clock.advance(dt);
    const out = { refused: {} };
    step.stepPending(clock.now(), out);
    step.step(clock.now(), presence, out);
    sentryStep.step(clock.now(), presence, out);
    return out;
  };
  const fleetOf = (id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
  const exposureRows = () => env.tx((db) => db.prepare("SELECT exposure_id, kind, state, end_reason, members_json, "
    + "losses_json, character_id, from_state FROM world_fleet_exposures ORDER BY started_at, exposure_id").all());
  const counters = () => step.getStatus().counters;
  return { base, env, clock, w, log, tracker, budget, gov, names, settings, step, sentryStep, presence, pass, fleetOf,
    exposureRows, counters };
}

function stagedSiege(t, tag, composition = CRUISERS3, factionId = FACTION_A) {
  const env = t.env;
  const r = env.fleets.createFleet({ factionId, currentSystemId: SYS, homeSystemId: SYS, fleetRole: "invasion",
    composition }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  const op = env.fleets.createOperation({ operationType: "invasion", factionId, originSystemId: SYS,
    targetSystemId: SYS, objective: "capture", dueAt: null, fleets: [{ fleetId: r.fleetId, expectedVersion: 1 }] },
  `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const f = t.fleetOf(r.fleetId);
  const st = env.tx((db) => env.fleets.repository.transition(db, { fleetId: r.fleetId, expectedVersion: f.version,
    from: f.state, to: "STAGED", patch: {} }, `${tag}:stage`));
  assert.ok(st.ok, JSON.stringify(st));
  return { fleetId: r.fleetId, operationId: op.operationId, version: t.fleetOf(r.fleetId).version };
}

const shipsOf = (t) => t.step.getStatus().entries.length > 0 ? t.step.relationGroups().flatMap((g) => g.entityIds)
  : [];

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FD-SV1 hold: anchor {kind:entity, itemID} of the smallest live hostile sentry, claim HELD SENTRY "
    + "fleet MATERIALIZED; no fire before warningMs, then engage + proxy round(3 x 100 x elapsed / 1000); vendor facts",
  () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    const f = stagedSiege(t, "sv1");
    t.w.player(SYS);
    const out = t.pass(0);
    const spawns = t.w.of("spawnShip");
    assert.deepStrictEqual(spawns.map((c) => [c[1], c[2], c[3], c[4]]), [0, 1, 2].map(() => [SYS,
      { kind: "entity", itemID: 7101 }, "search", t.settings.spawnDistanceM]), JSON.stringify(out));
    const rows = t.exposureRows();
    assert.deepStrictEqual(rows.map((r) => [r.exposure_id, r.kind, r.state, r.from_state, r.character_id,
      JSON.parse(r.members_json).length]), [[`fx:${f.fleetId}:${f.version}`, "SENTRY", "HELD", "STAGED", null, 3]]);
    const fl = t.fleetOf(f.fleetId);
    assert.deepStrictEqual([fl.state, fl.operationId], ["MATERIALIZED", f.operationId]);
    assert.deepStrictEqual([t.w.of("engage").length, t.w.of("damage").length, t.counters().holdStarted], [0, 0, 1]);
    const [g] = t.step.relationGroups();
    assert.deepStrictEqual([g.engageAfter, g.hullGroups], [t.clock.now() + WARNING_MS,
      ["cruiser", "cruiser", "cruiser"]]);
    t.pass(WARNING_MS);
    const ids = shipsOf(t);
    const engaged = t.w.of("engage");
    assert.ok(engaged.length >= 1 && engaged.every((c) => ids.includes(c[2]) && c[1] !== 7100), JSON.stringify(engaged));
    const hp = Math.round(3 * t.base.cfg.sentries.live.proxyDpsPerShip * (2 * PUMP_MS) / 1000);
    assert.deepStrictEqual(t.w.of("damage").map((c) => [c[1], c[2]]), [[7101, hp], [7102, hp]]);
    const anchors = fs.readFileSync(path.join(SERVER_SRC, "space", "npc", "npcAnchors.js"), "utf8").replace(/\r\n/g, "\n");
    const at = anchors.indexOf("normalizedKind === \"entity\" ||");
    assert.ok(at > 0 && anchors.indexOf("const entity = scene.getEntityByID(numericEntityID);", at) > at);
    const combat = fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "sentryCombat.js"), "utf8");
    assert.ok(combat.includes("const entity = scene.getEntityByID(itemId);"));
  }));

  needsDriver("T4 grid hold per grid: a fleet in a grid without a hostile sentry -> no spawn + holdGridMiss; in "
    + "the grid of 7102 -> anchor itemID 7102 (not the smaller 7101 of the gate grid), hostileSentryIds = [7102]",
  () => H.withStore(driver, async (reopen) => {
    const GATE = 50001001;
    const STATION_ID = 60001001;
    const grid = { at: "gate:99", reads: 0, isEnabled: () => true,
      positionsOf(tx, sys, fleets) {
        grid.reads += 1;
        assert.strictEqual(tx.inTransaction, true);
        return { ok: true, anchorsReason: null, positions: new Map(fleets.map((f) => [f.fleetId,
          { kind: "anchor", gridKey: grid.at }])) };
      },
      readSystemGrid: () => ({ ok: true, grids: [{ gridKey: `gate:${GATE}`, anchors: [{ kind: "gate", id: GATE }] },
        { gridKey: `station:${STATION_ID}`, anchors: [{ kind: "station", id: STATION_ID }] },
        { gridKey: "gate:99", anchors: [{ kind: "gate", id: 99 }] }] }) };
    const t = setup(reopen, { grid, sentries: [{ itemId: 7100, characterId: FRIEND },
      { itemId: 7101, characterId: CHAR, extra: { anchorKind: "gate", anchorId: GATE } },
      { itemId: 7102, characterId: CHAR, extra: { anchorKind: "station", anchorId: STATION_ID } }] });
    const f = stagedSiege(t, "g4");
    t.w.player(SYS);
    t.pass(0);
    assert.deepStrictEqual([t.w.of("spawnShip").length, t.counters().holdGridMiss, t.counters().holdGridFallback,
      grid.reads], [0, 1, 0, 1]);
    grid.at = `station:${STATION_ID}`;
    t.pass(t.settings.scanIntervalMs);
    const spawns = t.w.of("spawnShip");
    assert.ok(spawns.length > 0 && spawns.every((c) => c[2].itemID === 7102), JSON.stringify(spawns));
    const [e] = t.step.getStatus().entries;
    assert.deepStrictEqual([e.fleetId, e.anchorItemId, e.hostileSentryIds], [f.fleetId, 7102, [7102]]);
  }));

  needsDriver("HSH1 hold anchor: a listening post of an offline owner is no hold anchor (no spawn, no row); owner online "
    + "-> anchor itemID 7101; the owner read once per corporation in a scan", () => H.withStore(driver, async (reopen) => {
    const CORP = 98000001;
    const owner = { online: false, reads: 0 };
    const getOwnerOnline = () => ({ ownerOnline: (corpId) => {
      owner.reads += 1;
      return { online: corpId === CORP && owner.online, reason: null };
    } });
    const post = { typeId: 340520, ownerCorpId: CORP };
    const t = setup(reopen, { getOwnerOnline, sentries: [{ itemId: 7101, characterId: CHAR, extra: post },
      { itemId: 7102, characterId: CHAR, extra: post }] });
    const f = stagedSiege(t, "hsh1");
    t.w.player(SYS);
    t.pass(0);
    assert.deepStrictEqual([t.w.of("spawnShip").length, t.counters().holdStarted, t.exposureRows().length,
      owner.reads], [0, 0, 0, 2]);
    owner.online = true;
    t.pass(t.settings.scanIntervalMs);
    const spawns = t.w.of("spawnShip");
    assert.ok(spawns.length > 0 && spawns.every((c) => c[2].itemID === 7101), JSON.stringify(spawns));
    const [e] = t.step.getStatus().entries;
    assert.deepStrictEqual([e.fleetId, e.anchorItemId, e.hostileSentryIds, owner.reads >= 2], [f.fleetId, 7101,
      [7101, 7102], true]);
  }));

  needsDriver("FD-SV2 losses: 1 of 3 cruisers (>= 300 permille EHP) -> EXIT warp to the station -> landed -> "
    + "endInTx(RETREAT) once: -1 cruiser, STAGED with the operation; second end duplicate; cooldown -> no spawn",
  () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    const f = stagedSiege(t, "sv2");
    t.w.player(SYS);
    t.pass(0);
    t.pass(WARNING_MS);
    const [first] = shipsOf(t);
    t.w.kill(first);
    t.pass(PUMP_MS);
    const row = t.exposureRows()[0];
    assert.deepStrictEqual(JSON.parse(row.members_json).map((m) => m.state).sort(), ["DESTROYED", "SPAWNED", "SPAWNED"]);
    assert.deepStrictEqual([t.step.getStatus().exiting, t.counters().holdExited, t.counters().holdLossImported],
      [1, 1, 1]);
    const warp = t.w.of("warpShips");
    assert.deepStrictEqual([warp.length, warp[0][2], warp[0][1].length], [1, STATION.position, 2]);
    t.pass(PUMP_MS);
    const ended = t.exposureRows()[0];
    assert.deepStrictEqual([ended.state, ended.end_reason, JSON.parse(ended.losses_json)], ["ENDED", "RETREAT",
      [{ hullGroup: "cruiser", typeId: null, count: 1 }]]);
    const fl = t.fleetOf(f.fleetId);
    assert.deepStrictEqual([fl.state, fl.operationId, fl.shipCount], ["STAGED", f.operationId, 2]);
    assert.deepStrictEqual([t.counters().holdEnded, t.counters().holdRetreated, t.w.npc.size], [1, 1, 0]);
    const again = t.env.tx((db) => t.base.fx.endInTx(db, { exposureId: ended.exposure_id, at: t.clock.now(),
      reason: "RETREAT" }));
    assert.deepStrictEqual([again.ok, again.duplicate, t.fleetOf(f.fleetId).shipCount], [true, true, 2]);
    const spawned = t.w.of("spawnShip").length;
    t.pass(t.settings.scanIntervalMs);
    assert.deepStrictEqual([t.w.of("spawnShip").length, t.counters().holdStarted, t.exposureRows().length],
      [spawned, 1, 1]);
  }));

  needsDriver("FD-SV3 the player leaves -> NO_PLAYER after exitGraceMs, STAGED, zero losses; the virtual battle "
    + "round of the sentry service (unobserved) then takes this fleet", () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    const f = stagedSiege(t, "sv3");
    t.w.player(SYS);
    t.pass(0);
    t.w.players = [];
    t.pass(30000);
    assert.strictEqual(t.exposureRows()[0].state, "HELD", "still held within exitGraceMs");
    t.pass(PUMP_MS);
    const row = t.exposureRows()[0];
    assert.deepStrictEqual([row.state, row.end_reason, JSON.parse(row.losses_json)], ["ENDED", "NO_PLAYER", []]);
    const fl = t.fleetOf(f.fleetId);
    assert.deepStrictEqual([fl.state, fl.shipCount, t.w.npc.size], ["STAGED", 3, 0]);
    t.base.presenceOfService.distance = null;
    const R = t.base.cfg.sentries.battle.roundMs;
    const round = Math.floor(t.clock.now() / R) + 1;
    const r = t.base.sentries.onAttrition({ payload: { systemId: SYS, round }, dueAt: round * R },
      { anchorAt: round * R });
    assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
    const v = t.env.tx((db) => r.effect(db));
    assert.deepStrictEqual([v.ok, t.base.battleCalls.length, t.base.battleCalls[0].spec.sideA],
      [true, 1, { factionId: FACTION_A, fleets: [{ fleetId: f.fleetId, expectedVersion: fl.version }] }]);
  }));

  needsDriver("FD-SV4 restart: claim + 1 loss written, a new boot of ctx.fleetExposure ends it RESTART (loss once "
    + "STAGED); a third boot ends nothing; endInTx of the old exposure = duplicate", () => H.withStore(driver,
    async (reopen) => {
      const t = setup(reopen);
      const f = stagedSiege(t, "sv4");
      t.w.player(SYS);
      t.pass(0);
      t.w.kill(shipsOf(t)[0]);
      t.pass(PUMP_MS);
      const held = t.exposureRows()[0];
      assert.deepStrictEqual([held.state, JSON.parse(held.members_json).filter((m) => m.state === "DESTROYED").length],
        ["HELD", 1]);
      t.clock.advance(1000);
      const second = t.base.startFx();
      assert.ok(second.ok, JSON.stringify(second));
      assert.strictEqual(second.fleetExposure.getStatus().recovered, 1);
      const row = t.exposureRows()[0];
      const fl = t.fleetOf(f.fleetId);
      assert.deepStrictEqual([row.state, row.end_reason, fl.state, fl.shipCount, fl.operationId], ["ENDED", "RESTART",
        "STAGED", 2, f.operationId]);
      t.clock.advance(1000);
      const third = t.base.startFx();
      assert.strictEqual(third.fleetExposure.getStatus().recovered, 0);
      const old = t.env.tx((db) => t.base.fx.endInTx(db, { exposureId: held.exposure_id, at: t.clock.now(),
        reason: "RETREAT" }));
      assert.deepStrictEqual([old.ok, old.duplicate, t.fleetOf(f.fleetId).shipCount], [true, true, 2]);
    }));

  needsDriver("FD-SV5 refusals: flag off, budget, governor, own-faction sentry, version change, service "
    + "cursor and wiring, method lists", () => H.withStore(driver, async (reopen) => {
    const base = bootBase(reopen);
    const a = setup(base, { record: true, settings: { enabled: false } });
    const fa = stagedSiege(a, "sv5a");
    a.w.player(SYS);
    a.pass(0);
    a.pass(a.settings.scanIntervalMs);
    assert.deepStrictEqual([a.log.filter((c) => ["scene", "npcSpawn", "sentrySeam"].includes(c[0])), a.gov.asked,
      a.exposureRows().length], [[], 0, 0]);
    const c = setup(base);
    c.pass(0);
    assert.strictEqual(c.gov.asked, 0, "no candidate system -> the governor is not asked");
    c.gov.admits = false;
    c.w.player(SYS);
    c.pass(c.settings.scanIntervalMs);
    assert.deepStrictEqual([c.gov.asked, c.counters().holdRefusedGovernor, c.names, c.w.of("spawnShip").length],
      [1, 1, ["sentries.holdRefusedGovernor"], 0]);
    const b = setup(base, { budget: { perSystem: 2, global: 120 } });
    b.w.player(SYS);
    b.pass(0);
    assert.deepStrictEqual([b.counters().holdRefusedBudget, b.w.of("spawnShip").length, b.exposureRows().length,
      b.fleetOf(fa.fleetId).state], [1, 0, 0, "STAGED"]);
    const e = setup(base);
    e.w.player(SYS);
    e.w.beforePublish = () => {
      const fl = e.fleetOf(fa.fleetId);
      const r = e.env.tx((db) => e.env.fleets.repository.transition(db, { fleetId: fa.fleetId,
        expectedVersion: fl.version, from: "STAGED", to: "PLANNED", patch: {} }, "sv5e:replan"));
      assert.ok(r.ok, JSON.stringify(r));
    };
    e.pass(0);
    assert.deepStrictEqual([e.counters().holdClaimFailed, e.step.getStatus().lastRefusal.reason,
      e.w.of("despawn").length, e.w.npc.size, e.exposureRows().length], [1, "VERSION_CONFLICT", 1, 0, 0]);
    assert.strictEqual(e.budget.getStatus().reservedShips, 0);
    const g = setup(base, { record: true });
    stagedSiege(g, "sv5g");
    g.w.player(SYS);
    g.pass(0);
    g.w.kill(shipsOf(g)[0]);
    g.pass(WARNING_MS);
    g.pass(PUMP_MS);
    const used = (name) => [...new Set(g.log.filter((x) => x[0] === name).map((x) => x[1]))].sort();
    const sentrySource = fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "sentrySeams.js"), "utf8");
    const missing = [
      ...used("scene").filter((m) => !HUNT_SCENE_METHODS.includes(m)),
      ...used("npcSpawn").filter((m) => !NPC_SPAWN_METHODS.includes(m)),
      ...used("fleetExposure").filter((m) => !FLEET_EXPOSURE_METHODS.includes(m) || typeof base.fx[m] !== "function"),
      ...used("sentries").filter((m) => !SENTRY_FACADE_METHODS.includes(m)),
      ...used("sentrySeam").filter((m) => !new RegExp(`\\n\\s+${m}: \\(`).test(sentrySource)),
      ...used("fleets").filter((m) => typeof base.env.fleets.repository[m] !== "function"),
    ];
    assert.deepStrictEqual([missing, used("fleetExposure"), used("scene")], [[], ["claimInTx", "endInTx",
      "isKindEnabled", "markDestroyedInTx"], ["listSystemObjects", "readPlayerShips", "readShips", "warpShips"]]);
    assert.deepStrictEqual(used("sentries"), ["getMode", "kindOf", "listLiveInSystem"]);
  }));

  needsDriver("FD-SV5d a sentry of the fleet's own faction (not hostile) -> no candidate, no spawn, no row",
    () => H.withStore(driver, async (reopen) => {
      const t = setup(reopen, { record: true, sentries: [{ itemId: 7101, characterId: null,
        extra: { ownerKind: "faction", factionId: FACTION_A } }] });
      stagedSiege(t, "sv5d");
      t.w.player(SYS);
      t.pass(0);
      assert.deepStrictEqual([t.counters().holdScans, t.w.of("spawnShip").length, t.exposureRows().length,
        t.log.filter((x) => x[0] === "sentrySeam").length], [1, 0, 0, 0]);
    }));

  needsDriver("FD-SV5f: the cursor of the materialization service is not moved by the hold step; the "
    + "service runs the hold (relationGroups source sentryHold, getStatus().sentryHolds)", () => H.withStore(driver,
    async (reopen) => {
      const base = bootBase(reopen);
      const order = (holdOn) => {
        const w = fakeWorld();
        w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: SYS },
          { characterId: CHAR, entityId: PLAYER_SHIP + 1, systemId: OTHER }];
        const listed = [];
        const battleLive = { listMaterializableInTx: (db, systemId) => {
          listed.push(systemId);
          return { ok: true, battles: [] };
        }, readLiveInTx: () => ({ ok: false }) };
        const presence = { getStatus: () => ({ available: true, stale: false }), isObserved: () => true,
          observedSystems: () => [SYS, OTHER], getSystemPresence: (id) => ({ systemId: id, space: 1 }) };
        const tracker = createLossTracker({ maxPending: 40 });
        w.tracker = tracker;
        const M = { ...DEFAULTS.materialization, maxLiveMaterializationsPerSystem: 48, garrisonLive: null };
        const service = createMaterializationService({ store: base.env.store, battleLive, npcSpawn: w.npcSpawn,
          budget: createPhysicalBudget({ limits: { perSystem: 48, global: 120 }, clock: base.shared.clock }),
          getPresence: () => presence, getGovernor: () => null, getBattleStatus: () => null, clock: base.shared.clock,
          settings: M, telemetry: null, logger: base.logger, nowMs: () => 0, lossImportOn: true,
          sentries: { settings: base.cfg.sentries.live, getSentries: () => base.sentries, getSeam: () => w.sentrySeam,
            getFactionKind: HOSTILITY.getFactionKind, huntSettings: DEFAULTS.playerHunt, isFactionEnemy: null,
            readStanding: HOSTILITY.readStanding, strengthGroups: GROUPS },
          sentryHold: holdOn ? { settings: { ...base.cfg.sentries.liveHold, maxSystemsPerScan: 1 },
            lossTracker: tracker, getHuntScene: () => w.scene, getSentrySeam: () => w.sentrySeam,
            getFleetExposure: () => base.fx, getFleets: () => base.env.fleets, getSentries: () => base.sentries,
            getFactionKind: HOSTILITY.getFactionKind, huntSettings: { ...DEFAULTS.playerHunt,
              hostileStandingMax: -5 }, isFactionEnemy: null, readStanding: HOSTILITY.readStanding,
            maxStandingReads: 32, strengthGroups: GROUPS, retreatLossPermille: 300 } : undefined });
        service.runPass(base.shared.clock.now());
        base.shared.clock.advance(base.cfg.sentries.liveHold.scanIntervalMs);
        service.runPass(base.shared.clock.now());
        const st = service.getStatus();
        service.stop("test");
        return { listed, st, w };
      };
      const off = order(false);
      const f = stagedSiege({ env: base.env, fleetOf: (id) => base.env.tx((db) => base.env.fleets.repository
        .getFleet(db, id)).fleet }, "sv5f");
      const on = order(true);
      assert.deepStrictEqual(on.listed, off.listed, "the battle scan order of the service is unchanged");
      assert.deepStrictEqual([off.st.sentryHolds, on.st.sentryHolds.counters.holdStarted, on.st.sentryHolds.cursor,
        on.st.sentryHolds.entries.map((x) => x.fleetId)], [{ state: "off" }, 1, SYS, [f.fleetId]]);
      assert.ok(on.w.of("engage").length === 0, "warning time: no engage in the claim pass");
    }));
};

module.exports.rig = Object.freeze({ setup, stagedSiege, SYS });
