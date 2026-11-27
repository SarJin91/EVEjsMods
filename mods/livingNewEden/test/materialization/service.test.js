"use strict";

const assert = require("node:assert");

const { startMaterialization, createUnavailableMaterialization, MATERIALIZATION_METHODS } =
  require("../../lib/materialization");
const { COUNTER_NAMES, collectRelationGroups, combatGroupsOf } = require("../../lib/materialization/service");
const { startFleetExposure } = require("../../lib/fleetExposure");
const { SEAM_METHODS } = require("../../lib/adapter/npcSpawn");
const config = require("../../config");
const path = require("node:path");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { COUNTER_NAMES: HUNT_COUNTER_NAMES } = require("../../lib/materialization/huntStep");
const { createViewRegistry } = require("../../lib/observer/views");
const { planLiveMembers } = require("../../lib/battle/liveMembers");
const { harness: H } = require("../battle/settlement.test");
const { harness: C } = require("../battle/contacts.test");

const COMP2 = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const SYS = H.S.N5;
const SYS2 = H.S.N6;
const SYS3 = H.S.N7;
const HOLD_MS = 60000;

function fakeNpcSpawn(log) {
  const f = {
    scenes: new Set([SYS, SYS2, SYS3]),
    alive: new Map(),
    nextId: 5001,
    spawnCalls: 0,
    spawnFail: null,
    spawnOverride: null,
    profileResult: null,
    publishResult: null,
    despawnFail: new Set(),
    owners: [],
    profileOptions: [],
    anchorSpecs: [],
    gridCalls: [],
    resolveProfiles(requests, options) {
      log.push(["resolveProfiles", requests.length, options.seedPrefix]);
      f.profileOptions.push({ ...options });
      if (f.profileResult) return f.profileResult;
      return { ok: true, profiles: requests.map((r) => `prof_${r.factionId}_${r.hullGroup}`) };
    },
    isSceneLoaded: (sys) => f.scenes.has(sys),
    anchorCalls: [],
    pickAnchor(sys, opts) {
      f.anchorCalls.push(opts === undefined ? null : { ...opts });
      if (!f.scenes.has(sys)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, anchorDescriptor: { kind: "stargate", itemID: 50000001 } };
    },
    spawnShip(sys, spec) {
      f.spawnCalls += 1;
      log.push(["spawnShip", sys, spec.profileId, spec.spawnDistanceMeters]);
      f.owners.push([spec.profileId, spec.ownerId]);
      f.anchorSpecs.push(spec.anchorDescriptor);
      if (f.spawnFail) {
        const r = f.spawnFail(f.spawnCalls);
        if (r) return r;
      }
      if (f.spawnOverride) {
        const r = f.spawnOverride(sys, f.spawnCalls);
        if (r) return r;
      }
      const entityId = f.nextId;
      f.nextId += 1;
      f.alive.set(entityId, sys);
      return { ok: true, entityId };
    },
    engage(sys, sideA, sideB, opts) {
      log.push(["engage", sys, [...sideA], [...sideB], { ...opts }]);
      return { ok: true };
    },
    publish(sys, ids) {
      log.push(["publish", sys, [...ids]]);
      if (f.publishResult) return f.publishResult(ids);
      const published = ids.filter((id) => f.alive.has(id)).length;
      return { ok: true, published, missing: ids.length - published };
    },
    despawn(sys, ids) {
      log.push(["despawn", sys, [...ids]]);
      let removed = 0;
      let missing = 0;
      const failed = [];
      for (const id of ids) {
        if (f.despawnFail.has(id)) failed.push(id);
        else if (f.alive.delete(id)) removed += 1;
        else missing += 1;
      }
      if (failed.length > 0) return { ok: false, reason: "DESPAWN_FAILED", removed, missing, failed, detail: "boom" };
      return { ok: true, removed, missing };
    },
    countAlive: (sys, ids) => ids.filter((id) => f.alive.has(id)).length,
    listAlive: (sys, ids) => (f.scenes.has(sys) ? ids.filter((id) => f.alive.has(id)) : []),
    orderAttack(sys, entityId, targetId) {
      log.push(["orderAttack", sys, entityId, targetId]);
      return { ok: true };
    },
  };
  return f;
}

function withGridAnchor(f, result) {
  f.pickGridAnchor = (sys, grid) => {
    f.gridCalls.push([sys, { ...grid }]);
    return result(sys, grid);
  };
}

function fakePresence(systems) {
  const p = {
    observed: new Set(systems),
    st: { available: true, stale: false, reason: null },
    listeners: { observed: new Set(), unobserved: new Set() },
    getStatus() { return p.st; },
    isObserved: (id) => p.observed.has(id),
    observedSystems: () => [...p.observed].sort((a, b) => a - b),
    getSystemPresence: (id) => (p.observed.has(id)
      ? { systemId: id, total: 1, space: 1, docked: 0, transit: 0 } : null),
    distanceToObserved: (id) => ({ ok: true, distance: p.observed.has(id) ? 0 : null }),
    onSystemObserved(cb) {
      p.listeners.observed.add(cb);
      return { ok: true, unsubscribe: () => p.listeners.observed.delete(cb) };
    },
    onSystemUnobserved(cb) {
      p.listeners.unobserved.add(cb);
      return { ok: true, unsubscribe: () => p.listeners.unobserved.delete(cb) };
    },
    emitObserved(id) {
      for (const cb of [...p.listeners.observed]) cb(id);
    },
  };
  return p;
}

function setup(driver, opts = {}) {
  const presence = fakePresence(opts.observed || [SYS]);
  const env = C.createEnv(driver, { resolver: C.seamResolver(() => "DRAW"), presence,
    config: { "modules.materialization.enabled": true, ...(opts.config || {}) } });
  const log = [];
  const npc = fakeNpcSpawn(log);
  const gov = { overloaded: false, admits(wc) { return !gov.overloaded || wc === "SETTLEMENT" || wc === "LIVE"; } };
  const timers = [];
  const wrap = { revertThrows: 0, claimThrows: 0, beforeClaim: null };
  const T = (fn) => {
    const r = env.store.transaction("test.ms", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const battleView = () => {
    const b = env.battle;
    const live = { ...b.live,
      exitLiveInTx: (tx, req) => {
        log.push(["exitLiveInTx", req.battleId, req.reason]);
        return b.live.exitLiveInTx(tx, req);
      },
      markLiveInTx: (tx, req) => {
        log.push(["markLiveInTx", req.battleId]);
        return b.live.markLiveInTx(tx, req);
      },
      revertLiveClaimInTx: (tx, req) => {
        if (wrap.revertThrows > 0) {
          wrap.revertThrows -= 1;
          throw new Error("revert boom");
        }
        return b.live.revertLiveClaimInTx(tx, req);
      },
      claimLiveInTx: (tx, req, members) => {
        if (wrap.claimThrows > 0) {
          wrap.claimThrows -= 1;
          throw new Error("claim boom");
        }
        if (wrap.beforeClaim) wrap.beforeClaim(tx, req);
        return b.live.claimLiveInTx(tx, req, members);
      } };
    return { live, getStatus: () => b.getStatus() };
  };
  const views = createViewRegistry();
  const start = (extra = {}) => {
    const cfg = JSON.parse(JSON.stringify(env.cfg));
    Object.assign(cfg.materialization, extra.materialization || {});
    Object.assign(cfg.battle.liveEndMonitor, extra.liveEnd || {});
    const r = startMaterialization({ config: cfg, persistence: { ok: true, store: env.store }, clock: env.clock,
      adapter: { checkNpcSpawn: () => ({ ok: true }), getNpcSpawn: () => npc, ...(extra.adapter || {}) },
      getBattle: battleView,
      getPresence: () => presence, getGovernor: () => gov, telemetry: env.telemetry,
      logger: { log: (line) => env.lines.push(line) }, views: extra.views || views,
      setTimer: (fn, ms) => {
        timers.push(ms);
        return { cancel() {}, hasRef: () => false };
      }, hooks: extra.hooks, getFleets: extra.getFleets, ownerFactionIds: extra.ownerFactionIds,
      getPlayerHunt: extra.getPlayerHunt, getFactionKind: extra.getFactionKind,
      getFleetExposure: extra.getFleetExposure });
    assert.ok(r.ok, JSON.stringify(r));
    return r.materialization;
  };
  let n = 0;
  const mk = (system, structure, compA = COMP2, factionA = C.SANSHA) => {
    n += 1;
    const a = env.newFleet(`ms-a${n}`, factionA, system, compA);
    const b = env.newFleet(`ms-b${n}`, C.GURISTAS, system, COMP2);
    const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: env.fleet(id).version }] });
    const spec = { systemId: system, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
      maxResolutionMs: 20, garrison: null, sideA: side(factionA, a), sideB: side(C.GURISTAS, b), ...(structure || {}) };
    const created = T((db) => env.battle.repository.createBattle(db, spec, `ms:${n}:battle`));
    assert.strictEqual(created.ok, true, JSON.stringify(created));
    return created.battleId;
  };
  const rec = (id) => env.q("SELECT * FROM battle_records WHERE battle_id = ?", id)[0];
  const calls = (name) => log.filter((c) => c[0] === name);
  const count = (name) => env.telemetry.counts[`materialization.${name}`] || 0;
  const journal = (id, type) => env.n("SELECT count(*) AS n FROM world_event_journal WHERE aggregate_id = ? "
    + "AND event_type = ?", id, type);
  return { env, presence, npc, gov, log, timers, wrap, views, T, start, mk, rec, calls, count, journal };
}

const notPromise = (r) => {
  assert.ok(r && typeof r === "object" && typeof r.then !== "function" && !(r instanceof Promise), "never a Promise");
  return r;
};

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("MS-PR1 round 2: the pump shows an IDLE fleet as presence; a battle "
    + "of that fleet with a pending presence kill is deferred (PRESENCE_PENDING_LOSS, the kill counted by the presence "
    + "claim) and goes LIVE the next pass; a battle of a shown fleet despawns its presence ships before its spawn; "
    + "combatGroupsOf drops source presence", async () => {
    const s = setup(driver, { config: { "battle.liveLossImport.enabled": true, "fleetExposure.presence.enabled": true } });
    try {
      const { env } = s;
      const fx = startFleetExposure({ config: env.cfg, persistence: { ok: true, store: env.store,
        journal: env.journal }, clock: env.clock, getFleets: () => env.fleets, logger: { log() {} } });
      assert.ok(fx.ok, JSON.stringify(fx));
      let sink = null;
      const scene = {
        listSystemObjects: (sys, kinds) => ({ ok: true, objects: kinds.includes("stargate")
          ? [{ kind: "stargate", itemId: 50000001, position: { x: 0, y: 0, z: 0 }, toSystemId: SYS2 }] : [] }),
        readPlayerShips: () => ({ ok: true, ships: [{ characterId: 90000001, entityId: 99, position: { x: 0, y: 0,
          z: 0 }, inWarp: false }] }),
        readShips: (sys, ids) => ({ ok: true, ships: ids.filter((id) => s.npc.alive.has(id)).map((id) => ({
          entityId: id, position: { x: 0, y: 0, z: 0 }, inWarp: false })) }),
        readAggressors: () => ({ ok: true, aggressors: [] }),
        warpShips: (sys, ids) => ({ ok: true, warped: ids.length, failed: [] }),
      };
      const svc = s.start({ getFleets: () => env.fleets, getFleetExposure: () => fx.fleetExposure,
        adapter: { bindLiveLossSink: (fn) => {
          sink = fn;
          return { ok: true, unbind() {} };
        }, checkHuntScene: () => ({ ok: true }), getHuntScene: () => scene } });
      const battleOf = (a, tag) => {
        const b = env.newFleet(`${tag}-b`, C.GURISTAS, SYS, COMP2);
        const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: env.fleet(id).version }] });
        const spec = { systemId: SYS, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
          maxResolutionMs: 20, garrison: null, sideA: side(C.SANSHA, a), sideB: side(C.GURISTAS, b) };
        const created = s.T((db) => env.battle.repository.createBattle(db, spec, `${tag}:battle`));
        assert.strictEqual(created.ok, true, JSON.stringify(created));
        return created.battleId;
      };
      const shown = () => svc.getStatus().presence.entries;
      const a = env.newFleet("mspr-a", C.SANSHA, SYS, COMP2);
      svc.runPass();
      assert.deepStrictEqual(shown().map((e) => [e.fleetId, e.phase, e.ships]), [[a, "VISIBLE", 2]]);
      const id1 = battleOf(a, "mspr1");
      sink({ itemID: shown()[0].entityIds[0] }, { success: true });
      const r2 = svc.runPass();
      assert.deepStrictEqual([r2.refused.PRESENCE_PENDING_LOSS, r2.materialized], [1, []], JSON.stringify(r2));
      const st = svc.getStatus().presence;
      assert.deepStrictEqual([st.entries.length, st.counters.presenceLossDropped, st.counters.presenceClaimFailed],
        [0, 1, 1], "the claim of the ENGAGED fleet is refused, the kill counted");
      assert.deepStrictEqual(svc.runPass().materialized, [id1]);
      env.clock.advance(60000);
      const c = env.newFleet("mspr-c", C.SANSHA, SYS, COMP2);
      svc.runPass();
      const cShips = (shown().find((e) => e.fleetId === c) || { entityIds: [] }).entityIds;
      assert.strictEqual(cShips.length, 2, JSON.stringify(shown()));
      battleOf(c, "mspr2");
      const mark = s.log.length;
      svc.runPass();
      const after = s.log.slice(mark);
      const gone = after.findIndex((x) => x[0] === "despawn" && x[2].includes(cShips[0]));
      const spawn = after.findIndex((x) => x[0] === "spawnShip");
      assert.ok(gone >= 0 && spawn > gone, JSON.stringify(after.map((x) => x[0])));
      const groups = collectRelationGroups([], [[{ relationGroups: () => [{ systemId: SYS, entityIds: [1] }] },
        "presence"], [{ relationGroups: () => [{ systemId: SYS, entityIds: [2] }] }, "hunt"]], false);
      assert.deepStrictEqual(combatGroupsOf(groups).map((g) => g.source), ["hunt"]);
      fx.fleetExposure.stop();
    } finally {
      s.env.close();
    }
  });

  needsDriver("MS1 happy path: PENDING 2x2 -> LIVE in one synchronous pass (4 spawns, engage manual, one "
    + "publish before markLiveInTx, 4 ships reserved); two onSystemObserved + a pass -> no new spawn; a dead target "
    + "-> one orderAttack, then none; vendor mode -> no orderAttack", async () => {
    const s = setup(driver);
    try {
      const id = s.mk(SYS);
      const svc = s.start();
      const r = notPromise(svc.runPass());
      assert.deepStrictEqual([r.materialized, r.reverted, r.refused], [[id], [], {}], JSON.stringify(r));
      assert.deepStrictEqual([s.rec(id).state, s.rec(id).mode], ["LIVE", "LIVE_EVEJS"]);
      assert.strictEqual(s.calls("spawnShip").length, 4);
      assert.deepStrictEqual(s.calls("spawnShip").map((c) => c[3]), [35000, 35000, 15000, 15000]);
      const engage = s.calls("engage");
      assert.deepStrictEqual(engage, [["engage", SYS, [5001, 5002], [5003, 5004],
        { aggroPlayers: false, targetMode: "manual" }]]);
      const order = s.log.map((c) => c[0]).filter((x) => x === "publish" || x === "markLiveInTx");
      assert.deepStrictEqual(order, ["publish", "markLiveInTx"], "publish before tx B");
      const st = svc.getStatus();
      assert.strictEqual(st.budget.reservedShips, 4);
      assert.deepStrictEqual(st.live.map((x) => [x.battleId, x.ships]), [[id, 4]]);
      assert.deepStrictEqual([st.spawning, st.revertPending, st.strays], [0, [], 0]);
      assert.deepStrictEqual(s.env.q("SELECT state, entity_id FROM battle_live_members WHERE battle_id = ? ORDER BY "
        + "entity_id", id).map((m) => [m.state, Number(m.entity_id)]), [5001, 5002, 5003, 5004]
        .map((e) => ["SPAWNED", e]));

      const timersBefore = s.timers.length;
      s.presence.emitObserved(SYS);
      s.presence.emitObserved(SYS);
      assert.ok(s.timers.length > timersBefore && s.timers.slice(timersBefore).includes(0), "nudge = arm(0)");
      const again = notPromise(svc.runPass());
      assert.deepStrictEqual(again.materialized, []);
      assert.strictEqual(s.calls("spawnShip").length, 4, "one materialization only");

      s.npc.alive.delete(5003);
      svc.runPass();
      assert.deepStrictEqual(s.calls("orderAttack"), [["orderAttack", SYS, 5001, 5004]]);
      svc.runPass();
      assert.strictEqual(s.calls("orderAttack").length, 1, "the new target is alive: no second order");
      assert.strictEqual(s.count("retargeted"), 1);
      svc.stop("test");

      s.presence.observed.add(SYS2);
      const v = s.mk(SYS2);
      const vendor = s.start({ materialization: { targetMode: "vendor" }, views: createViewRegistry() });
      assert.deepStrictEqual(vendor.runPass().materialized, [v]);
      const ve = s.calls("engage")[1];
      assert.strictEqual(ve[4].targetMode, "vendor");
      s.npc.alive.delete(ve[3][0]);
      vendor.runPass();
      assert.strictEqual(s.calls("orderAttack").length, 1, "vendor mode: no orderAttack");
      vendor.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("MS2 RESOLVING at the claim -> BATTLE_ALREADY_RESOLVING in runPass.refused, no spawn, budget "
    + "0; a throw in the claim transaction -> budget 0", async () => {
    const s = setup(driver);
    try {
      const id = s.mk(SYS);
      s.wrap.beforeClaim = (tx, req) => {
        const b = s.env.battle.repository.getBattle(tx, req.battleId).battle;
        const c = s.env.battle.repository.claim(tx, { battleId: b.battleId, expectedVersion: b.version,
          mode: "VIRTUAL" }, `battle:${b.battleId}:claim:1:VIRTUAL`);
        s.env.battle.repository.transition(tx, { battleId: b.battleId, expectedVersion: c.version, from: "CLAIMED",
          to: "RESOLVING" }, `battle:${b.battleId}:resolving:1`);
      };
      const svc = s.start();
      const r = notPromise(svc.runPass());
      assert.strictEqual(r.refused.BATTLE_ALREADY_RESOLVING, 1, JSON.stringify(r));
      assert.strictEqual(s.rec(id).state, "RESOLVING");
      assert.strictEqual(s.calls("spawnShip").length, 0);
      assert.strictEqual(svc.getStatus().budget.reservedShips, 0);
      assert.strictEqual(s.count("refusedState"), 1);

      s.wrap.beforeClaim = null;
      s.wrap.claimThrows = 1;
      const other = s.mk(SYS);
      const t = svc.runPass();
      assert.strictEqual(t.refused.TX_FAILED, 1, JSON.stringify(t));
      assert.deepStrictEqual([s.rec(other).state, s.rec(other).mode], ["PENDING", null]);
      assert.strictEqual(svc.getStatus().budget.reservedShips, 0);
      assert.strictEqual(s.calls("spawnShip").length, 0);
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("MS3 rollback: spawn fails on the 3rd ship -> 2 despawned, CLAIMED VIRTUAL, one resolve:r1 "
    + "budget 0; publish 3 of 4 -> same rollback, publishFailed, no BATTLE_LIVE_STARTED; NO_PROFILE with detail -> "
    + "LIVE_UNSUPPORTED, no reservation, the log line carries the detail", async () => {
    const s = setup(driver, { observed: [SYS, SYS2, SYS3] });
    try {
      const a = s.mk(SYS);
      s.npc.spawnFail = (n) => (n === 3 ? { ok: false, reason: "SPAWN_FAILED", detail: "ANCHOR_NOT_FOUND" } : null);
      const svc = s.start();
      const r = svc.runPass();
      assert.deepStrictEqual([r.materialized, r.reverted, r.refused.SPAWN_FAILED], [[], [a], 1], JSON.stringify(r));
      assert.deepStrictEqual(s.calls("despawn"), [["despawn", SYS, [5001, 5002]]]);
      const ra = s.rec(a);
      assert.deepStrictEqual([ra.state, ra.mode, ra.claim_seq], ["CLAIMED", "VIRTUAL", 2]);
      assert.deepStrictEqual(s.env.q("SELECT idempotency_key FROM world_scheduled_events WHERE event_type = "
        + "'BATTLE_RESOLUTION' AND aggregate_id = ?", a).map((e) => e.idempotency_key), [`battle:${a}:resolve:r1`]);
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM battle_live_members WHERE battle_id = ?", a), 0);
      assert.strictEqual(svc.getStatus().budget.reservedShips, 0);
      assert.deepStrictEqual([s.count("spawnFailed"), s.count("reverted")], [1, 1]);

      s.npc.spawnFail = null;
      const b = s.mk(SYS2);
      s.npc.publishResult = (ids) => ({ ok: true, published: ids.length - 1, missing: 1 });
      const p = svc.runPass();
      assert.deepStrictEqual([p.reverted, p.refused.PUBLISH_PARTIAL], [[b], 1], JSON.stringify(p));
      assert.deepStrictEqual([s.rec(b).state, s.rec(b).mode], ["CLAIMED", "VIRTUAL"]);
      assert.strictEqual(s.calls("despawn").length, 2);
      assert.strictEqual(s.calls("despawn")[1][2].length, 4);
      assert.strictEqual(s.count("publishFailed"), 1);
      assert.strictEqual(s.journal(b, "BATTLE_LIVE_STARTED"), 0, "no LIVE before a full publication");
      assert.strictEqual(svc.getStatus().budget.reservedShips, 0);

      s.npc.publishResult = null;
      const c = s.mk(SYS3);
      const granted = svc.getStatus().budget.counters.granted;
      s.npc.profileResult = { ok: false, reason: "NO_PROFILE", factionId: C.SANSHA, hullGroup: "cruiser",
        detail: "hull pool empty" };
      svc.runPass();
      assert.deepStrictEqual([s.rec(c).state, s.rec(c).hold_reason], ["PENDING", "LIVE_UNSUPPORTED"]);
      assert.strictEqual(svc.getStatus().budget.counters.granted, granted, "no reservation");
      assert.strictEqual(s.count("unsupported"), 1);
      assert.ok(s.env.lines.includes(`materialization: unsupported ${c} NO_PROFILE hull pool empty`),
        s.env.lines.join("\n"));
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("MS4 crash and revertPending: (a) death after tx A -> a new boot: BATTLE_RECONCILE "
    + "BATTLE_LIVE_RECOVER -> CLAIMED VIRTUAL, nothing settled; (b) the revert throws once -> revertPending 1 (panel "
    + "alarm), the next pass reverts it, one revert key", async () => {
    const s = setup(driver);
    try {
      const id = s.mk(SYS);
      const first = s.start({ hooks: { afterClaim: () => false } });
      const r = notPromise(first.runPass());
      assert.strictEqual(r.aborted, true, JSON.stringify(r));
      assert.deepStrictEqual([s.rec(id).state, s.rec(id).mode], ["CLAIMED", "LIVE_EVEJS"]);
      assert.strictEqual(s.calls("spawnShip").length, 0);
      first.stop("crash");

      s.env.clock.set(s.env.clock.now() + 1000);
      s.env.restart();
      const bootAt = s.env.clock.now();
      const second = s.start({ views: createViewRegistry() });
      await s.env.drive(bootAt + s.env.cfg.battle.reconcileDelayMs + 3 * HOLD_MS);
      assert.strictEqual(s.env.event(`battle:reconcile:${bootAt}`).state, "DONE");
      assert.strictEqual(s.env.event(`battle:${id}:liverecover:${bootAt}`).state, "DONE");
      assert.deepStrictEqual([s.rec(id).state, s.rec(id).mode], ["CLAIMED", "VIRTUAL"]);
      assert.strictEqual(s.journal(id, "BATTLE_SETTLED"), 0, "no settlement of the half claim");
      assert.strictEqual(s.env.telemetry.counts["battle.liveRecover.reverted"], 1);
      second.stop("test");
    } finally {
      s.env.close();
    }

    const t = setup(driver);
    try {
      const id = t.mk(SYS);
      t.npc.spawnFail = () => ({ ok: false, reason: "SPAWN_FAILED", detail: "boom" });
      t.wrap.revertThrows = 1;
      const svc = t.start();
      svc.runPass();
      const st = svc.getStatus();
      assert.deepStrictEqual(st.revertPending.map((p) => [p.battleId, p.claimSeq, p.reason, p.attempts]),
        [[id, 1, "SPAWN_FAILED", 1]]);
      assert.deepStrictEqual([t.rec(id).state, t.rec(id).mode], ["CLAIMED", "LIVE_EVEJS"]);
      assert.strictEqual(st.budget.reservedShips, 0);
      const panel = t.views.getView("materialization").getData();
      assert.strictEqual(panel.alarm.raised, true);
      assert.deepStrictEqual(panel.alarm.revertPending.map((p) => p.battleId), [id]);

      const r2 = svc.runPass();
      assert.deepStrictEqual(r2.reverted, [id]);
      assert.deepStrictEqual([t.rec(id).state, t.rec(id).mode], ["CLAIMED", "VIRTUAL"]);
      assert.deepStrictEqual(svc.getStatus().revertPending, []);
      assert.strictEqual(t.env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
        `battle:${id}:revert:1`), 1);
      assert.strictEqual(t.views.getView("materialization").getData().alarm.raised, false);
      assert.deepStrictEqual([t.count("revertFailed"), t.count("reverted")], [1, 1]);
      svc.stop("test");
    } finally {
      t.env.close();
    }
  });

  needsDriver("MS5 exit (P2): unobserved -> nothing before exitGraceMs, then despawn 4 + COMPLETED DRAW "
    + "budget 0; DESPAWN_FAILED -> COMPLETED anyway, a stray retried, abandoned after despawnRetryPasses; governor "
    + "OVERLOADED -> no new battle (playerBattlesLiveWorkEnabled off, as before; on = GV1), the exit "
    + "of another one goes through", async () => {
    const s = setup(driver, { observed: [SYS, SYS2] });
    try {
      const grace = s.env.cfg.materialization.exitGraceMs;
      const x = s.mk(SYS);
      const svc = s.start({ materialization: { playerBattlesLiveWorkEnabled: false } });
      svc.runPass();
      assert.strictEqual(s.rec(x).state, "LIVE");
      s.presence.observed.delete(SYS);
      const t0 = s.env.clock.now();
      svc.runPass();
      assert.strictEqual(s.calls("despawn").length, 0, "before exitGraceMs nothing");
      assert.strictEqual(s.rec(x).state, "LIVE");
      s.env.clock.set(t0 + grace);
      const r = svc.runPass();
      assert.deepStrictEqual(r.exited, [x]);
      assert.deepStrictEqual(s.calls("despawn"), [["despawn", SYS, [5001, 5002, 5003, 5004]]]);
      const done = s.rec(x);
      assert.deepStrictEqual([done.state, done.mode, JSON.parse(done.result_json).outcome],
        ["COMPLETED", "LIVE_EVEJS", "DRAW"]);
      const st = svc.getStatus();
      assert.deepStrictEqual([st.budget.reservedShips, st.live, st.spawning], [0, [], 0]);

      const y = s.mk(SYS2);
      svc.runPass();
      assert.strictEqual(s.rec(y).state, "LIVE");
      s.npc.despawnFail.add(5006);
      s.presence.observed.delete(SYS2);
      const t1 = s.env.clock.now();
      svc.runPass();
      s.env.clock.set(t1 + grace);
      svc.runPass();
      assert.strictEqual(s.rec(y).state, "COMPLETED");
      assert.strictEqual(svc.getStatus().strays, 1);
      assert.strictEqual(s.count("despawnFailed"), 1);
      const retries = s.env.cfg.materialization.despawnRetryPasses;
      for (let i = 0; i < retries; i += 1) svc.runPass();
      assert.strictEqual(s.calls("despawn").filter((c) => c[2].length === 1 && c[2][0] === 5006).length, retries);
      assert.deepStrictEqual([s.count("despawnAbandoned"), svc.getStatus().strays], [1, 0]);
      s.npc.despawnFail.clear();

      s.presence.observed.add(SYS3);
      const z = s.mk(SYS3);
      svc.runPass();
      assert.strictEqual(s.rec(z).state, "LIVE");
      s.presence.observed.add(SYS);
      const w = s.mk(SYS);
      s.gov.overloaded = true;
      s.presence.observed.delete(SYS3);
      const t2 = s.env.clock.now();
      const g1 = svc.runPass();
      s.env.clock.set(t2 + grace);
      const g2 = svc.runPass();
      assert.deepStrictEqual(g2.exited, [z]);
      assert.strictEqual(s.rec(z).state, "COMPLETED");
      assert.deepStrictEqual([s.rec(w).state, s.rec(w).mode], ["PENDING", null]);
      assert.deepStrictEqual([g1.refused.GOVERNOR, g2.refused.GOVERNOR], [1, 1]);
      assert.ok(s.count("refusedGovernor") >= 2);
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("MS6 + ENTITY_TAKEN: (a) a permanent spawn error -> 1 claim + 1 revert in "
    + "retryAfterFailMs, skippedFailed >= 4, journal and events constant, a second try after retryAt; (b) "
    + "markLiveInTx of another battle with a taken entity -> ENTITY_TAKEN, nothing changed; (c) the vendor gives an "
    + "entity of a LIVE battle -> ENTITY_REUSED, rollback, that entity never despawned", async () => {
    const s = setup(driver);
    try {
      const pump = s.env.cfg.materialization.pumpMs;
      const retry = s.env.cfg.materialization.retryAfterFailMs;
      const id = s.mk(SYS);
      s.npc.spawnFail = () => ({ ok: false, reason: "SPAWN_FAILED", detail: "boom" });
      const svc = s.start();
      const t0 = s.env.clock.now();
      svc.runPass();
      const rows = () => [s.env.n("SELECT count(*) AS n FROM world_event_journal"),
        s.env.n("SELECT count(*) AS n FROM world_scheduled_events")];
      const after = rows();
      for (let i = 1; i <= 4; i += 1) {
        s.env.clock.set(t0 + i * pump);
        svc.runPass();
      }
      assert.deepStrictEqual(rows(), after, "nothing written inside the retry window");
      assert.deepStrictEqual([s.journal(id, "BATTLE_LIVE_CLAIMED"), s.journal(id, "BATTLE_LIVE_REVERTED")], [1, 1]);
      assert.ok(s.count("skippedFailed") >= 4, String(s.count("skippedFailed")));
      s.env.clock.set(t0 + retry + 1);
      svc.runPass();
      assert.deepStrictEqual([s.journal(id, "BATTLE_LIVE_CLAIMED"), s.journal(id, "BATTLE_LIVE_REVERTED")], [2, 2]);
      svc.stop("test");
    } finally {
      s.env.close();
    }

    const t = setup(driver, { observed: [SYS, SYS3] });
    try {
      t.npc.nextId = 1001;
      const x = t.mk(SYS);
      const svc = t.start();
      svc.runPass();
      assert.strictEqual(t.rec(x).state, "LIVE");
      const bootAt = svc.getStatus().bootAt;

      const y = t.mk(SYS2);
      const yb = t.T((db) => t.env.battle.repository.getBattle(db, y)).battle;
      const specs = planLiveMembers(yb.input, { maxShips: 256 }).members.map((m) => ({ ...m, profileId: "prof" }));
      const c = t.T((db) => t.env.battle.live.claimLiveInTx(db, { battleId: y, expectedVersion: yb.version }, specs));
      assert.strictEqual(c.ok, true, JSON.stringify(c));
      const snapshot = () => ({
        battles: t.env.q("SELECT * FROM battle_records ORDER BY battle_id").map((r) => ({ ...r })),
        members: t.env.q("SELECT * FROM battle_live_members ORDER BY battle_id, member_key").map((r) => ({ ...r })) });
      const before = snapshot();
      const spawned = specs.map((m, i) => ({ memberKey: m.memberKey, entityId: i === 0 ? 1001 : 7001 + i }));
      const taken = t.T((db) => t.env.battle.live.markLiveInTx(db, { battleId: y, expectedVersion: c.version,
        claimSeq: c.claimSeq, bootAt, spawned }));
      assert.strictEqual(taken.reason, "ENTITY_TAKEN", JSON.stringify(taken));
      assert.deepStrictEqual(snapshot(), before);

      const z = t.mk(SYS3);
      const spawnsBefore = t.npc.spawnCalls;
      t.npc.spawnOverride = (sys, nCall) => (nCall === spawnsBefore + 2 ? { ok: true, entityId: 1001 } : null);
      const r = svc.runPass();
      assert.deepStrictEqual([r.reverted, r.refused.ENTITY_REUSED], [[z], 1], JSON.stringify(r));
      assert.deepStrictEqual([t.rec(z).state, t.rec(z).mode], ["CLAIMED", "VIRTUAL"]);
      assert.ok(t.calls("despawn").every((call) => !call[2].includes(1001)), JSON.stringify(t.calls("despawn")));
      assert.deepStrictEqual(t.calls("despawn"), [["despawn", SYS3, [1005]]]);
      assert.strictEqual(t.rec(x).state, "LIVE");
      assert.ok(t.npc.alive.has(1001));
      assert.deepStrictEqual(svc.getStatus().live.map((l) => l.battleId), [x]);
      svc.stop("test");
    } finally {
      t.env.close();
    }
  });

  needsDriver("MS7 facade and stub: same methods, closed counter set, start refusals (off, seam), the panel "
    + "materialization (order 46) with the budget and the live battles", async () => {
    const s = setup(driver);
    try {
      const svc = s.start();
      assert.deepStrictEqual(Object.keys(svc).sort(), [...MATERIALIZATION_METHODS].sort());
      const stub = createUnavailableMaterialization("MATERIALIZATION_DISABLED", "disabled_by_config");
      assert.deepStrictEqual(Object.keys(stub).sort(), [...MATERIALIZATION_METHODS].sort());
      notPromise(stub.runPass());
      assert.strictEqual(stub.getStatus().state, "unavailable");
      assert.strictEqual(new Set(COUNTER_NAMES).size, COUNTER_NAMES.length);
      assert.strictEqual(COUNTER_NAMES.length, 50, "loss* (3), externallyEnded: - structureSettled "
        + "structureExited, structureReadFailed: + ownerUnknown; garrison-battles-live: + garrison* (2) "
        + "live-battle-ships-dormancy: + despawnPurged: + capitalSpawned, capitalNoProfile "
        + "npc-fleet-colors: + relation* (4); klmtw-angels-white: + relationUnchanged "
        + "grid: + gridAnchorUsed, gridAnchorFallback: + wave* (5) "
        + "profileFallback: + governorIdlePasses");

      const id = s.mk(SYS);
      svc.runPass();
      const view = s.views.getView("materialization");
      assert.strictEqual(view.order, 46);
      const data = view.getData();
      assert.deepStrictEqual([data.available, data.alarm.raised, data.budget.reservedShips, data.spawning],
        [true, false, 4, 0]);
      assert.deepStrictEqual(data.live.map((l) => [l.battleId, l.ships, l.alive]), [[id, 4, 4]]);
      assert.strictEqual(data.liveRecoverStaleOwned, 0);
      svc.stop("test");
      assert.strictEqual(s.views.getView("materialization"), null, "view removed at stop");
      assert.deepStrictEqual(svc.runPass().refused, { SERVICE_STOPPED: 1 });

      const base = { config: s.env.cfg, persistence: { ok: true, store: s.env.store }, clock: s.env.clock,
        getBattle: () => s.env.battle, logger: { log() {} } };
      const off = JSON.parse(JSON.stringify(s.env.cfg));
      off.modules.materialization.enabled = false;
      assert.strictEqual(startMaterialization({ ...base, config: off }).reason, "disabled_by_config");
      const seam = startMaterialization({ ...base, adapter: { checkNpcSpawn: () => ({ ok: false,
        reason: "SEAM_UNAVAILABLE", missing: ["space/npc/npcService"] }) } });
      assert.deepStrictEqual([seam.ok, seam.reason, seam.detail], [false, "SEAM_UNAVAILABLE", "space/npc/npcService"]);
      assert.strictEqual(startMaterialization({ ...base, getBattle: () => null }).reason, "dependency_disabled:battle");
    } finally {
      s.env.close();
    }
  });

  const exitOf = (rec) => JSON.parse(rec.result_json).diagnostics.exit;

  needsDriver("MS-END: side B down -> after exitGraceMs one exitLiveInTx(END) by the service, despawn "
    + "of every ship, budget 0, entry gone, the next pass does nothing; TIMEOUT -> battleEndTimeout", async () => {
    const s = setup(driver, { observed: [SYS, SYS2] });
    try {
      const grace = s.env.cfg.materialization.exitGraceMs;
      const id = s.mk(SYS);
      const svc = s.start();
      svc.runPass();
      assert.strictEqual(s.rec(id).state, "LIVE");
      s.npc.alive.delete(5003);
      s.npc.alive.delete(5004);
      const t0 = s.env.clock.now();
      assert.deepStrictEqual(svc.runPass().exited, [], "before exitGraceMs nothing");
      s.env.clock.set(t0 + grace);
      assert.deepStrictEqual(svc.runPass().exited, [id]);
      const done = s.rec(id);
      assert.deepStrictEqual([done.state, exitOf(done)], ["COMPLETED", "END"]);
      assert.deepStrictEqual(s.calls("exitLiveInTx"), [["exitLiveInTx", id, "END"]]);
      assert.deepStrictEqual(s.calls("despawn"), [["despawn", SYS, [5001, 5002, 5003, 5004]]]);
      const st = svc.getStatus();
      assert.deepStrictEqual([st.budget.reservedShips, st.live.length, st.counters.battleEndDetected,
        st.counters.exited], [0, 0, 1, 1]);
      svc.runPass();
      assert.deepStrictEqual([s.calls("exitLiveInTx").length, s.calls("despawn").length], [1, 1], "nothing more");

      const timeout = s.env.cfg.battle.liveEndMonitor.timeoutMs;
      const x = s.mk(SYS2);
      const t1 = s.env.clock.now();
      svc.runPass();
      assert.strictEqual(s.rec(x).state, "LIVE");
      s.env.clock.set(t1 + timeout);
      svc.runPass();
      s.env.clock.set(t1 + timeout + grace);
      assert.deepStrictEqual(svc.runPass().exited, [x]);
      assert.deepStrictEqual([exitOf(s.rec(x)), svc.getStatus().counters.battleEndTimeout,
        svc.getStatus().budget.reservedShips], ["END", 1, 0]);
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("MS-OWN: a battle settled outside the service -> next pass externallyEnded, despawn "
    + "budget 0, entry and tracked ships gone, no exitLiveInTx of the service", async () => {
    const s = setup(driver);
    try {
      const id = s.mk(SYS);
      const svc = s.start();
      svc.runPass();
      assert.strictEqual(svc.getStatus().lossTracker.tracked, 4);
      const ended = s.T((db) => s.env.battle.live.exitLiveInTx(db, { battleId: id, at: s.env.clock.now(),
        reason: "EXIT" }));
      assert.strictEqual(ended.ok, true, JSON.stringify(ended));
      svc.runPass();
      const st = svc.getStatus();
      assert.deepStrictEqual([st.counters.externallyEnded, st.counters.exited, st.budget.reservedShips, st.live.length,
        st.lossTracker.tracked], [1, 0, 0, 0, 0]);
      assert.deepStrictEqual(s.calls("despawn"), [["despawn", SYS, [5001, 5002, 5003, 5004]]]);
      assert.deepStrictEqual(s.calls("exitLiveInTx"), [], "the test settled it, the service never did");
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("MS-LOSS: a killmail of a LIVE ship -> member DESTROYED next pass (lossImported 1); the same "
    + "ship again, success:false, a foreign itemID -> nothing; the exit counts 1 destroyed ship, hull loss 1; stop "
    + "unbinds the sink", async () => {
    const s = setup(driver);
    try {
      let sink = null;
      const adapter = { bindLiveLossSink(fn) {
        if (sink) return { ok: false, reason: "SINK_BOUND" };
        sink = fn;
        return { ok: true, unbind: () => { if (sink === fn) sink = null; } };
      } };
      const fire = (itemID, success) => sink({ itemID }, { success });
      const id = s.mk(SYS);
      const svc = s.start({ adapter });
      svc.runPass();
      assert.strictEqual(svc.getStatus().lossImport, "on");
      const hunts = svc.getStatus().hunts;
      assert.deepStrictEqual(Object.keys(hunts.counters), [...HUNT_COUNTER_NAMES]);
      assert.deepStrictEqual([hunts.enabled, hunts.active, hunts.lossImport], [false, 0, "on"]);
      const state = (entityId) => s.env.q("SELECT state FROM battle_live_members WHERE battle_id = ? AND "
        + "entity_id = ?", id, entityId)[0].state;
      fire(5003, true);
      s.npc.alive.delete(5003);
      svc.runPass();
      assert.deepStrictEqual([state(5003), state(5004), s.count("lossImported")], ["DESTROYED", "SPAWNED", 1]);
      fire(5003, true);
      fire(5004, false);
      fire(999999, true);
      svc.runPass();
      assert.deepStrictEqual([state(5003), state(5004), s.count("lossImported"), s.count("lossFailed")],
        ["DESTROYED", "SPAWNED", 1, 0]);
      const liveLosses = [...svc.liveLossesByFleet()];

      s.presence.observed.delete(SYS);
      const t0 = s.env.clock.now();
      svc.runPass();
      s.env.clock.set(t0 + s.env.cfg.materialization.exitGraceMs);
      assert.deepStrictEqual(svc.runPass().exited, [id]);
      const lost = JSON.parse(s.rec(id).result_json).destroyedShips;
      assert.deepStrictEqual(lost.map((d) => d.count), [1]);
      assert.deepStrictEqual(liveLosses, [[lost[0].fleetId, 1]]);
      assert.strictEqual(svc.liveLossesByFleet().size, 0, "settled: the fleet row has the loss now");
      assert.strictEqual(s.env.fleet(lost[0].fleetId).composition.reduce((n, g) => n + g.count, 0), 1, "2 - 1");
      svc.stop("test");
      assert.strictEqual(sink, null, "stop() unbinds the sink");
    } finally {
      s.env.close();
    }
  });

  needsDriver("MS-HUNT through startMaterialization: the battle of the pass first, then the hunt (budget "
    + "fleet, behaviour search, lazy seam check); the killmail sink feeds the hunt tracker (lossImported 1)", () => {
    const s = setup(driver);
    try {
      s.env.cfg.playerHunt.enabled = true;
      s.env.cfg.playerHunt.noticeDelayMs = 0;
      const ph = require("../../lib/playerHunt").startPlayerHunt({ config: s.env.cfg,
        persistence: s.env.battleDeps.persistence, clock: s.env.clock, getFleets: () => s.env.fleets });
      assert.ok(ph.ok, JSON.stringify(ph));
      s.presence.getSystemPresence = (id) => ({ systemId: id, total: 1, space: 1, docked: 0, transit: 0,
        characters: [{ characterId: 103, state: "space" }] });
      const ship = (id) => ({ entityId: id, position: { x: 0, y: 0, z: 0 }, inWarp: false });
      let checks = 0;
      const scene = {
        listSystemObjects: () => ({ ok: true, objects: [{ kind: "stargate", itemId: 50000001,
          position: { x: 0, y: 0, z: 0 } }] }),
        readPlayerShips: () => ({ ok: true, ships: [{ characterId: 103, entityId: 9103, position: { x: 9e11, y: 0,
          z: 0 }, signatureRadius: 100, inWarp: false, cloaked: false, capsule: false }] }),
        readShips: (sys, ids) => ({ ok: true, ships: ids.filter((id) => s.npc.alive.has(id)).map(ship) }),
        warpShips: (sys, ids) => ({ ok: true, warped: ids.length, failed: [] }),
        setSearch: () => ({ ok: true, failed: [] }),
        attackTargets: () => ({ ok: true, failed: [] }),
        readAggressors: () => ({ ok: true, aggressors: [] }),
      };
      let sink = null;
      const adapter = {
        bindLiveLossSink(fn) {
          sink = fn;
          return { ok: true, unbind: () => { sink = null; } };
        },
        checkHuntScene: () => {
          checks += 1;
          return { ok: true };
        },
        getHuntScene: () => scene,
        readCharacterStanding: () => ({ ok: true, found: true, standing: -6 }),
      };
      const battleId = s.mk(SYS);
      const huntFleet = s.env.newFleet("ms-hunt", C.SANSHA, SYS, COMP2);
      const svc = s.start({ adapter, getPlayerHunt: () => ph.playerHunt, getFleets: () => s.env.fleets,
        getFactionKind: (f) => (f === C.SANSHA ? "pirate" : null) });
      const r = svc.runPass();
      assert.deepStrictEqual([r.materialized, r.huntsStarted.length], [[battleId], 1]);
      assert.deepStrictEqual(s.calls("spawnShip").length, 6, "4 battle ships first, then 2 hunt ships");
      assert.strictEqual(s.env.fleet(huntFleet).state, "MATERIALIZED");
      const st = svc.getStatus();
      assert.deepStrictEqual([st.hunts.active, st.budget.reservedByOwnerKind], [1, { battle: 4, fleet: 2 }]);
      assert.strictEqual(checks, 1);
      const huntShip = s.calls("spawnShip").length + 5000;
      sink({ itemID: huntShip }, { success: true });
      s.npc.alive.delete(huntShip);
      svc.runPass();
      assert.strictEqual(svc.getStatus().hunts.counters.lossImported, 1, "the second tracker of the same sink");
      assert.strictEqual(checks, 1, "the seam is checked once");
      svc.stop("test");
      ph.playerHunt.stop();
    } finally {
      s.env.close();
    }
  });

  needsDriver("SO3 stepStructures: two LIVE battles in one system, one with a structure; no destroyedAt -> no "
    + "exit (SLC-M2); destroyedAt -> only that one exits STRUCTURE_DESTROYED at once (SLC-M1), the next pass changes "
    + "nothing (SLC-M5); rows against the plan -> QUARANTINED, structureExited 0 (SLC-M6)", async () => {
    const s = setup(driver, { observed: [SYS, SYS2], config: { "battle.structureLiveCombat.enabled": true } });
    try {
      const rows = new Map();
      const seam = { reads: 0, getStructure(id) {
        seam.reads += 1;
        return { ok: true, row: rows.has(id) ? { structureId: id, ...rows.get(id) } : null };
      } };
      const struct = (id) => ({ structureId: id, structureTypeId: 35832, structureSide: "B" });
      const x = s.mk(SYS, struct(1030000000001));
      const y = s.mk(SYS);
      rows.set(1030000000001, { destroyedAt: null });
      const svc = s.start({ adapter: { getStructureSeam: () => seam } });
      svc.runPass();
      svc.runPass();
      assert.deepStrictEqual([s.rec(x).state, s.rec(y).state, svc.getStatus().budget.reservedShips], ["LIVE", "LIVE", 8]);
      const got = {};
      got.alive = [svc.runPass().exited, s.calls("exitLiveInTx").length, seam.reads > 0];
      rows.set(1030000000001, { destroyedAt: s.env.clock.now() });
      got.destroyed = [svc.runPass().exited, s.calls("exitLiveInTx"), s.calls("despawn"),
        svc.getStatus().budget.reservedShips, s.count("structureExited")];
      const result = JSON.parse(s.rec(x).result_json);
      got.result = [s.rec(x).state, result.structureDestroyed, result.objectiveAchieved, result.diagnostics.exit,
        s.rec(y).state];
      got.again = [svc.runPass().exited, s.calls("exitLiveInTx").length, s.count("structureExited")];

      const z = s.mk(SYS2, struct(1030000000002));
      rows.set(1030000000002, { destroyedAt: null });
      svc.runPass();
      assert.strictEqual(s.rec(z).state, "LIVE");
      const first = s.env.q("SELECT member_key FROM battle_live_members WHERE battle_id = ? ORDER BY member_key "
        + "LIMIT 1", z)[0].member_key;
      assert.ok(s.env.store.transaction("test.break", (db) => db.prepare("DELETE FROM battle_live_members WHERE "
        + "battle_id = ? AND member_key = ?").run(z, first)).ok);
      rows.set(1030000000002, { destroyedAt: s.env.clock.now() });
      got.quarantined = [svc.runPass().exited, s.rec(z).state, s.count("structureExited"),
        svc.getStatus().live.map((l) => l.battleId)];
      assert.deepStrictEqual(got, {
        alive: [[], 0, true],
        destroyed: [[x], [["exitLiveInTx", x, "STRUCTURE_DESTROYED"]], [["despawn", SYS, [5001, 5002, 5003, 5004]]],
          4, 1],
        result: ["COMPLETED", true, true, "STRUCTURE_DESTROYED", "LIVE"],
        again: [[], 1, 1],
        quarantined: [[z], "QUARANTINED", 1, [y]],
      });
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("SO3b stepStructures in the grace of EXIT: alive -> no exit in the grace "
    + "destroyedAt during the grace -> exit at once, reason EXIT kept, result structureDestroyed true, objective true, "
    + "structureExited 0", async () => {
    const s = setup(driver, { config: { "battle.structureLiveCombat.enabled": true } });
    try {
      const rows = new Map([[1030000000003, { destroyedAt: null }]]);
      const seam = { getStructure: (id) => ({ ok: true, row: rows.has(id) ? { structureId: id, ...rows.get(id) } : null }) };
      const x = s.mk(SYS, { structureId: 1030000000003, structureTypeId: 35832, structureSide: "B" });
      const svc = s.start({ adapter: { getStructureSeam: () => seam } });
      svc.runPass();
      svc.runPass();
      assert.strictEqual(s.rec(x).state, "LIVE");
      s.presence.observed.delete(SYS);
      const got = {};
      got.grace = [svc.runPass().exited, s.calls("exitLiveInTx").length];
      rows.set(1030000000003, { destroyedAt: s.env.clock.now() });
      got.destroyed = [svc.runPass().exited, s.calls("exitLiveInTx"), s.count("structureExited")];
      const result = JSON.parse(s.rec(x).result_json);
      got.result = [s.rec(x).state, result.structureDestroyed, result.objectiveAchieved, result.diagnostics.exit];
      assert.deepStrictEqual(got, {
        grace: [[], 0],
        destroyed: [[x], [["exitLiveInTx", x, "EXIT"]], 0],
        result: ["COMPLETED", true, true, "EXIT"],
      });
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("LM4: 500018 ships get the corporation of their fleet as ownerId, Sansha never "
    + "corporation null / no fleets service -> no ownerId + ownerUnknown, still LIVE; no owner factions ->", () => {
    const CAPS = 500018;
    const CORP = 98000001;
    const mkVs = (s, tag, system, capsCorp, sanshaCorp) => {
      const fleet = (key, factionId, corporationId) => {
        const r = s.env.fleets.createFleet({ factionId, corporationId, currentSystemId: system, homeSystemId: system,
          fleetRole: "patrol", composition: COMP2.map((e) => ({ ...e })) }, `test:lm4:${tag}:${key}`);
        assert.ok(r.ok, JSON.stringify(r));
        return r.fleetId;
      };
      const a = fleet("a", CAPS, capsCorp);
      const b = fleet("b", C.SANSHA, sanshaCorp);
      const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: s.env.fleet(id).version }] });
      const spec = { systemId: system, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
        maxResolutionMs: 20, garrison: null, sideA: side(CAPS, a), sideB: side(C.SANSHA, b) };
      const created = s.T((db) => s.env.battle.repository.createBattle(db, spec, `lm4:${tag}:battle`));
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      return created.battleId;
    };
    const capsP = `prof_${CAPS}_cruiser`;
    const sanP = `prof_${C.SANSHA}_cruiser`;
    const seen = [];
    const s = setup(driver, { observed: [SYS, SYS2, SYS3] });
    try {
      let fleetsSvc = s.env.fleets;
      const svc = s.start({ getFleets: () => fleetsSvc, ownerFactionIds: [CAPS] });
      const pass = (tag, id) => {
        s.npc.owners.length = 0;
        const r = svc.runPass();
        seen.push([tag, r.materialized.includes(id), s.rec(id).state, [...s.npc.owners], s.count("ownerUnknown")]);
      };
      pass("owned", mkVs(s, "o", SYS, CORP, 98000002));
      pass("corp null", mkVs(s, "n", SYS2, null, 98000002));
      fleetsSvc = null;
      pass("no fleets", mkVs(s, "f", SYS3, CORP, null));
      svc.stop("test");
    } finally {
      s.env.close();
    }
    const d = setup(driver);
    try {
      const svc = d.start();
      const id = mkVs(d, "d", SYS, CORP, null);
      const r = svc.runPass();
      seen.push(["default", r.materialized.includes(id), d.rec(id).state, [...d.npc.owners], d.count("ownerUnknown")]);
      svc.stop("test");
    } finally {
      d.env.close();
    }
    const none = [[capsP, undefined], [capsP, undefined], [sanP, undefined], [sanP, undefined]];
    assert.deepStrictEqual(seen, [
      ["owned", true, "LIVE", [[capsP, CORP], [capsP, CORP], [sanP, undefined], [sanP, undefined]], 0],
      ["corp null", true, "LIVE", none, 2],
      ["no fleets", true, "LIVE", none, 4],
      ["default", true, "LIVE", none, 0]]);
  });

  needsDriver("LM6 SWEEP (05c3): a throwing fleet read stays in ownersInTx (LIVE, ownerUnknown), a battle "
    + "without an owner faction reads no fleets, two 500018 battles in one pass get the owners of their own fleets", () => {
    const CAPS = 500018;
    const capsP = `prof_${CAPS}_cruiser`;
    const s = setup(driver, { observed: [SYS, SYS2, SYS3] });
    let n = 0;
    const capsVsSansha = (system, corporationId) => {
      n += 1;
      const fleet = (key, factionId, corp) => {
        const r = s.env.fleets.createFleet({ factionId, corporationId: corp, currentSystemId: system,
          homeSystemId: system, fleetRole: "patrol", composition: COMP2.map((e) => ({ ...e })) }, `test:lm6:${n}:${key}`);
        assert.ok(r.ok, JSON.stringify(r));
        return r.fleetId;
      };
      const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: s.env.fleet(id).version }] });
      const spec = { systemId: system, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
        maxResolutionMs: 20, garrison: null, sideA: side(CAPS, fleet("a", CAPS, corporationId)),
        sideB: side(C.SANSHA, fleet("b", C.SANSHA, null)) };
      const created = s.T((db) => s.env.battle.repository.createBattle(db, spec, `lm6:${n}:battle`));
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      return created.battleId;
    };
    const got = {};
    try {
      let mode = "throw";
      let reads = 0;
      const repository = { getFleets: (db, ids) => {
        reads += 1;
        if (mode === "throw") throw new Error("fleet read boom");
        return s.env.fleets.repository.getFleets(db, ids);
      } };
      const svc = s.start({ getFleets: () => ({ repository }), ownerFactionIds: [CAPS],
        materialization: { maxBattlesPerPass: 2 } });
      const pass = (ids) => {
        s.npc.owners.length = 0;
        reads = 0;
        const r = svc.runPass();
        return [ids.map((id) => [r.materialized.includes(id), s.rec(id).state]), reads,
          s.npc.owners.filter((o) => o[0] === capsP).map((o) => o[1]), s.count("ownerUnknown")];
      };
      got.threw = pass([capsVsSansha(SYS, 98000001)]);
      mode = "read";
      got.noOwner = pass([s.mk(SYS2)]);
      got.two = pass([capsVsSansha(SYS3, 98000011), capsVsSansha(SYS3, 98000012)]);
      got.two[2].sort((a, b) => a - b);
      svc.stop("test");
    } finally {
      s.env.close();
    }
    assert.deepStrictEqual(got, {
      threw: [[[true, "LIVE"]], 1, [undefined, undefined], 2],
      noOwner: [[[true, "LIVE"]], 0, [], 2],
      two: [[[true, "LIVE"], [true, "LIVE"]], 2, [98000011, 98000011, 98000012, 98000012], 2],
    });
  });

  needsDriver("IL3 service passes materialization.invaderProfilesEnabled to resolveProfiles as invaders "
    + "(default false, env 1 -> true); seam method list unchanged", () => {
    assert.deepStrictEqual([...SEAM_METHODS], ["resolveProfiles", "isSceneLoaded", "pickAnchor", "spawnShip",
      "engage", "publish", "despawn", "countAlive", "orderAttack", "listAlive", "setRelation", "pickGridAnchor",
      "seedCargo", "markConvoyShips", "forgetConvoyShips", "admitScene"]);
    const envFlag = config.resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_MATERIALIZATION_INVADER_PROFILES_ENABLED: "1" } }).config.materialization.invaderProfilesEnabled;
    assert.strictEqual(envFlag, true);
    const got = {};
    for (const [name, extra] of [["defaults", {}], ["env", { materialization: { invaderProfilesEnabled: envFlag } }]]) {
      const s = setup(driver);
      try {
        assert.strictEqual(s.env.cfg.materialization.invaderProfilesEnabled, false, "default false");
        const id = s.mk(SYS);
        const svc = s.start(extra);
        svc.runPass();
        got[name] = [s.rec(id).state, s.npc.profileOptions.map((o) => o.invaders)];
        assert.ok(s.env.lines.some((l) => l.includes(`invaderProfiles=${name === "env"}`)), "start line");
        svc.stop("test");
      } finally {
        s.env.close();
      }
    }
    assert.deepStrictEqual(got, { defaults: ["LIVE", [false]], env: ["LIVE", [true]] });
  });

  needsDriver("IP3 service passes materialization.industryProfilesEnabled to resolveProfiles as industry "
    + "a battle with an industrial member -> LIVE with the flag on, LIVE_UNSUPPORTED with it off", () => {
    const envFlag = config.resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_MATERIALIZATION_INDUSTRY_PROFILES_ENABLED: "1" } }).config.materialization
      .industryProfilesEnabled;
    assert.strictEqual(envFlag, true);
    const comp = [{ hullGroup: "cruiser", count: 1 }, { hullGroup: "industrial", count: 1 }];
    const got = {};
    for (const [name, extra] of [["off", {}], ["on", { materialization: { industryProfilesEnabled: envFlag } }]]) {
      const s = setup(driver);
      try {
        assert.strictEqual(s.env.cfg.materialization.industryProfilesEnabled, false, "default false");
        const base = s.npc.resolveProfiles;
        s.npc.resolveProfiles = (requests, options) => {
          const ind = requests.find((r) => r.hullGroup === "industrial");
          if (ind && options.industry !== true) {
            base(requests, options);
            return { ok: false, reason: "NO_PROFILE", factionId: ind.factionId, hullGroup: ind.hullGroup };
          }
          return base(requests, options);
        };
        const id = s.mk(SYS, undefined, comp);
        const svc = s.start(extra);
        const r = svc.runPass();
        got[name] = [s.rec(id).state, s.rec(id).hold_reason, r.materialized.length, s.count("unsupported"),
          s.npc.profileOptions.map((o) => o.industry)];
        assert.ok(s.env.lines.some((l) => l.includes(`industryProfiles=${name === "on"}`)), "start line");
        svc.stop("test");
      } finally {
        s.env.close();
      }
    }
    assert.deepStrictEqual(got, { off: ["PENDING", "LIVE_UNSUPPORTED", 0, 1, [false]],
      on: ["LIVE", null, 1, 0, [true]] });
  });

  needsDriver("MS-TEL DoD 11: happy-path counters (passes/attempted/materialized/shipsSpawned/exited), LIVE "
    + "gauges (liveBattles/liveShips/revertPending/strayShips/failedBattles) and passMs/spawnMs observations", () => {
    const s = setup(driver, { observed: [SYS] });
    try {
      const gauges = new Map();
      const obs = [];
      s.env.telemetry.gauge = (n, v) => { gauges.set(n, v); };
      s.env.telemetry.observe = (n, v) => { obs.push([n, v]); };
      const counters = () => ["passes", "attempted", "materialized", "shipsSpawned", "exited"].map((n) => s.count(n));
      const live = () => Object.fromEntries(["liveBattles", "liveShips", "revertPending", "strayShips",
        "failedBattles"].map((n) => [n, gauges.get(`materialization.${n}`)]));

      const id = s.mk(SYS);
      const svc = s.start();
      svc.runPass();
      assert.strictEqual(s.rec(id).state, "LIVE");
      assert.deepStrictEqual(counters(), [1, 1, 1, 4, 0]);
      assert.deepStrictEqual(live(), { liveBattles: 1, liveShips: 4, revertPending: 0, strayShips: 0,
        failedBattles: 0 });
      for (const name of ["materialization.passMs", "materialization.spawnMs"]) {
        const vals = obs.filter((o) => o[0] === name).map((o) => o[1]);
        assert.ok(vals.length >= 1, `${name} observed`);
        assert.ok(vals.every((v) => Number.isFinite(v) && v >= 0), `${name} finite and >= 0: ${vals}`);
      }

      s.presence.observed.delete(SYS);
      const t0 = s.env.clock.now();
      assert.deepStrictEqual(svc.runPass().exited, [], "grace: nothing yet");
      s.env.clock.set(t0 + s.env.cfg.materialization.exitGraceMs);
      assert.deepStrictEqual(svc.runPass().exited, [id]);
      assert.deepStrictEqual([s.count("exited"), s.count("passes"), s.count("materialized")], [1, 3, 1]);
      assert.deepStrictEqual([live().liveBattles, live().liveShips], [0, 0]);
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("DG5: despawn purged -> despawnPurged (despawnMissing "
    + "unchanged), gauge materialization.dormancyProtected and getStatus().dormancy from adapter.readDormancyGuardStats; "
    + "a throwing / missing reader -> no gauge, dormancy nulls", () => {
    const s = setup(driver, { observed: [SYS] });
    try {
      const gauges = new Map();
      s.env.telemetry.gauge = (n, v) => { gauges.set(n, v); };
      const guard = { protected: 4, blocked: 2 };
      const despawn = s.npc.despawn;
      s.npc.despawn = (sys, ids) => {
        const r = despawn(sys, ids);
        return { ...r, purged: r.missing };
      };
      const id = s.mk(SYS);
      const svc = s.start({ adapter: { readDormancyGuardStats: () => ({ installed: true, ...guard }) } });
      svc.runPass();
      assert.strictEqual(s.rec(id).state, "LIVE");
      assert.strictEqual(gauges.get("materialization.dormancyProtected"), 4);
      assert.deepStrictEqual(svc.getStatus().dormancy, { protected: 4, blocked: 2 });

      s.npc.alive.delete([...s.npc.alive.keys()][0]);
      guard.protected = 0;
      s.presence.observed.delete(SYS);
      const t0 = s.env.clock.now();
      assert.deepStrictEqual(svc.runPass().exited, [], "grace: nothing yet");
      s.env.clock.set(t0 + s.env.cfg.materialization.exitGraceMs);
      assert.deepStrictEqual(svc.runPass().exited, [id]);
      assert.deepStrictEqual([s.count("despawnMissing"), s.count("despawnPurged")], [1, 1]);
      assert.strictEqual(svc.getStatus().counters.despawnPurged, 1);
      assert.strictEqual(gauges.get("materialization.dormancyProtected"), 0);
      svc.stop("test");

      gauges.clear();
      const s2 = s.start({ adapter: { readDormancyGuardStats: () => { throw new Error("boom"); } } });
      s2.runPass();
      assert.strictEqual(gauges.has("materialization.dormancyProtected"), false);
      assert.deepStrictEqual(s2.getStatus().dormancy, { protected: null, blocked: null });
      s2.stop("test");
      const s3 = s.start();
      s3.runPass();
      assert.deepStrictEqual(s3.getStatus().dormancy, { protected: null, blocked: null });
      s3.stop("test");
    } finally {
      s.env.close();
    }
  });

  const GARRISON = Object.freeze({ side: "B", factionId: C.GURISTAS, strength: 80 });

  needsDriver("GLV7 garrison-battles-live: flag on -> 4 fleet ships + 4 proxies (side B "
    + "distance, Guristas profile), pickAnchor {prefer:station} only for the garrison battle, reserve 8, counters "
    + "garrisonMaterialized/garrisonShipsSpawned, one log line; proxies > room -> LIVE_TOO_LARGE (virtual)", async () => {
    const s = setup(driver, { observed: [SYS, SYS2], config: { "battle.garrisonLive.enabled": true } });
    try {
      const id = s.mk(SYS, { garrison: { ...GARRISON } });
      const svc = s.start();
      const r = svc.runPass();
      assert.deepStrictEqual([r.materialized, r.refused], [[id], {}], JSON.stringify(r));
      const members = s.env.q("SELECT fleet_id, side, faction_id, hull_group, state FROM battle_live_members WHERE "
        + "battle_id = ? AND fleet_id = 'garrison'", id).map((m) => ({ ...m }));
      const spawns = s.calls("spawnShip");
      assert.deepStrictEqual({ state: [s.rec(id).state, s.rec(id).mode], spawns: spawns.length,
        proxySpawns: spawns.slice(4).map((c) => [c[2], c[3]]), anchors: s.npc.anchorCalls,
        engageB: s.calls("engage")[0][3].length, reserved: svc.getStatus().budget.reservedShips,
        proxies: members.length, proxyRow: members[0],
        counts: [s.count("materialized"), s.count("shipsSpawned"), s.count("garrisonMaterialized"),
          s.count("garrisonShipsSpawned"), s.count("ownerUnknown")],
        line: s.env.lines.filter((l) => l.startsWith("materialization: garrison ")) },
      { state: ["LIVE", "LIVE_EVEJS"], spawns: 8,
        proxySpawns: Array(4).fill([`prof_${C.GURISTAS}_cruiser`, 15000]), anchors: [{ prefer: "station" }],
        engageB: 6, reserved: 8, proxies: 4,
        proxyRow: { fleet_id: "garrison", side: "B", faction_id: C.GURISTAS, hull_group: "cruiser", state: "SPAWNED" },
        counts: [1, 8, 1, 4, 0],
        line: [`materialization: garrison ${id} ships=4+4 anchor=stargate:50000001`] });
      svc.stop("test");

      const big = s.mk(SYS2, { garrison: { ...GARRISON } });
      const plain = s.mk(SYS2);
      const small = s.start({ materialization: { maxShipsPerBattle: 6 }, views: createViewRegistry() });
      const r2 = small.runPass();
      const r3 = small.runPass();
      assert.deepStrictEqual([r2.materialized, r3.materialized, s.rec(big).hold_reason, s.npc.anchorCalls.slice(1)],
        [[], [plain], "LIVE_UNSUPPORTED", [null]], JSON.stringify([r2, r3]));
      assert.ok(s.env.lines.some((l) => l === `materialization: unsupported ${big} LIVE_TOO_LARGE garrison 4 > room 2`),
        s.env.lines.join("\n"));
      small.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("GLV8 garrison-battles-live flag off (default): a garrison battle -> unsupported GARRISON_UNSUPPORTED, "
    + "LIVE_UNSUPPORTED, no spawn, no pickAnchor; vendor facts of the station anchor (npcAnchors kind station, "
    + "worldData stationID)", async () => {
    const s = setup(driver);
    try {
      const id = s.mk(SYS, { garrison: { ...GARRISON } });
      const svc = s.start();
      const r = svc.runPass();
      assert.deepStrictEqual([r.materialized, s.rec(id).hold_reason, s.calls("spawnShip").length, s.npc.anchorCalls,
        s.count("unsupported")], [[], "LIVE_UNSUPPORTED", 0, [], 1]);
      assert.ok(s.env.lines.some((l) => l.startsWith(`materialization: unsupported ${id} GARRISON_UNSUPPORTED`)));
      svc.stop("test");
    } finally {
      s.env.close();
    }
    const fs = require("node:fs");
    const src = path.resolve(MOD_DIR, "..", "..", "server", "src", "space");
    const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8").replace(/\r\n/g, "\n");
    if (!fs.existsSync(src)) return;
    assert.ok(read("npc/npcAnchors.js").includes('normalizedKind === "station"'), "npcAnchors: kind station");
    assert.ok(read("worldData.js").includes("stationID"), "worldData: stationID");
  });

  const BLOOD = 500012;
  const TITAN = 42241;
  const COMP_TITAN = Object.freeze([{ hullGroup: "cruiser", count: 1 }, { hullGroup: "titan", typeId: TITAN, count: 1 }]);
  const withCapitalSeam = (s, index) => {
    const ns = require("../../lib/adapter/npcSpawn");
    const real = ns.createNpcSpawn({ requireGame: () => ({ ok: false, reason: "file_not_found" }), navyProfiles: {},
      data: require("../../lib/adapter/data/liveProfiles"),
      capitalIndex: () => (index ? { ok: true, enabled: true, index, skipped: [] } : { ok: false, reason: "DISABLED" }) });
    const fake = s.npc.resolveProfiles;
    s.npc.resolveProfiles = (requests, options) => {
      const capitals = requests.filter((r) => ["carrier", "dreadnought", "force_auxiliary", "supercarrier", "titan"]
        .includes(r.hullGroup));
      const r = real.resolveProfiles(capitals, options);
      if (!r.ok) return r;
      const out = fake(requests, options);
      let k = 0;
      return { ok: true, profiles: requests.map((q, i) => (capitals.includes(q) ? r.profiles[k++] : out.profiles[i])) };
    };
  };
  const BLOOD_INDEX = Object.freeze({ [BLOOD]: { titan: { profileId: `lne_capital_${BLOOD}_titan`, typeId: TITAN } } });

  needsDriver("CM2: a titan without a LIVE profile (flag off; typeId other than the "
    + "index) -> LIVE_UNSUPPORTED (virtual), no spawn, capitalNoProfile per battle, one WARNING line per class and "
    + "faction", async () => {
    const s = setup(driver, { observed: [SYS, SYS2] });
    try {
      withCapitalSeam(s, null);
      const id1 = s.mk(SYS, null, COMP_TITAN, BLOOD);
      const svc = s.start();
      svc.runPass();
      const id2 = s.mk(SYS2, null, COMP_TITAN, BLOOD);
      svc.runPass();
      const warn = s.env.lines.filter((l) => l.startsWith("materialization: WARNING no LIVE capital profile"));
      assert.deepStrictEqual({ holds: [s.rec(id1).hold_reason, s.rec(id2).hold_reason],
        spawns: s.calls("spawnShip").length, noProfile: s.count("capitalNoProfile"), unsupported: s.count("unsupported"),
        warn: warn.length, reserved: svc.getStatus().budget.reservedShips },
      { holds: ["LIVE_UNSUPPORTED", "LIVE_UNSUPPORTED"], spawns: 0, noProfile: 2, unsupported: 2, warn: 1, reserved: 0 });
      assert.ok(warn[0].includes(`titan of faction ${BLOOD}`), warn[0]);
      assert.ok(s.env.lines.some((l) => l === `materialization: unsupported ${id1} NO_PROFILE CAPITAL`),
        s.env.lines.join("\n"));
      svc.stop("test");
    } finally {
      s.env.close();
    }
    const t = setup(driver);
    try {
      withCapitalSeam(t, { [BLOOD]: { titan: { profileId: `lne_capital_${BLOOD}_titan`, typeId: TITAN + 1 } } });
      const id = t.mk(SYS, null, COMP_TITAN, BLOOD);
      const svc = t.start({ materialization: { capitalLiveEnabled: true } });
      svc.runPass();
      assert.deepStrictEqual([t.rec(id).hold_reason, t.calls("spawnShip").length, t.count("capitalNoProfile")],
        ["LIVE_UNSUPPORTED", 0, 1]);
      svc.stop("test");
    } finally {
      t.env.close();
    }
  });

  needsDriver("CM3: a titan with the flag on -> LIVE with its LNE profile, spawn at "
    + "capitalAnchorDistanceMeters (+ sideSeparationMeters on side A), engage capitalIds, reservation ships + "
    + "(weight - 1) x capitals, capitalSpawned 1; the weighted count above the per-system limit -> LIVE_TOO_LARGE",
  async () => {
    const s = setup(driver);
    try {
      withCapitalSeam(s, BLOOD_INDEX);
      const id = s.mk(SYS, null, COMP_TITAN, BLOOD);
      const svc = s.start({ materialization: { capitalLiveEnabled: true } });
      const r = svc.runPass();
      const members = s.env.q("SELECT hull_group, type_id, profile_id FROM battle_live_members WHERE battle_id = ? "
        + "AND hull_group = 'titan'", id).map((m) => [m.hull_group, Number(m.type_id), m.profile_id]);
      const engage = s.calls("engage")[0];
      assert.deepStrictEqual({ materialized: r.materialized, members,
        spawns: s.calls("spawnShip").map((c) => [c[2], c[3]]), capitalIds: [...engage[4].capitalIds],
        reserved: svc.getStatus().budget.reservedShips, spawned: s.count("capitalSpawned"),
        noProfile: s.count("capitalNoProfile") },
      { materialized: [id], members: [["titan", TITAN, `lne_capital_${BLOOD}_titan`]],
        spawns: [[`prof_${BLOOD}_cruiser`, 35000], [`lne_capital_${BLOOD}_titan`, 60000],
          [`prof_${C.GURISTAS}_cruiser`, 15000], [`prof_${C.GURISTAS}_cruiser`, 15000]],
        capitalIds: [5002], reserved: 3 + 4, spawned: 1, noProfile: 0 });
      svc.stop("test");
    } finally {
      s.env.close();
    }
    const t = setup(driver, { config: { "limits.maxLiveMaterializationsPerSystem": 6 } });
    try {
      withCapitalSeam(t, BLOOD_INDEX);
      const id = t.mk(SYS, null, COMP_TITAN, BLOOD);
      const svc = t.start({ materialization: { capitalLiveEnabled: true, maxShipsPerBattle: 6 } });
      svc.runPass();
      assert.deepStrictEqual([t.rec(id).hold_reason, t.calls("spawnShip").length], ["LIVE_UNSUPPORTED", 0]);
      assert.ok(t.env.lines.some((l) => l === `materialization: unsupported ${id} LIVE_TOO_LARGE ships 7 > `
        + "limits.maxLiveMaterializationsPerSystem 6"), t.env.lines.join("\n"));
      svc.stop("test");
    } finally {
      t.env.close();
    }
    const cfg = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual([cfg.config.materialization.capitalBudgetWeight,
      cfg.config.materialization.capitalAnchorDistanceMeters], [4, 40000]);
    const warned = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_MATERIALIZATION_CAPITAL_LIVE_ENABLED: "1",
      EVEJS_LNE_MATERIALIZATION_CAPITAL_BUDGET_WEIGHT: "16", EVEJS_LNE_MAX_LIVE_MATERIALIZATIONS_PER_SYSTEM: "8" } });
    assert.ok(warned.warnings.some((w) => w.startsWith("materialization.capitalBudgetWeight=16 above limits.")),
      warned.warnings.join("\n"));
    const convoy = config.resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_FLEET_EXPOSURE_CONVOY_HULL_GROUPS: "freighter,titan" } });
    assert.strictEqual(convoy.config.fleetExposure.convoyHullGroups, "industrial,freighter,jump_freighter");
  });

  needsDriver("CMN4: a titan without a LIVE profile (flag off) whose weight "
    + "alone is above the per-system limit -> NO_PROFILE CAPITAL (capitalNoProfile, warning), not LIVE_TOO_LARGE",
  async () => {
    const t = setup(driver, { config: { "limits.maxLiveMaterializationsPerSystem": 6 } });
    try {
      withCapitalSeam(t, null);
      const id = t.mk(SYS, null, COMP_TITAN, BLOOD);
      const svc = t.start({ materialization: { maxShipsPerBattle: 6 } });
      svc.runPass();
      assert.deepStrictEqual([t.rec(id).hold_reason, t.calls("spawnShip").length, t.count("capitalNoProfile")],
        ["LIVE_UNSUPPORTED", 0, 1]);
      assert.ok(t.env.lines.some((l) => l === `materialization: unsupported ${id} NO_PROFILE CAPITAL`),
        t.env.lines.join("\n"));
      assert.ok(t.env.lines.some((l) => l.startsWith("materialization: WARNING no LIVE capital profile")));
      svc.stop("test");
    } finally {
      t.env.close();
    }
  });

  needsDriver("CM5: a killmail of a LIVE titan -> one destroyed entry {hullGroup titan "
    + "typeId} at the exit; a second killmail of the same entity is ignored (lossImported 1)", async () => {
    const s = setup(driver);
    try {
      let sink = null;
      const adapter = { bindLiveLossSink(fn) {
        sink = fn;
        return { ok: true, unbind: () => { sink = null; } };
      } };
      withCapitalSeam(s, BLOOD_INDEX);
      const id = s.mk(SYS, null, COMP_TITAN, BLOOD);
      const svc = s.start({ adapter, materialization: { capitalLiveEnabled: true } });
      svc.runPass();
      const titan = s.calls("spawnShip").findIndex((c) => c[2] === `lne_capital_${BLOOD}_titan`) + 5001;
      sink({ itemID: titan }, { success: true });
      s.npc.alive.delete(titan);
      svc.runPass();
      sink({ itemID: titan }, { success: true });
      svc.runPass();
      assert.strictEqual(s.count("lossImported"), 1);
      s.presence.observed.delete(SYS);
      const t0 = s.env.clock.now();
      svc.runPass();
      s.env.clock.set(t0 + s.env.cfg.materialization.exitGraceMs);
      assert.deepStrictEqual(svc.runPass().exited, [id]);
      const lost = JSON.parse(s.rec(id).result_json).destroyedShips;
      assert.deepStrictEqual(lost.map((d) => [d.hullGroup, d.typeId, d.count]), [["titan", TITAN, 1]]);
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  const GATE_GRID = Object.freeze({ kind: "gate", id: 50000002 });
  const PICKED = Object.freeze({ kind: "stargate", itemID: 50000001 });
  const GRID_OK = () => ({ ok: true, anchorDescriptor: { kind: "entity", itemID: 50000002 }, radiusMeters: 2500 });
  const gridLines = (s) => s.env.lines.filter((l) => l.startsWith("materialization: grid anchor fallback "));

  needsDriver("GA1 grid flag off: a battle with a grid -> no pickGridAnchor, one pickAnchor, the picked "
    + "anchor and the distances as before, both counters 0; config default false, env 1 -> true, warning", () => {
    const s = setup(driver);
    try {
      withGridAnchor(s.npc, GRID_OK);
      const id = s.mk(SYS, { grid: GATE_GRID });
      assert.deepStrictEqual([s.rec(id).grid_kind, Number(s.rec(id).grid_id)], ["gate", 50000002]);
      const svc = s.start();
      assert.strictEqual(s.env.cfg.materialization.gridAnchorEnabled, false, "default false");
      assert.deepStrictEqual(svc.runPass().materialized, [id]);
      assert.deepStrictEqual([s.npc.gridCalls, s.npc.anchorCalls, s.npc.anchorSpecs,
        s.calls("spawnShip").map((c) => c[3]), s.count("gridAnchorUsed"), s.count("gridAnchorFallback"),
        gridLines(s)], [[], [null], Array(4).fill(PICKED), [35000, 35000, 15000, 15000], 0, 0, []]);
      svc.stop("test");
    } finally {
      s.env.close();
    }
    const env = config.resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_MATERIALIZATION_GRID_ANCHOR_ENABLED: "1" } });
    assert.strictEqual(env.config.materialization.gridAnchorEnabled, true);
    const warning = "materialization.gridAnchorEnabled without battle.gridContacts.enabled - no battle has a grid, "
      + "pickAnchor as before";
    assert.ok(env.warnings.includes(warning), JSON.stringify(env.warnings));
    const both = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_MATERIALIZATION_GRID_ANCHOR_ENABLED: "1",
      EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED: "1" } });
    assert.ok(!both.warnings.includes(warning));
    assert.ok(!config.resolveConfig({ modDir: MOD_DIR, env: {} }).warnings.includes(warning));
  });

  needsDriver("GA2 grid flag on, gate grid: pickGridAnchor(SYS, grid) -> every spawn at {entity 50000002} "
    + "distance + radius 2500, no pickAnchor, gridAnchorUsed 1; a battle without a grid in the same pass -> "
    + "pickAnchor as before, counter unchanged", () => {
    const s = setup(driver);
    try {
      withGridAnchor(s.npc, GRID_OK);
      const gridded = s.mk(SYS, { grid: GATE_GRID });
      const plain = s.mk(SYS);
      const svc = s.start({ materialization: { gridAnchorEnabled: true, maxBattlesPerPass: 2 } });
      const r = svc.runPass();
      assert.deepStrictEqual([...r.materialized].sort(), [gridded, plain].sort(), JSON.stringify(r));
      const at = r.materialized.indexOf(gridded) * 4;
      const distances = s.calls("spawnShip").map((c) => c[3]);
      const other = r.materialized.indexOf(plain) * 4;
      assert.deepStrictEqual({
        gridCalls: s.npc.gridCalls,
        anchorCalls: s.npc.anchorCalls,
        gridSpecs: s.npc.anchorSpecs.slice(at, at + 4),
        gridDistances: distances.slice(at, at + 4),
        plainSpecs: s.npc.anchorSpecs.slice(other, other + 4),
        plainDistances: distances.slice(other, other + 4),
        counters: [s.count("gridAnchorUsed"), s.count("gridAnchorFallback")],
        lines: gridLines(s),
      }, {
        gridCalls: [[SYS, { ...GATE_GRID }]],
        anchorCalls: [null],
        gridSpecs: Array(4).fill({ kind: "entity", itemID: 50000002 }),
        gridDistances: [37500, 37500, 17500, 17500],
        plainSpecs: Array(4).fill(PICKED),
        plainDistances: [35000, 35000, 15000, 15000],
        counters: [1, 0],
        lines: [],
      });
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("GA3 grid fallback: GRID_ANCHOR_UNKNOWN -> pickAnchor, no radius, gridAnchorFallback 1, a log "
    + "line; no seam method -> SEAM_UNAVAILABLE; refused by the budget -> counters 0 (counted after materialized)",
  () => {
    const got = {};
    for (const [name, method] of [["unknown", true], ["noMethod", false]]) {
      const s = setup(driver);
      try {
        if (method) withGridAnchor(s.npc, () => ({ ok: false, reason: "GRID_ANCHOR_UNKNOWN" }));
        const id = s.mk(SYS, { grid: GATE_GRID });
        const svc = s.start({ materialization: { gridAnchorEnabled: true } });
        got[name] = [svc.runPass().materialized.length, s.npc.gridCalls.length, s.npc.anchorCalls, s.npc.anchorSpecs,
          s.calls("spawnShip").map((c) => c[3]), s.count("gridAnchorUsed"), s.count("gridAnchorFallback"),
          gridLines(s).map((l) => l.replace(id, "<id>"))];
        svc.stop("test");
      } finally {
        s.env.close();
      }
    }
    const fallback = (calls, reason) => [1, calls, [null], Array(4).fill(PICKED), [35000, 35000, 15000, 15000], 0, 1,
      [`materialization: grid anchor fallback <id> gate:50000002 ${reason}`]];
    assert.deepStrictEqual(got, { unknown: fallback(1, "GRID_ANCHOR_UNKNOWN"),
      noMethod: fallback(0, "SEAM_UNAVAILABLE") });

    const s = setup(driver, { config: { "limits.maxLiveMaterializationsPerSystem": 4 } });
    try {
      withGridAnchor(s.npc, GRID_OK);
      const plain = s.mk(SYS);
      const svc = s.start({ materialization: { gridAnchorEnabled: true } });
      assert.deepStrictEqual(svc.runPass().materialized, [plain]);
      s.mk(SYS, { grid: GATE_GRID });
      const r = svc.runPass();
      assert.deepStrictEqual([r.materialized, s.npc.gridCalls.length > 0, s.count("refusedBudget") > 0,
        s.count("gridAnchorUsed"), s.count("gridAnchorFallback")], [[], true, true, 0, 0], JSON.stringify(r));
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  const bigBattle = (s, tag) => {
    const { env } = s;
    const a1 = env.newFleet(`${tag}-a1`, C.SANSHA, SYS, [{ hullGroup: "frigate", count: 10 },
      { hullGroup: "cruiser", count: 9 }, { hullGroup: "logistics", count: 1 }]);
    const a2 = env.newFleet(`${tag}-a2`, C.SANSHA, SYS, [{ hullGroup: "frigate", count: 10 },
      { hullGroup: "cruiser", count: 10 }]);
    const a3 = env.newFleet(`${tag}-a3`, C.SANSHA, SYS, [{ hullGroup: "frigate", count: 10 },
      { hullGroup: "cruiser", count: 10 }]);
    const b1 = env.newFleet(`${tag}-b1`, C.GURISTAS, SYS, [{ hullGroup: "frigate", count: 20 },
      { hullGroup: "cruiser", count: 20 }]);
    const fl = (id) => ({ fleetId: id, expectedVersion: env.fleet(id).version });
    const spec = { systemId: SYS, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
      maxResolutionMs: 20, garrison: null, sideA: { factionId: C.SANSHA, fleets: [fl(a1), fl(a2), fl(a3)] },
      sideB: { factionId: C.GURISTAS, fleets: [fl(b1)] } };
    const created = s.T((db) => env.battle.repository.createBattle(db, spec, `${tag}:battle`));
    assert.strictEqual(created.ok, true, JSON.stringify(created));
    return created.battleId;
  };
  const stateCounts = (s, id) => Object.fromEntries(s.env.q("SELECT state, count(*) AS n FROM battle_live_members "
    + "WHERE battle_id = ? GROUP BY state ORDER BY state", id).map((r) => [r.state, Number(r.n)]));
  const livePayload = (s, id) => s.env.q("SELECT payload FROM world_event_journal WHERE aggregate_id = ? AND "
    + "event_type = 'BATTLE_LIVE_STARTED'", id).map((r) => Object.keys(JSON.parse(r.payload)).sort());

  needsDriver("AV4-T2: waves on, 60 vs 40 -> markLiveInTx 40 SPAWNED (24/16) "
    + "+ 60 RESERVE, budget 40 slots; 3 losses of side A -> the next pass spawns 3 RESERVE of side A (attackersOnly "
    + "engage, rows SPAWNED, budget still 40, waveShipsSpawned 3); the logistics member without a profile -> "
    + "profileFallback 1", async () => {
    const s = setup(driver);
    try {
      let sink = null;
      const adapter = { bindLiveLossSink(fn) {
        sink = fn;
        return { ok: true, unbind: () => { sink = null; } };
      } };
      const base = s.npc.resolveProfiles;
      s.npc.resolveProfiles = (requests, options) => {
        const missing = requests.find((r) => r.hullGroup === "logistics");
        if (missing) return { ok: false, reason: "NO_PROFILE", factionId: missing.factionId, hullGroup: "logistics" };
        return base(requests, options);
      };
      const id = bigBattle(s, "av4t2");
      const svc = s.start({ adapter, materialization: { wavesEnabled: true, profileFallbackEnabled: true } });
      assert.deepStrictEqual(svc.runPass().materialized, [id]);
      const first = s.calls("engage")[0];
      const live = svc.getStatus().live[0];
      assert.deepStrictEqual({ rows: stateCounts(s, id), sides: [first[2].length, first[3].length],
        reserved: svc.getStatus().budget.reservedShips, reserve: live.reserve, started: s.count("wavesStarted"),
        fallback: s.count("profileFallback"), logistics: s.env.q("SELECT profile_id FROM battle_live_members WHERE "
          + "battle_id = ? AND hull_group = 'logistics'", id).map((r) => r.profile_id) },
      { rows: { RESERVE: 60, SPAWNED: 40 }, sides: [24, 16], reserved: 40, reserve: 60, started: 1, fallback: 1,
        logistics: [`prof_${C.SANSHA}_cruiser`] });
      const lost = first[2].slice(0, 3);
      for (const entityId of lost) {
        sink({ itemID: entityId }, { success: true });
        s.npc.alive.delete(entityId);
      }
      const spawnsBefore = s.npc.spawnCalls;
      svc.runPass();
      const refill = s.calls("engage")[1];
      const newIds = refill[2];
      assert.deepStrictEqual({ spawned: s.npc.spawnCalls - spawnsBefore, refill: [newIds.length, refill[3].length,
        refill[4].attackersOnly], rows: stateCounts(s, id), reserved: svc.getStatus().budget.reservedShips,
      waveShips: s.count("waveShipsSpawned"), reserve: svc.getStatus().live[0].reserve,
      newRows: s.env.q("SELECT state FROM battle_live_members WHERE battle_id = ? AND entity_id IN (?, ?, ?) AND "
        + "side = 'A'", id, ...newIds).map((r) => r.state) },
      { spawned: 3, refill: [3, 16, true], rows: { DESTROYED: 3, RESERVE: 57, SPAWNED: 40 }, reserved: 40,
        waveShips: 3, reserve: 57, newRows: ["SPAWNED", "SPAWNED", "SPAWNED"] });
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("AV4-T5: waves off + 60 vs 40 -> LIVE_TOO_LARGE / LIVE_UNSUPPORTED as "
    + "before; waves on + a battle within the ceiling -> markLiveInTx without the reserve key (journal payload as with "
    + "the flag off)", async () => {
    const payloads = {};
    for (const wavesEnabled of [false, true]) {
      const s = setup(driver);
      try {
        const big = bigBattle(s, `av4t5${wavesEnabled}`);
        const small = s.mk(SYS);
        const svc = s.start({ materialization: { wavesEnabled } });
        svc.runPass();
        svc.runPass();
        if (!wavesEnabled) {
          assert.deepStrictEqual([s.rec(big).hold_reason, s.count("waveTooLarge"), s.count("wavesStarted")],
            ["LIVE_UNSUPPORTED", 0, 0]);
          assert.ok(s.env.lines.some((l) => l === `materialization: unsupported ${big} LIVE_TOO_LARGE ships 100 > 40`),
            s.env.lines.join("\n"));
        }
        assert.strictEqual(s.rec(small).state, "LIVE");
        payloads[wavesEnabled] = livePayload(s, small);
        svc.stop("test");
      } finally {
        s.env.close();
      }
    }
    assert.deepStrictEqual(payloads, { false: [["battleId", "bootAt", "claimSeq", "spawned", "spawnedHash"]],
      true: [["battleId", "bootAt", "claimSeq", "spawned", "spawnedHash"]] });
  });

  needsDriver("GV1 governor OVERLOADED (admits SETTLEMENT, LIVE): flag default -> the battle at the "
    + "player goes LIVE (materialized 1, no GOVERNOR refusal); flag off -> PENDING, mode null, GOVERNOR 1", async () => {
    const got = {};
    for (const [name, extra] of [["default", {}], ["off", { materialization: { playerBattlesLiveWorkEnabled: false } }]]) {
      const s = setup(driver);
      try {
        assert.strictEqual(s.env.cfg.materialization.playerBattlesLiveWorkEnabled, true, "default true");
        const w = s.mk(SYS);
        const svc = s.start(extra);
        s.gov.overloaded = true;
        const r = svc.runPass();
        got[name] = [s.rec(w).state, s.rec(w).mode, r.materialized.length, r.refused.GOVERNOR,
          s.count("materialized"), s.count("refusedGovernor")];
        svc.stop("test");
      } finally {
        s.env.close();
      }
    }
    assert.deepStrictEqual(got, { default: ["LIVE", "LIVE_EVEJS", 1, undefined, 1, 0],
      off: ["PENDING", null, 0, 1, 0, 1] });
  });

  needsDriver("GV5 stepWaves at OVERLOADED: flag default -> the wave refill of a LIVE "
    + "battle spawns (waveDeferred 0); flag off -> no spawn, waveDeferred 1 (as before)", async () => {
    const got = {};
    for (const [name, on] of [["default", true], ["off", false]]) {
      const s = setup(driver);
      try {
        let sink = null;
        const adapter = { bindLiveLossSink(fn) {
          sink = fn;
          return { ok: true, unbind: () => { sink = null; } };
        } };
        const id = bigBattle(s, `gv4${name}`);
        const svc = s.start({ adapter, materialization: { wavesEnabled: true, playerBattlesLiveWorkEnabled: on } });
        assert.deepStrictEqual(svc.runPass().materialized, [id]);
        for (const entityId of s.calls("engage")[0][2].slice(0, 3)) {
          sink({ itemID: entityId }, { success: true });
          s.npc.alive.delete(entityId);
        }
        s.gov.overloaded = true;
        const spawnsBefore = s.npc.spawnCalls;
        svc.runPass();
        got[name] = [s.npc.spawnCalls - spawnsBefore, s.count("waveShipsSpawned"), s.count("waveDeferred")];
        svc.stop("test");
      } finally {
        s.env.close();
      }
    }
    assert.deepStrictEqual(got, { default: [3, 3, 0], off: [0, 0, 1] });
  });

  needsDriver("GV2 governor SHED (admits nothing): the battle at the player stays PENDING (a hold, never "
    + "LIVE_UNSUPPORTED / VIRTUAL), refusedGovernor +1 per pass; no player in space -> governorIdlePasses +1, "
    + "refusedGovernor unchanged, GOVERNOR still refused", async () => {
    const s = setup(driver);
    try {
      const w = s.mk(SYS);
      const svc = s.start();
      s.gov.admits = () => false;
      const r1 = svc.runPass();
      const r2 = svc.runPass();
      assert.deepStrictEqual([s.rec(w).state, s.rec(w).mode, s.rec(w).hold_reason === "LIVE_UNSUPPORTED",
        r1.refused.GOVERNOR, r2.refused.GOVERNOR, s.count("refusedGovernor"), s.count("governorIdlePasses"),
        s.count("unsupported"), s.npc.spawnCalls], ["PENDING", null, false, 1, 1, 2, 0, 0, 0]);
      s.presence.observed.clear();
      const r3 = svc.runPass();
      assert.deepStrictEqual([r3.refused.GOVERNOR, s.count("refusedGovernor"), s.count("governorIdlePasses"),
        s.rec(w).state], [1, 2, 1, "PENDING"]);
      svc.stop("test");
    } finally {
      s.env.close();
    }
  });

  needsDriver("GV3 SoE porpoise: the real resolveProfiles (industry) -> NO_PROFILE, its fallback chain -> "
    + "ore_mining_retriever; a SoE porpoise battle with profileFallbackEnabled -> LIVE, profileFallback 1, no "
    + "unsupported; flag off -> LIVE_UNSUPPORTED NO_PROFILE; a SoE frigate (vendor navy table) stays NO_PROFILE "
    + "(SoE combat hulls =)", async () => {
    const ns = require("../../lib/adapter/npcSpawn");
    const { NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
    const { INDUSTRY_LIVE_PROFILES } = require("../../lib/adapter/data/industryLiveProfiles");
    const { fallbackChainOf } = require("../../lib/materialization/profileFallback");
    const SOE = 500016;
    const real = ns.createNpcSpawn({ requireGame: () => ({ ok: false, reason: "file_not_found" }),
      navyProfiles: NAVY_PROFILES_BY_FACTION_ID, industryProfiles: INDUSTRY_LIVE_PROFILES,
      data: require("../../lib/adapter/data/liveProfiles") });
    const one = (hullGroup) => real.resolveProfiles([{ memberKey: "m1", factionId: SOE, hullGroup }],
      { seedPrefix: "gv3", industry: true });
    assert.deepStrictEqual(one("porpoise"), { ok: false, reason: "NO_PROFILE", factionId: SOE, hullGroup: "porpoise" });
    assert.deepStrictEqual(fallbackChainOf("porpoise").map((g) => one(g)),
      [{ ok: true, profiles: ["ore_mining_retriever"] }]);
    assert.deepStrictEqual(one("frigate"), { ok: false, reason: "NO_PROFILE", factionId: SOE, hullGroup: "frigate" });
    assert.ok(fallbackChainOf("frigate").every((g) => one(g).reason === "NO_PROFILE"), "no SoE combat profile");
    const got = {};
    for (const profileFallbackEnabled of [true, false]) {
      const s = setup(driver);
      try {
        const fake = s.npc.resolveProfiles;
        s.npc.resolveProfiles = (requests, options) => {
          const soe = requests.filter((q) => q.factionId === SOE);
          const r = real.resolveProfiles(soe, options);
          if (!r.ok) return r;
          const out = fake(requests, options);
          let k = 0;
          return { ok: true, profiles: requests.map((q, i) => (soe.includes(q) ? r.profiles[k++] : out.profiles[i])) };
        };
        const id = s.mk(SYS, undefined, [{ hullGroup: "porpoise", count: 1 }], SOE);
        const svc = s.start({ materialization: { industryProfilesEnabled: true, profileFallbackEnabled } });
        svc.runPass();
        got[profileFallbackEnabled] = [s.rec(id).state, s.rec(id).hold_reason, s.count("profileFallback"),
          s.count("unsupported"), s.env.q("SELECT profile_id FROM battle_live_members WHERE battle_id = ? AND "
            + "hull_group = 'porpoise'", id).map((x) => x.profile_id)];
        if (!profileFallbackEnabled) {
          assert.ok(s.env.lines.some((l) => l === `materialization: unsupported ${id} NO_PROFILE faction ${SOE} porpoise`),
            s.env.lines.join("\n"));
        }
        svc.stop("test");
      } finally {
        s.env.close();
      }
    }
    assert.deepStrictEqual(got, { true: ["LIVE", null, 1, 0, ["ore_mining_retriever"]],
      false: ["PENDING", "LIVE_UNSUPPORTED", 0, 1, []] });
  });

  test("GV4 config materialization.playerBattlesLiveWorkEnabled: default true, env 0 -> false", () => {
    const of = (env) => config.resolveConfig({ modDir: MOD_DIR, env }).config.materialization
      .playerBattlesLiveWorkEnabled;
    assert.deepStrictEqual([of({}), of({ EVEJS_LNE_MATERIALIZATION_PLAYER_BATTLES_LIVE_WORK_ENABLED: "0" })],
      [true, false]);
  });
};

module.exports.harness = { setup, loadDriver: () => H.loadDriver(), SYS };
