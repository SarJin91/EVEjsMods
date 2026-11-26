// Port with changes of X-Eve server/src/space/npc/ambientTraffic/livingEconomySalvage.js (MIT, see CREDITS.md).

"use strict";

const { effectivePool, claimShare } = require("../world/wreckPool");

const SALVAGE_KIND = "salvage";
const SALVAGE_OPERATION_TYPE = "salvage";
const SALVAGE_OBJECTIVE = "salvage";
const SALVAGE_ITEM_KIND = "supply";
const SALVAGE_ITEM_KEYS = Object.freeze({ salvage: "unit:salvage", loot: "unit:loot" });
const PARAM_NAMES = Object.freeze(["baseTravelMs", "perJumpTravelMs", "baseRecoveryMs", "perWreckRecoveryMs",
  "maxRecoveryMs"]);
const ACTION = Object.freeze({ RECOVER: "RECOVER", RETURN: "RETURN", DELIVER: "DELIVER", EXHAUST: "EXHAUST",
  FAIL: "FAIL" });

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v) => typeof v === "string" && v.length > 0;
const invalid = (detail) => ({ ok: false, reason: "SALVAGE_PLAN_INVALID", detail });

function checkParams(p) {
  if (!p || typeof p !== "object") return "params";
  for (const name of PARAM_NAMES) if (!isTime(p[name])) return name;
  return null;
}

function salvageTimes(params, spec) {
  const bad = checkParams(params);
  if (bad) return invalid(`params.${bad}`);
  if (!spec || !Number.isSafeInteger(spec.jumps) || spec.jumps < 0) return invalid("jumps");
  if (!isPositiveInt(spec.shipsLost)) return invalid("shipsLost");
  const travelMs = params.baseTravelMs + spec.jumps * params.perJumpTravelMs;
  const recoveryMs = Math.min(params.maxRecoveryMs, params.baseRecoveryMs + spec.shipsLost * params.perWreckRecoveryMs);
  if (!Number.isSafeInteger(travelMs) || !Number.isSafeInteger(recoveryMs)) return invalid("times");
  return { ok: true, travelMs, recoveryMs };
}

function planSalvageOutbound(spec, params) {
  if (!spec || typeof spec !== "object") return invalid("spec");
  if (!isText(spec.fieldId)) return invalid("fieldId");
  if (!isPositiveInt(spec.factionId)) return invalid("factionId");
  if (!isPositiveInt(spec.systemId)) return invalid("systemId");
  if (!isText(spec.homeStationId)) return invalid("homeStationId");
  if (!isPositiveInt(spec.homeSystemId)) return invalid("homeSystemId");
  if (!isTime(spec.at)) return invalid("at");
  const t = salvageTimes(params, spec);
  if (!t.ok) return t;
  const intent = Object.freeze({ type: "LAUNCH", kind: SALVAGE_KIND, operationType: SALVAGE_OPERATION_TYPE,
    objective: SALVAGE_OBJECTIVE, factionId: spec.factionId, originSystemId: spec.homeSystemId,
    target: Object.freeze({ kind: "system", systemId: spec.systemId, ref: spec.fieldId }),
    homeStationId: spec.homeStationId, fleets: Object.freeze([]), mobilize: Object.freeze([]),
    dueAt: spec.at + t.travelMs });
  return { ok: true, intent, travelMs: t.travelMs, recoveryMs: t.recoveryMs };
}

const fieldAlive = (field, at) => Boolean(field && field.state === "ACTIVE" && field.expiresAt > at);

function planSalvageRecovery(job, field, at) {
  if (!job || !isTime(job.recoveryMs) || !isTime(at)) return invalid("job/at");
  if (!fieldAlive(field, at)) return { ok: true, action: ACTION.EXHAUST, reason: "FIELD_GONE" };
  return { ok: true, action: ACTION.RECOVER, nextAt: at + job.recoveryMs };
}

function planSalvageReturn(job, field, at, claimPermille) {
  if (!job || !isTime(job.travelMs) || !isTime(at)) return invalid("job/at");
  const permille = claimPermille === undefined ? 1000 : claimPermille;
  if (!Number.isSafeInteger(permille) || permille < 0 || permille > 1000) return invalid("claimPermille");
  if (!fieldAlive(field, at)) return { ok: true, action: ACTION.EXHAUST, reason: "FIELD_GONE" };
  const pool = effectivePool(field, at);
  if (pool.expired || pool.total <= 0) return { ok: true, action: ACTION.EXHAUST, reason: "EMPTY" };
  const share = claimShare(field, at, permille);
  if (!share.ok) return invalid("claimPermille");
  if (share.empty) return { ok: true, action: ACTION.EXHAUST, reason: "EMPTY" };
  return { ok: true, action: ACTION.RETURN, nextAt: at + job.travelMs, haul: share.haul, salvaged: share.salvaged };
}

function planSalvageDelivery(job, station, maxQuantity) {
  if (!job || !isPositiveInt(job.factionId) || !isPositiveInt(maxQuantity)) return invalid("job/maxQuantity");
  if (!station || station.ownerFactionId !== job.factionId || station.state === "DESTROYED") {
    return { ok: true, action: ACTION.FAIL, reason: "HOME_LOST" };
  }
  const deltas = [];
  if (job.lootUnits > 0) {
    deltas.push({ itemKind: SALVAGE_ITEM_KIND, itemKey: SALVAGE_ITEM_KEYS.loot,
      delta: Math.min(job.lootUnits, maxQuantity) });
  }
  if (job.salvageUnits > 0) {
    deltas.push({ itemKind: SALVAGE_ITEM_KIND, itemKey: SALVAGE_ITEM_KEYS.salvage,
      delta: Math.min(job.salvageUnits, maxQuantity) });
  }
  return { ok: true, action: ACTION.DELIVER, deltas,
    units: deltas.reduce((sum, d) => sum + d.delta, 0) };
}

module.exports = {
  SALVAGE_KIND,
  SALVAGE_OPERATION_TYPE,
  SALVAGE_OBJECTIVE,
  SALVAGE_ITEM_KIND,
  SALVAGE_ITEM_KEYS,
  PARAM_NAMES,
  ACTION,
  checkParams,
  salvageTimes,
  planSalvageOutbound,
  planSalvageRecovery,
  planSalvageReturn,
  planSalvageDelivery,
};
