"use strict";

const PERMILLE = 1000;
const MILLI_PERMILLE = PERMILLE * PERMILLE;

const isPositive = (v) => Number.isSafeInteger(v) && v > 0;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function scaledIsk(milli, factor) {
  const q = Math.floor(milli / MILLI_PERMILLE);
  const r = milli % MILLI_PERMILLE;
  return q * factor + Math.floor((r * factor) / MILLI_PERMILLE);
}

function createHullValueTable(recipeTable, prices, factors) {
  if (!recipeTable || typeof recipeTable.lookup !== "function" || !Array.isArray(recipeTable.groups)) {
    throw new TypeError("hullValues: recipeTable");
  }
  if (!prices || typeof prices !== "object") throw new TypeError("hullValues: prices");
  const f = factors || {};
  const values = new Map();
  for (const g of recipeTable.groups) {
    const row = recipeTable.lookup(g);
    if (!row || !row.minerals || typeof row.minerals !== "object") throw new TypeError(`hullValues: ${g}`);
    const factor = hasOwn(f, g) ? f[g] : PERMILLE;
    if (!isPositive(factor)) throw new TypeError(`hullValues: factor ${g}`);
    let milli = 0;
    for (const k of Object.keys(row.minerals).sort()) {
      if (!hasOwn(prices, k) || !isPositive(prices[k])) throw new TypeError(`hullValues: price ${k}`);
      milli += row.minerals[k] * prices[k];
    }
    const value = scaledIsk(milli, factor);
    if (!Number.isSafeInteger(milli) || !Number.isSafeInteger(value)) throw new TypeError(`hullValues: ${g} overflow`);
    values.set(g, value);
  }
  const all = Object.freeze(Object.fromEntries(values));
  return Object.freeze({
    version: `r${recipeTable.version}`,
    valueOf: (g) => (values.has(g) ? values.get(g) : null),
    all: () => all,
  });
}

module.exports = { createHullValueTable };
