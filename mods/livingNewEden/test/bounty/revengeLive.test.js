"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { MODULE_NAMES } = require("../../config");
const { createBountyService } = require("../../lib/bounty/service");
const { escortsOf } = require("../../lib/bounty/live");
const RV = require("../../lib/bounty/revenge");
const R = require("../../lib/bounty/repository");
const RR = require("../../lib/bounty/revengeRepository");
const { LEVELS, BOSS_SPAWN } = require("../../lib/bounty/data/levels");
const bountyScene = require("../../lib/adapter/bountyScene");
const huntScene = require("../../lib/adapter/huntScene");
const bountyVictims = require("../../lib/adapter/bountyVictims");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const T0 = 1760000000000;
const FACTION = 500010;
const KILLER = 42;
const KILLER_SHIP = 900001;
const BOSS_A = 7000;
const SYS = 4;
const GATE = Object.freeze({ x: 1000000000, y: 0, z: 0 });
const GANG = Object.freeze({ ok: true, state: "LINKED", characterIds: [BOSS_A, 7001, 7002, 7003],
  memberNames: [null, "Ana Hunter", "Bo Hunter", null], name: "Blood Gang" });

const readSource = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");

let resolved = null;
function base() {
  if (!resolved) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    resolved = r.config;
  }
  return resolved;
}
const settings = (over = {}) => ({ ...base().bountyHunters, enabled: true, liveEnabled: true, revengeEnabled: true,
  ...over });

function line() {
  return {
    getSystem: (id) => (Number.isInteger(id) && id >= 1 && id <= 10 ? { id, secClass: "lowsec", regionId: 10000001,
      constellationId: 20000001 } : null),
    getNeighbors: (id) => [id - 1, id + 1].filter((n) => n >= 1 && n <= 10),
    getSystemIds: () => Array.from({ length: 10 }, (_v, i) => i + 1),
    findRoute: (a, b) => ({ ok: true, jumps: Math.abs(a - b) }),
  };
}

function fakeHunt() {
  const h = { calls: [], players: new Map(), own: new Map(), aggressors: [], sceneLoaded: true };
  Object.assign(h, {
    readPlayerShips: (sys) => (h.sceneLoaded ? { ok: true, ships: (h.players.get(sys) || []).map((s) => ({ ...s })) }
      : { ok: false, reason: "SCENE_NOT_LOADED" }),
    readShips: (_sys, ids) => ({ ok: true, ships: ids.filter((id) => h.own.has(id))
      .map((id) => ({ entityId: id, ...h.own.get(id) })) }),
    readAggressors: (_sys, ids) => ({ ok: true, aggressors: h.aggressors.filter((a) => ids.includes(a.entityId)) }),
    setSearch(_sys, ids) {
      h.calls.push(["search", ids.slice()]);
      return { ok: true, failed: [] };
    },
    warpShips(_sys, ids, point, o) {
      h.calls.push(["warp", ids.slice(), point, o]);
      return { ok: true, warped: ids.length, failed: [] };
    },
    attackTargets(_sys, ids, targets) {
      h.calls.push(["attack", ids.slice(), targets.slice()]);
      return { ok: true, failed: [] };
    },
  });
  h.of = (name) => h.calls.filter((c) => c[0] === name);
  h.killerAt = (pos, over = {}) => h.players.set(SYS, [{ characterId: KILLER, entityId: KILLER_SHIP, position: pos,
    inWarp: false, cloaked: false, capsule: false, signatureRadius: 100, ...over }]);
  h.moveOwn = (pos) => {
    for (const id of h.own.keys()) h.own.set(id, { position: { ...pos }, inWarp: false });
  };
  return h;
}

function fakeScene(hunt) {
  let next = 6000000000;
  const s = { calls: [], refuse: null, onSpawn: null };
  Object.assign(s, {
    spawnGroup(spec) {
      s.calls.push(["spawnGroup", spec]);
      if (s.onSpawn) s.onSpawn(spec);
      if (s.refuse) return { ok: false, reason: s.refuse };
      const bossId = (next += 1);
      const escortIds = spec.escorts.map(() => (next += 1));
      for (const id of [bossId, ...escortIds]) hunt.own.set(id, { position: { ...GATE }, inWarp: false });
      return { ok: true, bossId, escortIds, anchorPoint: { ...GATE } };
    },
    despawn(_sys, ids) {
      s.calls.push(["despawn", ids.slice()]);
      for (const id of ids) hunt.own.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    markShips(ids, o) {
      s.calls.push(["mark", ids.slice(), o]);
      return { ok: true, marked: ids.length, evicted: 0 };
    },
    forgetShips(ids) {
      s.calls.push(["forget", ids.slice()]);
      return { ok: true, forgotten: ids.length };
    },
    isSceneLoaded: () => true,
    readAggression: (_sys, ids) => ({ ok: true, ships: ids.map((entityId) => ({ entityId, alive: true,
      aggressorId: null, inWarp: false })) }),
    warpOff: (_sys, ids) => ({ ok: true, ordered: ids.slice(), gone: [], failed: [] }),
    orderAttack: () => ({ ok: true }),
    listAlive: (_sys, ids) => ids,
  });
  s.of = (name) => s.calls.filter((c) => c[0] === name);
  return s;
}

function fakePresence() {
  const p = { chars: new Map(), space: new Map() };
  p.observedSystems = () => [...new Set([...p.space.keys(), ...[...p.chars.values()].map((c) => c.systemId)])];
  p.getSystemPresence = (id) => ({ systemId: id, space: p.space.get(id) || 0, docked: 0, transit: 0,
    characters: [...p.chars].filter(([, c]) => c.systemId === id).map(([characterId, c]) => ({ characterId,
      state: c.state })) });
  return p;
}

const sql = (opened, text, ...args) => {
  const r = opened.store.transaction("rl.sql", (db) => db.prepare(text).all(...args).map((x) => ({ ...x })));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const rowOf = (opened, revengeId) => sql(opened, "SELECT * FROM world_bounty_revenge WHERE revenge_id = ?",
  revengeId)[0];

function revengeRow(opened, P, over = {}) {
  const killedAt = T0 - P.revengeDelayMs - 1000;
  const r = opened.store.transaction("rl.rev", (tx) => RR.createRevengeInTx(tx, { wantedId: "bnt:1:1",
    characterId: KILLER, factionId: FACTION, gangId: 1, bossCharacterId: BOSS_A, targetLevel: 4, killSystemId: 3,
    killedAt, seed: 4, delayMs: P.revengeDelayMs, windowMs: P.revengeWindowMs, ...over }, killedAt));
  assert.ok(r.ok && r.value.ok && r.value.created, JSON.stringify(r));
  return r.value.revenge;
}

function busyTarget(opened) {
  const r = opened.store.transaction("rl.busy", (tx) => R.createInTx(tx, { slot: 90, cycle: 1, factionId: FACTION,
    characterId: 7001, level: 1, archetype: "BRAWLER", smuggler: 0, systemId: 9, nextMoveAt: T0 + 36000000,
    expiresAt: T0 + 86400000, rewardIsk: 3000000, seed: 3 }, T0));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

function rig(opened, P, opts = {}) {
  const hunt = fakeHunt();
  const scene = fakeScene(hunt);
  const presence = fakePresence();
  const g = line();
  const lines = [];
  const sent = [];
  const vc = { getOwnerIdentity: (_kind, gangId) => (gangId === 1 ? { ...GANG, ...(opts.gang || {}) }
    : { ok: true, state: "PENDING" }) };
  const svc = createBountyService({ store: opened.store, worldSeed: 7, logger: { log: (l) => lines.push(l) },
    settings: P, factionIds: [FACTION], levels: LEVELS, getGraph: () => g, getVirtualCorps: () => vc,
    homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 1 }), bloodlinesOf: () => [1],
    ownerCharacterBudget: 2048, systemFactionsOf: (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId,
      factionId: FACTION })) }), getPresence: () => presence, getBountyScene: () => scene,
    getHuntScene: () => hunt, getHuntParams: () => base().playerHunt, characterNameOf: (id) => `Pilot ${id}`,
    sendCharacterSystemLine: (spec) => {
      sent.push(spec);
      return { ok: true };
    } });
  assert.strictEqual(svc.boot(opts.at || T0).ok, true);
  const pass = (t) => {
    const r = svc.runPass(t);
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)} ${lines.join(" | ")}`);
    return r;
  };
  presence.chars.set(KILLER, { systemId: SYS, state: "space" });
  presence.space.set(SYS, 1);
  hunt.killerAt({ x: 0, y: 0, z: 0 });
  return { svc, hunt, scene, presence, pass, lines, sent, counters: () => svc.getStatus().counters };
}

module.exports = ({ test, skip }) => {
  test("RL1 vendor facts; bountyScene gate anchor (index % gates by itemID, none -> NO_ANCHOR), HUNTER escorts; "
    + "role hunter; GAME_MODULES consumer bountyRevenge", () => {
    assert.match(readSource("space/npc/npcRuntime.js"), /^function warpToPoint\(entityID, point, options = \{\}\) \{$/m);
    assert.match(readSource("space/npc/npcRuntime.js"), /^ {2}warpToPoint,$/m);
    assert.match(readSource("space/npc/npcService.js"), /^ {2}setBehaviorOverrides,$/m);

    const SYSTEM = 30002510;
    const gates = [50000003, 50000001, 50000002].map((itemID, i) => ({ kind: "stargate", itemID,
      position: { x: i + 1, y: 0, z: 0 } }));
    const belt = { kind: "asteroidBelt", itemID: 40000001, position: { x: 9, y: 9, z: 9 } };
    const scenes = new Map([[SYSTEM, { staticEntities: [...gates, belt], getEntityByID: () => null }],
      [SYSTEM + 1, { staticEntities: [belt], getEntityByID: () => null }]]);
    const modules = { "space/runtime": { isSolarSystemSceneLoaded: (id) => scenes.has(id), scenes },
      "space/npc/npcService": { getControllerByEntityID() {}, issueManualOrder() {}, wakeNpcController() {} } };
    const spawned = [];
    const spawn = { resolveProfiles: () => ({ ok: true, profiles: ["parity_blood_cruiser_1"] }),
      spawnShip: (_sys, spec) => {
        spawned.push(spec);
        return { ok: true, entityId: 8000000 + spawned.length };
      },
      publish: () => ({ ok: true }), despawn: () => ({ ok: true }) };
    const seam = bountyScene.createBountyScene({ requireGame: (rel) => (modules[rel] ? { ok: true,
      exports: modules[rel] } : { ok: false }), getSpawn: () => spawn, getSpawnTools: () => ({ ok: false }) });
    const spec = { systemId: SYSTEM, anchor: { kind: "gate", index: 4 }, factionId: FACTION,
      boss: { kind: "hull", hullClass: "cruiser" }, escorts: [{ hullClass: "frigate" }], slimName: "Bo Hunter",
      archetype: "HUNTER", seedKey: "rev:bnt:1:1" };
    const r = seam.spawnGroup(spec);
    assert.deepStrictEqual([r.ok, r.bossId, r.escortIds, r.anchorPoint], [true, 8000001, [8000002], { x: 3, y: 0, z: 0 }]);
    assert.deepStrictEqual(spawned.map((s) => [s.anchorDescriptor.itemID, s.archetype]),
      [[50000002, "HUNTER"], [50000002, "HUNTER"]], "4 % 3 gates by itemID; escorts HUNTER");
    assert.strictEqual(seam.spawnGroup({ ...spec, systemId: SYSTEM + 1 }).reason, "NO_ANCHOR");
    assert.strictEqual(seam.spawnGroup({ ...spec, anchor: { kind: "gate", index: -1 } }).reason, "INVALID_INPUT");
    assert.deepStrictEqual(liveProfiles.BOUNTY_BEHAVIOR.HUNTER, { autoAggro: false, proximityAggroRangeMeters: 0 });

    bountyVictims.resetBountyVictimsForTests();
    try {
      assert.strictEqual(bountyVictims.markBountyShips([8000001], { wantedId: "rev:bnt:1:1", version: 2,
        role: "hunter", cap: 64 }).ok, true);
      assert.deepStrictEqual(bountyVictims.bountyShipOf(8000001), { wantedId: "rev:bnt:1:1", version: 2,
        role: "hunter" });
    } finally {
      bountyVictims.resetBountyVictimsForTests();
    }

    assert.ok(!MODULE_NAMES.includes("bountyRevenge"));
    const has = (p, name) => GAME_MODULES.some((e) => e.path === p && e.symbols.some((s) => s.name === name
      && s.consumers.includes("bountyRevenge") && s.wrap !== true && s.firstLoad !== true));
    for (const [p, name] of [["space/npc/npcRuntime", "warpToPoint"], ["space/npc/npcService", "setBehaviorOverrides"],
      ["space/worldData", "getStargatesForSystem"], ["space/worldData", "getStationsForSystem"],
      ["space/worldData", "getAsteroidBeltsForSystem"], ["space/worldData", "getCelestialsForSystem"]]) {
      assert.ok(has(p, name), `${p}.${name}`);
    }
  });

  test("RL5 facades: createRevengeStep methods, hunt / bounty scene methods of the revenge on the real facades", () => {
    const hunt = huntScene.createHuntScene({ requireGame: () => ({ ok: false }), data: liveProfiles });
    const scene = bountyScene.createBountyScene({ requireGame: () => ({ ok: false }) });
    for (const m of RV.REVENGE_HUNT_METHODS) {
      assert.ok(huntScene.SEAM_METHODS.includes(m) && typeof hunt[m] === "function", m);
    }
    for (const m of RV.REVENGE_SCENE_METHODS) {
      assert.ok(bountyScene.SEAM_METHODS.includes(m) && typeof scene[m] === "function", m);
    }
    const step = RV.createRevengeStep({ settings: settings(), store: {}, bump() {}, log() {}, onStale() {} });
    assert.deepStrictEqual(Object.keys(step).sort(), [...RV.REVENGE_STEP_METHODS].sort());
    assert.strictEqual(RV.revengeLineOf(null, ""), "Hunters of the gang have found you. The gang wants its revenge.");
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("RL2/RL3/RL4/RL5b revenge squads on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("RL2 start: CAS LIVE before spawnGroup (level - 1, gate, free leader by seed) -> search -> line; a refused "
    + "spawn -> WAITING due now + liveRetryMs, no attempt", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const rev = revengeRow(opened, P);
      busyTarget(opened);
      const { svc, hunt, scene, pass, sent, counters } = rig(opened, P);
      let stateAtSpawn = null;
      scene.onSpawn = () => { stateAtSpawn = rowOf(opened, rev.revengeId).state; };
      const t1 = T0 + 1000;
      pass(t1);
      assert.strictEqual(stateAtSpawn, "LIVE", "CAS before the spawn");
      const row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.system_id, row.commander_id, row.live_at], ["LIVE", SYS, 7002, t1]);
      const [[, spec]] = scene.of("spawnGroup");
      assert.deepStrictEqual([spec.systemId, spec.anchor, spec.boss, spec.slimName, spec.archetype, spec.seedKey,
        spec.factionId], [SYS, { kind: "gate", index: 4 }, BOSS_SPAWN[LEVELS[3].boss], "Bo Hunter", "HUNTER",
        rev.revengeId, FACTION]);
      assert.deepStrictEqual(spec.escorts, escortsOf({ level: 3, seed: 4, stayIndex: 0, escortsLost: 0 }, LEVELS,
        P.maxShipsPerTarget));
      const [[, ids, mark]] = scene.of("mark");
      assert.deepStrictEqual([ids.length, mark.role, mark.wantedId, mark.version], [1 + spec.escorts.length, "hunter",
        rev.revengeId, row.version]);
      assert.deepStrictEqual(hunt.of("search").map((c) => c[1]), [ids]);
      assert.deepStrictEqual(sent, [{ characterId: KILLER, systemId: SYS,
        text: "Bo Hunter of Blood Gang has found you. The gang wants its revenge." }]);
      const c = counters();
      assert.deepStrictEqual([c.revengeLive, c.revengeLine, c.revengeNoCommander], [1, 1, 0]);
      assert.deepStrictEqual(svc.getStatus().revenge.squads, [{ revengeId: rev.revengeId, systemId: SYS,
        phase: "SCAN", ships: ids.length, commander: true }]);
      svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const rev = revengeRow(opened, P);
      const { svc, scene, pass, counters } = rig(opened, P);
      scene.refuse = "NO_ANCHOR";
      pass(T0 + 1000);
      const row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.attempts, row.due_at, row.end_reason],
        ["WAITING", 0, T0 + 1000 + P.liveRetryMs, "NO_ANCHOR"]);
      const c = counters();
      assert.deepStrictEqual([c.revengeSpawnFailed, c.revengeNoAnchor, c.revengeLive], [1, 1, 0]);
      svc.stop();
    });
  });

  test("RL3 phases: SCAN hits on the first cycle (warmScan) -> warp at the killer -> attack on grid -> capsule -> "
    + "exit to the gate -> DONE TARGET_DOWN; a capsule before contact -> WAITING + 1 attempt", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const HP = base().playerHunt;
      const rev = revengeRow(opened, P);
      const { svc, hunt, scene, pass, counters } = rig(opened, P);
      const t1 = T0 + 1000;
      pass(t1);
      const ids = scene.of("mark")[0][1];
      pass(t1 + HP.scanCycleMs);
      const [warp] = hunt.of("warp");
      assert.deepStrictEqual([warp[1], warp[2], warp[3]], [ids, { x: HP.warpInDistanceMeters, y: 0, z: 0 },
        { spreadMeters: HP.landingSpreadMeters }], "warp in off the killer, on the side of the squad");
      hunt.moveOwn({ x: HP.warpInDistanceMeters, y: 0, z: 0 });
      pass(t1 + HP.scanCycleMs + 1000);
      assert.deepStrictEqual(hunt.of("attack").map((c) => [c[1], c[2]]), [[ids, [KILLER_SHIP]]]);
      assert.strictEqual(counters().revengeEngaged, 1);
      hunt.killerAt({ x: 0, y: 0, z: 0 }, { capsule: true });
      const t3 = t1 + HP.scanCycleMs + 2000;
      pass(t3);
      assert.deepStrictEqual(hunt.of("warp")[1][2], GATE, "the squad leaves through its gate (EXITING)");
      assert.strictEqual(rowOf(opened, rev.revengeId).state, "LIVE");
      pass(t3 + HP.warpStartGraceMs);
      const row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.end_reason, row.ended_at], ["DONE", "TARGET_DOWN", t3 + HP.warpStartGraceMs]);
      assert.deepStrictEqual([scene.of("despawn")[0][1], scene.of("forget")[0][1]], [ids, ids]);
      assert.deepStrictEqual([counters().revengeDone, svc.getStatus().revenge.squads], [1, []]);
      svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const HP = base().playerHunt;
      const rev = revengeRow(opened, P);
      const { svc, hunt, scene, pass, counters } = rig(opened, P);
      const t1 = T0 + 1000;
      pass(t1);
      assert.strictEqual(rowOf(opened, rev.revengeId).state, "LIVE");
      hunt.killerAt({ x: 0, y: 0, z: 0 }, { capsule: true });
      pass(t1 + 1000);
      pass(t1 + 1000 + HP.warpStartGraceMs);
      const row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.attempts, row.end_reason], ["WAITING", 1, "TARGET_DOWN"]);
      assert.deepStrictEqual([counters().revengeDone, counters().revengeEngaged, counters().revengeRetry],
        [0, 0, 1]);
      assert.deepStrictEqual([scene.of("despawn").length, svc.getStatus().revenge.squads], [1, []]);
      svc.stop();
    });
  });

  test("RL4 ends: TARGET_GONE without contact -> WAITING + 1 attempt, then EXPIRED at revengeMaxAttempts; after "
    + "ENGAGED -> DONE; liveEnabled off -> WAITING without an attempt; boot LIVE -> WAITING", () => {
    const HP = base().playerHunt;
    withStore(driver, (opened) => {
      const P = settings({ revengeMaxAttempts: 2 });
      const rev = revengeRow(opened, P);
      const { svc, hunt, scene, pass, counters } = rig(opened, P);
      const t1 = T0 + 1000;
      pass(t1);
      hunt.players.set(SYS, []);
      pass(t1 + 1000);
      const t2 = t1 + 1000 + HP.exitGraceMs;
      pass(t2);
      let row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.attempts, row.due_at, row.end_reason],
        ["WAITING", 1, t2 + P.revengeRetryMs, "TARGET_GONE"]);
      assert.deepStrictEqual([counters().revengeRetry, scene.of("despawn").length], [1, 1]);
      hunt.killerAt({ x: 0, y: 0, z: 0 });
      const t3 = t2 + P.revengeRetryMs;
      pass(t3);
      assert.strictEqual(rowOf(opened, rev.revengeId).state, "LIVE");
      assert.deepStrictEqual(scene.of("spawnGroup")[1][1].escorts, escortsOf({ level: 3, seed: 4, stayIndex: 1,
        escortsLost: 0 }, LEVELS, P.maxShipsPerTarget));
      hunt.players.set(SYS, []);
      pass(t3 + 1000);
      pass(t3 + 1000 + HP.exitGraceMs);
      row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.attempts, row.end_reason], ["EXPIRED", 1, "TARGET_GONE"]);
      assert.strictEqual(counters().revengeExpiredAttempts, 1);
      svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const rev = revengeRow(opened, P);
      const { svc, hunt, pass, counters } = rig(opened, P);
      const t1 = T0 + 1000;
      pass(t1);
      hunt.moveOwn({ x: 1000, y: 0, z: 0 });
      pass(t1 + 1000);
      assert.strictEqual(hunt.of("attack").length, 1, "the killer on grid at once");
      hunt.players.set(SYS, []);
      pass(t1 + 2000);
      pass(t1 + 2000 + HP.exitGraceMs);
      const row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.end_reason, row.attempts], ["DONE", "TARGET_GONE", 0]);
      assert.strictEqual(counters().revengeDone, 1);
      svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const rev = revengeRow(opened, P);
      const r1 = rig(opened, P);
      const t1 = T0 + 1000;
      r1.pass(t1);
      P.liveEnabled = false;
      r1.pass(t1 + 1000);
      let row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.attempts, row.due_at, row.end_reason],
        ["WAITING", 0, t1 + 1000, "DISABLED"]);
      assert.deepStrictEqual([r1.scene.of("despawn").length, r1.counters().revengeDisabled], [1, 1]);
      P.liveEnabled = true;
      r1.pass(t1 + 2000 + P.revengeCheckEveryMs);
      assert.strictEqual(rowOf(opened, rev.revengeId).state, "LIVE");
      r1.svc.stop();
      assert.strictEqual(rowOf(opened, rev.revengeId).state, "LIVE", "stop writes nothing");
      const r2 = rig(opened, P, { at: t1 + 3000 + P.revengeCheckEveryMs });
      row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual([row.state, row.attempts], ["WAITING", 0]);
      assert.strictEqual(r2.counters().revengeRecovered, 1);
      r2.svc.stop();
    });
  });

  test("RL5b residentsFor has the LIVE leader, planCreates skips it (characterBusy); a hunter kill is a counter", () => {
    withStore(driver, (opened) => {
      const P = settings({ createsPerPass: 8 });
      const rev = revengeRow(opened, P);
      const { svc, scene, pass, counters } = rig(opened, P, { gang: { memberIndexes: [0, 1, 2, 3] } });
      pass(T0 + 1000);
      const leader = rowOf(opened, rev.revengeId).commander_id;
      assert.ok(leader === 7002 || leader === 7003, String(leader));
      const res = svc.residentsFor([SYS, 9], T0 + 1000);
      assert.ok(res.ok && res.bySystem.get(SYS).includes(leader), JSON.stringify([...res.bySystem]));
      const targets = sql(opened, "SELECT character_id AS c FROM world_bounty_targets").map((x) => x.c);
      assert.ok(targets.length > 0 && !targets.includes(leader), JSON.stringify(targets));
      assert.ok(counters().characterBusy >= 1);
      const ids = scene.of("mark")[0][1];
      const row = rowOf(opened, rev.revengeId);
      assert.deepStrictEqual(svc.onNpcKill({ characterId: KILLER, victimId: ids[0], wantedId: rev.revengeId,
        version: row.version, role: "hunter", systemId: SYS, atMs: T0 + 2000 }, T0 + 2000),
      { ok: true, outcome: "HUNTER_LOST" });
      assert.strictEqual(counters().revengeHunterLost, 1);
      assert.strictEqual(rowOf(opened, rev.revengeId).version, row.version, "no transaction");
      svc.stop();
    });
  });
};
