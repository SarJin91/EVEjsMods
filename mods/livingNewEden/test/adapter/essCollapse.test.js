"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { install, checkFingerprints, functionText, COUNTER_NAMES } = require("../../lib/adapter/essCollapse");
const { resolveConfig, SCHEMA } = require("../../config");
const loader = require("../../loader");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const DAY_MS = 86400000;
const CONFIG = Object.freeze({ pumpIntervalMs: 250, maxSystemsPerTick: 4, tickBudgetMs: 25, startDelayMs: 30000,
  maxHoldMs: 600000, retryDelayMs: 60000, maxRetries: 5, maxPending: 20000 });

function rig(config = {}, opts = {}) {
  const clock = { t: 1_000_000, perf: 0 };
  const timers = [];
  const calls = { sync: [], schedule: [], recover: 0, list: 0, vendorJob: 0, vendorReconcile: 0 };
  const lines = [];
  const counts = [];
  const handleJob = () => {
    calls.vendorJob += 1;
    return Promise.resolve("vendor");
  };
  const reconcile = () => {
    calls.vendorReconcile += 1;
    return Promise.resolve();
  };
  const ex = {
    handleJob, reconcile,
    synchronize(id) {
      calls.sync.push(id);
      clock.perf += opts.syncMs || 0;
      if (opts.fail && opts.fail.has(id)) return Promise.reject(new Error(`boom ${id}`));
      return opts.hold ? opts.hold(id) : Promise.resolve();
    },
    schedule(id, kind, dueAtMs) {
      calls.schedule.push([id, kind, dueAtMs]);
      return Promise.resolve();
    },
  };
  const out = install({
    settlementExports: ex,
    deps: {
      recoverLosses: () => { calls.recover += 1; },
      listBankSystemIds: () => {
        calls.list += 1;
        return { ok: true, ids: opts.banks || [] };
      },
      now: () => clock.t,
      perfNow: () => clock.perf,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      log: (line) => lines.push(line),
      onCount: (name, n) => counts.push([name, n]),
    },
    config: { ...CONFIG, ...config },
  });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  const step = async () => {
    const next = timers.shift();
    assert.ok(next, "a timer is armed");
    clock.t += next.ms;
    await next.fn();
  };
  const steps = async (n) => {
    for (let i = 0; i < n && timers.length > 0; i += 1) await step();
  };
  return { ex, core: out.core, clock, timers, calls, lines, counts, step, steps, handleJob, reconcile };
}

function job(systemID, kind) {
  return { jobID: `ess:${systemID}:${kind}`, type: "ess.settlement", payload: { systemID, kind, generation: "" } };
}

module.exports = ({ test, skip }) => {
  test("EC1 ess collapse: 30 days x 50 systems -> one synchronize per system, 0 schedule, nothing before ready",
    async () => {
      const r = rig();
      const systems = Array.from({ length: 50 }, (_, i) => 30000001 + i);
      const kinds = [...Array(262).fill("autopay"), ...Array(30).fill("dbs"), "recover", "link", "link", "link"];
      assert.strictEqual(kinds.length, 296);
      assert.ok((262 - 1) * 9900 * 1000 <= 30 * DAY_MS, "262 autopay jobs every 9900 s (first at 0) fit into 30 days");
      for (const id of systems) {
        for (const kind of kinds) {
          const p = r.ex.handleJob(job(id, kind));
          assert.ok(p instanceof Promise);
          assert.strictEqual(await p, undefined, "resolved at once (vendor acks)");
        }
      }
      await r.steps(200);
      assert.deepStrictEqual([r.calls.sync.length, r.calls.vendorJob, r.core.state()], [0, 0, "armed"]);
      r.core.markReady("booted");
      await r.steps(30000 / 250 + 20);
      assert.strictEqual(r.core.state(), "ready");
      assert.deepStrictEqual([...r.calls.sync].sort(), systems, "exactly once per system");
      assert.strictEqual(r.calls.schedule.length, 0);
      const s = r.core.stats();
      assert.deepStrictEqual([s.collapsed, s.maintained, s.pending, s.failed], [50 * 296, 50, 0, 0]);
      assert.ok(r.lines.includes("essCollapse: ready (booted)"), r.lines.join("\n"));
      assert.ok(r.lines.some((l) => l.startsWith(`essCollapse: drained systems=50 jobs=${50 * 296} in `)),
        r.lines.join("\n"));
      assert.ok(r.counts.every(([name]) => COUNTER_NAMES.includes(name)));
    });

  test("EC2 ess collapse: reconcile without schedule; after start recoverLosses once, one synchronize per bank",
    async () => {
      const r = rig({ startDelayMs: 0 }, { banks: [1, 2, 3] });
      await r.ex.handleJob(job(3, "autopay"));
      assert.strictEqual(await r.ex.reconcile(), undefined);
      assert.deepStrictEqual([r.calls.schedule.length, r.calls.recover, r.calls.list, r.calls.vendorReconcile],
        [0, 0, 0, 0], "nothing on the boot path");
      r.core.markReady("booted");
      await r.steps(5);
      assert.deepStrictEqual([r.calls.recover, r.calls.list], [1, 1]);
      assert.deepStrictEqual(r.calls.sync, [3, 1, 2], "the job system first, no repeat");
      assert.strictEqual(r.calls.schedule.length, 0);
      assert.strictEqual(r.core.stats().recoverAll, 1);
      r.core.disable("probe", "DRIFT handleJob");
      assert.strictEqual(r.core.state(), "disabled:probe");
      assert.strictEqual(await r.ex.handleJob(job(9, "dbs")), "vendor");
      assert.strictEqual(r.calls.vendorJob, 1);
      assert.ok(r.lines.includes("essCollapse: disabled:probe (DRIFT handleJob) - vendor ESS jobs"));
    });

  test("EC3 ess collapse: a failing synchronize -> durable recover retry, gave up after maxRetries", async () => {
    const r = rig({ startDelayMs: 0, maxRetries: 2 }, { fail: new Set([7]) });
    r.core.markReady("booted");
    await r.ex.handleJob(job(7, "autopay"));
    await r.steps(1);
    assert.deepStrictEqual(r.calls.schedule, [[7, "recover", r.clock.t + 60000]], "one durable retry");
    await r.ex.handleJob(job(7, "recover"));
    await r.steps(1);
    assert.strictEqual(r.calls.schedule.length, 2);
    await r.ex.handleJob(job(7, "recover"));
    await r.steps(1);
    assert.strictEqual(r.calls.schedule.length, 2, "no schedule after maxRetries");
    const s = r.core.stats();
    assert.deepStrictEqual([s.failed, s.retried, s.gaveUp, s.pending, r.calls.sync.length], [3, 2, 1, 0, 3]);
    assert.ok(r.lines.some((l) => l.startsWith("essCollapse: gave up system=7 after 3 - next boot reconcile")),
      r.lines.join("\n"));
    await r.steps(3);
    assert.strictEqual(r.calls.sync.length, 3, "no hot loop in RAM");
  });

  test("EC4 ess collapse: maxSystemsPerTick, tickBudgetMs, maxHoldMs fuse, steps never overlap", async () => {
    const perStep = async (r) => {
      const out = [];
      while (r.core.stats().pending > 0) {
        const before = r.calls.sync.length;
        await r.step();
        out.push(r.calls.sync.length - before);
      }
      return out;
    };
    const a = rig({ startDelayMs: 0 });
    for (let id = 1; id <= 10; id += 1) await a.ex.handleJob(job(id, "dbs"));
    a.core.markReady("booted");
    assert.deepStrictEqual(await perStep(a), [4, 4, 2], "maxSystemsPerTick");
    const b = rig({ startDelayMs: 0 }, { syncMs: 10 });
    for (let id = 1; id <= 7; id += 1) await b.ex.handleJob(job(id, "dbs"));
    b.core.markReady("booted");
    assert.deepStrictEqual(await perStep(b), [3, 3, 1], "tickBudgetMs 25 with 10 ms per call");
    const c = rig({ maxHoldMs: 60000 });
    await c.ex.handleJob(job(5, "link"));
    await c.steps(60000 / 250 - 1);
    assert.strictEqual(c.calls.sync.length, 0);
    await c.steps(1);
    assert.deepStrictEqual(c.calls.sync, [5]);
    assert.ok(c.lines.includes("essCollapse: ready by max_hold"), c.lines.join("\n"));
    let release = null;
    const d = rig({ startDelayMs: 0 }, { hold: () => new Promise((resolve) => { release = resolve; }) });
    await d.ex.handleJob(job(1, "dbs"));
    await d.ex.handleJob(job(2, "dbs"));
    d.core.markReady("booted");
    const next = d.timers.shift();
    const running = next.fn();
    await Promise.resolve();
    assert.deepStrictEqual([d.timers.length, d.calls.sync], [0, [1]], "no second step while the first runs");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await running;
    assert.deepStrictEqual([d.timers.length, d.calls.sync], [1, [1, 2]]);
  });

  const real = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  test("EC5 ess collapse: fingerprints, drift = no wrap, vendor facts, loader knobs off / outside world", async () => {
    assert.ok(real.ok, "EveJS server/src not found above the mod");
    const read = (...rel) => fs.readFileSync(path.join(real.srcDir, ...rel), "utf8").replace(/\r\n/g, "\n");
    const ess = read("services", "dynamic", "essSettlementRuntime.js");
    assert.strictEqual(checkFingerprints(ess), null, "today's vendor");
    const changed = ess.replace("maintain(Number(job.payload.systemID))",
      "maintain(Number(job.payload.systemID), job.payload.kind)");
    assert.strictEqual(checkFingerprints(changed), "handleJob");
    const handleJob = () => 1;
    const reconcile = () => 2;
    const ex = { handleJob, reconcile, synchronize() {}, schedule() {} };
    const lines = [];
    const out = install({ settlementExports: ex, sourceText: changed, config: CONFIG,
      deps: { log: (l) => lines.push(l), setTimer: () => assert.fail("no timer on drift") } });
    assert.deepStrictEqual([out.ok, out.core.state(), ex.handleJob === handleJob, ex.reconcile === reconcile],
      [true, "disabled:drift", true, true]);
    assert.deepStrictEqual(lines, ["essCollapse: disabled:drift (handleJob) - vendor ESS jobs"]);
    assert.strictEqual(functionText(ess, "handleJob"),
      "function handleJob(job) { return runSerialized(() => maintain(Number(job.payload.systemID))); }");
    const rec = functionText(ess, "reconcile");
    assert.ok(rec.includes("require(\"./dynamicBountyRuntime\").recoverLosses();"), rec);
    assert.ok(rec.includes("await schedule(bank.solarSystemID, \"recover\", state.now());"), rec);
    assert.ok(ess.includes("synchronize: systemID => runSerialized(() => maintain(systemID))"));
    assert.ok(read("services", "dynamic", "dynamicBountyRuntime.js").includes("policy.idle(output, target - cursor, config)"));
    const sched = read("services", "scheduler", "productionSchedulerRuntime.js");
    assert.ok(sched.includes("job => essOwner.handleJob(job)") && sched.includes("await essOwner.reconcile();"),
      "the scheduler reads both through the module object");
    const boot = (env, configEnv) => {
      const fake = { handleJob, reconcile, synchronize() {}, schedule() {} };
      const logged = [];
      const moduleApi = { _cache: {}, _resolveFilename: (r) => r,
        _load: (request) => (request.includes("essSettlementRuntime") ? fake : {}) };
      const res = loader.install({ moduleApi, globalObj: {}, env, isMainThread: true,
        logger: { log: (l) => logged.push(l), debug() {}, logError() {} },
        loadConfig: () => resolveConfig({ modDir: MOD_DIR, env: configEnv }) });
      assert.ok(res.ok);
      moduleApi._load("./essSettlementRuntime", { filename: "/x/server/src/services/scheduler/a.js" });
      return { fake, logged: logged.filter((l) => l.includes("essCollapse")) };
    };
    const ON = { EVEJS_LNE_WORLD_ESS_COLLAPSE_ENABLED: "1" };
    const WORLD = { EVEJS_GAMESTORE_OWNER_ROLE: "world" };
    for (const [env, configEnv, why] of [[WORLD, {}, "flag off"], [{}, ON, "no role"],
      [{ EVEJS_GAMESTORE_OWNER_ROLE: "maintenance" }, ON, "other role"]]) {
      const b = boot(env, configEnv);
      assert.deepStrictEqual([b.fake.handleJob === handleJob, b.fake.reconcile === reconcile, b.logged],
        [true, true, []], why);
    }
    const on = boot(WORLD, ON);
    assert.deepStrictEqual([on.fake.handleJob === handleJob, on.fake.reconcile === reconcile], [true, true]);
    assert.deepStrictEqual(on.logged, ["essCollapse: disabled:drift (source) - vendor ESS jobs"]);
    const cfg = resolveConfig({ modDir: MOD_DIR }).config.world.essCollapse;
    assert.deepStrictEqual(cfg, { enabled: false, ...CONFIG }, "defaults");
  });

  test("EC7 ess collapse: before the boot (empty cache, no adapter) the pump loads DBS / the banks via moduleApi._load",
    async () => {
      assert.ok(real.ok, "EveJS server/src not found above the mod");
      const DBS = "services/dynamic/dynamicBountyRuntime.js";
      const BANKS = "services/dynamic/dynamicResourceState.js";
      const norm = (p) => String(p).replace(/\\/g, "/");
      const fakeApi = (srcDir, opts = {}) => {
        const loads = [];
        const counter = { recover: 0 };
        const dbs = { recoverLosses: () => { counter.recover += 1; }, maintain() {} };
        const banks = { listSystemStates: () => [{ solarSystemID: 30000142 }] };
        const api = {
          _cache: {},
          _load(request, parent, isMain) {
            loads.push([norm(request), parent, isMain]);
            if (opts.throws) throw new Error("Cannot find module");
            if (norm(request) === `${norm(srcDir)}/${DBS}`) return dbs;
            if (norm(request) === `${norm(srcDir)}/${BANKS}`) return banks;
            return {};
          },
        };
        return { api, loads, counter, dbs, banks };
      };
      const src = "/x/server/src";
      const a = fakeApi(src);
      const ctx = { moduleApi: a.api, state: { dbsExports: null } };
      assert.strictEqual(loader.essGameExportsOf(ctx, src, DBS, { load: true }), a.dbs);
      assert.strictEqual(loader.essGameExportsOf(ctx, src, BANKS, { load: true }), a.banks);
      assert.deepStrictEqual(a.loads, [[`${src}/${DBS}`, null, false], [`${src}/${BANKS}`, null, false]]);
      assert.strictEqual(loader.essGameExportsOf(ctx, src, DBS), null);
      assert.strictEqual(loader.essGameExportsOf(ctx, null, DBS, { load: true }), null, "no source dir, no load");
      assert.strictEqual(a.loads.length, 2);
      const t = fakeApi(src, { throws: true });
      assert.strictEqual(loader.essGameExportsOf({ moduleApi: t.api, state: {} }, src, DBS, { load: true }), null);

      const run = async (opts) => {
        const f = fakeApi(real.srcDir, opts);
        const settlement = { handleJob: () => Promise.resolve("vendor"), reconcile: () => Promise.resolve(),
          synchronize: (id) => { synced.push(id); return Promise.resolve(); }, schedule: () => Promise.resolve() };
        const synced = [];
        const essFile = path.join(real.srcDir, "services", "dynamic", "essSettlementRuntime.js");
        const essEntry = { filename: essFile, exports: settlement };
        f.api._cache[essFile] = essEntry;
        const timers = [];
        const lines = [];
        const fctx = {
          isMainThread: true, env: { EVEJS_GAMESTORE_OWNER_ROLE: "world" }, moduleApi: f.api,
          logger: { log: (l) => lines.push(l), debug() {}, logError: (l) => lines.push(l) },
          loadConfig: () => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_ESS_COLLAPSE_ENABLED: "1",
            EVEJS_LNE_WORLD_ESS_COLLAPSE_START_DELAY_MS: "0" } }),
          setTimer: (fn, ms) => timers.push({ fn, ms }), telemetry: null, adapter: null,
          state: { configResult: null, dbsExports: null, essCollapse: null, essCollapseInstall: null,
            essRepositoryFastCore: null, essRepositoryFast: null },
        };
        const hooks = loader.buildHooks(fctx);
        loader.installModuleHook(f.api, hooks.filter((h) => h.name === "dbsKillmailScope"), fctx.logger);
        hooks.find((h) => h.name === "essSettlementJobs").run(settlement);
        const core = fctx.state.essCollapse;
        assert.ok(core, `${fctx.state.essCollapseInstall} ${lines.join("\n")}`);
        await settlement.reconcile();
        core.markReady("booted");
        for (let i = 0; i < 400 && timers.length > 0 && synced.length === 0; i += 1) await timers.shift().fn();
        return { f, core, synced, lines, fctx, essEntry };
      };
      const ok = await run({});
      assert.deepStrictEqual([ok.f.counter.recover, ok.core.stats().failed, ok.synced], [1, 0, [30000142]],
        ok.lines.join("\n"));
      const dbsLoad = ok.f.loads.find((l) => l[0].endsWith(DBS));
      assert.ok(dbsLoad && dbsLoad[1] === ok.essEntry && dbsLoad[2] === false, "parent = cached essSettlementRuntime");
      assert.strictEqual(ok.fctx.state.dbsExports, ok.f.dbs, "dbsKillmailScope ran (dbsExports set)");
      assert.strictEqual(typeof ok.fctx.state.dbsKillmailScope, "string", "the DBS scope hook decided");
      assert.ok(ok.lines.every((l) => !l.includes("failed")), ok.lines.join("\n"));
      const bad = await run({ throws: true });
      assert.deepStrictEqual([bad.f.counter.recover, bad.core.stats().failed, bad.synced], [0, 1, []]);
      assert.ok(bad.lines.includes("essCollapse: recoverLosses failed - dynamicBountyRuntime not loaded"),
        bad.lines.join("\n"));
      assert.ok(bad.lines.some((l) => l.startsWith("essCollapse: bank list failed - dynamicResourceState")),
        bad.lines.join("\n"));
    });

  const composeFile = findCompose();
  if (!composeFile) {
    skip("EC6 compose essCollapse keys", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("EC6 compose: every world.essCollapse.* SCHEMA key has a line, enabled :-1", () => {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const rows = SCHEMA.filter((row) => row.key.startsWith("world.essCollapse."));
      assert.strictEqual(rows.length, 9);
      const fallback = (row) => (row.key === "world.essCollapse.enabled" ? "1" : "");
      const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)
        || !text.includes(`\${${row.env}:-${fallback(row)}}`)).map((row) => row.env);
      assert.deepStrictEqual(missing, []);
    });
  }
};
