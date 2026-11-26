"use strict";

const SIDE_A = "A";
const SIDE_B = "B";

const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;

function structureOf(input) {
  if (!input || typeof input !== "object" || !isPositiveId(input.structureId)) return null;
  if (!isPositiveId(input.structureTypeId)) return null;
  if (input.structureSide !== SIDE_A && input.structureSide !== SIDE_B) return null;
  return { structureId: input.structureId, structureTypeId: input.structureTypeId, side: input.structureSide };
}

function withStructureOutcome(result, input, structure) {
  const s = structureOf(input);
  if (s === null) return result;
  const destroyed = Boolean(structure && structure.destroyed === true);
  let objectiveAchieved = result.objectiveAchieved;
  if (destroyed) objectiveAchieved = s.side === SIDE_B;
  return { ...result, objectiveAchieved, structureDestroyed: destroyed, structureId: s.structureId,
    structureTypeId: s.structureTypeId };
}

module.exports = { structureOf, withStructureOutcome };
