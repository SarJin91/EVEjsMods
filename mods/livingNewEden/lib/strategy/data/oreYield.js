"use strict";

const { mulDivFloor } = require("./tradeTiers");

const PERMILLE = 1000;

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

function typeIdOf(itemKey) {
  return typeof itemKey === "string" && itemKey.startsWith("type:") ? Number(itemKey.slice(5)) : NaN;
}

function expectedYield(portions, minerals, efficiencyPermille) {
  const out = [];
  if (!isCount(portions) || !isCount(efficiencyPermille) || !Array.isArray(minerals)) return out;
  for (const pair of minerals) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || !isCount(pair[1])) continue;
    const q = mulDivFloor(portions * pair[1], efficiencyPermille, PERMILLE);
    if (Number.isSafeInteger(q) && q > 0) out.push([pair[0], q]);
  }
  return out;
}

function portionsFor(need, yieldPerPortion, efficiencyPermille) {
  if (!Number.isSafeInteger(need) || need <= 0) return 0;
  if (!isCount(yieldPerPortion) || !isCount(efficiencyPermille)) return 0;
  const perPortion = yieldPerPortion * efficiencyPermille;
  if (!Number.isSafeInteger(perPortion) || perPortion < 1) return 0;
  const whole = Math.floor(need / perPortion) * PERMILLE;
  const rest = (need % perPortion) * PERMILLE;
  return whole + Math.ceil(rest / perPortion);
}

function primaryOf(minerals, quotes) {
  if (!Array.isArray(minerals) || !quotes || typeof quotes !== "object") return null;
  let best = null;
  let bestValue = -1;
  for (const pair of minerals) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || !isCount(pair[1])) return null;
    if (pair[1] === 0) continue;
    const q = Object.prototype.hasOwnProperty.call(quotes, pair[0]) ? quotes[pair[0]] : null;
    if (!q || q.ok !== true || !Number.isSafeInteger(q.unitMilli) || q.unitMilli < 1) return null;
    const value = pair[1] * q.unitMilli;
    if (value > bestValue || (value === bestValue && typeIdOf(pair[0]) < typeIdOf(best))) {
      best = pair[0];
      bestValue = value;
    }
  }
  return best;
}

module.exports = { expectedYield, portionsFor, primaryOf };
