"use strict";

const assert = require("node:assert");

const { startSovProjection, stopSovProjection } = require("../../lib/world/sovProjection");

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function boot(waitMs, seed) {
  const timers = [];
  const observed = [];
  let listCalls = 0;
  const game = (relPath) => {
    if (relPath === "services/sovereignty/sovSystemRules") {
      return { ok: true, exports: { isSovereigntyClaimableSolarSystem: async () => true } };
    }
    if (relPath === "services/sovereignty/sovState") return { ok: true, exports: { getSystemSovClaim: async () => null } };
    if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: {} };
    return { ok: false, reason: "not_needed" };
  };
  const ctx = {
    config: { enabled: true, modules: { sovProjection: { enabled: true } },
      world: { sovProjection: { invaderFactionIds: "500021", syncBatchSize: 500, syncSliceMs: 4,
        syncSeedWaitMs: waitMs, syncSeedPollMs: 1000, verifyAfterDrain: false } } },
    persistence: { ok: true, store: { transaction: () => ({ ok: true, value: null }) }, journal: {} },
    adapter: { getProcessRole: () => "world", requireGame: game, isVirtualAlliance: () => false,
      getSovProjection: () => ({ projectSovCall: async () => ({ ok: true }), readSovState: async () => ({ ok: true }),
        requireGame: game }) },
    virtualCorps: { whenReady: () => Promise.resolve(), getFactionIdentity: async () => ({ ok: false }) },
    occupation: { registerOnControllerChanged: () => null },
    world: { seed, listSystems: () => {
      listCalls += 1;
      return { systems: [], nextAfterSystemId: null };
    }, getSystem: () => ({ ok: false }) },
    telemetry: { count() {}, observe: (n, v) => observed.push([n, v]) },
    logger: { log() {}, warn() {}, error() {} },
    clock: { now: () => 1000 },
    fail: () => {},
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false, cancel() { t.cancelled = true; } };
      timers.push(t);
      return t;
    },
  };
  const started = startSovProjection(ctx);
  assert.ok(started.ok, JSON.stringify(started));
  return { ctx, started, timers, observed, listCalls: () => listCalls };
}

module.exports = ({ test }) => {
  test("SSW6 sov syncAll waits for the world seed (running -> done), syncSeedWaitMs 0 starts at once", async () => {
    let state = "running";
    const env = boot(600000, { getStatus: () => ({ state }) });
    try {
      await env.started.whenReady;
      await flush();
      assert.strictEqual(env.listCalls(), 0, "no syncAll while the seed runs");
      assert.deepStrictEqual(env.timers.map((t) => t.ms), [1000]);
      env.timers[0].fn();
      await flush();
      assert.strictEqual(env.listCalls(), 0);
      assert.strictEqual(env.timers.length, 2);
      state = "done";
      env.timers[1].fn();
      await flush();
      assert.strictEqual(env.listCalls(), 1, "syncAll after done");
      assert.strictEqual(env.timers.length, 2, "no poll after done");
      assert.deepStrictEqual(env.observed.filter(([n]) => n === "sovProjection.seedWaitMs"),
        [["sovProjection.seedWaitMs", 2000]]);
    } finally {
      stopSovProjection(env.ctx);
    }

    const now = boot(0, { getStatus: () => ({ state: "running" }) });
    try {
      await now.started.whenReady;
      await flush();
      assert.strictEqual(now.listCalls(), 1, "syncSeedWaitMs 0 = no wait");
      assert.strictEqual(now.timers.length, 0);
    } finally {
      stopSovProjection(now.ctx);
    }
  });
};
