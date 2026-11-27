"use strict";

const assert = require("node:assert");

const { startGridDefense, createUnavailableGridDefense, REQUIRED, SOFT_ROOTS } = require("../../lib/strategy/gridDefense");
const { decideResponse, decideStep, isDefender, pursuitWindowMs, activePursuitOf } =
  require("../../lib/strategy/gridDefense/decide");
const { rankPosts, pickPost } = require("../../lib/strategy/gridDefense/posts");
const K = require("../../lib/strategy/gridDefense/keys");
const { CLASSES, validateClasses } = require("../../lib/retention/classes");
const { createPinRepository } = require("../../lib/strategy/hunt/pinRepository");
const { getEventType } = require("../../lib/scheduler/eventTypes");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const { harness: C } = require("../battle/contacts.test");
const { harness: H } = require("../battle/settlement.test");

const { SANSHA, GURISTAS } = C;
const S = H.S;
const AU = 149597870700;
const GATE_N0 = 50009001;
const GATE_N6 = 50009002;
const STATION = 60009001;
const BELT = 40009001;
const big = (n) => [{ hullGroup: "cruiser", count: n }];

const anchor = (kind, id, x, extra = {}) => ({ kind, id, position: { x, y: 0, z: 0 }, toSystemId: null,
  lneStationId: null, lneSovStructureId: null, ownerCorpId: null, ...extra });
const fakeAdapter = () => ({ readGridAnchors(systemId) {
  if (systemId === S.N5) {
    return { ok: true, truncated: false, anchors: [anchor("gate", GATE_N0, 0, { toSystemId: S.N0 }),
      anchor("gate", GATE_N6, AU, { toSystemId: S.N6 }), anchor("station", STATION, 5 * AU),
      anchor("belt", BELT, 8 * AU)] };
  }
  return { ok: true, truncated: false, anchors: [] };
} });

const ON = Object.freeze({ "grid.enabled": true, "grid.movesEnabled": true, "battle.gridContacts.enabled": true,
  "grid.defense.enabled": true, "grid.defense.returnAfterMs": 60000 });

function bootDefense(env, over = {}) {
  const handlers = {};
  const scheduler = { ...env.scheduler, registerHandler: (type, fn, o) => {
    handlers[type] = fn;
    return env.scheduler.registerHandler(type, fn, o);
  } };
  const r = startGridDefense({ config: over.config || env.cfg, persistence: env.battleDeps.persistence, scheduler,
    fleets: env.fleets, telemetry: env.telemetry, graph: { getGraph: () => ({ ok: true, graph: env.graph }) },
    getBattle: () => env.battle, ...(over.deps || {}) });
  assert.ok(r.ok, JSON.stringify(r));
  return { defense: r.gridDefense, handlers };
}

function createScene(driver, config, extra = {}) {
  const env = C.createEnv(driver, { config, adapter: fakeAdapter(), ...extra });
  const over = { deps: extra.defenseDeps };
  let d = bootDefense(env, over);
  env.defense = () => d.defense;
  env.handlers = () => d.handlers;
  env.restartAll = () => {
    d.defense.stop();
    env.restart();
    d = bootDefense(env, over);
  };
  const close = env.close;
  env.close = () => {
    d.defense.stop();
    close();
  };
  env.tx = (fn) => {
    const r = env.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  env.fleetOf = (tag, factionId, role, comp, systemId = S.N5) => {
    const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId, fleetRole: role,
      composition: comp }, `gd:${tag}`);
    assert.ok(r.ok, JSON.stringify(r));
    return r.fleetId;
  };
  env.visit = (id) => env.q("SELECT move_seq, to_kind, to_id, arrive_at, purpose, target_fleet_id, attempts "
    + "FROM world_fleet_grid_visits WHERE fleet_id = ?", id)[0] || null;
  env.rows = (type) => env.q("SELECT idempotency_key, state, outcome, due_at FROM world_scheduled_events "
    + "WHERE event_type = ? ORDER BY due_at, idempotency_key", type);
  env.trip = (fleetId, factionId, from, to, type, objective, tag) => {
    const op = env.fleets.createOperation({ operationType: type, factionId, originSystemId: from, targetSystemId: to,
      objective, dueAt: env.clock.now() + 36000000, fleets: [{ fleetId, expectedVersion: env.fleet(fleetId).version }] },
    `gd:op:${tag}`);
    assert.ok(op.ok, JSON.stringify(op));
    const p = env.fleets.planTravel({ fleetId, targetSystemId: to }, `gd:plan:${tag}`);
    assert.ok(p.ok, JSON.stringify(p));
    return p;
  };
  return env;
}

const SETTINGS = Object.freeze({ roles: ["garrison"], chaseNonCombat: true, strengthRatioPermille: 1200,
  maxPursuersPerIntruder: 3, minHoldAtCp: 1, maxPursuitsPerSystem: 2, maxPursuitAttempts: 2, returnMaxRounds: 6 });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("GDF1 grid decideResponse: eta pick to 1.2x, max pursuers, minHoldAtCp, OUTMATCHED, BUSY, COOLDOWN, IN_GRID "
    + "EVASIVE, NON_COMBAT_SKIPPED, faction; isDefender; decideStep", () => {
    const def = (fleetId, factionId, strength, gridKey, etaMs, pursuing = null) => ({ fleetId, factionId, strength,
      gridKey, etaMs, pursuing });
    const base = { intruder: { fleetId: "i", factionId: 2, fleetRole: "patrol", strength: 100, gridKey: "belt:9" },
      defenders: [def("d1", 1, 50, "station:1", 10), def("d2", 1, 50, "station:1", 20), def("d3", 1, 80, "gate:5", 5),
        def("d4", 1, 60, "station:1", 1)], cpGridKey: "station:1", pursuitsByFaction: new Map(),
      cooldownFactions: new Set(), isHostile: (a, b) => a !== b, settings: SETTINGS };
    assert.deepStrictEqual(decideResponse(base), { kind: "PURSUE", factionId: 1, pursuers: ["d4", "d3"], need: 120,
      sum: 140 }, "d1 holds the CP; by eta d4, d3 up to 120");
    const run = (over, settings = {}) => decideResponse({ ...base, ...over, settings: { ...SETTINGS, ...settings } })
      .kind;
    assert.strictEqual(run({}, { maxPursuersPerIntruder: 1 }), "OUTMATCHED");
    assert.strictEqual(run({ intruder: { ...base.intruder, gridKey: "station:1" } }), "IN_GRID");
    assert.strictEqual(run({ pursuitsByFaction: new Map([[1, new Set(["i"])]]) }), "BUSY", "already a target");
    assert.strictEqual(run({ pursuitsByFaction: new Map([[1, new Set(["x", "y"])]]) }), "BUSY", "pursuit limit");
    assert.strictEqual(run({ cooldownFactions: new Set([1]) }), "COOLDOWN");
    assert.strictEqual(run({ intruder: { ...base.intruder, fleetRole: "hunter" } }), "EVASIVE");
    assert.strictEqual(run({ intruder: { ...base.intruder, fleetRole: "mining" } }, { chaseNonCombat: false }),
      "NON_COMBAT_SKIPPED");
    assert.strictEqual(run({ intruder: { ...base.intruder, fleetRole: "mining" } }), "PURSUE");
    assert.strictEqual(run({ defenders: base.defenders.map((d) => ({ ...d, strength: 0 })) }), "NO_DEFENDERS");
    assert.strictEqual(run({ isHostile: () => false }), "NO_DEFENDERS");
    const noHold = decideResponse({ ...base, settings: { ...SETTINGS, minHoldAtCp: 0 } });
    assert.deepStrictEqual(noHold.pursuers, ["d4", "d3"]);
    const busyD4 = decideResponse({ ...base, defenders: base.defenders.map((d) => (d.fleetId === "d4"
      ? { ...d, pursuing: "x" } : d)) });
    assert.deepStrictEqual(busyD4.pursuers, ["d3", "d2"], "a pursuing defender is no candidate");
    const f3 = decideResponse({ ...base, defenders: [...base.defenders, def("e1", 3, 150, "gate:5", 3),
      def("e2", 3, 150, "gate:6", 4)] });
    assert.deepStrictEqual([f3.factionId, f3.pursuers], [3, ["e1"]]);
    const tie = decideResponse({ ...base, defenders: [def("e1", 3, 240, "gate:5", 3), def("d9", 1, 240, "gate:6", 9)],
      settings: { ...SETTINGS, minHoldAtCp: 0 } });
    assert.strictEqual(tie.factionId, 1);

    assert.strictEqual(isDefender({ fleetRole: "garrison", state: "IDLE" }, null, SETTINGS), true);
    assert.strictEqual(isDefender({ fleetRole: "garrison", state: "STAGED" }, { operationType: "reinforce" }, SETTINGS),
      true);
    assert.strictEqual(isDefender({ fleetRole: "garrison", state: "STAGED" }, { operationType: "invasion" }, SETTINGS),
      false, "offensive operation");
    assert.strictEqual(isDefender({ fleetRole: "garrison", state: "ENGAGED" }, null, SETTINGS), false);
    assert.strictEqual(isDefender({ fleetRole: "patrol", state: "IDLE" }, null, SETTINGS), false);

    const step = (over) => decideStep({ phase: "ARRIVED", attempt: 0, round: 0, self: { state: "STAGED",
      gridKey: "belt:9" }, target: { state: "STAGED", inSystem: true, position: { kind: "anchor", gridKey: "belt:9" } },
    settings: SETTINGS, ...over });
    assert.strictEqual(step({}).kind, "CONTACT");
    assert.deepStrictEqual(step({ target: { state: "STAGED", inSystem: true, position: { kind: "warp" } } }),
      { kind: "LOCATE", attempt: 1 });
    assert.deepStrictEqual(step({ phase: "LOCATE", attempt: 1, target: { state: "IDLE", inSystem: true,
      position: { kind: "anchor", gridKey: "gate:5" } } }), { kind: "RETARGET", attempts: 1 });
    assert.strictEqual(step({ attempt: 1, target: { state: "STAGED", inSystem: true, position: { kind: "warp" } } })
      .kind, "RETURN", "attempt limit");
    assert.strictEqual(step({ target: { state: "TRAVELLING", inSystem: true, position: { kind: "transit" } } }).kind,
      "RETURN");
    assert.strictEqual(step({ target: null }).kind, "RETURN");
    assert.deepStrictEqual(step({ self: { state: "ENGAGED", gridKey: "belt:9" }, round: 2 }),
      { kind: "WAIT_ENGAGED", round: 3 });
    assert.strictEqual(step({ self: { state: "ENGAGED", gridKey: "belt:9" }, round: 6 }).kind, "STALE");

    const W = { ...SETTINGS, returnAfterMs: 60000, locateMs: 90000, reactionJitterMs: 10000 };
    assert.strictEqual(pursuitWindowMs(W), 620000);
    const pv = (over) => ({ purpose: "PURSUIT", targetFleetId: "t", arriveAt: 1000, ...over });
    assert.deepStrictEqual([activePursuitOf(pv({}), 500, W), activePursuitOf(pv({}), 621000, W),
      activePursuitOf(pv({}), 621001, W)], ["t", "t", null], "in warp, at the edge, past the window");
    assert.deepStrictEqual([activePursuitOf(pv({ arriveAt: null }), 1000, W), activePursuitOf(pv({ purpose: "RETURN" }),
      1000, W), activePursuitOf(pv({ targetFleetId: null }), 1000, W), activePursuitOf(null, 1000, W)],
    [null, null, null, null]);
  });

  test("GDF2 grid rankPosts / pickPost: CP, HOSTILE, NONE, ALLIED gates, own station, OWN gates; one post per grid "
    + "k mod min(N, maxPosts)", () => {
    const a = (kind, id, toSystemId = null) => ({ kind, id, toSystemId });
    const anchors = [a("gate", 4, 104), a("gate", 2, 102), a("gate", 1, 101), a("gate", 3, 103), a("gate", 5, 105),
      a("station", 10), a("structure", 30), a("structure", 31), a("belt", 40)];
    const gridOf = new Map([["gate:5", "gate:1"], ["gate:1", "gate:1"]]);
    const relationOf = new Map([[101, "HOSTILE"], [102, "NONE"], [103, "ALLIED"], [104, "OWN"], [105, "HOSTILE"]]);
    const posts = rankPosts({ anchors, gridOf, cp: a("station", 10), factionId: 1, relationOf,
      ownStationRefs: new Set(["structure:30"]) });
    assert.deepStrictEqual(posts.map((p) => `${p.kind}:${p.id}`), ["station:10", "gate:1", "gate:2", "gate:3",
      "structure:30", "gate:4"], "gate:5 shares the grid of gate:1; structure:31 is not own");
    const ids = ["a", "b", "c"];
    const pick = (fleetId, maxPosts) => pickPost({ posts, defenderIds: ids, fleetId, maxPosts });
    assert.deepStrictEqual([pick("a", 4).index, pick("b", 4).index, pick("c", 4).index, pick("z", 4).index],
      [0, 1, 2, 3], "absent fleet = defenderIds.length");
    assert.deepStrictEqual([pick("c", 2).index, pick("z", 2).anchor.id], [0, 1], "2 mod 2, 3 mod 2 -> gate:1");
    assert.deepStrictEqual(rankPosts({ anchors: [], gridOf: new Map(), cp: a("gate", 9), factionId: 1,
      relationOf: new Map(), ownStationRefs: new Set() }).map((p) => p.id), [9], "never empty");
  });

  needsDriver("GDF3 grid integration: belt intruder -> alert at its grid arrival, LOCATE, PURSUIT (one holds the "
    + "CP), grid battle on the belt, RETURN to the post; an arriving defender takes a gate post", async () => {
    const resolver = C.seamResolver((input) => (input.sideA.factionId === SANSHA ? "A_WIN" : "B_WIN"));
    const env = createScene(driver, ON, { resolver });
    try {
      const g1 = env.fleetOf("g1", SANSHA, "garrison", big(6));
      const g2 = env.fleetOf("g2", SANSHA, "garrison", big(6));
      const [hold, chaser] = [g1, g2].sort();
      const intruder = env.fleetOf("i", GURISTAS, "patrol", big(2), S.N0);
      const trip = env.trip(intruder, GURISTAS, S.N0, S.N5, "ratting", "rat", "i");
      await env.drive(trip.arriveAt);
      const iv = env.visit(intruder);
      assert.ok(iv && iv.to_kind === "belt" && Number(iv.move_seq) === 1, JSON.stringify(iv));
      assert.deepStrictEqual(env.rows("GRID_DEFENSE_ALERT"), [], "in warp at the arrival: no alert");
      await env.drive(Number(iv.arrive_at));
      const legSeq = env.fleet(intruder).legSeq;
      const seenKey = K.alertKey(S.N5, intruder, legSeq, 1);
      assert.deepStrictEqual(env.rows("GRID_DEFENSE_ALERT").map((r) => r.idempotency_key), [seenKey]);
      const seenDue = Number(env.rows("GRID_DEFENSE_ALERT")[0].due_at);
      assert.ok(seenDue >= Number(iv.arrive_at) + 20000 && seenDue <= Number(iv.arrive_at) + 30000, String(seenDue));
      await env.drive(seenDue);
      const alerts = env.rows("GRID_DEFENSE_ALERT");
      assert.deepStrictEqual(alerts.map((r) => [r.idempotency_key, r.state, r.outcome]), [[seenKey, "DONE", "LOCATING"],
        [`${seenKey}:loc`, "QUEUED", null]]);
      const locDue = Number(alerts[1].due_at);
      assert.ok(locDue >= Number(iv.arrive_at) + 90000 && locDue <= Number(iv.arrive_at) + 100000, String(locDue));
      await env.drive(locDue);
      assert.strictEqual(env.rows("GRID_DEFENSE_ALERT")[1].outcome, "PURSUE");
      const pv = env.visit(chaser);
      assert.ok(pv && pv.purpose === "PURSUIT" && pv.target_fleet_id === intruder && pv.to_kind === "belt",
        JSON.stringify(pv));
      assert.strictEqual(env.visit(hold), null, "the smallest id holds the CP");
      await env.drive(Number(pv.arrive_at));
      const battles = env.battles();
      assert.strictEqual(battles.length, 1);
      assert.deepStrictEqual([battles[0].grid_kind, Number(battles[0].grid_id)], ["belt", BELT]);
      const pLeg = env.fleet(chaser).legSeq;
      const arr = env.rows("GRID_DEFENSE_STEP").find((r) => r.idempotency_key === K.stepKey(chaser, pLeg, 1, "arr"));
      assert.ok(arr, JSON.stringify(env.rows("GRID_DEFENSE_STEP")));
      for (let i = 0; i < 12 && (!env.visit(chaser) || env.visit(chaser).purpose !== "RETURN"); i += 1) {
        await env.drive(env.clock.now() + 60000);
      }
      const rv = env.visit(chaser);
      assert.ok(rv && rv.purpose === "RETURN" && rv.to_kind === "gate", JSON.stringify(rv));
      assert.ok(env.rows("GRID_DEFENSE_STEP").some((r) => r.outcome === "RETURN"), "RETURN step");
      const c = env.defense().getStatus().counters;
      assert.deepStrictEqual([c.alerts, c.locating, c.pursuits, c.pursuers, c.returns], [1, 1, 1, 1, 1]);

      const g3 = env.fleetOf("g3", SANSHA, "garrison", big(2), S.N0);
      assert.deepStrictEqual([hold, chaser, g3].slice().sort(), [hold, chaser, g3], "g3 has the largest id");
      const t3 = env.trip(g3, SANSHA, S.N0, S.N5, "patrol", "patrol", "g3");
      await env.drive(t3.arriveAt);
      const posts = env.rows("GRID_DEFENSE_STEP").filter((r) => r.idempotency_key.endsWith(":post"));
      assert.deepStrictEqual(posts.map((r) => [r.state, r.outcome]), [["DONE", "POSTED"]], JSON.stringify(posts));
      const v3 = env.visit(g3);
      assert.ok(v3 && v3.purpose === "POST" && v3.to_kind === "gate" && Number(v3.to_id) === GATE_N6
        && Number(v3.move_seq) === 1, JSON.stringify(v3));
      assert.ok(env.fleets.grid.getStatus().counters.movesDeferred >= 1, "the override kept it on the entry gate");
    } finally {
      env.close();
    }
  });

  needsDriver("GDF3b grid: with grid.crossings.enabled the aligning intruder (on its entry gate at "
    + "the arrival) gets no arrival alert; the alert comes at its grid arrival, PURSUE, one battle, no refusal", async () => {
    const resolver = C.seamResolver((input) => (input.sideA.factionId === SANSHA ? "A_WIN" : "B_WIN"));
    const env = createScene(driver, { ...ON, "grid.crossings.enabled": true }, { resolver });
    try {
      env.fleetOf("g1", SANSHA, "garrison", big(6));
      env.fleetOf("g2", SANSHA, "garrison", big(6));
      const intruder = env.fleetOf("i", GURISTAS, "patrol", big(2), S.N0);
      const trip = env.trip(intruder, GURISTAS, S.N0, S.N5, "ratting", "rat", "i");
      await env.drive(trip.arriveAt);
      const iv = env.visit(intruder);
      const departAt = Number(env.q("SELECT depart_at FROM world_fleet_grid_visits WHERE fleet_id = ?",
        intruder)[0].depart_at);
      assert.ok(iv && iv.to_kind === "belt" && Number(iv.move_seq) === 1 && departAt > trip.arriveAt,
        `align window held: ${departAt} ${JSON.stringify(iv)}`);
      assert.deepStrictEqual(env.rows("GRID_DEFENSE_ALERT"), [], "aligning on the gate: no arrival alert");
      await env.drive(Number(iv.arrive_at));
      const seenKey = K.alertKey(S.N5, intruder, env.fleet(intruder).legSeq, 1);
      assert.deepStrictEqual(env.rows("GRID_DEFENSE_ALERT").map((r) => r.idempotency_key), [seenKey]);
      for (let i = 0; i < 20 && env.battles().length === 0; i += 1) await env.drive(env.clock.now() + 30000);
      assert.ok(env.rows("GRID_DEFENSE_ALERT").some((r) => r.outcome === "PURSUE"), "PURSUE");
      assert.strictEqual(env.battles().length, 1);
      assert.deepStrictEqual([env.battles()[0].grid_kind, Number(env.battles()[0].grid_id)], ["belt", BELT]);
      assert.strictEqual(env.defense().getStatus().counters.listenerRefused, 0);
    } finally {
      env.close();
    }
  });

  needsDriver("GDF4grid idempotency: ALERT twice -> one group move (one arriveAt), the second member STALE, RETURN "
    + "while ENGAGED -> ret2, restart before FLEET_GRID_ARRIVAL -> ARRIVED and RETURN once per member", async () => {
    const cfg = { ...ON, "battle.gridContacts.enabled": false, "grid.defense.seenReactionMs": 600000,
      "grid.defense.locateMs": 3600000 };
    const env = createScene(driver, cfg);
    try {
      const ids = ["a", "b", "c"].map((t) => env.fleetOf(t, SANSHA, "garrison", big(3)));
      const intruder = env.fleetOf("i", GURISTAS, "patrol", big(4));
      const t0 = env.clock.now();
      const legSeq = env.fleet(intruder).legSeq;
      const m = env.tx((db) => env.fleets.grid.moveInTx(db, { fleetId: intruder, systemId: S.N5, legSeq, at: t0,
        to: { kind: "belt", id: BELT }, purpose: "WORK" }));
      assert.strictEqual(m.ok, true, JSON.stringify(m));
      const at = m.arriveAt;
      env.clock.set(at);
      const ev = { eventType: K.ALERT_EVENT, idempotencyKey: `${K.alertKey(S.N5, intruder, legSeq, 1)}:loc`,
        payload: K.alertPayload({ systemId: S.N5, fleetId: intruder, legSeq, moveSeq: 1, phase: "LOCATE",
          appearAt: at, at }) };
      const read = env.handlers()[K.ALERT_EVENT](ev, {});
      assert.strictEqual(read.outcome, "PURSUE", JSON.stringify(read));
      assert.deepStrictEqual(env.tx((db) => read.effect(db, ev)), { ok: true, moved: 2 });
      const before = env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'FLEET_GRID_ARRIVAL'");
      const replay = env.tx((db) => read.effect(db, ev));
      assert.ok(replay.ok === true && ["IN_WARP", "STALE_VISIT"].includes(replay.refused), JSON.stringify(replay));
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
        + "'FLEET_GRID_ARRIVAL'"), before);
      assert.strictEqual(env.handlers()[K.ALERT_EVENT](ev, {}).outcome, "BUSY");
      const pursuers = ids.filter((id) => env.visit(id) && env.visit(id).purpose === "PURSUIT");
      assert.deepStrictEqual(pursuers.length, 2, "need 4.8 cruisers -> 2 of 3, one holds the CP");
      const [pa, pb] = pursuers.map((id) => env.visit(id));
      assert.strictEqual(pa.arrive_at, pb.arrive_at, "the group warps together");
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
        + "'FLEET_GRID_ARRIVAL' AND idempotency_key LIKE 'grid:%:1'") - 1, 2, "one FLEET_GRID_ARRIVAL per pursuer");

      env.restartAll();
      await env.drive(Number(pa.arrive_at));
      const arrived = env.rows("GRID_DEFENSE_STEP").filter((r) => r.idempotency_key.endsWith(":arr"));
      assert.deepStrictEqual(arrived.map((r) => [r.state, r.outcome]), [["DONE", "CONTACT"], ["DONE", "CONTACT"]]);
      const [p1, p2] = pursuers.sort();
      const f1 = env.fleet(p1);
      env.tx((db) => env.fleets.repository.transition(db, { fleetId: p1, expectedVersion: f1.version, from: f1.state,
        to: "ENGAGED" }, "gd4:engage"));
      const ret1 = (id) => ({ eventType: K.STEP_EVENT, payload: K.stepPayload({ fleetId: id, systemId: S.N5,
        legSeq: env.fleet(id).legSeq, moveSeq: Number(env.visit(id).move_seq), phase: "RETURN", targetFleetId: intruder,
        attempt: 0, round: 1, at: Number(pa.arrive_at) + 60000 }) });
      env.clock.set(Number(pa.arrive_at) + 60000);
      const ev1 = ret1(p1);
      const wait = env.handlers()[K.STEP_EVENT](ev1, {});
      assert.strictEqual(wait.outcome, "WAIT_ENGAGED", JSON.stringify(wait));
      env.tx((db) => wait.effect(db, ev1));
      const retKey = K.stepKey(p1, env.fleet(p1).legSeq, Number(env.visit(p1).move_seq), "ret2");
      assert.ok(env.event(retKey), "ret2 queued");
      const fe = env.fleet(p1);
      env.tx((db) => env.fleets.repository.transition(db, { fleetId: p1, expectedVersion: fe.version, from: "ENGAGED",
        to: "IDLE" }, "gd4:idle"));
      await env.drive(Number(pa.arrive_at) + 60000);
      const r1 = env.rows("GRID_DEFENSE_STEP").filter((r) => r.idempotency_key.endsWith(":ret1"));
      assert.deepStrictEqual(r1.map((r) => r.outcome).sort(), ["RETURN", "STALE"], JSON.stringify(r1));
      for (const id of [p1, p2]) assert.strictEqual(env.visit(id).purpose, "RETURN", id);
      const returns = env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'FLEET_GRID_ARRIVAL'"
        + " AND idempotency_key IN (?, ?)", `grid:${p1}:${env.fleet(p1).legSeq}:2`,
      `grid:${p2}:${env.fleet(p2).legSeq}:2`);
      assert.strictEqual(returns, 2, "one RETURN move per member");
      await env.drive(env.clock.now() + 120000);
      const ret2 = env.event(retKey);
      assert.deepStrictEqual([ret2.state, ret2.outcome], ["DONE", "STALE"], "ret2 after the group return");
      assert.strictEqual(env.defense().getStatus().counters.returns, 2);
    } finally {
      env.close();
    }
  });

  needsDriver("GDF5 grid flag off: drain mode, no listener / override, queued rows STALE, no defense visits",
    async () => {
    const env = createScene(driver, { ...ON, "grid.defense.enabled": false });
    try {
      const st = env.defense().getStatus();
      assert.deepStrictEqual([st.mode, st.reason, st.listeners], ["drain", "FLAG_OFF", 0]);
      const o = env.fleets.grid.addWorkTargetOverride(() => null);
      assert.strictEqual(o.ok, true, "the override slot is free");
      o.remove();
      const t = env.clock.now();
      const a = env.scheduler.enqueue(K.ALERT_EVENT, S.N5, t, K.alertPayload({ systemId: S.N5, fleetId: "x",
        legSeq: 0, moveSeq: 0, phase: "SEEN", appearAt: t, at: t }), K.alertKey(S.N5, "x", 0, 0));
      const s = env.scheduler.enqueue(K.STEP_EVENT, "x", t, K.stepPayload({ fleetId: "x", systemId: S.N5, legSeq: 0,
        moveSeq: 0, phase: "POST", targetFleetId: null, at: t }), K.stepKey("x", 0, 0, "post"));
      assert.ok(a.ok && s.ok, JSON.stringify([a, s]));
      const g = env.fleetOf("g", SANSHA, "garrison", big(3), S.N0);
      const intruder = env.fleetOf("i", GURISTAS, "hunter", big(2), S.N5);
      const trip = env.trip(g, SANSHA, S.N0, S.N5, "patrol", "patrol", "g");
      await env.drive(trip.arriveAt + 3600000);
      assert.deepStrictEqual([...env.rows(K.ALERT_EVENT), ...env.rows(K.STEP_EVENT)].map((r) => [r.state, r.outcome]),
        [["DONE", "STALE"], ["DONE", "STALE"]], "only the two hand rows, both drained");
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_fleet_grid_visits WHERE purpose IN ('POST', 'PURSUIT', "
        + "'RETURN')"), 0);
      assert.strictEqual(env.visit(g).purpose, "WORK", "no override: the work move of the rule");
      assert.ok(intruder);
      assert.strictEqual(env.defense().getStatus().counters.drained, 2);
    } finally {
      env.close();
    }
  });

  needsDriver("GDF8 grid: two PURSUIT visits in the window -> BUSY; past the window -> no pursuit "
    + "their defenders are candidates (PURSUE)", async () => {
    const env = createScene(driver, { ...ON, "battle.gridContacts.enabled": false });
    try {
      const [a, b] = ["a", "b", "c"].map((t) => env.fleetOf(t, SANSHA, "garrison", big(3)));
      const [i1, i2, i3] = ["i1", "i2", "i3"].map((t) => env.fleetOf(t, GURISTAS, "patrol", big(1)));
      const t0 = env.clock.now();
      const move = (fleetId, to, purpose, targetFleetId) => {
        const { legSeq: leg } = env.fleet(fleetId);
        const r = env.tx((db) => env.fleets.grid.moveInTx(db, { fleetId, systemId: S.N5, legSeq: leg, at: t0, to,
          purpose, targetFleetId }));
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r.arriveAt;
      };
      const arrivals = [move(a, { kind: "belt", id: BELT }, "PURSUIT", i1), move(b, { kind: "gate", id: GATE_N6 },
        "PURSUIT", i2), move(i3, { kind: "gate", id: GATE_N0 }, "WORK", null)];
      const at1 = Math.max(...arrivals);
      const legSeq = env.fleet(i3).legSeq;
      const alertAt = (at) => {
        env.clock.set(at);
        const ev = { eventType: K.ALERT_EVENT, idempotencyKey: `${K.alertKey(S.N5, i3, legSeq, 1)}:loc`,
          payload: K.alertPayload({ systemId: S.N5, fleetId: i3, legSeq, moveSeq: 1, phase: "LOCATE", appearAt: at1,
            at }) };
        return { ev, read: env.handlers()[K.ALERT_EVENT](ev, {}) };
      };
      assert.strictEqual(alertAt(at1).read.outcome, "BUSY", "maxPursuitsPerSystem 2 in the window");
      const window = pursuitWindowMs(env.cfg.grid.defense);
      const { ev, read } = alertAt(at1 + window + 1);
      assert.strictEqual(read.outcome, "PURSUE", JSON.stringify(read));
      const done = env.tx((db) => read.effect(db, ev));
      assert.deepStrictEqual(done, { ok: true, moved: 1 }, JSON.stringify(done));
      const chased = [a, b].filter((id) => env.visit(id).target_fleet_id === i3);
      assert.strictEqual(chased.length, 1, "a leftover pursuer is a candidate again");
      assert.strictEqual(env.visit(chased[0]).purpose, "PURSUIT");
    } finally {
      env.close();
    }
  });

  needsDriver("GDF9 grid: a RETURN grid arrival next to a hostile garrison -> no alert; a POST arrival -> "
    + "the alert", async () => {
    const env = createScene(driver, { ...ON, "battle.gridContacts.enabled": false });
    try {
      env.fleetOf("g", SANSHA, "garrison", big(3));
      const h = env.fleetOf("h", GURISTAS, "garrison", big(3));
      const move = (to, purpose, expectedMoveSeq) => {
        const { legSeq } = env.fleet(h);
        const at = env.clock.now();
        const r = env.tx((db) => env.fleets.grid.moveInTx(db, { fleetId: h, systemId: S.N5, legSeq, at, to, purpose,
          expectedMoveSeq }));
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r.arriveAt;
      };
      await env.drive(move({ kind: "gate", id: GATE_N0 }, "RETURN", 0));
      assert.strictEqual(env.visit(h).purpose, "RETURN");
      assert.deepStrictEqual(env.rows(K.ALERT_EVENT), [], "a defender back on its post: no alert");
      await env.drive(move({ kind: "gate", id: GATE_N6 }, "POST", 1));
      assert.deepStrictEqual(env.rows(K.ALERT_EVENT).map((r) => r.idempotency_key),
        [K.alertKey(S.N5, h, env.fleet(h).legSeq, 2)], "a POST arrival alerts");
    } finally {
      env.close();
    }
  });

  needsDriver("T5 grid garrison eye: a faction sentry (sf-) of the defender in the grid of the intruder -> SEEN "
    + "without LOCATING, seenBySentry 1; a player sentry in the same grid -> LOCATING", async () => {
    let live = [];
    const sentries = { getMode: () => "ready", listLiveInSystem: (sys) => (sys === S.N5 ? live : []) };
    const env = createScene(driver, { ...ON, "battle.gridContacts.enabled": false,
      "sentries.battle.gridEnabled": true }, { defenseDeps: { getSentries: () => sentries } });
    try {
      env.fleetOf("g", SANSHA, "garrison", big(3));
      const h = env.fleetOf("h", GURISTAS, "garrison", big(3));
      const move = (to, expectedMoveSeq) => {
        const { legSeq } = env.fleet(h);
        const at = env.clock.now();
        const r = env.tx((db) => env.fleets.grid.moveInTx(db, { fleetId: h, systemId: S.N5, legSeq, at, to,
          purpose: "POST", expectedMoveSeq }));
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r.arriveAt;
      };
      const sentry = (sentryId, ownerKind, gate) => ({ sentryId, itemId: 7001, ownerKind, typeId: 340501,
        factionId: ownerKind === "faction" ? SANSHA : null, characterId: ownerKind === "faction" ? null : 90000001,
        systemId: S.N5, anchorKind: "gate", anchorId: gate });
      const outcomeOf = async (moveSeq) => {
        const key = K.alertKey(S.N5, h, env.fleet(h).legSeq, moveSeq);
        const row = env.rows(K.ALERT_EVENT).find((r) => r.idempotency_key === key);
        assert.ok(row, JSON.stringify(env.rows(K.ALERT_EVENT)));
        await env.drive(Number(row.due_at));
        return env.rows(K.ALERT_EVENT).find((r) => r.idempotency_key === key).outcome;
      };
      live = [sentry("sf-1", "faction", GATE_N6)];
      await env.drive(move({ kind: "gate", id: GATE_N6 }, 0));
      const seen = await outcomeOf(1);
      assert.ok(seen !== "LOCATING" && seen !== null, String(seen));
      assert.strictEqual(env.defense().getStatus().counters.seenBySentry, 1);
      live = [sentry("sp-7001", "player", GATE_N0)];
      await env.drive(move({ kind: "gate", id: GATE_N0 }, 1));
      assert.strictEqual(await outcomeOf(2), "LOCATING");
      assert.strictEqual(env.defense().getStatus().counters.seenBySentry, 1);
    } finally {
      env.close();
    }
  });

  needsDriver("GDF7 grid facades: REQUIRED on the real facades, start refusals, event types, retention classes "
    + "service registry", async () => {
    const env = createScene(driver, ON);
    try {
      const roots = { fleets: env.fleets, scheduler: env.scheduler, persistence: env.battleDeps.persistence,
        battle: env.battle, hunt: { repository: createPinRepository() } };
      const missing = REQUIRED.filter((p) => {
        const parts = p.split(".");
        if (["world", "stations", "siege"].includes(parts[0])) return false;
        let v = roots[parts[0]];
        for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
        return typeof v !== "function";
      });
      assert.deepStrictEqual(missing, []);
      assert.deepStrictEqual([...SOFT_ROOTS], ["battle", "world", "stations", "siege", "hunt"]);
      assert.ok(REQUIRED.includes("hunt.repository.getActivePinForStrike"));
      const st = env.defense().getStatus();
      assert.deepStrictEqual([st.mode, st.reason, st.listeners], ["on", null, 3]);
      assert.deepStrictEqual(env.fleets.grid.addWorkTargetOverride(() => null), { ok: false,
        reason: "OVERRIDE_TAKEN" });
      const start = (cfg, fleets = env.fleets) => startGridDefense({ config: cfg, persistence:
        env.battleDeps.persistence, scheduler: env.scheduler, fleets });
      const cfg = (over) => {
        const c = JSON.parse(JSON.stringify(env.cfg));
        over(c);
        return c;
      };
      assert.deepStrictEqual(start(cfg((c) => {
        c.modules.strategy.enabled = false;
      })), { ok: false, reason: "disabled_by_config" });
      assert.deepStrictEqual(start(cfg((c) => {
        c.grid.defense.locateMs = 1000;
      })), { ok: false, reason: "INVALID_CONFIG:grid.defense.locateMs" });
      assert.deepStrictEqual(start(cfg((c) => {
        c.grid.defense.roles = "none";
      })), { ok: false, reason: "INVALID_CONFIG:grid.defense.roles" });
      assert.strictEqual(start(cfg((c) => {
        c.persistence.maxRowsPerTransaction = 7;
      })).reason, "GRID_DEFENSE_ROW_BOUND");
      const noGroup = { ...env.fleets, grid: { ...env.fleets.grid, moveGroupInTx: undefined } };
      assert.deepStrictEqual(start(env.cfg, noGroup), { ok: false, reason: "GRID_DEFENSE_FACADE_MISSING",
        detail: "fleets.grid.moveGroupInTx" });
      assert.strictEqual(createUnavailableGridDefense("X").getMode(), "off");
      assert.deepStrictEqual([getEventType(K.ALERT_EVENT).priority, getEventType(K.STEP_EVENT).priority], [3, 3]);
      validateClasses(CLASSES);
      const alert = CLASSES.find((c) => c.id === "grid-defense-alert");
      const stepCls = CLASSES.find((c) => c.id === "grid-defense-step");
      assert.ok(alert.pattern.test(K.alertKey(30000142, "f1", 2, 3)) && alert.pattern.test("gdef:1:f:2:3:loc"));
      assert.ok(["post", "arr", "loc2", "ret6", K.stepTag.sp(3), K.stepTag.strike()].every((t) => stepCls.pattern.test(K.stepKey("f1", 2, 3, t))));
      const names = buildDefaultServiceDefs().map((d) => d.name);
      assert.strictEqual(names.indexOf("gridDefense"), names.indexOf("blockade") + 1);
    } finally {
      env.close();
    }
  });
};

Object.assign(module.exports, { harness: Object.freeze({ createScene, anchor, ON, AU, GATE_N0, GATE_N6, STATION,
  BELT, big }) });
