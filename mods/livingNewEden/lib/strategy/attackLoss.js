"use strict";

const { ATTACK_LOSS_OPERATION_TYPES } = require("./schema");

const NAME = "attackLoss";
const SIDE_NAMES = Object.freeze(["A", "B"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function inputProblem(settled) {
  if (!isPlainObject(settled)) return "settled";
  if (!isId(settled.systemId)) return "systemId";
  if (!isTime(settled.at)) return "at";
  if (settled.winnerSide !== null && !SIDE_NAMES.includes(settled.winnerSide)) return "winnerSide";
  if (!Array.isArray(settled.fleets)) return "fleets";
  for (const f of settled.fleets) {
    if (!isPlainObject(f) || typeof f.fleetId !== "string" || !SIDE_NAMES.includes(f.side)) return "fleets[]";
  }
  if (!isPlainObject(settled.sides)) return "sides";
  for (const s of SIDE_NAMES) if (!isPlainObject(settled.sides[s]) || !isId(settled.sides[s].factionId)) return "sides";
  return null;
}

function createAttackLossConsequence(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createAttackLossConsequence: deps missing");
  const { attackLossRepository, fleetRepository, registry } = deps;
  if (!attackLossRepository || typeof attackLossRepository.recordLossInTx !== "function") {
    throw new TypeError("createAttackLossConsequence: attackLossRepository required");
  }
  if (!fleetRepository || typeof fleetRepository.getFleets !== "function"
    || typeof fleetRepository.getOperation !== "function") {
    throw new TypeError("createAttackLossConsequence: fleetRepository with getFleets and getOperation required");
  }
  if (!registry || typeof registry.getFaction !== "function") {
    throw new TypeError("createAttackLossConsequence: registry required");
  }

  function isRaid(tx, operationIds, systemId) {
    for (const id of operationIds) {
      const r = fleetRepository.getOperation(tx, id);
      if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "OPERATION_READ_FAILED" };
      const op = r.operation;
      if (op && ATTACK_LOSS_OPERATION_TYPES.includes(op.operationType) && op.targetSystemId === systemId) {
        return { ok: true, raid: true };
      }
    }
    return { ok: true, raid: false };
  }

  function applyIn(tx, settled, ck) {
    const problem = inputProblem(settled);
    if (problem !== null || typeof ck !== "string" || ck.length < 1) {
      return { ok: false, reason: "ATTACK_LOSS_INPUT_INVALID", detail: problem || "ck" };
    }
    if (settled.winnerSide === null) return { ok: true, recorded: 0, skipped: 0 };
    const loser = settled.winnerSide === "A" ? "B" : "A";
    const factionId = settled.sides[loser].factionId;
    if (registry.getFaction(factionId) === null
      || (typeof registry.isActive === "function" && registry.isActive(factionId) !== true)) {
      return { ok: true, recorded: 0, skipped: 0 };
    }
    const ids = settled.fleets.filter((f) => f.side === loser).map((f) => f.fleetId);
    if (ids.length === 0) return { ok: true, recorded: 0, skipped: 0 };
    const read = fleetRepository.getFleets(tx, ids);
    if (!read || read.ok !== true) return { ok: false, reason: (read && read.reason) || "FLEETS_READ_FAILED" };
    const operationIds = [...new Set(read.fleets.map((x) => x.operationId).filter((x) => typeof x === "string"))]
      .sort();
    if (operationIds.length === 0) return { ok: true, recorded: 0, skipped: 0 };
    const raid = isRaid(tx, operationIds, settled.systemId);
    if (raid.ok !== true) return raid;
    if (raid.raid !== true) return { ok: true, recorded: 0, skipped: 0 };
    const r = attackLossRepository.recordLossInTx(tx, { factionId, systemId: settled.systemId, at: settled.at,
      lostAttacks: 1 }, `${ck}:attack:f:${factionId}`);
    if (r && r.ok === true) return { ok: true, recorded: r.duplicate === true ? 0 : 1, skipped: 0 };
    if (r && r.reason === "ATTACK_LOSS_LIMIT") return { ok: true, recorded: 0, skipped: 1 };
    return { ok: false, reason: (r && r.reason) || "ATTACK_LOSS_WRITE_FAILED" };
  }

  return Object.freeze({ name: NAME, apply(tx, settled, ck) {
    try {
      return applyIn(tx, settled, ck);
    } catch (err) {
      return { ok: false, reason: "ATTACK_LOSS_THREW", detail: String((err && err.message) || err).slice(0, 200) };
    }
  } });
}

module.exports = { createAttackLossConsequence };
