"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const M = require("../../lib/worldBosses/machine");
const S = require("../../lib/worldBosses/schema");
const { decideClash } = require("../../lib/worldBosses/clash");
const { CATALOG_V1, validateCatalog } = require("../../lib/worldBosses/catalog");
const { createWorldBossRepository } = require("../../lib/worldBosses/repository");
const { createWorldBossService } = require("../../lib/worldBosses/service");
const { createJournal } = require("../../lib/persistence/journal");
const { createHeavyEventScene } = require("../../lib/adapter/heavyEventScene");
const { BOSS_PROFILE_IDS } = require("../../lib/adapter/data/bossProfiles");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const KINDS = validateCatalog(CATALOG_V1).kinds;
const DRIFTER = KINDS.get("drifter_swarm");
const CATALOG_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "space", "npc", "trigDrifter",
  "trigDrifterNpcCatalog.js");
const PILOT = 90000001;
const LIVE = Object.freeze({ maxMs: 7200000, abandonGraceMs: 120000 });
const LIVE_ENV = Object.freeze({ EVEJS_LNE_WORLD_BOSSES_ROLL_ENABLED: "0", EVEJS_LNE_WORLD_BOSSES_LIVE_ENABLED: "1",
  EVEJS_LNE_WORLD_BOSSES_DWELL_MS: "3600000" });

function fakeSeam() {
  const s = { players: [{ characterId: PILOT, entityId: 1 }], loaded: true, alive: new Set(), next: 100,
    spawnCalls: [], despawned: [], refuse: new Set(), failures: new Map(), despawnFail: false };
  s.seam = {
    readGrid: () => (s.loaded ? { ok: true, players: s.players.slice(), copies: 0 }
      : { ok: false, reason: "SCENE_NOT_LOADED" }),
    spawnPhase: (systemId, input) => {
      s.spawnCalls.push(input);
      const spawned = [];
      const unspawnable = [];
      for (const m of input.members) {
        const fails = s.failures.get(m.memberKey) || 0;
        if (s.refuse.has(m.memberKey)) unspawnable.push({ memberKey: m.memberKey, reason: "NO_PROFILE" });
        else if (fails > 0) {
          s.failures.set(m.memberKey, fails - 1);
          unspawnable.push({ memberKey: m.memberKey, reason: "SPAWN_FAILED" });
        } else {
          s.next += 1;
          s.alive.add(s.next);
          spawned.push({ memberKey: m.memberKey, entityId: s.next, hullGroup: m.hullGroup });
        }
      }
      return { ok: true, spawned, unspawnable };
    },
    readMembers: (systemId, ids) => (s.loaded ? { ok: true, live: ids.filter((id) => s.alive.has(id))
      .map((entityId) => ({ entityId, position: null })), gone: ids.filter((id) => !s.alive.has(id)) }
      : { ok: false, reason: "SCENE_NOT_LOADED" }),
    despawn: (systemId, ids) => {
      if (s.despawnFail) return { ok: false, reason: "DESPAWN_FAILED", failed: ids.slice() };
      s.despawned.push(...ids);
      for (const id of ids) s.alive.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
  };
  s.killAll = () => s.alive.clear();
  return s;
}

function rig(store, clock, opts = {}) {
  const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 2000 });
  const repo = createWorldBossRepository({ journal });
  const fk = F.fakes([5]);
  const scene = opts.scene || fakeSeam();
  const sites = { ...fk.sites, listSitesByEvent: (eventId) => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE",
    position: { x: 1, y: 2, z: 3 }, eventId }] }) };
  const presence = { observedSystems: () => [5], isObserved: (id) => id === 5,
    listPresence: () => [{ systemId: 7, characters: [{ characterId: PILOT }] },
      { systemId: 40, characters: [{ characterId: PILOT + 1 }] }] };
  const queued = [];
  const notices = { enqueueItemsInTx: (tx, items, now) => {
    queued.push({ items, now });
    return { ok: true, inserted: items.length, duplicates: 0 };
  } };
  const graph = F.makeGraph();
  const make = (bootAt) => createWorldBossService({ store, journal, repo, worldSeed: 1, bootAt,
    settings: F.settingsFor({ ...LIVE_ENV, ...(opts.env || {}) }), kinds: KINDS, getGraph: () => graph,
    getPresence: () => presence, getOccupation: () => fk.occupation, getSites: () => sites,
    getWorldRepository: () => fk.worldRepository, getScene: () => scene.seam, getNotices: () => notices,
    getGovernor: () => ({ admits: () => true }) });
  const svc = make(opts.bootAt || 1000);
  if (opts.spawn !== false) {
    const made = store.transaction("test.wbl.spawn", (tx) => svc.spawnInTx(tx, { kind: opts.kind || "drifter_swarm",
      originKind: "admin", originRef: "pm:1", systemId: 5, at: clock.now }, "admin:pm:1"));
    assert.strictEqual(made.value.ok, true, JSON.stringify(made));
  }
  return { svc, repo, scene, queued, make, journal };
}

function raw(store) {
  const r = store.transaction("test.wbl.raw", (db) => db.prepare("SELECT * FROM world_bosses").get());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const counters = (svc) => svc.getStatus().counters;

module.exports = ({ test, skip }) => {
  test("WBL1 decideLive: START gates, WAIT_LIVE blocks decideClash, EXIT after the grace / maxMs, phase end", () => {
    const row = { state: "DWELL", mode: "VIRTUAL", liveSince: null };
    const f = { now: 1000, gridPlayers: 1, sceneLoaded: true, lastGridSeenAt: null, alive: 0, pendingUnits: 10,
      openClashes: 0, governorOk: true, room: 12 };
    assert.deepStrictEqual(M.decideLive(row, f, LIVE), { action: "START", count: 10 });
    assert.deepStrictEqual(M.decideLive(row, { ...f, room: 4 }, LIVE), { action: "START", count: 4 });
    assert.deepStrictEqual(M.decideLive(row, { ...f, openClashes: 1 }, LIVE).reason, "OPEN_CLASHES");
    assert.deepStrictEqual(M.decideLive(row, { ...f, gridPlayers: 0 }, LIVE).reason, "NO_PLAYER");
    assert.deepStrictEqual(M.decideLive(row, { ...f, sceneLoaded: false }, LIVE).reason, "NO_PLAYER");
    assert.deepStrictEqual(M.decideLive(row, { ...f, governorOk: false }, LIVE).reason, "GOVERNOR");
    assert.deepStrictEqual(M.decideLive(row, { ...f, room: 0 }, LIVE).reason, "BUDGET");
    assert.deepStrictEqual(M.decideLive({ ...row, state: "MOVING" }, f, LIVE).reason, "NOT_DWELL");

    const live = { state: "DWELL", mode: "LIVE", liveSince: 1000, openClashes: [], factionId: 500024 };
    assert.deepStrictEqual(decideClash(live, [], () => true, { maxOpen: 4 }), { action: "WAIT_LIVE" });
    const g = { ...f, now: 5000, lastGridSeenAt: 5000, alive: 3, pendingUnits: 2, room: 2 };
    assert.deepStrictEqual(M.decideLive(live, g, LIVE), { action: "WAVE", count: 2 });
    assert.deepStrictEqual(M.decideLive(live, { ...g, room: 0 }, LIVE).action, "HOLD");
    const away = { ...g, gridPlayers: 0, lastGridSeenAt: 5000 };
    assert.deepStrictEqual(M.decideLive(live, { ...away, now: 5000 + 119999 }, LIVE).action, "HOLD");
    assert.deepStrictEqual(M.decideLive(live, { ...away, now: 5000 + 120000 }, LIVE),
      { action: "EXIT", reason: "ABANDONED" });
    assert.deepStrictEqual(M.decideLive(live, { ...g, now: 1000 + LIVE.maxMs }, LIVE),
      { action: "EXIT", reason: "MAX_TIME" });
    assert.deepStrictEqual(M.decideLive({ ...live, state: "MOVING" }, g, LIVE), { action: "EXIT", reason: "NOT_DWELL" });
    const done = { ...g, alive: 0, pendingUnits: 0 };
    assert.deepStrictEqual(M.decideLive(live, done, LIVE), { action: "NEXT_PHASE" });
    assert.deepStrictEqual(M.decideLive(live, { ...done, lastPhase: true }, LIVE), { action: "DEFEAT" });
    assert.deepStrictEqual(M.decideLive(live, { ...done, skippedUnits: 1 }, LIVE), { action: "EXIT", reason: "UNSPAWNABLE" });
    assert.deepStrictEqual(M.decideLive(live, { ...done, skippedUnits: 1, lastPhase: true }, LIVE),
      { action: "EXIT", reason: "UNSPAWNABLE" });
    assert.deepStrictEqual(M.decideLive(live, { ...done, skippedUnits: 0 }, LIVE), { action: "NEXT_PHASE" });
    assert.deepStrictEqual(M.decideLive(live, { ...done, skippedUnits: 0, lastPhase: true }, LIVE), { action: "DEFEAT" });
    const wave = M.nextWave(DRIFTER.phases[2], M.phaseUnits(DRIFTER.phases[2]), null, 99);
    assert.deepStrictEqual(wave.map((u) => [u.unitKey, u.flagship]), [["bs1", false], ["bs2", false], ["bs3", false],
      ["bs4", false], ["tyrannos1", true], ["strategos1", true]]);
    assert.deepStrictEqual(M.nextWave(DRIFTER.phases[2], { ...M.phaseUnits(DRIFTER.phases[2]), bs2: 0 },
      new Set(["bs1"]), 2).map((u) => u.unitKey), ["bs3", "bs4"]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("WBL2-WBL3 world boss LIVE on a store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("WBL2 START -> LIVE; loss key twice = HP 0 once; gone unseen -> pool; three phases -> DEFEATED + participant",
      () => withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock);
        const ends = [];
        R.svc.addEndListener((e) => ends.push(e.outcome));
        R.svc.livePass(clock.now);
        let b = raw(store);
        assert.deepStrictEqual([b.mode, b.live_boot_at, b.live_since, R.scene.alive.size], ["LIVE", 1000, F.T0, 10]);
        assert.deepStrictEqual([counters(R.svc).liveStarted, counters(R.svc).liveShips], [1, 10]);

        const lossOnce = () => store.transaction("test.wbl.loss", (tx) => {
          const row = R.repo.getInTx(tx, b.boss_id).row;
          const units = { ...JSON.parse(row.unitsJson), cruiser1: 0 };
          return R.repo.liveLossInTx(tx, { bossId: row.bossId, expectedVersion: row.version, from: row.state,
            to: row.state, now: clock.now, patch: { unitsJson: JSON.stringify(units) } },
          { key: S.keyLiveLoss(row.bossId, row.phase, "cruiser1"), eventType: S.EVENT.LIVE, payload: { action: "LOSS" } });
        }).value;
        assert.deepStrictEqual([lossOnce().duplicate, lossOnce().duplicate], [false, true]);
        assert.strictEqual(JSON.parse(raw(store).units_json).cruiser1, 0);

        const before = JSON.parse(raw(store).units_json);
        R.scene.players = [];
        const one = [...R.scene.alive][1];
        R.scene.alive.delete(one);
        clock.now += 5000;
        R.svc.livePass(clock.now);
        assert.strictEqual(counters(R.svc).liveLostUnseen, 1);
        assert.deepStrictEqual(JSON.parse(raw(store).units_json), before, "no HP written");
        R.scene.players = [{ characterId: PILOT, entityId: 1 }];
        clock.now += 5000;
        R.svc.livePass(clock.now);
        assert.strictEqual(R.scene.alive.size, 10, "the unit back to the pool spawned again");

        for (let phase = 1; phase <= 3; phase += 1) {
          R.scene.killAll();
          clock.now += 5000;
          R.svc.livePass(clock.now);
          if (phase < 3) {
            assert.strictEqual(raw(store).phase, phase + 1);
            clock.now += 5000;
            R.svc.livePass(clock.now);
            assert.strictEqual(R.scene.alive.size, phase === 1 ? 8 : 6, `wave of phase ${phase + 1}`);
          }
        }
        b = raw(store);
        assert.deepStrictEqual([b.state, b.mode, b.reward_state, b.end_reason, b.live_since],
          ["DEFEATED", "VIRTUAL", "PENDING", "DEFEATED", null]);
        assert.deepStrictEqual(ends, ["DEFEATED"]);
        const parts = store.transaction("test.wbl.parts", (tx) => R.repo.listParticipantsInTx(tx, b.boss_id, 8));
        assert.deepStrictEqual(parts.value.rows.map((p) => [p.characterId, p.phasesMask]), [[PILOT, 7]]);
        const c = counters(R.svc);
        assert.deepStrictEqual([c.liveLost, c.defeated, c.liveEnded, c.phaseCleared], [9 + 8 + 6, 1, 1, 3]);
        R.svc.livePass(clock.now + 5000);
        assert.deepStrictEqual(ends, ["DEFEATED"], "once");

        const T = rig(store, clock, { kind: "triglavian_armada", spawn: false,
          env: { EVEJS_LNE_WORLD_BOSSES_KINDS_CSV: "drifter_swarm,triglavian_armada" } });
        const made = store.transaction("test.wbl.spawn2", (tx) => T.svc.spawnInTx(tx, { kind: "triglavian_armada",
          originKind: "admin", originRef: "pm:2", systemId: 5, at: clock.now }, "admin:pm:2"));
        assert.strictEqual(made.value.ok, true, JSON.stringify(made));
        const id = made.value.bossId;
        store.transaction("test.wbl.phase3", (tx) => {
          const row = T.repo.getInTx(tx, id).row;
          return T.repo.transitionInTx(tx, { bossId: id, expectedVersion: row.version, from: row.state, to: row.state,
            now: clock.now, patch: { phase: 3, unitsJson: JSON.stringify(M.phaseUnits(KINDS.get("triglavian_armada")
              .phases[2])) } }, { key: "test:p3", eventType: S.EVENT.LIVE, payload: {} });
        });
        T.scene.refuse.add("zirnitra1");
        T.svc.livePass(clock.now);
        T.svc.livePass(clock.now + 5000);
        const tr = store.transaction("t", (db) => db.prepare("SELECT mode FROM world_bosses WHERE boss_id = ?")
          .get(id)).value;
        assert.deepStrictEqual([tr.mode, counters(T.svc).liveRefusedProfile, T.scene.alive.size, T.scene.spawnCalls
          .length], ["VIRTUAL", 1, 0, 1]);
        assert.strictEqual(T.scene.spawnCalls[0].members.find((m) => m.memberKey === "zirnitra1").profileId,
          "parity_trig_liminal_zirnitra");
      }));

    test("WBL3 recovery of a LIVE row of another boot -> VIRTUAL once; DEPART in LIVE held; ETA mail at a departure",
      () => withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock, { bootAt: 111, env: { EVEJS_LNE_WORLD_BOSSES_NOTICES_ENABLED: "1",
          EVEJS_LNE_WORLD_BOSSES_NOTICES_RADIUS_JUMPS: "3" } });
        R.svc.livePass(clock.now);
        const units = raw(store).units_json;
        assert.deepStrictEqual([raw(store).mode, raw(store).live_boot_at], ["LIVE", 111]);
        const due = raw(store).next_due_at;
        R.svc.runPass(due);
        assert.deepStrictEqual([raw(store).state, raw(store).next_due_at, counters(R.svc).liveHolds],
          ["DWELL", due + 1800000, 1]);

        const next = R.make(222);
        assert.strictEqual(next.liveRecover(clock.now + 10), 1);
        const b = raw(store);
        assert.deepStrictEqual([b.mode, b.live_since, b.live_boot_at, b.units_json], ["VIRTUAL", null, null, units]);
        assert.strictEqual(counters(next).liveRecovered, 1);
        assert.strictEqual(next.liveRecover(clock.now + 20), 0, "once");
        const keys = store.transaction("t", (db) => db.prepare(`SELECT idempotency_key FROM world_event_journal
          WHERE idempotency_key LIKE '%:recover:%'`).all()).value.map((r) => r.idempotency_key);
        assert.deepStrictEqual(keys, [`wb:${b.boss_id}:recover:222`]);

        next.runPass(b.next_due_at);
        assert.strictEqual(raw(store).state, "MOVING");
        assert.strictEqual(R.queued.length, 1);
        const [item] = R.queued[0].items;
        assert.deepStrictEqual([R.queued[0].items.length, item.eventKey, item.characterId, item.kind, item.systemId],
          [1, `wb:${b.boss_id}:eta:1`, PILOT, "WORLD_BOSS", raw(store).next_system_id]);
        assert.ok(/^[\x20-\x7E]+$/.test(item.line) && item.line.length <= 400 && item.line.includes("S5"), item.line);
        assert.strictEqual(counters(next).etaMails, 1);
      }));

    test("WBL6 a phase without a flagship, 1 of 10 spawned, it dies -> EXIT UNSPAWNABLE, VIRTUAL, HP kept, no restart",
      () => withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock);
        const before = JSON.parse(raw(store).units_json);
        for (const k of Object.keys(before)) if (k !== "cruiser1") R.scene.refuse.add(k);
        R.svc.livePass(clock.now);
        assert.deepStrictEqual([raw(store).mode, R.scene.alive.size], ["LIVE", 1]);
        R.scene.killAll();
        clock.now += 5000;
        R.svc.livePass(clock.now);
        const b = raw(store);
        const after = JSON.parse(b.units_json);
        assert.deepStrictEqual([b.mode, b.state, b.phase, after.cruiser1], ["VIRTUAL", "DWELL", 1, 0]);
        for (const k of Object.keys(before)) if (k !== "cruiser1") assert.strictEqual(after[k], before[k], k);
        const c = counters(R.svc);
        assert.deepStrictEqual([c.liveExitUnspawnable, c.phaseCleared, c.defeated], [1, 0, 0]);
        clock.now += 5000;
        R.svc.livePass(clock.now);
        assert.deepStrictEqual([R.scene.spawnCalls.length, raw(store).mode], [1, "VIRTUAL"], "marker: no restart");
      }));

    test("WBL7 transient spawn errors: retry in the next wave; flagship at start = cooldown; strays eat the room", () => {
      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock);
        R.scene.failures.set("cruiser2", 1);
        R.svc.livePass(clock.now);
        assert.deepStrictEqual([raw(store).mode, R.scene.alive.size, counters(R.svc).liveSpawnRetry], ["LIVE", 9, 1]);
        clock.now += 5000;
        R.svc.livePass(clock.now);
        assert.strictEqual(R.scene.alive.size, 10, "the retried unit in the next wave");
        R.scene.killAll();
        clock.now += 5000;
        R.svc.livePass(clock.now);
        assert.deepStrictEqual([raw(store).phase, raw(store).mode, counters(R.svc).liveExitUnspawnable], [2, "LIVE", 0]);
      });

      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const T = rig(store, clock);
        const id = raw(store).boss_id;
        store.transaction("test.wbl7.phase2", (tx) => {
          const row = T.repo.getInTx(tx, id).row;
          return T.repo.transitionInTx(tx, { bossId: id, expectedVersion: row.version, from: row.state, to: row.state,
            now: clock.now, patch: { phase: 2, unitsJson: JSON.stringify(M.phaseUnits(DRIFTER.phases[1])) } },
          { key: "test:wbl7:p2", eventType: S.EVENT.LIVE, payload: {} });
        });
        T.scene.failures.set("polemarkos1", 1);
        T.svc.livePass(clock.now);
        assert.deepStrictEqual([raw(store).mode, counters(T.svc).liveRefusedProfile, T.scene.alive.size,
          T.scene.spawnCalls.length], ["VIRTUAL", 1, 0, 1]);
        T.svc.livePass(clock.now + 5000);
        assert.strictEqual(T.scene.spawnCalls.length, 1, "cooldown");
        T.svc.livePass(clock.now + 300000);
        assert.deepStrictEqual([raw(store).mode, T.scene.spawnCalls.length, T.scene.alive.size], ["LIVE", 2, 8]);
      });

      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const D = rig(store, clock, { env: { EVEJS_LNE_WORLD_BOSSES_LIVE_MAX_SHIPS_PER_PHASE: "10" } });
        D.svc.livePass(clock.now);
        assert.deepStrictEqual([raw(store).mode, D.scene.alive.size], ["LIVE", 10]);
        D.scene.despawnFail = true;
        D.scene.players = [];
        clock.now += 120000;
        D.svc.livePass(clock.now);
        assert.deepStrictEqual([raw(store).mode, D.svc.getStatus().live.strayShips], ["VIRTUAL", 10]);
        D.scene.players = [{ characterId: PILOT, entityId: 1 }];
        clock.now += 5000;
        D.svc.livePass(clock.now);
        assert.deepStrictEqual([raw(store).mode, D.scene.spawnCalls.length, counters(D.svc).liveRefusedBudget],
          ["VIRTUAL", 1, 1]);
      });
    });
  }

  test("WBL4 vendor fact: BOSS_PROFILE_IDS are parity_drifter_/parity_trig_ ids of catalog keys without reinforcements",
    () => {
      const src = fs.readFileSync(CATALOG_SRC, "utf8").replace(/\r\n/g, "\n");
      assert.ok(src.includes("return `parity_drifter_${variant.key}`;"), "getDrifterProfileID");
      assert.ok(src.includes("return `parity_trig_${variant.key}`;"), "getTrigProfileID");
      assert.strictEqual(src.split("reinforcementVariantKey:").length - 1, 1, "only lancer calls reinforcements");
      for (const id of BOSS_PROFILE_IDS) {
        const m = /^parity_(drifter|trig)_([a-z_]+)$/.exec(id);
        assert.ok(m, id);
        const at = src.indexOf(`key: "${m[2]}",`);
        assert.ok(at >= 0, `key ${m[2]}`);
        const end = src.indexOf("key: \"", at + 6);
        assert.ok(!src.slice(at, end < 0 ? src.length : end).includes("reinforcementVariantKey:"), id);
      }
      const used = [...KINDS.values()].flatMap((k) => k.phases.flatMap((p) => p.units)).map((u) => u.profileId)
        .filter(Boolean);
      assert.deepStrictEqual([...new Set(used)].sort(), [...BOSS_PROFILE_IDS].sort());
    });

  test("WBL5 spawnPhase: profileId outside the list -> NO_PROFILE, listed -> its profile without resolveProfiles; "
    + "no field -> resolveProfiles", () => {
    const SYS = 30002510;
    const calls = { resolve: 0, ships: [] };
    let n = 500;
    const spawn = { resolveProfiles: () => {
      calls.resolve += 1;
      return { ok: true, profiles: ["resolved_profile"] };
    }, spawnShip: (systemId, opts) => {
      calls.ships.push(opts);
      n += 1;
      return { ok: true, entityId: n };
    }, publish: (systemId, ids) => ({ ok: true, published: ids.length }), despawn: () => ({ ok: true }) };
    const mods = { "space/runtime": { scenes: new Map([[SYS, { getEntityByID: () => null }]]),
      isSolarSystemSceneLoaded: (id) => id === SYS } };
    const seam = createHeavyEventScene({ requireGame: (rel) => ({ ok: true, exports: mods[rel] }),
      getNpcSpawn: () => spawn, getHuntScene: () => null });
    const base = { eventId: "wb:x:v1", factionId: 500024, anchorPoint: { x: 0, y: 0, z: 0 }, spawnDistanceM: 30000,
      aggroRangeM: 100000, leashRangeM: 200000 };
    const r = seam.spawnPhase(SYS, { ...base, members: [{ memberKey: "bogus1", hullGroup: "battleship",
      profileId: "parity_drifter_lancer" }, { memberKey: "strategos1", hullGroup: "dreadnought",
      profileId: "parity_drifter_strategos" }] });
    assert.deepStrictEqual([r.ok, r.unspawnable, r.spawned.map((x) => x.memberKey)],
      [true, [{ memberKey: "bogus1", reason: "NO_PROFILE" }], ["strategos1"]]);
    assert.deepStrictEqual([calls.resolve, calls.ships[0].profileId, calls.ships[0].guard.capital],
      [0, "parity_drifter_strategos", true]);
    const plain = seam.spawnPhase(SYS, { ...base, members: [{ memberKey: "bs1", hullGroup: "battleship" }] });
    assert.deepStrictEqual([plain.ok, calls.resolve, calls.ships[1].profileId, calls.ships[1].guard.capital],
      [true, 1, "resolved_profile", undefined]);
  });
};
