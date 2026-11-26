"use strict";

const { MOD_LOCKS } = require("../lockSpec");
const { flatRow, createFlatProvider, ROW_TYPES } = require("./flatKit");

const BASE_NEED = Object.freeze({ DEFAULTS: "object", KEYS: "object", load: "function", resolveDataDir: "function" });
const needWith = (extra) => Object.freeze({ ...BASE_NEED, ...extra });
const BOOLEANS_NEED = needWith({ BOOLEAN_FIELDS: "array" });
const CLEANUP_WARNING = "Destroys the items of the custom types after the restart (EVEJS_CUSTOMTYPES_CLEANUP).";

const SPECS = Object.freeze({
  autopilotJumpZero: Object.freeze({ need: BASE_NEED }),
  dailyGoalsPersist: Object.freeze({ need: needWith({ BOOLEAN_FIELDS: "array", LIMITS: "object" }) }),
  marketAllRegions: Object.freeze({ need: needWith({ BOOLEAN_FIELDS: "array", LIMITS: "object" }) }),
  industryOrphanCleanup: Object.freeze({ need: BOOLEANS_NEED }),
  missionStructureRestore: Object.freeze({ need: BOOLEANS_NEED }),
  skyhookOrphanFix: Object.freeze({ need: BOOLEANS_NEED }),
  planetaryDrill: Object.freeze({ need: needWith({ BOOLEAN_FIELDS: "array", INTEGER_RANGES: "object" }) }),
  customTypes: Object.freeze({ need: BOOLEANS_NEED, fields: (cfg) => [...cfg.BOOLEAN_FIELDS],
    descriptions: Object.freeze({ cleanup: CLEANUP_WARNING }) }),
  moonOreAnomalies: Object.freeze({ need: BASE_NEED }),
});
const MOD_IDS = Object.freeze(Object.keys(SPECS));

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(obj, key) {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function typeOf(cfg, field) {
  const def = cfg.DEFAULTS[field];
  const range = (min, max) => {
    const out = {};
    if (Number.isFinite(min)) out.min = min;
    if (Number.isFinite(max)) out.max = max;
    return out;
  };
  if (typeof def === "boolean") return { type: "boolean" };
  if (typeof def !== "number") return null;
  const limits = own(cfg.LIMITS, field);
  if (isPlainObject(limits)) return { type: "integer", ...range(limits.min, limits.max) };
  const ints = own(cfg.INTEGER_RANGES, field);
  if (Array.isArray(ints)) return { type: "integer", ...range(ints[0], ints[1]) };
  if (field === "launchTypeID") {
    return { type: "integer", ...range(0, Array.isArray(cfg.LAUNCH_TYPE_RANGE) ? cfg.LAUNCH_TYPE_RANGE[1] : undefined) };
  }
  if (field === "warpInDistanceMeters") {
    return { type: "number", ...range(cfg.MIN_WARP_IN_DISTANCE_METERS, cfg.MAX_WARP_IN_DISTANCE_METERS) };
  }
  return null;
}

function rowsOf(cfg, fields, manifestFields, descriptions) {
  const rows = [];
  for (const field of fields) {
    const kind = typeOf(cfg, field);
    if (!kind) continue;
    const env = typeof cfg.KEYS[field] === "string" ? cfg.KEYS[field] : null;
    const row = flatRow({ key: field, default: cfg.DEFAULTS[field], env, ...kind }, manifestFields);
    const text = own(descriptions, field);
    rows.push(typeof text === "string" && row.description === null ? Object.freeze({ ...row, description: text }) : row);
  }
  return rows.filter((r) => ROW_TYPES.includes(r.type));
}

function createSimpleModProvider(modId, deps) {
  const spec = Object.prototype.hasOwnProperty.call(SPECS, modId) ? SPECS[modId] : null;
  if (!spec) return { ok: false, reason: "NO_PROVIDER" };
  const loaded = deps && deps.loaded;
  if (!loaded || loaded.ok !== true || !loaded.exports) {
    return { ok: false, reason: (loaded && loaded.reason) || "CONFIG_MISSING" };
  }
  const cfg = loaded.exports;
  const env = deps.env || process.env;
  const modDir = loaded.modDir;
  const manifest = loaded.manifest || { displayName: null, fields: {} };
  const fields = typeof spec.fields === "function" ? spec.fields(cfg) : Object.keys(cfg.DEFAULTS);
  const rows = rowsOf(cfg, fields, manifest.fields, spec.descriptions);
  return createFlatProvider({
    modId,
    title: manifest.displayName || modId,
    dataDir: cfg.resolveDataDir(env, modDir),
    env,
    rows,
    envOf: (field) => (typeof cfg.KEYS[field] === "string" ? [cfg.KEYS[field]] : []),
    load: (overrideValues) => {
      const r = cfg.load(modDir, env, overrideValues === null ? undefined : { overrideValues });
      const values = {};
      for (const row of rows) if (Object.prototype.hasOwnProperty.call(r, row.key)) values[row.key] = r[row.key];
      return { values, warnings: Array.isArray(r.shopProblems) ? [...r.shopProblems] : [],
        errors: Array.isArray(r.problems) ? [...r.problems] : [] };
    },
    locks: MOD_LOCKS[modId],
  });
}

module.exports = { SPECS, MOD_IDS, createSimpleModProvider };
