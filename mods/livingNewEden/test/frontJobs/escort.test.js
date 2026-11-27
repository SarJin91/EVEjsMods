"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { startFrontJobs, createUnavailableFrontJobs, FACADE_METHODS } = require("../../lib/frontJobs");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const CALDARI = 500001;
const GURISTAS = 500010;
const S1 = 30000001;
const S2 = 30000002;
const DEST = 30000099;
const FRONTS = [{ systemId: S1, controllerFactionId: GURISTAS, occupierFactionId: CALDARI,
  previousControllerFactionId: null, occupationState: "INVASION" }, { systemId: S2, controllerFactionId: CALDARI,
  occupierFactionId: null, previousControllerFactionId: GURISTAS, occupationState: "INVASION" }];
const world = { repository: { listActiveOccupations: (_tx, o) => ({ ok: true,
  systems: FRONTS.filter((f) => f.systemId > o.afterSystemId).slice(0, o.limit), nextAfterSystemId: null }) } };
const ESCORT_ON = Object.freeze({ EVEJS_LNE_FRONT_JOBS_ESCORT_ENABLED: "1" });

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const all = (store, sql) => run(store, (db) => db.prepare(sql).all());
const BOARD_SQL = "SELECT slot, kind, issuer_faction_id AS i, target_faction_id AS t, system_id AS s, target_count AS n, "
  + "max_completions AS m, isk_amount AS isk, lp_amount AS lp, description AS d FROM world_front_jobs ORDER BY slot";

function logisticsOf(byFaction) {
  return { readOpen: (_tx, factionId, opts) => {
    const list = byFaction[factionId] || [];
    return { ok: true, truncated: list.length > opts.limit, convoys: list.slice(0, opts.limit) };
  } };
}

function start(store, env, logistics) {
  const cfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FRONT_JOBS_ENABLED: "1",
    EVEJS_LNE_FRONT_JOBS_JOBS_PER_DAY: "2", ...env } });
  assert.ok(cfg.ok, JSON.stringify(cfg.errors));
  const started = startFrontJobs({ config: cfg.config, ctx: { persistence: { ok: true, store, worldSeed: 4242 },
    world, logistics }, clock: { now: () => AT }, adapter: null, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.ok(started.ok, JSON.stringify(started));
  return started.frontJobs;
}

function board(driver, env, logistics) {
  return withStore(driver, ({ store }) => {
    const fj = start(store, env, logistics);
    try {
      return all(store, BOARD_SQL);
    } finally {
      fj.stop("test");
    }
  });
}

module.exports = ({ test, skip }) => {
  test("E3 the real facade and the stub have the keys of FACADE_METHODS; the stub refuses", () => {
    assert.ok(FACADE_METHODS.includes("onEscortCrossing"));
    const stub = createUnavailableFrontJobs("x");
    assert.deepStrictEqual(Object.keys(stub), [...FACADE_METHODS]);
    assert.deepStrictEqual(stub.onEscortCrossing({ ownerFactionId: CALDARI, systemId: S1, characterIds: [1], atMs: AT }),
      { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" });
    const driver = loadDriver();
    if (!driver.ok) return;
    withStore(driver, ({ store }) => {
      const fj = start(store, ESCORT_ON, logisticsOf({}));
      try {
        assert.deepStrictEqual(Object.keys(fj), [...FACADE_METHODS]);
      } finally {
        fj.stop("test");
      }
    });
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("E1-E2 front job ESCORT", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("E1 generator: open convoy -> ESCORT in the last slot at destSystemId; no convoy -> the board of the flag off",
    () => {
      const off = board(driver, {}, logisticsOf({}));
      assert.deepStrictEqual(off.map((r) => r.kind), ["KILL", "KILL"]);
      const on = board(driver, ESCORT_ON, logisticsOf({ [CALDARI]: [{ convoyId: "c1", destSystemId: DEST },
        { convoyId: "c2", destSystemId: S2 }], [GURISTAS]: [{ convoyId: "g1", destSystemId: null }] }));
      assert.deepStrictEqual(on.map((r) => r.kind), ["KILL", "ESCORT"]);
      assert.deepStrictEqual(on[0], off[0], "the KILL draw is unchanged");
      assert.deepStrictEqual(on[1], { slot: 1, kind: "ESCORT", i: CALDARI, t: null, s: DEST, n: 3, m: 3, isk: 1500000,
        lp: 400, d: `Escort 3 convoy jumps for ${CALDARI}` });
      const none = board(driver, ESCORT_ON, logisticsOf({ [GURISTAS]: [{ convoyId: "g1", destSystemId: null }] }));
      assert.deepStrictEqual(none, off, "no convoy -> no ESCORT, the slots go to KILL");
    });

  test("E2 onEscortCrossing: three crossings -> DONE + payout PENDING; a miss -> no transaction, escortMiss 1", () => {
    withStore(driver, ({ store }) => {
      let txs = 0;
      const spy = { ...store, transaction: (name, fn) => {
        txs += 1;
        return store.transaction(name, fn);
      } };
      const fj = start(spy, ESCORT_ON, logisticsOf({ [CALDARI]: [{ convoyId: "c1", destSystemId: DEST }] }));
      try {
        const job = all(store, "SELECT job_id FROM world_front_jobs WHERE kind = 'ESCORT'")[0];
        assert.ok(job, "ESCORT job on the board");
        const before = txs;
        const cross = (owner, ids, dt) => fj.onEscortCrossing({ ownerFactionId: owner, systemId: S1, characterIds: ids,
          atMs: AT + dt });
        assert.deepStrictEqual(cross(GURISTAS, [9001], 1), { ok: true, credited: 0, outcome: "NO_JOB" });
        assert.strictEqual(cross(CALDARI, [1, 2, 3, 4, 5], 1).reason, "INVALID_INPUT");
        assert.strictEqual(txs, before, "a miss and an invalid call open no transaction");
        for (const dt of [2, 3, 4]) {
          assert.deepStrictEqual(cross(CALDARI, [9001], dt), { ok: true, credited: 1, outcome: "APPLIED" });
        }
        assert.strictEqual(txs, before + 3);
        assert.deepStrictEqual(all(store, "SELECT character_id AS c, state, progress FROM world_front_job_progress"),
          [{ c: 9001, state: "DONE", progress: 3 }]);
        assert.deepStrictEqual(all(store, "SELECT job_id, character_id AS c, isk_amount AS isk, lp_amount AS lp, state "
          + "FROM world_front_job_payouts"), [{ job_id: job.job_id, c: 9001, isk: 1500000, lp: 400, state: "PENDING" }]);
        const c = fj.getStatus().counters;
        assert.deepStrictEqual([c.escortMiss, c.escortCredited, c.contributions, c.completions, c.escortErrors],
          [1, 3, 3, 1, 0]);
      } finally {
        fj.stop("test");
      }
    });
  });
};
