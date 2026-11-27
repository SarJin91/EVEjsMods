"use strict";

const assert = require("node:assert");
const path = require("node:path");
const perfHooks = require("node:perf_hooks");

const { startTelemetry } = require("../../lib/telemetry");
const { createHeapDetail } = require("../../lib/telemetry/heapDetail");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW_MS = 1700000000000;
const MB = 1024 * 1024;
const { NODE_PERFORMANCE_GC_MAJOR, NODE_PERFORMANCE_GC_MINOR } = perfHooks.constants;

function makeConfig(telemetry) {
  return { enabled: true, modules: { telemetry: { enabled: true } },
    telemetry: { intervalSeconds: 10, histogramSamples: 64, maxMetrics: 64, slowOpLogPerMin: 10,
      heapDetail: true, heapAfterMajorRing: 16, majorGcLogMs: 500, ...telemetry },
    dataDir: "" };
}

function fakeTimers() {
  return { setInterval: () => ({ unref() { return this; } }), clearInterval() {} };
}

function fakePerf() {
  const created = [];
  class FakeObserver {
    constructor(cb) { this.cb = cb; created.push(this); }
    observe() {}
    disconnect() {}
  }
  FakeObserver.supportedEntryTypes = ["gc"];
  const pause = (ms, kind) => created[0].cb({ getEntries: () => [{ duration: ms, startTime: 1, detail: { kind } }] });
  return { pause, perfHooks: { PerformanceObserver: FakeObserver, constants: perfHooks.constants,
    performance: perfHooks.performance } };
}

function fakeV8() {
  const calls = { stats: 0, spaces: 0 };
  let used = 100 * MB;
  return {
    calls,
    bump() { used += MB; },
    getHeapStatistics() {
      calls.stats += 1;
      return { heap_size_limit: 8192 * MB, total_heap_size: 300 * MB, used_heap_size: used,
        total_available_size: 7000 * MB, malloced_memory: 1 * MB, external_memory: 2 * MB,
        number_of_native_contexts: 1, number_of_detached_contexts: 0 };
    },
    getHeapSpaceStatistics() {
      calls.spaces += 1;
      return [{ space_name: "old_space", space_used_size: 80 * MB, space_size: 90 * MB, space_available_size: 5 * MB },
        { space_name: "new_space", space_used_size: 4 * MB, space_size: 16 * MB, space_available_size: 8 * MB }];
    },
  };
}

function start(telemetry, v8Api, lines = []) {
  const perf = fakePerf();
  const started = startTelemetry({ config: makeConfig(telemetry), adapter: null, modDir: MOD_DIR,
    logger: { log: (m) => lines.push(m) }, timers: fakeTimers(), perfHooks: perf.perfHooks, v8Api,
    clock: { now: () => NOW_MS } });
  assert.strictEqual(started.ok, true);
  return { t: started.telemetry, pause: perf.pause, lines };
}

module.exports = ({ test }) => {
  test("HD1 process.heap: afterMajor count/ring from major pauses only, ring bounded, spaces; heapDetail=false -> "
    + "null and no v8 call", () => {
    const v8 = fakeV8();
    const { t, pause } = start({ majorGcLogMs: 0 }, v8);
    for (let i = 0; i < 3; i += 1) {
      v8.bump();
      pause(10 + i, NODE_PERFORMANCE_GC_MAJOR);
    }
    pause(5, NODE_PERFORMANCE_GC_MINOR);
    const heap = t.capture().process.heap;
    assert.strictEqual(heap.afterMajor.count, 3);
    assert.strictEqual(heap.afterMajor.ring.length, 3);
    assert.strictEqual(heap.afterMajor.lastUsedBytes, 103 * MB);
    assert.strictEqual(heap.afterMajor.minUsedBytes, 101 * MB);
    assert.strictEqual(heap.afterMajor.maxUsedBytes, 103 * MB);
    assert.strictEqual(heap.afterMajor.lastPauseMs, 12);
    assert.strictEqual(heap.afterMajor.lastAtMs, NOW_MS);
    assert.deepStrictEqual(heap.afterMajor.ring[0], [NOW_MS, 101 * MB, 10, null]);
    assert.strictEqual(heap.spaces.old_space.usedBytes, 80 * MB);
    assert.strictEqual(heap.limitBytes, 8192 * MB);
    assert.strictEqual(heap.detachedContexts, 0);
    t.stop();

    const v8b = fakeV8();
    const b = start({ majorGcLogMs: 0 }, v8b);
    for (let i = 0; i < 20; i += 1) {
      v8b.bump();
      b.pause(i + 1, NODE_PERFORMANCE_GC_MAJOR);
    }
    const ring = b.t.capture().process.heap.afterMajor.ring;
    assert.strictEqual(ring.length, 16);
    assert.deepStrictEqual(ring.map((e) => e[2]), Array.from({ length: 16 }, (_v, i) => i + 5),
      "oldest first, the first 4 dropped");
    b.t.stop();

    const v8c = fakeV8();
    const c = start({ heapDetail: false }, v8c);
    c.pause(10, NODE_PERFORMANCE_GC_MAJOR);
    assert.strictEqual(c.t.capture().process.heap, null);
    assert.deepStrictEqual(v8c.calls, { stats: 0, spaces: 0 });
    c.t.stop();

    const broken = { getHeapStatistics() { throw new Error("x"); },
      getHeapSpaceStatistics() { throw new Error("y"); } };
    const d = start({ majorGcLogMs: 0 }, broken);
    d.pause(10, NODE_PERFORMANCE_GC_MAJOR);
    const snap = d.t.capture();
    assert.strictEqual(snap.process.heap.usedBytes, null);
    assert.strictEqual(snap.process.heap.afterMajor.count, 1);
    assert.strictEqual(snap.process.heap.afterMajor.ring.length, 0);
    assert.ok(snap.telemetry.callbackErrors >= 1);
    d.t.stop();
  });

  test("HD-chars ring 4th field = players online: gauge value, throw -> null + onError, absent -> "
    + "3 fields", () => {
    const v8 = fakeV8();
    const { t, pause } = start({ majorGcLogMs: 0 }, v8);
    t.gauge("presence.characters", 2);
    pause(10, NODE_PERFORMANCE_GC_MAJOR);
    t.gauge("presence.characters", 0);
    pause(11, NODE_PERFORMANCE_GC_MAJOR);
    assert.deepStrictEqual(t.capture().process.heap.afterMajor.ring.map((e) => e[3]), [2, 0]);
    t.stop();

    let errors = 0;
    let value = () => { throw new Error("boom"); };
    const hd = createHeapDetail({ v8Api: fakeV8(), ringSize: 4, clock: { now: () => NOW_MS },
      onError: () => { errors += 1; }, charactersNow: () => value() });
    assert.doesNotThrow(() => hd.noteMajor(5));
    value = () => -1;
    hd.noteMajor(6);
    value = () => 3;
    hd.noteMajor(7);
    assert.deepStrictEqual(hd.read().afterMajor.ring, [[NOW_MS, 100 * MB, 5, null], [NOW_MS, 100 * MB, 6, null],
      [NOW_MS, 100 * MB, 7, 3]]);
    assert.strictEqual(errors, 1);

    const plain = createHeapDetail({ v8Api: fakeV8(), ringSize: 4, clock: { now: () => NOW_MS } });
    plain.noteMajor(5);
    assert.deepStrictEqual(plain.read().afterMajor.ring, [[NOW_MS, 100 * MB, 5]]);
  });

  test("HD2 'telemetry: major GC' line: major >= majorGcLogMs only, minor never, 0 = off", () => {
    const marker = "telemetry: major GC 600ms usedAfter=";
    const a = start({ majorGcLogMs: 500 }, fakeV8());
    a.pause(600, NODE_PERFORMANCE_GC_MAJOR);
    assert.deepStrictEqual(a.lines.filter((l) => l.startsWith("telemetry: major GC")),
      [`${marker}100MB limit=8192MB`]);
    a.pause(400, NODE_PERFORMANCE_GC_MAJOR);
    a.pause(900, NODE_PERFORMANCE_GC_MINOR);
    assert.strictEqual(a.lines.filter((l) => l.startsWith("telemetry: major GC")).length, 1);
    a.t.stop();

    const off = start({ majorGcLogMs: 0 }, fakeV8());
    off.pause(600, NODE_PERFORMANCE_GC_MAJOR);
    assert.strictEqual(off.lines.filter((l) => l.startsWith("telemetry: major GC")).length, 0);
    off.t.stop();
  });
};
