"use strict";

const { liveCombatFleets } = require("./operations");

const PERMILLE = 1000;
const DEFENSIVE_TYPES = Object.freeze(["blockade", "escort"]);
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);

function defensiveBudgetOf(fleets, operations, sharePermille) {
  const list = fleets || [];
  const cap = Math.floor(liveCombatFleets(list) * sharePermille / PERMILLE);
  const defensive = new Set((operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state)
    && DEFENSIVE_TYPES.includes(op.operationType)).map((op) => op.operationId));
  const busy = list.filter((x) => x.operationId !== null && x.operationId !== undefined
    && defensive.has(x.operationId)).length;
  return { cap, busy };
}

module.exports = { defensiveBudgetOf, DEFENSIVE_TYPES };
