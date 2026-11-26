"use strict";

const { RECON_LOSS_ROLES } = require("./schema");

const NAME = "reconLoss";
const DESTROYED = "DESTROYED";
const SIDE_NAMES = Object.freeze(["A", "B"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function inputProblem(settled) {
  if (!isPlainObject(settled)) return "settled";
  if (!isId(settled.systemId)) return "systemId";
  if (!isTime(settled.at)) return "at";
  if (!Array.isArray(settled.fleets)) return "fleets";
  for (const f of settled.fleets) {
    if (!isPlainObject(f) || typeof f.fleetId !== "string" || !SIDE_NAMES.includes(f.side)
      || typeof f.disposition !== "string") return "fleets[]";
  }
  if (!isPlainObject(settled.sides)) return "sides";
  for (const s of SIDE_NAMES) if (!isPlainObject(settled.sides[s]) || !isId(settled.sides[s].factionId)) return "sides";
  return null;
}

function createReconLossConsequence(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createReconLossConsequence: deps missing");
  const { reconLossRepository, fleetRepository, registry } = deps;
  if (!reconLossRepository || typeof reconLossRepository.recordLossInTx !== "function") {
    throw new TypeError("createReconLossConsequence: reconLossRepository required");
  }
  if (!fleetRepository || typeof fleetRepository.getFleets !== "function") {
    throw new TypeError("createReconLossConsequence: fleetRepository required");
  }
  if (!registry || typeof registry.getFaction !== "function") {
    throw new TypeError("createReconLossConsequence: registry required");
  }

  function applyIn(tx, settled, ck) {
    const problem = inputProblem(settled);
    if (problem !== null || typeof ck !== "string" || ck.length < 1) {
      return { ok: false, reason: "RECON_LOSS_INPUT_INVALID", detail: problem || "ck" };
    }
    let recorded = 0;
    let skipped = 0;
    for (const side of SIDE_NAMES) {
      const factionId = settled.sides[side].factionId;
      if (registry.getFaction(factionId) === null
        || (typeof registry.isActive === "function" && registry.isActive(factionId) !== true)) continue;
      const dead = settled.fleets.filter((f) => f.side === side && f.disposition === DESTROYED);
      if (dead.length === 0) continue;
      const read = fleetRepository.getFleets(tx, dead.map((f) => f.fleetId));
      if (!read || read.ok !== true) return { ok: false, reason: (read && read.reason) || "FLEETS_READ_FAILED" };
      const lostFleets = read.fleets.filter((x) => RECON_LOSS_ROLES.includes(x.fleetRole)).length;
      if (lostFleets === 0) continue;
      const r = reconLossRepository.recordLossInTx(tx, { factionId, systemId: settled.systemId, at: settled.at,
        lostFleets }, `${ck}:recon:f:${factionId}`);
      if (r && r.ok === true) {
        if (r.duplicate !== true) recorded += 1;
        continue;
      }
      if (r && r.reason === "RECON_LOSS_LIMIT") {
        skipped += 1;
        continue;
      }
      return { ok: false, reason: (r && r.reason) || "RECON_LOSS_WRITE_FAILED" };
    }
    return { ok: true, recorded, skipped };
  }

  return Object.freeze({ name: NAME, apply(tx, settled, ck) {
    try {
      return applyIn(tx, settled, ck);
    } catch (err) {
      return { ok: false, reason: "RECON_LOSS_THREW", detail: String((err && err.message) || err).slice(0, 200) };
    }
  } });
}

module.exports = { createReconLossConsequence };
