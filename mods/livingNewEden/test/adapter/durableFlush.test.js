"use strict";

const assert = require("node:assert");

const { flushStructuresFrom } = require("../../lib/adapter/structures");
const { flushWrecksFrom } = require("../../lib/adapter/nativeWrecks");
const { creditRewardIskFrom } = require("../../lib/adapter/playerRewards");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { probeModules } = require("../../lib/adapter/probe");
const { createPoller, installPollerHooks, getPollerHooks } = require("../../lib/presence/poller");
const { isThenable } = require("../../lib/adapter/maybeAsync");

const CHAR = 90000001;
const KEY = "lne:libpay:30000142:0:1000:90000001:isk";

function fakeStore({ durable = "ok", sync = true } = {}) {
  const calls = [];
  const store = {};
  if (sync) {
    store.flushTableSync = (table) => {
      calls.push(["sync", table]);
      return { success: true };
    };
  }
  if (durable !== null) {
    store.flushTableDurable = async (table) => {
      calls.push(["durable", table]);
      if (durable === "reject") throw new Error("worker gone");
      return durable === "fail" ? { success: false, errorMsg: "FLUSH_ERROR" } : { success: true };
    };
  }
  return { store, calls };
}

function withWorkerOff(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "EVEJS_PERSISTENCE_WORKER");
  const prior = process.env.EVEJS_PERSISTENCE_WORKER;
  process.env.EVEJS_PERSISTENCE_WORKER = "0";
  return Promise.resolve().then(fn).finally(() => {
    if (had) process.env.EVEJS_PERSISTENCE_WORKER = prior;
    else delete process.env.EVEJS_PERSISTENCE_WORKER;
  });
}

function wallet() {
  return {
    getCharacterWallet: (id) => (id === CHAR ? { characterID: id, balance: 100 } : null),
    adjustCharacterBalanceAsync: async () => ({ success: true, data: { balance: 5100 } }),
  };
}

const iskSpec = () => ({ characterId: CHAR, amountIsk: 5000, commandId: KEY, issuerCorporationId: 1000035,
  systemId: 30000142, description: "liberation" });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function manualTimers() {
  const pending = [];
  return {
    setTimer: (fn) => {
      const entry = { fn, live: true };
      pending.push(entry);
      return { cancel: () => { entry.live = false; }, hasRef: () => false };
    },
    fire: () => {
      const next = pending.find((e) => e.live);
      if (!next) return false;
      next.live = false;
      next.fn();
      return true;
    },
    armed: () => pending.filter((e) => e.live).length,
  };
}

module.exports = ({ test }) => {
  test("DF1 structures flush: durable when exported (worker off too), sync only without it, failures map to "
    + "FLUSH_FAILED", async () => {
    const vendorOf = (store) => ({ gameStore: store, state: { STRUCTURES_TABLE: "structures" } });
    const durable = fakeStore();
    const pending = flushStructuresFrom(vendorOf(durable.store));
    assert.ok(isThenable(pending), "durable flush is awaited");
    assert.deepStrictEqual(await pending, { ok: true });
    assert.deepStrictEqual(durable.calls, [["durable", "structures"]]);

    await withWorkerOff(async () => {
      const off = fakeStore();
      assert.deepStrictEqual(await flushStructuresFrom(vendorOf(off.store)), { ok: true });
      assert.deepStrictEqual(off.calls, [["durable", "structures"]], "the seam stays on with the worker off");
    });

    const legacy = fakeStore({ durable: null });
    assert.deepStrictEqual(flushStructuresFrom(vendorOf(legacy.store)), { ok: true }, "plain result without durable");
    assert.deepStrictEqual(legacy.calls, [["sync", "structures"]]);

    assert.deepStrictEqual(await flushStructuresFrom(vendorOf(fakeStore({ durable: "fail" }).store)),
      { ok: false, reason: "FLUSH_FAILED", ambiguous: true, detail: "FLUSH_ERROR" });
    assert.deepStrictEqual(await flushStructuresFrom(vendorOf(fakeStore({ durable: "reject" }).store)),
      { ok: false, reason: "FLUSH_FAILED", ambiguous: true, detail: "worker gone" });
  });

  test("DF2 wrecks flush: both tables through durable, a failure or a rejection is durable:false", async () => {
    const modsOf = (store) => ({ gameStore: store, store: { TABLE: { WRECKS: "wrecks", WRECK_ITEMS: "wreckItems" } } });
    const ok = fakeStore();
    assert.deepStrictEqual(await flushWrecksFrom(modsOf(ok.store)), { ok: true, durable: true });
    assert.deepStrictEqual(ok.calls, [["durable", "wrecks"], ["durable", "wreckItems"]]);
    assert.deepStrictEqual(await flushWrecksFrom(modsOf(fakeStore({ durable: "fail" }).store)),
      { ok: true, durable: false });
    assert.deepStrictEqual(await flushWrecksFrom(modsOf(fakeStore({ durable: "reject" }).store)),
      { ok: true, durable: false });
    assert.deepStrictEqual(flushWrecksFrom(modsOf(fakeStore({ durable: null }).store)), { ok: true, durable: true });
  });

  test("DF3 ISK reward: durable flush failure or rejection -> FLUSH_FAILED, success -> ok", async () => {
    const ok = fakeStore();
    assert.deepStrictEqual(await creditRewardIskFrom(wallet(), ok.store, iskSpec()),
      { ok: true, duplicate: false, fingerprintMismatch: false });
    assert.deepStrictEqual(ok.calls, [["durable", "characters"]]);
    assert.deepStrictEqual(await creditRewardIskFrom(wallet(), fakeStore({ durable: "fail" }).store, iskSpec()),
      { ok: false, reason: "FLUSH_FAILED", permanent: false, detail: "FLUSH_ERROR" });
    assert.deepStrictEqual(await creditRewardIskFrom(wallet(), fakeStore({ durable: "reject" }).store, iskSpec()),
      { ok: false, reason: "FLUSH_FAILED", permanent: false, detail: "worker gone" });
    const legacy = fakeStore({ durable: null });
    assert.strictEqual((await creditRewardIskFrom(wallet(), legacy.store, iskSpec())).ok, true);
    assert.deepStrictEqual(legacy.calls, [["sync", "characters"]]);
  });

  test("DF4 probe: flushTableSync required, a missing flushTableDurable disables no module", () => {
    const entry = GAME_MODULES.find((m) => m.path === "gameStore/index");
    const byName = new Map(entry.symbols.map((s) => [s.name, s]));
    assert.ok(byName.get("flushTableSync").consumers.length > 0);
    assert.deepStrictEqual([...byName.get("flushTableDurable").consumers], []);
    const exportsObject = {};
    for (const s of entry.symbols) {
      if (s.name === "flushTableDurable") continue;
      const type = s.valueType || "function";
      exportsObject[s.name] = s.kind === "property" ? "world" : type === "function" ? () => {} : type === "object"
        ? {} : type === "number" ? 1 : "x";
    }
    const report = probeModules([entry], { load: () => ({ ok: true, exports: exportsObject }) });
    assert.deepStrictEqual([report.modules[0].missing, report.disabledModules], [["flushTableDurable"], {}]);
  });

  test("DF5 poller: an async pass blocks the next one until it settles, a re-arm waits, meter takes the sync part",
    async () => {
      const prior = getPollerHooks();
      const metered = [];
      installPollerHooks({ meter: (label, ms) => metered.push([label, ms]) });
      try {
        const timers = manualTimers();
        let t = 0;
        let started = 0;
        let gate = deferred();
        const poller = createPoller({ label: "test:async", intervalMs: 10, now: () => t, setTimer: timers.setTimer,
          runPass: () => {
            started += 1;
            return gate.promise;
          } });
        poller.start();
        assert.ok(timers.fire());
        poller.arm(0);
        assert.deepStrictEqual([started, timers.armed(), metered.length], [1, 0, 1], "no second pass in flight");
        t += 5;
        gate.resolve();
        gate = deferred();
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual([poller.getPasses(), timers.armed()], [1, 1], "the re-arm runs after the pass");
        assert.ok(timers.fire());
        poller.stop();
        gate.resolve();
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual([started, poller.getPasses(), timers.armed()], [2, 2, 0], "stopped: nothing armed");
        const failing = createPoller({ label: "test:reject", intervalMs: 10, now: () => t, setTimer: timers.setTimer,
          onError: (err) => metered.push(["error", err.message]),
          runPass: () => Promise.reject(new Error("pass failed")) });
        failing.start();
        assert.ok(timers.fire());
        await new Promise((r) => setImmediate(r));
        assert.ok(metered.some((m) => m[0] === "error" && m[1] === "pass failed"), "rejection goes to onError");
        assert.strictEqual(failing.getPasses(), 1);
        failing.stop();
      } finally {
        installPollerHooks(prior);
      }
    });

  test("DF6 poller: a pass still pending after stall.afterMs is logged once, a pass that settles in time is not",
    async () => {
      const prior = getPollerHooks();
      const logged = [];
      installPollerHooks({ stall: { afterMs: 50, log: (label, ms) => logged.push([label, ms]) } });
      try {
        const timers = manualTimers();
        let gate = deferred();
        const poller = createPoller({ label: "test:stall", intervalMs: 10, now: () => 0, setTimer: timers.setTimer,
          runPass: () => gate.promise });
        poller.start();
        assert.ok(timers.fire());
        assert.strictEqual(timers.armed(), 1, "stall watch armed while the pass is pending");
        assert.ok(timers.fire());
        assert.deepStrictEqual(logged, [["test:stall", 50]]);
        gate.resolve();
        gate = deferred();
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual([poller.getPasses(), timers.armed()], [1, 1]);
        assert.ok(timers.fire());
        gate.resolve();
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual([poller.getPasses(), timers.armed(), logged.length], [2, 1, 1],
          "settled in time: the stall watch is cancelled");
        poller.stop();
        assert.strictEqual(timers.armed(), 0);
      } finally {
        installPollerHooks(prior);
      }
    });
};
