"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { startFrontJobs } = require("../../lib/frontJobs");
const { applyContributionInTx } = require("../../lib/frontJobs/progress");
const { createFrontJobRepository } = require("../../lib/frontJobs/repository");
const { settleClearInTx } = require("../../lib/frontJobs/kinds/clear");
const { settleDeliverInTx } = require("../../lib/frontJobs/kinds/deliver");
const { boardDayOf, boardWindowOf } = require("../../lib/frontJobs/rules");
const scanObs = require("../../lib/adapter/scanObservation");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const AT = Date.UTC(2026, 10, 7, 12, 0, 0);
const CALDARI = 500001;
const GURISTAS = 500010;
const S1 = 30000001;
const S2 = 30000002;
const FRONTS = [{ systemId: S1, controllerFactionId: GURISTAS, occupierFactionId: CALDARI,
  previousControllerFactionId: null, occupationState: "INVASION" }, { systemId: S2, controllerFactionId: CALDARI,
  occupierFactionId: null, previousControllerFactionId: GURISTAS, occupationState: "INVASION" }];
const silent = { log() {}, debug() {}, logError() {} };

const repo = createFrontJobRepository();
const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const all = (store, sql) => run(store, (db) => db.prepare(sql).all());
const world = { repository: { listActiveOccupations: (_tx, o) => ({ ok: true,
  systems: FRONTS.filter((f) => f.systemId > o.afterSystemId).slice(0, o.limit), nextAfterSystemId: null }) } };

function start(store, env, now) {
  const cfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FRONT_JOBS_ENABLED: "1",
    EVEJS_LNE_FRONT_JOBS_JOBS_PER_DAY: "2", ...env } });
  assert.ok(cfg.ok, JSON.stringify(cfg.errors));
  const started = startFrontJobs({ config: cfg.config, ctx: { persistence: { ok: true, store, worldSeed: 4242 },
    world }, clock: { now: () => now }, adapter: null, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.ok(started.ok, JSON.stringify(started));
  return started.frontJobs;
}

module.exports = ({ test, skip }) => {
  test("FS1 vendor facts: module-object call with characterID, perfectSignatureIDs, combat ids numeric", () => {
    const mgr = fs.readFileSync(path.join(SERVER_SRC, "services", "exploration", "scanMgrService.js"), "utf8");
    const at = mgr.indexOf("probeScanRuntime.buildSignatureScanResults(");
    assert.ok(at > 0, "(a) call through the module object");
    assert.ok(!/\{[^}]*\bbuildSignatureScanResults\b[^}]*\}\s*=\s*(require|probeScanRuntime)/.test(mgr),
      "(a) no destructuring of the wrapped export");
    assert.ok(/^\s*characterID,\s*$/m.test(mgr.slice(at, at + 900)), "(b) characterID in the options of the call");
    const rt = fs.readFileSync(path.join(SERVER_SRC, "services", "exploration", "probes", "probeScanRuntime.js"),
      "utf8");
    const def = rt.slice(rt.indexOf("function buildSignatureScanResults("));
    const body = def.slice(0, def.search(/^\}/m));
    assert.ok(/^\s{4}perfectSignatureIDs,\s*$/m.test(body), "(c) the result has perfectSignatureIDs");
    assert.ok(/listCombatTargetSites\(options\)/.test(body), "Combat targets join the sites");
    assert.ok(/siteID: itemID,\s*\n\s*targetID: itemID,/.test(rt), "A combat target id is the numeric itemID");
    const sig = fs.readFileSync(path.join(SERVER_SRC, "services", "exploration", "signatures", "signatureRuntime.js"),
      "utf8");
    assert.ok(sig.includes("targetID: String(site && site.targetID || \"\").trim().toUpperCase()"),
      "A signature id is a string");
    assert.ok(/module\.exports = \{[\s\S]*?\n\s+buildSignatureScanResults,/.test(rt), "export on the module object");
  });

  test("FS2 observeScan: no perfect -> no call; perfect -> listener; throw contained; no listener", () => {
    const seen = [];
    let throws = false;
    const listener = { onPerfectScan(s) {
      if (throws) throw new Error("boom");
      seen.push(s);
      return { ok: true };
    } };
    const deps = { getFrontJobsScan: () => listener, now: () => AT };
    assert.deepStrictEqual(scanObs.observeScan({ perfectSignatureIDs: [] }, S1, { characterID: 9001 }, deps),
      { skipped: "NO_PERFECT" });
    assert.deepStrictEqual(scanObs.observeScan({ perfectSignatureIDs: [1000000123] }, S1, { characterID: 9001 }, deps),
      { skipped: "NO_PERFECT" }, "a combat target id never counts");
    assert.deepStrictEqual(scanObs.observeScan({ perfectSignatureIDs: ["ABC-123"] }, S1, {}, deps),
      { skipped: "NO_CHARACTER" });
    assert.strictEqual(seen.length, 0);
    scanObs.observeScan({ perfectSignatureIDs: [1000000123, "ABC-123"] }, S1, { characterID: 9001 }, deps);
    assert.deepStrictEqual(seen, [{ characterId: 9001, systemId: S1, atMs: AT, signatureIds: ["ABC-123"] }]);
    throws = true;
    const r = scanObs.observeScan({ perfectSignatureIDs: ["ABC-123"] }, S1, { characterID: 9001 }, deps);
    assert.strictEqual(r.result.reason, "LISTENER_THREW");
    assert.deepStrictEqual(scanObs.observeScan({ perfectSignatureIDs: ["ABC-123"] }, S1, { characterID: 9001 },
      { getFrontJobsScan: () => null, now: () => AT }), { skipped: "NO_HANDLER" });
  });

  test("FS3 wrap idempotent, result === original's; loader hook only with scanEnabled", () => {
    const vendorResult = { perfectSignatureIDs: ["ABC-123"] };
    let calls = 0;
    const original = function original() {
      calls += 1;
      return vendorResult;
    };
    const w = scanObs.wrapSignatureScanResults(original, { getFrontJobsScan: () => ({ onPerfectScan() {
      throw new Error("listener fault");
    } }), now: () => AT });
    assert.ok(w.ok);
    assert.strictEqual(w.wrapped(S1, new Map(), { characterID: 9001 }), vendorResult);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(scanObs.wrapSignatureScanResults(w.wrapped), { ok: true, wrapped: w.wrapped, noop: true });
    assert.deepStrictEqual(scanObs.wrapSignatureScanResults(null), { ok: false, reason: "NOT_A_FUNCTION" });
    const { buildHooks } = require("../../loader");
    const hookRun = (scanEnabled) => {
      const config = { enabled: true, modules: { world: { enabled: true } }, occupation: { enabled: true },
        frontJobs: { enabled: true, scanEnabled } };
      const ctx = { logger: silent, state: { configResult: { ok: true, config } } };
      const hook = buildHooks(ctx).find((h) => h.name === "frontJobsScan");
      const exportsObj = { buildSignatureScanResults: original };
      assert.strictEqual(hook.match("x/services/exploration/probes/probeScanRuntime.js", exportsObj), true);
      hook.run(exportsObj, "probeScanRuntime", null);
      return [ctx.state.frontJobsScan, exportsObj.buildSignatureScanResults[scanObs.WRAPPED] === true];
    };
    assert.deepStrictEqual(hookRun(false), ["disabled", false]);
    assert.deepStrictEqual(hookRun(true), ["wrapped", true]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("FS4-FS5 front job SCAN / day boundary", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FS4 service: SCAN job, perfect scan through the wrap -> DONE + payout, again ALREADY_DONE; off -> null", () => {
    scanObs.setScanWrapMounted(true);
    withStore(driver, ({ store }) => {
      const fj = start(store, { EVEJS_LNE_FRONT_JOBS_SCAN_ENABLED: "1" }, AT);
      try {
        const jobs = all(store, "SELECT job_id, system_id AS s, max_completions AS m, isk_amount AS isk, description "
          + "FROM world_front_jobs WHERE kind = 'SCAN'");
        assert.strictEqual(jobs.length, 1);
        assert.deepStrictEqual([jobs[0].m, jobs[0].isk], [3, 1500000]);
        assert.ok(jobs[0].description.startsWith("Scan a signature in"), jobs[0].description);
        const sys = jobs[0].s;
        const other = sys === S1 ? S2 : S1;
        const w = scanObs.wrapSignatureScanResults(() => ({ perfectSignatureIDs: ["XYZ-001"] }), { now: () => AT + 5 });
        w.wrapped(other, new Map(), { characterID: 9001 });
        assert.strictEqual(all(store, "SELECT count(*) AS n FROM world_front_job_payouts")[0].n, 0, "other system");
        w.wrapped(sys, new Map(), { characterID: 9001 });
        const pays = all(store, "SELECT character_id AS c, job_id, isk_amount AS isk FROM world_front_job_payouts");
        assert.deepStrictEqual(pays.map((p) => [p.c, p.job_id, p.isk]), [[9001, jobs[0].job_id, 1500000]]);
        const again = scanObs.observeScan({ perfectSignatureIDs: ["XYZ-001"] }, sys, { characterID: 9001 },
          { getFrontJobsScan: scanObs.getFrontJobsScan, now: () => AT + 6 });
        assert.strictEqual(again.result.outcome, "ALREADY_DONE");
        const st = fj.getStatus();
        assert.deepStrictEqual([st.counters.scansObserved, st.counters.scansMatched, st.counters.completions,
          st.kinds.scan, st.kinds.scanListener], [3, 2, 1, true, true]);
      } finally {
        fj.stop("test");
      }
      assert.strictEqual(scanObs.getFrontJobsScan(), null, "stop clears the listener");
    });
    withStore(driver, ({ store }) => {
      const fj = start(store, {}, AT);
      try {
        assert.strictEqual(scanObs.getFrontJobsScan(), null, "scanEnabled off -> no listener");
        assert.strictEqual(all(store, "SELECT count(*) AS n FROM world_front_jobs WHERE kind = 'SCAN'")[0].n, 0);
      } finally {
        fj.stop("test");
      }
    });
  });

  test("FS6: scanEnabled without the mounted wrap -> no SCAN job, slot to KILL, scanSeamMissing", () => {
    const before = scanObs.isScanWrapMounted();
    scanObs.setScanWrapMounted(false);
    try {
      withStore(driver, ({ store }) => {
        const fj = start(store, { EVEJS_LNE_FRONT_JOBS_SCAN_ENABLED: "1" }, AT);
        try {
          const kinds = all(store, "SELECT kind FROM world_front_jobs ORDER BY slot").map((r) => r.kind);
          assert.deepStrictEqual(kinds, ["KILL", "KILL"]);
          const st = fj.getStatus();
          assert.deepStrictEqual([st.counters.scanSeamMissing, st.kinds.scan, st.kinds.scanWrapMounted,
            st.kinds.scanListener], [1, true, false, false]);
          assert.ok(String(st.lastRefusal).includes("SCAN:NO_WRAP"), String(st.lastRefusal));
        } finally {
          fj.stop("test");
        }
      });
    } finally {
      scanObs.setScanWrapMounted(before);
    }
  });

  test("FS5 day boundary: ref finished before expiresAt paid after the end; CLEAR without eligible -> EXPIRED", () => {
    withStore(driver, ({ store }) => {
      const day = boardDayOf(AT, 11);
      const end = boardWindowOf(day, 11).endMs;
      run(store, (db) => db.prepare(`INSERT INTO world_event_sites (site_key, event_id, slot, system_id, template_id,
        label, faction_id, request_hash, state, expires_at, next_attempt_at, created_at, updated_at)
        VALUES ('lne:ev1:0', 'ev1', 0, ?, 'tpl', 'Den', ?, ?, 'ACTIVE', ?, ?, ?, ?)`)
        .run(S1, GURISTAS, "a".repeat(64), end + 86400000, AT, AT, AT));
      const fj = start(store, { EVEJS_LNE_FRONT_JOBS_CLEAR_ENABLED: "1" }, AT);
      try {
        const job = all(store, "SELECT job_id FROM world_front_jobs WHERE kind = 'CLEAR'")[0];
        assert.ok(job, "CLEAR job on the board");
        fj.onNpcKill({ characterId: 9001, victimFactionId: 500099, systemId: S1, atMs: AT + 1, rewardable: true });
        run(store, (db) => db.prepare("UPDATE world_event_sites SET state = 'COMPLETED', updated_at = ? "
          + "WHERE site_key = 'lne:ev1:0'").run(end - 1000));
        fj.runPass(end + 10);
        const pays = all(store, "SELECT character_id AS c, job_id, planned_at AS p FROM world_front_job_payouts");
        assert.deepStrictEqual(pays.map((p) => [p.c, p.job_id, p.p]), [[9001, job.job_id, end - 1000]]);
        assert.strictEqual(all(store, `SELECT state FROM world_front_jobs WHERE job_id = '${job.job_id}'`)[0].state,
          "FILLED");
        assert.strictEqual(fj.getStatus().counters.clearSettled, 1);
      } finally {
        fj.stop("test");
      }
    });
    withStore(driver, ({ store }) => {
      const day = boardDayOf(AT, 11);
      const end = boardWindowOf(day, 11).endMs;
      const params = { resetHourUtc: 11, maxCompletionsPerCharacterDay: 5, clearMinKills: 2 };
      const mk = (slot, kind, ref) => {
        const job = { jobId: `fj:${day}:${slot}:${AT}`, day, slot, kind, state: "OPEN", issuerFactionId: CALDARI,
          targetFactionId: null, systemId: S1, regionId: null, targetCount: 1, ref, iskAmount: 1, lpAmount: 0,
          lpCorporationId: null, standingMicro: 0, maxCompletions: 3, description: `${kind} job`, createdAt: AT,
          expiresAt: end };
        run(store, (db) => assert.ok(repo.insertJobInTx(db, job).ok));
        return job;
      };
      const unclaimed = mk(0, "CLEAR", "lne:a:0");
      const lateSite = mk(1, "CLEAR", "lne:b:0");
      const deliver = mk(2, "DELIVER", "to-1");
      const sites = { "lne:a:0": { state: "COMPLETED", updatedAt: AT + 50 },
        "lne:b:0": { state: "COMPLETED", updatedAt: end + 1 } };
      const deps = { repo, params, sites: { getByKeyInTx: (_tx, k) => sites[k] || null },
        offers: { getOffer: () => ({ ok: true, offer: { state: "ACCEPTED", acceptorCharacterId: 9002,
          updatedAt: end - 5 } }) } };
      run(store, (db) => applyContributionInTx(db, deps, { jobId: unclaimed.jobId, characterId: 9001, amount: 1,
        atMs: AT + 1 }));
      assert.deepStrictEqual(run(store, (db) => settleClearInTx(db, unclaimed, deps, AT + 100)),
        { ok: true, outcome: "LOST", completions: 0 }, "kills under clearMinKills -> EXPIRED, not FILLED");
      assert.strictEqual(run(store, (db) => settleClearInTx(db, lateSite, deps, end + 10)).outcome, "WAIT",
        "COMPLETED after the end -> left to the expiry");
      assert.deepStrictEqual(run(store, (db) => settleDeliverInTx(db, deliver, deps, end + 10)),
        { ok: true, outcome: "SETTLED", characterId: 9002 });
      assert.deepStrictEqual(all(store, "SELECT state FROM world_front_jobs ORDER BY slot").map((r) => r.state),
        ["EXPIRED", "OPEN", "FILLED"]);
      assert.deepStrictEqual(all(store, "SELECT character_id AS c, planned_at AS p FROM world_front_job_payouts")
        .map((r) => [r.c, r.p]), [[9002, end - 5]]);
    });
  });
};
