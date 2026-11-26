"use strict";

const WRAPPED = Symbol.for("livingNewEden.scanObservationWrapped");
const MAX_DETAIL = 120;

let frontJobsScan = null;
let scanWrapMounted = false;

const listenerOf = (l) => (l && typeof l.onPerfectScan === "function" ? l : null);

function setFrontJobsScan(l) {
  frontJobsScan = listenerOf(l);
}

function getFrontJobsScan() {
  return frontJobsScan;
}

function setScanWrapMounted(mounted) {
  scanWrapMounted = mounted === true;
}

function isScanWrapMounted() {
  return scanWrapMounted;
}

const toPositiveInt = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function observeScan(result, systemID, options, deps) {
  let listener = null;
  try {
    listener = typeof deps.getFrontJobsScan === "function" ? listenerOf(deps.getFrontJobsScan()) : null;
  } catch (_err) {
    listener = null;
  }
  if (listener === null) return { skipped: "NO_HANDLER" };
  const perfect = result && Array.isArray(result.perfectSignatureIDs) ? result.perfectSignatureIDs : [];
  const signatureIds = perfect.filter((id) => typeof id === "string" && id !== "");
  if (signatureIds.length === 0) return { skipped: "NO_PERFECT" };
  const characterId = toPositiveInt(options && options.characterID);
  if (!characterId) return { skipped: "NO_CHARACTER" };
  const systemId = toPositiveInt(systemID) || toPositiveInt(result && result.systemID);
  if (!systemId) return { skipped: "NO_SYSTEM" };
  const atMs = Math.trunc(Number(typeof deps.now === "function" ? deps.now() : NaN));
  if (!Number.isSafeInteger(atMs) || atMs < 0) return { skipped: "NO_TIME" };
  try {
    return { result: listener.onPerfectScan({ characterId, systemId, atMs, signatureIds }) };
  } catch (err) {
    return { result: { ok: false, reason: "LISTENER_THREW", detail: String((err && err.message) || err)
      .slice(0, MAX_DETAIL) } };
  }
}

function wrapSignatureScanResults(originalFn, opts = {}) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[WRAPPED] === true) return { ok: true, wrapped: originalFn, noop: true };
  const deps = {
    getFrontJobsScan: typeof opts.getFrontJobsScan === "function" ? opts.getFrontJobsScan : getFrontJobsScan,
    now: typeof opts.now === "function" ? opts.now : () => Date.now(),
  };
  const wrapped = function livingNewEdenObservedSignatureScan(systemID, rawProbes, options) {
    const result = originalFn.apply(this, arguments);
    try {
      observeScan(result, systemID, options, deps);
    } catch (_err) {
    }
    return result;
  };
  wrapped[WRAPPED] = true;
  return { ok: true, wrapped };
}

module.exports = { wrapSignatureScanResults, observeScan, setFrontJobsScan, getFrontJobsScan, setScanWrapMounted,
  isScanWrapMounted, WRAPPED };
