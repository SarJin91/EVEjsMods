"use strict";

const { settleRowsBound, taleSystemIdsOf } = require("../nativeIncursions/consequence");
const N = require("../nativeIncursions/schema");

const MILLI = 1000;

function holdPointsOf(points, strengthMilli) {
  if (!Number.isSafeInteger(points) || points <= 0) return 0;
  const s = Number.isSafeInteger(strengthMilli) && strengthMilli >= 0 && strengthMilli <= MILLI ? strengthMilli : MILLI;
  return Math.max(1, Math.ceil((points * s) / MILLI));
}

function systemIdsOfRow(systems) {
  const list = Array.isArray(systems) ? systems : [];
  return taleSystemIdsOf(list.map((s) => (s && typeof s === "object" ? s.systemId : null)), N.MAX_TALE_SYSTEMS);
}

function settleTxRowsBound(maxFactionsPerSystem, poolParticipants) {
  const F = Number.isSafeInteger(maxFactionsPerSystem) && maxFactionsPerSystem > 0 ? maxFactionsPerSystem : 0;
  const pool = Number.isSafeInteger(poolParticipants) && poolParticipants > 0 ? poolParticipants : 0;
  return settleRowsBound(F, N.MAX_TALE_SYSTEMS) + pool;
}

module.exports = { holdPointsOf, systemIdsOfRow, settleTxRowsBound };
