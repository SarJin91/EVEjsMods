"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const OS = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const SOV = require("../../lib/world/sovStructures/schema");
const { startSovStructures } = require("../../lib/world/sovStructures");
const { createSovStructureRepository } = require("../../lib/world/sovStructures/repository");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { startOccupation } = require("../../lib/world/occupation");
const { createHostility } = require("../../lib/battle/data/hostility");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const AMARR = 500003;
const SANSHA = 500019;
const GURISTAS = 500010;
const isHostile = createHostility();

const PARAMS = Object.freeze({ evalIntervalMs: 900000, idleEvalIntervalMs: 7200000, maxActiveSystems: 64,
  reconTimeoutMs: 2 * HOUR, contestTimeoutMs: 6 * HOUR, invasionHoldMs: 6 * HOUR, occupiedSettleMs: 6 * HOUR,
  consolidateMs: 24 * HOUR, invasionMinScore: 30, occupyMinScore: 60, occupyMaxDefenderScore: 30, stableMinScore: 80,
  stableMaxResidualScore: 20, battleWinPoints: 20, battleLossPoints: 15, holdPointsPerHour: 10,
  stationPointsPerHour: 5, stationBonusCap: 3, decayPointsPerHour: 5, requireNoDefenderStations: true,
  garrisonFleetsTarget: 1, detachedUpkeepStep: 0.5, detachedUpkeepPeriodMs: 24 * HOUR, detachedUpkeepMaxFactor: 4,
  maxFactionsPerSystem: 8, stableBaselineScore: 60, stableRecoverPointsPerHour: 1, stableForeignDecayPointsPerHour: 1,
  stableForeignFloorScore: 0, garrisonFromRoles: Object.freeze(["invasion", "patrol", "scout", "reserve"]) });

function view(o = {}) {
  const range = new Set(o.range || [SANSHA]);
  const v = { systemId: 30002000, state: o.state || OS.INVASION, controller: o.controller === undefined ? AMARR
    : o.controller, occupier: o.occupier === undefined ? SANSHA : o.occupier, previousController: null, sinceAt: 0,
  seq: 4, evaluatedAt: null, capturedAt: null, detachedSinceAt: null, home: null, coreOwner: null,
  influence: new Map(Object.entries(o.influence || { [SANSHA]: 80, [AMARR]: 10 }).map(([f, score]) => [Number(f),
    { score, garrison: 0 }])),
  presence: new Map(Object.entries(o.presence || { [SANSHA]: 100 }).map(([f, strength]) => [Number(f), { strength,
    fleets: [{ fleetId: `fl:${f}`, version: 1, state: "IDLE", fleetRole: "invasion", refitPending: false }] }])),
  stations: new Map(), inRange: (f) => range.has(f), isHostile, presenceTruncated: false, at: o.at || 7 * HOUR,
  rangeKnown: true };
  if (o.sov !== undefined) v.sov = o.sov;
  return v;
}
const sovOf = (structures, needs = () => true) => ({ needs, structures });
const ref = (factionId, state, id = `sovs:30002000:${factionId}:4:1`) => ({ structureId: id, factionId, state,
  version: 1, attackerFactionId: null, attackStartedAt: null });
const tick = { kind: "tick" };

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function fakeTreasury(balances) {
  const paid = new Map();
  return { paid, balances, chargeWarSpendInTx(db, spec, key) {
    if (paid.has(key)) return { ok: true, duplicate: true, balanceIsk: balances.get(spec.factionId) };
    if (!balances.has(spec.factionId)) return { ok: false, reason: "NO_TREASURY", detail: String(spec.factionId) };
    const b = balances.get(spec.factionId);
    if (b < spec.isk) return { ok: false, reason: "TREASURY_INSUFFICIENT", detail: `${b}/${spec.isk}` };
    balances.set(spec.factionId, b - spec.isk);
    paid.set(key, spec.isk);
    return { ok: true, duplicate: false, balanceIsk: b - spec.isk };
  } };
}

function bootSov(opened, shared, envOver = {}, treasury = null, extraSov = {}) {
  const env = H.boot(opened, shared);
  const config = configOf({ EVEJS_LNE_SOV_STRUCTURES_ENABLED: "1", ...envOver });
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const holder = { sov: null, occupation: null };
  const persistence = { ok: true, store: env.store, journal: env.journal, worldSeed: opened.worldSeed };
  const o = startOccupation({ config, persistence, clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets,
    world: { repository: repo }, graph: { getGraph: () => ({ ok: true, graph: shared.graph }) },
    getStations: () => null, views: createViewRegistry(), logger: { log() {} }, nowMs: () => 0,
    getSovStructures: () => holder.sov, needsSovStructureOf: () => true });
  assert.ok(o.ok, JSON.stringify(o));
  holder.occupation = o.occupation;
  const s = startSovStructures({ config, persistence, clock: shared.clock, scheduler: env.scheduler,
    getOccupation: () => holder.occupation, getTreasury: () => treasury, logger: { log() {} }, ...extraSov });
  assert.ok(s.ok, JSON.stringify(s));
  holder.sov = s.sovStructures;
  return { ...env, repo, config, occupation: o.occupation, sov: s.sovStructures, service: s.service,
    physical: s.physical || null, sovRepo: createSovStructureRepository() };
}

function seedSystem(env, systemId, controller, occupier) {
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: controller },
    influence: [{ factionId: controller, influenceScore: 50 }] }, `world:seed:v1:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
  if (occupier === undefined) return;
  const u = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 1, reason: "OCCUPATION_PHASE",
    state: { occupationState: OS.INVASION, occupierFactionId: occupier, phaseSeq: 2 } }, `test:invasion:${systemId}`));
  assert.ok(u.ok, JSON.stringify(u));
}

const anchor = (env, systemId, factionId, at, keyBase) => env.tx((db) => env.sov.applyOpsInTx(db, { systemId,
  ops: [{ op: SOV.OP.ANCHOR, factionId, claimSeq: 2 }], at }, keyBase));
const rowOf = (env, id) => env.tx((db) => env.sovRepo.getById(db, id)).structure;
const keyCount = (env, key) => env.tx((db) => db.prepare(`SELECT count(*) AS n FROM world_scheduled_events
  WHERE idempotency_key = ?`).get(key)).n;
const sovRows = (env) => env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_sov_structures").get()).n;

function step(env, structureId, now) {
  const res = env.service.onStep({ payload: { structureId }, idempotencyKey: SOV.stepKey(structureId) }, { now });
  assert.ok(res.ok, JSON.stringify(res));
  if (typeof res.effect === "function") {
    const e = env.tx((db) => res.effect(db));
    assert.ok(e.ok, JSON.stringify(e));
  }
  if (typeof res.onCommitted === "function") res.onCommitted();
  return res.outcome;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("SOVS1 machine gate: INVASION with every condition + needs -> no transition + ANCHOR (claimSeq = seq); own "
    + "ANCHORING -> wait; structure of the controller -> ATTACK; own ONLINE -> OCCUPIED + BIND; view.sov null = "
    + "the evaluation without "
    + "the field (sovOps [])", () => {
    const out = {};
    const a = M.evaluate(view({ sov: sovOf([]) }), tick, PARAMS);
    out.anchor = [a.to, a.sovOps, a.notes.includes(SOV.NOTES.ANCHOR_REQUESTED)];
    const w = M.evaluate(view({ sov: sovOf([ref(SANSHA, SOV.ANCHORING)]) }), tick, PARAMS);
    out.wait = [w.to, w.sovOps, w.notes.includes(SOV.NOTES.ANCHORING)];
    const f = M.evaluate(view({ sov: sovOf([ref(AMARR, SOV.ONLINE, "sovg:30002000:500003:1")]) }), tick, PARAMS);
    out.foreign = [f.to, f.sovOps, f.notes.includes(SOV.NOTES.SIEGE_STARTED)];
    const b = M.evaluate(view({ sov: sovOf([ref(SANSHA, SOV.ONLINE)]) }), tick, PARAMS);
    out.bind = [b.to, b.statePatch.controllerFactionId, b.statePatch.capturedAt, b.sovOps];
    const plain = M.evaluate(view(), tick, PARAMS);
    const off = M.evaluate(view({ sov: null }), tick, PARAMS);
    out.regression = [plain.to, plain.sovOps];
    assert.deepStrictEqual(off, plain, "view.sov null = no field");
    assert.deepStrictEqual(out, {
      anchor: [null, [{ op: "ANCHOR", factionId: SANSHA, claimSeq: 4 }], true],
      wait: [null, [], true],
      foreign: [null, [{ op: "ATTACK", structureId: "sovg:30002000:500003:1", factionId: SANSHA, version: 1 }], true],
      bind: [OS.OCCUPIED, SANSHA, 7 * HOUR, [{ op: "BIND", structureId: "sovs:30002000:500019:4:1",
        capturedAt: 7 * HOUR }]],
      regression: [OS.OCCUPIED, []],
    });
  });

  test("SOVS2 machine follow-up: INVASION -> CONTESTED under a hostile holder -> DESTROY FIELD_LOST of the pretender "
    + "structure; CONTESTED -> STABLE (timeout) with its ANCHORING -> END CLAIM_LOST; an exempt kind -> OCCUPIED "
    + "without a structure", () => {
    const out = {};
    const lost = M.evaluate(view({ presence: { [AMARR]: 100 }, sov: sovOf([ref(SANSHA, SOV.ANCHORING)]) }), tick,
      PARAMS);
    out.fieldLost = [lost.to, lost.sovOps];
    const timeout = M.evaluate(view({ state: OS.CONTESTED, presence: {}, sov: sovOf([ref(SANSHA, SOV.ANCHORING)]) }),
      tick, PARAMS);
    out.claimLost = [timeout.to, timeout.sovOps];
    const exempt = M.evaluate(view({ sov: sovOf([], (f) => f !== SANSHA) }), tick, PARAMS);
    out.exempt = [exempt.to, exempt.sovOps];
    assert.deepStrictEqual(out, {
      fieldLost: [OS.CONTESTED, [{ op: "DESTROY", structureId: "sovs:30002000:500019:4:1", reason: "FIELD_LOST",
        byFactionId: AMARR }]],
      claimLost: [OS.STABLE, [{ op: "END", structureId: "sovs:30002000:500019:4:1", reason: "CLAIM_LOST",
        byFactionId: null }]],
      exempt: [OS.OCCUPIED, []],
    });
  });

  needsDriver("SOVS3 applyOpsInTx ANCHOR on a real store: fee once (sovs:<id>:fee), row ANCHORING due at + anchorMs "
    + "and the step event; same keyBase again -> DUPLICATE, balance kept; TREASURY_INSUFFICIENT -> REFUSED, no row; "
    + "maxAnchoringPerFaction -> SOV_LIMIT_FACTION", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const treasury = fakeTreasury(new Map([[SANSHA, 2500000000], [GURISTAS, 10]]));
    const env = bootSov(reopen(), shared, { EVEJS_LNE_SOV_STRUCTURES_MAX_ANCHORING_PER_FACTION: "1" }, treasury);
    const at = shared.clock.now();
    const id = SOV.structureIdOf(H.S.N5, SANSHA, 2, 1);
    const first = anchor(env, H.S.N5, SANSHA, at, "occ:test:1:sov");
    const again = anchor(env, H.S.N5, SANSHA, at, "occ:test:1:sov");
    const row = rowOf(env, id);
    const poor = anchor(env, H.S.N6, GURISTAS, at, "occ:test:2:sov");
    const limit = anchor(env, H.S.N7, SANSHA, at, "occ:test:3:sov");
    assert.deepStrictEqual({ first, again, poor, limit, row: [row.state, row.costIsk, row.dueAt, row.attempt],
      paid: [...treasury.paid.entries()], balance: treasury.balances.get(SANSHA), step: keyCount(env, SOV.stepKey(id)),
      rows: sovRows(env) }, {
      first: { ok: true, results: [{ op: "ANCHOR", outcome: "APPLIED", structureId: id }] },
      again: { ok: true, results: [{ op: "ANCHOR", outcome: "DUPLICATE", structureId: id }] },
      poor: { ok: true, results: [{ op: "ANCHOR", outcome: "REFUSED", reason: "TREASURY_INSUFFICIENT" }] },
      limit: { ok: true, results: [{ op: "ANCHOR", outcome: "REFUSED", reason: "SOV_LIMIT_FACTION" }] },
      row: [SOV.ANCHORING, 1000000000, at + 3600000, 1],
      paid: [[`${id}:fee`, 1000000000]],
      balance: 1500000000,
      step: 1,
      rows: 1,
    });
    env.sov.noteCommitted([...first.results, ...poor.results]);
    const c = env.sov.getStatus().counters;
    assert.deepStrictEqual([c.anchorRequested, c.anchorRefused, c.anchorUnfunded], [1, 1, 1]);
  }));

  needsDriver("SOVS4 SOV_STRUCTURE_STEP: claim still INVASION of the owner -> ONLINE + nudge occ:<sys>:<seq>:s:<id>; "
    + "claim of another faction -> ENDED CLAIM_LOST; a second run -> STALE", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const env = bootSov(reopen(), shared, { EVEJS_LNE_SOV_STRUCTURES_COST_ISK: "0" });
      seedSystem(env, H.S.N5, AMARR, SANSHA);
      seedSystem(env, H.S.N6, AMARR, SANSHA);
      const at = shared.clock.now();
      const own = SOV.structureIdOf(H.S.N5, SANSHA, 2, 1);
      const other = SOV.structureIdOf(H.S.N6, GURISTAS, 2, 1);
      assert.ok(anchor(env, H.S.N5, SANSHA, at, "k:1").ok);
      assert.ok(anchor(env, H.S.N6, GURISTAS, at, "k:2").ok);
      const now = at + 7200000;
      const out = { online: step(env, own, now), lost: step(env, other, now), again: step(env, own, now) };
      const a = rowOf(env, own);
      const b = rowOf(env, other);
      assert.deepStrictEqual({ ...out, own: [a.state, a.onlineAt], other: [b.state, b.endReason],
        nudge: keyCount(env, OS.sovNudgeKey(H.S.N5, 2, own)), nudgeLost: keyCount(env, OS.sovNudgeKey(H.S.N6, 2, other)),
        counters: (({ online, endedClaimLost, stepStale }) => [online, endedClaimLost, stepStale])(
          env.sov.getStatus().counters) }, {
        online: "STEPPED", lost: "STEPPED", again: "STALE",
        own: [SOV.ONLINE, now], other: [SOV.ENDED, "CLAIM_LOST"],
        nudge: 1, nudgeLost: 0, counters: [1, 1, 1],
      });
    }));

  needsDriver("SOVS5 abandonInTx ends the live structure of the controller ABANDONED in the same transaction; a "
    + "rollback of the caller keeps both the system and the structure", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = bootSov(reopen(), shared, { EVEJS_LNE_SOV_STRUCTURES_COST_ISK: "0" });
    seedSystem(env, H.S.N5, GURISTAS);
    const at = shared.clock.now();
    const id = SOV.structureIdOf(H.S.N5, GURISTAS, 2, 1);
    assert.ok(anchor(env, H.S.N5, GURISTAS, at, "k:1").ok);
    const BOOM = new Error("rollback");
    const rolled = env.store.transaction("test", (db) => {
      const r = env.occupation.abandonInTx(db, { systemId: H.S.N5, at }, "abandon:test:1");
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(env.sovRepo.getById(db, id).structure.state, SOV.ENDED, "ended inside the transaction");
      throw BOOM;
    });
    assert.strictEqual(rolled.error, BOOM);
    const kept = [rowOf(env, id).state, env.tx((db) => env.repo.getSystem(db, H.S.N5, {})).system.controllerFactionId];
    const done = env.tx((db) => env.occupation.abandonInTx(db, { systemId: H.S.N5, at }, "abandon:test:1"));
    const row = rowOf(env, id);
    assert.deepStrictEqual({ kept, done: [done.ok, done.previousControllerFactionId],
      after: [row.state, row.endReason, env.tx((db) => env.repo.getSystem(db, H.S.N5, {})).system.controllerFactionId],
      counted: env.sov.getStatus().counters.endedAbandoned >= 1 }, {
      kept: [SOV.ANCHORING, GURISTAS],
      done: [true, GURISTAS],
      after: [SOV.ENDED, "ABANDONED", null],
      counted: true,
    });
  }));
};

module.exports.harness = { H, view, sovOf, ref, tick, PARAMS, AMARR, SANSHA, GURISTAS, HOUR, bootSov, seedSystem,
  rowOf, step, configOf };
