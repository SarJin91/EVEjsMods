"use strict";

const assert = require("node:assert");

const { planLiveMembers } = require("../../lib/battle/liveMembers");
const { harness: H } = require("./settlement.test");
const { harness: C } = require("./contacts.test");

const COMP2 = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const ENGAGE_MS = 60000;
const HOLD_MS = 60000;
const NEIGHBOR_MS = 600000;
const OPEN = "('QUEUED', 'RETRY', 'CLAIMED')";

function fakePresence(dist) {
  return { dist, radii: [], st: { available: true, stale: false, reason: null },
    getStatus() { return this.st; },
    isObserved(id) { return this.dist[id] === 0; },
    distanceToObserved(id, radius) {
      this.radii.push(radius);
      const d = this.dist[id];
      return { ok: true, distance: d === undefined ? null : d };
    } };
}

function setup(driver, opts = {}) {
  const seam = C.seamResolver(() => "DRAW");
  const env = C.createEnv(driver, { resolver: seam, presence: opts.presence, config: opts.config });
  const T = (fn) => {
    const r = env.store.transaction("test.hb", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const battle = (id) => T((db) => env.battle.repository.getBattle(db, id)).battle;
  const rec = (id) => env.q("SELECT * FROM battle_records WHERE battle_id = ?", id)[0];
  const bySystem = (sys) => env.battles().filter((b) => b.system_id === sys);
  let n = 0;
  const mk = (system) => {
    n += 1;
    const a = env.newFleet(`hb-a${n}`, C.SANSHA, system, COMP2);
    const b = env.newFleet(`hb-b${n}`, C.GURISTAS, system, COMP2);
    const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: env.fleet(id).version }] });
    const spec = { systemId: system, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
      maxResolutionMs: 20, garrison: null, sideA: side(C.SANSHA, a), sideB: side(C.GURISTAS, b) };
    const created = T((db) => env.battle.repository.createBattle(db, spec, `hb:${n}:battle`));
    assert.strictEqual(created.ok, true, JSON.stringify(created));
    return { battleId: created.battleId, a, b };
  };
  const claimLive = (battleId) => {
    const p = battle(battleId);
    const specs = planLiveMembers(p.input, { maxShips: 256 }).members.map((m) => ({ ...m, profileId: "prof_test" }));
    const c = T((db) => env.battle.live.claimLiveInTx(db, { battleId, expectedVersion: p.version }, specs));
    assert.strictEqual(c.ok, true, JSON.stringify(c));
    return c;
  };
  const toLive = (system) => {
    const m = mk(system);
    const c = claimLive(m.battleId);
    const spawned = env.q("SELECT member_key FROM battle_live_members WHERE battle_id = ? ORDER BY member_key",
      m.battleId).map((r, i) => ({ memberKey: r.member_key, entityId: 9000 + 100 * n + i }));
    const l = T((db) => env.battle.live.markLiveInTx(db, { battleId: m.battleId, expectedVersion: c.version,
      claimSeq: c.claimSeq, bootAt: env.clock.now(), spawned }));
    assert.strictEqual(l.ok, true, JSON.stringify(l));
    return m;
  };
  const events = (battleId, type, where = "") => env.q(`SELECT * FROM world_scheduled_events WHERE event_type = ? `
    + `AND aggregate_id = ?${where} ORDER BY idempotency_key`, type, battleId);
  return { env, seam, T, battle, rec, bySystem, mk, claimLive, toLive, events,
    count: (name) => env.telemetry.counts[`battle.${name}`] || 0 };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const S = H.S;

  needsDriver("HB1 hold radius: materialization ON - distance 1 fresh -> hold, after neighborHoldMaxMs -> "
    + "resolved, distance null -> resolved; OFF - distance 1 -> resolved, observed -> hold (radius 0)", async () => {
    const presence = fakePresence({ [S.N6]: 1 });
    const s = setup(driver, { presence, config: { "modules.materialization.enabled": true } });
    try {
      assert.strictEqual(s.env.battle.getStatus().presencePolicy, "ready radius:1");
      s.env.newFleet("a", C.SANSHA, S.N6);
      s.env.newFleet("b", C.GURISTAS, S.N6);
      s.env.newFleet("c", C.SANSHA, S.N7);
      s.env.newFleet("d", C.GURISTAS, S.N7);
      const at = s.env.clock.now();
      s.env.check(S.N6, "n6");
      s.env.check(S.N7, "n7");
      await s.env.drive(at + ENGAGE_MS);
      const [held] = s.bySystem(S.N6);
      assert.deepStrictEqual([held.state, held.hold_reason], ["PENDING", "AWAITING_LIVE"]);
      assert.ok(presence.radii.length > 0 && presence.radii.every((r) => r === 1), JSON.stringify(presence.radii));
      assert.strictEqual(s.bySystem(S.N7)[0].state, "COMPLETED", "distance null -> resolved");
      assert.strictEqual(s.seam.calls, 1);
      assert.ok(s.count("resolution.heldNeighbor") >= 1);
      await s.env.drive(Number(held.created_at) + NEIGHBOR_MS - HOLD_MS);
      assert.strictEqual(s.rec(held.battle_id).state, "PENDING", "still held before neighborHoldMaxMs");
      await s.env.drive(Number(held.created_at) + NEIGHBOR_MS + 2 * HOLD_MS);
      assert.deepStrictEqual([s.rec(held.battle_id).state, s.rec(held.battle_id).mode], ["COMPLETED", "VIRTUAL"]);
      assert.strictEqual(s.seam.calls, 2);
    } finally {
      s.env.close();
    }

    const off = fakePresence({ [S.N6]: 1, [S.N7]: 0 });
    const o = setup(driver, { presence: off });
    try {
      assert.strictEqual(o.env.battle.getStatus().presencePolicy, "ready radius:0");
      for (const [tag, sys] of [["e", S.N6], ["f", S.N7]]) {
        o.env.newFleet(`${tag}1`, C.SANSHA, sys);
        o.env.newFleet(`${tag}2`, C.GURISTAS, sys);
        o.env.check(sys, tag);
      }
      await o.env.drive(o.env.clock.now() + ENGAGE_MS);
      assert.strictEqual(o.bySystem(S.N6)[0].state, "COMPLETED", "OFF: neighbour resolves as before");
      assert.deepStrictEqual([o.bySystem(S.N7)[0].state, o.bySystem(S.N7)[0].hold_reason], ["PENDING",
        "AWAITING_LIVE"], "OFF: observed system holds");
      assert.deepStrictEqual(off.radii, [], "OFF: distanceToObserved never asked");
      assert.strictEqual(o.count("resolution.heldNeighbor"), 0);
    } finally {
      o.env.close();
    }
  });

  needsDriver("HB2 LIVE_UNSUPPORTED resolves virtually in an observed system and at distance 1 (before the "
    + "hold branch): resolver called, COMPLETED VIRTUAL, never re-marked AWAITING_LIVE", async () => {
    const presence = fakePresence({ [S.N6]: 0, [S.N7]: 1 });
    const s = setup(driver, { presence, config: { "modules.materialization.enabled": true } });
    try {
      s.env.newFleet("a", C.SANSHA, S.N6);
      s.env.newFleet("b", C.GURISTAS, S.N6);
      s.env.newFleet("c", C.SANSHA, S.N7);
      s.env.newFleet("d", C.GURISTAS, S.N7);
      const at = s.env.clock.now();
      s.env.check(S.N6, "n6");
      s.env.check(S.N7, "n7");
      await s.env.drive(at);
      const near = s.bySystem(S.N7)[0].battle_id;
      const nb = s.battle(near);
      const un = s.T((db) => s.env.battle.live.markUnsupportedInTx(db, { battleId: near, expectedVersion: nb.version,
        reason: "NO_PROFILE" }));
      assert.strictEqual(un.ok, true, JSON.stringify(un));
      await s.env.drive(at + ENGAGE_MS);
      const obs = s.bySystem(S.N6)[0];
      assert.deepStrictEqual([obs.state, obs.hold_reason], ["PENDING", "AWAITING_LIVE"]);
      assert.deepStrictEqual([s.rec(near).state, s.rec(near).mode], ["COMPLETED", "VIRTUAL"], "distance 1");
      assert.strictEqual(s.seam.calls, 1);

      const ob = s.battle(obs.battle_id);
      const u2 = s.T((db) => s.env.battle.live.markUnsupportedInTx(db, { battleId: obs.battle_id,
        expectedVersion: ob.version, reason: "NO_PROFILE" }));
      assert.strictEqual(u2.ok, true, JSON.stringify(u2));
      const bucket = Math.floor((at + ENGAGE_MS) / HOLD_MS) + 1;
      await s.env.drive(bucket * HOLD_MS);
      assert.deepStrictEqual([s.rec(obs.battle_id).state, s.rec(obs.battle_id).mode], ["COMPLETED", "VIRTUAL"]);
      assert.strictEqual(s.seam.calls, 2);
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
        `battle:${obs.battle_id}:await:${u2.version}`), 0, "no AWAITING_LIVE over LIVE_UNSUPPORTED");
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key LIKE ?",
        `battle:${near}:await:%`), 0, "the neighbour was never marked");
      assert.strictEqual(s.count("resolution.unsupportedVirtual"), 2);
    } finally {
      s.env.close();
    }
  });

  needsDriver("HB3 recovery after a restart (materialization OFF): CLAIMED LIVE_EVEJS -> CLAIMED VIRTUAL + one "
    + "resolution chain; LIVE -> COMPLETED LIVE_EVEJS DRAW, no losses, fleets released; LIVE of this boot untouched",
  async () => {
    const presence = fakePresence({ [S.N7]: 0 });
    const s = setup(driver, { presence });
    try {
      const x = s.mk(S.N7);
      s.claimLive(x.battleId);
      const y = s.toLive(S.N5);
      s.env.clock.set(s.env.clock.now() + 1000);
      s.env.restart();
      const bootAt = s.env.clock.now();
      const z = s.toLive(S.N5);
      assert.ok(s.battle(z.battleId).updatedAt >= bootAt);
      await s.env.drive(bootAt + s.env.cfg.battle.reconcileDelayMs + 3 * HOLD_MS);

      const bx = s.battle(x.battleId);
      assert.deepStrictEqual([bx.state, bx.mode, bx.claimSeq], ["CLAIMED", "VIRTUAL", 2]);
      assert.strictEqual(s.events(x.battleId, "BATTLE_RESOLUTION", ` AND state IN ${OPEN}`).length, 1,
        JSON.stringify(s.events(x.battleId, "BATTLE_RESOLUTION")));
      assert.strictEqual(s.env.event(`battle:${x.battleId}:resolve:r1`).state, "DONE");

      const by = s.rec(y.battleId);
      assert.deepStrictEqual([by.state, by.mode, JSON.parse(by.result_json).outcome], ["COMPLETED", "LIVE_EVEJS",
        "DRAW"]);
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM battle_losses WHERE battle_id = ?", y.battleId), 0);
      for (const id of [y.a, y.b]) assert.notStrictEqual(s.env.fleet(id).state, "ENGAGED", id);
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM battle_live_members WHERE battle_id = ?", y.battleId), 0);

      assert.strictEqual(s.rec(z.battleId).state, "LIVE", "this boot: not recovered");
      assert.strictEqual(s.events(z.battleId, "BATTLE_LIVE_RECOVER").length, 0);
      assert.deepStrictEqual([s.count("liveRecover.reverted"), s.count("liveRecover.exited")], [1, 1]);
      assert.strictEqual(s.seam.calls, 0, "y is never resolved virtually");

      presence.dist = {};
      await s.env.drive(s.env.clock.now() + 2 * HOLD_MS);
      assert.deepStrictEqual([s.rec(x.battleId).state, s.rec(x.battleId).mode], ["COMPLETED", "VIRTUAL"]);
      assert.strictEqual(s.seam.calls, 1);
    } finally {
      s.env.close();
    }
  });

  needsDriver("HB4 idempotency: a second BATTLE_RECONCILE of the boot -> liverecover duplicate; the handler "
    + "on a settled battle -> STALE; one BATTLE_SETTLED; resolve:r<n> open -> no second chain; broken "
    + "members -> QUARANTINED", async () => {
    const s = setup(driver);
    try {
      const y = s.toLive(S.N5);
      const v = s.toLive(S.N6);
      const w = s.mk(S.N7);
      const wc = s.claimLive(w.battleId);
      const far = s.env.clock.now() + 10 * 3600000;
      const rv = s.T((db) => s.env.battle.live.revertLiveClaimInTx(db, { battleId: w.battleId,
        expectedVersion: wc.version, claimSeq: wc.claimSeq, at: far, reason: "SPAWN_FAILED" }));
      assert.strictEqual(rv.ok, true, JSON.stringify(rv));
      const firstKey = s.env.q("SELECT member_key FROM battle_live_members WHERE battle_id = ? ORDER BY member_key "
        + "LIMIT 1", v.battleId)[0].member_key;
      assert.ok(s.env.store.transaction("test.break", (db) => db.prepare("DELETE FROM battle_live_members WHERE "
        + "battle_id = ? AND member_key = ?").run(v.battleId, firstKey)).ok);

      s.env.clock.set(s.env.clock.now() + 1000);
      s.env.restart();
      const bootAt = s.env.clock.now();
      const recAt = bootAt + s.env.cfg.battle.reconcileDelayMs;
      await s.env.drive(recAt);
      assert.strictEqual(s.env.event(`battle:reconcile:${bootAt}`).state, "DONE");
      const key = `battle:${y.battleId}:liverecover:${bootAt}`;
      assert.strictEqual(s.env.event(key).state, "QUEUED");
      const dup = s.env.scheduler.enqueue("BATTLE_RECONCILE", "reconcile", recAt, { afterId: null, page: 0, bootAt },
        "test:reconcile:2");
      assert.strictEqual(dup.ok, true, JSON.stringify(dup));
      const dups = s.env.telemetry.counts["scheduler.duplicates"] || 0;
      await s.env.drive(recAt);
      assert.strictEqual(s.env.event("test:reconcile:2").state, "DONE");
      assert.ok((s.env.telemetry.counts["scheduler.duplicates"] || 0) > dups, "liverecover key is a duplicate");
      assert.strictEqual(s.events(y.battleId, "BATTLE_LIVE_RECOVER").length, 1);
      assert.deepStrictEqual(s.events(w.battleId, "BATTLE_RESOLUTION").map((e) => e.idempotency_key),
        [`battle:${w.battleId}:resolve:r1`], "No hold chain next to resolve:r1");

      await s.env.drive(recAt + 3 * HOLD_MS);
      assert.strictEqual(s.rec(y.battleId).state, "COMPLETED");
      const again = s.env.scheduler.enqueue("BATTLE_LIVE_RECOVER", y.battleId, s.env.clock.now(),
        { battleId: y.battleId, bootAt }, "test:liverecover:2");
      assert.strictEqual(again.ok, true, JSON.stringify(again));
      await s.env.drive(s.env.clock.now());
      assert.deepStrictEqual([s.env.event("test:liverecover:2").state, s.env.event("test:liverecover:2").outcome],
        ["DONE", "STALE"]);
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'BATTLE_SETTLED' "
        + "AND aggregate_id = ?", y.battleId), 1);

      const bv = s.rec(v.battleId);
      assert.deepStrictEqual([bv.state, JSON.parse(bv.error_json).reason], ["QUARANTINED", "LIVE_MEMBERS_INVALID"]);
      assert.strictEqual(s.count("liveRecover.refused"), 1);
      assert.strictEqual(s.count("liveRecover.exited"), 1);
    } finally {
      s.env.close();
    }
  });

  needsDriver("HB5: a BATTLE_LIVE_RECOVER of a previous boot on a LIVE and a CLAIMED "
    + "LIVE_EVEJS battle of this boot -> STALE, both untouched; payload without bootAt -> QUARANTINED", async () => {
    const s = setup(driver);
    try {
      const oldBoot = s.env.clock.now();
      s.env.clock.set(oldBoot + 1000);
      s.env.restart();
      const z = s.toLive(S.N5);
      const w = s.mk(S.N7);
      s.claimLive(w.battleId);
      const at = s.env.clock.now();
      const keys = [];
      for (const id of [z.battleId, w.battleId]) {
        const key = `battle:${id}:liverecover:${oldBoot}`;
        const e = s.env.scheduler.enqueue("BATTLE_LIVE_RECOVER", id, at, { battleId: id, bootAt: oldBoot }, key);
        assert.strictEqual(e.ok, true, JSON.stringify(e));
        keys.push(key);
      }
      const bad = s.env.scheduler.enqueue("BATTLE_LIVE_RECOVER", z.battleId, at, { battleId: z.battleId },
        "test:liverecover:noboot");
      assert.strictEqual(bad.ok, true, JSON.stringify(bad));
      await s.env.drive(at);

      for (const key of keys) {
        assert.deepStrictEqual([s.env.event(key).state, s.env.event(key).outcome], ["DONE", "STALE"], key);
      }
      assert.deepStrictEqual([s.rec(z.battleId).state, s.rec(z.battleId).mode], ["LIVE", "LIVE_EVEJS"]);
      assert.deepStrictEqual([s.rec(w.battleId).state, s.rec(w.battleId).mode], ["CLAIMED", "LIVE_EVEJS"]);
      const nb = s.env.event("test:liverecover:noboot");
      assert.strictEqual(nb.state, "QUARANTINED");
      assert.ok(String(nb.last_error).includes("LIVE_RECOVER_PAYLOAD_INVALID"), nb.last_error);
      assert.deepStrictEqual([s.count("liveRecover.reverted"), s.count("liveRecover.exited"),
        s.count("liveRecover.refused")], [0, 0, 0]);
      assert.strictEqual(s.count("liveRecover.staleOwned"), 2);
      assert.strictEqual(s.env.battle.getStatus().counters["liveRecover.staleOwned"], 2);
    } finally {
      s.env.close();
    }
  });

  needsDriver("AV4-T4: a LIVE wave battle of the previous boot with SPAWNED + RESERVE "
    + "rows -> BATTLE_LIVE_RECOVER -> exitLiveInTx(RESTART) COMPLETED LIVE_EVEJS, no losses, the reserve survives, rows "
    + "deleted", async () => {
    const s = setup(driver);
    try {
      const y = s.mk(S.N5);
      const c = s.claimLive(y.battleId);
      const keys = s.env.q("SELECT member_key FROM battle_live_members WHERE battle_id = ? ORDER BY member_key",
        y.battleId).map((r) => r.member_key);
      const l = s.T((db) => s.env.battle.live.markLiveInTx(db, { battleId: y.battleId, expectedVersion: c.version,
        claimSeq: c.claimSeq, bootAt: s.env.clock.now(), spawned: [{ memberKey: keys[0], entityId: 9601 },
          { memberKey: keys[3], entityId: 9602 }], reserve: [keys[1], keys[2]] }));
      assert.strictEqual(l.ok, true, JSON.stringify(l));
      assert.deepStrictEqual(s.env.q("SELECT state FROM battle_live_members WHERE battle_id = ? ORDER BY member_key",
        y.battleId).map((r) => r.state), ["SPAWNED", "RESERVE", "RESERVE", "SPAWNED"]);
      s.env.clock.set(s.env.clock.now() + 1000);
      s.env.restart();
      const bootAt = s.env.clock.now();
      await s.env.drive(bootAt + s.env.cfg.battle.reconcileDelayMs + 3 * HOLD_MS);
      const by = s.rec(y.battleId);
      const result = JSON.parse(by.result_json);
      assert.deepStrictEqual({ state: by.state, mode: by.mode, exit: result.diagnostics.exit,
        destroyed: result.destroyedShips.length, surviving: result.survivingShips.reduce((n, g) => n + g.count, 0),
        losses: s.env.n("SELECT count(*) AS n FROM battle_losses WHERE battle_id = ?", y.battleId),
        rows: s.env.n("SELECT count(*) AS n FROM battle_live_members WHERE battle_id = ?", y.battleId),
        exited: s.count("liveRecover.exited") },
      { state: "COMPLETED", mode: "LIVE_EVEJS", exit: "RESTART", destroyed: 0, surviving: 4, losses: 0, rows: 0,
        exited: 1 });
    } finally {
      s.env.close();
    }
  });
};
