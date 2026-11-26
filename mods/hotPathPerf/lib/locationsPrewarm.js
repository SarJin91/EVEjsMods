"use strict";

function defaultNow() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function createLocationsPrewarm(deps) {
  const log = deps.log;
  const warn = deps.warn || ((line) => console.warn(`[hotPathPerf] WARN ${line}`));
  const now = deps.now || defaultNow;
  let ConfigServiceClass = null;
  const state = { done: false, ok: null, ms: null, reason: null };

  function setConfigService(exportsValue) {
    if (typeof exportsValue !== "function" || !exportsValue.prototype) return false;
    if (typeof exportsValue.prototype.Handle_GetMultiLocationsEx !== "function") return false;
    ConfigServiceClass = exportsValue;
    return true;
  }

  function finish(ok, reason, ms) {
    state.ok = ok;
    state.reason = reason;
    state.ms = ms;
  }

  function runOnce() {
    if (state.done) return { ok: false, reason: "ALREADY_DONE" };
    state.done = true;
    if (!ConfigServiceClass) {
      finish(false, "CONFIG_SERVICE_NOT_LOADED", null);
      try {
        warn("prewarm locations skipped: CONFIG_SERVICE_NOT_LOADED");
      } catch (_error) {}
      return { ok: false, reason: "CONFIG_SERVICE_NOT_LOADED" };
    }
    let started = null;
    try {
      started = now();
      const fn = ConfigServiceClass.prototype.Handle_GetMultiLocationsEx;
      const raw = (fn && fn.__hotPathPerf) || fn;
      raw.call(ConfigServiceClass.prototype, [[]], null);
      const ms = Math.round(now() - started);
      finish(true, null, ms);
      log(`prewarm locations took ${ms}ms`);
      return { ok: true, ms };
    } catch (error) {
      let ms = null;
      try {
        ms = started === null ? 0 : Math.round(now() - started);
      } catch (_error) {
        ms = 0;
      }
      finish(false, "THREW", ms);
      try {
        warn(`prewarm locations failed after ${ms}ms: ${error && error.message || error}`);
      } catch (_error) {}
      return { ok: false, reason: "THREW", ms };
    }
  }

  function wrapPreload(original) {
    const wrapped = function hotPathPerfPrewarmPreload(...args) {
      const result = original.apply(this, args);
      runOnce();
      return result;
    };
    Object.defineProperty(wrapped, "__hotPathPerfPrewarm", { value: original });
    return wrapped;
  }

  function status() {
    return { done: state.done, ok: state.ok, ms: state.ms, reason: state.reason };
  }

  return { setConfigService, wrapPreload, runOnce, status };
}

module.exports = { createLocationsPrewarm };
