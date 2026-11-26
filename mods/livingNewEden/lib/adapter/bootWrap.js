"use strict";

const WRAPPED = Symbol.for("livingNewEden.wrapped");

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

function wrapBootWorld(exportsObject, handlers) {
  if (exportsObject === null || typeof exportsObject !== "object"
    || !Object.prototype.hasOwnProperty.call(exportsObject, "bootWorld")
    || typeof exportsObject.bootWorld !== "function") {
    return { ok: false, reason: "boot_world_missing" };
  }
  const original = exportsObject.bootWorld;
  if (original[WRAPPED] === true) return { ok: false, reason: "already_wrapped" };

  function safe(label, fn) {
    return (...args) => {
      try {
        fn(...args);
      } catch (err) {
        try {
          handlers.onHandlerError(`${label} handler failed`, err);
        } catch (_ignored) {
        }
      }
    };
  }

  const onBooted = safe("boot", handlers.onBooted);
  const onBootFailed = safe("boot failure", handlers.onBootFailed);

  function livingNewEdenBootWorld() {
    const result = original.apply(this, arguments);
    if (!isThenable(result)) {
      onBootFailed("boot_not_promise");
      return result;
    }
    try {
      result.then(onBooted, (err) => onBootFailed(`boot_rejected: ${(err && err.message) || err}`, err));
    } catch (err) {
      onBootFailed("boot_then_failed", err);
    }
    return result;
  }

  for (const symbol of Object.getOwnPropertySymbols(original)) {
    try {
      livingNewEdenBootWorld[symbol] = original[symbol];
    } catch (_ignored) {
    }
  }
  livingNewEdenBootWorld[WRAPPED] = true;

  try {
    exportsObject.bootWorld = livingNewEdenBootWorld;
  } catch (_err) {
    return { ok: false, reason: "assign_failed" };
  }
  if (exportsObject.bootWorld !== livingNewEdenBootWorld) return { ok: false, reason: "assign_failed" };
  return { ok: true, reason: null };
}

module.exports = { WRAPPED, wrapBootWorld };
