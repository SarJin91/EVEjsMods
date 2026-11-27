"use strict";

const WRAPPED = Symbol.for("evejs.sharedStorePerfFix.mirrorSkip.wrapped");
const STATS_SYMBOL = "evejs.sharedStorePerfFix.mirrorSkip";
const ACTIVE_SELF_DESTRUCT_STATES = new Set(["countdown", "prepared"]);
const VENDOR_FUNCTIONS = Object.freeze(["upsertStructureRecord", "getStructureByID", "getStructureSelfDestructRecord"]);

function isMirrorRecord(record) {
  return Boolean(
    record &&
    typeof record === "object" &&
    record.devFlags &&
    typeof record.devFlags === "object" &&
    record.devFlags.sovereigntyMirror === true,
  );
}

function definedKeys(value) {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameValue(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = definedKeys(left);
  if (leftKeys.length !== definedKeys(right).length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !sameValue(left[key], right[key])) return false;
  }
  return true;
}

function planMirrorUpsert(record, options, vendor) {
  if (!isMirrorRecord(record)) return { action: "pass", reason: "notMirror", record };
  if (options && options.durable === true) return { action: "pass", reason: "durable", record };
  const next = vendor.normalize(record);
  const structureID = next && next.structureID;
  if (!Number.isSafeInteger(structureID) || structureID <= 0) return { action: "pass", reason: "noStructureID", record };
  const existing = vendor.getExisting(structureID);
  if (!existing || typeof existing !== "object") return { action: "pass", reason: "new", record };
  if (existing.state !== next.state) return { action: "pass", reason: "stateChanged", record };

  const kept = { ...record, stateStartedAt: existing.stateStartedAt };
  const receipt = vendor.selfDestructReceipt(structureID);
  if (receipt && ACTIVE_SELF_DESTRUCT_STATES.has(receipt.state)) {
    return { action: "write", reason: "selfDestruct", record: kept };
  }
  const candidate = vendor.normalize(kept);
  if (!candidate.jumpBridgeCapacitor && existing.jumpBridgeCapacitor) {
    candidate.jumpBridgeCapacitor = structuredClone(existing.jumpBridgeCapacitor);
  }
  if (!sameValue(candidate, existing)) return { action: "write", reason: "changed", record: kept };
  return { action: "skip", reason: "unchanged", record: kept, data: candidate };
}

function vendorAccess(exports) {
  return {
    normalize: (record) => exports._testing.normalizeStructureRecord(record),
    getExisting: (structureID) => exports.getStructureByID(structureID, { refresh: false }),
    selfDestructReceipt: (structureID) => exports.getStructureSelfDestructRecord(structureID),
  };
}

function missingVendorFunction(exports) {
  for (const name of VENDOR_FUNCTIONS) {
    if (typeof exports[name] !== "function") return `structureState.${name}`;
  }
  if (!exports._testing || typeof exports._testing.normalizeStructureRecord !== "function") {
    return "structureState._testing.normalizeStructureRecord";
  }
  return null;
}

function createMirrorSkip({ logErrorFn = () => {}, publish = true } = {}) {
  const stats = { skipped: 0, written: 0, keptStartedAt: 0, errors: 0, drift: 0 };
  const state = { wrapped: false, inert: false };
  if (publish) globalThis[Symbol.for(STATS_SYMBOL)] = stats;

  function drift(detail) {
    state.inert = true;
    stats.drift += 1;
    logErrorFn(`DRIFT ${detail} - sovereignty mirror writes stay as vanilla`);
  }

  function wrapExports(exports) {
    if (state.wrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (!exports || typeof exports !== "object") return { ok: false, reason: "pending" };
    const missing = missingVendorFunction(exports);
    if (missing) {
      if (Object.keys(exports).length === 0) return { ok: false, reason: "pending" };
      drift(missing);
      return { ok: false, reason: "drift" };
    }
    const previous = exports.upsertStructureRecord;
    if (previous[WRAPPED]) {
      state.wrapped = true;
      return { ok: true };
    }
    const vendor = vendorAccess(exports);
    const wrapped = function upsertStructureRecord(record) {
      let plan = null;
      try {
        plan = planMirrorUpsert(record, arguments[1], vendor);
      } catch (error) {
        stats.errors += 1;
        if (stats.errors === 1) logErrorFn(`mirror write check failed - write passes through (${String(error && error.message)})`);
      }
      if (!plan || plan.action === "pass") return previous.apply(this, arguments);
      if (plan.action === "skip") {
        stats.skipped += 1;
        return { success: true, data: plan.data };
      }
      stats.written += 1;
      if (plan.record.stateStartedAt !== record.stateStartedAt) stats.keptStartedAt += 1;
      const args = Array.from(arguments);
      args[0] = plan.record;
      return previous.apply(this, args);
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    exports.upsertStructureRecord = wrapped;
    state.wrapped = true;
    return { ok: true };
  }

  return { state, stats, wrapExports };
}

module.exports = {
  STATS_SYMBOL,
  WRAPPED,
  createMirrorSkip,
  isMirrorRecord,
  planMirrorUpsert,
  sameValue,
};
