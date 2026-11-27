"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { arrivalKey } = require("../../lib/fleets/travelService");
const { startPlayerHunt } = require("../../lib/playerHunt");
const { membersOf } = require("../../lib/playerHunt/huntRepository");
const { createJournal } = require("../../lib/persistence/journal");
const { resolveConfig } = require("../../config");
const { returnKey, homeKey, approachChainIdOf, approachKey, MAX_HUNT_ID_LENGTH }
  = require("../../lib/playerHunt/schema");
const { JOURNAL_MAX_KEY_LENGTH } = require("../../lib/persistence/migrations");

const { S, FACTION_A } = H;
const MOD_DIR = path.resolve(__dirname, "..", "..");
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const CHAR = 90000001;
const CONSTRAINTS = Object.freeze({ maxJumps: 1, avoidSecClasses: ["highsec"] });

function huntFacade(env, opened, shared) {
  const config = JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  config.enabled = true;
  config.modules = { ...config.modules, fleets: { ...(config.modules && config.modules.fleets), enabled: true } };
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const r = startPlayerHunt({ config, persistence: { ok: true, store: opened.store, journal,
    worldSeed: opened.worldSeed }, clock: shared.clock, getFleets: () => env.fleets });
  assert.ok(r.ok, JSON.stringify(r));
  return r.playerHunt;
}

function liveHunt(env, ph, shared, tag, lose) {
  const fleetId = H.newFleet(env, tag, FACTION_A, COMP);
  const now = shared.clock.now();
  const c = env.tx((db) => ph.claimInTx(db, { fleetId, expectedVersion: 1, characterId: CHAR, systemId: S.N0,
    mode: "SWEEP", standing: -6, at: now }));
  assert.ok(c.ok && !c.duplicate, JSON.stringify(c));
  const l = env.tx((db) => ph.markLiveInTx(db, { huntId: c.huntId, expectedVersion: c.version, at: now }));
  assert.ok(l.ok, JSON.stringify(l));
  if (lose) {
    const memberKey = membersOf(fleetId, COMP)[0].memberKey;
    assert.ok(env.tx((db) => ph.markDestroyedInTx(db, { huntId: c.huntId, memberKey })).ok);
  }
  return { fleetId, huntId: c.huntId };
}

const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
const huntOf = (env, ph, id) => env.tx((db) => ph.readInTx(db, id)).hunt;
const opsOf = (env, fleetId) => env.tx((db) => db.prepare("SELECT operation_type, objective, due_at, state FROM "
  + "world_operations WHERE fleet_ids LIKE ? ORDER BY planned_at, operation_id").all(`%${fleetId}%`));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PU2 pursueInTx: ENDED/PURSUIT + operation pursuit/destroy dueAt=at + TRAVELLING + one "
    + "FLEET_ARRIVAL, losses applied; replay ALREADY_ENDED; UNREACHABLE rolls back; pursueNextInTx IDLE -> TRAVELLING",
  () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const env = H.boot(opened, shared);
    const ph = huntFacade(env, opened, shared);

    const a = liveHunt(env, ph, shared, "pu2a", true);
    shared.clock.advance(1000);
    const at = shared.clock.now();
    const req = { huntId: a.huntId, at, targetSystemId: S.N5, constraints: CONSTRAINTS };
    const r = env.tx((db) => ph.pursueInTx(db, req));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual([r.fleetId, r.jumps, r.losses.reduce((n, g) => n + g.count, 0)], [a.fleetId, 1, 1]);
    const hunt = huntOf(env, ph, a.huntId);
    assert.deepStrictEqual([hunt.state, hunt.endReason], ["ENDED", "PURSUIT"]);
    const f = fleetOf(env, a.fleetId);
    assert.deepStrictEqual([f.state, f.operationId, f.targetSystemId, f.shipCount, f.version],
      ["TRAVELLING", r.operationId, S.N5, 1, r.fleetVersion]);
    assert.deepStrictEqual(opsOf(env, a.fleetId), [{ operation_type: "pursuit", objective: "destroy", due_at: at,
      state: "ACTIVE" }]);
    const arrival = H.eventOf(env, arrivalKey(a.fleetId, f.legSeq));
    assert.deepStrictEqual(arrival, { state: "QUEUED", due_at: r.arriveAt });
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'FLEET_ARRIVAL' "
      + "AND aggregate_id = ?", a.fleetId), 1);

    const journalBefore = H.n(env, "SELECT count(*) AS n FROM world_event_journal");
    assert.strictEqual(env.tx((db) => ph.pursueInTx(db, req)).reason, "ALREADY_ENDED");
    assert.strictEqual(opsOf(env, a.fleetId).length, 1);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal"), journalBefore);

    const b = liveHunt(env, ph, shared, "pu2b", false);
    const bad = env.tx((db) => ph.pursueInTx(db, { huntId: b.huntId, at: shared.clock.now(), targetSystemId: S.ISO,
      constraints: CONSTRAINTS }));
    assert.deepStrictEqual([bad.ok, bad.reason], [false, "UNREACHABLE"]);
    assert.strictEqual(huntOf(env, ph, b.huntId).state, "LIVE");
    assert.strictEqual(fleetOf(env, b.fleetId).state, "MATERIALIZED");
    assert.deepStrictEqual(opsOf(env, b.fleetId), []);

    shared.clock.set(r.arriveAt + 1);
    for (let i = 0; i < 8; i += 1) {
      const p = await env.scheduler.runPass();
      assert.ok(p.ok, JSON.stringify(p));
      if (p.jobs === 0) break;
    }
    const idle = fleetOf(env, a.fleetId);
    assert.deepStrictEqual([idle.state, idle.currentSystemId, idle.operationId], ["IDLE", S.N5, null]);

    const next = { chainId: a.huntId, hop: 2, fleetId: a.fleetId, expectedVersion: idle.version, fromSystemId: S.N5,
      targetSystemId: S.N6, at: shared.clock.now(), constraints: CONSTRAINTS };
    assert.strictEqual(env.tx((db) => ph.pursueNextInTx(db, { ...next, expectedVersion: idle.version + 1 })).reason,
      "VERSION_CONFLICT");
    assert.strictEqual(opsOf(env, a.fleetId).length, 1);
    const n2 = env.tx((db) => ph.pursueNextInTx(db, next));
    assert.strictEqual(n2.ok, true, JSON.stringify(n2));
    const f2 = fleetOf(env, a.fleetId);
    assert.deepStrictEqual([f2.state, f2.operationId, f2.targetSystemId], ["TRAVELLING", n2.operationId, S.N6]);
    assert.deepStrictEqual(opsOf(env, a.fleetId).map((o) => [o.operation_type, o.state]),
      [["pursuit", "COMPLETED"], ["pursuit", "ACTIVE"]]);
    ph.stop();
  }));

  needsDriver("PX2 endWithReturnInTx: ENDED/RETREATED + operation return/return dueAt=at + TRAVELLING + one "
    + "FLEET_ARRIVAL, the loss applied; replay ALREADY_ENDED (no new journal row); UNREACHABLE rolls back; the longest "
    + "huntId fits the journal key", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const env = H.boot(opened, shared);
    const ph = huntFacade(env, opened, shared);
    const RET = { maxJumps: 10 };

    const a = liveHunt(env, ph, shared, "px2a", true);
    shared.clock.advance(1000);
    const at = shared.clock.now();
    const req = { huntId: a.huntId, at, reason: "RETREATED", targetSystemId: S.N5, constraints: RET };
    const r = env.tx((db) => ph.endWithReturnInTx(db, req));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual([r.fleetId, r.losses.reduce((n, g) => n + g.count, 0)], [a.fleetId, 1]);
    const hunt = huntOf(env, ph, a.huntId);
    assert.deepStrictEqual([hunt.state, hunt.endReason], ["ENDED", "RETREATED"]);
    const f = fleetOf(env, a.fleetId);
    assert.deepStrictEqual([f.state, f.operationId, f.targetSystemId, f.shipCount], ["TRAVELLING", r.operationId,
      S.N5, 1]);
    assert.deepStrictEqual(opsOf(env, a.fleetId), [{ operation_type: "return", objective: "return", due_at: at,
      state: "ACTIVE" }]);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'FLEET_ARRIVAL' "
      + "AND aggregate_id = ?", a.fleetId), 1);

    const journalBefore = H.n(env, "SELECT count(*) AS n FROM world_event_journal");
    assert.strictEqual(env.tx((db) => ph.endWithReturnInTx(db, req)).reason, "ALREADY_ENDED");
    assert.strictEqual(opsOf(env, a.fleetId).length, 1);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal"), journalBefore);
    assert.strictEqual(env.tx((db) => ph.endWithReturnInTx(db, { ...req, reason: "PURSUIT" })).reason,
      "PLAYER_HUNT_INVALID_INPUT");

    const b = liveHunt(env, ph, shared, "px2b", false);
    const bad = env.tx((db) => ph.endWithReturnInTx(db, { huntId: b.huntId, at: shared.clock.now(),
      reason: "RETREATED", targetSystemId: S.ISO, constraints: RET }));
    assert.deepStrictEqual([bad.ok, bad.reason], [false, "UNREACHABLE"]);
    assert.strictEqual(huntOf(env, ph, b.huntId).state, "LIVE");
    assert.strictEqual(fleetOf(env, b.fleetId).state, "MATERIALIZED");
    assert.deepStrictEqual(opsOf(env, b.fleetId), []);

    const longest = `${returnKey("h".repeat(MAX_HUNT_ID_LENGTH))}:op:fleet:${"f".repeat(64)}`;
    assert.ok(longest.length <= JOURNAL_MAX_KEY_LENGTH, `${longest.length}`);
    const maxKey = H.n(env, "SELECT max(length(idempotency_key)) AS n FROM world_event_journal WHERE "
      + "idempotency_key LIKE 'phunt:%:return%'");
    assert.ok(maxKey > 0 && maxKey <= JOURNAL_MAX_KEY_LENGTH, `${maxKey}`);
    ph.stop();
  }));

  needsDriver("PC2 returnHomeInTx: IDLE fleet -> operation return/return dueAt=at + TRAVELLING + one "
    + "FLEET_ARRIVAL; replay FLEET_NOT_IDLE (one operation); UNREACHABLE rolls back (IDLE, no operation, no journal "
    + "row); the arrival + completion -> IDLE at home; the longest key fits",
  () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const env = H.boot(opened, shared);
    const ph = huntFacade(env, opened, shared);
    const RET = { maxJumps: 10 };

    const fleetId = H.newFleet(env, "pc2a", FACTION_A, COMP);
    const idle = fleetOf(env, fleetId);
    shared.clock.advance(1000);
    const at = shared.clock.now();
    const req = { chainId: "ph:chain-pc2", fleetId, expectedVersion: idle.version, fromSystemId: S.N0,
      targetSystemId: S.N5, at, constraints: RET };
    const r = env.tx((db) => ph.returnHomeInTx(db, req));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const f = fleetOf(env, fleetId);
    assert.deepStrictEqual([f.state, f.operationId, f.targetSystemId, f.version], ["TRAVELLING", r.operationId,
      S.N5, r.fleetVersion]);
    assert.deepStrictEqual(opsOf(env, fleetId), [{ operation_type: "return", objective: "return", due_at: at,
      state: "ACTIVE" }]);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'FLEET_ARRIVAL' "
      + "AND aggregate_id = ?", fleetId), 1);
    assert.strictEqual(env.tx((db) => ph.returnHomeInTx(db, req)).reason, "FLEET_NOT_IDLE");
    assert.strictEqual(opsOf(env, fleetId).length, 1);

    const b = H.newFleet(env, "pc2b", FACTION_A, COMP);
    const bVersion = fleetOf(env, b).version;
    const journalBefore = H.n(env, "SELECT count(*) AS n FROM world_event_journal");
    const bad = env.tx((db) => ph.returnHomeInTx(db, { ...req, chainId: "ph:chain-pc2b", fleetId: b,
      expectedVersion: bVersion, targetSystemId: S.ISO }));
    assert.deepStrictEqual([bad.ok, bad.reason], [false, "UNREACHABLE"]);
    const fb = fleetOf(env, b);
    assert.deepStrictEqual([fb.state, fb.operationId], ["IDLE", null]);
    assert.deepStrictEqual(opsOf(env, b), []);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal"), journalBefore);

    shared.clock.set(r.arriveAt + 1);
    for (let i = 0; i < 8; i += 1) {
      const p = await env.scheduler.runPass();
      assert.ok(p.ok, JSON.stringify(p));
      if (p.jobs === 0) break;
    }
    const home = fleetOf(env, fleetId);
    assert.deepStrictEqual([home.state, home.currentSystemId, home.operationId], ["IDLE", S.N5, null]);

    const longest = `${homeKey("h".repeat(MAX_HUNT_ID_LENGTH))}:op:fleet:${"f".repeat(64)}`;
    assert.ok(longest.length <= JOURNAL_MAX_KEY_LENGTH, `${longest.length}`);
    ph.stop();
  }));

  needsDriver("AP2 approachInTx: IDLE fleet -> operation pursuit/destroy dueAt=at + TRAVELLING, journal keys "
    + "phunt:apr:<id>:<v>:approach:op / :plan; replay FLEET_NOT_IDLE (one operation); TOO_FAR rolls back (IDLE, no "
    + "operation, no journal row)", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const env = H.boot(opened, shared);
    const ph = huntFacade(env, opened, shared);

    const fleetId = H.newFleet(env, "ap2a", FACTION_A, COMP);
    const idle = fleetOf(env, fleetId);
    shared.clock.advance(1000);
    const at = shared.clock.now();
    const chainId = approachChainIdOf(fleetId, idle.version);
    const req = { chainId, fleetId, expectedVersion: idle.version, fromSystemId: S.N0, targetSystemId: S.N5, at,
      constraints: CONSTRAINTS };
    const r = env.tx((db) => ph.approachInTx(db, req));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const f = fleetOf(env, fleetId);
    assert.deepStrictEqual([f.state, f.operationId, f.targetSystemId, f.version], ["TRAVELLING", r.operationId,
      S.N5, r.fleetVersion]);
    assert.deepStrictEqual(opsOf(env, fleetId), [{ operation_type: "pursuit", objective: "destroy", due_at: at,
      state: "ACTIVE" }]);
    const key = approachKey(chainId);
    assert.strictEqual(key, `phunt:apr:${fleetId}:${idle.version}:approach`);
    for (const k of [`${key}:op`, `${key}:plan`]) {
      assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?", k), 1, k);
    }
    assert.strictEqual(env.tx((db) => ph.approachInTx(db, req)).reason, "FLEET_NOT_IDLE");
    assert.strictEqual(opsOf(env, fleetId).length, 1);

    const b = H.newFleet(env, "ap2b", FACTION_A, COMP);
    const bVersion = fleetOf(env, b).version;
    const journalBefore = H.n(env, "SELECT count(*) AS n FROM world_event_journal");
    const bad = env.tx((db) => ph.approachInTx(db, { ...req, chainId: approachChainIdOf(b, bVersion), fleetId: b,
      expectedVersion: bVersion, targetSystemId: S.N6 }));
    assert.deepStrictEqual([bad.ok, bad.reason], [false, "TOO_FAR"]);
    const fb = fleetOf(env, b);
    assert.deepStrictEqual([fb.state, fb.operationId], ["IDLE", null]);
    assert.deepStrictEqual(opsOf(env, b), []);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal"), journalBefore);
    ph.stop();
  }));
};
