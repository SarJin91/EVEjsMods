"use strict";

const assert = require("node:assert");
const { createTickDriver } = require("../../lib/core/tickDriver");
const { formatTelemetry } = require("../../lib/core/telemetry");

function fakeTimers() {
  const t = { handles: [], cleared: [] };
  t.setInterval = (fn, ms) => {
    const handle = { fn, ms, unrefs: 0, unref() {
      this.unrefs += 1;
      return this;
    } };
    t.handles.push(handle);
    return handle;
  };
  t.clearInterval = (handle) => t.cleared.push(handle);
  return t;
}

module.exports = ({ test }) => {
  test("TD1 start: two unref'd timers; tick -> wing.tick(now), throws counted; stop clears both, "
    + "final telemetry once; telemetry line = non-zero counters", () => {
    const timers = fakeTimers();
    const ticks = [];
    const telemetry = [];
    let fail = false;
    const wing = { tick: (nowMs) => {
      if (fail) throw new Error("bug");
      ticks.push(nowMs);
    } };
    const driver = createTickDriver({ wing, tickIntervalMs: 500, telemetryIntervalMs: 600000, timers,
      now: () => 1234, onTelemetry: (final) => telemetry.push(final) });
    assert.deepStrictEqual(driver.start(), { ok: true, reason: null });
    assert.deepStrictEqual(driver.start(), { ok: false, reason: "already_started" });
    assert.deepStrictEqual(timers.handles.map((h) => [h.ms, h.unrefs]), [[500, 1], [600000, 1]]);
    assert.strictEqual(driver.isRunning(), true);
    timers.handles[0].fn();
    fail = true;
    timers.handles[0].fn();
    timers.handles[1].fn();
    assert.deepStrictEqual(ticks, [1234]);
    assert.deepStrictEqual(driver.stats(), { ticks: 2, errors: 1 });
    assert.deepStrictEqual(telemetry, [false]);
    assert.strictEqual(driver.stop(), true);
    assert.deepStrictEqual(timers.cleared, timers.handles);
    assert.deepStrictEqual(telemetry, [false, true]);
    assert.strictEqual(driver.stop(), false, "idempotent");
    assert.deepStrictEqual(driver.start(), { ok: false, reason: "stopped" });
    assert.strictEqual(driver.isRunning(), false);

    const line = formatTelemetry({
      wing: { records: 1, live: 1, storeReadOnly: false, counters: { "orderCopy.ok.launch": 2, lost: 0,
        "tick.maxMs": 0.123 } },
      guards: { "guard.error": 1, "guard.refused.Handle_Board": 3 },
      store: { counters: { "store.write.ok": 4 } },
      driver: { ticks: 9, errors: 0 },
    });
    assert.strictEqual(line, "telemetry records=1 live=1 guard.error=1 guard.refused.Handle_Board=3 "
      + "orderCopy.ok.launch=2 store.write.ok=4 tick.maxMs=0.12");
  });
};
