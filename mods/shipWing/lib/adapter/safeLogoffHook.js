"use strict";

const MARKER = Symbol.for("shipWing.safeLogoff");
const CONSUMER = "safeLogoff";
const MODULE_PATH = "services/ship/safeLogoffRuntime";
const EXPORT_NAME = "prepareStart";

const COUNTER_NAMES = Object.freeze(["safeLogoff.aborted", "safeLogoff.blocked", "safeLogoff.error"]);

function isObj(value) {
  return value !== null && typeof value === "object";
}

function isFn(value) {
  return typeof value === "function";
}

function labelsOk(labels) {
  return isObj(labels) && typeof labels.DRONES_CONNECTED === "string" && typeof labels.MOVEMENT_ACTIVE === "string";
}

function createSafeLogoffHook(deps) {
  const runtime = deps && deps.runtime;
  const wing = deps && deps.wing;
  const characterIdOf = deps && deps.characterIdOf;
  const findSession = deps && deps.findSession;
  const config = (deps && deps.config) || {};
  const log = (deps && deps.log) || {};
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let installed = false;
  let active = false;

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function debug(message) {
    try {
      if (isFn(log.debug)) log.debug(message);
    } catch (_err) {
    }
  }

  function blockedResult(session) {
    const charId = Number(characterIdOf(session));
    if (!(charId > 0)) return null;
    if (!(Number(wing.deployedCount(charId)) > 0)) return null;
    const res = runtime.collectFailedConditions(session);
    if (!isObj(res) || res.success !== true || !Array.isArray(res.labels)) return null;
    const LABELS = runtime.LABELS;
    const labels = [...res.labels];
    if (!labels.includes(LABELS.DRONES_CONNECTED)) labels.push(LABELS.DRONES_CONNECTED);
    const order = Object.values(LABELS);
    const rank = (label) => {
      const at = order.indexOf(label);
      return at < 0 ? order.length : at;
    };
    labels.sort((a, b) => rank(a) - rank(b));
    return { success: true, data: labels };
  }

  function install() {
    if (installed) return { ok: false, reason: "SAFE_LOGOFF_ALREADY_INSTALLED" };
    if (!isObj(runtime) || !isFn(runtime[EXPORT_NAME]) || !isFn(runtime.abort)
      || !isFn(runtime.collectFailedConditions) || !labelsOk(runtime.LABELS)
      || !wing || !isFn(wing.deployedCount) || !isFn(characterIdOf) || !isFn(findSession)) {
      return { ok: false, reason: "SAFE_LOGOFF_SEAM_UNAVAILABLE" };
    }
    const base = runtime[EXPORT_NAME];
    if (base[MARKER] === true) return { ok: false, reason: "SAFE_LOGOFF_ALREADY_INSTALLED" };
    const wrapper = function shipWingSafeLogoff(session) {
      if (!active || config.safeLogoffBlockWhileDeployed !== true) return base.apply(this, arguments);
      let blocked = null;
      try {
        blocked = blockedResult(session);
      } catch (err) {
        bump("safeLogoff.error");
        debug(`safe logoff prepareStart failed - ${(err && err.message) || err}`);
        blocked = null;
      }
      if (!blocked) return base.apply(this, arguments);
      bump("safeLogoff.blocked");
      return blocked;
    };
    for (const symbol of Object.getOwnPropertySymbols(base)) {
      if (symbol !== MARKER) wrapper[symbol] = base[symbol];
    }
    wrapper[MARKER] = true;
    try {
      runtime[EXPORT_NAME] = wrapper;
    } catch (_err) {
      return { ok: false, reason: "SAFE_LOGOFF_INSTALL_FAILED" };
    }
    if (runtime[EXPORT_NAME] !== wrapper) return { ok: false, reason: "SAFE_LOGOFF_INSTALL_FAILED" };
    installed = true;
    active = true;
    return { ok: true };
  }

  function abortFor(charId, verb, source) {
    if (!active || config.safeLogoffAbortOnOrder !== true) return false;
    try {
      const session = findSession(Number(charId));
      if (!session || !session._safeLogoff) return false;
      const done = runtime.abort(session, { reason: runtime.LABELS.MOVEMENT_ACTIVE }) === true;
      if (done) {
        bump("safeLogoff.aborted");
        debug(`safe logoff aborted for char=${Number(charId)} (${verb}, ${source || "chat"})`);
      }
      return done;
    } catch (err) {
      bump("safeLogoff.error");
      debug(`safe logoff abort failed - ${(err && err.message) || err}`);
      return false;
    }
  }

  return Object.freeze({
    install,
    abortFor,
    stop: () => {
      active = false;
    },
    isActive: () => active,
    stats: () => ({ counters: { ...counters } }),
  });
}

function installSafeLogoffHookFromGame(gameAdapter, deps) {
  if (!gameAdapter || !isFn(gameAdapter.isConsumerAvailable) || !gameAdapter.isConsumerAvailable(CONSUMER)) {
    return { ok: false, reason: `probe_${CONSUMER}_unavailable` };
  }
  const loaded = gameAdapter.requireGame(MODULE_PATH);
  if (!loaded || !loaded.ok) return { ok: false, reason: `require_failed:${loaded && loaded.reason}` };
  const hook = createSafeLogoffHook({ ...deps, runtime: loaded.exports });
  const installed = hook.install();
  return installed.ok ? { ok: true, hook } : { ok: false, reason: installed.reason };
}

module.exports = {
  MARKER, CONSUMER, MODULE_PATH, COUNTER_NAMES, createSafeLogoffHook, installSafeLogoffHookFromGame,
};
