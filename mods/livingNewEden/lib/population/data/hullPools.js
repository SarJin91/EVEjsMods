"use strict";

const { ARCHETYPE } = require("../schema");
const { ARCHETYPES } = require("./archetypes");

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const HULL_CLASS_NAMES = Object.freeze(["FRIGATE", "DESTROYER", "CRUISER", "BATTLECRUISER", "BATTLESHIP",
  "MINING_FRIGATE", "BARGE", "ORCA", "INDUSTRIAL", "DST", "FREIGHTER", "EXPLORER"]);
const HULL_CLASS = Object.freeze(Object.fromEntries(HULL_CLASS_NAMES.map((n, i) => [n, i + 1])));

const t = (cls, live, label) => ({ cls: HULL_CLASS[cls], live, label });

const HULL_TYPES = deepFreeze({
  603: t("FRIGATE", false, "Merlin"),
  594: t("FRIGATE", false, "Incursus"),
  16240: t("DESTROYER", true, "Catalyst"),
  626: t("CRUISER", false, "Vexor"),
  621: t("CRUISER", false, "Caracal"),
  16229: t("BATTLECRUISER", true, "Brutix"),
  24702: t("BATTLECRUISER", true, "Hurricane"),
  33472: t("BATTLESHIP", true, "Nestor"),
  32880: t("MINING_FRIGATE", true, "Venture"),
  17478: t("BARGE", true, "Retriever"),
  22546: t("BARGE", true, "Skiff"),
  28606: t("ORCA", false, "Orca"),
  1944: t("INDUSTRIAL", true, "Bestower"),
  648: t("INDUSTRIAL", true, "Badger"),
  652: t("INDUSTRIAL", true, "Mammoth"),
  12731: t("DST", true, "Bustard"),
  12753: t("DST", true, "Impel"),
  12747: t("DST", true, "Mastodon"),
  12745: t("DST", true, "Occator"),
  20185: t("FREIGHTER", true, "Charon"),
  20187: t("FREIGHTER", true, "Obelisk"),
  33468: t("EXPLORER", true, "Astero"),
  33470: t("EXPLORER", true, "Stratios"),
});

const ROUTE_RESTRICTED_CLASSES = Object.freeze(["FREIGHTER"]);
const RESTRICTED_CODES = Object.freeze(ROUTE_RESTRICTED_CLASSES.map((n) => HULL_CLASS[n]));

const same = (list) => ({ highsec: list, lowsec: list, nullsec: list });

const POOLS = deepFreeze({
  [ARCHETYPE.TRADER]: {
    highsec: [648, 1944, 652, 12731, 12745, 20185, 20187],
    lowsec: [648, 1944, 652, 12731, 12753, 12747, 12745, 20185, 20187],
    nullsec: [1944, 652, 12731, 12753, 12747, 12745],
  },
  [ARCHETYPE.MINER]: same([32880, 17478, 22546, 28606]),
  [ARCHETYPE.RATTER]: {
    highsec: [603, 16240, 626, 16229, 24702, 33472],
    lowsec: [16240, 621, 16229, 24702, 33472],
    nullsec: [16240, 621, 16229, 24702, 33472],
  },
  [ARCHETYPE.EXPLORER]: same([33468, 33470]),
  [ARCHETYPE.COMMUTER]: same([32880, 16240, 33468, 1944]),
});

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function hullPoolOf(archetype, band) {
  const a = own(POOLS, archetype) ? archetype : ARCHETYPE.TRADER;
  if (typeof band === "string" && own(POOLS[a], band)) return POOLS[a][band];
  return ARCHETYPES[a].hulls;
}

function hullClassOf(typeId) {
  return own(HULL_TYPES, typeId) ? HULL_TYPES[typeId].cls : 0;
}

function isLiveHull(typeId) {
  return own(HULL_TYPES, typeId) ? HULL_TYPES[typeId].live === true : true;
}

function isRouteRestricted(typeId) {
  return RESTRICTED_CODES.includes(hullClassOf(typeId));
}

function routeSafePool(pool, band, avoidBands) {
  if (typeof band !== "string" || !Array.isArray(avoidBands) || !avoidBands.includes(band)) return pool;
  return pool.filter((typeId) => !isRouteRestricted(typeId));
}

module.exports = { HULL_CLASS_NAMES, HULL_CLASS, HULL_TYPES, POOLS, ROUTE_RESTRICTED_CLASSES, hullPoolOf, hullClassOf,
  isLiveHull, isRouteRestricted, routeSafePool };
