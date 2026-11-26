"use strict";

const CONTRABAND = Object.freeze([
  Object.freeze({ typeId: 3703, min: 2, max: 6 }),
  Object.freeze({ typeId: 3705, min: 2, max: 6 }),
  Object.freeze({ typeId: 3707, min: 2, max: 6 }),
  Object.freeze({ typeId: 3709, min: 2, max: 6 }),
  Object.freeze({ typeId: 3711, min: 1, max: 3 }),
  Object.freeze({ typeId: 3713, min: 1, max: 4 }),
  Object.freeze({ typeId: 3818, min: 1, max: 3 }),
  Object.freeze({ typeId: 3820, min: 1, max: 3 }),
  Object.freeze({ typeId: 3822, min: 2, max: 6 }),
  Object.freeze({ typeId: 3824, min: 1, max: 4 }),
  Object.freeze({ typeId: 3826, min: 2, max: 6 }),
  Object.freeze({ typeId: 28670, min: 1, max: 2 }),
  Object.freeze({ typeId: 28672, min: 1, max: 2 }),
  Object.freeze({ typeId: 28674, min: 1, max: 2 }),
  Object.freeze({ typeId: 28676, min: 1, max: 2 }),
  Object.freeze({ typeId: 28678, min: 1, max: 2 }),
]);

const LEVEL_LOOT_ROLLS = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4 });
const SMUGGLER_MULTIPLIER = 3;
const OFFICER_LOOT_MIN_LEVEL = 5;

module.exports = { CONTRABAND, LEVEL_LOOT_ROLLS, SMUGGLER_MULTIPLIER, OFFICER_LOOT_MIN_LEVEL };
