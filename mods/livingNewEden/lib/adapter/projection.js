"use strict";

const WRAPPED = Symbol.for("livingNewEden.projectionWrapped");

const REASON_PROJECTED = "CONTROLLER_PIRATE";
const REASON_FAILED = "FAILED";
const READ_PREFIX = "READ_";
const READ_NOT_FAILURES = Object.freeze(["READ_WORLD_UNAVAILABLE", "READ_WORLD_DISABLED"]);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isFailure(reason) {
  return reason === REASON_FAILED
    || (typeof reason === "string" && reason.startsWith(READ_PREFIX) && !READ_NOT_FAILURES.includes(reason));
}

function projectFactionKey(systemId, options, deps) {
  if (options !== null && typeof options === "object"
    && typeof options.factionKey === "string" && options.factionKey.length > 0) {
    return { key: null, reason: "EXPLICIT_OVERRIDE" };
  }
  const id = Math.trunc(Number(systemId));
  if (!Number.isSafeInteger(id) || id <= 0) return { key: null, reason: "BAD_SYSTEM_ID" };
  const read = deps.readController(id);
  if (!read || read.ok !== true) {
    return { key: null, reason: `${READ_PREFIX}${(read && read.reason) || "NO_RESULT"}` };
  }
  const controller = read.controllerFactionId;
  if (controller === null || controller === undefined) return { key: null, reason: "NO_CONTROLLER" };
  const pirateTable = deps.pirateKeyByFactionId;
  const field = String(controller);
  if (hasOwn(pirateTable, field) && typeof pirateTable[field] === "string" && pirateTable[field].length > 0) {
    return { key: pirateTable[field], reason: REASON_PROJECTED };
  }
  return { key: null, reason: "NOT_PIRATE" };
}

function wrapPirateFactionKey(originalFn, deps) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[WRAPPED] === true) return { ok: true, wrapped: originalFn, noop: true };
  const d = deps || {};
  const table = d.pirateKeyByFactionId;
  if (table === null || typeof table !== "object") return { ok: false, reason: "PIRATE_TABLE_INVALID" };
  if (typeof d.readController !== "function") return { ok: false, reason: "READ_CONTROLLER_NOT_A_FUNCTION" };
  const onOutcome = typeof d.onOutcome === "function" ? d.onOutcome : null;
  const decisionDeps = Object.freeze({ pirateKeyByFactionId: table, readController: d.readController });

  function livingNewEdenProjectedPirateFactionKey(systemID, options) {
    let decision;
    try {
      decision = projectFactionKey(systemID, options, decisionDeps);
    } catch (_err) {
      decision = { key: null, reason: REASON_FAILED };
    }
    if (onOutcome) {
      try {
        onOutcome(decision.key ? "projected" : (isFailure(decision.reason) ? "failed" : "vendor"), decision.reason);
      } catch (_err) {
      }
    }
    if (decision.key) return decision.key;
    return originalFn.apply(this, arguments);
  }

  livingNewEdenProjectedPirateFactionKey[WRAPPED] = true;
  return { ok: true, wrapped: livingNewEdenProjectedPirateFactionKey };
}

module.exports = { wrapPirateFactionKey, projectFactionKey, isFailure, WRAPPED, REASON_PROJECTED };
