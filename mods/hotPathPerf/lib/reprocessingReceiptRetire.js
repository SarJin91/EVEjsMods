"use strict";

const { fingerprintFunctions } = require("./blueprintOwnerRead");

const MARKER = "__hotPathPerfReceiptRetire";
const HOOK_NAME = "hotPathPerf.reprocessingReceiptRetire";
const DETAIL_MAX = 200;

const FINGERPRINTS = Object.freeze({
  custody: Object.freeze({ retireReceipts: "b0c704a492d6b3054d73c5037094325a12b41a14" }),
  settlement: Object.freeze({
    retireOperationReceipts: "b71af962c1d6118a25d7f367e8a0a2ee8ad300b8",
    pruneFinishedOperationReceipts: "8680c6065c0e4628da4eb46be76f70bce8d5fe0f",
  }),
});

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
}

function defaultClearTimer(handle) {
  clearTimeout(handle);
}

function emptyWindow() {
  return { deferredCalls: 0, keys: 0, flushes: 0, flushMaxMs: 0, flushFailures: 0, warned: false };
}

function createReprocessingReceiptRetire(options) {
  const config = (options && options.config) || {};
  const log = (options && options.log) || (() => {});
  const now = (options && options.now) || Date.now;
  const setTimer = (options && options.setTimer) || defaultSetTimer;
  const clearTimer = (options && options.clearTimer) || defaultClearTimer;
  const delayMs = Math.max(0, Number(config.reprocessingReceiptRetireDelayMs) || 0);
  const maxPendingKeys = Math.max(1, Math.floor(Number(config.reprocessingReceiptRetireMaxPendingKeys) || 1));

  const priv = {
    original: null, store: null, disabledReason: null, hookRegistered: false,
    pending: new Set(),
    timer: null,
    win: emptyWindow(),
  };

  function checkSource(key, text) {
    if (priv.disabledReason) return false;
    const expected = key === "custody" ? FINGERPRINTS.custody : key === "settlement" ? FINGERPRINTS.settlement : null;
    if (!expected) {
      disable("drift", `unknown source ${key}`);
      return false;
    }
    const names = Object.keys(expected);
    const got = fingerprintFunctions(text, names);
    const bad = names.filter((name) => got.get(name) !== expected[name]);
    if (bad.length > 0) {
      disable("drift", `${key}: ${bad.join(",")}`);
      return false;
    }
    return true;
  }

  function registerHook() {
    if (priv.hookRegistered || !priv.store) return;
    priv.hookRegistered = true;
    try {
      priv.store.registerShutdownHook(HOOK_NAME, () => { flush("shutdown"); });
    } catch (error) {
      log(`WARN reprocessingReceiptRetireDefer shutdown hook not registered: ${fit(error && error.message || error)}`);
    }
  }

  function setStoreDeps(m) {
    if (priv.store) return true;
    if (!m || typeof m !== "object" || typeof m.registerShutdownHook !== "function" ||
      typeof m.isShutdownInProgress !== "function") return false;
    priv.store = {
      registerShutdownHook: (name, fn) => m.registerShutdownHook(name, fn),
      isShutdownInProgress: () => m.isShutdownInProgress() === true,
    };
    registerHook();
    return true;
  }

  function stopTimer() {
    if (priv.timer === null) return;
    const handle = priv.timer;
    priv.timer = null;
    try { clearTimer(handle); } catch (_error) {}
  }

  function armTimer() {
    if (priv.timer !== null) return;
    priv.timer = setTimer(() => {
      priv.timer = null;
      try {
        flush("timer");
      } catch (error) {
        log(`WARN reprocessingReceiptRetireDefer timer error: ${fit(error && error.message || error)}`);
      }
    }, delayMs);
  }

  function flush(reason) {
    stopTimer();
    if (priv.pending.size === 0) return { success: true, keys: 0 };
    const keys = [...priv.pending];
    priv.pending.clear();
    const w = priv.win;
    if (!priv.original) {
      w.flushFailures += 1;
      return { success: false, keys: keys.length };
    }
    const started = now();
    let ok = false;
    let detail = "custody error";
    try {
      const result = priv.original.call(null, keys);
      ok = Boolean(result) && result.success === true;
      if (!ok && result && result.errorMsg) detail = String(result.errorMsg);
    } catch (error) {
      detail = String(error && error.message || error);
    }
    const ms = Number(now()) - Number(started);
    w.flushes += 1;
    if (ms > w.flushMaxMs) w.flushMaxMs = ms;
    if (!ok) {
      w.flushFailures += 1;
      if (!w.warned) {
        w.warned = true;
        log(`WARN reprocessingReceiptRetireDefer flush failed (reason=${reason} keys=${keys.length}): ${fit(detail)}` +
          " — receipts left for the boot prune");
      }
    }
    return { success: ok, keys: keys.length };
  }

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    if (priv.pending.size > 0) {
      try { flush("disable"); } catch (_error) {}
    }
    stopTimer();
    priv.pending.clear();
    priv.disabledReason = String(reason);
    log(`WARN reprocessingReceiptRetireDefer disabled: ${priv.disabledReason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function wrapRetire(original) {
    if (typeof original !== "function" || original[MARKER]) return original;
    priv.original = original;
    const wrapped = function hotPathPerfRetireReceipts(idempotencyKeys) {
      if (priv.disabledReason || !priv.store || !Array.isArray(idempotencyKeys)) return original.apply(this, arguments);
      try {
        for (const key of idempotencyKeys) priv.pending.add(key);
        priv.win.deferredCalls += 1;
        priv.win.keys += idempotencyKeys.length;
        if (priv.pending.size >= maxPendingKeys) flush("limit");
        else armTimer();
        return { success: true, removed: 0, removedReceiptKeys: [], deferred: idempotencyKeys.length };
      } catch (error) {
        disable("error", error && error.message || error);
        return original.apply(this, arguments);
      }
    };
    Object.defineProperty(wrapped, MARKER, { value: original });
    return wrapped;
  }

  function status() {
    return { disabledReason: priv.disabledReason, pending: priv.pending.size };
  }

  function stateText() {
    return priv.disabledReason ? `disabled:${priv.disabledReason}` : "on";
  }

  function takeStats() {
    const w = priv.win;
    if (w.deferredCalls === 0 && w.flushes === 0 && w.flushFailures === 0 && priv.pending.size === 0) return null;
    priv.win = emptyWindow();
    return {
      deferredCalls: w.deferredCalls, keys: w.keys, flushes: w.flushes, flushMaxMs: w.flushMaxMs,
      flushFailures: w.flushFailures, pending: priv.pending.size,
    };
  }

  function drainStatsLines() {
    const s = takeStats();
    if (!s) return [];
    return [`stats reprocessingReceiptRetireDefer state=${stateText()} deferredCalls=${s.deferredCalls} keys=${s.keys} ` +
      `flushes=${s.flushes} flushMaxMs=${s.flushMaxMs} flushFailures=${s.flushFailures} pending=${s.pending}`];
  }

  return { checkSource, setStoreDeps, wrapRetire, flush, disable, status, stateText, takeStats, drainStatsLines };
}

module.exports = { createReprocessingReceiptRetire, FINGERPRINTS, MARKER, HOOK_NAME };
