"use strict";

const { MEMBER_STATE } = require("./schema");

const PERMILLE = 1000;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

function fleetPowerOf(grid, cfg) {
  const players = grid && isCount(grid.players) ? grid.players : 0;
  const copies = grid && isCount(grid.copies) ? grid.copies : 0;
  const weight = cfg && isCount(cfg.copyWeightPermille) ? cfg.copyWeightPermille : 0;
  return players + (copies * weight) / PERMILLE;
}

function scaleStepsOf(power, tierDef, prevSteps, cfg) {
  const cap = cfg && isCount(cfg.maxUpscaleSteps) ? cfg.maxUpscaleSteps : 0;
  const prev = isCount(prevSteps) ? Math.min(prevSteps, cap) : 0;
  const per = cfg && Number.isSafeInteger(cfg.shipsPerUpscaleStep) && cfg.shipsPerUpscaleStep > 0
    ? cfg.shipsPerUpscaleStep : null;
  if (per === null || !tierDef || !isCount(tierDef.fleetSize) || typeof power !== "number" || !Number.isFinite(power)) {
    return prev;
  }
  const wanted = Math.ceil(Math.max(0, power - tierDef.fleetSize) / per);
  return Math.min(cap, Math.max(prev, wanted));
}

function membersOfRow(row) {
  if (!row) return [];
  if (Array.isArray(row.members)) return row.members;
  const text = typeof row.membersJson === "string" ? row.membersJson : row.members_json;
  if (typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

function membersOfPhase(row, phase, steps) {
  const unlocked = isCount(steps) ? steps : 0;
  return membersOfRow(row).filter((m) => m && m.state === MEMBER_STATE.RESERVED
    && (m.phase === phase || (m.phase === null && Number.isSafeInteger(m.step) && m.step >= 1 && m.step <= unlocked)));
}

module.exports = { fleetPowerOf, scaleStepsOf, membersOfPhase, membersOfRow };
