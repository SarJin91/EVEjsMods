"use strict";

function buildPowerTable(groups) {
  const out = {};
  for (const [group, g] of Object.entries(groups || {})) {
    const offense = Math.max((Number(g.dps) || 0) * (Number(g.applicationFactor) || 0), Number(g.remoteRepPerSec) || 0,
      1);
    const raw = Math.sqrt(offense * Math.max(0, Number(g.ehp) || 0));
    const permille = g.powerPermille;
    out[group] = Number.isSafeInteger(permille) && permille > 0 && permille !== 1000
      ? Math.round(raw * permille / 1000)
      : Math.round(raw);
  }
  return Object.freeze(out);
}

function strengthOf(composition, table) {
  let sum = 0;
  for (const e of composition || []) {
    const power = table[e.hullGroup];
    if (Number.isSafeInteger(power) && Number.isSafeInteger(e.count) && e.count > 0) sum += power * e.count;
  }
  return sum;
}

function garrisonPowerOf(points, powerPerPoint) {
  const p = Number.isFinite(points) && points > 0 ? points : 0;
  const k = Number.isFinite(powerPerPoint) && powerPerPoint > 0 ? powerPerPoint : 0;
  return Math.round(p * k);
}

module.exports = { buildPowerTable, strengthOf, garrisonPowerOf };
