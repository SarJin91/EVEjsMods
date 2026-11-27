"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { spreadOffsetMs, spreadCampaignJob, wrapCampaignBinding, runCampaignRetry, WRAPPED_CAMPAIGN_SPREAD } =
  require("../../lib/adapter/sovCampaignSpread");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { stableHash32 } = require("../../lib/util/rng");
const config = require("../../config");
const loader = require("../../loader");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const SPREAD_MS = 3600000;
const LNE_SYSTEM = 30004711;
const PLAYER_SYSTEM = 30004712;
const THROW_SYSTEM = 30004713;
const LNE_ALLIANCE = 99000001;
const PLAYER_ALLIANCE = 99012345;
const HUB_A = 1000000123456;
const WINDOW_START = 1793890800000;

function windowJob(systemID, targetID) {
  const captureEpoch = `owned-hub:${systemID}:${targetID}:1790000000000`;
  return {
    jobID: `sovereignty-campaign:${targetID}:${captureEpoch}`,
    type: "sovereignty.campaign-tick",
    dueAtMs: WINDOW_START,
    payload: { targetID, captureEpoch, windowEventMs: WINDOW_START },
  };
}

function deps(extra) {
  return {
    spreadMs: SPREAD_MS,
    allianceOfSystem: (id) => {
      if (id === THROW_SYSTEM) throw new Error("claim boom");
      return id === LNE_SYSTEM ? LNE_ALLIANCE : PLAYER_ALLIANCE;
    },
    isVirtualAlliance: (id) => id === LNE_ALLIANCE,
    ...extra,
  };
}

function findSrcDir() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function fakeExports() {
  const state = { bound: null, unbindArgs: [] };
  const exportsObject = {
    bindDurableScheduler(scheduler) {
      if (!scheduler || typeof scheduler.schedule !== "function") throw new TypeError("requires schedule");
      state.bound = scheduler;
      return true;
    },
    unbindDurableScheduler(scheduler = null) {
      state.unbindArgs.push(scheduler);
      if (scheduler && scheduler !== state.bound) return false;
      state.bound = null;
      return true;
    },
  };
  return { exportsObject, state };
}

function fakeScheduler() {
  const scheduled = [];
  const scheduler = Object.freeze({
    marker: "original",
    schedule(job) {
      scheduled.push({ self: this, job });
      return Promise.resolve({ jobID: job && job.jobID });
    },
  });
  return { scheduler, scheduled };
}

module.exports = ({ test }) => {
  test("T1 sovCampaignSpread: window job of an LNE hub -> dueAtMs + fnv1a32(targetID) % spreadMs, payload and jobID "
    + "unchanged, the same answer twice", () => {
    const job = windowJob(LNE_SYSTEM, HUB_A);
    const input = JSON.parse(JSON.stringify(job));
    const offset = spreadOffsetMs(HUB_A, SPREAD_MS);
    assert.ok(offset > 0 && offset < SPREAD_MS, `offset ${offset} in (0, spreadMs)`);
    const first = spreadCampaignJob(job, deps());
    const second = spreadCampaignJob(job, deps());
    assert.strictEqual(first.reason, "SPREAD");
    assert.strictEqual(first.spread, true);
    assert.notStrictEqual(first.job, job, "a new job object");
    assert.strictEqual(first.job.dueAtMs, WINDOW_START + offset);
    assert.strictEqual(first.job.jobID, input.jobID);
    assert.deepStrictEqual(first.job.payload, input.payload, "payload untouched (windowEventMs stays the vendor's)");
    assert.deepStrictEqual(job, input, "input not mutated");
    assert.deepStrictEqual(second.job, first.job, "idempotent: same dueAtMs for the same job");
    for (let i = 0; i < 50; i += 1) {
      const o = spreadOffsetMs(HUB_A + i, SPREAD_MS);
      assert.ok(Number.isSafeInteger(o) && o >= 0 && o < SPREAD_MS);
    }
    assert.strictEqual(spreadOffsetMs(HUB_A, 0), 0);
    assert.strictEqual(spreadOffsetMs(HUB_A, 2 ** 32), stableHash32(String(HUB_A)), "FNV-1a 32 = stableHash32");
  });

  test("T2 sovCampaignSpread: the same object passes through - reinforced, player hub, other type, spreadMs 0, "
    + "throwing claim", () => {
    const lne = windowJob(LNE_SYSTEM, HUB_A);
    const reinforced = { ...lne, payload: { targetID: HUB_A, captureEpoch: lne.payload.captureEpoch,
      reinforcementExitMs: WINDOW_START } };
    const cases = [
      [reinforced, deps(), "NOT_WINDOW"],
      [windowJob(PLAYER_SYSTEM, HUB_A), deps(), "NOT_LNE"],
      [{ ...lne, type: "sovereignty.hub-fuel" }, deps(), "NOT_CAMPAIGN"],
      [lne, deps({ spreadMs: 0 }), "ZERO"],
      [windowJob(THROW_SYSTEM, HUB_A), deps(), "CLAIM_UNAVAILABLE"],
      [{ ...lne, payload: { ...lne.payload, captureEpoch: "1790000000000" } }, deps(), "NO_SYSTEM"],
    ];
    for (const [job, d, reason] of cases) {
      const out = spreadCampaignJob(job, d);
      assert.strictEqual(out.reason, reason);
      assert.strictEqual(out.spread, false, reason);
      assert.strictEqual(out.job, job, `${reason}: the same object`);
    }
  });

  test("T3 sovCampaignSpread: wrapCampaignBinding - vendor bind gets a proxy, schedule moves the job on the original, "
    + "unbind(original) unbinds the proxy, second wrap = noop", () => {
    const { exportsObject, state } = fakeExports();
    const outcomes = [];
    const wrapped = wrapCampaignBinding(exportsObject, deps({ onOutcome: (r) => outcomes.push(r) }));
    assert.strictEqual(wrapped.ok, true);
    assert.strictEqual(typeof wrapped.retry.drain, "function");
    assert.strictEqual(wrapped.retry.size(), 0, "retryMax absent -> nothing remembered");
    assert.strictEqual(exportsObject[WRAPPED_CAMPAIGN_SPREAD], true);
    const { scheduler, scheduled } = fakeScheduler();
    assert.strictEqual(exportsObject.bindDurableScheduler(scheduler), true);
    assert.notStrictEqual(state.bound, scheduler, "the vendor holds the proxy");
    assert.strictEqual(Object.getPrototypeOf(state.bound), scheduler, "proxy inherits the scheduler");
    assert.strictEqual(state.bound.marker, "original");

    const job = windowJob(LNE_SYSTEM, HUB_A);
    const player = windowJob(PLAYER_SYSTEM, HUB_A);
    state.bound.schedule(job);
    state.bound.schedule(player);
    assert.strictEqual(scheduled.length, 2);
    assert.strictEqual(scheduled[0].self, scheduler, "original schedule runs on the original scheduler");
    assert.strictEqual(scheduled[0].job.dueAtMs, WINDOW_START + spreadOffsetMs(HUB_A, SPREAD_MS));
    assert.strictEqual(scheduled[1].job, player, "player hub: the same object");
    assert.deepStrictEqual(outcomes, ["SPREAD", "NOT_LNE"]);

    assert.strictEqual(exportsObject.unbindDurableScheduler({ schedule() {} }), false, "foreign scheduler: vendor false");
    assert.strictEqual(exportsObject.unbindDurableScheduler(scheduler), true, "original -> proxy unbound");
    assert.strictEqual(state.bound, null);
    assert.strictEqual(exportsObject.unbindDurableScheduler(), true, "no argument passes through");
    assert.strictEqual(state.unbindArgs.length, 3);
    assert.strictEqual(state.unbindArgs[2], null);
    assert.throws(() => exportsObject.bindDurableScheduler(null), TypeError, "vendor validation kept");

    const bind = exportsObject.bindDurableScheduler;
    assert.deepStrictEqual(wrapCampaignBinding(exportsObject, deps()), { ok: true, noop: true });
    assert.strictEqual(exportsObject.bindDurableScheduler, bind, "not wrapped twice");
    assert.deepStrictEqual(wrapCampaignBinding({}, deps()), { ok: false, reason: "BIND_NOT_A_FUNCTION" });
    assert.deepStrictEqual(wrapCampaignBinding({ bindDurableScheduler() {} }, deps()),
      { ok: false, reason: "UNBIND_NOT_A_FUNCTION" });
    assert.deepStrictEqual(wrapCampaignBinding(fakeExports().exportsObject, { spreadMs: SPREAD_MS }),
      { ok: false, reason: "DEPS_INVALID" });
  });

  test("T4 sovCampaignSpread: a throw in the decision -> the original schedule(job) once + failed; throwing claim -> "
    + "CLAIM_UNAVAILABLE", () => {
    const { exportsObject, state } = fakeExports();
    const outcomes = [];
    wrapCampaignBinding(exportsObject, deps({
      isVirtualAlliance: () => { throw new Error("map boom"); },
      onOutcome: (r) => { outcomes.push(r); throw new Error("telemetry boom"); },
    }));
    const { scheduler, scheduled } = fakeScheduler();
    exportsObject.bindDurableScheduler(scheduler);
    const job = windowJob(LNE_SYSTEM, HUB_A);
    const claimFails = windowJob(THROW_SYSTEM, HUB_A);
    state.bound.schedule(job);
    state.bound.schedule(claimFails);
    assert.strictEqual(scheduled.length, 2, "each job scheduled exactly once");
    assert.strictEqual(scheduled[0].job, job, "passthrough of the same object");
    assert.strictEqual(scheduled[1].job, claimFails);
    assert.deepStrictEqual(outcomes, ["failed", "CLAIM_UNAVAILABLE"]);
  });

  test("T6 sovCampaignSpread: start jobs remembered as NOT_LNE are re-scheduled after the map is ready in "
    + "slices, same jobID, due/still-player/re-scheduled jobs untouched, cap, failed whenReady clears", async () => {
    const { exportsObject, state } = fakeExports();
    let ready = false;
    const outcomes = [];
    const hubs = [HUB_A, HUB_A + 1, HUB_A + 2, HUB_A + 3, HUB_A + 4];
    const wrapped = wrapCampaignBinding(exportsObject, deps({
      retryMax: 5,
      isVirtualAlliance: (id) => ready && id === LNE_ALLIANCE,
      onOutcome: (r) => outcomes.push(r),
    }));
    const { scheduler, scheduled } = fakeScheduler();
    exportsObject.bindDurableScheduler(scheduler);
    const [a, b, c, d, e] = hubs.map((id) => windowJob(LNE_SYSTEM, id));
    const due = { ...c, dueAtMs: WINDOW_START - 10 };
    const player = windowJob(PLAYER_SYSTEM, HUB_A + 9);
    for (const job of [a, b, due, player, d, e]) state.bound.schedule(job);
    assert.strictEqual(wrapped.retry.size(), 5, "cap retryMax: e not remembered");
    state.bound.schedule({ ...b, payload: { targetID: b.payload.targetID, captureEpoch: b.payload.captureEpoch,
      reinforcementExitMs: WINDOW_START } });
    assert.strictEqual(wrapped.retry.size(), 4);
    scheduled.length = 0;
    ready = true;
    const waits = [];
    const out = await runCampaignRetry(wrapped.retry, {
      whenReady: () => Promise.resolve(), nowMs: () => WINDOW_START - 15, batch: 2, delayMs: 7,
      wait: (ms) => { waits.push(ms); return Promise.resolve(); },
    });
    assert.deepStrictEqual(out, { ok: true, spread: 2, skipped: 2, kept: 0, restored: 0, slices: 2 },
      "due job and player hub skipped");
    assert.deepStrictEqual(waits, [7], "one pause between the two slices");
    assert.deepStrictEqual(scheduled.map((s) => s.job.jobID), [a.jobID, d.jobID], "same jobIDs, no duplicate");
    assert.strictEqual(scheduled[0].self, scheduler);
    assert.strictEqual(scheduled[0].job.dueAtMs, WINDOW_START + spreadOffsetMs(a.payload.targetID, SPREAD_MS));
    assert.ok(outcomes.includes("RETRY_SPREAD") && outcomes.includes("RETRY_SKIPPED"));
    state.bound.schedule(player);
    assert.strictEqual(wrapped.retry.size(), 0);

    const second = fakeExports();
    const w2 = wrapCampaignBinding(second.exportsObject, deps({ retryMax: 10, isVirtualAlliance: () => false }));
    const s2 = fakeScheduler();
    second.exportsObject.bindDurableScheduler(s2.scheduler);
    second.state.bound.schedule(windowJob(LNE_SYSTEM, HUB_A));
    assert.strictEqual(w2.retry.size(), 1);
    const failed = await runCampaignRetry(w2.retry, { whenReady: () => Promise.reject(new Error("vc boom")),
      nowMs: () => 0, batch: 5, delayMs: 1, wait: () => Promise.resolve() });
    assert.deepStrictEqual(failed, { ok: false, reason: "NOT_READY", restored: 0 });
    assert.strictEqual(w2.retry.size(), 0);
    assert.strictEqual(s2.scheduled.length, 1, "no write on a failed whenReady");
  });

  test("T7 sovCampaignSpread SWEEP: after the first slice a newer vendor job of a remembered jobID (reinforced "
    + "or NOT_LNE) still drops the entry, nothing new is added, isStopped -> STOPPED", async () => {
    const { exportsObject, state } = fakeExports();
    let ready = false;
    const wrapped = wrapCampaignBinding(exportsObject, deps({
      retryMax: 10, isVirtualAlliance: (id) => ready && id === LNE_ALLIANCE }));
    const { scheduler, scheduled } = fakeScheduler();
    exportsObject.bindDurableScheduler(scheduler);
    const [a, b, c] = [HUB_A, HUB_A + 1, HUB_A + 2].map((id) => windowJob(LNE_SYSTEM, id));
    for (const job of [a, b, c]) state.bound.schedule(job);
    scheduled.length = 0;
    ready = true;
    const first = wrapped.retry.drain(WINDOW_START - 1000, 1, 0);
    assert.strictEqual(first.spread, 1);
    await first.settled;
    state.bound.schedule({ ...b, payload: { targetID: b.payload.targetID, captureEpoch: b.payload.captureEpoch,
      reinforcementExitMs: WINDOW_START } });
    ready = false;
    state.bound.schedule(c);
    state.bound.schedule(windowJob(LNE_SYSTEM, HUB_A + 5));
    assert.strictEqual(wrapped.retry.size(), 0, "both entries dropped, nothing added after the first drain");
    scheduled.length = 0;
    const second = wrapped.retry.drain(WINDOW_START - 1000, 5, 0);
    await second.settled;
    assert.strictEqual(second.spread, 0);
    assert.strictEqual(scheduled.length, 0, "the old window job never overwrites the newer vendor job");

    const other = fakeExports();
    const w2 = wrapCampaignBinding(other.exportsObject, deps({ retryMax: 10 }));
    other.exportsObject.bindDurableScheduler(fakeScheduler().scheduler);
    other.state.bound.schedule(windowJob(PLAYER_SYSTEM, HUB_A));
    const stopped = await runCampaignRetry(w2.retry, { whenReady: () => Promise.resolve(), nowMs: () => 0, batch: 5,
      delayMs: 1, wait: () => Promise.resolve(), isStopped: () => true });
    assert.deepStrictEqual(stopped, { ok: false, reason: "STOPPED", restored: 0 });
    assert.strictEqual(w2.retry.size(), 0);
  });

  test("T8 sovCampaignSpread R1: a recorded NOT_LNE window job with provisional on -> vendor gets dueAtMs + offset "
    + "(jobID, payload unchanged), counter PROVISIONAL; provisional off or retryMax 0 -> vendor time", () => {
    const run = (extra) => {
      const { exportsObject, state } = fakeExports();
      const outcomes = [];
      const wrapped = wrapCampaignBinding(exportsObject, deps({ isVirtualAlliance: () => false,
        onOutcome: (r) => outcomes.push(r), ...extra }));
      const { scheduler, scheduled } = fakeScheduler();
      exportsObject.bindDurableScheduler(scheduler);
      const job = windowJob(LNE_SYSTEM, HUB_A);
      state.bound.schedule(job);
      return { job, scheduled, outcomes, wrapped };
    };
    const offset = spreadOffsetMs(HUB_A, SPREAD_MS);
    assert.ok(offset > 0);
    const on = run({ retryMax: 5, provisional: true });
    assert.strictEqual(on.scheduled.length, 1);
    assert.strictEqual(on.scheduled[0].job.dueAtMs, WINDOW_START + offset, "provisional time");
    assert.strictEqual(on.scheduled[0].job.jobID, on.job.jobID);
    assert.deepStrictEqual(on.scheduled[0].job.payload, on.job.payload, "payload (windowEventMs) untouched");
    assert.strictEqual(on.job.dueAtMs, WINDOW_START, "input not mutated");
    assert.deepStrictEqual(on.outcomes, ["PROVISIONAL"]);
    assert.strictEqual(on.wrapped.retry.size(), 1);
    const off = run({ retryMax: 5 });
    assert.strictEqual(off.scheduled[0].job, off.job, "provisional off: the same object, vendor time (T6)");
    assert.deepStrictEqual(off.outcomes, ["NOT_LNE"]);
    assert.strictEqual(off.wrapped.retry.size(), 1);
    const noRetry = run({ retryMax: 0, provisional: true });
    assert.strictEqual(noRetry.scheduled[0].job, noRetry.job, "retryMax 0: nobody could correct -> vendor time");
    assert.deepStrictEqual(noRetry.outcomes, ["NOT_LNE"]);
  });

  test("T9 sovCampaignSpread R1: drain after ready - LNE hub kept without a write, player hub restored to the "
    + "original time, provisional time inside the margin skipped", async () => {
    const { exportsObject, state } = fakeExports();
    let ready = false;
    const outcomes = [];
    const wrapped = wrapCampaignBinding(exportsObject, deps({ retryMax: 10, provisional: true,
      isVirtualAlliance: (id) => ready && id === LNE_ALLIANCE, onOutcome: (r) => outcomes.push(r) }));
    const { scheduler, scheduled } = fakeScheduler();
    exportsObject.bindDurableScheduler(scheduler);
    const lne = windowJob(LNE_SYSTEM, HUB_A);
    const player = windowJob(PLAYER_SYSTEM, HUB_A + 9);
    const soon = { ...windowJob(LNE_SYSTEM, HUB_A + 1), dueAtMs: WINDOW_START - 2 * SPREAD_MS };
    for (const job of [lne, player, soon]) state.bound.schedule(job);
    assert.deepStrictEqual(outcomes, ["PROVISIONAL", "PROVISIONAL", "PROVISIONAL"]);
    assert.strictEqual(scheduled[1].job.dueAtMs, WINDOW_START + spreadOffsetMs(HUB_A + 9, SPREAD_MS),
      "player hub also provisional while the map is not ready");
    scheduled.length = 0;
    outcomes.length = 0;
    ready = true;
    const slice = wrapped.retry.drain(WINDOW_START - SPREAD_MS, 10, 0);
    await slice.settled;
    assert.strictEqual(slice.kept, 1);
    assert.strictEqual(slice.restored, 1);
    assert.strictEqual(slice.skipped, 1);
    assert.strictEqual(slice.spread, 0);
    assert.strictEqual(scheduled.length, 1, "only the player hub is written");
    assert.strictEqual(scheduled[0].self, scheduler, "original scheduler");
    assert.strictEqual(scheduled[0].job, player, "the original job object");
    assert.strictEqual(scheduled[0].job.dueAtMs, WINDOW_START);
    assert.deepStrictEqual(outcomes.sort(), ["RETRY_KEPT", "RETRY_RESTORED", "RETRY_SKIPPED"]);
  });

  test("T10 sovCampaignSpread R1: whenReady rejected -> restore() writes the originals of all provisional jobs in "
    + "slices; retryMax 1 -> the second job goes without a provisional time", async () => {
    const { exportsObject, state } = fakeExports();
    const outcomes = [];
    const wrapped = wrapCampaignBinding(exportsObject, deps({ retryMax: 3, provisional: true,
      isVirtualAlliance: () => false, onOutcome: (r) => outcomes.push(r) }));
    const { scheduler, scheduled } = fakeScheduler();
    exportsObject.bindDurableScheduler(scheduler);
    const jobs = [HUB_A, HUB_A + 1, HUB_A + 2].map((id) => windowJob(LNE_SYSTEM, id));
    for (const job of jobs) state.bound.schedule(job);
    assert.ok(scheduled.every((s, i) => s.job.dueAtMs === WINDOW_START + spreadOffsetMs(jobs[i].payload.targetID,
      SPREAD_MS)));
    scheduled.length = 0;
    const waits = [];
    const out = await runCampaignRetry(wrapped.retry, { whenReady: () => Promise.reject(new Error("vc boom")),
      nowMs: () => 0, batch: 2, delayMs: 9, wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
    assert.deepStrictEqual(out, { ok: false, reason: "NOT_READY", restored: 3 });
    assert.deepStrictEqual(waits, [9], "two restore slices, one pause");
    assert.deepStrictEqual(scheduled.map((s) => s.job), jobs, "originals, same objects (vendor time)");
    assert.strictEqual(wrapped.retry.size(), 0);
    assert.strictEqual(outcomes.filter((r) => r === "RETRY_RESTORED").length, 3);

    const small = fakeExports();
    const out2 = [];
    const w2 = wrapCampaignBinding(small.exportsObject, deps({ retryMax: 1, provisional: true,
      isVirtualAlliance: () => false, onOutcome: (r) => out2.push(r) }));
    const s2 = fakeScheduler();
    small.exportsObject.bindDurableScheduler(s2.scheduler);
    small.state.bound.schedule(jobs[0]);
    small.state.bound.schedule(jobs[1]);
    assert.deepStrictEqual(out2, ["PROVISIONAL", "NOT_LNE"]);
    assert.strictEqual(s2.scheduled[1].job, jobs[1], "over the limit: vendor time");
    assert.strictEqual(w2.retry.size(), 1);
  });

  test("T11 sovCampaignSpread R1 config + loader: key default false, env 1 -> true; the loader passes provisional "
    + "only with campaignSpreadRetryMax > 0", () => {
    const def = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.strictEqual(def.config.world.sovProjection.campaignSpreadProvisionalEnabled, false);
    const on = config.resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_WORLD_SOVPROJECTION_CAMPAIGN_SPREAD_PROVISIONAL_ENABLED: "1" } });
    assert.strictEqual(on.config.world.sovProjection.campaignSpreadProvisionalEnabled, true);

    const CAMPAIGN = path.join(path.sep, "x", "server", "src", "services", "sovereignty", "sovCampaignState");
    const silent = { log: () => {}, logError: () => {}, debug: () => {} };
    const viaLoader = (retryMax) => {
      const { exportsObject, state } = fakeExports();
      const moduleApi = { _cache: {}, _load: (request) => (request === CAMPAIGN ? exportsObject : {}) };
      const ctx = { state: {}, logger: silent, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
        config: { enabled: true, debug: false, dataDir: "/x", world: { sovProjection: { campaignSpreadEnabled: true,
          campaignSpreadMs: SPREAD_MS, campaignSpreadRetryMax: retryMax, campaignSpreadRetryBatch: 5,
          campaignSpreadRetryDelayMs: 10, campaignSpreadProvisionalEnabled: true } } } }) };
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), silent);
      moduleApi._load(CAMPAIGN, { filename: path.join(path.sep, "x", "server", "src", "index.js") });
      assert.strictEqual(ctx.state.sovCampaignSpread, "wrapped");
      const { scheduler, scheduled } = fakeScheduler();
      exportsObject.bindDurableScheduler(scheduler);
      const job = windowJob(LNE_SYSTEM, HUB_A);
      state.bound.schedule(job);
      return scheduled[0].job.dueAtMs;
    };
    assert.strictEqual(viaLoader(10), WINDOW_START + spreadOffsetMs(HUB_A, SPREAD_MS), "retryMax > 0: provisional");
    assert.strictEqual(viaLoader(0), WINDOW_START, "retryMax 0: no provisional");
  });

  test("T5 vendor facts freeze: campaign tick jobs go through durableScheduler.schedule, window payload "
    + "owned-hub epoch, the runtime binds through the module object", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const campaign = fs.readFileSync(path.join(src, "services", "sovereignty", "sovCampaignState.js"), "utf8");
    assert.ok(campaign.includes("durableScheduler.schedule(job)"), "the only schedule call");
    assert.strictEqual(campaign.split("durableScheduler.schedule(").length - 1, 1, "exactly one schedule call");
    assert.ok(campaign.includes('DURABLE_CAMPAIGN_TICK_JOB_TYPE = "sovereignty.campaign-tick"'), "job type");
    assert.ok(/payload: \{\s*targetID: Number\(state\.targetID\),\s*captureEpoch: String\(state\.captureEpoch \|\| ""\),\s*windowEventMs,\s*\}/
      .test(campaign), "window payload");
    assert.ok(campaign.includes("`owned-hub:${target.solarSystemID}:${target.targetID}:`"), "owned-hub epoch");
    assert.ok(/if \(scheduler && scheduler !== durableScheduler\) \{/.test(campaign), "unbind compares identity");
    assert.ok(campaign.includes("await scheduleCampaignTick(refreshedState, null, nowMs)"), "reconciliation schedules");
    assert.ok(/String\(job\.jobID \|\| ""\) !== expected\.jobID \|\|\s*String\(payload\.captureEpoch \|\| ""\) !== String\(state\.captureEpoch \|\| ""\)\s*\)/
      .test(campaign), "stale check on jobID + captureEpoch only");
    const runtime = fs.readFileSync(path.join(src, "services", "scheduler", "productionSchedulerRuntime.js"), "utf8");
    assert.ok(runtime.includes("sovereigntyCampaignOwner.bindDurableScheduler(scheduler)"), "bind via module object");
    assert.ok(runtime.includes("sovereigntyCampaignOwner.unbindDurableScheduler(scheduler)"), "unbind via module object");
    assert.ok(!/\{[^}]*bindDurableScheduler[^}]*\}\s*=\s*require/.test(runtime), "never destructured");
  });
};
