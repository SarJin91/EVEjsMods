"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const V = require("../../lib/freeCorps/ventures");
const WV = require("../../lib/freeCorps/wormholeVentures");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const T0 = 2000000000000;
const H = 30000001;
const E = 30000002;
const J = 31000001;

function settings({ ventures = {}, wormholes = {} } = {}) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: ON_ENV });
  assert.deepStrictEqual(r.errors, []);
  const f = r.config.freeCorps;
  return { ...f, ventures: { ...f.ventures, enabled: true, jumpsPerStep: 1, workStepsMin: 2, workStepsMax: 2,
    yieldVariancePermille: 0, ...ventures, loss: { highsecPermille: 0, lowsecPermille: 0, nullsecPermille: 0 } },
  wormholes: { ...f.wormholes, enabled: true, weight: 1000, ...wormholes } };
}

const corpOf = (over = {}) => ({ corp_id: 1, archetype: "explorer", state: "ACTIVE", open: 1, sec_band: "highsec",
  home_system_id: H, members_target: 4, isk: 50000000, struggle_count: 0, seed: 1, venture_seq: 0, recover_until: 0,
  recover_crew: 0, ventures_done: 0, ventures_lost: 0, isk_earned: 0, isk_lost: 0, last_review_at: 0, ended_at: null,
  end_reason: null, ...over });

function envOf({ now = T0, expiresAt = 0, linked = () => true, exit = () => ({ ok: false, reason: "NO_EXIT" }),
  observed = () => false } = {}) {
  return { now, linkedCount: 4, memberRoom: 0,
    reachOf: () => Object.freeze([{ systemId: H, jumps: 0, secClass: "highsec" },
      { systemId: E, jumps: 2, secClass: "highsec" }]),
    beltsOf: () => null, stationsOf: () => [], isObserved: observed,
    wh: { mode: "LIVE", minLifeMs: 0, entriesOf: (id) => (id === E ? [{ jSystemId: J, expiresAt }] : []),
      isLinked: linked, findExit: exit } };
}

function planWh(S, env) {
  for (let seed = 1; seed <= 20; seed += 1) {
    const p = V.planVenture(corpOf({ seed }), env, S);
    if (p.ok && p.row.kind === "EXPLORE_WH") return { seed, row: p.row };
  }
  return null;
}

function step(state, env, S) {
  const r = V.stepCorpVenture(state.corp, state.venture, { ...env, now: state.venture.step_due_at }, S);
  assert.strictEqual(r.ok, true);
  if (r.venture) state.venture = { ...state.venture, ...r.venture.row };
  state.corp = { ...state.corp, ...r.corp };
  return r;
}

const workingRow = (o = {}) => ({ venture_id: "fcv:1:1", corp_id: 1, seq: 1, kind: "EXPLORE_WH", state: "WORKING",
  open: 1, home_system_id: H, system_id: J, target_system_id: J, target_station_id: null, sec_band: "wormhole",
  jumps: 3, crew: 4, crew_lost: 0, step: 3, travel_steps: 3, work_steps: 2, steps_total: 8, holds: 0, yield_isk: 0,
  cost_isk: 0, started_at: T0, step_due_at: T0, updated_at: T0, ended_at: null, end_reason: null, version: 1,
  wh_route: JSON.stringify([J, E]), wh_entry_system_id: E, stranded_steps: 0, ...o });

module.exports = ({ test }) => {
  test("FC6-1 EXPLORE_WH plan [J, E] jumps 3, TRAVEL -> J -> WORKING -> RETURNING out to E -> DONE at home, payout "
    + "of the J yield; a short-lived pair -> EXPLORE", () => {
    const S = settings();
    const found = planWh(S, envOf());
    assert.ok(found, "an EXPLORE_WH plan for one of the seeds 1..20");
    const row = found.row;
    assert.deepStrictEqual([row.kind, row.jumps, row.sec_band, row.wh_route, row.wh_entry_system_id, row.state,
      row.system_id, row.target_system_id, row.travel_steps, row.steps_total, row.stranded_steps],
    ["EXPLORE_WH", 3, "wormhole", JSON.stringify([J, E]), E, "TRAVEL", H, J, 3, 8, 0]);
    const state = { corp: corpOf({ seed: found.seed, venture_seq: 1 }), venture: row };
    const seen = [];
    for (let k = 0; k < 12 && state.venture.open === 1; k += 1) {
      step(state, envOf(), S);
      seen.push([state.venture.state, state.venture.step, state.venture.system_id]);
    }
    assert.deepStrictEqual(seen, [["TRAVEL", 1, H], ["TRAVEL", 2, H], ["WORKING", 3, J], ["WORKING", 4, J],
      ["RETURNING", 5, J], ["RETURNING", 6, E], ["RETURNING", 7, E], ["DONE", 8, H]]);
    const pay = 2 * 4 * S.wormholes.yieldIskPerStepPerPilot;
    assert.deepStrictEqual([state.venture.yield_isk, state.venture.steps_total, state.corp.isk, state.corp.ventures_done],
      [pay, 8, 50000000 + pay, 1]);

    const short = envOf({ expiresAt: T0 + 60000 });
    for (let seed = 1; seed <= 5; seed += 1) {
      const p = V.planVenture(corpOf({ seed }), short, S);
      assert.deepStrictEqual([p.ok, p.row.kind, p.row.wh_route], [true, "EXPLORE", null], `seed ${seed}`);
    }
  });

  test("FC6-3 STRANDED: NO_EXIT, a player in J waits, LOST after strandedMaxSteps, LOST by the roll (deterministic), "
    + "WH_RESCUED", () => {
    const cut = { linked: () => false };
    let S = settings({ wormholes: { strandedLossPermille: 0, strandedMaxSteps: 2 } });
    const st = { corp: corpOf({ venture_seq: 1, isk: 30000000 }), venture: workingRow() };
    let r = step(st, envOf(cut), S);
    assert.deepStrictEqual([st.venture.state, st.venture.step, st.venture.step_due_at, st.venture.stranded_steps],
      ["STRANDED", 3, T0 + S.wormholes.strandedStepMs, 0]);
    assert.ok(r.tallies.includes("whStranded") && r.tallies.includes("whNoExit"), r.tallies.join(","));
    r = step(st, envOf({ ...cut, observed: (id) => id === J }), S);
    assert.deepStrictEqual([st.venture.state, st.venture.stranded_steps, st.venture.crew_lost],
      ["STRANDED", 0, 0]);
    assert.ok(r.tallies.includes("whStrandedWait"));
    step(st, envOf(cut), S);
    assert.deepStrictEqual([st.venture.state, st.venture.stranded_steps], ["STRANDED", 1]);
    r = step(st, envOf(cut), S);
    const cost = 4 * S.ventures.shipLossIskPerPilot;
    assert.deepStrictEqual([st.venture.state, st.venture.open, st.venture.crew_lost, st.venture.end_reason,
      st.venture.cost_isk], ["LOST", 0, 4, "STRANDED", cost]);
    assert.deepStrictEqual([st.corp.isk, st.corp.isk_lost, st.corp.ventures_lost, st.corp.recover_crew],
      [0, 30000000, 1, 4], "paid min(isk, cost)");
    assert.ok(r.tallies.includes("whStrandedLost") && r.kindEvents.some((e) => e.event === "lost"));

    S = settings({ wormholes: { strandedLossPermille: 1000, strandedMaxSteps: 0 } });
    const lostOnce = () => {
      const s2 = { corp: corpOf({ venture_seq: 1 }), venture: workingRow({ state: "STRANDED", step_due_at: T0 }) };
      step(s2, envOf(cut), S);
      return s2.venture;
    };
    const a = lostOnce();
    assert.deepStrictEqual([a.state, a.end_reason], ["LOST", "STRANDED_LOSS"]);
    assert.ok(a.crew_lost >= 1 && a.crew_lost <= 4, String(a.crew_lost));
    assert.strictEqual(lostOnce().crew_lost, a.crew_lost, "deterministic for the seed");

    const exit = () => ({ ok: true, route: [J, 31000002, E], hops: 2, gateJumps: 2 });
    const s3 = { corp: corpOf({ venture_seq: 1 }), venture: workingRow({ state: "STRANDED" }) };
    step(s3, envOf({ ...cut, exit }), S);
    assert.deepStrictEqual([s3.venture.state, s3.venture.end_reason, s3.venture.system_id, s3.venture.wh_route,
      s3.venture.steps_total], ["RETURNING", "WH_RESCUED", J, JSON.stringify([J, 31000002, E]), 3 + 4]);
  });

  test("FC6-NOTE1 restart after a 2 h downtime: WAIT defers until the sync or syncWaitMaxMs after the boot "
    + "(max(step_due_at, waitSince)), then OFFLINE; no waitSince = from step_due_at", () => {
    const S = settings();
    const maxMs = S.wormholes.syncWaitMaxMs;
    assert.ok(Number.isSafeInteger(maxMs) && maxMs > 0 && maxMs < 2 * 3600000, String(maxMs));
    const boot = T0;
    const row = workingRow({ step_due_at: boot - 2 * 3600000 });
    const corp = corpOf({ venture_seq: 1 });
    const waitEnv = (now, waitSince) => ({ ...envOf({ now }), wh: { ...envOf().wh, mode: "WAIT", waitSince } });
    const run = (now, waitSince) => WV.advanceWhVenture(corp, row, waitEnv(now, waitSince), S);
    for (const now of [boot, boot + maxMs]) {
      assert.deepStrictEqual(run(now, boot), { defer: true, reason: "WH_SYNC_WAIT", tallies: ["whSyncWait"] },
        `now = boot + ${now - boot}`);
    }
    const off = run(boot + maxMs + 1, boot);
    assert.deepStrictEqual([off.venture.state, off.venture.end_reason, off.venture.system_id],
      ["RETURNING", "WH_OFFLINE", E]);
    assert.ok(off.tallies.includes("whOffline"), off.tallies.join(","));
    assert.strictEqual(WV.advanceWhVenture(corp, row, envOf({ now: boot + 60000 }), S), null);
    const later = workingRow({ step_due_at: boot + maxMs });
    assert.strictEqual(WV.advanceWhVenture(corp, later, waitEnv(boot + maxMs + 1, boot), S).defer, true);
    assert.strictEqual(run(boot, null).venture.end_reason, "WH_OFFLINE");
  });
};
