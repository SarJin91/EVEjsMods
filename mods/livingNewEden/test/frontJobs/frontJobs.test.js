"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const killObservation = require("../../lib/adapter/killObservation");
const { startFrontJobs, createUnavailableFrontJobs, FACADE_METHODS } = require("../../lib/frontJobs");
const { applyContributionInTx } = require("../../lib/frontJobs/progress");
const { createFrontJobRepository } = require("../../lib/frontJobs/repository");
const { boardDayOf, boardWindowOf } = require("../../lib/frontJobs/rules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DAY = 86400000;
const AT = Date.UTC(2026, 10, 7, 12, 0, 0);
const CALDARI = 500001;
const MINMATAR = 500002;
const AMARR = 500003;
const GALLENTE = 500004;
const GURISTAS = 500010;
const S1 = 30000001;
const S2 = 30000002;
const S3 = 30000003;
const S4 = 30000004;
const S5 = 30000005;

const front = (systemId, controller, occupier, previous) => ({ systemId, controllerFactionId: controller,
  occupierFactionId: occupier, previousControllerFactionId: previous, occupationState: "INVASION" });

const FRONTS = [front(S1, GURISTAS, CALDARI, null), front(S2, CALDARI, null, GURISTAS),
  front(S3, MINMATAR, MINMATAR, MINMATAR), front(S4, null, AMARR, null), front(S5, GALLENTE, AMARR, null)];

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FRONT_JOBS_ENABLED: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

function fakeWorld(fronts) {
  const sorted = [...fronts].sort((a, b) => a.systemId - b.systemId);
  return { repository: { listActiveOccupations(_tx, opts) {
    const rows = sorted.filter((f) => f.systemId > opts.afterSystemId).slice(0, opts.limit);
    return { ok: true, systems: rows, nextAfterSystemId: rows.length === opts.limit ? rows[rows.length - 1].systemId
      : null };
  } } };
}

function boot(opened, env, clock, fronts = FRONTS) {
  const ctx = { persistence: { ok: true, store: opened.store, worldSeed: 4242 }, world: fakeWorld(fronts) };
  const started = startFrontJobs({ config: configOf(env), ctx, clock, adapter: null,
    setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.ok(started.ok, JSON.stringify(started));
  return started.frontJobs;
}

const rows = (store, sql, ...args) => {
  const r = store.transaction("t", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const jobsOf = (store) => rows(store, "SELECT job_id, day, slot, state, issuer_faction_id AS issuer, "
  + "target_faction_id AS target, system_id AS sys, completions FROM world_front_jobs ORDER BY day, slot");
const kill = (characterId, systemId, victimFactionId, atMs) => ({ characterId, victimFactionId, systemId, atMs,
  rewardable: true });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("FJ1-FJ3 front jobs", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("FJ1 generator: same day + new instance -> min(jobsPerDay, candidates) rows, same slots; issuer/target", () => {
      withStore(driver, (opened) => {
        const clock = { t: AT, now() { return this.t; } };
        const a = boot(opened, { EVEJS_LNE_FRONT_JOBS_JOBS_PER_DAY: "2" }, clock);
        let first;
        try {
          assert.deepStrictEqual(Object.keys(a), [...FACADE_METHODS]);
          assert.deepStrictEqual(Object.keys(createUnavailableFrontJobs("x")), [...FACADE_METHODS]);
          assert.strictEqual(killObservation.getFrontJobs(), a, "bridge registered");
          first = jobsOf(opened.store);
          assert.strictEqual(first.length, 2, "min(2, 3 candidates)");
          assert.deepStrictEqual(first.map((j) => j.slot), [0, 1]);
          clock.t = AT + 3600000;
          assert.deepStrictEqual(a.runPass(clock.t), { ok: true, generated: 0, expired: 0 });
        } finally {
          a.stop("test");
        }
        assert.strictEqual(killObservation.getFrontJobs(), null, "stop clears the bridge");
        const b = boot(opened, { EVEJS_LNE_FRONT_JOBS_JOBS_PER_DAY: "2" }, clock);
        try {
          assert.deepStrictEqual(jobsOf(opened.store), first, "restart on the same day adds nothing");
          const expected = { [S1]: [CALDARI, GURISTAS], [S2]: [GURISTAS, CALDARI], [S5]: [AMARR, GALLENTE] };
          for (const j of first) assert.deepStrictEqual([j.issuer, j.target], expected[j.sys], `system ${j.sys}`);
        } finally {
          b.stop("test");
        }
        clock.t = AT + DAY;
        const c = boot(opened, { EVEJS_LNE_FRONT_JOBS_JOBS_PER_DAY: "4" }, clock);
        try {
          const all = jobsOf(opened.store);
          const day2 = boardDayOf(clock.t, 11);
          assert.deepStrictEqual(all.filter((j) => j.day !== day2).map((j) => j.state), ["EXPIRED", "EXPIRED"]);
          const next = all.filter((j) => j.day === day2);
          assert.deepStrictEqual([next.length, next.map((j) => j.sys).sort()], [3, [S1, S2, S5]]);
          assert.deepStrictEqual(c.getStatus().counters.jobsExpired, 2);
        } finally {
          c.stop("test");
        }
      });
    });

    test("FJ2 progress: target kills -> one PENDING payout (pirate: lp SKIPPED), ALREADY_DONE, FILLED", () => {
      withStore(driver, (opened) => {
        const clock = { t: AT, now() { return this.t; } };
        const fj = boot(opened, { EVEJS_LNE_FRONT_JOBS_KILL_TARGET: "3",
          EVEJS_LNE_FRONT_JOBS_MAX_COMPLETIONS_PER_JOB: "2" }, clock, [FRONTS[0], FRONTS[1]]);
        try {
          const store = opened.store;
          const t = AT + 1000;
          assert.deepStrictEqual(fj.onNpcKill({ ...kill(9001, S1, GURISTAS, t), rewardable: undefined }).outcome,
            "IGNORED");
          assert.deepStrictEqual([1, 2, 3].map((i) => fj.onNpcKill(kill(9001, S1, GURISTAS, t + i)).outcome),
            ["PROGRESS", "PROGRESS", "COMPLETED"]);
          assert.strictEqual(fj.onNpcKill(kill(9001, S1, GURISTAS, t + 4)).outcome, "ALREADY_DONE");
          [1, 2, 3].forEach((i) => fj.onNpcKill(kill(9002, S2, CALDARI, t + i)));
          const pays = rows(store, "SELECT character_id AS c, isk_amount AS isk, lp_amount AS lp, lp_corporation_id AS "
            + "corp, standing_micro AS std, isk_state, lp_state, std_state, state FROM world_front_job_payouts "
            + "ORDER BY character_id");
          assert.deepStrictEqual(pays.map((p) => ({ ...p })), [
            { c: 9001, isk: 2000000, lp: 500, corp: 1000035, std: 5000, isk_state: "PENDING", lp_state: "PENDING",
              std_state: "PENDING", state: "PENDING" },
            { c: 9002, isk: 2000000, lp: 0, corp: null, std: 5000, isk_state: "PENDING", lp_state: "SKIPPED",
              std_state: "PENDING", state: "PENDING" }]);
          [1, 2, 3].forEach((i) => fj.onNpcKill(kill(9003, S1, GURISTAS, t + i)));
          const s1 = jobsOf(store).find((j) => j.sys === S1);
          assert.deepStrictEqual([s1.state, s1.completions], ["FILLED", 2]);
          assert.strictEqual(fj.onNpcKill(kill(9004, S1, GURISTAS, t + 9)).outcome, "NO_JOB", "filled job left the cache");
          const direct = store.transaction("t", (db) => applyContributionInTx(db, { repo: createFrontJobRepository(),
            params: { maxCompletionsPerCharacterDay: 5, resetHourUtc: 11 } },
          { jobId: s1.job_id, characterId: 9004, amount: 1, atMs: t + 9 }));
          assert.strictEqual(direct.value.outcome, "JOB_CLOSED");
          assert.strictEqual(rows(store, "SELECT count(*) AS n FROM world_front_job_payouts")[0].n, 3);
          assert.deepStrictEqual(fj.getStatus().counters.completions, 3);
        } finally {
          fj.stop("test");
        }
      });
    });

    test("FJ3 expiry: kill at expires_at -> EXPIRED before the pass, the pass expires; daily cap -> DAILY_CAP", () => {
      withStore(driver, (opened) => {
        const clock = { t: AT, now() { return this.t; } };
        const fj = boot(opened, { EVEJS_LNE_FRONT_JOBS_KILL_TARGET: "1",
          EVEJS_LNE_FRONT_JOBS_MAX_COMPLETIONS_PER_CHARACTER_DAY: "1" }, clock, [FRONTS[0], FRONTS[1]]);
        try {
          const store = opened.store;
          const { endMs } = boardWindowOf(boardDayOf(AT, 11), 11);
          assert.strictEqual(fj.onNpcKill(kill(9001, S1, GURISTAS, endMs)).outcome, "EXPIRED");
          assert.strictEqual(rows(store, "SELECT count(*) AS n FROM world_front_job_progress")[0].n, 0);
          assert.strictEqual(fj.onNpcKill(kill(9001, S1, GURISTAS, AT + 1)).outcome, "COMPLETED");
          assert.strictEqual(fj.onNpcKill(kill(9001, S2, CALDARI, AT + 2)).outcome, "DAILY_CAP");
          const prog = rows(store, "SELECT progress, state, done_at FROM world_front_job_progress "
            + "WHERE character_id = 9001 ORDER BY state");
          assert.deepStrictEqual(prog.map((p) => [p.progress, p.state, p.done_at === null]), [[1, "DONE", false]]);
          assert.strictEqual(rows(store, "SELECT count(*) AS n FROM world_front_job_payouts")[0].n, 1);
          clock.t = endMs;
          const pass = fj.runPass(endMs);
          assert.strictEqual(pass.expired, 2);
          const day1 = boardDayOf(AT, 11);
          assert.deepStrictEqual(jobsOf(store).filter((j) => j.day === day1).map((j) => j.state),
            ["EXPIRED", "EXPIRED"]);
          assert.strictEqual(fj.getStatus().counters.dailyCapped, 1);
        } finally {
          fj.stop("test");
        }
      });
    });
  }

  test("FJ4 flag off: disabled_by_config, no kill listener, no transaction", () => {
    const off = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    assert.strictEqual(off.frontJobs.enabled, false, "default off");
    let calls = 0;
    const store = { transaction() { calls += 1; return { ok: false, reason: "COUNTED" }; }, getWorldSeed: () => 1 };
    const r = startFrontJobs({ config: off, ctx: { persistence: { ok: true, store, worldSeed: 1 },
      world: fakeWorld(FRONTS) }, clock: { now: () => AT }, setTimer: () => assert.fail("no timer") });
    assert.deepStrictEqual(r, { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(killObservation.getFrontJobs(), null);
    assert.strictEqual(calls, 0);
  });
};
