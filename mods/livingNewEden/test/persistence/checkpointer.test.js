"use strict";

const assert = require("node:assert");

const { createCheckpointer, decideCheckpoint } = require("../../lib/persistence/checkpointer");

const S = Object.freeze({ checkpointForceFrames: 4000, checkpointTargetFrames: 600, checkpointMaxIntervalMs: 30000,
  checkpointPollMs: 1000, checkpointAlignToTick: true, checkpointAlignWaitMs: 250 });

function fakeStore() {
  const wal = { managed: true, rowsSinceCheckpoint: 0, estimatedFrames: 0, framesPerRow: 3,
    lastCheckpointAtMs: null, lastLogFrames: null };
  const calls = [];
  return { wal, calls,
    getState: () => "open",
    getWalStatus: () => ({ ...wal }),
    checkpoint() {
      calls.push(wal.estimatedFrames);
      const logFrames = wal.estimatedFrames;
      wal.rowsSinceCheckpoint = 0;
      wal.estimatedFrames = 0;
      return { ok: true, ms: 1, logFrames, checkpointedFrames: logFrames, busy: 0 };
    } };
}

function harness(extra = {}) {
  const store = fakeStore();
  const timers = [];
  const immediates = [];
  const listeners = [];
  let now = 0;
  const cp = createCheckpointer({ store, settings: { ...S, ...(extra.settings || {}) }, nowMs: () => now,
    getGovernor: extra.getGovernor || (() => null),
    addTickListener: extra.noTick ? undefined : (fn) => {
      listeners.push(fn);
      return { ok: true, remove: () => listeners.splice(listeners.indexOf(fn), 1) };
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false, cancel() { this.cancelled = true; } };
      timers.push(t);
      return t;
    },
    setImmediateFn: (fn) => immediates.push(fn) });
  const live = () => timers.filter((t) => !t.cancelled && !t.fired);
  const fireTimer = () => {
    const pending = live();
    assert.strictEqual(pending.length, 1, "exactly one timer armed");
    pending[0].fired = true;
    pending[0].fn();
    return pending[0].ms;
  };
  const tick = () => listeners.forEach((fn) => fn({ intervalMs: 100 }));
  const flush = () => immediates.splice(0).forEach((fn) => fn());
  return { store, cp, timers, live, fireTimer, tick, flush, listeners, advance: (ms) => { now += ms; },
    now: () => now };
}

module.exports = ({ test }) => {
  test("T2 checkpointer: decision table, tick alignment, timer fallback, stop disarms", () => {
    const wal = (frames, rows, last) => ({ estimatedFrames: frames, rowsSinceCheckpoint: rows,
      lastCheckpointAtMs: last });
    const gov = (mode, maintenanceAdmitted) => ({ mode, maintenanceAdmitted });
    assert.strictEqual(decideCheckpoint(wal(4000, 10, 0), gov("SHED", false), 1, S), "force");
    assert.strictEqual(decideCheckpoint(wal(3999, 10, 0), gov("SHED", false), 1, S), null);
    assert.strictEqual(decideCheckpoint(wal(3999, 10, 0), gov("OVERLOADED", false), 40000, S), null);
    assert.strictEqual(decideCheckpoint(wal(600, 10, 0), gov("NORMAL", true), 1, S), "target");
    assert.strictEqual(decideCheckpoint(wal(600, 10, 0), null, 1, S), "target");
    assert.strictEqual(decideCheckpoint(wal(600, 10, 0), gov("CONSTRAINED", false), 1, S), null);
    assert.strictEqual(decideCheckpoint(wal(10, 3, 0), gov("CONSTRAINED", false), 30000, S), "interval");
    assert.strictEqual(decideCheckpoint(wal(0, 0, 0), gov("NORMAL", true), 30000, S), null, "no rows, no interval");
    assert.strictEqual(decideCheckpoint(wal(599, 3, 0), gov("NORMAL", true), 29999, S), null);

    const h = harness();
    assert.deepStrictEqual(h.cp.start(), { ok: true });
    h.store.wal.estimatedFrames = 700;
    h.store.wal.rowsSinceCheckpoint = 200;
    assert.strictEqual(h.fireTimer(), S.checkpointPollMs);
    assert.deepStrictEqual([h.cp.getStatus().state, h.cp.getStatus().armed, h.store.calls.length],
      ["armed", "target", 0]);
    h.tick();
    h.tick();
    assert.strictEqual(h.store.calls.length, 0, "not on the tick itself");
    h.flush();
    assert.deepStrictEqual(h.store.calls, [700], "exactly one checkpoint after the tick");
    assert.deepStrictEqual([h.cp.getStatus().state, h.cp.getStatus().counts.target], ["running", 1]);
    assert.strictEqual(h.live().length, 1, "re-armed timer");

    h.store.wal.estimatedFrames = 650;
    h.store.wal.rowsSinceCheckpoint = 1;
    h.fireTimer();
    assert.strictEqual(h.cp.getStatus().state, "armed");
    assert.strictEqual(h.fireTimer(), S.checkpointAlignWaitMs);
    assert.deepStrictEqual(h.store.calls, [700, 650]);

    h.store.wal.estimatedFrames = 900;
    h.fireTimer();
    assert.strictEqual(h.cp.getStatus().state, "armed");
    h.tick();
    h.cp.stop();
    h.flush();
    h.tick();
    assert.deepStrictEqual([h.store.calls.length, h.live().length, h.listeners.length, h.cp.getStatus().state],
      [2, 0, 0, "stopped"]);
  });
};
