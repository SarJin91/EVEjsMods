"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createBountyService } = require("../../lib/bounty/service");
const { escortsOf } = require("../../lib/bounty/live");
const { createJournal } = require("../../lib/persistence/journal");
const R = require("../../lib/bounty/repository");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const HOUR = 3600000;
const SIDE = 30;
const FACTIONS = Object.freeze([500010, 500011, 500012, 500019, 500020]);
const AGGRESSOR = 140000001;
const HIGHSEC = 13;

let base = null;
function settings(over = {}) {
  if (!base) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    base = r.config.bountyHunters;
  }
  return { ...base, enabled: true, liveEnabled: true, ...over };
}

function grid() {
  const idOf = (x, y) => y * SIDE + x + 1;
  return {
    getSystem: (id) => (Number.isInteger(id) && id >= 1 && id <= SIDE * SIDE ? { id,
      secClass: id === HIGHSEC ? "highsec"
        : Math.floor(Math.floor((id - 1) / SIDE) / 2) % 2 === 0 ? "lowsec" : "nullsec",
      regionId: 10000001, constellationId: 20000001 } : null),
    getNeighbors: (id) => {
      const x = (id - 1) % SIDE;
      const y = Math.floor((id - 1) / SIDE);
      const out = [];
      if (x > 0) out.push(idOf(x - 1, y));
      if (x < SIDE - 1) out.push(idOf(x + 1, y));
      if (y > 0) out.push(idOf(x, y - 1));
      if (y < SIDE - 1) out.push(idOf(x, y + 1));
      return out;
    },
    getSystemIds: () => Array.from({ length: SIDE * SIDE }, (_v, i) => i + 1),
  };
}
const factionOfId = (id) => FACTIONS[Math.floor(((id - 1) % SIDE) / 6)];
const systemFactionsOf = (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId,
  factionId: factionOfId(systemId) })) });

function fakeScene() {
  let next = 5000000000;
  const s = { calls: [], alive: new Map(), noBelts: false, warpRefuse: 0 };
  Object.assign(s, {
    isSceneLoaded: () => true,
    spawnGroup(spec) {
      s.calls.push(["spawnGroup", spec]);
      if (s.noBelts && spec.anchor.kind === "belt" && spec.anchor.gateFallback === false) {
        return { ok: false, reason: "NO_ANCHOR" };
      }
      const bossId = spec.boss ? (next += 1) : null;
      const escortIds = spec.escorts.map(() => (next += 1));
      for (const id of [bossId, ...escortIds]) if (id) s.alive.set(id, { aggressorId: null, inWarp: false });
      return { ok: true, bossId, escortIds, anchorPoint: { x: 0, y: 0, z: 0 },
        arrivalGate: spec.anchor.kind === "gateTo" };
    },
    readAggression: (_sys, ids) => ({ ok: true, ships: ids.map((entityId) => {
      const a = s.alive.get(entityId);
      return a ? { entityId, alive: true, aggressorId: a.aggressorId, inWarp: a.inWarp }
        : { entityId, alive: false, aggressorId: null, inWarp: false };
    }) }),
    warpOff(_sys, ids, from) {
      s.calls.push(["warpOff", ids.slice(), from]);
      if (s.warpRefuse > 0) {
        s.warpRefuse -= 1;
        return { ok: true, ordered: [], gone: [], failed: ids.slice() };
      }
      return { ok: true, ordered: ids.filter((id) => s.alive.has(id)), gone: [], failed: [] };
    },
    orderAttack(_sys, id, target) {
      s.calls.push(["orderAttack", id, target]);
      return { ok: true };
    },
    despawn(_sys, ids) {
      s.calls.push(["despawn", ids.slice()]);
      for (const id of ids) s.alive.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listAlive: (_sys, ids) => ids.filter((id) => s.alive.has(id)),
    markShips(ids, o) {
      s.calls.push(["mark", ids.slice(), o.role, o.version]);
      return { ok: true, marked: ids.length, evicted: 0 };
    },
    forgetShips(ids) {
      s.calls.push(["forget", ids.slice()]);
      return { ok: true, forgotten: ids.length };
    },
  });
  s.of = (name) => s.calls.filter((c) => c[0] === name);
  return s;
}

const GATE_BASE = 70000000;
function addGates(s) {
  Object.assign(s, { noGate: false, jumpReady: false, fleeFail: 0 });
  s.fleeToGate = (sys, id, to, o) => {
    s.calls.push(["fleeToGate", sys, id, to, o]);
    if (s.noGate) return { ok: false, reason: "NO_GATE" };
    if (s.fleeFail > 0) {
      s.fleeFail -= 1;
      return { ok: false, reason: "ORDER_FAILED", detail: "WARP_SCRAMBLED" };
    }
    return { ok: true, gateId: GATE_BASE + to, mode: "warp" };
  };
  s.jumpAtGate = (sys, id, gateId, o) => {
    s.calls.push(["jumpAtGate", sys, id, gateId, o]);
    return s.jumpReady ? { ok: true, jumped: true, fx: true } : { ok: true, jumped: false, distanceMeters: 50000 };
  };
  return s;
}

function fakePresence() {
  const p = { space: new Map() };
  p.observedSystems = () => [...p.space.keys()];
  p.getSystemPresence = (id) => (p.space.has(id) ? { systemId: id, space: p.space.get(id), docked: 0, transit: 0 }
    : null);
  return p;
}

let slotSeq = 0;
function seed(opened, rows) {
  const r = opened.store.transaction("lt.seed", (tx) => rows.map((row) => {
    slotSeq += 1;
    const made = R.createInTx(tx, { slot: slotSeq, cycle: 1, factionId: factionOfId(row.systemId),
      characterId: 91000000 + slotSeq, level: 1, archetype: "BRAWLER", smuggler: 0, nextMoveAt: T0 + 10 * HOUR,
      expiresAt: T0 + 24 * HOUR, rewardIsk: 3000000, seed: 77 + slotSeq, ...row }, T0);
    assert.ok(made.ok, JSON.stringify(made));
    return made.target.wantedId;
  }));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function rowOf(opened, wantedId) {
  const r = opened.store.transaction("lt.read", (db) => ({ ...db.prepare("SELECT * FROM world_bounty_targets "
    + "WHERE wanted_id = ?").get(wantedId) }));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function rig(opened, P, extra = {}) {
  const scene = fakeScene();
  const presence = fakePresence();
  const g = grid();
  let sceneReads = 0;
  const svc = createBountyService({ ...extra, store: opened.store, worldSeed: 7, settings: P, factionIds: FACTIONS,
    levels: LEVELS, getGraph: () => g, getVirtualCorps: () => null,
    homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 466 }),
    bloodlinesOf: () => [1], ownerCharacterBudget: 2048, systemFactionsOf, getPresence: () => presence,
    getBountyScene: () => {
      sceneReads += 1;
      return scene;
    },
    characterNameOf: () => "Kaito 'Viper' Ishimura" });
  assert.strictEqual(svc.boot(T0).ok, true);
  const pass = (t) => {
    const r = svc.runPass(t);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    return r;
  };
  return { svc, scene, presence, pass, sceneReads: () => sceneReads };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("L2/L4/L5 bounty LIVE on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("L2 onNpcKill: escort -> escorts_lost + 1, boss -> KILLED + PENDING, a second observation NOOP", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const [id] = seed(opened, [{ systemId: 63, level: 3 }]);
      const { svc, scene, presence, pass } = rig(opened, P);
      presence.space.set(63, 1);
      pass(T0 + 5000);
      const [, spec] = scene.of("spawnGroup")[0];
      assert.deepStrictEqual(spec.boss, { kind: "hull", hullClass: "cruiser" });
      const marks = scene.of("mark");
      const bossId = marks[0][1][0];
      const escortIds = marks[1][1];
      const version = marks[0][3];
      assert.ok(escortIds.length >= 2 && escortIds.length <= 3, String(escortIds.length));
      const obs = (role, victimId) => ({ characterId: 42, victimId, wantedId: id, version, role, systemId: 63,
        atMs: T0 + 9000 });
      assert.deepStrictEqual(svc.onNpcKill(obs("escort", escortIds[0]), T0 + 9000), { ok: true,
        outcome: "ESCORT_LOST" });
      let row = rowOf(opened, id);
      assert.deepStrictEqual([row.state, row.escorts_lost, row.version], ["LIVE", 1, version]);
      assert.deepStrictEqual(svc.onNpcKill(obs("boss", bossId), T0 + 10000), { ok: true, outcome: "KILLED" });
      row = rowOf(opened, id);
      assert.deepStrictEqual([row.state, row.killed_by, row.killed_at, row.ended_at, row.payout_state],
        ["KILLED", 42, T0 + 10000, T0 + 10000, "PENDING"]);
      assert.deepStrictEqual(svc.onNpcKill(obs("boss", bossId), T0 + 11000), { ok: true, outcome: "NOOP" });
      assert.strictEqual(rowOf(opened, id).version, row.version, "nothing written by the second observation");
      assert.strictEqual(svc.getStatus().counters.killLate, 1);
      assert.deepStrictEqual(svc.residentsFor([63], T0 + 11000).bySystem.size, 0, "the boss left Local");
      const despawnsBefore = scene.of("despawn").length;
      pass(T0 + 10000 + P.killedDespawnMs - 1000);
      assert.strictEqual(scene.of("despawn").length, despawnsBefore, "escort still there");
      pass(T0 + 10000 + P.killedDespawnMs);
      assert.strictEqual(scene.of("despawn").length, despawnsBefore + 1);
      assert.ok(scene.of("forget").some((c) => c[1].includes(bossId)));
      assert.strictEqual(svc.getStatus().live.groups, 0);
    });
  });

  test("L4 off = no seam call; spawn, RUNNER warp-off, tackle fight-back, escape with a move, idle despawn, docked, "
    + "highsec NO_ANCHOR retry, 300 targets / 2 observed systems", () => {
    withStore(driver, (opened) => {
      const [id] = seed(opened, [{ systemId: 3, archetype: "RUNNER" }]);
      const off = rig(opened, settings({ liveEnabled: false }));
      off.presence.space.set(3, 1);
      off.pass(T0 + 5000);
      off.pass(T0 + 10000);
      assert.strictEqual(off.sceneReads(), 0, "liveEnabled off -> no seam");
      assert.strictEqual(rowOf(opened, id).state, "ROAMING");
      off.svc.stop();

      const P = settings();
      const { svc, scene, presence, pass } = rig(opened, P);
      presence.space.set(3, 0);
      pass(T0 + 5000);
      assert.strictEqual(scene.of("spawnGroup").length, 0, "docked pilot only -> no spawn");
      presence.space.set(3, 1);
      let t = T0 + 10000;
      pass(t);
      const [, spec] = scene.of("spawnGroup")[0];
      assert.deepStrictEqual([spec.systemId, spec.anchor, spec.slimName, spec.archetype, spec.boss.hullClass,
        spec.escorts.length, spec.seedKey], [3, { kind: "belt", index: 0, gateFallback: true },
        "Kaito 'Viper' Ishimura", "RUNNER", "frigate", 0, id]);
      assert.strictEqual(rowOf(opened, id).state, "LIVE");
      const bossId = scene.of("mark")[0][1][0];
      pass((t += 5000));
      assert.strictEqual(scene.of("warpOff").length, 0, "no aggression -> no warp-off");
      scene.alive.get(bossId).aggressorId = AGGRESSOR;
      pass((t += 5000));
      assert.deepStrictEqual(scene.of("warpOff")[0], ["warpOff", [bossId], AGGRESSOR]);
      pass((t += P.runnerWarpRetryMs));
      assert.deepStrictEqual(scene.of("orderAttack"), [["orderAttack", bossId, AGGRESSOR]]);
      pass((t += P.runnerWarpRetryMs));
      assert.strictEqual(scene.of("warpOff").length, 2);
      scene.alive.delete(bossId);
      pass((t += 1000));
      assert.strictEqual(rowOf(opened, id).state, "LIVE", "escapeConfirmMs not over");
      pass((t += P.escapeConfirmMs));
      let row = rowOf(opened, id);
      assert.deepStrictEqual([row.state, row.trace_system_id, row.stay_index, row.trace_at], ["ROAMING", 3, 1, t]);
      assert.ok([2, 4].includes(row.system_id), String(row.system_id));
      assert.strictEqual(svc.getStatus().counters.escaped, 1);
      const there = row.system_id;
      presence.space.set(there, 1);
      pass((t += 5000));
      assert.strictEqual(scene.of("spawnGroup").length, 2);
      presence.space.set(there, 0);
      pass((t += P.idleDespawnMs - 5000));
      assert.strictEqual(rowOf(opened, id).state, "LIVE");
      pass((t += 5000));
      row = rowOf(opened, id);
      assert.deepStrictEqual([row.state, row.system_id, row.stay_index], ["ROAMING", there, 1]);
      assert.strictEqual(svc.getStatus().counters.despawned, 1);
      svc.stop();
    });

    withStore(driver, (opened) => {
      const [id] = seed(opened, [{ systemId: HIGHSEC }]);
      const P = settings();
      const { svc, scene, presence, pass } = rig(opened, P);
      scene.noBelts = true;
      presence.space.set(HIGHSEC, 1);
      pass(T0 + 5000);
      assert.strictEqual(scene.of("spawnGroup")[0][1].anchor.gateFallback, false, "highsec: belt only");
      assert.strictEqual(rowOf(opened, id).state, "ROAMING");
      assert.deepStrictEqual([svc.getStatus().counters.spawnFailed, svc.getStatus().counters.liveNoAnchor], [1, 1]);
      pass(T0 + 10000);
      pass(T0 + 5000 + P.liveRetryMs - 1000);
      assert.strictEqual(scene.of("spawnGroup").length, 1, "liveRetryMs not over");
      assert.ok(svc.getStatus().counters.liveRetryWait >= 2);
      pass(T0 + 5000 + P.liveRetryMs);
      assert.strictEqual(scene.of("spawnGroup").length, 2);
      svc.stop();
    });

    withStore(driver, (opened) => {
      const rows = Array.from({ length: 300 }, (_v, i) => ({ systemId: i + 1, level: i + 1 === 20 ? 2 : 1 }))
        .filter((r) => r.systemId !== HIGHSEC);
      const ids = seed(opened, rows);
      assert.strictEqual(ids.length, 299);
      const { svc, scene, presence, pass } = rig(opened, settings());
      presence.space.set(10, 1);
      presence.space.set(20, 2);
      pass(T0 + 5000);
      assert.deepStrictEqual(scene.of("spawnGroup").map((c) => c[1].systemId), [20], "level 2 first, one per pass");
      pass(T0 + 10000);
      pass(T0 + 15000);
      assert.deepStrictEqual(scene.of("spawnGroup").map((c) => c[1].systemId), [20, 10]);
      assert.strictEqual(svc.getStatus().live.groups, 2);
      svc.stop();
    });
  });

  test("L6: onResidentsChanged after a boss kill / an escape (never a despawn or a late "
    + "observation); the wake result of spawnGroup counted (liveWoken / liveWakeFailed + log)", () => {
    withStore(driver, (opened) => {
      const [id] = seed(opened, [{ systemId: 63, level: 3 }]);
      const changed = [];
      const lines = [];
      const P = settings();
      const { svc, scene, presence, pass } = rig(opened, P, { onResidentsChanged: (sid) => changed.push(sid),
        logger: { log: (l) => lines.push(l) } });
      const spawnGroup = scene.spawnGroup;
      scene.spawnGroup = (spec) => ({ ...spawnGroup(spec), wake: { woken: 2, failed: 1 } });
      presence.space.set(63, 1);
      pass(T0 + 5000);
      assert.deepStrictEqual([svc.getStatus().counters.liveWoken, svc.getStatus().counters.liveWakeFailed], [2, 1]);
      assert.ok(lines.some((l) => l.includes(`live wake ${id} (BRAWLER) refused for 1 ship(s)`)), lines.join("\n"));
      const marks = scene.of("mark");
      const bossId = marks[0][1][0];
      const obs = { characterId: 42, victimId: bossId, wantedId: id, version: marks[0][3], role: "boss", systemId: 63,
        atMs: T0 + 9000 };
      assert.deepStrictEqual(changed, [], "spawn -> no nudge");
      assert.deepStrictEqual(svc.onNpcKill(obs, T0 + 9000), { ok: true, outcome: "KILLED" });
      assert.deepStrictEqual(changed, [63], "the kill nudges the Local of the system");
      assert.deepStrictEqual(svc.onNpcKill(obs, T0 + 9500), { ok: true, outcome: "NOOP" });
      assert.deepStrictEqual(changed, [63], "a late observation -> no second nudge");
      svc.stop();
    });

    withStore(driver, (opened) => {
      const [id] = seed(opened, [{ systemId: 3, archetype: "RUNNER" }]);
      const changed = [];
      const P = settings();
      const { svc, scene, presence, pass } = rig(opened, P, { onResidentsChanged: (sid) => changed.push(sid) });
      presence.space.set(3, 1);
      let t = T0 + 10000;
      pass(t);
      const bossId = scene.of("mark")[0][1][0];
      scene.alive.get(bossId).aggressorId = AGGRESSOR;
      pass((t += 5000));
      scene.alive.delete(bossId);
      pass((t += 1000));
      pass((t += P.escapeConfirmMs));
      const row = rowOf(opened, id);
      assert.strictEqual(row.state, "ROAMING");
      assert.deepStrictEqual(changed, [3], "the escape nudges the system it left");
      presence.space.set(row.system_id, 1);
      pass((t += 5000));
      presence.space.set(row.system_id, 0);
      pass((t += P.idleDespawnMs));
      assert.strictEqual(svc.getStatus().counters.despawned, 1);
      assert.deepStrictEqual(changed, [3], "despawn -> no nudge");
      svc.stop();
    });
  });

  test("L5 AMBUSH escort after ambushDelayMs; maxLive 4; escorts cut to maxShipsPerTarget - 1", () => {
    withStore(driver, (opened) => {
      seed(opened, [{ systemId: 63, level: 3, archetype: "AMBUSH" }]);
      const P = settings();
      const { svc, scene, presence, pass } = rig(opened, P);
      presence.space.set(63, 1);
      pass(T0 + 5000);
      assert.strictEqual(scene.of("spawnGroup")[0][1].escorts.length, 0, "the escort waits");
      const bossId = scene.of("mark")[0][1][0];
      scene.alive.get(bossId).aggressorId = AGGRESSOR;
      pass(T0 + 10000);
      pass(T0 + 10000 + P.ambushDelayMs - 1000);
      assert.strictEqual(scene.of("spawnGroup").length, 1);
      assert.strictEqual(scene.of("warpOff").length, 0, "an ambush boss never warps off");
      pass(T0 + 10000 + P.ambushDelayMs);
      const late = scene.of("spawnGroup")[1][1];
      assert.deepStrictEqual([late.boss, late.anchor], [null, { kind: "entity", entityId: bossId }]);
      assert.ok(late.escorts.length >= 2 && late.escorts.length <= 3);
      assert.deepStrictEqual(scene.of("mark")[1].slice(2), ["escort", scene.of("mark")[0][3]]);
      pass(T0 + 60000);
      assert.strictEqual(scene.of("spawnGroup").length, 2, "one late escort");
      svc.stop();
    });

    withStore(driver, (opened) => {
      const systems = [61, 63, 65, 67, 69, 71];
      seed(opened, systems.map((systemId) => ({ systemId, level: 6 })));
      const P = settings({ maxShipsPerTarget: 3 });
      const { svc, scene, presence, pass } = rig(opened, P);
      for (const s of systems) presence.space.set(s, 1);
      for (let i = 1; i <= 8; i += 1) pass(T0 + i * 5000);
      const spawns = scene.of("spawnGroup");
      assert.strictEqual(spawns.length, P.maxLive, "maxLive 4");
      assert.strictEqual(svc.getStatus().live.groups, 4);
      assert.ok(svc.getStatus().counters.liveDeferred >= 2);
      for (const [, spec] of spawns) {
        assert.strictEqual(spec.escorts.length, 2, "maxShipsPerTarget 3 -> 2 escorts");
        assert.deepStrictEqual(spec.boss, { kind: "capital", hullClass: "battleship" });
      }
      svc.stop();
    });
  });

  test("LN1: a refused bounty.kill (not CAS_LOST) is retried -> KILLED + PENDING, never an escape "
    + "The killed boss goes to despawn too", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const [id] = seed(opened, [{ systemId: 3, archetype: "RUNNER" }]);
      let refuse = 1;
      const store = { ...opened.store, transaction(name, fn) {
        if (name === "bounty.kill" && refuse > 0) {
          refuse -= 1;
          return { ok: false, reason: "TX_FAILED" };
        }
        return opened.store.transaction(name, fn);
      } };
      const { svc, scene, presence, pass } = rig({ ...opened, store }, P);
      presence.space.set(3, 1);
      let t = T0 + 5000;
      pass(t);
      const [, bossIds, , version] = scene.of("mark")[0];
      const bossId = bossIds[0];
      scene.alive.get(bossId).aggressorId = AGGRESSOR;
      pass((t += 5000));
      assert.strictEqual(scene.of("warpOff").length, 1, "RUNNER warped off");
      const killAt = t + 1000;
      const obs = { characterId: 42, victimId: bossId, wantedId: id, version, role: "boss", systemId: 3, atMs: killAt };
      assert.deepStrictEqual(svc.onNpcKill(obs, killAt), { ok: false, reason: "TX_FAILED" });
      assert.strictEqual(svc.getStatus().live.pendingKills, 1);
      scene.alive.delete(bossId);
      pass((t += P.escapeConfirmMs + 5000));
      const row = rowOf(opened, id);
      assert.deepStrictEqual([row.state, row.killed_by, row.killed_at, row.payout_state],
        ["KILLED", 42, killAt, "PENDING"]);
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([c.escaped, c.lostScene, c.killRetry, c.killed, svc.getStatus().live.pendingKills],
        [0, 0, 1, 1, 0]);
      pass((t += P.killedDespawnMs));
      const last = scene.of("despawn").pop();
      assert.ok(last && last[1].includes(bossId), "allIds released");
      assert.strictEqual(svc.getStatus().live.groups, 0);
      svc.stop();
    });
  });

  test("P6 LIVE: smuggler freighter (2 escorts, warp-off after smugglerWarpOffDelayMs) with loot in the hold "
    + "the kill -> payout PENDING, journal BOUNTY_CLAIMED, claim line to the killer next pass", () => {
    withStore(driver, (opened) => {
      const P = settings({ smugglerEnabled: true, lootEnabled: true, maxShipsPerTarget: 12 });
      const [id] = seed(opened, [{ systemId: 63, level: 6, smuggler: 1, archetype: "RUNNER" }]);
      const lines = [];
      const officer = [];
      const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
      const { svc, scene, presence, pass } = rig(opened, P, { journal,
        sendCharacterSystemLine: (spec) => {
          lines.push(spec);
          return { ok: true };
        },
        rollOfficerLoot: (factionId, s) => {
          officer.push([factionId, s]);
          return { ok: true, items: [{ typeId: 99001, quantity: 1 }], skipped: 0 };
        } });
      presence.space.set(63, 1);
      let t = T0 + 5000;
      pass(t);
      const [, spec] = scene.of("spawnGroup")[0];
      assert.deepStrictEqual([spec.boss, spec.archetype], [{ kind: "freighter", hullClass: "battleship", jump: true },
        "SMUGGLER"]);
      const plain = escortsOf(R.toTarget(rowOf(opened, id)), LEVELS, 12, 0).length;
      assert.strictEqual(spec.escorts.length, plain + 2, "smuggler + 2 escorts");
      assert.ok(spec.cargo.some((it) => it.typeId === 99001) && spec.cargo.length >= 2, JSON.stringify(spec.cargo));
      assert.strictEqual(officer.length, 1);
      assert.strictEqual(svc.getStatus().counters.smugglerSpawned, 1);
      const [, bossIds, , version] = scene.of("mark")[0];
      scene.alive.get(bossIds[0]).aggressorId = AGGRESSOR;
      pass((t += 5000));
      pass((t += P.smugglerWarpOffDelayMs - 5000));
      assert.strictEqual(scene.of("warpOff").length, 0, "not before smugglerWarpOffDelayMs");
      pass((t += 5000));
      assert.strictEqual(scene.of("warpOff").length, 1);
      const obs = { characterId: 42, victimId: bossIds[0], wantedId: id, version, role: "boss", systemId: 63,
        atMs: t };
      assert.deepStrictEqual(svc.onNpcKill(obs, t), { ok: true, outcome: "KILLED" });
      const row = rowOf(opened, id);
      const pay = opened.store.transaction("lt.pay", (tx) => ({ ...tx.prepare("SELECT * FROM world_bounty_payouts")
        .get() }));
      assert.deepStrictEqual([pay.value.payout_key, pay.value.state, pay.value.amount_isk, pay.value.character_id],
        [`lne:bounty:${id}:${row.created_at}`, "PENDING", row.reward_isk, 42]);
      const j = opened.store.transaction("lt.j", (tx) => journal.listAfter(tx, { afterId: 0, uptoId: 1000000,
        aggregateTypes: ["bounty"], limit: 10 }));
      assert.ok(j.ok && j.value.ok, JSON.stringify(j));
      assert.deepStrictEqual(j.value.entries.map((e) => [e.aggregateType, e.eventType, e.payload.wantedId]),
        [["bounty", "BOUNTY_CLAIMED", id]]);
      assert.strictEqual(JSON.stringify(j.value.entries[0].payload).includes("42"), false, "no player in the fact");
      assert.strictEqual(lines.length, 0, "the line waits for the pass");
      pass((t += 1000));
      assert.deepStrictEqual(lines.map((l) => [l.characterId, l.systemId]), [[42, 63]]);
      assert.ok(lines[0].text.includes("Kaito 'Viper' Ishimura") && lines[0].text.includes("ISK"), lines[0].text);
      svc.stop();
    });
  });

  test("LN2: runnerWarpRetryMs 0 - a refused first warp-off is ordered again", () => {
    withStore(driver, (opened) => {
      seed(opened, [{ systemId: 3, archetype: "RUNNER" }]);
      const { svc, scene, presence, pass } = rig(opened, settings({ runnerWarpRetryMs: 0 }));
      presence.space.set(3, 1);
      pass(T0 + 5000);
      const bossId = scene.of("mark")[0][1][0];
      scene.alive.get(bossId).aggressorId = AGGRESSOR;
      scene.warpRefuse = 1;
      pass(T0 + 10000);
      pass(T0 + 15000);
      assert.ok(scene.of("warpOff").length >= 2, String(scene.of("warpOff").length));
      assert.strictEqual(svc.getStatus().live.live[0].phase, "warp");
      assert.strictEqual(svc.getStatus().counters.warpOff, 1);
      svc.stop();
    });
  });

  test("SN7: a group refused by the scene NPC budget - no write, no spawnFailed, retry after "
    + "liveRetryMs; a seam refusal after the pre-check is not spawnFailed either", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const [id] = seed(opened, [{ systemId: 63, level: 3 }]);
      let full = true;
      const gates = [];
      const { svc, scene, presence, pass } = rig(opened, P, { admitScene: (sys, n, source) => {
        gates.push([sys, n, source]);
        return full ? { ok: false, reason: "SCENE_NPC_BUDGET", count: 150, cap: 150 } : { ok: true, count: 0, cap: 150 };
      } });
      presence.space.set(63, 1);
      const before = rowOf(opened, id);
      pass(T0 + 5000);
      const after = rowOf(opened, id);
      assert.deepStrictEqual([after.state, after.version], [before.state, before.version], "no transaction");
      let c = svc.getStatus().counters;
      assert.deepStrictEqual([scene.of("spawnGroup").length, c.liveSceneRefused, c.spawnFailed], [0, 1, 0]);
      pass(T0 + 5000 + P.liveRetryMs - 1000);
      assert.strictEqual(gates.length, 1, "liveRetryMs not over");
      full = false;
      pass(T0 + 5000 + P.liveRetryMs);
      const [, spec] = scene.of("spawnGroup")[0];
      assert.deepStrictEqual(gates[1], [63, 1 + spec.escorts.length, "bounty"], "the whole group (boss + escorts)");
      assert.strictEqual(rowOf(opened, id).state, "LIVE");
      svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const [id] = seed(opened, [{ systemId: 63, level: 3 }]);
      const { svc, scene, presence, pass } = rig(opened, P, { admitScene: () => ({ ok: true, count: 0, cap: 150 }) });
      scene.spawnGroup = () => ({ ok: false, reason: "SCENE_NPC_BUDGET", count: 150, cap: 150 });
      presence.space.set(63, 1);
      pass(T0 + 5000);
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([rowOf(opened, id).state, c.liveSceneRefused, c.spawnFailed], ["ROAMING", 1, 0]);
      svc.stop();
    });
  });

  function fleeing(opened, P, extra = {}) {
    const [id] = seed(opened, [{ systemId: 3, archetype: "RUNNER" }]);
    const r = rig(opened, P, extra);
    addGates(r.scene);
    r.presence.space.set(3, 1);
    let t = T0 + 10000;
    r.pass(t);
    const bossId = r.scene.of("mark")[0][1][0];
    r.scene.alive.get(bossId).aggressorId = AGGRESSOR;
    r.pass((t += 5000));
    const flee = r.scene.of("fleeToGate");
    assert.strictEqual(flee.length, 1, "one flee order at the first aggression");
    return { ...r, id, bossId, t, x: flee[0][3] };
  }

  function jumpOut(f, P, t0) {
    let t = t0;
    f.scene.jumpReady = true;
    f.pass((t += 5000));
    assert.strictEqual(f.svc.getStatus().live.live[0].phase, "jumping");
    f.pass((t += P.gateJumpDespawnMs));
    return t;
  }

  test("BTA1: RUNNER aggressed -> fleeToGate to the pickEscape neighbour (no warpOff), jump "
    + "at the gate -> escaped after gateJumpDespawnMs, row ROAMING in that system, trace = origin", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const lines = [];
      const f = fleeing(opened, P, { logger: { log: (l) => lines.push(l) } });
      let t = f.t;
      assert.ok([2, 4].includes(f.x), String(f.x));
      assert.deepStrictEqual(f.scene.of("fleeToGate")[0], ["fleeToGate", 3, f.bossId, f.x,
        { landingMeters: P.gateLandingMeters, jumpRangeMeters: P.gateJumpRangeMeters }]);
      assert.strictEqual(f.scene.of("warpOff").length, 0, "no vendor warp-off");
      assert.strictEqual(f.svc.getStatus().live.live[0].phase, "gate");
      const checks = f.scene.of("jumpAtGate").length;
      f.scene.alive.get(f.bossId).inWarp = true;
      f.pass((t += 5000));
      assert.strictEqual(f.scene.of("jumpAtGate").length, checks, "in warp: no jump check");
      f.scene.alive.get(f.bossId).inWarp = false;
      f.scene.jumpReady = true;
      f.pass((t += 5000));
      assert.deepStrictEqual(f.scene.of("jumpAtGate").pop(), ["jumpAtGate", 3, f.bossId, GATE_BASE + f.x,
        { jumpRangeMeters: P.gateJumpRangeMeters }]);
      f.pass((t += P.gateJumpDespawnMs - 1000));
      assert.strictEqual(rowOf(opened, f.id).state, "LIVE", "gateJumpDespawnMs not over");
      f.pass((t += 1000));
      const row = rowOf(opened, f.id);
      assert.deepStrictEqual([row.state, row.system_id, row.trace_system_id, row.stay_index], ["ROAMING", f.x, 3, 1]);
      assert.ok(f.scene.of("despawn").some((c) => c[1].includes(f.bossId)), "the group left the scene");
      assert.strictEqual(f.scene.of("fleeToGate").length, 1);
      const c = f.svc.getStatus().counters;
      assert.deepStrictEqual([c.escaped, c.gateJump, c.fleeGate, c.fleeNoGate, c.warpOff], [1, 1, 1, 0, 0]);
      assert.strictEqual(lines.filter((l) => l.includes(`live escape ${f.id} RUNNER 3->${f.x} via gate `
        + `${GATE_BASE + f.x}`)).length, 1, lines.join("\n"));
      f.svc.stop();
    });
  });

  test("BTA2: held on grid -> fleeToGate again after fleeRetryMs (fleeRetry); NO_GATE -> "
    + "warpOff (fleeNoGate) with the saved move; escapeViaGate false -> warpOff as before", () => {
    withStore(driver, (opened) => {
      const P = settings({ runnerWarpRetryMs: 0 });
      const [id] = seed(opened, [{ systemId: 3, archetype: "RUNNER" }]);
      const r = rig(opened, P);
      addGates(r.scene);
      r.scene.fleeFail = 1;
      r.presence.space.set(3, 1);
      let t = T0 + 10000;
      r.pass(t);
      const bossId = r.scene.of("mark")[0][1][0];
      r.scene.alive.get(bossId).aggressorId = AGGRESSOR;
      r.pass((t += 5000));
      const t1 = t;
      r.pass((t += 5000));
      assert.deepStrictEqual([r.scene.of("fleeToGate").length, r.scene.of("jumpAtGate").length], [1, 0],
        "no gate id yet, no retry before fleeRetryMs");
      r.pass((t = t1 + P.fleeRetryMs));
      assert.strictEqual(r.scene.of("fleeToGate").length, 2, "retried");
      r.pass((t += 5000));
      assert.strictEqual(r.scene.of("jumpAtGate").length, 1, "held, not at the gate");
      r.pass((t = t1 + 2 * P.fleeRetryMs));
      const flee = r.scene.of("fleeToGate");
      assert.strictEqual(flee.length, 3, "held (not in warp, not jumped) -> retried");
      assert.ok(flee.every((c) => c[3] === flee[0][3]), "one escape system");
      const c = r.svc.getStatus().counters;
      assert.deepStrictEqual([c.fleeGate, c.fleeRetry, c.warpOff, rowOf(opened, id).state], [1, 2, 0, "LIVE"]);
      r.svc.stop();
    });

    withStore(driver, (opened) => {
      const P = settings();
      const lines = [];
      const [id] = seed(opened, [{ systemId: 3, archetype: "RUNNER" }]);
      const r = rig(opened, P, { logger: { log: (l) => lines.push(l) } });
      addGates(r.scene);
      r.scene.noGate = true;
      r.presence.space.set(3, 1);
      let t = T0 + 10000;
      r.pass(t);
      const bossId = r.scene.of("mark")[0][1][0];
      r.scene.alive.get(bossId).aggressorId = AGGRESSOR;
      r.pass((t += 5000));
      assert.deepStrictEqual(r.scene.of("warpOff")[0], ["warpOff", [bossId], AGGRESSOR]);
      const x = r.scene.of("fleeToGate")[0][3];
      pass2(r, P, t);
      assert.strictEqual(r.scene.of("fleeToGate").length, 1, "after NO_GATE the group keeps the warp-off");
      assert.strictEqual(r.scene.of("warpOff").length, 2);
      r.scene.alive.delete(bossId);
      r.pass((t += 2 * P.runnerWarpRetryMs + 1000));
      r.pass((t += P.escapeConfirmMs));
      const row = rowOf(opened, id);
      assert.deepStrictEqual([row.state, row.system_id, row.trace_system_id], ["ROAMING", x, 3], "the saved move");
      const c = r.svc.getStatus().counters;
      assert.deepStrictEqual([c.fleeNoGate, c.fleeGate, c.escaped, c.gateJump], [1, 0, 1, 0]);
      assert.strictEqual(lines.filter((l) => l.includes(`live flee ${id} (RUNNER) without a gate - NO_GATE`)).length,
        1, lines.join("\n"));
      r.svc.stop();
    });

    withStore(driver, (opened) => {
      seed(opened, [{ systemId: 3, archetype: "RUNNER" }]);
      const r = rig(opened, settings({ escapeViaGate: false }));
      addGates(r.scene);
      r.presence.space.set(3, 1);
      r.pass(T0 + 10000);
      const bossId = r.scene.of("mark")[0][1][0];
      r.scene.alive.get(bossId).aggressorId = AGGRESSOR;
      r.pass(T0 + 15000);
      assert.deepStrictEqual([r.scene.of("warpOff").length, r.scene.of("fleeToGate").length], [1, 0]);
      r.svc.stop();
    });
  });

  function pass2(r, P, t0) {
    r.pass(t0 + P.runnerWarpRetryMs);
    r.pass(t0 + 2 * P.runnerWarpRetryMs);
  }

  test("BTA3: after a jump the next spawn in X within followSpawnWindowMs anchors at the gate "
    + "back to the origin (arrivalSpawn); after the window the belt", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const f = fleeing(opened, P);
      let t = jumpOut(f, P, f.t);
      assert.strictEqual(rowOf(opened, f.id).system_id, f.x);
      f.presence.space.set(f.x, 1);
      f.pass((t += 5000));
      const spawns = f.scene.of("spawnGroup");
      assert.strictEqual(spawns.length, 2);
      assert.deepStrictEqual(spawns[1][1].anchor, { kind: "gateTo", systemId: 3, index: 1, gateFallback: true });
      assert.strictEqual(f.svc.getStatus().counters.arrivalSpawn, 1);
      f.svc.stop();
    });

    withStore(driver, (opened) => {
      const P = settings();
      const f = fleeing(opened, P);
      const t = jumpOut(f, P, f.t);
      f.presence.space.set(f.x, 1);
      f.pass(t + P.followSpawnWindowMs);
      const spawns = f.scene.of("spawnGroup");
      assert.strictEqual(spawns.length, 2);
      assert.deepStrictEqual(spawns[1][1].anchor, { kind: "belt", index: 1, gateFallback: true });
      assert.strictEqual(f.svc.getStatus().counters.arrivalSpawn, 0);
      f.svc.stop();
    });
  });

  test("GCE4 bounty live: gate controller flag on -> Departure of the boss at its gate before the despawn, the "
    + "follow spawn asks for gateEvents and counts the arrivals; flag off -> no call, no gateEvents", () => {
    const withDeparture = (s) => {
      s.presentGateDeparture = (sys, id, gateId) => {
        s.calls.push(["departure", sys, id, gateId]);
        return { ok: true, sent: true, queued: 1 };
      };
      const spawnGroup = s.spawnGroup;
      s.spawnGroup = (spec) => {
        const r = spawnGroup(spec);
        return spec.gateEvents === true ? { ...r, arrivals: 1 + r.escortIds.length } : r;
      };
    };
    withStore(driver, (opened) => {
      const P = settings({ gateControllerEventsEnabled: true });
      const f = fleeing(opened, P);
      withDeparture(f.scene);
      let t = jumpOut(f, P, f.t);
      const dep = f.scene.calls.findIndex((c) => c[0] === "departure");
      const gone = f.scene.calls.findIndex((c) => c[0] === "despawn" && c[1].includes(f.bossId));
      assert.deepStrictEqual(f.scene.calls[dep], ["departure", 3, f.bossId, GATE_BASE + f.x]);
      assert.ok(gone > dep, "Departure before the despawn");
      f.presence.space.set(f.x, 1);
      f.pass((t += 5000));
      const follow = f.scene.of("spawnGroup")[1][1];
      assert.deepStrictEqual([follow.anchor.kind, follow.gateEvents], ["gateTo", true]);
      const c = f.svc.getStatus().counters;
      assert.deepStrictEqual([c.gateDepartureEvents, c.gateArrivalEvents > 0], [1, true]);
      assert.ok(!("gateEvents" in f.scene.of("spawnGroup")[0][1]), "belt spawn: no gateEvents");
      f.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const f = fleeing(opened, P);
      withDeparture(f.scene);
      let t = jumpOut(f, P, f.t);
      f.presence.space.set(f.x, 1);
      f.pass((t += 5000));
      assert.deepStrictEqual(f.scene.of("departure"), []);
      assert.ok(f.scene.of("spawnGroup").every((c) => !("gateEvents" in c[1])));
      const c = f.svc.getStatus().counters;
      assert.deepStrictEqual([c.gateDepartureEvents, c.gateArrivalEvents], [0, 0]);
      f.svc.stop();
    });
  });
};
