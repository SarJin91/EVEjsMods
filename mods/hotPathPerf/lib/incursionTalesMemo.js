"use strict";

const crypto = require("crypto");
const { fingerprintFunctions } = require("./blueprintOwnerRead");

const MARKER = "__hotPathPerfIncursion";
const TABLE = "incursionLifecycle";
const DETAIL_MAX = 200;

const LIST_TALES_LINE = "  function listTales() { return Object.values(store.read().tales).map(validateTale); }";
const STORE_LINE = "  const store = options.store || require(\"./incursionLifecycleStore\");";

const FINGERPRINTS = Object.freeze({
  presentation: "409faee03ab3207e5e3c17a119c962b49ac43c54",
  store: "f0773fef420fb8c16e95e998c7bf762d45327a1a",
  lifecycle: Object.freeze({ validateTale: "c1436dc16b5fbc52c876e7ed7cf8e80e82280fea" }),
});

const UPSTREAM_STORE_LINE = "function readShared() {";
const UPSTREAM_LIST_TALES_LINE = "  function listTales() { return Object.values(readTales()).map(validateTale); }";
const UPSTREAM_READ_TALES_LINE = "  const readTales = () => (store.readShared ? store.readShared() : store.read()).tales;";

function fixedUpstream(src) {
  const store = lf(src && src.store).split("\n");
  const lifecycle = lf(src && src.lifecycle).split("\n");
  return store.includes(UPSTREAM_STORE_LINE) && lifecycle.includes(UPSTREAM_LIST_TALES_LINE) &&
    lifecycle.includes(UPSTREAM_READ_TALES_LINE) && !lifecycle.includes(LIST_TALES_LINE);
}

class VendorThrow {
  constructor(error) {
    this.error = error;
  }
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function lf(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_error) {
    return false;
  }
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, MARKER, { value: original });
  return wrapper;
}

function emptyWindow() {
  return { hits: 0, fills: 0, passthrough: 0, bumps: 0, fillMaxMs: 0, parityChecks: 0 };
}

function createIncursionTalesMemo(options) {
  const config = (options && options.config) || {};
  const log = (options && options.log) || (() => {});
  const now = (options && options.now) || (() => process.hrtime.bigint());
  const priv = {
    store: null,
    lifecycle: null,
    presentation: null,
    fingerprintOk: false,
    mutateWrapped: false,
    disabledReason: null,
    root: null,
    gen: 0,
    filledGen: -1,
    tales: null,
    mutateDepth: 0,
    window: emptyWindow(),
  };

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    priv.root = null;
    priv.tales = null;
    log(`WARN incursionTalesMemo disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setStoreDeps(gameStoreExports) {
    if (!gameStoreExports || typeof gameStoreExports.read !== "function") return false;
    priv.store = gameStoreExports;
    return true;
  }

  function setLifecycleDeps(lifecycleExports) {
    if (!lifecycleExports || typeof lifecycleExports.listTales !== "function") return false;
    priv.lifecycle = lifecycleExports;
    return true;
  }

  function setPresentationDeps(presentationExports) {
    if (!presentationExports || typeof presentationExports.isPrepared !== "function") return false;
    priv.presentation = presentationExports;
    return true;
  }

  function checkFingerprint(src) {
    const s = src || {};
    if (sha1(lf(s.presentation)) !== FINGERPRINTS.presentation) return { ok: false, detail: "incursionPresentation.js" };
    if (sha1(lf(s.store)) !== FINGERPRINTS.store) return { ok: false, detail: "incursionLifecycleStore.js" };
    const lifecycle = lf(s.lifecycle);
    if (!lifecycle.split("\n").includes(LIST_TALES_LINE)) return { ok: false, detail: "incursionLifecycle.js listTales" };
    if (!lifecycle.split("\n").includes(STORE_LINE)) return { ok: false, detail: "incursionLifecycle.js store" };
    const got = fingerprintFunctions(lifecycle, Object.keys(FINGERPRINTS.lifecycle));
    for (const name of Object.keys(FINGERPRINTS.lifecycle)) {
      if (got.get(name) !== FINGERPRINTS.lifecycle[name]) return { ok: false, detail: `incursionLifecycle.js ${name}` };
    }
    priv.fingerprintOk = true;
    return { ok: true };
  }

  function ready() {
    return priv.disabledReason === null && priv.store !== null && priv.lifecycle !== null && priv.presentation !== null &&
      priv.fingerprintOk && priv.mutateWrapped;
  }

  function view() {
    if (!ready() || priv.mutateDepth > 0) return null;
    const r = priv.store.read(TABLE, "/");
    if (!r || r.success !== true || !r.data || typeof r.data !== "object") return null;
    if (priv.tales !== null && r.data === priv.root && priv.gen === priv.filledGen) {
      priv.window.hits += 1;
      return priv.tales;
    }
    const gen = priv.gen;
    const started = now();
    let tales;
    try {
      tales = priv.lifecycle.listTales();
    } catch (error) {
      priv.root = null;
      priv.tales = null;
      throw new VendorThrow(error);
    }
    if (!Array.isArray(tales)) {
      disable("error", "listTales: not an array");
      return null;
    }
    deepFreeze(tales);
    priv.root = r.data;
    priv.filledGen = gen;
    priv.tales = tales;
    priv.window.fills += 1;
    const ms = Number(now() - started) / 1e6;
    if (ms > priv.window.fillMaxMs) priv.window.fillMaxMs = ms;
    return tales;
  }

  function prepared(tales) {
    return tales.filter(priv.presentation.isPrepared);
  }

  function wrapWith(name, original, compute, describe) {
    if (typeof original !== "function") return original;
    if (original[MARKER]) return original;
    const wrapped = {
      [`hotPathPerfIncursion_${name}`]: function () {
        let result;
        try {
          const v = view();
          if (v === null) {
            priv.window.passthrough += 1;
            return original.apply(this, arguments);
          }
          result = compute(v, arguments);
        } catch (error) {
          if (error instanceof VendorThrow) throw error.error;
          disable("error", `${name}: ${error && error.message || error}`);
          priv.window.passthrough += 1;
          return original.apply(this, arguments);
        }
        if (config.incursionTalesMemoParityCheck === true) {
          const vendor = original.apply(this, arguments);
          priv.window.parityChecks += 1;
          if (!sameJson(result, vendor)) {
            disable("parity", `fn=${name} system=${describe(arguments)}`);
            return vendor;
          }
        }
        return result;
      },
    }[`hotPathPerfIncursion_${name}`];
    return markWrapped(wrapped, original);
  }

  const noSystem = () => "-";

  function wrapGetTales(original) {
    return wrapWith("getTales", original, (v) => prepared(v), noSystem);
  }

  function wrapActiveTales(original) {
    return wrapWith("activeTales", original, (v) => prepared(v).filter((tale) => !tale.terminal), noSystem);
  }

  function wrapForSystem(original) {
    return wrapWith("forSystem", original, (v, args) => {
      const systemID = args[0];
      const active = prepared(v).filter((tale) => !tale.terminal);
      return active.find((tale) => tale.placement.systems.some((row) => row.solarSystemID === Number(systemID))) || null;
    }, (args) => String(args[0]));
  }

  function wrapMutate(original) {
    if (typeof original !== "function") return original;
    if (original[MARKER]) {
      priv.mutateWrapped = true;
      return original;
    }
    const wrapped = function hotPathPerfIncursionMutate() {
      priv.mutateDepth += 1;
      try {
        return original.apply(this, arguments);
      } finally {
        priv.mutateDepth -= 1;
        priv.gen += 1;
        priv.window.bumps += 1;
      }
    };
    priv.mutateWrapped = true;
    return markWrapped(wrapped, original);
  }

  function stateName() {
    if (priv.disabledReason) return "disabled";
    return ready() ? "ready" : "waiting";
  }

  function status() {
    return { enabled: priv.disabledReason === null, ready: ready(), disabledReason: priv.disabledReason, state: stateName() };
  }

  function snapshot() {
    return { state: stateName(), reason: priv.disabledReason, ...priv.window };
  }

  function stateText() {
    return priv.disabledReason ? `disabled:${priv.disabledReason}` : stateName();
  }

  function drainStatsLines() {
    const w = priv.window;
    const line = `stats incursionTalesMemo state=${stateText()} hits=${w.hits} fills=${w.fills} passthrough=${w.passthrough} ` +
      `bumps=${w.bumps} fillMaxMs=${w.fillMaxMs.toFixed(1)} parityChecks=${w.parityChecks}`;
    priv.window = emptyWindow();
    return [line];
  }

  return {
    setStoreDeps, setLifecycleDeps, setPresentationDeps, checkFingerprint,
    wrapGetTales, wrapActiveTales, wrapForSystem, wrapMutate,
    disable, status, snapshot, stateText, drainStatsLines,
  };
}

module.exports = { createIncursionTalesMemo, fixedUpstream, deepFreeze, FINGERPRINTS, TABLE, MARKER, LIST_TALES_LINE, STORE_LINE };
