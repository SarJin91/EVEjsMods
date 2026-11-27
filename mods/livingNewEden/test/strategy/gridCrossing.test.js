"use strict";

const assert = require("node:assert");

const T = require("../../lib/fleets/grid/transit");
const X = require("../../lib/strategy/gridDefense/crossing");
const { startGridDefense } = require("../../lib/strategy/gridDefense");
const { gridCrossingRowsOf, blockadeRowsOf } = require("../../lib/strategy/reviewRows");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
const { jumpMsForComposition } = require("../../lib/fleets/travel");
const { harness: GD } = require("./gridDefense.test");
const { harness: C } = require("../battle/contacts.test");
const { harness: H } = require("../battle/settlement.test");

const S = H.S;
const { SANSHA, GURISTAS } = C;
const cruisers = (n) => [{ hullGroup: "cruiser", count: n }];
const frigates = (n) => [{ hullGroup: "frigate", count: n }];
const ON = Object.freeze({ ...GD.ON, "grid.crossings.enabled": true });
const SETTINGS = Object.freeze({ chaseNonCombat: true, lockMs: 5000, minStrengthPermille: 500,
  catchChancePermille: 1000 });

module.exports = ({ test, skip }) => {
  test("GXC1 grid pure: transit timeline, catchAtOf, decideCrossing rules, nextCrossingOf", () => {
    const raw = jumpMsForComposition(cruisers(1), { timeFactor: 1 }).baseJumpMs;
    for (const factor of [1, 0.5]) {
      const jumpMs = Math.round(raw * factor);
      const leg = { systems: [1, 2, 3], departAt: 1000, jumpMs };
      const tl = T.transitTimelineOf(leg, 1, cruisers(2));
      assert.ok(tl.ok, JSON.stringify(tl));
      assert.deepStrictEqual([tl.from, tl.until, tl.alignRaw, tl.rawJumpMs, tl.hullGroup],
        [1000 + jumpMs, 1000 + 2 * jumpMs, 7000, raw, "cruiser"]);
      assert.strictEqual(tl.inUntil, tl.from + Math.round(tl.s * 7000));
      assert.strictEqual(tl.outFrom, tl.from + Math.round(tl.s * (raw - 18000)));
      for (const gate of ["in", "out"]) {
        const at = T.catchAtOf(tl, gate, 5000);
        assert.ok(at >= tl.from && at < tl.until, `${gate} ${at}`);
      }
      assert.strictEqual(T.catchAtOf(tl, "in", 5000), tl.from + Math.round(tl.s * 5000));
    }
    assert.deepStrictEqual(T.transitTimelineOf({ systems: [1, 2], departAt: 0, jumpMs: 10 }, 1, cruisers(1)).reason,
      "NOT_INNER");

    const base = { transit: { fleetId: "t", factionId: 2, fleetRole: "patrol", strength: 100, alignRaw: 7000 },
      gate: "in", exposureMs: 0, guards: [{ fleetId: "g1", factionId: 1, strength: 30 },
        { fleetId: "g2", factionId: 1, strength: 30 }], cooldownFactions: new Set(), roll: 10, settings: SETTINGS };
    const run = (over, s = {}) => X.decideCrossing({ ...base, ...over, settings: { ...SETTINGS, ...s } });
    assert.deepStrictEqual(run({}), { kind: "CATCH", factionId: 1, guardIds: ["g1", "g2"] });
    assert.strictEqual(run({ transit: { ...base.transit, fleetRole: "hunter" } }).kind, "EVASIVE");
    assert.strictEqual(run({ transit: { ...base.transit, fleetRole: "mining" } }, { chaseNonCombat: false }).kind,
      "NON_COMBAT_SKIPPED");
    assert.strictEqual(run({ transit: { ...base.transit, alignRaw: 3000 } }).kind, "TOO_FAST", "frigate");
    assert.strictEqual(run({ gate: "out", exposureMs: 0 }).kind, "TOO_FAST");
    assert.strictEqual(run({ gate: "out", exposureMs: 10000 }).kind, "CATCH");
    assert.strictEqual(run({ guards: [] }).kind, "NO_GUARD");
    assert.strictEqual(run({ cooldownFactions: new Set([1]) }).kind, "COOLDOWN");
    assert.strictEqual(run({ guards: [{ fleetId: "g1", factionId: 1, strength: 40 }] }).kind, "OUTMATCHED");
    assert.strictEqual(run({}, { catchChancePermille: 0 }).kind, "ESCAPED");
    const tie = run({ guards: [{ fleetId: "b", factionId: 3, strength: 60 }, { fleetId: "a", factionId: 1,
      strength: 60 }] });
    assert.deepStrictEqual([tie.factionId, tie.guardIds], [1, ["a"]], "tie -> the smaller factionId");
    assert.ok(X.rollOf(7, "k") >= 0 && X.rollOf(7, "k") < 1000 && X.rollOf(7, "k") === X.rollOf(7, "k"));
    assert.ok(/^gxh:[0-9a-f]{40}$/.test(X.haltKeyOf(X.crossingKey("f1", 2, 1, "in"))));

    const leg = { systems: [1, 2, 3, 4], departAt: 0, jumpMs: raw };
    const exposure = (id) => (id === 3 ? 10000 : 0);
    const c = (a, b) => new Set([a, b].filter(Boolean));
    assert.deepStrictEqual(T.nextCrossingOf(leg, cruisers(1), null, c(2, 3), exposure, SETTINGS),
      { systemIndex: 1, systemId: 2, gate: "in", at: raw + 5000 });
    assert.deepStrictEqual(T.nextCrossingOf(leg, cruisers(1), { i: 1, gate: "in" }, c(2, 3), exposure, SETTINGS)
      .systemIndex, 2, "system 2 has no exit exposure -> system 3 IN");
    assert.deepStrictEqual(T.nextCrossingOf(leg, cruisers(1), { i: 2, gate: "in" }, c(2, 3), exposure, SETTINGS).gate,
      "out");
    const fr = T.nextCrossingOf(leg, frigates(1), null, c(2, 3), exposure, SETTINGS);
    assert.deepStrictEqual([fr.systemIndex, fr.gate], [2, "out"], "a frigate: only the bubble exit");
    assert.strictEqual(T.nextCrossingOf(leg, cruisers(1), null, new Set(), exposure, SETTINGS), null);
    assert.strictEqual(T.nextCrossingOf(leg, cruisers(1), { i: 2, gate: "out" }, c(2, 3), exposure, SETTINGS), null);

    const cfg = (on) => C.testConfig(on ? ON : {});
    assert.deepStrictEqual([gridCrossingRowsOf(cfg(true)), gridCrossingRowsOf(cfg(false)), gridCrossingRowsOf(null)],
      [1, 0, 0]);
    assert.strictEqual(blockadeRowsOf({ departureExtraRows: 1 }), 1);
    const on = rowBoundsOfConfig({ ...cfg(true), modules: { ...cfg(true).modules, strategy: { enabled: true } } });
    const off = rowBoundsOfConfig({ ...cfg(false), modules: { ...cfg(false).modules, strategy: { enabled: true } } });
    assert.ok(on.review > off.review, `${on.review} > ${off.review}`);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  async function guardAt(env, tag, anchor, comp = cruisers(6)) {
    const id = env.fleetOf(tag, SANSHA, "garrison", comp);
    const legSeq = env.fleet(id).legSeq;
    const at = env.clock.now();
    const r = env.tx((db) => env.fleets.grid.moveInTx(db, { fleetId: id, systemId: S.N5, legSeq, at, to: anchor,
      purpose: "POST" }));
    assert.ok(r.ok && r.moved, JSON.stringify(r));
    await env.drive(r.arriveAt);
    return id;
  }
  const gate = (id) => ({ kind: "gate", id });
  const crossings = (env) => env.rows("FLEET_GRID_CROSSING");
  const payloadOf = (env, key) => JSON.parse(env.event(key).payload);
  const haltRows = (env, key) => env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
    X.haltKeyOf(key));

  needsDriver("GXC2 grid departure listener: one gridx row past a hostile garrison; hunter, no hostile, wormhole "
    + "leg, rolled back plan -> none", async () => {
    const env = GD.createScene(driver, ON);
    try {
      env.fleetOf("g", SANSHA, "garrison", cruisers(6));
      const t = env.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      const trip = env.trip(t, GURISTAS, S.N0, S.N6, "patrol", "patrol", "t");
      const legSeq = env.fleet(t).legSeq;
      const key = X.crossingKey(t, legSeq, 1, "in");
      assert.deepStrictEqual(crossings(env).map((r) => r.idempotency_key), [key]);
      const tl = T.transitTimelineOf({ systems: [S.N0, S.N5, S.N6], departAt: trip.departAt, jumpMs: trip.jumpMs }, 1,
        cruisers(2));
      const at = T.catchAtOf(tl, "in", 5000);
      assert.deepStrictEqual(payloadOf(env, key), { fleetId: t, legSeq, systemIndex: 1, systemId: S.N5, gate: "in",
        check: 0, at });
      assert.strictEqual(Number(crossings(env)[0].due_at), at);
      assert.strictEqual(env.defense().getStatus().crossings.enabled, true);

      const h = env.fleetOf("h", GURISTAS, "hunter", cruisers(2), S.N0);
      env.trip(h, GURISTAS, S.N0, S.N6, "patrol", "patrol", "h");
      const friend = env.fleetOf("s", SANSHA, "patrol", cruisers(2), S.N0);
      env.trip(friend, SANSHA, S.N0, S.N6, "patrol", "patrol", "s");
      assert.strictEqual(crossings(env).length, 1, "hunter / no hostile garrison: no row");

      const r = env.fleetOf("r", GURISTAS, "patrol", cruisers(2), S.N0);
      const op = env.fleets.createOperation({ operationType: "patrol", factionId: GURISTAS, originSystemId: S.N0,
        targetSystemId: S.N6, objective: "patrol", dueAt: env.clock.now() + 3600000,
        fleets: [{ fleetId: r, expectedVersion: env.fleet(r).version }] }, "gd:op:r");
      assert.ok(op.ok, JSON.stringify(op));
      const rolled = env.store.transaction("test.rollback", (db) => {
        const p = env.fleets.travel.planInTx(db, { fleetId: r, targetSystemId: S.N6 }, "gd:plan:r");
        assert.ok(p.ok, JSON.stringify(p));
        throw new Error("rollback");
      });
      assert.strictEqual(rolled.ok, false);
      assert.strictEqual(crossings(env).length, 1, "rolled back plan: no row");

      env.defense().stop();
      let listener = null;
      const travel = { ...env.fleets.travel, addDepartureListener: (fn) => {
        listener = fn;
        return env.fleets.travel.addDepartureListener(fn);
      } };
      const s2 = startGridDefense({ config: env.cfg, persistence: env.battleDeps.persistence, scheduler: env.scheduler,
        fleets: { ...env.fleets, travel }, graph: { getGraph: () => ({ ok: true, graph: env.graph }) } });
      assert.ok(s2.ok && typeof listener === "function", JSON.stringify(s2));
      env.tx((db) => listener(db, { fleetId: r, factionId: GURISTAS, fleetRole: "patrol", operationId: null, legSeq: 9,
        leg: { systems: [S.N0, S.N5, S.N6], departAt: env.clock.now(), jumpMs: trip.jumpMs }, wormholes: true,
        chained: false }));
      assert.strictEqual(crossings(env).length, 1, "wormhole leg: no row");
      s2.gridDefense.stop();
    } finally {
      env.close();
    }
  });

  needsDriver("GXC3 grid catch: entry gate -> STAGED on the gate, contact at p.at, battle in the gate grid; exit "
    + "gate in nullsec -> placeInTx; a guard at the CP -> NO_GUARD + the next check", async () => {
    const resolver = C.seamResolver(() => "A_WIN");
    const env = GD.createScene(driver, ON, { resolver });
    try {
      await guardAt(env, "g", gate(GD.GATE_N0));
      const t = env.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      env.trip(t, GURISTAS, S.N0, S.N6, "patrol", "patrol", "t");
      const legSeq = env.fleet(t).legSeq;
      const key = X.crossingKey(t, legSeq, 1, "in");
      const at = Number(env.event(key).due_at);
      await env.drive(at);
      assert.deepStrictEqual([env.event(key).state, env.event(key).outcome], ["DONE", "CATCH"]);
      const f = env.fleet(t);
      assert.deepStrictEqual([f.currentSystemId, f.legSeq, ["STAGED", "ENGAGED"].includes(f.state)],
        [S.N5, legSeq, true], f.state);
      const v = env.visit(t);
      assert.ok(v && v.to_kind === null && Number(v.move_seq) === 0, JSON.stringify(v));
      const pos = env.tx((db) => env.fleets.grid.positionsOf(db, S.N5, [f], at)).positions.get(t);
      assert.deepStrictEqual([pos.anchorKind, pos.anchorId], ["gate", GD.GATE_N0]);
      const contact = env.event(`contact:${S.N5}:arr:${t}:${legSeq}`);
      assert.ok(contact && Number(contact.due_at) === at, JSON.stringify(contact));
      await env.drive(at + 60000);
      const battles = env.battles();
      assert.ok(battles.length === 1 && battles[0].grid_kind === "gate" && Number(battles[0].grid_id) === GD.GATE_N0,
        JSON.stringify(battles));
      assert.strictEqual(env.defense().getStatus().counters.crossingsCaught, 1);
    } finally {
      env.close();
    }

    const env2 = GD.createScene(driver, ON);
    try {
      await guardAt(env2, "g", gate(GD.GATE_N6));
      const t = env2.fleetOf("t", GURISTAS, "patrol", frigates(2), S.N0);
      env2.trip(t, GURISTAS, S.N0, S.N6, "patrol", "patrol", "t");
      const legSeq = env2.fleet(t).legSeq;
      assert.deepStrictEqual(crossings(env2).map((r) => r.idempotency_key), [X.crossingKey(t, legSeq, 1, "out")],
        "a frigate: only the exit gate of nullsec N5");
      await env2.drive(Number(crossings(env2)[0].due_at));
      const v = env2.q("SELECT at_kind, at_id FROM world_fleet_grid_visits WHERE fleet_id = ?", t)[0];
      assert.deepStrictEqual([["STAGED", "ENGAGED"].includes(env2.fleet(t).state), v.at_kind, Number(v.at_id)],
        [true, "gate", GD.GATE_N6]);
      assert.strictEqual(env2.fleets.grid.getStatus().counters.placed, 1);
    } finally {
      env2.close();
    }

    const env3 = GD.createScene(driver, ON);
    try {
      env3.fleetOf("g", SANSHA, "garrison", cruisers(6));
      const t = env3.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      env3.trip(t, GURISTAS, S.N0, S.N6, "patrol", "patrol", "t");
      const legSeq = env3.fleet(t).legSeq;
      await env3.drive(Number(crossings(env3)[0].due_at));
      assert.deepStrictEqual(crossings(env3).map((r) => [r.idempotency_key, r.outcome]),
        [[X.crossingKey(t, legSeq, 1, "in"), "NO_GUARD"], [X.crossingKey(t, legSeq, 1, "out"), null]]);
      assert.strictEqual(payloadOf(env3, X.crossingKey(t, legSeq, 1, "out")).check, 1);
      assert.strictEqual(env3.fleet(t).state, "TRAVELLING");
    } finally {
      env3.close();
    }
  });

  needsDriver("GXC4 grid idempotency: one intercept for two effects, legSeq + 1 -> STALE without a next row "
    + "drain -> STALE, CROSSING_PLACE_FAILED rolls the intercept back", async () => {
    const env = GD.createScene(driver, ON);
    try {
      await guardAt(env, "g", gate(GD.GATE_N0));
      const t = env.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      env.trip(t, GURISTAS, S.N0, S.N6, "patrol", "patrol", "t");
      const legSeq = env.fleet(t).legSeq;
      const key = X.crossingKey(t, legSeq, 1, "in");
      const row = env.event(key);
      env.clock.set(Number(row.due_at));
      const ev = { eventType: X.EVENT_TYPE, idempotencyKey: key, dueAt: Number(row.due_at),
        payload: JSON.parse(row.payload) };
      const r = env.handlers()[X.EVENT_TYPE](ev);
      assert.strictEqual(r.outcome, "CATCH", JSON.stringify(r));
      const first = env.tx((db) => r.effect(db, ev));
      const second = env.tx((db) => r.effect(db, ev));
      assert.deepStrictEqual([first.caught, second.duplicate], [true, true]);
      await env.drive(Number(row.due_at) + 1000);
      assert.deepStrictEqual([env.event(key).outcome], ["STALE"], "the queued row sees the stopped leg");
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key LIKE ?",
        `contact:${S.N5}:arr:${t}:%`), 1);
      assert.strictEqual(haltRows(env, key), 1);

      env.fleetOf("g2", SANSHA, "garrison", cruisers(6));
      const u = env.fleetOf("u", GURISTAS, "patrol", cruisers(2), S.N0);
      env.trip(u, GURISTAS, S.N0, S.N6, "patrol", "patrol", "u");
      const uKey = X.crossingKey(u, env.fleet(u).legSeq, 1, "in");
      const re = env.fleets.planTravel({ fleetId: u, targetSystemId: S.N6 }, "gd:replan:u");
      assert.ok(re.ok, JSON.stringify(re));
      await env.drive(Number(env.event(uKey).due_at));
      assert.strictEqual(env.event(uKey).outcome, "STALE");
      assert.ok(!crossings(env).some((x) => x.idempotency_key === X.crossingKey(u, env.fleet(u).legSeq - 1, 1, "out")),
        "no next row of the old leg");
    } finally {
      env.close();
    }

    const env2 = GD.createScene(driver, ON);
    try {
      await guardAt(env2, "g", gate(GD.GATE_N0));
      const t = env2.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      env2.trip(t, GURISTAS, S.N0, S.N6, "patrol", "patrol", "t");
      const key = X.crossingKey(t, env2.fleet(t).legSeq, 1, "in");
      env2.defense().stop();
      const off = JSON.parse(JSON.stringify(env2.cfg));
      off.grid.crossings.enabled = false;
      const s2 = startGridDefense({ config: off, persistence: env2.battleDeps.persistence, scheduler: env2.scheduler,
        fleets: env2.fleets, graph: { getGraph: () => ({ ok: true, graph: env2.graph }) } });
      assert.ok(s2.ok, JSON.stringify(s2));
      assert.deepStrictEqual(s2.gridDefense.getStatus().crossings, { enabled: false, reason: "FLAG_OFF" });
      await env2.drive(Number(env2.event(key).due_at));
      assert.strictEqual(env2.event(key).outcome, "STALE");
      assert.strictEqual(s2.gridDefense.getStatus().counters.drained, 1);
      assert.strictEqual(env2.fleet(t).state, "TRAVELLING");
      s2.gridDefense.stop();
    } finally {
      env2.close();
    }

    const env3 = GD.createScene(driver, ON);
    try {
      await guardAt(env3, "g", gate(GD.GATE_N6));
      env3.defense().stop();
      const grid = { ...env3.fleets.grid, placeInTx: () => ({ ok: true, placed: false }) };
      const s3 = startGridDefense({ config: env3.cfg, persistence: env3.battleDeps.persistence,
        scheduler: env3.scheduler, fleets: { ...env3.fleets, grid },
        graph: { getGraph: () => ({ ok: true, graph: env3.graph }) } });
      assert.ok(s3.ok, JSON.stringify(s3));
      const t = env3.fleetOf("t", GURISTAS, "patrol", frigates(2), S.N0);
      env3.trip(t, GURISTAS, S.N0, S.N6, "patrol", "patrol", "t");
      const key = X.crossingKey(t, env3.fleet(t).legSeq, 1, "out");
      await env3.drive(Number(env3.event(key).due_at));
      assert.strictEqual(env3.event(key).state, "QUARANTINED");
      assert.strictEqual(env3.fleet(t).state, "TRAVELLING");
      assert.strictEqual(haltRows(env3, key), 0);
      assert.strictEqual(s3.gridDefense.getStatus().counters.crossingPlaceFailed, 1);
      s3.gridDefense.stop();
    } finally {
      env3.close();
    }
  });

  needsDriver("GXC5 grid align window: a cruiser departs at + align after a gate arrival, a frigate and the flag "
    + "off at `at`", async () => {
    const departOf = async (config, comp, tag, withGuard = false) => {
      const resolver = C.seamResolver((input) => (input.sideA.factionId === SANSHA ? "A_WIN" : "B_WIN"));
      const env = GD.createScene(driver, config, { resolver });
      try {
        if (withGuard) await guardAt(env, "g", gate(GD.GATE_N0));
        const id = env.fleetOf(tag, GURISTAS, "patrol", comp, S.N0);
        const trip = env.trip(id, GURISTAS, S.N0, S.N5, "ratting", "rat", tag);
        await env.drive(trip.arriveAt);
        const v = env.q("SELECT to_kind, depart_at, arrive_at FROM world_fleet_grid_visits WHERE fleet_id = ?", id)[0];
        assert.ok(v && v.to_kind === "belt", JSON.stringify(v));
        const f = env.fleet(id);
        const atArrival = env.tx((db) => env.fleets.grid.positionsOf(db, S.N5, [f], trip.arriveAt)).positions.get(id);
        const out = { held: Number(v.depart_at) - trip.arriveAt, kind: atArrival.kind, anchorKind: atArrival.anchorKind,
          moveMs: Number(v.arrive_at) - trip.arriveAt, alignHeld: env.fleets.grid.getStatus().counters.alignHeld,
          expect: env.clock.travelDurationMs(Math.round(env.cfg.fleets.travelTimeFactor * 7000), { observed: false }) };
        if (withGuard) {
          await env.drive(trip.arriveAt + 60000);
          out.gateBattles = env.battles().filter((b) => b.grid_kind === "gate")
            .map((b) => [b.grid_kind, Number(b.grid_id)]);
        }
        return out;
      } finally {
        env.close();
      }
    };
    const cruiser = await departOf(ON, cruisers(2), "c");
    assert.ok(cruiser.held > 0 && cruiser.held === Math.min(cruiser.moveMs - 1, Math.round(cruiser.expect)),
      JSON.stringify(cruiser));
    assert.deepStrictEqual([cruiser.kind, cruiser.anchorKind, cruiser.alignHeld], ["anchor", "gate", 1]);
    const frigate = await departOf(ON, frigates(2), "f");
    assert.deepStrictEqual([frigate.held, frigate.alignHeld], [0, 0]);
    const off = await departOf(GD.ON, cruisers(2), "o");
    assert.deepStrictEqual([off.held, off.kind, off.alignHeld], [0, "warp", 0]);
    const guardedCruiser = await departOf(ON, cruisers(2), "c", true);
    assert.deepStrictEqual(guardedCruiser.gateBattles, [["gate", GD.GATE_N0]], JSON.stringify(guardedCruiser));
    const guardedFrigate = await departOf(ON, frigates(2), "f", true);
    assert.deepStrictEqual([guardedFrigate.held, guardedFrigate.gateBattles], [0, []], JSON.stringify(guardedFrigate));
  });
};
