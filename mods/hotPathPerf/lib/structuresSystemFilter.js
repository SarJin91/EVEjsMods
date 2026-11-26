"use strict";

const DETAIL_MAX = 200;

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Number(value);
  const int = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return int > 0 ? int : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfStructures", { value: original });
  return wrapper;
}

function emptyWindow() {
  return { served: 0, empty: 0, passthrough: 0, cloned: 0, parityChecks: 0, refreshRan: 0, refreshSkipped: 0,
    refreshAgeMaxMs: 0 };
}

function createStructuresSystemFilter(options) {
  const config = options.config;
  const log = options.log;
  const now = options.now || Date.now;
  const priv = { deps: null, disabledReason: null, window: emptyWindow(), freshnessSource: null,
    ownRefreshAtMs: null, coalesceDisabledReason: null };
  const coalesceOn = config.structuresRefreshCoalesce === true;
  const freshMs = Number.isFinite(config.structuresRefreshFreshMs) ? config.structuresRefreshFreshMs : 0;

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    log(`WARN structuresSystemFilter disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function disableCoalesce(reason, detail) {
    if (priv.coalesceDisabledReason) return;
    priv.coalesceDisabledReason = reason;
    log(`WARN structuresSystemFilter coalesce disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setFreshnessSource(fn) {
    if (priv.freshnessSource || typeof fn !== "function") return false;
    priv.freshnessSource = fn;
    return true;
  }

  function coalesceText() {
    if (!coalesceOn) return "off";
    return priv.coalesceDisabledReason ? `disabled:${priv.coalesceDisabledReason}` : "on";
  }

  function shouldSkipRefresh(t) {
    if (!coalesceOn || freshMs <= 0 || priv.coalesceDisabledReason) return false;
    try {
      let last = null;
      const own = priv.ownRefreshAtMs;
      if (own !== null && Number.isFinite(own)) last = own;
      if (priv.freshnessSource) {
        const src = priv.freshnessSource();
        if (src !== null && src !== undefined && Number.isFinite(src)) last = last === null ? src : Math.max(last, src);
      }
      if (last === null || !Number.isFinite(t) || t < last || t - last >= freshMs) return false;
      const age = t - last;
      priv.window.refreshSkipped += 1;
      if (age > priv.window.refreshAgeMaxMs) priv.window.refreshAgeMaxMs = age;
      return true;
    } catch (error) {
      disableCoalesce("error", String(error && error.message || error));
      return false;
    }
  }

  function runRefresh() {
    const t = now();
    if (shouldSkipRefresh(t)) return;
    priv.deps.tickStructures(t);
    priv.ownRefreshAtMs = t;
    priv.window.refreshRan += 1;
  }

  function setDeps(stateExports) {
    if (priv.deps) return true;
    const m = stateExports;
    if (!m || typeof m !== "object" || typeof m.tickStructures !== "function" ||
      typeof m.peekStructuresForSystem !== "function") return false;
    priv.deps = {
      tickStructures: (nowMs) => m.tickStructures(nowMs),
      peekStructuresForSystem: (id, opts) => m.peekStructuresForSystem(id, opts),
    };
    return true;
  }

  function wrapListForSystem(original) {
    const wrapped = function hotPathPerfStructuresForSystem(solarSystemID, options) {
      const opts = arguments.length >= 2 ? options : undefined;
      if (priv.disabledReason || !priv.deps || (opts !== undefined && (opts === null || typeof opts !== "object"))) {
        priv.window.passthrough += 1;
        return original.apply(this, arguments);
      }
      const o = opts || {};
      const numericSystemID = toPositiveInt(solarSystemID, 0);
      if (!numericSystemID) {
        priv.window.empty += 1;
        return [];
      }
      if (o.refresh !== false) runRefresh();
      const includeDestroyed = o.includeDestroyed === true;
      let rows;
      try {
        rows = priv.deps.peekStructuresForSystem(numericSystemID, { includeDestroyed });
        if (!Array.isArray(rows)) throw new Error(`peekStructuresForSystem returned ${typeof rows}`);
      } catch (error) {
        disable("error", String(error && error.message || error));
        return original.call(this, solarSystemID, { includeDestroyed, refresh: false });
      }
      const result = rows.map(cloneValue);
      if (config.structuresSystemFilterParityCheck === true) {
        const vendor = original.call(this, solarSystemID, { includeDestroyed, refresh: false });
        priv.window.parityChecks += 1;
        let same;
        try {
          same = JSON.stringify(result) === JSON.stringify(vendor);
        } catch (_error) {
          same = false;
        }
        if (!same) {
          disable("parity", `solarSystemID=${numericSystemID}`);
          return vendor;
        }
      }
      priv.window.served += 1;
      priv.window.cloned += result.length;
      return result;
    };
    return markWrapped(wrapped, original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return priv.deps ? "ready" : "waiting";
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      ready: priv.disabledReason === null && priv.deps !== null,
      disabledReason: priv.disabledReason,
      state: stateText(),
      coalesce: coalesceText(),
      freshMs,
    };
  }

  function statsSnapshot() {
    return { ...status(), ...priv.window };
  }

  function drainStatsLines() {
    const w = priv.window;
    const line = `stats structuresSystemFilter state=${stateText()} served=${w.served} empty=${w.empty} ` +
      `passthrough=${w.passthrough} cloned=${w.cloned} parityChecks=${w.parityChecks} refreshRan=${w.refreshRan} ` +
      `refreshSkipped=${w.refreshSkipped} refreshAgeMaxMs=${w.refreshAgeMaxMs} coalesce=${coalesceText()}`;
    priv.window = emptyWindow();
    return [line];
  }

  return { setDeps, setFreshnessSource, wrapListForSystem, disable, status, statsSnapshot, drainStatsLines };
}

module.exports = { createStructuresSystemFilter, toPositiveInt };
