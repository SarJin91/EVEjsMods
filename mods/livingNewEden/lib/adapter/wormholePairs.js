"use strict";

const EXPECTED_VERSION = 4;
const MAX_DETAIL_LENGTH = 200;

const REASON = Object.freeze({
  UNAVAILABLE: "WORMHOLE_STATE_UNAVAILABLE",
  DRIFT: "WORMHOLE_STATE_DRIFT",
  VERSION: "WORMHOLE_STATE_VERSION",
  TOO_LARGE: "WORMHOLE_STATE_TOO_LARGE",
  FAILED: "WORMHOLE_STATE_FAILED",
});

function refusal(reason, detail) {
  return Object.freeze({ ok: false, reason, ...(detail ? { detail: String(detail).slice(0, MAX_DETAIL_LENGTH) } : {}) });
}

function intOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function nonNegative(value) {
  return Math.max(0, intOf(value));
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function readWormholePairsFrom(stateExports, opts, configExports) {
  try {
    if (!isObject(stateExports) || typeof stateExports.getStateView !== "function") {
      return refusal(REASON.DRIFT, "getStateView");
    }
    if (stateExports.WORMHOLE_RUNTIME_VERSION !== EXPECTED_VERSION) {
      return refusal(REASON.VERSION, `WORMHOLE_RUNTIME_VERSION=${stateExports.WORMHOLE_RUNTIME_VERSION}`);
    }
    if (isObject(configExports) && configExports.wormholesEnabled !== true) {
      return Object.freeze({ ok: true, version: EXPECTED_VERSION, skipped: 0, pairs: Object.freeze([]),
        vendorDisabled: true });
    }
    const maxPairs = opts && opts.maxPairs;
    if (!Number.isSafeInteger(maxPairs) || maxPairs < 1) return refusal(REASON.FAILED, "maxPairs");
    const view = stateExports.getStateView();
    if (!isObject(view) || !isObject(view.pairsByID)) return refusal(REASON.DRIFT, "pairsByID");
    if (view.version !== undefined && view.version !== EXPECTED_VERSION) {
      return refusal(REASON.VERSION, `state.version=${view.version}`);
    }
    const keys = Object.keys(view.pairsByID);
    if (keys.length > maxPairs) return refusal(REASON.TOO_LARGE, `${keys.length}>${maxPairs}`);
    const pairs = [];
    let skipped = 0;
    for (const key of keys) {
      const pair = view.pairsByID[key];
      const source = isObject(pair) && isObject(pair.source) ? pair.source : null;
      const destination = isObject(pair) && isObject(pair.destination) ? pair.destination : null;
      const pairId = isObject(pair) ? intOf(pair.pairID) : 0;
      const fromSystemId = source ? intOf(source.systemID) : 0;
      const toSystemId = destination ? intOf(destination.systemID) : 0;
      if (pairId <= 0 || fromSystemId <= 0 || toSystemId <= 0) {
        skipped += 1;
        continue;
      }
      const createdAt = nonNegative(pair.createdAtMs);
      pairs.push(Object.freeze({
        pairKey: `${pairId}@${createdAt}`,
        pairId,
        fromSystemId,
        toSystemId,
        active: pair.state === "active",
        createdAt,
        expiresAt: nonNegative(pair.expiresAtMs),
        collapseAt: nonNegative(pair.collapseAtMs),
        maxJumpMass: nonNegative(pair.maxJumpMass),
      }));
    }
    return Object.freeze({ ok: true, version: EXPECTED_VERSION, skipped, pairs: Object.freeze(pairs),
      vendorDisabled: false });
  } catch (err) {
    return refusal(REASON.FAILED, (err && err.message) || err);
  }
}

module.exports = { REASON, EXPECTED_VERSION, readWormholePairsFrom };
