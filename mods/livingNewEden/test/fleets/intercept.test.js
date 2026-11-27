"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");
const { opDoneKey, arrivalKey } = require("../../lib/fleets/travelService");

const { S, FACTION_A } = H;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);

function travelling(env, tag, dueAt) {
  const fleetId = H.newFleet(env, tag, FACTION_A, COMP, S.N5);
  const op = env.fleets.createOperation({ operationType: "patrol", factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.L2, objective: "patrol", dueAt, fleets: [{ fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const p = env.fleets.planTravel({ fleetId, targetSystemId: S.L2 }, `${tag}:plan`);
  assert.ok(p.ok, JSON.stringify(p));
  return { fleetId, operationId: op.operationId, plan: p };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("LA5 interceptInTx: NOT_CROSSING / STALE_LEG / LEG_HAS_WORMHOLES / VERSION_CONFLICT "
    + "TX_REQUIRED before any write; STAGED, route null, legSeq kept, listeners intercepted:true; duplicate", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = H.boot(reopen(), shared);
      const heard = [];
      env.fleets.travel.addArrivalListener((tx, a) => heard.push({ ...a }));
      const t0 = shared.clock.now();
      const a = travelling(env, "la5a", t0 + 3600000);
      const f0 = env.tx((db) => env.fleets.repository.getFleet(db, a.fleetId)).fleet;
      const leg = f0.route;
      assert.deepStrictEqual(leg.systems, [S.N0, S.L1, S.L2]);
      const t1 = leg.departAt + leg.jumpMs;
      const spec = (o = {}) => ({ fleetId: a.fleetId, expectedVersion: f0.version, legSeq: f0.legSeq, systemIndex: 1,
        at: t1, ...o });
      const rows = () => ({ journal: H.n(env, "SELECT count(*) AS n FROM world_event_journal"),
        events: H.n(env, "SELECT count(*) AS n FROM world_scheduled_events") });
      const before = rows();
      const call = (s, key = "la5:halt") => env.tx((db) => env.fleets.travel.interceptInTx(db, s, key));

      const reasons = [
        env.fleets.travel.interceptInTx(null, spec(), "la5:halt").reason,
        call(spec({ systemIndex: 0, at: leg.departAt })).reason,
        call(spec({ systemIndex: 2, at: leg.arriveAt })).reason,
        call(spec({ at: t1 - 1 })).reason,
        call(spec({ at: t1 + leg.jumpMs })).reason,
        call(spec({ legSeq: f0.legSeq + 1 })).reason,
        call(spec({ expectedVersion: f0.version + 1 })).reason,
        call({ ...spec(), extra: 1 }).reason,
      ];
      assert.deepStrictEqual(reasons, ["TX_REQUIRED", "NOT_CROSSING", "NOT_CROSSING", "NOT_CROSSING", "NOT_CROSSING",
        "STALE_LEG", "VERSION_CONFLICT", "FLEET_INVALID_INPUT"]);
      assert.deepStrictEqual(rows(), before, "a refusal writes nothing");

      const r = travelling(env, "la5r", t0 + 3600000);
      const rr = env.fleets.retreat({ fleetId: r.fleetId }, "la5r:retreat");
      assert.ok(rr.ok, JSON.stringify(rr));
      const fr = env.tx((db) => env.fleets.repository.getFleet(db, r.fleetId)).fleet;
      assert.strictEqual(fr.state, "RETREATING");
      assert.strictEqual(call({ fleetId: r.fleetId, expectedVersion: fr.version, legSeq: fr.legSeq, systemIndex: 1,
        at: fr.route.departAt + fr.route.jumpMs }, "la5r:halt").reason, "STALE_LEG");

      const w = travelling(env, "la5w", t0 + 3600000);
      const fw = env.tx((db) => env.fleets.repository.getFleet(db, w.fleetId)).fleet;
      const v2 = { ...fw.route, v: 2, constraints: { wormholes: true }, wormholeEdges: [{ i: 1, pairKey: "wh:x",
        expiresAt: t0 + 9999999 }] };
      env.tx((db) => db.prepare("UPDATE virtual_fleets SET route_json = ? WHERE fleet_id = ?")
        .run(JSON.stringify(v2), w.fleetId));
      assert.strictEqual(call({ fleetId: w.fleetId, expectedVersion: fw.version, legSeq: fw.legSeq, systemIndex: 1,
        at: fw.route.departAt + fw.route.jumpMs }, "la5w:halt").reason, "LEG_HAS_WORMHOLES");
      assert.strictEqual(heard.length, 0, "no listener before a success");
      assert.strictEqual(env.fleets.travel.getCounters().intercepts, 0);

      const ok = call(spec());
      assert.deepStrictEqual(ok, { ok: true, duplicate: false, systemId: S.L1 });
      const f1 = env.tx((db) => env.fleets.repository.getFleet(db, a.fleetId)).fleet;
      assert.deepStrictEqual([f1.state, f1.currentSystemId, f1.route, f1.legSeq, f1.nextActionAt],
        ["STAGED", S.L1, null, f0.legSeq, null]);
      assert.deepStrictEqual(heard, [{ fleetId: a.fleetId, factionId: FACTION_A, systemId: S.L1, at: t1,
        state: "STAGED", legSeq: f0.legSeq, fleetRole: "invasion", intercepted: true,
        entry: { via: "GATE", fromSystemId: S.N0 } }]);
      assert.strictEqual(H.eventOf(env, opDoneKey(a.operationId)).state, "QUEUED");
      assert.strictEqual(env.fleets.travel.getCounters().intercepts, 1);
      const after = rows();
      assert.deepStrictEqual(call(spec()), { ok: true, duplicate: true, systemId: S.L1 });
      assert.deepStrictEqual(rows(), after);
      assert.strictEqual(heard.length, 1);
      assert.ok(before.journal < after.journal);

      shared.clock.set(leg.arriveAt + 1);
      for (let i = 0; i < 6; i += 1) {
        const p = await env.scheduler.runPass();
        assert.ok(p.ok, JSON.stringify(p));
        if (p.jobs === 0) break;
      }
      assert.strictEqual(H.eventOf(env, arrivalKey(a.fleetId, f0.legSeq)).state, "DONE");
      const f2 = env.tx((db) => env.fleets.repository.getFleet(db, a.fleetId)).fleet;
      assert.deepStrictEqual([f2.state, f2.currentSystemId], ["STAGED", S.L1]);
      assert.ok(env.fleets.travel.getCounters().staleArrivals >= 1);
    }));
};
