"use strict";

const SYMBOL_NAME = "observeRuntimeTickSample";
const WRAPPED = Symbol.for("livingNewEden.tickSampleWrap");

function toFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

function orZero(value) {
  return Number.isNaN(value) ? 0 : value;
}

function normalizeTickSample(sample) {
  if (sample === null || typeof sample !== "object") return null;
  const intervalMs = toFiniteNumber(sample.actualIntervalMs);
  const workMs = toFiniteNumber(sample.tickDurationMs);
  const latenessMs = toFiniteNumber(sample.latenessMs);
  if (Number.isNaN(intervalMs) || Number.isNaN(workMs) || Number.isNaN(latenessMs)) return null;
  return {
    intervalMs,
    workMs,
    latenessMs,
    sceneCount: orZero(toFiniteNumber(sample.sceneCount)),
    tickedSceneCount: orZero(toFiniteNumber(sample.tickedSceneCount)),
    atMs: toFiniteNumber(sample.startedAtMonotonicMs),
  };
}

function wrapTickSample(exportsObject, onSample) {
  if (exportsObject === null || typeof exportsObject !== "object" || typeof onSample !== "function") {
    return { ok: false, reason: "tick_symbol_missing" };
  }
  const descriptor = Object.getOwnPropertyDescriptor(exportsObject, SYMBOL_NAME);
  if (!descriptor) return { ok: false, reason: "tick_symbol_missing" };
  if (descriptor.get || descriptor.set) return { ok: false, reason: "tick_symbol_not_writable" };
  if (typeof descriptor.value !== "function") return { ok: false, reason: "tick_symbol_missing" };
  if (descriptor.writable !== true || descriptor.configurable !== true) {
    return { ok: false, reason: "tick_symbol_not_writable" };
  }
  const previous = descriptor.value;
  if (previous[WRAPPED] === true || exportsObject[WRAPPED] === true) return { ok: false, reason: "already_wrapped" };

  let active = true;
  let errors = 0;
  function livingNewEdenObserveRuntimeTickSample(sample) {
    if (active) {
      try {
        const normalized = normalizeTickSample(sample);
        if (normalized) onSample(normalized);
      } catch (_err) {
        errors += 1;
      }
    }
    return previous.apply(this, arguments);
  }
  Object.defineProperty(livingNewEdenObserveRuntimeTickSample, WRAPPED, { value: true });
  Object.defineProperty(exportsObject, WRAPPED, { value: true, configurable: true, enumerable: false, writable: true });
  exportsObject[SYMBOL_NAME] = livingNewEdenObserveRuntimeTickSample;

  function unwrap() {
    if (!active) return;
    active = false;
    if (exportsObject[SYMBOL_NAME] === livingNewEdenObserveRuntimeTickSample) {
      exportsObject[SYMBOL_NAME] = previous;
      delete exportsObject[WRAPPED];
    }
  }

  return { ok: true, unwrap, errors: () => errors };
}

module.exports = { SYMBOL_NAME, WRAPPED, normalizeTickSample, wrapTickSample };
