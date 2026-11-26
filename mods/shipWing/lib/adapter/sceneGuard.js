"use strict";

const WRAPPED = Symbol.for("shipWing.derivedGuard");
const METHOD = "refreshShipEntityDerivedState";
const SCENE_MODULE = "space/runtime/solarSystemScene";
const SCENE_EXPORT = "SolarSystemScene";

function isObj(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function createSceneGuard(deps) {
  const proto = deps && deps.proto;
  const wing = deps && deps.wing;
  let installed = false;
  let active = false;
  let original = null;
  let wrapper = null;

  function note(kind, err) {
    try {
      wing.noteDerivedGuard(kind, err);
    } catch (_err) {
    }
  }

  const countFn = wing && typeof wing.derivedTwinCount === "function" ? "derivedTwinCount" : "liveTwinCount";
  const lookupFn = wing && typeof wing.derivedTwinOf === "function" ? "derivedTwinOf" : "twinOf";

  function twinFor(entityOrID) {
    try {
      if (wing[countFn]() === 0) return null;
      return wing[lookupFn](entityOrID) || null;
    } catch (err) {
      note("error", err);
      return null;
    }
  }

  function install() {
    if (!isObj(proto) || typeof proto[METHOD] !== "function" || !wing || typeof wing.twinOf !== "function"
      || typeof wing.liveTwinCount !== "function") {
      return { ok: false, reason: "GUARD_SEAM_UNAVAILABLE" };
    }
    if (installed || proto[METHOD][WRAPPED] === true) return { ok: false, reason: "GUARD_ALREADY_INSTALLED" };
    original = proto[METHOD];
    const base = original;
    wrapper = function shipWingDerivedGuard(entityOrID) {
      if (!active) return base.apply(this, arguments);
      const twin = twinFor(entityOrID);
      if (!twin) return base.apply(this, arguments);
      note("skipped");
      return { success: true, data: { shipWingSkipped: true } };
    };
    for (const symbol of Object.getOwnPropertySymbols(base)) {
      if (symbol !== WRAPPED) wrapper[symbol] = base[symbol];
    }
    wrapper[WRAPPED] = true;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(proto, METHOD);
      if (!descriptor || descriptor.configurable) {
        Object.defineProperty(proto, METHOD, { value: wrapper, writable: true, configurable: true,
          enumerable: descriptor ? descriptor.enumerable : false });
      } else if (descriptor.writable) {
        proto[METHOD] = wrapper;
      } else {
        return { ok: false, reason: "GUARD_INSTALL_FAILED" };
      }
    } catch (_err) {
      return { ok: false, reason: "GUARD_INSTALL_FAILED" };
    }
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    if (installed && proto[METHOD] === wrapper) proto[METHOD] = original;
    installed = false;
  }

  return Object.freeze({ install, uninstall, isActive: () => active });
}

function installSceneGuardFromGame(gameAdapter, deps) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("tasks")) {
    return { ok: false, reason: "probe_tasks_unavailable" };
  }
  const loaded = gameAdapter.requireGame(SCENE_MODULE);
  if (!loaded || !loaded.ok) return { ok: false, reason: `require_failed:${loaded && loaded.reason}` };
  const cls = isObj(loaded.exports) ? loaded.exports[SCENE_EXPORT] : null;
  const guard = createSceneGuard({ proto: typeof cls === "function" ? cls.prototype : null, wing: deps && deps.wing });
  const installed = guard.install();
  return installed.ok ? { ok: true, guard } : { ok: false, reason: installed.reason };
}

module.exports = { WRAPPED, METHOD, SCENE_MODULE, SCENE_EXPORT, createSceneGuard, installSceneGuardFromGame };
