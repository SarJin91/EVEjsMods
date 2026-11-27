"use strict";

const assert = require("node:assert");
const path = require("node:path");
const util = require("node:util");

const { resolveConfig } = require("../../config");
const { createSpikeAttribution } = require("../../lib/telemetry/spikeAttribution");
const { createStallDiag } = require("../../lib/telemetry/stallDiag");
const { installTimerTags } = require("../../lib/telemetry/timerTags");
const { createCpuProfile } = require("../../lib/telemetry/cpuProfile");
const { startTelemetry } = require("../../lib/telemetry");
const loader = require("../../loader");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
const WALL_AT_PERF_ZERO = 1700000000000;
const SPIKE_LINE = "telemetry: spike 600ms at=2023-11-14T22:13:30.000Z source=unattributed tickWork=3 gc=0/0 lne=0 "
  + "rest=500 ops=-";

function spikeOf(over = {}) {
  const lines = [];
  let perf = 0;
  const a = createSpikeAttribution({ thresholdMs: 500, ringSize: 16, maxPending: 4, maxOpsPerLine: 6,
    perfNow: () => perf, wallNow: () => WALL_AT_PERF_ZERO + perf, log: (l) => lines.push(l), count() {}, ...over });
  a.onTick({ intervalMs: 100, workMs: 3, latenessMs: 0, atMs: 9400 });
  a.onTick({ intervalMs: 600, workMs: 2, latenessMs: 500, atMs: 10000 });
  return { a, lines, settle: () => {
    perf = 10005;
    a.resolve(10005);
    perf = 20005;
    a.resolve(20005);
  } };
}

function fakeGlobals() {
  const calls = [];
  const make = (name) => function vendorTimer(cb, ...args) {
    const handle = { name, cb, args, unref() { return this; } };
    calls.push(handle);
    return handle;
  };
  const g = { setTimeout: make("timeout"), setInterval: make("interval"), setImmediate: make("immediate") };
  g.setTimeout[util.promisify.custom] = "promisified";
  return { g, calls, originals: { ...g } };
}

module.exports = ({ test }) => {
  test("SD-S1 stall diag off bit for bit: spike line literal, no core, no wrap of the timers", () => {
    const plain = spikeOf();
    plain.settle();
    assert.deepStrictEqual(plain.lines, [SPIKE_LINE]);
    const throwing = spikeOf({ extraSuffix: () => { throw new Error("x"); } });
    throwing.settle();
    assert.deepStrictEqual(throwing.lines, [SPIKE_LINE], "a throwing suffix leaves the line as it is");
    const suffixed = spikeOf({ extraSuffix: () => " diag=-" });
    suffixed.settle();
    assert.deepStrictEqual(suffixed.lines, [`${SPIKE_LINE} diag=-`]);

    const config = resolveConfig({ modDir: MOD_DIR }).config;
    assert.strictEqual(config.telemetry.stallDiag.enabled, false, "default off");
    assert.strictEqual(config.telemetry.stallDiag.profile.enabled, false, "profile default off");
    const before = globalThis.setTimeout;
    const t = startTelemetry({ config: { ...config, dataDir: null }, adapter: null, modDir: MOD_DIR,
      logger: { log() {} }, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    assert.ok(t.ok);
    assert.ok(!("stallDiag" in t.telemetry.getStatus()), "no stallDiag status with the flag off");
    t.telemetry.noteForeign("x", 0, 999);
    t.telemetry.stop();
    assert.strictEqual(globalThis.setTimeout, before);

    const boot = (env) => {
      const fake = fakeGlobals();
      const moduleApi = { _cache: {}, _load: () => ({}), _resolveFilename: (r) => r };
      const out = loader.install({ moduleApi, globalObj: fake.g, env: { EVEJS_GAMESTORE_OWNER_ROLE: "world" },
        isMainThread: true, logger: { log() {}, debug() {}, logError() {} },
        loadConfig: () => resolveConfig({ modDir: MOD_DIR, env }) });
      assert.ok(out.ok);
      moduleApi._load("path", { filename: "/x/server/index.js" });
      return fake;
    };
    const off = boot({});
    assert.ok(["setTimeout", "setInterval", "setImmediate"].every((n) => off.g[n] === off.originals[n]));
    const on = boot({ EVEJS_LNE_TELEMETRY_STALL_DIAG_ENABLED: "1" });
    assert.ok(on.g.setTimeout !== on.originals.setTimeout, "flag on wraps the timers");
  });

  test("SD-S2 suffix: foreign span in the gap, union with the mod's operations, source stays unattributed", () => {
    const core = createStallDiag({ ringSize: 16, maxLabels: 8, maxOpsPerLine: 6, slowCallbackMs: 50 });
    assert.strictEqual(core.suffixForGap(9000, 10000, { restMs: 977, source: "unattributed" }), "",
      "nothing recorded yet -> no suffix");
    core.noteForeign("server/src/x.js:1", 9100, 600);
    core.noteForeign("fast", 9100, 10);
    assert.strictEqual(core.suffixForGap(9000, 10000, { lneSpans: [], gcSpans: [[9800, 9820]], tickSpan: [9000, 9003],
      restMs: 977, source: "unattributed" }), " diag=server/src/x.js:1/600 untimed=377");
    assert.strictEqual(core.suffixForGap(9000, 10000, { lneSpans: [[9200, 9400]], gcSpans: [], tickSpan: [9000, 9003],
      restMs: 777, source: "unattributed" }), " diag=server/src/x.js:1/600 untimed=377");
    core.noteJob("ess.settlement", 9500, 3);
    assert.match(core.suffixForGap(9000, 10000, { restMs: 977, source: "unattributed" }), / jobs=ess\.settlement:1 /);

    const diag = createStallDiag({ ringSize: 16, maxLabels: 8, maxOpsPerLine: 6, slowCallbackMs: 50 });
    diag.noteForeign("server/src/x.js:1", 9500, 400);
    const h = spikeOf({ extraSuffix: (gs, ge, parts) => diag.suffixForGap(gs, ge, parts) });
    h.settle();
    assert.deepStrictEqual(h.lines, [`${SPIKE_LINE} diag=server/src/x.js:1/400 untimed=100`]);
    assert.deepStrictEqual(h.a.getStatus().bySource.unattributed, 1);
    assert.match(diag.summaryLine({ p50: 20, p99: 40, max: 600 }, { captures: 3, skipped: 1, captureMs: 0.4 }),
      /^telemetry: stall-diag window=5m state=on top=server\/src\/x\.js:1\/400\/1\/max400 jobs=- killmail=0\/0\/max0 loop=p50:20,p99:40,max:600 spikes=1 rest=500 untimed=100 cost=captures:3\/skipped:1\/0$/);
  });

  test("SD-S3 timer tags on fake globals: pass-through, same handle, promisify.custom, labels, budget, chained", () => {
    const fake = fakeGlobals();
    let now = 1000;
    const notes = [];
    const t = installTimerTags({ globalObj: fake.g, timersModule: null, now: () => now,
      sink: { noteForeign: (label, startMs, ms) => notes.push({ label, startMs, ms }) },
      slowCallbackMs: 50, stackDepth: 8, captureMaxPerSec: 1, maxMinutes: 0,
      excludeDirs: [path.join(MOD_DIR, "lib", "telemetry")], rootDir: REPO_ROOT });
    assert.ok(t.ok);
    assert.strictEqual(installTimerTags({ globalObj: fake.g, now: () => now }).reason, "already_installed");
    assert.strictEqual(fake.g.setTimeout[util.promisify.custom], "promisified");
    const self = { me: true };
    const err = new Error("boom");
    const slowCb = function slowOne(a, b) {
      now += 60;
      return [this, a, b];
    };
    const handle = fake.g.setTimeout(slowCb, 5, "x");
    assert.strictEqual(handle, fake.calls[0], "the vendor's own handle");
    assert.deepStrictEqual(handle.args, [5, "x"]);
    assert.deepStrictEqual(handle.cb.call(self, 1, 2), [self, 1, 2]);
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].label.startsWith("mods/livingNewEden/test/telemetry/stallDiag.test.js:"), notes[0].label);
    assert.deepStrictEqual([notes[0].startMs, notes[0].ms], [1000, 60]);
    fake.g.setInterval(function namedLater() {
      now += 70;
      throw err;
    }, 1);
    assert.throws(() => fake.calls[1].cb(), (e) => e === err);
    assert.strictEqual(notes[1].label, "fn:namedLater");
    fake.g.setImmediate(() => 1);
    assert.strictEqual(fake.calls[2].cb(), 1);
    assert.strictEqual(notes.length, 2, "a fast callback is not noted");
    fake.g.setTimeout("not a function", 1);
    assert.strictEqual(fake.calls[3].cb, "not a function", "a non-function goes to the original unchanged");
    assert.strictEqual(t.getStatus().skipped, 2);

    fake.g.setTimeout = function someoneElse() {};
    assert.deepStrictEqual(t.uninstall(), { ok: false, reason: "chained" });
    assert.strictEqual(fake.g.setInterval, fake.originals.setInterval);
    const clean = fakeGlobals();
    const t2 = installTimerTags({ globalObj: clean.g, now: () => 0 });
    assert.deepStrictEqual(t2.uninstall(), { ok: true });
    assert.strictEqual(clean.g.setTimeout, clean.originals.setTimeout);
  });

  test("SD-S5 CPU profile on a fake Session: trigger after bootGrace, maxPerBoot, top-N, inspector error", async () => {
    const fired = [];
    const core = createStallDiag({ ringSize: 16, maxLabels: 8, maxOpsPerLine: 6, slowCallbackMs: 50,
      profileTrigger: { restMs: 300, bootGraceEndsAtMs: () => 5000, fire: (r) => fired.push(r) } });
    core.suffixForGap(4000, 4900, { restMs: 400, source: "unattributed" });
    core.suffixForGap(6000, 6900, { restMs: 200, source: "unattributed" });
    core.suffixForGap(6000, 6900, { restMs: 400, source: "gc" });
    assert.deepStrictEqual(fired, []);
    core.suffixForGap(6000, 6900, { restMs: 400, source: "unattributed" });
    assert.deepStrictEqual(fired, ["rest=400"]);

    const profile = { startTime: 0, endTime: 8000, samples: [2, 2, 3, 4], timeDeltas: [1000, 2000, 2000, 3000],
      nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 } },
        { id: 2, callFrame: { functionName: "getAllKillmailRecords",
          url: "/app/server/src/services/killmail/killmailState.js", lineNumber: 435 } },
        { id: 3, callFrame: { functionName: "(garbage collector)", url: "", lineNumber: -1 } },
        { id: 4, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 } }] };
    const run = (failOn) => {
      let perf = 100;
      const lines = [];
      const posts = [];
      const timers = [];
      const writes = [];
      const sessions = [];
      class FakeSession {
        constructor() { sessions.push(this); this.closed = false; }
        connect() {}
        disconnect() { this.closed = true; }
        post(method, _params, cb) {
          posts.push(method);
          if (method === failOn) return cb(new Error("boom"));
          if (method === "Profiler.stop") {
            perf += 8;
            return cb(null, { profile });
          }
          return cb(null, {});
        }
      }
      const p = createCpuProfile({ inspector: { Session: FakeSession }, dir: path.join("/data", "diag"),
        fs: { promises: { mkdir: async () => {}, writeFile: async (f) => { writes.push(f); } } },
        now: () => perf, wallNow: () => WALL_AT_PERF_ZERO, durationSec: 120, samplingIntervalUs: 1000, topN: 5,
        maxPerBoot: 1, log: (l) => lines.push(l), noteOp() {}, rootDir: "/app", gaps: () => [[100, 103]],
        setTimer: (fn, ms) => {
          timers.push({ fn, ms });
          return { cancel() {} };
        } });
      return { p, lines, posts, timers, writes, sessions };
    };
    const ok = run(null);
    assert.deepStrictEqual(ok.p.trigger("rest=400"), { ok: true });
    assert.deepStrictEqual(ok.posts, ["Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start"]);
    assert.ok(ok.lines[0].startsWith("stall-diag: profile started at=2023-11-14T22:13:20.000Z"), ok.lines[0]);
    assert.deepStrictEqual(ok.p.trigger("again"), { ok: false, reason: "busy" });
    assert.strictEqual(ok.timers[0].ms, 120000);
    ok.timers[0].fn();
    assert.strictEqual(ok.lines[1], "stall-diag: profile top=getAllKillmailRecords@server/src/services/killmail/"
      + "killmailState.js:436/3 gc=2 program=0 idle=3 samples=4 aligned=yes drift=0 gaps=1 "
      + "gapTop=getAllKillmailRecords@server/src/services/killmail/killmailState.js:436/3");
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ok.writes.length, 1);
    assert.ok(ok.writes[0].startsWith(path.join("/data", "diag", "stall-")) && ok.writes[0].endsWith(".cpuprofile"));
    assert.strictEqual(ok.p.getStatus().state, "done");
    assert.deepStrictEqual(ok.p.trigger("third"), { ok: false, reason: "exhausted" });

    const bad = run("Profiler.start");
    assert.deepStrictEqual(bad.p.trigger("rest=400"), { ok: false, reason: "inspector_failed" });
    assert.ok(bad.lines.some((l) => l.includes("failed step=Profiler.start error=boom")), bad.lines.join("\n"));
    assert.strictEqual(bad.sessions[0].closed, true);
    assert.strictEqual(bad.p.getStatus().state, "failed");
  });
};
