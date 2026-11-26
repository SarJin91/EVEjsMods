"use strict";

const { FACTION_RACE } = require("../../economy/data/hullTradeTypes");
const { CLASS_SOURCE_TYPES } = require("../../fleets/data/capitalClasses");

const EMPIRE_FACTION_IDS = Object.freeze([500001, 500002, 500003, 500004]);
const RACE_KEY = Object.freeze({ 1: "caldari", 2: "minmatar", 4: "amarr", 8: "gallente" });

const PIRATE_HULL_CLASSES = Object.freeze({
  500012: Object.freeze({ dreadnought: 42243, force_auxiliary: 42242, titan: 42241 }),
  500010: Object.freeze({ dreadnought: 45647, force_auxiliary: 45645, titan: 45649 }),
  500020: Object.freeze({ dreadnought: 42124, supercarrier: 42125, titan: 42126 }),
  500019: Object.freeze({ supercarrier: 3514 }),
  500011: Object.freeze({ dreadnought: 87381, titan: 78576 }),
});

function empireClasses(factionId) {
  const race = RACE_KEY[FACTION_RACE[String(factionId)]];
  const out = {};
  for (const cls of Object.keys(CLASS_SOURCE_TYPES)) out[cls] = CLASS_SOURCE_TYPES[cls][race];
  return Object.freeze(out);
}

const FACTION_HULL_CLASSES = Object.freeze({
  ...Object.fromEntries(EMPIRE_FACTION_IDS.map((id) => [id, empireClasses(id)])),
  ...PIRATE_HULL_CLASSES,
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function classTypeOf(factionId, cls) {
  const row = hasOwn(FACTION_HULL_CLASSES, String(factionId)) ? FACTION_HULL_CLASSES[String(factionId)] : null;
  if (!row || typeof cls !== "string" || !hasOwn(row, cls)) return null;
  const typeId = row[cls];
  return Number.isSafeInteger(typeId) && typeId > 0 ? typeId : null;
}

function capitalClassesOf(factionId) {
  const row = hasOwn(FACTION_HULL_CLASSES, String(factionId)) ? FACTION_HULL_CLASSES[String(factionId)] : null;
  const out = {};
  for (const cls of Object.keys(row || {})) {
    const typeId = classTypeOf(factionId, cls);
    if (typeId !== null) out[cls] = typeId;
  }
  return out;
}

module.exports = { FACTION_HULL_CLASSES, classTypeOf, capitalClassesOf };
