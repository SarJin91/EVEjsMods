"use strict";

const WRAPPED = Symbol.for("evejs.missionStructureRestore.wrapped");

function markWrapped(fn) {
  Object.defineProperty(fn, WRAPPED, { value: true });
  return fn;
}

function wrapEnsure(serviceExports, { restore, stats, onError }) {
  const previous = serviceExports && serviceExports.ensureSiteContentsMaterialized;
  if (typeof previous !== "function") return { ok: false, reason: "missing" };
  if (previous[WRAPPED]) return { ok: false, reason: "already-wrapped" };

  const wrapped = function ensureSiteContentsMaterialized(scene, instanceOrSite, options) {
    const result = previous.apply(this, arguments);
    try {
      stats.calls += 1;
      restore(scene, result, options);
    } catch (error) {
      stats.errors += 1;
      try {
        onError("restore step failed - vanilla result kept", error);
      } catch (_logError) {
      }
    }
    return result;
  };
  serviceExports.ensureSiteContentsMaterialized = markWrapped(wrapped);
  return { ok: true };
}

module.exports = {
  WRAPPED,
  wrapEnsure,
};
