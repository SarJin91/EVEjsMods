"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");

const { S, FACTION_A } = H;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const t = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  t("BLK2 departure listener: called after the leg write, before FLEET_ARRIVAL; an exception is counted; retreat "
    + "calls none", () => H.withStore(driver, (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const fleetId = H.newFleet(env, "dl", FACTION_A, COMP);
    const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION_A, originSystemId: S.N0,
      targetSystemId: S.N9, objective: "capture", dueAt: H.START_MS + 3600000,
      fleets: [{ fleetId, expectedVersion: 1 }] }, "dl:op");
    assert.ok(op.ok, JSON.stringify(op));

    const seen = [];
    const listener = env.fleets.travel.addDepartureListener((tx, d) => {
      const row = env.fleets.repository.getFleet(tx, d.fleetId).fleet;
      const arrivals = tx.prepare("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'FLEET_ARRIVAL' "
        + "AND aggregate_id = ?").get(d.fleetId).n;
      seen.push({ d: JSON.parse(JSON.stringify(d)), state: row.state, legSeq: row.legSeq, arrivals });
      const r = env.scheduler.enqueue("BLOCKADE_INTERCEPT", "op-probe", d.leg.departAt + d.leg.jumpMs,
        { operationId: "op-probe", fleetId: d.fleetId, legSeq: d.legSeq, systemIndex: 1, at: d.leg.departAt
          + d.leg.jumpMs }, `blockade:op-probe:x:${d.fleetId}:${d.legSeq}`, { tx, chained: d.chained });
      assert.ok(r.ok, JSON.stringify(r));
    });
    assert.ok(listener.ok);
    const thrower = env.fleets.travel.addDepartureListener(() => {
      throw new Error("listener boom");
    });
    assert.ok(thrower.ok);
    assert.deepStrictEqual(env.fleets.travel.addDepartureListener(null), { ok: false, reason: "INVALID_LISTENER" });

    const plan = env.fleets.planTravel({ fleetId, targetSystemId: S.N9, constraints: AVOID }, "dl:plan");
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.strictEqual(seen.length, 1);
    const s = seen[0];
    assert.deepStrictEqual({ state: s.state, legSeq: s.legSeq, arrivals: s.arrivals }, { state: "TRAVELLING",
      legSeq: plan.legSeq, arrivals: 0 }, "after the leg write, before FLEET_ARRIVAL");
    assert.deepStrictEqual(s.d, { fleetId, factionId: FACTION_A, fleetRole: "invasion", shipCount: 3,
      operationId: op.operationId,
      legSeq: plan.legSeq, leg: { systems: [S.N0, S.N5, S.N6, S.N7, S.N9], departAt: plan.departAt,
        jumpMs: plan.jumpMs }, wormholes: false, chained: false });
    const rows = env.tx((db) => db.prepare("SELECT event_type FROM world_scheduled_events WHERE aggregate_id IN (?, ?) "
      + "ORDER BY event_type").all(fleetId, "op-probe")).map((r) => r.event_type);
    assert.deepStrictEqual(rows, ["BLOCKADE_INTERCEPT", "FLEET_ARRIVAL"]);
    assert.strictEqual(env.fleets.travel.getCounters().departureListenerErrors, 1);
    const fleet = env.tx((db) => env.fleets.repository.getFleet(db, fleetId)).fleet;
    assert.deepStrictEqual([fleet.state, fleet.legSeq, fleet.route.arriveAt], ["TRAVELLING", plan.legSeq,
      plan.arriveAt]);

    const back = env.fleets.retreat({ fleetId, targetSystemId: S.N5 }, "dl:retreat");
    assert.ok(back.ok, JSON.stringify(back));
    assert.strictEqual(seen.length, 1, "no call on a retreat");
    assert.strictEqual(env.fleets.travel.getCounters().departureListenerErrors, 1);

    listener.remove();
    thrower.remove();
    const f2 = H.newFleet(env, "dl2", FACTION_A, COMP);
    const op2 = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION_A, originSystemId: S.N0,
      targetSystemId: S.N9, objective: "capture", dueAt: H.START_MS + 3600000,
      fleets: [{ fleetId: f2, expectedVersion: 1 }] }, "dl2:op");
    assert.ok(op2.ok, JSON.stringify(op2));
    assert.ok(env.fleets.planTravel({ fleetId: f2, targetSystemId: S.N9, constraints: AVOID }, "dl2:plan").ok);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(env.fleets.travel.getCounters().departureListenerErrors, 1);
  }));
};
