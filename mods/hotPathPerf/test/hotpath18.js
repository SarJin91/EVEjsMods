"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const stallWatchLib = require("../lib/stallWatch");
const { createSchedulerDueGate } = require("../lib/schedulerDueGate");
const { loadConfig, DEFAULTS, ENV, STALL_WATCH_RANGES } = require("../config");

const { shouldStart, startStallWatch, readBreadcrumb, LABEL_MAX_BYTES } = stallWatchLib;
const MISSING = path.join(__dirname, "missing.json");
const FIXTURE = path.join(__dirname, "fixtures", "stallWatchBusy.js");
const COMPOSE = path.resolve(__dirname, "../../../compose.yaml");

function fakeDeps() {
  const counts = { workers: 0, intervals: 0, timeouts: 0, posted: [], terminated: 0 };
  const timeouts = [];
  return {
    counts,
    timeouts,
    createWorker: (file, opts) => {
      counts.workers += 1;
      counts.lastFile = file;
      counts.lastOpts = opts;
      return { on() {}, unref() {}, postMessage: (m) => counts.posted.push(m), terminate: () => { counts.terminated += 1; } };
    },
    setInterval: () => { counts.intervals += 1; return { unref() {} }; },
    setTimeout: (fn, ms) => { counts.timeouts += 1; const h = { fn, ms, unref() {} }; timeouts.push(h); return h; },
    clearInterval() {},
    clearTimeout() {},
  };
}

function deferred() {
  const reactions = [];
  return {
    then(ok, err) {
      const next = deferred();
      reactions.push({ ok, err, next });
      return next;
    },
    resolve(value) {
      for (const r of reactions.splice(0)) r.next.resolve(r.ok ? r.ok(value) : value);
    },
    reject(error) {
      for (const r of reactions.splice(0)) {
        if (r.err) r.next.resolve(r.err(error));
        else r.next.reject(error);
      }
    },
  };
}
const resolvedNow = (value) => ({ then: (ok) => resolvedNow(ok ? ok(value) : value) });

function inspectorAvailable() {
  try {
    const inspector = require("inspector");
    return typeof inspector.Session === "function"
      && typeof inspector.Session.prototype.connectToMainThread === "function";
  } catch (_error) {
    return false;
  }
}

function register(ctx) {
  const { test, src, loader, config, createRecorder } = ctx;

  test("hotpath18 SW1 shouldStart (world/no_role/scheduler/*.worker.js/thread/flag), breadcrumb ≤ 120 B and seq, config", () => {
    const world = { EVEJS_GAMESTORE_OWNER_ROLE: "world" };
    assert.deepStrictEqual(shouldStart({ env: world, isMainThread: true, argv1: "/app/server/index.js", enabled: true }),
      { start: true, reason: "world" });
    assert.strictEqual(shouldStart({ env: {}, isMainThread: true, argv1: "/app/server/index.js", enabled: true }).reason, "no_role");
    assert.strictEqual(shouldStart({ env: { EVEJS_GAMESTORE_OWNER_ROLE: "scheduler" }, isMainThread: true,
      argv1: "/app/server/index.js", enabled: true }).reason, "role:scheduler");
    assert.strictEqual(shouldStart({ env: world, isMainThread: true,
      argv1: "/app/server/src/services/scheduler/durableSchedulerProcess.worker.js", enabled: true }).reason, "worker_process");
    assert.strictEqual(shouldStart({ env: world, isMainThread: false, argv1: "/app/server/index.js", enabled: true }).reason,
      "not_main_thread");
    assert.strictEqual(shouldStart({ env: world, isMainThread: true, argv1: "/app/server/index.js", enabled: false }).reason,
      "disabled");
    const deps = fakeDeps();
    const lines = [];
    const started = startStallWatch({ thresholdMs: 5000, sampleEveryMs: 20000, maxSamples: 40, frames: 12, windowMs: 1800000,
      heartbeatMs: 250, serverRoot: "/app/server", log: (l) => lines.push(l), ...deps });
    assert.strictEqual(started.ok, true);
    assert.strictEqual(deps.counts.workers, 1);
    assert.deepStrictEqual(deps.counts.lastOpts.execArgv, [], "thread without the mods' --require");
    assert.strictEqual(deps.counts.lastOpts.resourceLimits.maxOldGenerationSizeMb, 32);
    assert.strictEqual(deps.counts.lastFile, stallWatchLib.WORKER_FILE);
    const watch = started.watch;
    assert.strictEqual(readBreadcrumb(watch.sab).seq, 0);
    watch.breadcrumb("call:schedule:ess.settlement");
    let c = readBreadcrumb(watch.sab);
    assert.strictEqual(c.label, "call:schedule:ess.settlement");
    assert.strictEqual(c.seq, 1);
    watch.breadcrumb("x".repeat(300));
    c = readBreadcrumb(watch.sab);
    assert.strictEqual(c.label, "x".repeat(LABEL_MAX_BYTES), "cut to 120 B");
    assert.strictEqual(c.seq, 2);
    watch.breadcrumb("ż".repeat(100));
    assert.strictEqual(readBreadcrumb(watch.sab).label, "ż".repeat(60), "UTF-8 cut at a character boundary");
    watch.setPhase("owners");
    assert.strictEqual(readBreadcrumb(watch.sab).phase, "owners");
    watch.setPhase("nonsense");
    assert.strictEqual(readBreadcrumb(watch.sab).phase, "owners");
    watch.stop("test");
    watch.stop("again");
    assert.deepStrictEqual(deps.counts.posted, [{ stop: true, reason: "test" }], "stop once");
    for (const t of deps.timeouts.filter((h) => h.ms === 1000)) t.fn();
    assert.strictEqual(deps.counts.terminated, 1, "terminate after 1 s");
    assert.deepStrictEqual(watch.stats(), { stalls: 0, maxGapMs: 0, samples: 0 });
    const failed = startStallWatch({ ...deps, createWorker: () => { throw new Error("nope"); }, log: (l) => lines.push(l) });
    assert.deepStrictEqual(failed, { ok: false, reason: "worker_failed" });
    assert.ok(lines.some((l) => /^stallWatch: worker failed: nope$/.test(l)), lines.join("|"));
    const def = loadConfig({ env: {}, settingsPath: MISSING });
    assert.strictEqual(def.stallWatch, true);
    assert.strictEqual(def.stallWatchThresholdMs, 5000);
    assert.strictEqual(def.schedulerOwnersSlowCallMs, 10000);
    const warns = [];
    const clamped = loadConfig({ env: { HOTPATH_STALL_WATCH_THRESHOLD_MS: "100", HOTPATH_STALL_WATCH_FRAMES: "99" },
      settingsPath: MISSING, warn: (m) => warns.push(m) });
    assert.strictEqual(clamped.stallWatchThresholdMs, 500);
    assert.strictEqual(clamped.stallWatchFrames, 50);
    assert.ok(warns.some((m) => /stallWatchThresholdMs=100 clamped to 500/.test(m)), warns.join("|"));
    assert.strictEqual(Object.keys(STALL_WATCH_RANGES).length, 7);
    void config;
  });

  test("hotpath18 SW2 child process: stall line with a breadcrumb, sample with busyCulpritFn during the loop, stall ended, code 0; SW2b thread exit while paused", () => {
    if (!inspectorAvailable()) {
      console.log("SKIP hotpath18 SW2: node without inspector.Session#connectToMainThread");
      return;
    }
    const run = childProcess.spawnSync(process.execPath, [FIXTURE, "2500"], { timeout: 8000, encoding: "utf8" });
    const out = String(run.stdout || "");
    assert.strictEqual(run.status, 0, `status=${run.status} signal=${run.signal}\n${out}\n${run.stderr}`);
    const lines = out.split(/\r?\n/);
    const stallAt = lines.findIndex((l) => /\[hotPathPerf\] stallWatch: stall gapMs=\d+ phase=boot .*last=call:schedule:test\.type@-/.test(l));
    const sampleAt = lines.findIndex((l) => /stallWatch: sample n=1 frames: busyCulpritFn@.*stallWatchBusy\.js:\d+/.test(l));
    const busyDoneAt = lines.indexOf("fixture: busy done");
    const endedAt = lines.findIndex((l) => /stallWatch: stall ended gapMs=\d+ samples=\d+/.test(l));
    assert.ok(stallAt >= 0 && sampleAt > stallAt, out);
    assert.ok(busyDoneAt > sampleAt, `sample during the loop (before the busy loop ends)\n${out}`);
    assert.ok(endedAt > busyDoneAt, out);
    const b = childProcess.spawnSync(process.execPath, [FIXTURE, "1200", "--exit-in-pause"], { timeout: 8000, encoding: "utf8" });
    const outB = String(b.stdout || "");
    assert.strictEqual(b.status, 0, `SW2b status=${b.status} signal=${b.signal}\n${outB}\n${b.stderr}`);
    assert.ok(outB.includes("stallWatch: test exit in pause"), outB);
    assert.ok(outB.includes("fixture: busy done"), `main thread resumed after the session dropped\n${outB}`);
  });

  test("hotpath18 SW3 HOTPATH_STALL_WATCH=0 without thread and timer; scheduler role / *.worker.js does not start; no_role waits for world", () => {
    const savedLoad = Module._load;
    const off = loadConfig({ env: { HOTPATH_STALL_WATCH: "0" }, settingsPath: MISSING });
    assert.strictEqual(off.stallWatch, false);
    const d0 = fakeDeps();
    const worldDeps = { env: { EVEJS_GAMESTORE_OWNER_ROLE: "world" }, argv1: "/app/server/index.js", isMainThread: true, log() {} };
    let st = null;
    try {
      st = loader.install({ env: {}, config: { ...off, statsLogMinutes: 0 }, stallWatchDeps: { ...worldDeps, ...d0 } });
      assert.ok(st, "install returns the state");
      Module._load("path", null, false);
      Module._load("path", null, false);
    } finally {
      Module._load = savedLoad;
      delete globalThis[loader.INSTALL_FLAG];
    }
    assert.strictEqual(st.stallWatchPending, false);
    assert.strictEqual(st.stallWatchLib, null);
    assert.strictEqual(st.stallWatch, null);
    assert.strictEqual(d0.counts.workers, 0, "no thread");
    assert.strictEqual(d0.counts.intervals, 0, "no setInterval");
    const stateWith = (deps) => {
      const s = loader.createState({ ...config, stallWatch: true }, createRecorder(config, () => {}));
      s.stallWatch = null;
      s.stallWatchPending = true;
      s.stallWatchLib = stallWatchLib;
      s.stallWatchDeps = deps;
      return s;
    };
    const scheduler = fakeDeps();
    const sch = stateWith({ ...worldDeps, ...scheduler, env: { EVEJS_GAMESTORE_OWNER_ROLE: "scheduler" } });
    const childDeps = fakeDeps();
    const child = stateWith({ ...worldDeps, ...childDeps,
      argv1: "/app/server/src/services/scheduler/durableSchedulerProcess.worker.js" });
    const env = {};
    const later = fakeDeps();
    const lines = [];
    const wait = stateWith({ ...worldDeps, ...later, env, log: (l) => lines.push(l) });
    try {
      loader.installHook(sch);
      loader.installHook(child);
      loader.installHook(wait);
      Module._load("path", null, false);
      Module._load("path", null, false);
      assert.strictEqual(wait.stallWatchPending, true, "no_role: waits");
      env.EVEJS_GAMESTORE_OWNER_ROLE = "world";
      Module._load("path", null, false);
      Module._load("path", null, false);
    } finally {
      Module._load = savedLoad;
    }
    assert.strictEqual(sch.stallWatchPending, false);
    assert.strictEqual(child.stallWatchPending, false);
    assert.strictEqual(scheduler.counts.workers + childDeps.counts.workers, 0, "scheduler / *.worker.js without a start");
    assert.strictEqual(later.counts.workers, 1, "start once, after the world role is set");
    assert.ok(wait.stallWatch && typeof wait.stallWatch.breadcrumb === "function");
    assert.strictEqual(later.counts.lastOpts.workerData.serverRoot, "/app/server");
    assert.ok(lines.some((l) => /^stallWatch: armed pid=\d+ role=world thresholdMs=5000 windowMs=1800000 /.test(l)), lines.join("|"));
    const gate = loader.createDueGateOf(config, () => {}, wait);
    let client = null;
    gate.capture(() => {
      gate.wrapOnEvent(() => {});
      client = gate.wrapClient(Object.freeze({ call: () => resolvedNow(1) }));
    });
    client.call("list");
    assert.strictEqual(readBreadcrumb(wait.stallWatch.sab).label, "reply:list:list");
  });

  test("hotpath18 SW4 start() timeline, reply breadcrumb before the vendor continuation, slow call, phases", () => {
    let t = 1_700_000_000_000;
    const now = () => t;
    const events = [];
    const lines = [];
    const gate = createSchedulerDueGate({ types: ["ess.settlement"], releaseDelayMs: 30000, maxHoldMs: 300000,
      pumpIntervalMs: 100, batch: 8, maxInFlight: 2, minLeaseLeftMs: 10000, staleDropMs: 120000, maxHeld: 100000,
      now, setTimer: () => ({}), clearTimer() {}, log: (l) => lines.push(l), slowCallMs: 10000,
      onBreadcrumb: (label) => events.push(`crumb:${label}`), onPhase: (p) => events.push(`phase:${p}`) });
    const pending = [];
    let onEvent = null;
    let client = null;
    gate.capture(() => {
      onEvent = gate.wrapOnEvent(() => events.push("vendor-onEvent"));
      client = gate.wrapClient(Object.freeze({ call: (cmd) => {
        events.push(`vendor-call:${cmd}`);
        if (cmd === "schedule") return resolvedNow({ ok: true });
        const d = deferred();
        pending.push(d);
        return d;
      } }));
    });
    onEvent({ topic: "scheduler.due", payload: { jobID: "job:1", type: "B", leaseToken: "job:1#1", leaseUntilMs: t + 30000 } });
    assert.deepStrictEqual(events.splice(0), ["crumb:due:B", "vendor-onEvent"]);
    const startD = deferred();
    const rt = gate.wrapRuntime({ start: () => startD, getState: () => "idle", shutdown() {} });
    rt.start();
    assert.deepStrictEqual(events.splice(0), ["phase:owners"]);
    for (let i = 0; i < 3; i += 1) {
      t += 1000;
      client.call("schedule", { type: "A", jobID: `a:${i}` });
    }
    assert.deepStrictEqual(events.splice(0).filter((e) => e.startsWith("crumb:call")),
      ["crumb:call:schedule:A", "crumb:call:schedule:A", "crumb:call:schedule:A"]);
    const p = client.call("validateLease", { jobID: "job:1", leaseToken: "job:1#1" });
    p.then(() => events.push("vendor-continuation"));
    assert.deepStrictEqual(events.splice(0), ["crumb:call:validateLease:B", "vendor-call:validateLease"]);
    t += 12000;
    pending[0].resolve({ ok: true });
    assert.deepStrictEqual(events.splice(0), ["crumb:reply:validateLease:B", "vendor-continuation"],
      "reply breadcrumb before the vendor continuation");
    assert.ok(lines.some((l) => l === "scheduler owners: slow call cmd=validateLease label=B rtMs=12000 phase=owners"),
      lines.join("|"));
    assert.ok(!lines.some((l) => /slow call cmd=schedule/.test(l)), "fast calls without a line");
    assert.strictEqual(lines.filter((l) => /^scheduler owners: timeline/.test(l)).length, 0, "line only at the end of start()");
    t += 500;
    startD.resolve(undefined);
    assert.deepStrictEqual(events.splice(0), ["phase:after_owners"]);
    const timeline = lines.filter((l) => /^scheduler owners: timeline/.test(l));
    assert.strictEqual(timeline.length, 1, lines.join("|"));
    assert.ok(/^scheduler owners: timeline startMs=15500 calls=4 top: /.test(timeline[0]), timeline[0]);
    assert.ok(timeline[0].includes("schedule:A=3@1.0-3.0s rt0ms"), timeline[0]);
    assert.ok(timeline[0].includes("validateLease:B=1@3.0-3.0s rt12000ms"), timeline[0]);
    assert.ok(lines.some((l) => /^scheduler due gate: open \(owners_ready\)/.test(l)), lines.join("|"));
    client.call("ack", { jobID: "zzz:9", leaseToken: "x" });
    assert.ok(events.includes("crumb:call:ack:zzz"), events.join("|"));
    assert.strictEqual(lines.filter((l) => /^scheduler owners: timeline/.test(l)).length, 1);
  });

  test("hotpath18 SW5 vendor facts: world role before the first require(, child roles in 5 lines, compose has the keys", () => {
    const index = src("../index.js");
    const roleAt = index.indexOf("process.env.EVEJS_GAMESTORE_OWNER_ROLE = \"world\";");
    assert.ok(roleAt >= 0);
    const lfIndex = index.replace(/\r\n/g, "\n");
    const checkStart = lfIndex.indexOf("\ntry {\n  const { prepareSharedStore } = require(\"./src/gameStore/startupSharedStore\");");
    const checkEnd = lfIndex.indexOf("\n} catch (error) {\n  process.stderr.write(`[Startup] ${error.message}\\n`);\n  process.exit(1);\n}\n");
    assert.ok(checkStart >= 0 && checkEnd > checkStart, "startup save check block");
    assert.ok(checkStart < lfIndex.indexOf("require("), "the only earlier requires are in the startup save check");
    const lfRoleAt = lfIndex.indexOf("process.env.EVEJS_GAMESTORE_OWNER_ROLE = \"world\";");
    assert.ok(checkEnd < lfRoleAt, "role after the startup save check");
    assert.ok(lfRoleAt < lfIndex.indexOf("require(", checkEnd), "role before the first require( after the startup save check");
    const head = (rel) => src(rel).split(/\r?\n/).slice(0, 5).join("\n");
    assert.ok(head("services/scheduler/durableSchedulerProcess.worker.js")
      .includes("process.env.EVEJS_GAMESTORE_OWNER_ROLE = \"scheduler\";"));
    assert.ok(head("services/account/walletAuthorityProcess.worker.js")
      .includes("process.env.EVEJS_GAMESTORE_OWNER_ROLE = \"wallet\";"));
    const compose = fs.readFileSync(COMPOSE, "utf8");
    const keys = Object.keys(DEFAULTS).filter((k) => /^stallWatch/.test(k) || k === "schedulerOwnersSlowCallMs");
    assert.strictEqual(keys.length, 8);
    for (const key of keys) {
      const envName = ENV[key];
      const def = envName === "HOTPATH_STALL_WATCH" ? "1" : "";
      assert.ok(compose.includes(`      ${envName}: \${${envName}:-${def}}`), envName);
    }
  });
}

module.exports = { register };
