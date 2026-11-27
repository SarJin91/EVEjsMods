"use strict";

const assert = require("node:assert");

const OS = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const { estimateProgress, progressToJson } = require("../../lib/world/occupation/progress");
const SOV = require("../../lib/world/sovStructures/schema");
const { FACADE_METHODS, createUnavailableSovStructures, reconcileRowsOf } = require("../../lib/world/sovStructures");
const { VIEW_ID, SYSTEM_VIEW_ID, ROW_KEYS } = require("../../lib/world/sovStructures/view");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: X } = require("./sovStructures.test");

const { H, view, sovOf, ref, tick, PARAMS, AMARR, SANSHA, GURISTAS, HOUR } = X;
const STRUCT = "sovg:30002000:500003:1";

const siegeSov = (structures, observed = false) => ({ ...sovOf(structures), siegeHoldMs: HOUR,
  pauseWhenObserved: true, observed, anchorMs: 2 * HOUR });
const besieged = (attacker, since, version = 2) => ({ ...ref(AMARR, SOV.ONLINE, STRUCT), version,
  attackerFactionId: attacker, attackStartedAt: since });

function reconcile(env, phase, now, after = "") {
  const res = env.service.onReconcile({ payload: { bucket: 1, phase, after },
    idempotencyKey: SOV.reconcileKey(1, phase, after) }, { now });
  assert.ok(res.ok, JSON.stringify(res));
  const e = env.tx((db) => res.effect(db));
  assert.ok(e.ok, JSON.stringify(e));
  res.onCommitted();
}

function heldSystem(env, systemId, controller, capturedAt) {
  X.seedSystem(env, systemId, controller);
  if (capturedAt === null) return;
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 1, reason: "OCCUPATION_PHASE",
    state: { capturedAt } }, `test:capture:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

const systemOf = (env, id) => env.tx((db) => env.repo.getSystem(db, id, {})).system;
const sovRowsOf = (env, systemId) => env.tx((db) => db.prepare(`SELECT structure_id AS id, state, end_reason AS r
  FROM world_sov_structures WHERE system_id = ? ORDER BY structure_id`).all(systemId))
  .map((r) => [r.id, r.state, r.r]);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("SOVX1 machine siege: the structure of C -> ATTACK; hold not over -> SOV_SIEGE; over while observed -> "
    + "SOV_SIEGE_OBSERVED, no op; over -> DESTROY SIEGE + controller null, previous C, to null", () => {
    const attack = M.evaluate(view({ sov: siegeSov([ref(AMARR, SOV.ONLINE, STRUCT)]) }), tick, PARAMS);
    const wait = M.evaluate(view({ sov: siegeSov([besieged(SANSHA, 6.5 * HOUR)]) }), tick, PARAMS);
    const observed = M.evaluate(view({ sov: siegeSov([besieged(SANSHA, 5 * HOUR)], true) }), tick, PARAMS);
    const destroy = M.evaluate(view({ sov: siegeSov([besieged(SANSHA, 5 * HOUR)]) }), tick, PARAMS);
    const has = (e, n) => e.notes.includes(n);
    assert.deepStrictEqual({
      attack: [attack.to, attack.sovOps, has(attack, SOV.NOTES.SIEGE_STARTED), attack.controllerChanged],
      wait: [wait.to, wait.sovOps, has(wait, SOV.NOTES.SIEGE)],
      observed: [observed.to, observed.sovOps, has(observed, SOV.NOTES.SIEGE_OBSERVED),
        observed.statePatch.controllerFactionId],
      destroy: [destroy.to, destroy.sovOps, destroy.controllerChanged, destroy.statePatch.controllerFactionId,
        destroy.statePatch.previousControllerFactionId, destroy.statePatch.capturedAt,
        destroy.statePatch.occupationState, has(destroy, SOV.NOTES.CONTROL_RELEASED)],
    }, {
      attack: [null, [{ op: "ATTACK", structureId: STRUCT, factionId: SANSHA, version: 1 }], true, false],
      wait: [null, [], true],
      observed: [null, [], true, AMARR],
      destroy: [null, [{ op: "DESTROY", structureId: STRUCT, reason: "SIEGE", byFactionId: SANSHA, version: 2 }],
        true, null, AMARR, null, OS.INVASION, true],
    });
  });

  test("SOVX2 machine: INVASION -> CONTESTED (hostile holder) with the structure of C under a siege of P -> LIFT; "
    + "still INVASION of P -> no LIFT", () => {
    const lost = M.evaluate(view({ presence: { [AMARR]: 100 }, sov: siegeSov([besieged(SANSHA, 6.5 * HOUR)]) }),
      tick, PARAMS);
    const kept = M.evaluate(view({ sov: siegeSov([besieged(SANSHA, 6.5 * HOUR)]) }), tick, PARAMS);
    assert.deepStrictEqual([lost.to, lost.sovOps, kept.sovOps], [OS.CONTESTED,
      [{ op: "LIFT", structureId: STRUCT, version: 2 }], []]);
  });

  needsDriver("SOVX3 reconcile ADOPT: a captured system without a row -> one GRANDFATHERED ONLINE, a second run "
    + "inserts nothing; heartland and an exempt kind skipped; after DESTROYED of that epoch no new row", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const logs = [];
      const env = X.bootSov(reopen(), shared, {}, null, { needsSovStructureOf: (f) => f !== SANSHA,
        logger: { log: (line) => logs.push(line) } });
      heldSystem(env, H.S.N5, GURISTAS, 1000);
      heldSystem(env, H.S.N6, AMARR, null);
      heldSystem(env, H.S.N7, SANSHA, 2000);
      const now = shared.clock.now();
      reconcile(env, SOV.PHASE.ADOPT, now);
      const first = sovRowsOf(env, H.S.N5);
      reconcile(env, SOV.PHASE.ADOPT, now);
      const id = SOV.grandfatheredIdOf(H.S.N5, GURISTAS, 1000);
      const row = X.rowOf(env, id);
      const killed = env.tx((db) => env.sovRepo.transition(db, { structure: row, to: SOV.DESTROYED, at: now,
        reason: SOV.REASON.LIVE_KILL, byFactionId: null }));
      assert.ok(killed.ok, JSON.stringify(killed));
      reconcile(env, SOV.PHASE.ADOPT, now);
      assert.deepStrictEqual({ first, after: sovRowsOf(env, H.S.N5), heartland: sovRowsOf(env, H.S.N6),
        exempt: sovRowsOf(env, H.S.N7), origin: [row.origin, row.claimCapturedAt, row.costIsk],
        adopted: env.sov.getStatus().counters.adopted,
        adoptLogs: logs.filter((l) => l.startsWith("sovStructures: running adopted=")) }, {
        first: [[id, SOV.ONLINE, null]],
        after: [[id, SOV.DESTROYED, "LIVE_KILL"]],
        heartland: [],
        exempt: [],
        origin: [SOV.GRANDFATHERED, 1000, 0],
        adopted: 1,
        adoptLogs: ["sovStructures: running adopted=1"],
      });
    }));

  needsDriver("SOVX4 reconcile HEAL: DESTROYED (SIEGE) while the system is still held in its epoch -> abandonInTx "
    + "once (controller null); CONTROL: ONLINE of a faction without control -> ENDED CONTROL_LOST", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = X.bootSov(reopen(), shared);
      const now = shared.clock.now();
      heldSystem(env, H.S.N5, GURISTAS, 1000);
      heldSystem(env, H.S.N6, AMARR, 3000);
      const sieged = SOV.grandfatheredIdOf(H.S.N5, GURISTAS, 1000);
      const stray = SOV.grandfatheredIdOf(H.S.N6, GURISTAS, 5);
      env.tx((db) => {
        assert.ok(env.sovRepo.insertGrandfathered(db, { systemId: H.S.N5, factionId: GURISTAS, capturedAt: 1000,
          at: now }).inserted);
        assert.ok(env.sovRepo.insertGrandfathered(db, { systemId: H.S.N6, factionId: GURISTAS, capturedAt: 5,
          at: now }).inserted);
        const s = env.sovRepo.getById(db, sieged).structure;
        return env.sovRepo.transition(db, { structure: s, to: SOV.DESTROYED, at: now, reason: SOV.REASON.SIEGE,
          byFactionId: SANSHA });
      });
      reconcile(env, SOV.PHASE.HEAL, now);
      reconcile(env, SOV.PHASE.HEAL, now + 1000);
      reconcile(env, SOV.PHASE.CONTROL, now);
      const abandons = env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal "
        + "WHERE idempotency_key = ?").get(SOV.abandonKey(sieged))).n;
      const c = env.sov.getStatus().counters;
      assert.deepStrictEqual({ healed: [systemOf(env, H.S.N5).controllerFactionId, abandons, c.healed, c.healRefused],
        control: [sovRowsOf(env, H.S.N6), c.endedControlLost] }, {
        healed: [null, 1, 1, 0],
        control: [[[stray, SOV.ENDED, "CONTROL_LOST"]], 1],
      });
    }));

  needsDriver("SOVX5 panel sov-structures on the real facade (store of the service, row keys; facade methods of the "
    + "service = of the stub = FACADE_METHODS) + the sov condition of estimateProgress", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const env = X.bootSov(reopen(), shared, {}, null, { views });
      const now = shared.clock.now();
      env.tx((db) => env.sovRepo.insertGrandfathered(db, { systemId: H.S.N5, factionId: GURISTAS, capturedAt: 1000,
        at: now }));
      const all = views.getView(VIEW_ID).getData();
      const one = views.getView(SYSTEM_VIEW_ID).getData({ param: H.S.N6 });
      const stub = createUnavailableSovStructures("TEST");
      const p = estimateProgress(view({ sov: siegeSov([{ ...ref(SANSHA, SOV.ANCHORING), dueAt: 8 * HOUR }]) }), PARAMS);
      const json = progressToJson(p);
      assert.deepStrictEqual({
        all: [all.available, all.structures.map((r) => [r.structureId, r.state, r.origin]), all.truncated,
          Object.keys(all.structures[0])],
        one: [one.available, one.systemId, one.structures.length],
        facade: [Object.keys(env.sov).sort(), Object.keys(stub).sort()],
        progress: [json.sov, json.status, json.limiting],
      }, {
        all: [true, [[SOV.grandfatheredIdOf(H.S.N5, GURISTAS, 1000), SOV.ONLINE, SOV.GRANDFATHERED]], false,
          [...ROW_KEYS]],
        one: [true, H.S.N6, 0],
        facade: [[...FACADE_METHODS].sort(), [...FACADE_METHODS].sort()],
        progress: [{ kind: "sov", have: SOV.ANCHORING, etaMs: HOUR }, "ADVANCING", "SOV"],
      });
    }));

  test("SOVX6: reconcile pages bounded by the row limit (runtime min, store limit wins) "
    + "too small a limit for one HEAL abandon -> refusal", () => {
    const cfg = (maxRows, reconcileMaxRows, healMaxPerEvent) => ({ persistence: { maxRowsPerTransaction: maxRows },
      world: { maxFactionsPerSystem: 8 }, sovStructures: { reconcileMaxRows, healMaxPerEvent } });
    const store = (n) => ({ limits: { maxRowsPerTransaction: n } });
    const pick = (r) => (r.ok ? [r.pageRows, r.healRows] : r.detail);
    assert.deepStrictEqual([
      pick(reconcileRowsOf(cfg(1000, 200, 20), store(1000))),
      pick(reconcileRowsOf(cfg(1000, 5000, 200), store(1000))),
      pick(reconcileRowsOf(cfg(1000, 5000, 200), store(100))),
      pick(reconcileRowsOf(cfg(14, 200, 20), store(14))),
    ], [[200, 20], [998, 76], [98, 7], "persistence.maxRowsPerTransaction 14 < 15"]);
  });

  needsDriver("SOVX7: HEAL with healMaxPerEvent 1 abandons one system per event and the "
    + "successor continues after that row only", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = X.bootSov(reopen(), shared, { EVEJS_LNE_SOV_STRUCTURES_HEAL_MAX_PER_EVENT: "1" });
      const now = shared.clock.now();
      heldSystem(env, H.S.N5, GURISTAS, 1000);
      heldSystem(env, H.S.N6, GURISTAS, 1000);
      const systemOfId = new Map([H.S.N5, H.S.N6].map((sys) => [SOV.grandfatheredIdOf(sys, GURISTAS, 1000), sys]));
      const ids = [...systemOfId.keys()].sort();
      env.tx((db) => {
        for (const [id, sys] of systemOfId) {
          assert.ok(env.sovRepo.insertGrandfathered(db, { systemId: sys, factionId: GURISTAS, capturedAt: 1000,
            at: now }).inserted);
          const t = env.sovRepo.transition(db, { structure: env.sovRepo.getById(db, id).structure,
            to: SOV.DESTROYED, at: now, reason: SOV.REASON.SIEGE, byFactionId: SANSHA });
          assert.ok(t.ok, JSON.stringify(t));
        }
      });
      reconcile(env, SOV.PHASE.HEAL, now);
      const successor = (after) => env.tx((db) => db.prepare(`SELECT count(*) AS n FROM world_scheduled_events
        WHERE idempotency_key = ?`).get(SOV.reconcileKey(1, SOV.PHASE.HEAL, after))).n;
      const held = (id) => systemOf(env, systemOfId.get(id)).controllerFactionId;
      assert.deepStrictEqual([env.sov.getStatus().counters.healed, held(ids[0]), held(ids[1]), successor(ids[0])],
        [1, null, GURISTAS, 1]);
    }));

  needsDriver("SOVX8: before the first ADOPT a captured system of C without a structure is "
    + "adoptPending -> the pretender waits (no ANCHOR); heartland / exempt C / after ADOPT / epoch row DESTROYED -> "
    + "not pending; after ADOPT the gate besieges C", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = X.bootSov(reopen(), shared, {}, null, { needsSovStructureOf: (f) => f !== SANSHA });
      heldSystem(env, H.S.N5, GURISTAS, 1000);
      heldSystem(env, H.S.N6, AMARR, null);
      heldSystem(env, H.S.N7, SANSHA, 2000);
      const now = shared.clock.now();
      const read = (sys) => env.tx((db) => env.sov.readForOccupationInTx(db, sys)).sov;
      const pending = () => [H.S.N5, H.S.N6, H.S.N7].map((sys) => read(sys).adoptPending);
      const gate = (sov) => {
        const e = M.evaluate(view({ controller: GURISTAS, sov: { ...sov, needs: () => true } }), tick, PARAMS);
        return [e.to, e.sovOps.map((o) => o.op), e.notes.includes(SOV.NOTES.ADOPT_PENDING)];
      };
      const before = pending();
      const waited = gate(read(H.S.N5));
      reconcile(env, SOV.PHASE.ADOPT, now);
      const afterAdopt = pending();
      const besieged = gate(read(H.S.N5));
      const id = SOV.grandfatheredIdOf(H.S.N5, GURISTAS, 1000);
      const row = X.rowOf(env, id);
      const killed = env.tx((db) => env.sovRepo.transition(db, { structure: row, to: SOV.DESTROYED,
        at: now, reason: SOV.REASON.LIVE_KILL, byFactionId: null }));
      assert.ok(killed.ok, JSON.stringify(killed));
      assert.deepStrictEqual({ before, waited, afterAdopt, besieged, destroyed: read(H.S.N5).adoptPending,
        anchorAfterKill: gate(read(H.S.N5)) }, {
        before: [true, false, false],
        waited: [null, [], true],
        afterAdopt: [false, false, false],
        besieged: [null, ["ATTACK"], false],
        destroyed: false,
        anchorAfterKill: [null, ["ANCHOR"], false],
      });
    }));
};
