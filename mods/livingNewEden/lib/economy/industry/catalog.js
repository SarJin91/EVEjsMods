"use strict";

const { INDUSTRY_CATALOG_VERSION, INDUSTRY_HULL_CLASSES, INDUSTRY_STRUCTURE_FAMILIES,
  INDUSTRY_ORE_BANDS } = require("./classes");

const REASON = "INDUSTRY_CATALOG_INVALID";
const PERMILLE = 1000;
const MINERAL_KEYS = Object.freeze(["type:34", "type:35", "type:36", "type:37", "type:38", "type:39", "type:40"]);
const MINERAL_KEY_SET = new Set(MINERAL_KEYS);
const HASH_RE = /^[0-9a-f]{64}$/;

const HULL_INT_FIELDS = Object.freeze(["representativeTypeId", "sampleSize", "mineralSum", "timeSec",
  "mineralValueIsk", "componentValueIsk", "componentFactorPermille", "unpricedLeaves", "cargoM3", "cargoMedianM3",
  "oreHoldM3"]);
const KIT_INT_FIELDS = Object.freeze(["typeId", "mineralSum", "timeSec", "mineralValueIsk", "componentValueIsk",
  "componentFactorPermille", "unpricedLeaves"]);
const TRAVEL_FIELDS = Object.freeze(["warpSpeedAu", "alignSeconds", "maxVelocityMs"]);

class Invalid extends Error {}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

function check(cond, detail) {
  if (!cond) throw new Invalid(detail);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function sameKeys(obj, names, label) {
  check(isObject(obj), `${label} missing`);
  const keys = Object.keys(obj).sort();
  const want = [...names].sort();
  check(keys.join() === want.join(), `${label} keys ${keys.join(",")} != ${want.join(",")}`);
}

function checkMinerals(minerals, label) {
  check(isObject(minerals), `${label}.minerals missing`);
  for (const [k, v] of Object.entries(minerals)) {
    check(MINERAL_KEY_SET.has(k), `${label}.minerals key ${k} outside type:34-40`);
    check(isCount(v), `${label}.minerals.${k} not a safe integer >= 0`);
  }
}

function checkInts(row, fields, label) {
  for (const f of fields) check(isCount(row[f]), `${label}.${f} not a safe integer >= 0`);
  check(row.componentFactorPermille >= PERMILLE, `${label}.componentFactorPermille < ${PERMILLE}`);
}

function validate(data) {
  check(isObject(data), "data missing");
  const header = data.HEADER;
  check(isObject(header), "HEADER missing");
  check(header.catalogVersion === INDUSTRY_CATALOG_VERSION,
    `HEADER.catalogVersion ${header.catalogVersion} != ${INDUSTRY_CATALOG_VERSION}`);
  check(isCount(header.sdeBuild), "HEADER.sdeBuild");
  check(typeof header.sourceHash === "string" && HASH_RE.test(header.sourceHash), "HEADER.sourceHash");

  sameKeys(data.HULLS, INDUSTRY_HULL_CLASSES, "HULLS");
  for (const cls of INDUSTRY_HULL_CLASSES) {
    const row = data.HULLS[cls];
    const label = `HULLS.${cls}`;
    check(isObject(row), `${label} missing`);
    checkMinerals(row.minerals, label);
    checkInts(row, HULL_INT_FIELDS, label);
    check(Array.isArray(row.members) && row.members.length > 0 && row.members.every(isCount), `${label}.members`);
    check(isObject(row.travel), `${label}.travel missing`);
    for (const f of TRAVEL_FIELDS) {
      check(Number.isFinite(row.travel[f]) && row.travel[f] >= 0, `${label}.travel.${f} not finite >= 0`);
    }
  }
  sameKeys(data.STRUCTURES, INDUSTRY_STRUCTURE_FAMILIES, "STRUCTURES");
  for (const family of INDUSTRY_STRUCTURE_FAMILIES) {
    const row = data.STRUCTURES[family];
    const label = `STRUCTURES.${family}`;
    check(isObject(row), `${label} missing`);
    checkMinerals(row.minerals, label);
    checkInts(row, KIT_INT_FIELDS, label);
  }
  sameKeys(data.ORE_BANDS, INDUSTRY_ORE_BANDS, "ORE_BANDS");
  for (const band of INDUSTRY_ORE_BANDS) {
    const row = data.ORE_BANDS[band];
    const label = `ORE_BANDS.${band}`;
    check(isObject(row), `${label} missing`);
    sameKeys(row.mineralsPerMillionM3, MINERAL_KEYS, `${label}.mineralsPerMillionM3`);
    for (const k of MINERAL_KEYS) {
      const v = row.mineralsPerMillionM3[k];
      check(Number.isSafeInteger(v) && v > 0, `${label}.mineralsPerMillionM3.${k} not > 0`);
    }
  }
}

function createIndustryCatalog(data) {
  try {
    const source = data === undefined ? require("../data/industryCatalog") : data;
    validate(source);
    const copy = deepFreeze(JSON.parse(JSON.stringify({ HEADER: source.HEADER, HULLS: source.HULLS,
      STRUCTURES: source.STRUCTURES, ORE_BANDS: source.ORE_BANDS })));
    const hulls = new Map(INDUSTRY_HULL_CLASSES.map((c) => [c, copy.HULLS[c]]));
    const kits = new Map(INDUSTRY_STRUCTURE_FAMILIES.map((f) => [f, copy.STRUCTURES[f]]));
    const bands = new Map(INDUSTRY_ORE_BANDS.map((b) => [b, copy.ORE_BANDS[b]]));
    const catalog = Object.freeze({
      version: copy.HEADER.catalogVersion,
      sdeBuild: copy.HEADER.sdeBuild,
      sourceHash: copy.HEADER.sourceHash,
      hullClasses: INDUSTRY_HULL_CLASSES,
      structureFamilies: INDUSTRY_STRUCTURE_FAMILIES,
      hull: (cls) => hulls.get(cls) || null,
      kit: (family) => kits.get(family) || null,
      oreBand: (secClass) => bands.get(secClass) || null,
    });
    return { ok: true, catalog };
  } catch (err) {
    return { ok: false, reason: REASON, detail: err instanceof Invalid ? err.message : `load: ${err && err.message}` };
  }
}

module.exports = { createIndustryCatalog };
