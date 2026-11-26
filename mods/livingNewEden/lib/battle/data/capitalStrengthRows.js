"use strict";

const { HEADER, TYPES } = require("./strengthCatalog");
const { CLASS_SOURCE_TYPES } = require("../../fleets/data/capitalClasses");

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function capitalStrengthRowsOf(types, sourceTypes, fields) {
  const out = {};
  for (const cls of Object.keys(sourceTypes)) {
    const rows = Object.values(sourceTypes[cls])
      .filter((typeId) => hasOwn(types, String(typeId)))
      .map((typeId) => types[String(typeId)])
      .sort((a, b) => a.ehp - b.ehp || a.typeId - b.typeId);
    if (rows.length === 0) continue;
    const median = rows[Math.floor((rows.length - 1) / 2)];
    out[cls] = Object.freeze(Object.fromEntries(fields.map((f) => [f, median[f]])));
  }
  return Object.freeze(out);
}

const CAPITAL_STRENGTH_ROWS = capitalStrengthRowsOf(TYPES, CLASS_SOURCE_TYPES, HEADER.fields);

const POWER_PERMILLE_KEYS = Object.freeze({
  carrier: "capitalPowerPermilleCarrier",
  dreadnought: "capitalPowerPermilleDreadnought",
  force_auxiliary: "capitalPowerPermilleForceAuxiliary",
  supercarrier: "capitalPowerPermilleSupercarrier",
  titan: "capitalPowerPermilleTitan",
});

const BATTLESHIP_POWER_KEY = "battleshipPowerPermille";

const permilleOf = (value) => (Number.isSafeInteger(value) && value >= 1 ? value : 1000);

function capitalPowerOverlayOf(strategyConfig) {
  const valid = Boolean(strategyConfig) && typeof strategyConfig === "object";
  const capitalOn = valid && strategyConfig.capitalPowerCalibrated === true;
  const battleshipOn = valid && strategyConfig.battleshipPowerCalibrated === true;
  if (!capitalOn && !battleshipOn) return CAPITAL_STRENGTH_ROWS;
  const out = capitalOn ? capitalRowsOf(strategyConfig) : { ...CAPITAL_STRENGTH_ROWS };
  if (battleshipOn) out.battleship = Object.freeze({ powerPermille: permilleOf(strategyConfig[BATTLESHIP_POWER_KEY]) });
  return Object.freeze(out);
}

function capitalRowsOf(strategyConfig) {
  const out = {};
  for (const cls of Object.keys(CAPITAL_STRENGTH_ROWS)) {
    const key = hasOwn(POWER_PERMILLE_KEYS, cls) ? POWER_PERMILLE_KEYS[cls] : null;
    if (key === null) {
      out[cls] = CAPITAL_STRENGTH_ROWS[cls];
      continue;
    }
    out[cls] = Object.freeze({ ...CAPITAL_STRENGTH_ROWS[cls], powerPermille: permilleOf(strategyConfig[key]) });
  }
  return out;
}

module.exports = { CAPITAL_STRENGTH_ROWS, capitalStrengthRowsOf, capitalPowerOverlayOf, POWER_PERMILLE_KEYS,
  BATTLESHIP_POWER_KEY };
