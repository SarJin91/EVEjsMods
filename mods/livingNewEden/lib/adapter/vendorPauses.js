"use strict";

const { performance } = require("node:perf_hooks");

const PREPARE = "prepareUniverseSitesForPlayerEntry";
const PREWARM = "prewarmSolarSystemForArrival";
const NAMES = Object.freeze([PREPARE, PREWARM]);
const KIND = Object.freeze({ [PREPARE]: "entryPrepare", [PREWARM]: "arrivalPrewarm" });
const WRAPPED = Symbol.for("livingNewEden.vendorPauses");
const RUNTIME_PATH = "space/runtime";

const state = {
  installedOn: new WeakSet(),
  installed: false,
  depth: 0,
  minMs: Infinity,
  subscribers: new Set(),
  recorded: 0,
  subscriberErrors: 0,
  now: () => performance.now(),
};

function systemIdOf(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function report(kind, firstArg, startMs) {
  try {
    const endMs = state.now();
    if (!(endMs - startMs >= state.minMs) || state.subscribers.size === 0) return;
    state.recorded += 1;
    const pause = Object.freeze({ startMs, endMs, systemId: systemIdOf(firstArg), kind });
    for (const fn of [...state.subscribers]) {
      try {
        fn(pause);
      } catch (_err) {
        state.subscriberErrors += 1;
      }
    }
  } catch (_err) {
    state.subscriberErrors += 1;
  }
}

function makeWrapper(name, found) {
  const kind = KIND[name];
  const wrapper = {
    [name]: function livingNewEdenVendorPause() {
      state.depth += 1;
      const outer = state.depth === 1;
      let startMs = 0;
      if (outer) {
        try {
          startMs = state.now();
        } catch (_err) {
          startMs = NaN;
        }
      }
      try {
        return found.apply(this, arguments);
      } finally {
        state.depth -= 1;
        if (outer && Number.isFinite(startMs)) report(kind, arguments[0], startMs);
      }
    },
  }[name];
  for (const s of Object.getOwnPropertySymbols(found)) {
    if (s === WRAPPED) continue;
    try {
      wrapper[s] = found[s];
    } catch (_err) {
    }
  }
  Object.defineProperty(wrapper, WRAPPED, { value: true });
  return wrapper;
}

function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  state.subscribers.add(fn);
  return () => {
    state.subscribers.delete(fn);
  };
}

function stats() {
  return { installed: state.installed, subscribers: state.subscribers.size, recorded: state.recorded,
    subscriberErrors: state.subscriberErrors };
}

const API = Object.freeze({ ok: true, subscribe, stats });

function install(requireGame, opts = {}) {
  if (typeof requireGame !== "function") return { ok: false, reason: "RUNTIME_UNAVAILABLE", detail: "no_require" };
  let loaded;
  try {
    loaded = requireGame(RUNTIME_PATH);
  } catch (err) {
    return { ok: false, reason: "RUNTIME_UNAVAILABLE", detail: String((err && err.message) || err) };
  }
  if (!loaded || loaded.ok !== true || loaded.exports === null || typeof loaded.exports !== "object") {
    return { ok: false, reason: "RUNTIME_UNAVAILABLE", detail: String((loaded && loaded.reason) || "not_loaded") };
  }
  const proto = Object.getPrototypeOf(loaded.exports);
  if (proto === null || typeof proto !== "object") return { ok: false, reason: "SYMBOL_MISSING", detail: "prototype" };
  if (Number.isFinite(opts.minMs) && opts.minMs >= 0) state.minMs = opts.minMs;
  if (typeof opts.now === "function") state.now = opts.now;
  if (state.installedOn.has(proto)) return API;
  const found = {};
  for (const name of NAMES) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || d.get || d.set || typeof d.value !== "function") {
      return { ok: false, reason: "SYMBOL_MISSING", detail: name };
    }
    if (d.writable !== true) return { ok: false, reason: "NOT_WRITABLE", detail: name };
    found[name] = d.value;
  }
  const prepareWrapper = makeWrapper(PREPARE, found[PREPARE]);
  const prewarmWrapper = makeWrapper(PREWARM, found[PREWARM]);
  try {
    proto[PREPARE] = prepareWrapper;
    proto[PREWARM] = prewarmWrapper;
  } catch (err) {
    if (proto[PREPARE] === prepareWrapper) proto[PREPARE] = found[PREPARE];
    return { ok: false, reason: "NOT_WRITABLE", detail: String((err && err.message) || err) };
  }
  state.installedOn.add(proto);
  state.installed = true;
  return API;
}

module.exports = { install, stats, NAMES, KIND, WRAPPED, RUNTIME_PATH };
