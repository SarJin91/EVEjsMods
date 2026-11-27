"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { membersOf } = require("../../lib/playerHunt/huntRepository");
const { createExposureRepository } = require("../../lib/fleetExposure/exposureRepository");
const { startFleetExposure, createUnavailableFleetExposure, FLEET_EXPOSURE_METHODS } =
  require("../../lib/fleetExposure");
const X = require("../../lib/fleetExposure/schema");

const { S, FACTION_A } = H;
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const MINERS = Object.freeze([{ hullGroup: "mining_barge", count: 2 }]);
const CONVOY = Object.freeze([{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }]);
const CHAR = 90000001;

const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
const rows = (env) => ({ journal: H.n(env, "SELECT count(*) AS n FROM world_event_journal"),
  exposures: H.n(env, "SELECT count(*) AS n FROM world_fleet_exposures") });

function repoOf(env) {
  return createExposureRepository({ journal: env.journal, fleetRepository: env.fleets.repository,
    getTravel: () => env.fleets.travel });
}

function newFleet(env, tag, fleetRole, composition) {
  const r = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.N0, homeSystemId: S.N0, fleetRole,
    composition }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function stagedMiner(env, tag) {
  const fleetId = newFleet(env, tag, "mining", MINERS);
  const op = env.fleets.createOperation({ operationType: "mining", factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.N0, objective: "mine", dueAt: null, fleets: [{ fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const f = fleetOf(env, fleetId);
  const st = env.tx((db) => env.fleets.repository.transition(db, { fleetId, expectedVersion: f.version,
    from: f.state, to: "STAGED", patch: {} }, `${tag}:stage`));
  assert.ok(st.ok, JSON.stringify(st));
  return { fleetId, operationId: op.operationId };
}

const membersSpec = (fleetId, composition) => membersOf(fleetId, composition)
  .map((m) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup, typeId: m.typeId }));

function minerSpec(env, fleetId, operationId, at, extra = {}) {
  const f = fleetOf(env, fleetId);
  return { exposureId: X.exposureIdOf(fleetId, f.version), fleetId, expectedVersion: f.version, kind: "MINER",
    systemId: f.currentSystemId, operationId, at, characterId: CHAR, members: membersSpec(fleetId, f.composition),
    destroyed: [], crossing: null, ...extra };
}

function factsConfig(enabled) {
  return { ...H.CONFIG, fleetExposure: { enabled } };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FEX1 MINER claim: STAGED -> MATERIALIZED with the operation kept, row HELD; duplicate; IDLE -> "
    + "FLEET_NOT_EXPOSABLE; another id -> EXPOSURE_OPEN; migration 53 STRICT", () => H.withStore(driver,
    async (reopen) => {
      assert.ok(LATEST_SCHEMA_VERSION >= 53, String(LATEST_SCHEMA_VERSION));
      assert.strictEqual(MIGRATIONS[52].name, "world_fleet_exposures");
      const shared = H.sharedOf();
      const env = H.boot(reopen(), shared);
      const meta = env.tx((db) => ({
        strict: db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'world_fleet_exposures'").get().strict,
        indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'world_fleet_exposures'"
          + " AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name),
      }));
      assert.deepStrictEqual(meta, { strict: 1, indexes: ["world_fleet_exposures_open_fleet",
        "world_fleet_exposures_state"] });
      const repo = repoOf(env);
      const t0 = shared.clock.now();
      const m = stagedMiner(env, "fex1");
      const f0 = fleetOf(env, m.fleetId);
      const spec = minerSpec(env, m.fleetId, m.operationId, t0);
      const claim = env.tx((db) => repo.claimInTx(db, spec));
      assert.strictEqual(claim.ok, true, JSON.stringify(claim));
      assert.strictEqual(claim.duplicate, false);
      const e = claim.exposure;
      assert.deepStrictEqual([e.exposureId, e.state, e.kind, e.fromState, e.systemId, e.operationId, e.legSeq,
        e.characterId, e.factionId, e.members.map((x) => x.state)], [spec.exposureId, "HELD", "MINER", "STAGED", S.N0,
        m.operationId, f0.legSeq, CHAR, FACTION_A, ["SPAWNED", "SPAWNED"]]);
      const f1 = fleetOf(env, m.fleetId);
      assert.deepStrictEqual([f1.state, f1.operationId, f1.currentSystemId, f1.version], ["MATERIALIZED",
        m.operationId, S.N0, f0.version + 1]);

      const before = rows(env);
      const dup = env.tx((db) => repo.claimInTx(db, spec));
      assert.deepStrictEqual([dup.ok, dup.duplicate, dup.exposure.exposureId], [true, true, spec.exposureId]);
      assert.deepStrictEqual(rows(env), before, "a duplicate writes nothing");

      const idle = newFleet(env, "fex1i", "mining", MINERS);
      const before2 = rows(env);
      const idleSpec = minerSpec(env, idle, m.operationId, t0);
      const r = env.tx((db) => repo.claimInTx(db, idleSpec));
      assert.deepStrictEqual([r.ok, r.reason], [false, "FLEET_NOT_EXPOSABLE"], JSON.stringify(r));
      assert.deepStrictEqual(rows(env), before2);
      assert.strictEqual(fleetOf(env, idle).state, "IDLE");

      const againSpec = minerSpec(env, m.fleetId, m.operationId, t0 + 1);
      const again = env.tx((db) => repo.claimInTx(db, againSpec));
      assert.deepStrictEqual([again.ok, again.reason, again.exposureId], [false, "EXPOSURE_OPEN", spec.exposureId]);
      assert.deepStrictEqual(rows(env), before2);
      const other = stagedMiner(env, "fex1o");
      const bad = minerSpec(env, other.fleetId, other.operationId, t0, {
        members: [{ memberKey: `${other.fleetId}:mining_barge:0:3`, hullGroup: "mining_barge", typeId: null }] });
      assert.strictEqual(env.tx((db) => repo.claimInTx(db, bad)).reason, "FLEET_EXPOSURE_INVALID_INPUT");
      assert.strictEqual(fleetOf(env, other.fleetId).state, "STAGED");
    }));

  needsDriver("FEX2 CONVOY claim: TRAVELLING through 5 systems, at in the window of i = 2 -> MATERIALIZED in "
    + "systems[2], route null, operation kept; at outside -> NOT_CROSSING, still TRAVELLING, no row", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = H.boot(reopen(), shared);
      const repo = repoOf(env);
      const fleetId = newFleet(env, "fex2", "logistics", CONVOY);
      const op = env.fleets.createOperation({ operationType: "logistics", factionId: FACTION_A, originSystemId: S.N0,
        targetSystemId: S.N9, objective: "deliver", dueAt: null, fleets: [{ fleetId, expectedVersion: 1 }] },
      "fex2:op");
      assert.ok(op.ok, JSON.stringify(op));
      const p = env.fleets.planTravel({ fleetId, targetSystemId: S.N9, constraints: AVOID }, "fex2:plan");
      assert.ok(p.ok, JSON.stringify(p));
      const f0 = fleetOf(env, fleetId);
      const leg = f0.route;
      assert.deepStrictEqual([f0.state, leg.systems], ["TRAVELLING", [S.N0, S.N5, S.N6, S.N7, S.N9]]);
      const spec = (at) => ({ exposureId: X.exposureIdOf(fleetId, f0.version), fleetId, expectedVersion: f0.version,
        kind: "CONVOY", systemId: S.N6, operationId: op.operationId, at, characterId: null,
        members: membersSpec(fleetId, f0.composition).filter((m) => m.hullGroup === "industrial"), destroyed: [],
        crossing: { legSeq: f0.legSeq, systemIndex: 2 } });
      const before = rows(env);
      const outside = env.tx((db) => repo.claimInTx(db, spec(leg.departAt + leg.jumpMs)));
      assert.deepStrictEqual([outside.ok, outside.reason], [false, "NOT_CROSSING"], JSON.stringify(outside));
      assert.deepStrictEqual(rows(env), before, "the savepoint rolled back everything");
      const still = fleetOf(env, fleetId);
      assert.deepStrictEqual([still.state, still.version], ["TRAVELLING", f0.version]);

      const at = leg.departAt + 2 * leg.jumpMs;
      const claim = env.tx((db) => repo.claimInTx(db, spec(at)));
      assert.strictEqual(claim.ok, true, JSON.stringify(claim));
      const f1 = fleetOf(env, fleetId);
      assert.deepStrictEqual([f1.state, f1.currentSystemId, f1.route, f1.operationId, f1.legSeq], ["MATERIALIZED",
        S.N6, null, op.operationId, f0.legSeq]);
      assert.deepStrictEqual([claim.exposure.fromState, claim.exposure.legSeq, claim.exposure.systemId,
        claim.exposure.members.length, claim.exposure.characterId], ["TRAVELLING", f0.legSeq, S.N6, 2, null]);
      assert.strictEqual(rows(env).exposures, 1);
      assert.strictEqual(env.fleets.travel.getCounters().intercepts, 1);
    }));

  needsDriver("FEX3 markDestroyedInTx 1 of 2 -> endInTx(QUIET) once: 1 hull lost, STAGED with the same "
    + "operation, ENDED + losses_json; duplicate end; HELD of a previous boot -> RESTART once at start (flag off too)",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const repo = repoOf(env);
    const t0 = shared.clock.now();
    const m = stagedMiner(env, "fex3");
    const spec = minerSpec(env, m.fleetId, m.operationId, t0);
    assert.ok(env.tx((db) => repo.claimInTx(db, spec)).ok);
    const [k1, k2] = spec.members.map((x) => x.memberKey);
    const id = spec.exposureId;
    assert.deepStrictEqual(env.tx((db) => repo.markDestroyedInTx(db, { exposureId: id, memberKey: k1, at: t0 + 10 })),
      { ok: true, duplicate: false });
    assert.deepStrictEqual(env.tx((db) => repo.markDestroyedInTx(db, { exposureId: id, memberKey: k1, at: t0 + 20 })),
      { ok: true, duplicate: true });
    assert.strictEqual(env.tx((db) => repo.markDestroyedInTx(db, { exposureId: id, memberKey: "x", at: t0 }))
      .reason, "MEMBER_NOT_FOUND");

    const end = env.tx((db) => repo.endInTx(db, { exposureId: id, at: t0 + 30, reason: "QUIET" }));
    const losses = [{ hullGroup: "mining_barge", typeId: null, count: 1 }];
    assert.deepStrictEqual(end, { ok: true, duplicate: false, outcome: "RELEASED", losses });
    const f = fleetOf(env, m.fleetId);
    assert.deepStrictEqual([f.state, f.operationId, f.shipCount, f.composition], ["STAGED", m.operationId, 1,
      [{ hullGroup: "mining_barge", typeId: null, count: 1 }]]);
    const row = env.tx((db) => repo.getInTx(db, id)).exposure;
    assert.deepStrictEqual([row.state, row.endReason, row.endedAt, row.losses], ["ENDED", "QUIET", t0 + 30, losses]);
    const before = rows(env);
    assert.deepStrictEqual(env.tx((db) => repo.endInTx(db, { exposureId: id, at: t0 + 40, reason: "RESTART" })),
      { ok: true, duplicate: true, outcome: "RELEASED", losses });
    assert.deepStrictEqual(rows(env), before);
    assert.strictEqual(fleetOf(env, m.fleetId).version, f.version, "one settlement");
    assert.strictEqual(env.tx((db) => repo.markDestroyedInTx(db, { exposureId: id, memberKey: k2, at: t0 + 50 }))
      .reason, "NOT_HELD");

    const m3 = stagedMiner(env, "fex3c");
    const spec3 = minerSpec(env, m3.fleetId, m3.operationId, t0 + 60);
    assert.ok(env.tx((db) => repo.claimInTx(db, spec3)).ok);
    const cancel = env.tx((db) => {
      const o = env.fleets.repository.getOperation(db, m3.operationId).operation;
      return env.fleets.repository.transitionOperation(db, { operationId: m3.operationId, expectedVersion: o.version,
        from: o.state, to: "CANCELLED" }, "fex3c:cancel");
    });
    assert.ok(cancel.ok, JSON.stringify(cancel));
    assert.deepStrictEqual(env.tx((db) => repo.endInTx(db, { exposureId: spec3.exposureId, at: t0 + 70,
      reason: "QUIET" })), { ok: true, duplicate: false, outcome: "RELEASED", losses: [] });
    const f3 = fleetOf(env, m3.fleetId);
    assert.deepStrictEqual([f3.state, f3.operationId, f3.shipCount], ["IDLE", null, 2]);

    const m2 = stagedMiner(env, "fex3b");
    const spec2 = minerSpec(env, m2.fleetId, m2.operationId, t0 + 100);
    const c2 = env.tx((db) => repo.claimInTx(db, { ...spec2, destroyed: [spec2.members[1].memberKey] }));
    assert.ok(c2.ok, JSON.stringify(c2));
    shared.clock.set(t0 + 5000);
    const lines = [];
    const deps = (enabled) => ({ config: factsConfig(enabled), persistence: { ok: true, store: env.store,
      journal: env.journal }, clock: shared.clock, getFleets: () => env.fleets, telemetry: null,
    logger: { log: (l) => lines.push(l) } });
    const first = startFleetExposure(deps(false));
    assert.strictEqual(first.ok, true, JSON.stringify(first));
    const st = first.fleetExposure.getStatus();
    assert.deepStrictEqual([st.state, st.enabled, st.recovered, st.recoverFailed, st.lastError],
      ["ready", false, 1, 0, null]);
    const row2 = env.tx((db) => first.fleetExposure.getInTx(db, spec2.exposureId)).exposure;
    assert.deepStrictEqual([row2.state, row2.endReason, row2.endedAt], ["ENDED", "RESTART", t0 + 5000]);
    const f2 = fleetOf(env, m2.fleetId);
    assert.deepStrictEqual([f2.state, f2.operationId, f2.shipCount], ["STAGED", m2.operationId, 1]);
    assert.strictEqual(env.tx((db) => first.fleetExposure.claimInTx(db, spec2)).reason, "FLEET_EXPOSURE_DISABLED");
    assert.deepStrictEqual(Object.keys(first.fleetExposure).sort(), [...FLEET_EXPOSURE_METHODS].sort());
    assert.deepStrictEqual(Object.keys(createUnavailableFleetExposure("x")).sort(), [...FLEET_EXPOSURE_METHODS].sort());
    assert.strictEqual(createUnavailableFleetExposure("x").endInTx().reason, "FLEET_EXPOSURE_UNAVAILABLE");
    first.fleetExposure.stop("restart");
    const second = startFleetExposure(deps(true));
    assert.deepStrictEqual([second.fleetExposure.getStatus().recovered, second.fleetExposure.isEnabled()], [0, true]);
    assert.ok(lines[0].startsWith("fleetExposure: running enabled=false travel=ready recovered=1 failed=0"), lines[0]);
  }));

  needsDriver("FEX4: endInTx after applyLosses -> crews.reconcileGuardedInTx(cause LIVE, req.at "
    + "maxRows) with crew key lossesKey; no service / a throw / ok:false -> the same settlement", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = H.boot(reopen(), shared);
      const t0 = shared.clock.now();
      const calls = [];
      const settle = (tag, getCrews) => {
        const repo = createExposureRepository({ journal: env.journal, fleetRepository: env.fleets.repository,
          getTravel: () => env.fleets.travel, ...(getCrews ? { getCrews, crewMaxRows: 32 } : {}) });
        const m = stagedMiner(env, tag);
        const spec = minerSpec(env, m.fleetId, m.operationId, t0);
        assert.ok(env.tx((db) => repo.claimInTx(db, { ...spec, destroyed: [spec.members[0].memberKey] })).ok);
        const end = env.tx((db) => repo.endInTx(db, { exposureId: spec.exposureId, at: t0 + 30, reason: "QUIET" }));
        const f = fleetOf(env, m.fleetId);
        return { m, spec, end, fleet: [f.state, f.shipCount] };
      };
      const base = settle("fex4a", null);
      assert.deepStrictEqual([base.end.ok, base.end.outcome, base.fleet], [true, "RELEASED", ["STAGED", 1]]);
      const rec = settle("fex4b", () => ({ reconcileGuardedInTx(db, fleetId, req, key) {
        calls.push([typeof db.prepare, fleetId, req, key]);
        return { ok: true, duplicate: false, lost: 1 };
      } }));
      assert.deepStrictEqual(calls, [["function", rec.m.fleetId, { cause: "LIVE", at: t0 + 30, maxRows: 32 },
        X.lossesKey(rec.spec.exposureId)]]);
      for (const [tag, getCrews] of [["fex4c", () => ({ reconcileGuardedInTx: () => { throw new Error("boom"); } })],
        ["fex4d", () => ({ reconcileGuardedInTx: () => ({ ok: false, reason: "CREWS_OFF" }) })],
        ["fex4e", () => { throw new Error("getter"); }], ["fex4f", () => null]]) {
        const r = settle(tag, getCrews);
        assert.deepStrictEqual([r.end, r.fleet], [base.end, base.fleet], tag);
      }
      assert.deepStrictEqual([rec.end, rec.fleet], [base.end, base.fleet]);
    }));

  needsDriver("FEX6: crews throws after SQLite rolled the whole transaction back -> the error goes "
    + "up, the fleet is not released and the exposure stays HELD (no write in autocommit)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = H.boot(reopen(), shared);
      const t0 = shared.clock.now();
      const boom = new Error("fex5-ioerr");
      const repo = createExposureRepository({ journal: env.journal, fleetRepository: env.fleets.repository,
        getTravel: () => env.fleets.travel, getCrews: () => ({ reconcileGuardedInTx: (db) => {
          db.exec("ROLLBACK");
          throw boom;
        } }) });
      const m = stagedMiner(env, "fex5");
      const spec = minerSpec(env, m.fleetId, m.operationId, t0);
      assert.ok(env.tx((db) => repo.claimInTx(db, { ...spec, destroyed: [spec.members[0].memberKey] })).ok);
      const before = fleetOf(env, m.fleetId);
      const r = env.store.transaction("test", (db) => repo.endInTx(db, { exposureId: spec.exposureId, at: t0 + 30,
        reason: "QUIET" }));
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.strictEqual(r.error, boom, `the original error, got ${r.error && r.error.message}`);
      const f = fleetOf(env, m.fleetId);
      assert.deepStrictEqual([f.state, f.shipCount, f.version], [before.state, before.shipCount, before.version]);
      assert.strictEqual(env.tx((db) => repo.getInTx(db, spec.exposureId)).exposure.state, "HELD");
    }));

  needsDriver("REX1 release to STAGED calls releaseContact once with {releaseId, fleetId, systemId, at} "
    + "a duplicate endInTx does not; FLEET_GONE makes no call", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const calls = [];
    const repo = createExposureRepository({ journal: env.journal, fleetRepository: env.fleets.repository,
      getTravel: () => env.fleets.travel, releaseContact: (db, info) => calls.push([typeof db.prepare, info]) });
    const t0 = shared.clock.now();
    const m = stagedMiner(env, "rex1");
    const spec = minerSpec(env, m.fleetId, m.operationId, t0);
    assert.ok(env.tx((db) => repo.claimInTx(db, spec)).ok);
    const req = { exposureId: spec.exposureId, at: t0 + 30, reason: "QUIET" };
    const end = env.tx((db) => repo.endInTx(db, req));
    assert.deepStrictEqual([end.ok, end.duplicate, end.outcome], [true, false, "RELEASED"], JSON.stringify(end));
    assert.strictEqual(fleetOf(env, m.fleetId).state, "STAGED");
    assert.deepStrictEqual(calls, [["function", { releaseId: spec.exposureId, fleetId: m.fleetId, systemId: S.N0,
      at: t0 + 30 }]]);
    assert.strictEqual(env.tx((db) => repo.endInTx(db, req)).duplicate, true);
    assert.strictEqual(calls.length, 1, "no call on a duplicate");

    const g = stagedMiner(env, "rex1g");
    const gSpec = minerSpec(env, g.fleetId, g.operationId, t0);
    assert.ok(env.tx((db) => repo.claimInTx(db, gSpec)).ok);
    const f1 = fleetOf(env, g.fleetId);
    assert.ok(env.tx((db) => env.fleets.repository.transition(db, { fleetId: g.fleetId, expectedVersion: f1.version,
      from: "MATERIALIZED", to: "IDLE" }, "rex1g:offline")).ok);
    const gone = env.tx((db) => repo.endInTx(db, { exposureId: gSpec.exposureId, at: t0 + 40, reason: "QUIET" }));
    assert.strictEqual(gone.endReason, "FLEET_GONE", JSON.stringify(gone));
    assert.strictEqual(calls.length, 1, "no call on FLEET_GONE");
  }));

  needsDriver("FD-SV0: claim SENTRY on a STAGED invasion fleet -> HELD, MATERIALIZED; a mining "
    + "fleet -> FLEET_NOT_EXPOSABLE; endInTx(RETREAT) -> STAGED with the operation, losses once; ROLES_OF_KIND.SENTRY "
    + "= SIEGE_ROLES; facade gate per kind (liveHold off -> DISABLED)", () => H.withStore(driver, async (reopen) => {
    const { SIEGE_ROLES } = require("../../lib/stations/siege/schema");
    assert.deepStrictEqual([...X.ROLES_OF_KIND.SENTRY], [...SIEGE_ROLES]);
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const t0 = shared.clock.now();
    const comp = [{ hullGroup: "cruiser", count: 3 }];
    const fleetId = newFleet(env, "sv0", "invasion", comp);
    const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION_A, originSystemId: S.N0,
      targetSystemId: S.N0, objective: "capture", dueAt: null, fleets: [{ fleetId, expectedVersion: 1 }] }, "sv0:op");
    assert.ok(op.ok, JSON.stringify(op));
    const f0 = fleetOf(env, fleetId);
    assert.ok(env.tx((db) => env.fleets.repository.transition(db, { fleetId, expectedVersion: f0.version,
      from: f0.state, to: "STAGED", patch: {} }, "sv0:stage")).ok);
    const sentrySpec = (id, operationId) => {
      const f = fleetOf(env, id);
      return { exposureId: X.exposureIdOf(id, f.version), fleetId: id, expectedVersion: f.version, kind: "SENTRY",
        systemId: f.currentSystemId, operationId, at: t0, characterId: null, members: membersSpec(id, f.composition),
        destroyed: [], crossing: null };
    };
    const cfg = (liveHold) => ({ ...H.CONFIG, fleetExposure: { enabled: false },
      sentries: { enabled: true, liveHold: { enabled: liveHold } } });
    const start = (liveHold) => startFleetExposure({ config: cfg(liveHold), persistence: { ok: true, store: env.store,
      journal: env.journal }, clock: shared.clock, getFleets: () => env.fleets, telemetry: null, logger: { log() {} } });
    const off = start(false).fleetExposure;
    const spec = sentrySpec(fleetId, op.operationId);
    const refused = env.tx((db) => off.claimInTx(db, spec));
    assert.deepStrictEqual([refused.reason, off.isKindEnabled("SENTRY"), off.isKindEnabled("MINER"), rows(env).exposures],
      ["FLEET_EXPOSURE_DISABLED", false, false, 0]);
    off.stop();
    const fx = start(true).fleetExposure;
    assert.deepStrictEqual([fx.isKindEnabled("SENTRY"), fx.isKindEnabled("MINER"), fx.isEnabled()], [true, false, false]);
    const claim = env.tx((db) => fx.claimInTx(db, spec));
    assert.strictEqual(claim.ok, true, JSON.stringify(claim));
    assert.deepStrictEqual([claim.exposure.kind, claim.exposure.state, claim.exposure.fromState,
      claim.exposure.characterId, fleetOf(env, fleetId).state], ["SENTRY", "HELD", "STAGED", null, "MATERIALIZED"]);
    const m = stagedMiner(env, "sv0m");
    const minerAsSentry = sentrySpec(m.fleetId, m.operationId);
    const mined = env.tx((db) => fx.claimInTx(db, minerAsSentry));
    assert.deepStrictEqual([mined.reason, mined.detail], ["FLEET_NOT_EXPOSABLE", "fleetRole"]);
    const lost = env.tx((db) => fx.markDestroyedInTx(db, { exposureId: spec.exposureId,
      memberKey: spec.members[0].memberKey, at: t0 + 10 }));
    assert.ok(lost.ok, JSON.stringify(lost));
    const end = env.tx((db) => fx.endInTx(db, { exposureId: spec.exposureId, at: t0 + 20, reason: "RETREAT" }));
    const f1 = fleetOf(env, fleetId);
    assert.deepStrictEqual([end.ok, end.duplicate, end.outcome, f1.state, f1.operationId, f1.shipCount],
      [true, false, "RELEASED", "STAGED", op.operationId, 2]);
    const again = env.tx((db) => fx.endInTx(db, { exposureId: spec.exposureId, at: t0 + 30, reason: "NO_PLAYER" }));
    assert.deepStrictEqual([again.duplicate, fleetOf(env, fleetId).shipCount], [true, 2]);
  }));

  needsDriver("FEX-PR1 PRESENCE: IDLE claim with operationId null -> row "
    + "operation_id \"-\", from_state IDLE -> loss -> endInTx -> IDLE with fewer ships; STAGED -> release STAGED with "
    + "the operation; RESTART of an IDLE row -> IDLE; switch independent (REFITTING: FEX-PR2)",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const t0 = shared.clock.now();
    const cfg = (on) => ({ ...H.CONFIG, fleetExposure: { enabled: false, presence: { enabled: on } } });
    const start = (on) => startFleetExposure({ config: cfg(on), persistence: { ok: true, store: env.store,
      journal: env.journal }, clock: shared.clock, getFleets: () => env.fleets, telemetry: null, logger: { log() {} } });
    const fx = start(true).fleetExposure;
    assert.deepStrictEqual([fx.isKindEnabled("PRESENCE"), fx.isKindEnabled("MINER"), fx.getStatus().presence],
      [true, false, true]);
    const specOf = (id, operationId, extra = {}) => {
      const f = fleetOf(env, id);
      return { exposureId: X.exposureIdOf(id, f.version), fleetId: id, expectedVersion: f.version, kind: "PRESENCE",
        systemId: f.currentSystemId, operationId, at: t0, characterId: CHAR, members: membersSpec(id, f.composition),
        destroyed: [], crossing: null, ...extra };
    };
    const idle = newFleet(env, "pr1i", "garrison", MINERS);
    const spec = specOf(idle, null);
    const claim = env.tx((db) => fx.claimInTx(db, spec));
    assert.strictEqual(claim.ok, true, JSON.stringify(claim));
    const raw = env.tx((db) => db.prepare("SELECT operation_id, from_state FROM world_fleet_exposures "
      + "WHERE exposure_id = ?").get(spec.exposureId));
    assert.deepStrictEqual([raw.operation_id, raw.from_state, claim.exposure.operationId, claim.exposure.fromState,
      fleetOf(env, idle).state], [X.NO_OPERATION_ID, "IDLE", null, "IDLE", "MATERIALIZED"]);
    const m = stagedMiner(env, "pr1m");
    const asMiner = { ...specOf(m.fleetId, null), kind: "MINER" };
    assert.strictEqual(env.tx((db) => fx.claimInTx(db, asMiner)).reason, "FLEET_EXPOSURE_DISABLED");
    assert.ok(env.tx((db) => fx.markDestroyedInTx(db, { exposureId: spec.exposureId,
      memberKey: spec.members[0].memberKey, at: t0 + 10 })).ok);
    const end = env.tx((db) => fx.endInTx(db, { exposureId: spec.exposureId, at: t0 + 20, reason: "QUIET" }));
    const f1 = fleetOf(env, idle);
    assert.deepStrictEqual([end.ok, end.outcome, f1.state, f1.operationId, f1.shipCount], [true, "RELEASED", "IDLE",
      null, 1]);
    const st = specOf(m.fleetId, m.operationId);
    assert.ok(env.tx((db) => fx.claimInTx(db, st)).ok);
    const stEnd = env.tx((db) => fx.endInTx(db, { exposureId: st.exposureId, at: t0 + 30, reason: "QUIET" }));
    assert.deepStrictEqual([stEnd.ok, fleetOf(env, m.fleetId).state, fleetOf(env, m.fleetId).operationId],
      [true, "STAGED", m.operationId]);
    const again = specOf(idle, null);
    assert.ok(env.tx((db) => fx.claimInTx(db, again)).ok);
    fx.stop();
    shared.clock.advance(1000);
    const next = start(false).fleetExposure;
    assert.deepStrictEqual([next.isKindEnabled("PRESENCE"), next.getStatus().recovered, fleetOf(env, idle).state],
      [false, 1, "IDLE"]);
  }));

  needsDriver("FEX-PR2: PRESENCE claim of a REFITTING fleet -> from_state REFITTING, the lock "
    + "keeps the deadline; end before it -> REFITTING with the same deadline and refit_pending, one loss, a repeat = "
    + "duplicate; end after it -> IDLE (refit_pending cleared); RESTART before it -> REFITTING",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const t0 = shared.clock.now();
    const due = t0 + 3600000;
    const cfg = (on) => ({ ...H.CONFIG, fleetExposure: { enabled: false, presence: { enabled: on } } });
    const start = (on) => startFleetExposure({ config: cfg(on), persistence: { ok: true, store: env.store,
      journal: env.journal }, clock: shared.clock, getFleets: () => env.fleets, telemetry: null, logger: { log() {} } });
    const fx = start(true).fleetExposure;
    const rf = newFleet(env, "pr2r", "garrison", MINERS);
    const refitOf = (tag, patch) => {
      const f = fleetOf(env, rf);
      const r = env.tx((db) => env.fleets.repository.transition(db, { fleetId: rf, expectedVersion: f.version,
        from: "IDLE", to: "REFITTING", patch }, `${tag}:refit`));
      assert.ok(r.ok, JSON.stringify(r));
    };
    const specOf = () => {
      const f = fleetOf(env, rf);
      return { exposureId: X.exposureIdOf(rf, f.version), fleetId: rf, expectedVersion: f.version, kind: "PRESENCE",
        systemId: f.currentSystemId, operationId: null, at: t0, characterId: CHAR, members: membersSpec(rf,
          f.composition), destroyed: [], crossing: null };
    };
    refitOf("pr2a", { nextActionAt: due, refitPending: true });
    const spec = specOf();
    const claim = env.tx((db) => fx.claimInTx(db, spec));
    assert.strictEqual(claim.ok, true, JSON.stringify(claim));
    const locked = fleetOf(env, rf);
    assert.deepStrictEqual([claim.exposure.fromState, locked.state, locked.nextActionAt, locked.refitPending],
      ["REFITTING", "MATERIALIZED", due, true]);
    assert.ok(env.tx((db) => fx.markDestroyedInTx(db, { exposureId: spec.exposureId,
      memberKey: spec.members[0].memberKey, at: t0 + 10 })).ok);
    const end = env.tx((db) => fx.endInTx(db, { exposureId: spec.exposureId, at: t0 + 20, reason: "QUIET" }));
    const f1 = fleetOf(env, rf);
    assert.deepStrictEqual([end.ok, end.duplicate, end.outcome, end.losses.reduce((n, g) => n + g.count, 0), f1.state,
      f1.nextActionAt, f1.refitPending, f1.shipCount], [true, false, "RELEASED", 1, "REFITTING", due, true, 1]);
    const settles = (id) => H.n(env, `SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = '${
      X.settleKey(id)}'`);
    const again = env.tx((db) => fx.endInTx(db, { exposureId: spec.exposureId, at: t0 + 30, reason: "WIPED" }));
    assert.deepStrictEqual([again.ok, again.duplicate, fleetOf(env, rf).shipCount, settles(spec.exposureId)],
      [true, true, 1, 1]);
    const late = specOf();
    assert.ok(env.tx((db) => fx.claimInTx(db, late)).ok);
    const lateEnd = env.tx((db) => fx.endInTx(db, { exposureId: late.exposureId, at: due, reason: "TIMEOUT" }));
    const f2 = fleetOf(env, rf);
    assert.deepStrictEqual([lateEnd.ok, f2.state, f2.nextActionAt, f2.refitPending, f2.shipCount],
      [true, "IDLE", null, false, 1]);
    refitOf("pr2b", { nextActionAt: due });
    const held = specOf();
    assert.ok(env.tx((db) => fx.claimInTx(db, held)).ok);
    fx.stop();
    shared.clock.advance(1000);
    const next = start(false).fleetExposure;
    const f3 = fleetOf(env, rf);
    assert.deepStrictEqual([next.getStatus().recovered, f3.state, f3.nextActionAt], [1, "REFITTING", due]);
  }));
};
