"use strict";

const { createRng } = require("../util/rng");
const { DAY_MS, KEY_PREFIX, SOURCE_KEY_PART } = require("./schema");

const PERMILLE = 1000;

function rollHit(seed, permille) {
  const p = Number(permille);
  if (!(p > 0)) return false;
  if (p >= PERMILLE) return true;
  return createRng(seed).nextFloat() * PERMILLE < p;
}

function dayOf(nowMs) {
  return Math.floor(Number(nowMs) / DAY_MS);
}

function officerKeyOf(day, systemId, source, sourceId) {
  return `${KEY_PREFIX}:${day}:${systemId}:${source}:${sourceId}`;
}

function sourceKeyOf(source, sourceId) {
  return `${KEY_PREFIX}:${SOURCE_KEY_PART}:${source}:${sourceId}`;
}

function systemRangeOf(day, systemId) {
  const prefix = `${KEY_PREFIX}:${day}:${systemId}`;
  return [`${prefix}:`, `${prefix};`];
}

function dayRangeOf(day) {
  const prefix = `${KEY_PREFIX}:${day}`;
  return [`${prefix}:`, `${prefix};`];
}

module.exports = { rollHit, dayOf, officerKeyOf, sourceKeyOf, systemRangeOf, dayRangeOf };
