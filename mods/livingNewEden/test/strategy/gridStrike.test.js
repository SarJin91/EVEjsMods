"use strict";

const assert = require("node:assert");

const K = require("../../lib/strategy/gridDefense/keys");
const { createGridDefenseService } = require("../../lib/strategy/gridDefense/service");
const { parseDefenseSettings } = require("../../lib/strategy/gridDefense/settings");
const { createPinRepository } = require("../../lib/strategy/hunt/pinRepository");
const { harness: G } = require("./gridDefense.test");
const { harness: C } = require("../battle/contacts.test");
const { harness: H } = require("../battle/settlement.test");

const { SANSHA, GURISTAS } = C;
const S = H.S;
const STRIKE_ON = Object.freeze({ ...G.ON, "grid.defense.strikePursuitEnabled": true });
const STRIKE_OP = Object.freeze({ operationType: "intercept", objective: "destroy" });
const PIN_MS = 3600000;

function strikeScene(driver, config, extra = {}) {
  const pins = createPinRepository();
  const env = G.createScene(driver, config, { ...extra, defenseDeps: { getHunt: () => ({ repository: pins }) } });
  env.pins = pins;
  let n = 0;
  env.pin = (strike, target, outcome = null) => {
    n += 1;
    const at = env.clock.now();
    const id = `hp_gst_${n}`;
    const r = env.tx((db) => pins.createPin(db, { pinId: id, idempotencyKey: `gst:pin:${n}`, factionId: SANSHA,
      hunterFleetId: `hunter_${n}`, systemId: S.N5, targetFleetId: target, targetFactionId: GURISTAS,
      strikeOperationId: `op_gst_${n}`, strikeFleetId: strike, pinnedAt: at, untilAt: at + PIN_MS, detail: {} }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    if (outcome) {
      const c = env.tx((db) => pins.closePin(db, { pinId: id, expectedVersion: 1, outcome, at }));
      assert.strictEqual(c.ok, true, JSON.stringify(c));
    }
    return id;
  };
  env.onBelt = async (fleetId) => {
    const { legSeq } = env.fleet(fleetId);
    const m = env.tx((db) => env.fleets.grid.moveInTx(db, { fleetId, systemId: S.N5, legSeq, at: env.clock.now(),
      to: { kind: "belt", id: G.BELT }, purpose: "WORK" }));
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    await env.drive(m.arriveAt);
  };
  env.strikeRows = () => env.rows(K.STEP_EVENT).filter((r) => r.idempotency_key.endsWith(":strike"));
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("GST1 grid flag off: the strike flies to the CP, no strike row, workOverride null "
    + "STRIKE payload parse", async () => {
    const env = strikeScene(driver, G.ON);
    try {
      const t = env.fleetOf("t", GURISTAS, "patrol", G.big(2));
      await env.onBelt(t);
      const s = env.fleetOf("s", SANSHA, "patrol", G.big(4), S.N0);
      env.pin(s, t);
      const trip = env.trip(s, SANSHA, S.N0, S.N5, "intercept", "destroy", "s");
      await env.drive(trip.arriveAt + 60000);
      const v = env.visit(s);
      assert.ok(v && v.purpose === "WORK" && v.to_kind === "station" && Number(v.to_id) === G.STATION,
        JSON.stringify(v));
      assert.deepStrictEqual(env.strikeRows(), []);
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_fleet_grid_visits WHERE purpose = 'PURSUIT'"), 0);
      const st = env.defense().getStatus();
      assert.deepStrictEqual(st.strikePursuit, { enabled: false, reason: "FLAG_OFF" });
      assert.strictEqual(st.counters.strikeListenerReads, 0);

      const svc = (cfg) => {
        const parsed = parseDefenseSettings(cfg);
        assert.ok(parsed.ok, JSON.stringify(parsed));
        return createGridDefenseService({ store: env.store, scheduler: env.scheduler, fleets: env.fleets,
          settings: parsed.settings, mode: "on", strengthOf: () => 1, isHostile: () => true });
      };
      const on = JSON.parse(JSON.stringify(env.cfg));
      on.grid.defense.strikePursuitEnabled = true;
      const arrival = { state: "STAGED" };
      const patrol = { fleetRole: "patrol" };
      assert.strictEqual(svc(env.cfg).workOverride({ fleet: patrol, operation: STRIKE_OP, arrival }), null);
      assert.deepStrictEqual(svc(on).workOverride({ fleet: patrol, operation: STRIKE_OP, arrival }),
        { kind: "STAY", rule: "GRID_STRIKE_HOLD" });
      assert.strictEqual(svc(on).workOverride({ fleet: { fleetRole: "hunter" }, operation: STRIKE_OP, arrival }), null);
      assert.strictEqual(svc(on).workOverride({ fleet: patrol, operation: { operationType: "patrol",
        objective: "patrol" }, arrival }), null);
      const bad = JSON.parse(JSON.stringify(env.cfg));
      bad.grid.defense.strikePursuitEnabled = 1;
      assert.deepStrictEqual(parseDefenseSettings(bad), { ok: false, key: "grid.defense.strikePursuitEnabled" });
      delete bad.grid.defense.strikePursuitEnabled;
      assert.strictEqual(parseDefenseSettings(bad).settings.strikePursuitEnabled, false, "no key = off");

      const sp = (over) => K.stepPayload({ fleetId: "f", systemId: S.N5, legSeq: 1, moveSeq: 0, phase: "STRIKE",
        targetFleetId: null, at: 5, ...over });
      assert.ok(K.parseStepPayload(sp({})));
      assert.strictEqual(K.parseStepPayload(sp({ targetFleetId: "t" })), null);
      assert.strictEqual(K.parseStepPayload(sp({ attempt: 1 })), null);
      assert.strictEqual(K.stepKey("f", 1, 0, K.stepTag.strike()), "gdstep:f:1:0:strike");
    } finally {
      env.close();
    }
  });

  needsDriver("GST2 grid integration: the strike holds on its entry gate, STRIKE -> PURSUIT to the belt of "
    + "the pin target, grid contact, belt battle", async () => {
    const resolver = C.seamResolver((input) => (input.sideA.factionId === SANSHA ? "A_WIN" : "B_WIN"));
    const env = strikeScene(driver, STRIKE_ON, { resolver });
    try {
      const t = env.fleetOf("t", GURISTAS, "patrol", G.big(2));
      await env.onBelt(t);
      const s = env.fleetOf("s", SANSHA, "patrol", G.big(4), S.N0);
      env.pin(s, t);
      const trip = env.trip(s, SANSHA, S.N0, S.N5, "intercept", "destroy", "s");
      await env.drive(trip.arriveAt);
      const legSeq = env.fleet(s).legSeq;
      const hold = env.visit(s);
      assert.ok(hold && Number(hold.move_seq) === 0 && hold.to_kind === null, JSON.stringify(hold));
      assert.ok(env.fleets.grid.getStatus().counters.movesDeferred >= 1, "the override kept it on the entry gate");
      const key = K.stepKey(s, legSeq, 0, "strike");
      const rows = env.strikeRows();
      assert.deepStrictEqual(rows.map((r) => [r.idempotency_key, r.state]), [[key, "QUEUED"]]);
      const due = trip.arriveAt + 20000 + K.jitterOf(env.battleDeps.persistence.worldSeed, key, 10000);
      assert.strictEqual(Number(rows[0].due_at), due);
      await env.drive(due);
      assert.strictEqual(env.event(key).outcome, "STRIKE_PURSUE");
      const pv = env.visit(s);
      assert.ok(pv && pv.purpose === "PURSUIT" && pv.target_fleet_id === t && pv.to_kind === "belt"
        && Number(pv.to_id) === G.BELT && Number(pv.move_seq) === 1, JSON.stringify(pv));
      await env.drive(Number(pv.arrive_at));
      assert.ok(env.event(`contact:${S.N5}:grid:${s}:${legSeq}:1`), "the grid contact of the strike arrival");
      const battles = env.battles();
      assert.strictEqual(battles.length, 1);
      assert.deepStrictEqual([battles[0].grid_kind, Number(battles[0].grid_id)], ["belt", G.BELT]);
      const st = env.defense().getStatus();
      assert.deepStrictEqual(st.strikePursuit, { enabled: true, reason: null });
      assert.deepStrictEqual([st.counters.strikeListenerReads, st.counters.strikePursuits, st.counters.listenerRefused],
        [1, 1, 0]);
    } finally {
      env.close();
    }
  });

  needsDriver("GST3 grid no pin / CLOSED pin / target elsewhere -> STRIKE_NO_PIN, no move, the operation "
    + "completes as before; query plan", async () => {
    const cases = [["none", null], ["closed", "CANCELLED"], ["elsewhere", null]];
    for (const [name, outcome] of cases) {
      const env = strikeScene(driver, STRIKE_ON);
      try {
        const t = env.fleetOf("t", GURISTAS, "patrol", G.big(2), name === "elsewhere" ? S.N6 : S.N5);
        const s = env.fleetOf("s", SANSHA, "patrol", G.big(4), S.N0);
        if (name !== "none") env.pin(s, t, outcome);
        const trip = env.trip(s, SANSHA, S.N0, S.N5, "intercept", "destroy", "s");
        await env.drive(trip.arriveAt + 60000);
        const rows = env.strikeRows();
        assert.deepStrictEqual(rows.map((r) => [r.state, r.outcome]), [["DONE", "STRIKE_NO_PIN"]], name);
        const v = env.visit(s);
        assert.ok(v && Number(v.move_seq) === 0, `${name}: ${JSON.stringify(v)}`);
        const done = env.q("SELECT state, due_at FROM world_scheduled_events WHERE event_type = "
          + "'FLEET_OPERATION_COMPLETE'");
        assert.strictEqual(done.length, 1, name);
        assert.strictEqual(Number(done[0].due_at), env.fleets.getOperation(env.fleet(s).operationId).operation.dueAt,
          name);
        const st = env.defense().getStatus();
        assert.strictEqual(st.counters.strikeNoPin, 1, name);
        assert.strictEqual(st.lastRefusal.reason, name === "elsewhere" ? "TARGET_GONE" : "NO_PIN", name);
        if (name === "none") {
          const plan = env.q("EXPLAIN QUERY PLAN SELECT * FROM world_hunt_pins WHERE system_id = ? AND state = 'ACTIVE' "
            + "AND strike_fleet_id = ? ORDER BY pinned_at DESC, pin_id LIMIT 1", S.N5, s).map((r) => r.detail).join("|");
          assert.ok(plan.includes("world_hunt_pins_system_state") && !/\bSCAN\b/.test(plan), plan);
        }
      } finally {
        env.close();
      }
    }
  });

  needsDriver("GST4 grid idempotency: the STRIKE key again (duplicate) and the handler again -> one move",
    async () => {
    const env = strikeScene(driver, STRIKE_ON);
    try {
      const t = env.fleetOf("t", GURISTAS, "patrol", G.big(2));
      await env.onBelt(t);
      const s = env.fleetOf("s", SANSHA, "patrol", G.big(4), S.N0);
      env.pin(s, t);
      const trip = env.trip(s, SANSHA, S.N0, S.N5, "intercept", "destroy", "s");
      await env.drive(trip.arriveAt);
      const legSeq = env.fleet(s).legSeq;
      const key = K.stepKey(s, legSeq, 0, "strike");
      const row = env.event(key);
      await env.drive(Number(row.due_at));
      assert.strictEqual(env.event(key).outcome, "STRIKE_PURSUE");
      const payload = JSON.parse(row.payload);
      const again = env.scheduler.enqueue(K.STEP_EVENT, s, payload.at, payload, key);
      assert.ok(again.ok === true && again.duplicate === true, JSON.stringify(again));
      const ev = { eventType: K.STEP_EVENT, idempotencyKey: key, payload };
      const read = env.handlers()[K.STEP_EVENT](ev, {});
      assert.strictEqual(read.outcome, "STALE", JSON.stringify(read));
      if (typeof read.effect === "function") env.tx((db) => read.effect(db, ev));
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key = ?",
        `grid:${s}:${legSeq}:1`), 1);
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key LIKE ?",
        `grid:${s}:${legSeq}:%`), 1, "one move of the strike");
      assert.strictEqual(Number(env.visit(s).move_seq), 1);
      assert.strictEqual(env.defense().getStatus().counters.strikePursuits, 1);
    } finally {
      env.close();
    }
  });

  needsDriver("GST5 grid RETURN classes: the strike ends in place (STRIKE_END), the garrison returns alone",
    async () => {
    const env = strikeScene(driver, { ...STRIKE_ON, "battle.gridContacts.enabled": false });
    try {
      const g = env.fleetOf("g", SANSHA, "garrison", G.big(3));
      const s = env.fleetOf("s", SANSHA, "patrol", G.big(3));
      const t = env.fleetOf("t", GURISTAS, "patrol", G.big(1));
      const t0 = env.clock.now();
      const arrive = [g, s].map((id) => {
        const { legSeq } = env.fleet(id);
        const r = env.tx((db) => env.fleets.grid.moveInTx(db, { fleetId: id, systemId: S.N5, legSeq, at: t0, to: { kind: "gate", id: G.GATE_N6 }, purpose: "PURSUIT",
          targetFleetId: t }));
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r.arriveAt;
      });
      const at = Math.max(...arrive) + 60000;
      env.clock.set(at);
      const ret = (id) => ({ eventType: K.STEP_EVENT, idempotencyKey: K.stepKey(id, env.fleet(id).legSeq, 1, "ret1"),
        payload: K.stepPayload({ fleetId: id, systemId: S.N5, legSeq: env.fleet(id).legSeq, moveSeq: 1,
          phase: "RETURN", targetFleetId: t, attempt: 0, round: 1, at }) });
      const evS = ret(s);
      const rs = env.handlers()[K.STEP_EVENT](evS, {});
      assert.strictEqual(rs.outcome, "STRIKE_END", JSON.stringify(rs));
      assert.strictEqual(rs.effect, undefined);
      const evG = ret(g);
      const rg = env.handlers()[K.STEP_EVENT](evG, {});
      assert.strictEqual(rg.outcome, "RETURN", JSON.stringify(rg));
      const v = env.tx((db) => rg.effect(db, evG));
      assert.strictEqual(v.moved, 1, JSON.stringify(v));
      assert.strictEqual(env.visit(g).purpose, "RETURN");
      const sv = env.visit(s);
      assert.ok(sv.purpose === "PURSUIT" && Number(sv.move_seq) === 1, JSON.stringify(sv));
    } finally {
      env.close();
    }
  });
};
