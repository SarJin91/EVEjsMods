"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { createContactService } = require("../../../lib/battle/contactService");
const { createUnavailableBattle } = require("../../../lib/battle");
const { startBlockade, createUnavailableBlockade, REQUIRED, SOFT_ROOTS } = require("../../../lib/strategy/blockade");
const { haltKeyOf, INTERCEPT_EVENT } = require("../../../lib/strategy/blockade/blockadeService");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const { S, FACTION_A, FACTION_B } = H;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);
const POST_COMP = Object.freeze([{ hullGroup: "cruiser", count: 4 }]);
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const HOUR = 3600000;

function cfgOf(strategy = {}) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    strategy: { ...DEFAULTS.strategy, blockadeEnabled: true, blockadeInterceptChancePermille: 1000, ...strategy } };
}

function bootBlockade(reopen, cfg, travelOf = null) {
  const opened = reopen();
  const shared = H.sharedOf();
  const env = H.boot(opened, shared);
  const handlers = {};
  const scheduler = { ...env.scheduler, registerHandler: (type, fn, o) => {
    handlers[type] = fn;
    return env.scheduler.registerHandler(type, fn, o);
  } };
  const contact = createContactService({ scheduler: env.scheduler, isActive: () => true, bump() {} });
  env.fleets.travel.addArrivalListener(contact.onArrival);
  const lines = [];
  const battle = { readCooldownsInTx: () => ({ ok: true, cooldowns: new Map() }) };
  const started = startBlockade({ config: cfg, persistence: { ok: true, store: env.store, journal: env.journal,
    worldSeed: opened.worldSeed }, scheduler, fleets: travelOf ? { ...env.fleets, travel: travelOf(env.fleets.travel) }
    : env.fleets, logger: { log: (l) => lines.push(l) },
  getBattle: () => battle });
  env.shared = shared;
  env.handlers = handlers;
  env.started = started;
  env.lines = lines;
  env.events = (type) => env.tx((db) => db.prepare("SELECT idempotency_key, aggregate_id, due_at, payload, state "
    + "FROM world_scheduled_events WHERE event_type = ? ORDER BY due_at, idempotency_key").all(type))
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  env.fleet = (id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
  return env;
}

function post(env, tag, systemId, dueAt) {
  const fleetId = H.newFleet(env, tag, FACTION_B, POST_COMP);
  const op = env.fleets.createOperation({ operationType: "blockade", factionId: FACTION_B, originSystemId: S.N0,
    targetSystemId: systemId, objective: "hold", dueAt, fleets: [{ fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const f = env.fleet(fleetId);
  const moved = env.tx((db) => env.fleets.repository.transition(db, { fleetId, expectedVersion: f.version,
    from: "PLANNED", to: "STAGED", patch: { currentSystemId: systemId } }, `${tag}:staged`));
  assert.ok(moved.ok, JSON.stringify(moved));
  return { fleetId, operationId: op.operationId };
}

function mover(env, tag, type = "invasion", objective = "capture", dueAt = H.START_MS + HOUR) {
  const fleetId = H.newFleet(env, tag, FACTION_A, COMP);
  const op = env.fleets.createOperation({ operationType: type, factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.N9, objective, dueAt, fleets: [{ fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const plan = env.fleets.planTravel({ fleetId, targetSystemId: S.N9, constraints: AVOID }, `${tag}:plan`);
  assert.ok(plan.ok, JSON.stringify(plan));
  return { fleetId, operationId: op.operationId, plan };
}

const evOf = (row) => ({ eventType: "BLOCKADE_INTERCEPT", idempotencyKey: row.idempotency_key, payload: row.payload,
  dueAt: row.due_at, aggregateId: row.aggregate_id });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const t = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  t("BLK3 blockade: departure -> one BLOCKADE_INTERCEPT; INTERCEPT -> STAGED in the blockade system + contact check; "
    + "replay = duplicate, one stop per crossing", () => H.withStore(driver, (reopen) => {
    const env = bootBlockade(reopen, cfgOf());
    assert.ok(env.started.ok, JSON.stringify(env.started));
    const b = post(env, "post", S.N6, H.START_MS + 2 * HOUR);
    const m = mover(env, "inv");
    const at = m.plan.departAt + 2 * m.plan.jumpMs;
    const key = `blockade:${b.operationId}:x:${m.fleetId}:${m.plan.legSeq}`;
    const rows = env.events("BLOCKADE_INTERCEPT");
    assert.deepStrictEqual(rows.map((r) => [r.idempotency_key, r.aggregate_id, r.due_at, r.state]),
      [[key, b.operationId, at, "QUEUED"]]);
    assert.deepStrictEqual(rows[0].payload, { operationId: b.operationId, fleetId: m.fleetId, legSeq: m.plan.legSeq,
      systemIndex: 2, at });
    assert.strictEqual(env.started.blockade.getStatus().counters.crossingsQueued, 1);

    env.shared.clock.set(at);
    const ev = evOf(rows[0]);
    const res = env.handlers[INTERCEPT_EVENT](ev, {});
    assert.deepStrictEqual([res.ok, res.outcome], [true, "INTERCEPT"], JSON.stringify(res));
    const v = env.tx((db) => res.effect(db, ev));
    assert.deepStrictEqual({ ok: v.ok, applied: v.applied, action: v.action, systemId: v.systemId },
      { ok: true, applied: true, action: "INTERCEPT", systemId: S.N6 });
    res.onCommitted(v);
    const stopped = env.fleet(m.fleetId);
    assert.deepStrictEqual([stopped.state, stopped.currentSystemId, stopped.legSeq], ["STAGED", S.N6,
      m.plan.legSeq]);
    const contact = env.events("BATTLE_CONTACT_CHECK");
    assert.deepStrictEqual(contact.map((r) => [r.idempotency_key, r.due_at]),
      [[`contact:${S.N6}:arr:${m.fleetId}:${m.plan.legSeq}`, at]]);
    assert.deepStrictEqual(contact[0].payload, { systemId: S.N6, at, triggerFleetId: m.fleetId });
    const hit = env.tx((db) => env.journal.findByKey(db, `${key}:hit`));
    assert.deepStrictEqual([hit.found, hit.entry.aggregateType, hit.entry.aggregateId], [true, "blockade",
      b.operationId]);
    assert.ok(`${key}:hit:halt`.length > 64, String(`${key}:hit:halt`.length));
    const halt = env.tx((db) => env.journal.findByKey(db, haltKeyOf(`${key}:hit`)));
    assert.deepStrictEqual([halt.found, halt.entry.aggregateType, halt.entry.aggregateId], [true, "fleet",
      m.fleetId]);

    const again = env.tx((db) => res.effect(db, ev));
    assert.deepStrictEqual({ applied: again.applied, action: again.action }, { applied: false, action: "DUPLICATE" });
    assert.strictEqual(env.fleet(m.fleetId).version, stopped.version);
    const res2 = env.handlers[INTERCEPT_EVENT](ev, {});
    assert.deepStrictEqual([res2.ok, res2.outcome, res2.effect], [true, "STALE", undefined]);
    res2.onCommitted();
    const second = env.tx((db) => env.fleets.travel.interceptInTx(db, { fleetId: m.fleetId,
      expectedVersion: stopped.version, legSeq: m.plan.legSeq, systemIndex: 2, at }, "lowsec:ambush:c:v:hit:halt"));
    assert.strictEqual(second.reason, "STALE_LEG");
    const st = env.started.blockade.getStatus();
    assert.deepStrictEqual([st.counters.intercepts, st.counters.stale, st.staleByReason.LEG_MOVED], [1, 1, 1]);
    assert.ok(env.lines.some((l) => l.startsWith(`blockade: operation ${b.operationId} intercepted fleet`)),
      env.lines.join("\n"));
    env.started.blockade.stop();
  }));

  t("BLK4 blockade activation scan: fleets in flight before the blockade; fleetIds limit the scan; mining in, recon "
    + "out", () => H.withStore(driver, (reopen) => {
    const env = bootBlockade(reopen, cfgOf());
    assert.ok(env.started.ok, JSON.stringify(env.started));
    const inv = mover(env, "inv");
    const mine = mover(env, "mine", "mining", "mine", null);
    mover(env, "rec", "recon", "scout");
    assert.deepStrictEqual(env.events("BLOCKADE_INTERCEPT"), [], "no blockade yet -> no event at departure");
    const dueAt = H.START_MS + 2 * HOUR;
    const b = post(env, "post", S.N6, dueAt);
    const reg = (spec) => env.tx((db) => env.started.blockade.registerBlockadeInTx(db, spec));
    const base = { operationId: b.operationId, systemId: S.N6, factionId: FACTION_B, dueAt,
      at: env.shared.clock.now() };
    assert.deepStrictEqual(reg({ ...base, fleetIds: [inv.fleetId] }), { ok: true, queued: 1, truncated: false,
      refused: 0 });
    assert.deepStrictEqual(env.events("BLOCKADE_INTERCEPT").map((r) => r.payload.fleetId), [inv.fleetId]);
    assert.deepStrictEqual(reg(base), { ok: true, queued: 1, truncated: false, refused: 0 },
      "inv duplicate, mining new, recon out");
    const rows = env.events("BLOCKADE_INTERCEPT");
    assert.deepStrictEqual(rows.map((r) => r.payload.fleetId).sort(), [inv.fleetId, mine.fleetId].sort());
    const x = rows.find((r) => r.payload.fleetId === mine.fleetId);
    assert.deepStrictEqual(x.payload, { operationId: b.operationId, fleetId: mine.fleetId,
      legSeq: mine.plan.legSeq, systemIndex: 2, at: mine.plan.departAt + 2 * mine.plan.jumpMs });
    assert.deepStrictEqual(reg({ ...base, operationId: "op-short", dueAt: base.at + 1 }), { ok: true, queued: 0,
      truncated: false, refused: 0 });
    assert.strictEqual(env.started.blockade.getStatus().counters.crossingsQueued, 0, "no count before countScan");
    assert.deepStrictEqual(reg({ ...base, systemId: 0 }), { ok: false, reason: "BLOCKADE_INVALID_INPUT" });
    assert.deepStrictEqual(reg({ ...base, extra: 1 }), { ok: false, reason: "BLOCKADE_INVALID_INPUT" });
    const counters = () => env.started.blockade.getStatus().counters;
    const pick = (c) => [c.crossingsQueued, c.enqueueRefused, c.activationScanTruncated];
    const before = pick(counters());
    env.started.blockade.countScan({ ok: true, queued: 2, truncated: true, refused: 3 });
    assert.deepStrictEqual(pick(counters()), [before[0] + 2, before[1] + 3, before[2] + 1]);
    env.started.blockade.countScan({ ok: false, reason: "X", queued: 5, refused: 5, truncated: true });
    env.started.blockade.countScan(null);
    assert.deepStrictEqual(pick(counters()), [before[0] + 2, before[1] + 3, before[2] + 1]);
    env.started.blockade.stop();
  }));

  t("BLK5 blockade facades: REQUIRED paths on the real facades; flag off -> no listener, no event; stop() removes "
    + "the listener", () => H.withStore(driver, (reopen) => {
    const env = bootBlockade(reopen, cfgOf({ blockadeEnabled: false }));
    assert.deepStrictEqual(env.started, { ok: false, reason: "disabled_by_config" });
    const roots = { fleets: env.fleets, scheduler: env.scheduler, persistence: { store: env.store,
      journal: env.journal }, battle: createUnavailableBattle("test") };
    const missing = REQUIRED.filter((p) => {
      const parts = p.split(".");
      let v = roots[parts[0]];
      for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
      return typeof v !== "function";
    });
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual([...SOFT_ROOTS], ["battle"]);
    const off = createUnavailableBlockade("BLOCKADE_DISABLED");
    assert.deepStrictEqual([off.getMode(), off.registerBlockadeInTx().reason], ["off", "BLOCKADE_UNAVAILABLE"]);
    post(env, "post", S.N6, H.START_MS + 2 * HOUR);
    mover(env, "inv");
    assert.deepStrictEqual(env.events("BLOCKADE_INTERCEPT"), []);

    const on = startBlockade({ config: cfgOf(), persistence: { ok: true, store: env.store, journal: env.journal,
      worldSeed: 1 }, scheduler: env.scheduler, fleets: env.fleets });
    assert.ok(on.ok, JSON.stringify(on));
    on.blockade.stop();
    mover(env, "inv2");
    assert.deepStrictEqual(env.events("BLOCKADE_INTERCEPT"), []);
    assert.strictEqual(on.blockade.registerBlockadeInTx({ inTransaction: true }, {}).reason, "BLOCKADE_STOPPED");
  }));

  test("BLK6: blockadeEnabled adds blockadeMaxCrossingsPerLeg per travel plan to the review / reactive "
    + "bounds and the resolveConfig warnings; flag off = unchanged", () => {
    const R = require("../../../lib/strategy/reviewRows");
    const c = DEFAULTS;
    const F = c.strategy.maxFleetsPerOperation;
    const relief = { maxReliefPerReview: c.siege.maxReliefPerReview };
    const defense = { maxDefensePerReview: c.strategy.maxDefensePerReview };
    const rest = [c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, relief,
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview }, defense];
    const s = (enabled, k) => ({ ...c.strategy, blockadeEnabled: enabled, blockadeMaxCrossingsPerLeg: k });
    const plans = c.strategy.maxOperationsPerReview * F + c.strategy.maxReturnsPerReview
      + c.mining.maxDispatchesPerReview + c.logistics.maxDispatchesPerReview
      + (c.siege.maxReliefPerReview + c.strategy.maxDefensePerReview) * F;
    assert.strictEqual(c.strategy.blockadeEnabled, false);
    const off = R.reviewRowBound(c.strategy, ...rest);
    assert.strictEqual(off, 976, "flag off (default): the bound before");
    assert.strictEqual(R.reviewRowBound(s(false, 8), ...rest), off, "flag off: K is not counted");
    const got = [2, 8].map((k) => R.reviewRowBound(s(true, k), ...rest) - off);
    assert.deepStrictEqual(got, [2 * plans, 8 * plans]);
    const rOff = R.reactiveRowBound(s(false, 2), relief, defense, 12);
    assert.strictEqual(rOff, R.reactiveRowBound(c.strategy, relief, defense, 12));
    assert.strictEqual(R.reactiveRowBound(s(true, 2), relief, defense, 12) - rOff,
      2 * F * (relief.maxReliefPerReview + defense.maxDefensePerReview));
    assert.deepStrictEqual([R.reliefRows(F, 0), R.reliefRows(F, 3) - R.reliefRows(F)], [R.reliefRows(F), 3 * F]);
    assert.deepStrictEqual([R.blockadeRowsOf(s(false, 5)), R.blockadeRowsOf(s(true, 5)), R.blockadeRowsOf(null)],
      [0, 5, 0]);

    const ON = { EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED: "1", EVEJS_LNE_STRATEGY_BLOCKADE_MAX_CROSSINGS_PER_LEG: "2" };
    const warn = (maxRows, on, prefix) => config.resolveConfig({ modDir: MOD_DIR, env: {
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: String(maxRows), ...(on ? ON : {}) } }).warnings
      .filter((w) => w.startsWith(prefix));
    const reactiveOff = R.reactiveRowBound(c.strategy, relief, defense, 3 * c.strategy.reactivePruneBatch);
    const { convoyStepRows } = require("../../../lib/economy/schema");
    const mining = R.MINING_DISPATCH_ROWS + c.mining.pruneBatch;
    const convoy = Math.max(convoyStepRows(c.logistics.maxCargoItems),
      R.CONVOY_DISPATCH_BASE_ROWS + c.logistics.maxCargoItems + c.logistics.pruneBatch);
    const rowsAt1 = (prefix) => Number(warn(1, false, prefix)[0].slice(prefix.length).trim().split(" ")[0]);
    const cases = [["one strategy review may write", 2 * plans],
      ["one faction of a reactive sweep may write", 2 * F * (relief.maxReliefPerReview + defense.maxDefensePerReview)],
      ["one mining dispatch may write", 2], ["one convoy step may write", 2]];
    const offRows = cases.map(([prefix]) => rowsAt1(prefix));
    assert.deepStrictEqual(offRows.slice(1), [reactiveOff, mining, convoy]);
    const seen = cases.map(([prefix, delta], i) => [warn(offRows[i], false, prefix).length,
      warn(offRows[i], true, prefix).map((w) => w.startsWith(`${prefix} ${offRows[i] + delta} rows`))]);
    assert.deepStrictEqual(seen, [[0, [true]], [0, [true]], [0, [true]], [0, [true]]]);
  });

  test("BLK8 (R1, R2): border posts add 0 rows at the defaults (1064 with the blockade, on = off), the "
    + "excess of a big scan page, the mining LOAD warning with K, startBlockade BLOCKADE_ROW_BOUND at 1000 and a start "
    + "at 1100", async () => {
    const R = require("../../../lib/strategy/reviewRows");
    const { rowBoundsOfConfig } = require("../../../lib/strategy/reviewBound");
    const { ROWS_PER_LOAD } = require("../../../lib/economy/schema");
    const ON = { EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED: "1" };
    const cfg = (env) => config.resolveConfig({ modDir: MOD_DIR, env }).config;
    const review = (env) => rowBoundsOfConfig(cfg(env)).review;
    const posts = { ...ON, EVEJS_LNE_STRATEGY_BORDER_POSTS_ENABLED: "1" };
    assert.deepStrictEqual([review({}), review(ON), review(posts)], [998, 1066, 1066]);
    assert.strictEqual(R.borderPostRows(2, 32), 44);
    const st = DEFAULTS.strategy;
    const F = st.maxFleetsPerOperation;
    const launch = 1 + 2 + 2 * F + (3 + 2) * F + 2 + 12;
    const big = { ...posts, EVEJS_LNE_STRATEGY_BORDER_POST_SCAN_MAX_FLEETS: "256" };
    assert.strictEqual(review(big) - review(ON), Math.min(st.borderPostsMaxPerReview, st.maxOperationsPerReview)
      * (R.borderPostRows(2, 256) - launch));
    assert.strictEqual(review({ ...big, EVEJS_LNE_STRATEGY_BORDER_POSTS_ENABLED: "0" }), 1066, "posts off: no term");
    const load = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { ...env,
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: String(ROWS_PER_LOAD) } }).warnings
      .filter((w) => w.startsWith("one mining LOAD step may write"));
    assert.deepStrictEqual([load({}).length, load(ON).map((w) => w.split(" rows")[0])],
      [0, [`one mining LOAD step may write ${ROWS_PER_LOAD + 2}`]]);
    const at1000 = startBlockade({ config: cfg(ON) });
    assert.deepStrictEqual(at1000, { ok: false, reason: "BLOCKADE_ROW_BOUND",
      detail: "review=1066 > persistence.maxRowsPerTransaction=1000" });
    const c1100 = cfg({ ...ON, EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "1100" });
    assert.strictEqual(startBlockade({ config: c1100 }).reason, "dependency_disabled:persistence");
    if (driver.ok) {
      await H.withStore(driver, (reopen) => {
        const env = bootBlockade(reopen, c1100);
        assert.ok(env.started.ok, JSON.stringify(env.started));
        env.started.blockade.stop();
      });
    }
  });

  t("BLK7: interceptInTx FLEET_INVALID_INPUT -> permanent refusal: BLOCKADE_INTERCEPT QUARANTINED "
    + "after one attempt, nothing written", () => H.withStore(driver, async (reopen) => {
    const travelOf = (tr) => ({ ...tr, interceptInTx: () => ({ ok: false, reason: "FLEET_INVALID_INPUT",
      detail: "idempotencyKey" }) });
    const env = bootBlockade(reopen, cfgOf(), travelOf);
    assert.ok(env.started.ok, JSON.stringify(env.started));
    const b = post(env, "post", S.N6, H.START_MS + 2 * HOUR);
    const m = mover(env, "inv");
    const at = m.plan.departAt + 2 * m.plan.jumpMs;
    const key = `blockade:${b.operationId}:x:${m.fleetId}:${m.plan.legSeq}`;
    env.shared.clock.set(at);
    const pass = await env.scheduler.runPass();
    assert.ok(pass.ok, JSON.stringify(pass));
    const rows = env.tx((db) => db.prepare("SELECT state, attempts, last_error FROM world_scheduled_events "
      + "WHERE event_type = ?").all(INTERCEPT_EVENT)).map((r) => [r.state, r.attempts, r.last_error]);
    assert.deepStrictEqual(rows.map((r) => [r[0], r[1]]), [["QUARANTINED", 1]], JSON.stringify(rows));
    assert.ok(String(rows[0][2]).includes("FLEET_INVALID_INPUT"), JSON.stringify(rows));
    assert.strictEqual(env.fleet(m.fleetId).state, "TRAVELLING");
    assert.strictEqual(env.tx((db) => env.journal.findByKey(db, `${key}:hit`)).found, false);
    env.started.blockade.stop();
  }));
};
