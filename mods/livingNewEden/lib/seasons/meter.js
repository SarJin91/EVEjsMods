"use strict";

const { OUTCOME } = require("./schema");

function deltaOf(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : 0;
}

function addSafe(a, b) {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b);
}

function applyDeltas(row, d) {
  const delta = d || {};
  return { meterDefense: addSafe(deltaOf(row.meterDefense), deltaOf(delta.defense)),
    meterCrisis: addSafe(deltaOf(row.meterCrisis), deltaOf(delta.crisis)) };
}

function outcomeOf(d, c, winRatioPermille) {
  if (d === 0 && c === 0) return OUTCOME.DRAW;
  return d * 1000 >= c * winRatioPermille ? OUTCOME.WON : OUTCOME.LOST;
}

module.exports = { applyDeltas, outcomeOf };
