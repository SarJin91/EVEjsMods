"use strict";

const PERMILLE = 1000;

function effectiveFactorPermille(rowFactor, params) {
  if (!Number.isSafeInteger(rowFactor) || rowFactor < PERMILLE) return null;
  const weighted = PERMILLE + Math.floor(((rowFactor - PERMILLE) * params.componentWeightPermille) / PERMILLE);
  return Math.min(params.componentFactorMaxPermille, weighted);
}

module.exports = { effectiveFactorPermille };
