"use strict";

const assert = require("node:assert");
const path = require("node:path");
const perfHooks = require("node:perf_hooks");

const { createWalAttribution } = require("../../lib/telemetry/walAttribution");
const { isMetricName } = require("../../lib/telemetry/registry");
const { startTelemetry } = require("../../lib/telemetry");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW_MS = 1700000000000;

function telemetryWith(walPerTx) {
  const config = { enabled: true, modules: { telemetry: { enabled: true } },
    telemetry: { intervalSeconds: 10, histogramSamples: 64, maxMetrics: 4096 }, dataDir: null,
    ...(walPerTx === undefined ? {} : { persistence: { walPerTx } }) };
  class FakeObserver {
    observe() {}
    disconnect() {}
  }
  FakeObserver.supportedEntryTypes = ["gc"];
  const timers = { setInterval: () => ({ unref() { return this; } }), clearInterval() {} };
  const started = startTelemetry({ config, adapter: null, modDir: MOD_DIR, logger: { log() {} }, timers,
    perfHooks: { PerformanceObserver: FakeObserver, constants: perfHooks.constants, performance: perfHooks.performance },
    clock: { now: () => NOW_MS } });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  return started.telemetry;
}

module.exports = ({ test }) => {
  test("WM4 WAL attribution: keys, scheduler label, other / overflow, detail names, hook + snapshot block", () => {
    const a = createWalAttribution({ maxKeys: 3, detailModule: "freeCorps", maxDetailNames: 2 });
    assert.strictEqual(a.keyOf("freeCorps.pass", null), "freeCorps");
    assert.strictEqual(a.keyOf("scheduler.complete", "FLEET_ARRIVAL"), "scheduler_FLEET_ARRIVAL");
    assert.strictEqual(a.keyOf("9bad.pass", null), "other");
    assert.strictEqual(a.keyOf("bad-name.x", "FLEET_ARRIVAL"), "other");
    assert.strictEqual(a.keyOf("open", null), "open", "a name without a dot is its own key");

    const map = (pairs) => Object.fromEntries(pairs);
    assert.deepStrictEqual(map(a.note("freeCorps.pass", 7, { frames: 4, label: null })), {
      "persistence.walTx.freeCorps": 1, "persistence.walPerTx.txTotal": 1, "persistence.walRows.freeCorps": 7,
      "persistence.walPerTx.rowsTotal": 7, "persistence.walFrames.freeCorps": 4, "persistence.walPerTx.framesTotal": 4,
      "persistence.walFramesByName.freeCorps.pass": 4 });
    assert.deepStrictEqual(map(a.note("scheduler.complete", 2, { frames: null, label: "FLEET_ARRIVAL" })), {
      "persistence.walTx.scheduler_FLEET_ARRIVAL": 1, "persistence.walPerTx.txTotal": 1,
      "persistence.walRows.scheduler_FLEET_ARRIVAL": 2, "persistence.walPerTx.rowsTotal": 2,
      "persistence.walPerTx.framesUnknown": 1 });
    a.note("trade.buy", 1, { frames: 1, label: null });
    const over = map(a.note("observer.read", 0, { frames: 0, label: null }));
    assert.strictEqual(over["persistence.walPerTx.overflow"], 1);
    assert.strictEqual(over["persistence.walTx.other"], 1);
    assert.strictEqual(map(a.note("trade.sell", 1, { frames: 2, label: null }))["persistence.walFrames.trade"], 2);
    a.note("freeCorps.news", 1, { frames: 1, label: null });
    assert.strictEqual(map(a.note("freeCorps.chatter", 1, { frames: 1, label: null }))[
      "persistence.walFramesByName.freeCorps.chatter"], undefined, "limit 2");
    assert.strictEqual(map(a.note("freeCorps.pass", 1, { frames: 3, label: null }))[
      "persistence.walFramesByName.freeCorps.pass"], 3);
    const none = createWalAttribution({ maxKeys: 8, detailModule: "", maxDetailNames: 32 });
    assert.strictEqual(none.note("freeCorps.pass", 1, { frames: 1, label: null })
      .some(([n]) => n.startsWith("persistence.walFramesByName.")), false, "empty detailModule = no detail");
    const names = new Set();
    const b = createWalAttribution({ maxKeys: 128, detailModule: "freeCorps", maxDetailNames: 32 });
    for (const [n, l] of [["freeCorps.contracts.claim", null], ["scheduler.complete", "STRATEGY_INTENT"],
      ["9x.y", null], ["virtualCorps.updateState", null], ["freeCorps.pass", null]]) {
      for (const [name] of b.note(n, 1, { frames: 1, label: l })) names.add(name);
      for (const [name] of b.note(n, 1, { frames: null, label: l })) names.add(name);
    }
    for (const name of a.note("x.y", 1, { frames: 1, label: null })) names.add(name[0]);
    const bad = [...names].filter((n) => !isMetricName(n));
    assert.deepStrictEqual(bad, [], "every counter name passes isMetricName");

    const on = telemetryWith({ enabled: true, maxKeys: 128, detailModule: "freeCorps", maxDetailNames: 32 });
    try {
      on.hooks.onTiming("freeCorps.pass", 1, "ok", 5, undefined, undefined, { frames: 3, label: null });
      on.hooks.onTiming("scheduler.complete", 1, "TX_ABORTED", 2, undefined, undefined,
        { frames: 1, label: "FLEET_ARRIVAL" });
      on.hooks.onTiming("trade.buy", 1, "ok", 1, undefined, undefined, { frames: null, label: null });
      on.hooks.onTiming("trade.buy", 1, "ok", 1);
      const w = on.capture().persistence.walPerTx;
      assert.deepStrictEqual(w, { calibrated: false, frameBytes: null, overflow: 0, framesUnknown: 1,
        total: { frames: 4, rows: 8, tx: 3 },
        keys: { freeCorps: { frames: 3, rows: 5, tx: 1 }, scheduler_FLEET_ARRIVAL: { frames: 1, rows: 2, tx: 1 },
          trade: { frames: 0, rows: 1, tx: 1 } },
        names: { "freeCorps.pass": 3 } });
    } finally {
      on.stop();
    }
    for (const walPerTx of [undefined, { enabled: false, maxKeys: 128, detailModule: "freeCorps", maxDetailNames: 32 }]) {
      const off = telemetryWith(walPerTx);
      try {
        off.hooks.onTiming("freeCorps.pass", 1, "ok", 5, undefined, undefined, { frames: 3, label: null });
        assert.strictEqual(off.capture().persistence.walPerTx, null, "flag off -> null");
      } finally {
        off.stop();
      }
    }
  });
};
