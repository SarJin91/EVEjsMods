"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const perfHooks = require("node:perf_hooks");

const config = require("../../config");
const { createHistogram } = require("../../lib/telemetry/histogram");
const { createRegistry } = require("../../lib/telemetry/registry");
const { startTelemetry } = require("../../lib/telemetry");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NAMES = ["tick.a", "tick.b", "gc.c", "persistence.d", "observer.e"];

module.exports = ({ test }) => {
  test("CS1 registry: reuse unchanged, at most summariesPerRead changed per read, oldest first, default 16", () => {
    const r = createRegistry({ histogramSamples: 16, maxMetrics: 32, summariesPerRead: 2 });
    for (const [i, name] of NAMES.entries()) r.observe(name, i + 1);
    const first = r.read();
    assert.deepStrictEqual(r.lastReadStats(), { summarized: 5, reused: 0, deferred: 0 }, "new histograms: always");
    for (const name of NAMES) assert.strictEqual(first.histograms[name].samples, 1);

    const second = r.read();
    assert.deepStrictEqual(r.lastReadStats(), { summarized: 0, reused: 5, deferred: 0 }, "nothing recorded");
    for (const name of NAMES) assert.strictEqual(second.histograms[name], first.histograms[name], "same summary object");

    for (const name of NAMES) r.observe(name, 100);
    const third = r.read();
    assert.deepStrictEqual(r.lastReadStats(), { summarized: 2, reused: 0, deferred: 3 });
    const fresh = NAMES.filter((n) => third.histograms[n].samples === 2);
    assert.strictEqual(fresh.length, 2);
    for (const n of NAMES.filter((x) => !fresh.includes(x))) {
      assert.strictEqual(third.histograms[n], first.histograms[n], `${n} deferred: previous summary`);
    }
    r.read();
    assert.deepStrictEqual(r.lastReadStats(), { summarized: 2, reused: 2, deferred: 1 });
    const fifth = r.read();
    assert.deepStrictEqual(r.lastReadStats(), { summarized: 1, reused: 4, deferred: 0 });
    for (const name of NAMES) assert.strictEqual(fifth.histograms[name].samples, 2, name);

    const h = createHistogram(16);
    for (let v = 0; v < 21; v += 1) h.record((v * 7) % 13, v * 10);
    assert.deepStrictEqual(h.summarize(new Float64Array(16)), h.summarize());
    const u = createRegistry({ histogramSamples: 16, maxMetrics: 32 });
    for (let v = 0; v < 21; v += 1) u.observe("tick.x", (v * 7) % 13, v * 10);
    assert.deepStrictEqual(u.read().histograms["tick.x"], h.summarize(), "no limit: the old summary");

    const resolved = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.strictEqual(resolved.config.telemetry.histogramSummariesPerPass, 16);
  });

  test("CS2 telemetry: capture.steps shows the bound; a slow capture logs one line with the steps", () => {
    class FakeObserver {
      observe() {}
      disconnect() {}
    }
    FakeObserver.supportedEntryTypes = ["gc"];
    let now = 0;
    const perf = { PerformanceObserver: FakeObserver, constants: perfHooks.constants,
      performance: { now: () => (now += 40) } };
    const lines = [];
    const cfg = { enabled: true, modules: { telemetry: { enabled: true } }, dataDir: null,
      telemetry: { intervalSeconds: 10, histogramSamples: 64, maxMetrics: 64, histogramSummariesPerPass: 2,
        slowOpMs: 10, slowOpLogPerMin: 10 } };
    const started = startTelemetry({ config: cfg, adapter: null, modDir: MOD_DIR,
      logger: { log: (m) => lines.push(m) }, perfHooks: perf, clock: { now: () => 1700000000000 },
      timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    assert.strictEqual(started.ok, true);
    const t = started.telemetry;
    for (const name of NAMES) t.observe(name, 1);
    let snap = t.capture();
    assert.strictEqual(snap.capture.steps.histogramsSummarized, 5);
    for (const name of NAMES) t.observe(name, 2);
    lines.length = 0;
    snap = t.capture();
    const s = snap.capture.steps;
    assert.strictEqual(s.histogramsSummarized, 2);
    assert.strictEqual(s.histogramsDeferred, 3);
    for (const k of ["governorMs", "registryReadMs", "moduleCostMs", "processMs", "buildMs"]) {
      assert.ok(typeof s[k] === "number" && s[k] >= 0, k);
    }
    const slow = lines.filter((l) => l.startsWith("telemetry: slow capture "));
    assert.strictEqual(slow.length, 1, lines.join("\n"));
    assert.match(slow[0], /governor=\d+ read=\d+ moduleCost=\d+ process=\d+ build=\d+ freeze=\d+ histograms=2\/0\/3$/);
    t.stop();
  });
};
