"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { startFrontJobs } = require("../../lib/frontJobs");
const { applyContributionInTx } = require("../../lib/frontJobs/progress");
const { createFrontJobRepository } = require("../../lib/frontJobs/repository");
const { ensureBoardInTx } = require("../../lib/frontJobs/generator");
const { settleClearInTx } = require("../../lib/frontJobs/kinds/clear");
const { settleDeliverInTx, pickDeliverCandidatesInTx } = require("../../lib/frontJobs/kinds/deliver");
const { boardDayOf, boardWindowOf } = require("../../lib/frontJobs/rules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 7, 12, 0, 0);
const DAY = 86400000;
const CALDARI = 500001;
const GURISTAS = 500010;
const S1 = 30000001;
const S2 = 30000002;
const FRONTS = [{ systemId: S1, controllerFactionId: GURISTAS, occupierFactionId: CALDARI,
  previousControllerFactionId: null, occupationState: "INVASION" }, { systemId: S2, controllerFactionId: CALDARI,
  occupierFactionId: null, previousControllerFactionId: GURISTAS, occupationState: "INVASION" }];
const PARAMS = Object.freeze({ resetHourUtc: 11, maxCompletionsPerCharacterDay: 5, clearMinKills: 2 });

const repo = createFrontJobRepository();
const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const all = (store, sql) => run(store, (db) => db.prepare(sql).all());

function insertJob(store, slot, kind, ref, maxCompletions) {
  const day = boardDayOf(AT, 11);
  const job = { jobId: `fj:${day}:${slot}:${AT}`, day, slot, kind, state: "OPEN", issuerFactionId: CALDARI,
    targetFactionId: null, systemId: S1, regionId: null, targetCount: 1, ref, iskAmount: 4000000, lpAmount: 1000,
    lpCorporationId: 1000035, standingMicro: 5000, maxCompletions, description: `${kind} job`, createdAt: AT,
    expiresAt: boardWindowOf(day, 11).endMs };
  run(store, (db) => assert.ok(repo.insertJobInTx(db, job).ok));
  return job;
}

const fakeSites = (byKey) => ({ getByKeyInTx: (_tx, k) => byKey[k] || null, listVisibleBySystemInTx: () => [] });
const fakeOffers = (byId) => ({ getOffer: (_tx, id) => ({ ok: true, offer: byId[id] || null }),
  listOpenOfFaction: () => ({ ok: true, offers: [], truncated: false }) });

module.exports = ({ test, skip }) => {
  test("WD1: DELIVER skips a war offer; isWarOffer throws -> skipped; absent -> both",
    () => {
      const offer = (offerId) => ({ offerId, state: "OPEN", channel: "contract", side: "buy", assigneeCharacterId: null,
        systemId: S2, typeId: 34, quantity: 100, expiresAt: AT + DAY });
      const offers = { listOpenOfFaction: (_tx, f) => ({ ok: true,
        offers: f === CALDARI ? [offer("to_b"), offer("to_a")] : [] }) };
      const pick = (isWarOffer) => {
        const r = pickDeliverCandidatesInTx({}, FRONTS, { offers, params: { deliverScanLimit: 20 },
          ...(isWarOffer ? { isWarOffer } : {}) }, { nextInt: (min) => min }, 5, AT);
        assert.ok(r.ok, JSON.stringify(r));
        return r.candidates.map((c) => c.ref).sort();
      };
      assert.deepStrictEqual(pick(null), ["to_a", "to_b"], "no isWarOffer -> as before");
      assert.deepStrictEqual(pick((_tx, id) => id === "to_a"), ["to_b"], "the war offer is skipped");
      assert.deepStrictEqual(pick(() => {
        throw new Error("read failed");
      }), [], "fail-closed: a throw skips the offer");
    });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("FK1-FK5 front job kinds", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FK1 CLEAR: site COMPLETED -> DONE for clearMaxCompletions newest characters, FILLED, second settle no-op", () => {
    withStore(driver, ({ store }) => {
      const job = insertJob(store, 0, "CLEAR", "lne:ev1:0", 2);
      const site = { siteKey: "lne:ev1:0", state: "ACTIVE" };
      const deps = { repo, params: PARAMS, sites: fakeSites({ "lne:ev1:0": site }) };
      const kills = [[9001, 1], [9001, 2], [9003, 5], [9003, 6], [9002, 8], [9002, 9], [9004, 10]];
      const outcomes = kills.map(([c, t]) => run(store, (db) => applyContributionInTx(db, deps,
        { jobId: job.jobId, characterId: c, amount: 1, atMs: AT + t })).outcome);
      assert.ok(outcomes.every((o) => o === "PROGRESS"), "a CLEAR kill never completes");
      assert.deepStrictEqual(run(store, (db) => settleClearInTx(db, job, deps, AT + 20)).outcome, "WAIT");
      site.state = "COMPLETED";
      assert.deepStrictEqual(run(store, (db) => settleClearInTx(db, job, deps, AT + 21)),
        { ok: true, outcome: "SETTLED", completions: 2 });
      const pays = all(store, "SELECT character_id AS c, isk_amount AS isk, state FROM world_front_job_payouts "
        + "ORDER BY character_id");
      assert.deepStrictEqual(pays.map((p) => [p.c, p.isk, p.state]), [[9002, 4000000, "PENDING"],
        [9003, 4000000, "PENDING"]]);
      const row = all(store, "SELECT state, completions FROM world_front_jobs")[0];
      assert.deepStrictEqual([row.state, row.completions], ["FILLED", 2]);
      assert.strictEqual(run(store, (db) => settleClearInTx(db, job, deps, AT + 22)).outcome, "CLOSED");
      assert.strictEqual(all(store, "SELECT count(*) AS n FROM world_front_job_payouts")[0].n, 2);
    });
  });

  test("FK2 CLEAR: site LOST or no row -> EXPIRED, zero payouts", () => {
    withStore(driver, ({ store }) => {
      const lost = insertJob(store, 0, "CLEAR", "lne:ev1:0", 3);
      const gone = insertJob(store, 1, "CLEAR", "lne:ev2:0", 3);
      const deps = { repo, params: PARAMS, sites: fakeSites({ "lne:ev1:0": { siteKey: "lne:ev1:0", state: "LOST" } }) };
      [9001, 9001].forEach((c, i) => run(store, (db) => applyContributionInTx(db, deps,
        { jobId: lost.jobId, characterId: c, amount: 1, atMs: AT + i })));
      assert.strictEqual(run(store, (db) => settleClearInTx(db, lost, deps, AT + 5)).outcome, "LOST");
      assert.strictEqual(run(store, (db) => settleClearInTx(db, gone, deps, AT + 5)).outcome, "LOST");
      assert.deepStrictEqual(all(store, "SELECT state FROM world_front_jobs ORDER BY slot").map((r) => r.state),
        ["EXPIRED", "EXPIRED"]);
      assert.strictEqual(all(store, "SELECT count(*) AS n FROM world_front_job_payouts")[0].n, 0);
    });
  });

  test("FK3 DELIVER: ACCEPTED with acceptor -> 1 payout, FILLED; CANCELLED -> EXPIRED", () => {
    withStore(driver, ({ store }) => {
      const okJob = insertJob(store, 0, "DELIVER", "to-1", 1);
      const cancelled = insertJob(store, 1, "DELIVER", "to-2", 1);
      const offers = { "to-1": { offerId: "to-1", state: "OPEN", acceptorCharacterId: null },
        "to-2": { offerId: "to-2", state: "CANCELLED", acceptorCharacterId: null } };
      const deps = { repo, params: PARAMS, offers: fakeOffers(offers) };
      assert.strictEqual(run(store, (db) => settleDeliverInTx(db, okJob, deps, AT + 1)).outcome, "WAIT");
      offers["to-1"] = { offerId: "to-1", state: "ACCEPTED", acceptorCharacterId: 9001 };
      assert.deepStrictEqual(run(store, (db) => settleDeliverInTx(db, okJob, deps, AT + 2)),
        { ok: true, outcome: "SETTLED", characterId: 9001 });
      assert.strictEqual(run(store, (db) => settleDeliverInTx(db, okJob, deps, AT + 3)).outcome, "CLOSED");
      assert.strictEqual(run(store, (db) => settleDeliverInTx(db, cancelled, deps, AT + 3)).outcome, "LOST");
      assert.deepStrictEqual(all(store, "SELECT state FROM world_front_jobs ORDER BY slot").map((r) => r.state),
        ["FILLED", "EXPIRED"]);
      const pays = all(store, "SELECT character_id AS c FROM world_front_job_payouts");
      assert.deepStrictEqual(pays.map((p) => p.c), [9001]);
    });
  });

  test("FK4 generator: flags off -> readers untouched; no candidates -> KILL; candidates -> CLEAR/DELIVER last", () => {
    withStore(driver, ({ store }) => {
      const calls = { sites: 0, offers: 0 };
      let siteRows = [];
      let offerRows = [];
      const sites = { listVisibleBySystemInTx: () => { calls.sites += 1; return siteRows; },
        getByKeyInTx: () => { calls.sites += 1; return null; } };
      const offers = { listOpenOfFaction: () => { calls.offers += 1; return { ok: true, offers: offerRows }; },
        getOffer: () => { calls.offers += 1; return { ok: true, offer: null }; } };
      const base = { resetHourUtc: 11, jobsPerDay: 3, frontScanLimit: 50, empireIssuerWeight: 3, killTarget: 10,
        maxCompletionsPerJob: 3, killIsk: 2000000, killLp: 500, standingRaw: 0.005, maxClearPerDay: 1,
        clearMaxCompletions: 4, clearIsk: 4000000, clearLp: 1000, clearSiteScanLimit: 8, maxDeliverPerDay: 1,
        deliverScanLimit: 20, deliverIsk: 1500000, deliverLp: 400 };
      const world = { listActiveOccupations: (_tx, o) => {
        const rows = FRONTS.filter((f) => f.systemId > o.afterSystemId).slice(0, o.limit);
        return { ok: true, systems: rows, nextAfterSystemId: null };
      } };
      const board = (params, at) => run(store, (db) => ensureBoardInTx(db, { repo, params, worldSeed: 7, sites, offers,
        lpCorpOf: (f) => (f === CALDARI ? 1000035 : null), getWorldRepository: () => world,
        typeName: (id) => (id === 34 ? "Tritanium" : null) }, at));
      const kinds = (day) => all(store, `SELECT slot, kind, ref, max_completions AS m, isk_amount AS isk, description
        FROM world_front_jobs WHERE day = ${day} ORDER BY slot`);
      const d0 = boardDayOf(AT, 11);
      assert.strictEqual(board({ ...base, clearEnabled: false, deliverEnabled: false }, AT).created, 2);
      assert.deepStrictEqual([calls, kinds(d0).map((j) => j.kind)], [{ sites: 0, offers: 0 }, ["KILL", "KILL"]]);
      board({ ...base, clearEnabled: true, deliverEnabled: true }, AT + DAY);
      assert.deepStrictEqual(kinds(d0 + 1).map((j) => j.kind), ["KILL", "KILL"]);
      assert.ok(calls.sites > 0 && calls.offers > 0, "flags on read the foreign tables");
      siteRows = [{ siteKey: "lne:ev9:0", state: "COMPLETED", factionId: GURISTAS, label: "Old" },
        { siteKey: "lne:ev8:0", state: "ACTIVE", factionId: GURISTAS, label: "Guristas Den" }];
      offerRows = [{ offerId: "to-7", state: "OPEN", channel: "contract", side: "buy", assigneeCharacterId: null,
        systemId: S2, typeId: 34, quantity: 5000, expiresAt: AT + 10 * DAY },
      { offerId: "to-6", state: "OPEN", channel: "contract", side: "buy", assigneeCharacterId: 9001,
        systemId: S2, typeId: 34, quantity: 5000, expiresAt: AT + 10 * DAY }];
      board({ ...base, clearEnabled: true, deliverEnabled: true }, AT + 2 * DAY);
      const d2 = kinds(d0 + 2);
      assert.deepStrictEqual(d2.map((j) => [j.slot, j.kind, j.ref, j.m]), [[0, "KILL", null, 3],
        [1, "CLEAR", "lne:ev8:0", 4], [2, "DELIVER", "to-7", 1]]);
      assert.deepStrictEqual([d2[1].isk, d2[2].isk], [4000000, 1500000]);
      assert.ok(d2[1].description.startsWith("Clear Guristas Den in"), d2[1].description);
      assert.ok(d2[2].description.startsWith("Deliver 5000 Tritanium to"), d2[2].description);
    });
  });

  test("FK5 service: CLEAR job on a real site row, any-faction kill counts, COMPLETED -> the pass pays", () => {
    withStore(driver, ({ store }) => {
      run(store, (db) => db.prepare(`INSERT INTO world_event_sites (site_key, event_id, slot, system_id, template_id,
        label, faction_id, request_hash, state, expires_at, next_attempt_at, created_at, updated_at)
        VALUES ('lne:ev1:0', 'ev1', 0, ?, 'tpl', 'Den', ?, ?, 'ACTIVE', ?, ?, ?, ?)`)
        .run(S1, GURISTAS, "a".repeat(64), AT + DAY, AT, AT, AT));
      const cfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FRONT_JOBS_ENABLED: "1",
        EVEJS_LNE_FRONT_JOBS_CLEAR_ENABLED: "1", EVEJS_LNE_FRONT_JOBS_DELIVER_ENABLED: "1",
        EVEJS_LNE_FRONT_JOBS_JOBS_PER_DAY: "2" } });
      assert.ok(cfg.ok, JSON.stringify(cfg.errors));
      const world = { repository: { listActiveOccupations: (_tx, o) => ({ ok: true,
        systems: FRONTS.filter((f) => f.systemId > o.afterSystemId).slice(0, o.limit), nextAfterSystemId: null }) } };
      const started = startFrontJobs({ config: cfg.config, ctx: { persistence: { ok: true, store, worldSeed: 4242 },
        world }, clock: { now: () => AT }, adapter: null, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
      assert.ok(started.ok, JSON.stringify(started));
      const fj = started.frontJobs;
      try {
        const clear = all(store, "SELECT job_id, kind, ref FROM world_front_jobs WHERE kind = 'CLEAR'");
        assert.deepStrictEqual(clear.map((j) => j.ref), ["lne:ev1:0"]);
        const r = fj.onNpcKill({ characterId: 9001, victimFactionId: 500099, systemId: S1, atMs: AT + 1,
          rewardable: true });
        assert.ok(r.ok && r.results.some((x) => x.outcome === "PROGRESS"), JSON.stringify(r));
        run(store, (db) => db.prepare("UPDATE world_event_sites SET state = 'COMPLETED' WHERE site_key = 'lne:ev1:0'")
          .run());
        fj.runPass(AT + 2);
        const pays = all(store, `SELECT character_id AS c, job_id FROM world_front_job_payouts`);
        assert.deepStrictEqual(pays.map((p) => [p.c, p.job_id]), [[9001, clear[0].job_id]]);
        const st = fj.getStatus();
        assert.deepStrictEqual([st.counters.clearSettled, st.kinds.clear, st.kinds.deliver, st.lastRefusal],
          [1, true, true, null]);
        assert.ok("standingMissing" in st.payout, "review");
      } finally {
        fj.stop("test");
      }
    });
  });
};
