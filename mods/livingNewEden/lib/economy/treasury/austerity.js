"use strict";

const MAX_ISK = 1e15;
const PERMILLE = 1000;
const NORMAL = "NORMAL";
const AUSTERITY = "AUSTERITY";

const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function permilleOf(value, permille) {
  const v = count(value);
  const p = count(permille);
  return Math.floor(v / PERMILLE) * p + Math.floor(((v % PERMILLE) * p) / PERMILLE);
}

function feeOf(runs, value, permille) {
  return permilleOf(Math.min(MAX_ISK, count(runs) * count(value)), permille);
}

function thresholdsOf(initialIsk, enterPermille, exitPermille) {
  const enterIsk = permilleOf(initialIsk, enterPermille);
  return { enterIsk, exitIsk: Math.max(enterIsk, permilleOf(initialIsk, exitPermille)) };
}

function nextMode(mode, balanceAfter, th) {
  if (mode === NORMAL && balanceAfter < th.enterIsk) return AUSTERITY;
  if (mode === AUSTERITY && balanceAfter >= th.exitIsk) return NORMAL;
  return mode;
}

module.exports = { permilleOf, feeOf, thresholdsOf, nextMode, NORMAL, AUSTERITY };
