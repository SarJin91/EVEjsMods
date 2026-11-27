"use strict";

const assert = require("node:assert");

const { planLiveMembers, buildLiveResult } = require("../../lib/battle/liveMembers");
const { withStructureOutcome } = require("../../lib/battle/structureOutcome");
const { validateResult } = require("../../lib/battle/contract");
const { createLossTracker } = require("../../lib/materialization/lossTracker");
const { harness: H } = require("./settlement.test");
const { harness: C } = require("./contacts.test");

const COMP2 = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const HOLD_MS = 60000;
const RESTART_GAP_MS = 4000;

function setup(driver, opts = {}) {
  const env = C.createEnv(driver, { resolver: C.seamResolver(() => "DRAW"), getStructureSeam: opts.getStructureSeam,
    config: opts.config });
  const T = (fn) => {
    const r = env.store.transaction("test.lrm", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const battle = (id) => T((db) => env.battle.repository.getBattle(db, id)).battle;
  let n = 0;
  const mk = (system, structure) => {
    n += 1;
    const a = env.newFleet(`lrm-a${n}`, C.SANSHA, system, COMP2);
    const b = env.newFleet(`lrm-b${n}`, C.GURISTAS, system, COMP2);
    const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: env.fleet(id).version }] });
    const spec = { systemId: system, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
      maxResolutionMs: 20, garrison: null, sideA: side(C.SANSHA, a), sideB: side(C.GURISTAS, b), ...(structure || {}) };
    const created = T((db) => env.battle.repository.createBattle(db, spec, `lrm:${n}:battle`));
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
  const members = (battleId) => env.q("SELECT member_key, fleet_id, entity_id FROM battle_live_members WHERE "
    + "battle_id = ? ORDER BY member_key", battleId);
  const toLive = (system, structure) => {
    const m = mk(system, structure);
    const c = claimLive(m.battleId);
    const spawned = members(m.battleId).map((r, i) => ({ memberKey: r.member_key, entityId: 9000 + 100 * n + i }));
    const l = T((db) => env.battle.live.markLiveInTx(db, { battleId: m.battleId, expectedVersion: c.version,
      claimSeq: c.claimSeq, bootAt: env.clock.now(), spawned }));
    assert.strictEqual(l.ok, true, JSON.stringify(l));
    return { ...m, spawned };
  };
  const lose = (m, k) => {
    const keys = members(m.battleId).filter((r) => r.fleet_id === m.a).slice(0, k).map((r) => r.member_key);
    for (const memberKey of [...keys, ...keys]) {
      const r = T((db) => env.battle.live.markDestroyedInTx(db, { battleId: m.battleId, memberKey }));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
    }
  };
  const settleKeys = (id) => env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
    `battle:${id}:settle:v1`);
  const ships = (fleetId) => env.fleet(fleetId).composition.reduce((s, g) => s + g.count, 0);
  const rec = (id) => env.q("SELECT * FROM battle_records WHERE battle_id = ?", id)[0];
  return { env, T, mk, claimLive, toLive, lose, settleKeys, ships, rec };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const S = H.S;

  needsDriver("LRM restart matrix (previous boot, updated_at < bootAt; reconcile + 02b twice): one "
    + "settle:v1 or QUARANTINED per battle, RESTART result from the member rows with k DESTROYED, hull losses once; "
    + "a LIVE battle of this boot stays LIVE (STALE)", async () => {
    const s = setup(driver);
    try {
      const rows = {};
      rows.pending = s.mk(S.N5);
      rows.claimed = s.mk(S.N6);
      s.claimLive(rows.claimed.battleId);
      rows.live0 = s.toLive(S.N7);
      rows.liveK = s.toLive(S.N5);
      s.lose(rows.liveK, 1);
      rows.inMemory = s.toLive(S.N6);
      const tracker = createLossTracker({ maxPending: 10 });
      tracker.track(rows.inMemory.battleId, rows.inMemory.spawned);
      tracker.note({ itemID: rows.inMemory.spawned[0].entityId }, { success: true });
      rows.exitRolledBack = s.toLive(S.N7);
      s.lose(rows.exitRolledBack, 1);
      const boom = s.env.store.transaction("test.lrm.exit", (db) => {
        const r = s.env.battle.live.exitLiveInTx(db, { battleId: rows.exitRolledBack.battleId,
          at: s.env.clock.now(), reason: "EXIT" });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        throw new Error("crash inside the exit transaction");
      });
      assert.strictEqual(boom.ok, false);
      rows.exited = s.toLive(S.N5);
      const ex = s.T((db) => s.env.battle.live.exitLiveInTx(db, { battleId: rows.exited.battleId,
        at: s.env.clock.now(), reason: "EXIT" }));
      assert.strictEqual(ex.ok, true, JSON.stringify(ex));
      rows.broken = s.toLive(S.N6);
      const firstKey = s.env.q("SELECT member_key FROM battle_live_members WHERE battle_id = ? ORDER BY member_key "
        + "LIMIT 1", rows.broken.battleId)[0].member_key;
      assert.ok(s.env.store.transaction("test.break", (db) => db.prepare("DELETE FROM battle_live_members WHERE "
        + "battle_id = ? AND member_key = ?").run(rows.broken.battleId, firstKey)).ok);
      const shipsBefore = Object.fromEntries(Object.entries(rows).map(([k, m]) => [k, [s.ships(m.a), s.ships(m.b)]]));

      s.env.clock.set(s.env.clock.now() + RESTART_GAP_MS);
      s.env.restart();
      const bootAt = s.env.clock.now();
      rows.current = s.toLive(S.N7);
      assert.ok(s.rec(rows.current.battleId).updated_at >= bootAt);
      const recAt = bootAt + s.env.cfg.battle.reconcileDelayMs;
      await s.env.drive(recAt + 3 * HOLD_MS);
      const again = s.env.clock.now();
      assert.ok(s.env.scheduler.enqueue("BATTLE_RECONCILE", "reconcile", again, { afterId: null, page: 0, bootAt },
        "test:lrm:reconcile:2").ok);
      for (const [k, m] of Object.entries(rows)) {
        assert.ok(s.env.scheduler.enqueue("BATTLE_LIVE_RECOVER", m.battleId, again, { battleId: m.battleId, bootAt },
          `test:lrm:${k}:2`).ok, k);
      }
      await s.env.drive(again + 3 * HOLD_MS);

      const exitOf = (id) => {
        const r = s.rec(id);
        return r.result_json ? JSON.parse(r.result_json).diagnostics.exit || null : null;
      };
      const destroyedOf = (id) => {
        const r = s.rec(id);
        return r.result_json ? (JSON.parse(r.result_json).destroyedShips || []).reduce((n, d) => n + d.count, 0)
          : null;
      };
      const got = Object.fromEntries(Object.entries(rows).map(([k, m]) => [k, {
        state: s.rec(m.battleId).state, mode: s.rec(m.battleId).mode, keys: s.settleKeys(m.battleId),
        exit: exitOf(m.battleId), destroyed: destroyedOf(m.battleId),
        lostA: k === "current" ? null : shipsBefore[k][0] - s.ships(m.a),
        lostB: k === "current" ? null : shipsBefore[k][1] - s.ships(m.b),
        second: s.env.event(`test:lrm:${k}:2`).outcome }]));
      const live = (destroyed) => ({ state: "COMPLETED", mode: "LIVE_EVEJS", keys: 1, exit: "RESTART", destroyed,
        lostA: destroyed, lostB: 0, second: "STALE" });
      const virtual = { state: "COMPLETED", mode: "VIRTUAL", keys: 1, exit: null, destroyed: 0, lostA: 0, lostB: 0,
        second: "STALE" };
      assert.deepStrictEqual(got, {
        pending: virtual,
        claimed: virtual,
        live0: live(0),
        liveK: live(1),
        inMemory: live(0),
        exitRolledBack: live(1),
        exited: { state: "COMPLETED", mode: "LIVE_EVEJS", keys: 1, exit: "EXIT", destroyed: 0, lostA: 0, lostB: 0,
          second: "STALE" },
        broken: { state: "QUARANTINED", mode: "LIVE_EVEJS", keys: 0, exit: null, destroyed: null, lostA: 0, lostB: 0,
          second: "STALE" },
        current: { state: "LIVE", mode: "LIVE_EVEJS", keys: 0, exit: null, destroyed: null, lostA: null, lostB: null,
          second: "STALE" },
      });
      assert.strictEqual(tracker.sizes().pending, 1, "the noted loss died with the process (R1)");
      assert.strictEqual(s.env.event(`battle:${rows.current.battleId}:liverecover:${bootAt}`), undefined,
        "reconcile skips a LIVE battle of this boot");
    } finally {
      s.env.close();
    }
  });

  needsDriver("SO4 RESTART of a LIVE structure battle: structure destroyed -> the stored result equals "
    + "withStructureOutcome(buildLiveResult(...), input, {destroyed:true}) (one function); no seam -> "
    + "structureDestroyed false", async () => {
    const STRUCT = { structureId: 1030000000009, structureTypeId: 35832, structureSide: "B" };
    const run = async (getStructureSeam) => {
      const s = setup(driver, { getStructureSeam });
      try {
        const m = s.toLive(S.N5, STRUCT);
        s.lose(m, 1);
        const before = s.T((db) => s.env.battle.repository.getBattle(db, m.battleId)).battle;
        const members = s.T((db) => s.env.battle.live.listMembersInTx(db, m.battleId)).members;
        s.env.clock.set(s.env.clock.now() + RESTART_GAP_MS);
        s.env.restart();
        const bootAt = s.env.clock.now();
        await s.env.drive(bootAt + s.env.cfg.battle.reconcileDelayMs + 3 * HOLD_MS);
        const ev = s.env.event(`battle:${m.battleId}:liverecover:${bootAt}`);
        const built = buildLiveResult(before, members, { at: Number(ev.due_at), reason: "RESTART" });
        assert.ok(built.ok, JSON.stringify(built));
        const r = s.rec(m.battleId);
        return { state: r.state, stored: JSON.parse(r.result_json), built: built.result, input: before.input };
      } finally {
        s.env.close();
      }
    };
    const seam = { getStructure: (id) => ({ ok: true, row: { structureId: id, destroyedAt: 1760000000000 } }) };
    const dead = await run(() => seam);
    const none = await run(() => null);
    const R = { maxResultBytes: 131072 };
    const expect = (x, structure) => JSON.parse(JSON.stringify(validateResult(x.input,
      withStructureOutcome(x.built, x.input, structure), R).result));
    assert.deepStrictEqual([dead.state, dead.stored, none.state, none.stored],
      ["COMPLETED", expect(dead, { destroyed: true }), "COMPLETED", expect(none, undefined)]);
    assert.deepStrictEqual([dead.stored.structureDestroyed, dead.stored.objectiveAchieved, dead.stored.outcome,
      none.stored.structureDestroyed, none.stored.objectiveAchieved], [true, true, "DRAW", false, false],
    "1 of 2 ships of A lost: DRAW kept, no forced A_WIN");
  });

  needsDriver("GLV6 a LIVE battle with 3 battleship proxies of a previous boot "
    + "rebooted with battle.garrisonLive.enabled false and hullGroup cruiser -> RESTART COMPLETED from the rows "
    + "(garrisonShips 3, garrisonLost 1), one settle:v1, no quarantine", async () => {
    const s = setup(driver, { config: { "battle.garrisonLive.enabled": true, "battle.garrisonLive.hullGroup": "battleship" } });
    try {
      const a = s.env.newFleet("glv6-a", C.SANSHA, S.N5, COMP2);
      const b = s.env.newFleet("glv6-b", C.GURISTAS, S.N5, COMP2);
      const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: s.env.fleet(id).version }] });
      const spec = { systemId: S.N5, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
        maxResolutionMs: 20, garrison: { side: "B", factionId: C.GURISTAS, strength: 60 }, sideA: side(C.SANSHA, a),
        sideB: side(C.GURISTAS, b) };
      const created = s.T((db) => s.env.battle.repository.createBattle(db, spec, "glv6:battle"));
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      const battleId = created.battleId;
      const p = s.T((db) => s.env.battle.repository.getBattle(db, battleId)).battle;
      const gl = s.env.cfg.battle.garrisonLive;
      const gp = s.env.battle.live.planGarrison(p.input, { maxShips: gl.maxShips, pointsPerShip: gl.pointsPerShip,
        hullGroup: gl.hullGroup, room: 40 });
      const specs = [...planLiveMembers(p.input, { maxShips: 256 }).members, ...gp.members]
        .map((m) => ({ ...m, profileId: "prof_test" }));
      const c = s.T((db) => s.env.battle.live.claimLiveInTx(db, { battleId, expectedVersion: p.version }, specs));
      assert.strictEqual(c.ok, true, JSON.stringify(c));
      const rows = s.env.q("SELECT member_key, fleet_id FROM battle_live_members WHERE battle_id = ? ORDER BY "
        + "member_key", battleId);
      const spawned = rows.map((r, i) => ({ memberKey: r.member_key, entityId: 9900 + i }));
      assert.strictEqual(s.T((db) => s.env.battle.live.markLiveInTx(db, { battleId, expectedVersion: c.version,
        claimSeq: c.claimSeq, bootAt: s.env.clock.now(), spawned })).ok, true);
      const proxyKey = rows.find((r) => r.fleet_id === "garrison").member_key;
      assert.strictEqual(s.T((db) => s.env.battle.live.markDestroyedInTx(db, { battleId, memberKey: proxyKey })).ok,
        true);

      gl.enabled = false;
      gl.hullGroup = "cruiser";
      s.env.clock.set(s.env.clock.now() + RESTART_GAP_MS);
      s.env.restart();
      const bootAt = s.env.clock.now();
      await s.env.drive(bootAt + s.env.cfg.battle.reconcileDelayMs + 3 * HOLD_MS);
      const r = s.rec(battleId);
      const result = r.result_json ? JSON.parse(r.result_json) : null;
      assert.deepStrictEqual([r.state, r.mode, s.settleKeys(battleId), result && result.diagnostics, proxyKey],
        ["COMPLETED", "LIVE_EVEJS", 1, { source: "live", exit: "RESTART", garrisonShips: 3, garrisonLost: 1 },
          "garrison:battleship:0:1"]);
    } finally {
      s.env.close();
    }
  });
};
