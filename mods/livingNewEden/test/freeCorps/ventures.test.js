"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { createManualClock } = require("../../lib/util/clock");
const { createViewRegistry } = require("../../lib/observer/views");
const { startFreeCorps } = require("../../lib/freeCorps");
const { createFreeCorpVentureRepository } = require("../../lib/freeCorps/ventureRepository");
const V = require("../../lib/freeCorps/ventures");
const { VENTURE_KINDS } = require("../../lib/freeCorps/data/ventureKinds");
const { VENTURE_ENGINE_KINDS, keyGrow } = require("../../lib/freeCorps/schema");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 2000000000000;
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const A = 30000001;
const B = 30000002;
const C = 30000003;
const L1 = 30000011;
const L2 = 30000012;
const STEP = 900000;
const REST = 1800000;
const HOLD = 600000;

function resolved() {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: ON_ENV });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function cfgOf({ fc = {}, ventures = {}, lifecycle = {}, vc = {} } = {}) {
  const c = resolved();
  const f = c.freeCorps;
  return { ...c, virtualCorps: { ...c.virtualCorps, ...vc },
    freeCorps: { ...f, targetCorps: 0, ...fc, ventures: { ...f.ventures, enabled: true, ...ventures,
      loss: { ...f.ventures.loss, ...(ventures.loss || {}) } }, lifecycle: { ...f.lifecycle, ...lifecycle } } };
}

function graphOf(spec) {
  const byId = new Map(Object.entries(spec).map(([id, s]) => [Number(id), { id: Number(id), name: `S${id}`,
    regionId: 10000002, constellationId: 20000020, secClass: s.band }]));
  return { getSystem: (id) => byId.get(id) || null,
    getSystemsBySecClass: (band) => [...byId.values()].filter((v) => v.secClass === band).map((v) => v.id),
    getNeighbors: (id) => (spec[id] ? spec[id].links.slice() : null) };
}

const LINE = Object.freeze({ [A]: { band: "highsec", links: [B] }, [B]: { band: "highsec", links: [A, C] },
  [C]: { band: "highsec", links: [B] } });
const LOW = Object.freeze({ [L1]: { band: "lowsec", links: [L2] }, [L2]: { band: "lowsec", links: [L1] } });

function fakeVc(store) {
  const vc = { identities: new Map(), ensures: [],
    oc: { ok: true, ready: true, total: 0, byKind: { capsuleer: 0, civilian: 0, free: 0 } },
    ensureOwnerIdentity(spec) {
      vc.ensures.push({ spec, inTx: store.isInTransaction() });
      return { ok: true, queued: true };
    },
    getOwnerIdentity: (kind, id) => vc.identities.get(id) || { ok: true, state: "PENDING" },
    countOwnerCharacters: () => vc.oc };
  return vc;
}

const linked = (n, corporationId = 98000001) => ({ ok: true, state: "LINKED", corporationId,
  ceoCharacterId: 91000001, characterIds: Array.from({ length: n }, (_v, i) => 91000001 + i), refusedMemberCount: 0 });

function boot(opened, { cfg, graph = graphOf(LINE), clock, views, stations = { [A]: [60000001] },
  belts = { [C]: 3 }, observed = null } = {}) {
  const clk = clock || createManualClock(T0);
  const vc = fakeVc(opened.store);
  const journal = createJournal({ clock: clk, maxPayloadBytes: 16384, maxRows: 500 });
  const presence = observed === null ? null : { isObserved: (id) => observed.has(id) };
  const r = startFreeCorps({ config: cfg, clock: clk, logger: { log() {} }, telemetry: null,
    persistence: { store: opened.store, journal, worldSeed: opened.worldSeed }, views: views || null,
    getGraph: () => ({ ok: true, graph }), getVirtualCorps: () => vc, getGovernor: () => null,
    listStations: (systemId) => ({ ok: true, stations: (stations[systemId] || []).map((stationId) => ({ stationId,
      corporationId: 1000100 })) }),
    bloodlinesOf: () => [1, 2], raceSourceFactionIds: [500001], excludedRegionIds: [10000070],
    reservedNames: () => ({ names: new Set(), tickers: new Set() }),
    setTimer: () => ({ cancel() {}, hasRef: () => false }), nowMs: () => 0,
    bfs: require("../../lib/strategy/ai/bfs").bfs,
    readSystemBelts: (ids) => ({ ok: true, counts: new Map(ids.map((id) => [id, belts[id] || 0])) }),
    getPresence: () => presence });
  assert.ok(r.ok, JSON.stringify(r));
  return { fc: r.freeCorps, vc, clock: clk, journal };
}

const exec = (opened, sql, ...args) => {
  const r = opened.store.transaction("t.exec", (db) => db.prepare(sql).run(...args));
  assert.ok(r.ok, JSON.stringify(r));
};
const all = (opened, sql, ...args) => {
  const r = opened.store.transaction("t.all", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
    typeof v === "bigint" ? Number(v) : v])));
};

function seedCorp(opened, { archetype = "miner", band = "highsec", home = A, station = 60000001, members = 5,
  isk = 200000000, nextAt = T0, seed = 12345, corpId = 1, ventureSeq = 0 } = {}) {
  exec(opened, "INSERT INTO world_free_corps (corp_id, archetype, state, open, name, ticker, sec_band, home_system_id, "
    + "home_station_id, home_station_corp_id, race_faction_id, members_target, corporation_id, isk, struggle_count, "
    + "seed, name_attempt, venture_seq, next_at, founded_at, updated_at, version) VALUES (?, ?, 'ACTIVE', 1, ?, ?, ?, "
    + "?, ?, 1000100, 500001, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, 1)", corpId, archetype, `Corp ${corpId}`, `TC${corpId}`,
  band, home, station, members, 98000000 + corpId, isk, seed, ventureSeq, nextAt, T0 - 1000, T0 - 1000);
}

const corpRow = (opened) => all(opened, "SELECT * FROM world_free_corps WHERE corp_id = 1")[0];
const ventureRows = (opened) => all(opened, "SELECT * FROM world_free_corp_ventures ORDER BY venture_id");

function pass(env) {
  const r = env.fc.runPassNow();
  assert.deepStrictEqual(r, { ok: true, ran: true }, JSON.stringify(env.fc.getStatus().lastError));
  return env.fc.getStatus();
}

function ventureRow(o) {
  const travel = o.travel_steps;
  const work = o.work_steps;
  const open = ["TRAVEL", "WORKING", "RETURNING", "HELD"].includes(o.state) ? 1 : 0;
  return { venture_id: `fcv:1:${o.seq}`, corp_id: 1, seq: o.seq, kind: o.kind, state: o.state, open,
    home_system_id: o.home, system_id: o.system, target_system_id: o.target, target_station_id: null,
    sec_band: o.band, jumps: o.jumps, crew: o.crew, crew_lost: 0, step: o.step, travel_steps: travel,
    work_steps: work, steps_total: 2 * travel + work, holds: 0, yield_isk: 0, cost_isk: 0, started_at: o.at,
    step_due_at: o.due === undefined ? o.at : o.due, updated_at: o.at, ended_at: open ? null : o.ended,
    end_reason: open ? null : "DONE", version: 1 };
}

function insertVenture(opened, row) {
  const repo = createFreeCorpVentureRepository();
  const r = opened.store.transaction("t.v", (db) => repo.insertInTx(db, row, row.updated_at));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

function pureEnv(over = {}) {
  return { now: T0, linkedCount: 5, memberRoom: 10,
    reachOf: () => Object.freeze([{ systemId: A, jumps: 0, secClass: "highsec" },
      { systemId: B, jumps: 1, secClass: "highsec" }]),
    beltsOf: () => null, stationsOf: (id) => (id === B ? [{ stationId: 60000002 }] : []),
    isObserved: () => false, ...over };
}

const pureCorp = (over = {}) => ({ corp_id: 1, archetype: "miner", state: "ACTIVE", open: 1, sec_band: "highsec",
  home_system_id: A, members_target: 5, isk: 200000000, struggle_count: 0, seed: 77, venture_seq: 0,
  recover_until: 0, recover_crew: 0, ventures_done: 0, ventures_lost: 0, isk_earned: 0, isk_lost: 0,
  last_review_at: 0, ended_at: null, end_reason: null, ...over });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FC3-1 happy path: review -> TRAVEL -> WORKING -> RETURNING -> DONE, payout, next venture, panel; "
    + "flag off = reschedule and zero venture rows", () => {
    const cfg = cfgOf({ ventures: { jumpsPerStep: 1, workStepsMin: 2, workStepsMax: 2,
      loss: { highsecPermille: 0, lowsecPermille: 0, nullsecPermille: 0 } } });
    withStore(driver, (opened) => {
      seedCorp(opened);
      const views = createViewRegistry();
      const env = boot(opened, { cfg, views });
      env.vc.identities.set(1, linked(5));
      pass(env);
      let v = ventureRows(opened);
      assert.strictEqual(v.length, 1);
      assert.deepStrictEqual([v[0].venture_id, v[0].kind, v[0].state, v[0].crew, v[0].system_id, v[0].target_system_id,
        v[0].steps_total, v[0].step], ["fcv:1:1", "MINE", "TRAVEL", 5, A, C, 6, 0]);
      const upkeep = 5 * cfg.freeCorps.lifecycle.upkeepIskPerMember;
      assert.strictEqual(corpRow(opened).isk, 200000000 - upkeep);
      assert.strictEqual(corpRow(opened).next_at, T0 + STEP);
      assert.strictEqual(corpRow(opened).venture_seq, 1);
      const seen = [];
      for (let k = 1; k <= 6; k += 1) {
        env.clock.advance(STEP);
        pass(env);
        v = ventureRows(opened);
        seen.push([v[0].state, v[0].step, v[0].system_id]);
        if (k === 3) {
          const data = views.getView("free-corps").getData({});
          assert.strictEqual(data.ventures.enabled, true);
          assert.strictEqual(data.ventures.open, 1);
          assert.deepStrictEqual([data.ventures.rows[0].kind, data.ventures.rows[0].step, data.ventures.rows[0].crew,
            data.ventures.rows[0].corp], ["MINE", "3/6", 5, "Corp 1 [TC1]"]);
        }
      }
      assert.deepStrictEqual(seen, [["TRAVEL", 1, A], ["WORKING", 2, C], ["WORKING", 3, C], ["RETURNING", 4, C],
        ["RETURNING", 5, C], ["DONE", 6, A]]);
      const corp = corpRow(opened);
      assert.ok(v[0].yield_isk > 0, String(v[0].yield_isk));
      assert.strictEqual(corp.isk, 200000000 - upkeep + v[0].yield_isk, "treasury = initial - upkeep + yield");
      assert.strictEqual(corp.ventures_done, 1);
      assert.strictEqual(corp.isk_earned, v[0].yield_isk);
      assert.strictEqual(corp.next_at, env.clock.now() + REST);
      assert.strictEqual(env.fc.getStatus().ventures.byKind["MINE.done"], 1);
      env.clock.advance(REST);
      pass(env);
      v = ventureRows(opened);
      assert.deepStrictEqual(v.map((x) => [x.venture_id, x.open]), [["fcv:1:1", 0], ["fcv:1:2", 1]]);
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      seedCorp(opened);
      const off = cfgOf({ ventures: { enabled: false } });
      const env = boot(opened, { cfg: off });
      env.vc.identities.set(1, linked(5));
      const st = pass(env);
      assert.strictEqual(corpRow(opened).next_at, T0 + off.freeCorps.activeIdleMs);
      assert.strictEqual(corpRow(opened).isk, 200000000);
      assert.strictEqual(ventureRows(opened).length, 0);
      assert.strictEqual(st.ventures.enabled, false);
      env.fc.stop();
    });
  });

  needsDriver("FC3-2 determinism and restart: a failed pass rolls back venture and corporation, both stores end "
    + "equal, a second pass at the same now writes nothing", () => {
    const cfg = cfgOf({ ventures: { jumpsPerStep: 1 } });
    const run = (opened, failFirst) => {
      seedCorp(opened);
      const env = boot(opened, { cfg });
      env.vc.identities.set(1, linked(5));
      if (failFirst) {
        exec(opened, "CREATE TEMP TRIGGER fc3_boom BEFORE UPDATE ON world_free_corps BEGIN "
          + "SELECT RAISE(ABORT, 'test boom'); END;");
        const r = env.fc.runPassNow();
        assert.strictEqual(r.ok, false, JSON.stringify(r));
        assert.strictEqual(env.fc.getStatus().counters.passFailed, 1);
        assert.strictEqual(ventureRows(opened).length, 0, "venture INSERT rolled back");
        assert.strictEqual(corpRow(opened).version, 1, "corporation unchanged");
        exec(opened, "DROP TRIGGER temp.fc3_boom");
      }
      for (let k = 0; k < 12; k += 1) {
        pass(env);
        env.clock.advance(STEP);
      }
      pass(env);
      const before = [ventureRows(opened), corpRow(opened)];
      pass(env);
      const after = [ventureRows(opened), corpRow(opened)];
      env.fc.stop();
      return { before, after };
    };
    withStore(driver, (a) => withStore(driver, (b) => {
      const ra = run(a, false);
      const rb = run(b, true);
      const strip = ([vs, corp]) => [vs, { ...corp, updated_at: null }];
      assert.deepStrictEqual(strip(rb.before), strip(ra.before), "same rows in both stores");
      assert.ok(ra.before[0].length >= 2, `ventures ${ra.before[0].length}`);
      assert.deepStrictEqual(ra.after, ra.before, "a second pass at the same now writes nothing");
      assert.deepStrictEqual(rb.after, rb.before);
    }));
  });

  needsDriver("FC3-3 HELD in an observed system, LOST when nobody looks, HOLD_LIMIT after maxHolds", () => {
    const cfg = cfgOf({ ventures: { loss: { lowsecPermille: 1000 } } });
    const stations = { [L1]: [60000011] };
    const belts = { [L2]: 2 };
    withStore(driver, (opened) => {
      seedCorp(opened, { archetype: "ratter", band: "lowsec", home: L1, station: 60000011, isk: 10000000,
        ventureSeq: 1 });
      insertVenture(opened, ventureRow({ seq: 1, kind: "RAT", state: "WORKING", home: L1, system: L2, target: L2,
        band: "lowsec", jumps: 1, crew: 5, step: 1, travel_steps: 1, work_steps: 3, at: T0 }));
      const observed = new Set([L2]);
      const env = boot(opened, { cfg, stations, belts, graph: graphOf(LOW), observed });
      env.vc.identities.set(1, linked(5));
      let st = pass(env);
      let v = ventureRows(opened)[0];
      assert.deepStrictEqual([v.state, v.holds, v.step, v.step_due_at, v.crew_lost], ["HELD", 1, 1, T0 + HOLD, 0]);
      assert.strictEqual(corpRow(opened).isk, 10000000, "treasury unchanged");
      assert.strictEqual(st.ventures.byKind["RAT.held"], 1);
      observed.clear();
      env.clock.advance(HOLD);
      pass(env);
      v = ventureRows(opened)[0];
      const corp = corpRow(opened);
      assert.strictEqual(v.state, "LOST");
      assert.ok(v.crew_lost >= 1 && v.crew_lost <= 5, String(v.crew_lost));
      assert.strictEqual(corp.isk, 0, "treasury clamped at 0 (loss above the treasury)");
      assert.strictEqual(corp.isk_lost, 10000000);
      assert.strictEqual(corp.recover_crew, v.crew_lost);
      assert.strictEqual(corp.ventures_lost, 1);
      env.clock.advance(REST);
      st = pass(env);
      const next = ventureRows(opened).filter((x) => x.open === 1);
      if (v.crew_lost < 5) {
        assert.strictEqual(next.length, 1);
        assert.strictEqual(next[0].crew, 5 - v.crew_lost, "smaller crew while recovering");
      } else {
        assert.strictEqual(st.counters.ventureNoCrew, 1);
      }
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      seedCorp(opened, { archetype: "ratter", band: "lowsec", home: L1, station: 60000011, ventureSeq: 1 });
      insertVenture(opened, ventureRow({ seq: 1, kind: "RAT", state: "WORKING", home: L1, system: L2, target: L2,
        band: "lowsec", jumps: 1, crew: 5, step: 1, travel_steps: 1, work_steps: 2, at: T0 }));
      const env = boot(opened, { cfg: cfgOf({ ventures: { maxHolds: 1, loss: { lowsecPermille: 1000 } } }),
        stations, belts, graph: graphOf(LOW), observed: new Set([L2]) });
      env.vc.identities.set(1, linked(5));
      pass(env);
      assert.strictEqual(ventureRows(opened)[0].state, "HELD");
      env.clock.advance(HOLD);
      const st = pass(env);
      let v = ventureRows(opened)[0];
      assert.deepStrictEqual([v.state, v.step, v.crew_lost], ["RETURNING", 3, 0]);
      assert.strictEqual(st.counters.ventureHoldLimit, 1);
      env.clock.advance(STEP);
      pass(env);
      v = ventureRows(opened)[0];
      assert.deepStrictEqual([v.state, v.end_reason, v.crew_lost, v.system_id], ["DONE", "HOLD_LIMIT", 0, L1]);
      assert.strictEqual(corpRow(opened).ventures_lost, 0);
      env.fc.stop();
    });
  });

  needsDriver("FC3-L: a blocked founding is checked once per foundingIntervalMs; ACTIVE while the "
    + "virtualCorps maps are not ready is rechecked without repair or ensure", () => {
    withStore(driver, (opened) => {
      const cfg = cfgOf({ fc: { targetCorps: 60 }, vc: { ownerCharacterBudget: 100 }, ventures: { enabled: false } });
      const e = boot(opened, { cfg });
      e.vc.oc = { ok: true, ready: true, total: 99, byKind: { capsuleer: 99, civilian: 0, free: 0 } };
      pass(e);
      e.clock.advance(5000);
      let st = pass(e);
      assert.strictEqual(st.counters.foundingBlockedBudget, 1, "second pass inside the interval: no scan");
      e.clock.advance(cfg.freeCorps.foundingIntervalMs);
      st = pass(e);
      assert.strictEqual(st.counters.foundingBlockedBudget, 2, "after the interval: checked again");
      e.fc.stop();
    });
    withStore(driver, (opened) => {
      seedCorp(opened);
      const cfg = cfgOf();
      const e = boot(opened, { cfg });
      e.vc.oc = { ok: true, ready: false, total: 0, byKind: { capsuleer: 0, civilian: 0, free: 0 } };
      const st = pass(e);
      assert.strictEqual(st.counters.identityRepairs, 0);
      assert.strictEqual(st.counters.vcUnavailable, 1);
      assert.strictEqual(e.vc.ensures.length, 0, "no ensure while not ready");
      assert.strictEqual(corpRow(opened).next_at, T0 + cfg.freeCorps.foundingRecheckMs);
      assert.strictEqual(ventureRows(opened).length, 0);
      e.fc.stop();
    });
  });

  test("FC3-4 missing static data: HAUL without belts, NO_TARGET, BUILD at home without graph, NO_FUNDS, NO_CREW, "
    + "NO_KIND; refusals become rest", () => {
    assert.deepStrictEqual(VENTURE_KINDS, VENTURE_ENGINE_KINDS, "kinds of the data = kinds of the schema");
    const S = cfgOf().freeCorps;
    const haul = V.planVenture(pureCorp(), pureEnv(), S);
    assert.ok(haul.ok, JSON.stringify(haul));
    assert.deepStrictEqual([haul.row.kind, haul.row.target_system_id, haul.row.target_station_id, haul.row.state],
      ["HAUL", B, 60000002, "TRAVEL"]);
    assert.deepStrictEqual(V.planVenture(pureCorp(), pureEnv({ stationsOf: () => [] }), S),
      { ok: false, reason: "NO_TARGET" });
    const cMax = 5 * S.ventures.buildInputIskPerStepPerPilot * S.ventures.workStepsMax;
    const build = V.planVenture(pureCorp({ archetype: "industrialist", isk: cMax }), pureEnv({ reachOf: () => null }), S);
    assert.ok(build.ok, JSON.stringify(build));
    assert.deepStrictEqual([build.row.kind, build.row.travel_steps, build.row.state, build.row.system_id],
      ["BUILD", 0, "WORKING", A]);
    assert.strictEqual(build.row.cost_isk, 5 * S.ventures.buildInputIskPerStepPerPilot * build.row.work_steps);
    assert.deepStrictEqual(V.planVenture(pureCorp({ archetype: "industrialist", isk: cMax - 1 }),
      pureEnv({ reachOf: () => null }), S), { ok: false, reason: "NO_FUNDS" });
    assert.deepStrictEqual(V.planVenture(pureCorp(), pureEnv({ linkedCount: 0 }), S), { ok: false, reason: "NO_CREW" });
    assert.deepStrictEqual(V.planVenture(pureCorp({ archetype: "hunter" }), pureEnv(), S),
      { ok: false, reason: "NO_KIND" });
    const rest = V.stepCorpVenture(pureCorp({ archetype: "hunter" }), null, pureEnv(), S);
    assert.deepStrictEqual([rest.ok, rest.venture, rest.rest, rest.nextAt], [true, null, { reason: "NO_KIND" },
      T0 + S.ventures.restMs]);
    assert.ok(rest.tallies.includes("ventureNoKind") && rest.tallies.includes("upkeepPaid"), rest.tallies.join(","));
  });

  needsDriver("FC3-5 life cycle, growth after the commit, budget block, retention batches, migration 74 and reset "
    + "policy", () => {
    const S = cfgOf({ lifecycle: { struggleReviews: 2 } }).freeCorps;
    let corp = pureCorp({ isk: 1000 });
    const env = pureEnv();
    const transitions = [];
    for (let k = 0; k < 3; k += 1) {
      const r = V.reviewCorp(corp, env, S);
      transitions.push([r.corp.state, r.corp.struggle_count, r.transition]);
      corp = { ...corp, ...r.corp };
    }
    assert.deepStrictEqual(transitions, [["ACTIVE", 1, null], ["STRUGGLING", 2, "STRUGGLING"],
      ["STRUGGLING", 3, null]]);
    assert.strictEqual(corp.isk, 0);
    const back = V.reviewCorp({ ...corp, isk: 100000000 }, env, S);
    assert.deepStrictEqual([back.corp.state, back.corp.struggle_count, back.transition], ["ACTIVE", 0, "RECOVERED"]);
    assert.ok(back.tallies.includes("recovered"));

    withStore(driver, (opened) => {
      seedCorp(opened, { isk: 3000000000 });
      const cfg = cfgOf({ ventures: { jumpsPerStep: 1 } });
      const e = boot(opened, { cfg });
      e.vc.identities.set(1, linked(5));
      e.vc.oc = { ok: true, ready: true, total: 5, byKind: { capsuleer: 0, civilian: 0, free: 5 } };
      const st = pass(e);
      const row = corpRow(opened);
      const L = cfg.freeCorps.lifecycle;
      assert.strictEqual(row.members_target, 6);
      assert.strictEqual(row.isk, 3000000000 - 5 * L.upkeepIskPerMember - L.growthCostIsk);
      assert.strictEqual(st.counters.grew, 1);
      assert.deepStrictEqual(e.vc.ensures.map((x) => [x.inTx, x.spec.members, x.spec.ownerId]), [[false, 6, 1]]);
      const j = all(opened, "SELECT COUNT(*) AS n FROM world_event_journal WHERE idempotency_key = ?", keyGrow(1, 6));
      assert.strictEqual(j[0].n, 1, "journal lne:fc:grow once");
      e.fc.stop();
    });
    withStore(driver, (opened) => {
      seedCorp(opened, { isk: 3000000000 });
      const e = boot(opened, { cfg: cfgOf({ vc: { ownerCharacterBudget: 100 } }) });
      e.vc.identities.set(1, linked(5));
      e.vc.oc = { ok: true, ready: true, total: 100, byKind: { capsuleer: 95, civilian: 0, free: 5 } };
      const st = pass(e);
      assert.strictEqual(corpRow(opened).members_target, 5);
      assert.strictEqual(st.counters.growthBlockedBudget, 1);
      assert.strictEqual(e.vc.ensures.length, 0);
      e.fc.stop();
    });
    withStore(driver, (opened) => {
      const cfg = cfgOf();
      const R = cfg.freeCorps.retention;
      seedCorp(opened, { nextAt: T0 + 86400000, ventureSeq: 71 });
      const old = T0 - R.ventureRetentionMs - 1000;
      for (let s = 1; s <= 71; s += 1) {
        insertVenture(opened, ventureRow({ seq: s, kind: "MINE", state: "DONE", home: A, system: A, target: C,
          band: "highsec", jumps: 2, crew: 3, step: 6, travel_steps: 2, work_steps: 2, at: old - 1000,
          ended: s === 71 ? T0 - 1000 : old - 100 + s }));
      }
      const e = boot(opened, { cfg });
      let st = pass(e);
      assert.strictEqual(ventureRows(opened).length, 7);
      assert.strictEqual(st.counters.pruned, 64);
      st = pass(e);
      assert.deepStrictEqual(ventureRows(opened).map((x) => x.venture_id), ["fcv:1:71"], "the young one stays");
      assert.strictEqual(st.counters.pruned, 70);
      e.fc.stop();
    });
    withStore(driver, (opened) => {
      assert.ok(LATEST_SCHEMA_VERSION >= 76, "migration 76 (wars) after 75");
      const idx = all(opened, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = "
        + "'world_free_corp_ventures' AND sql LIKE '%WHERE open = %' ORDER BY name").map((x) => x.name);
      assert.deepStrictEqual(idx, ["world_free_corp_ventures_ended", "world_free_corp_ventures_open",
        "world_free_corp_ventures_system"]);
      assert.strictEqual(all(opened, "SELECT COUNT(*) AS n FROM world_free_corp_ventures")[0].n, 0);
      const cols = all(opened, "PRAGMA table_info(world_free_corps)").map((x) => x.name);
      for (const c of ["recover_until", "recover_crew", "ventures_done", "ventures_lost", "isk_earned", "isk_lost",
        "last_review_at"]) assert.ok(cols.includes(c), c);
    }, { fresh: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-fc3-"));
    const file = path.join(tmp, "world.sqlite");
    const open = (migrations) => openStore({ filePath: file, openDatabase: (f) => new driver.Database(f),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations });
    try {
      const at73 = open(MIGRATIONS.slice(0, 73));
      assert.ok(at73.ok, JSON.stringify(at73));
      seedCorp(at73);
      at73.store.close("test");
      const at74 = open(MIGRATIONS);
      assert.ok(at74.ok, JSON.stringify(at74));
      const row = corpRow(at74);
      assert.deepStrictEqual([row.isk, row.recover_until, row.ventures_done, row.isk_lost, row.last_review_at],
        [200000000, 0, 0, 0, 0]);
      at74.store.close("test");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    assert.strictEqual(TABLE_POLICY.world_free_corp_ventures, ACTION.WIPE);
    assert.strictEqual(TABLE_POLICY.world_free_corps, ACTION.KEEP);
  });
};
