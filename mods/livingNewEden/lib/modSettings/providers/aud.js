"use strict";

const { MOD_LOCKS } = require("../lockSpec");
const { flatRow, createFlatProvider } = require("./flatKit");

const MOD_ID = "EveJS-AdvancedUtilityDrones-1.0.3";
const NEED = Object.freeze({ DEFAULTS: "object", KEYS: "object", LIMITS: "object", JSON_KEY_BY_ENV: "object",
  load: "function", resolveDataDir: "function", readNumberList: "function" });
const STATE_REFRESH_FIELD = "stateRefreshMs";
const NULLABLE_NUMBER_FIELD = "rangeMeters";
const STRING_FIELDS = Object.freeze([STATE_REFRESH_FIELD, "playersFile"]);

function enumsOf(cfg) {
  const list = (...values) => (values.every((v) => typeof v === "string") ? Object.freeze(values) : null);
  return {
    rangeMode: list(cfg.RANGE_MODE_SHIP, cfg.RANGE_MODE_FIXED),
    targetMode: list(cfg.TARGET_MODE_SPREAD, cfg.TARGET_MODE_FOCUS),
    salvageTargetMode: list(cfg.TARGET_MODE_SPREAD, cfg.TARGET_MODE_FOCUS),
    filterFallback: list(cfg.FILTER_FALLBACK_ANY, cfg.FILTER_FALLBACK_IDLE),
    playerControlPolicy: list(cfg.PLAYER_CONTROL_HOLD, cfg.PLAYER_CONTROL_RECALL, cfg.PLAYER_CONTROL_OFF),
    salvageDistance: list(cfg.SALVAGE_DISTANCE_NEAREST, cfg.SALVAGE_DISTANCE_FARTHEST),
  };
}

function rowsOf(cfg, fields) {
  const enums = enumsOf(cfg);
  const rows = [];
  for (const field of fields) {
    const def = Object.prototype.hasOwnProperty.call(cfg.DEFAULTS, field) ? cfg.DEFAULTS[field] : undefined;
    const env = typeof cfg.KEYS[field] === "string" ? cfg.KEYS[field] : null;
    const limits = cfg.LIMITS[field];
    const spec = { key: field, default: def, env };
    if (STRING_FIELDS.includes(field)) spec.type = "string";
    else if (enums[field]) Object.assign(spec, { type: "enum", values: enums[field] });
    else if (typeof def === "boolean") spec.type = "boolean";
    else if (typeof def === "number" || field === NULLABLE_NUMBER_FIELD) {
      spec.type = "number";
      if (limits && Number.isFinite(limits.minimum)) spec.min = limits.minimum;
      if (limits && Number.isFinite(limits.maximum)) spec.max = limits.maximum;
      if (field === NULLABLE_NUMBER_FIELD) spec.nullable = true;
    } else continue;
    rows.push(flatRow(spec, null));
  }
  return rows;
}

function createAudProvider(deps) {
  const loaded = deps && deps.loaded;
  if (!loaded || loaded.ok !== true || !loaded.exports) {
    return { ok: false, reason: (loaded && loaded.reason) || "CONFIG_MISSING" };
  }
  const cfg = loaded.exports;
  const env = deps.env || process.env;
  const modDir = loaded.modDir;
  const manifest = loaded.manifest || { displayName: null, fields: {} };
  const fields = [...new Set(Object.values(cfg.JSON_KEY_BY_ENV))];
  const legacy = cfg.LEGACY_KEY_BY_ENV && typeof cfg.LEGACY_KEY_BY_ENV === "object" ? cfg.LEGACY_KEY_BY_ENV : {};
  return createFlatProvider({
    modId: MOD_ID,
    title: manifest.displayName || MOD_ID,
    dataDir: cfg.resolveDataDir(env, modDir),
    env,
    rows: rowsOf(cfg, fields),
    envOf: (field) => [cfg.KEYS[field], legacy[cfg.KEYS[field]]].filter((n) => typeof n === "string"),
    load: (overrideValues) => {
      const r = cfg.load(modDir, env, overrideValues === null ? {} : { overrideValues });
      const values = {};
      for (const field of fields) {
        if (field === STATE_REFRESH_FIELD) {
          values[field] = Array.isArray(r.stateRefreshScheduleMs) ? r.stateRefreshScheduleMs.join(",") : undefined;
        } else if (Object.prototype.hasOwnProperty.call(r, field)) values[field] = r[field];
      }
      return { values, warnings: [], errors: Array.isArray(r.problems) ? [...r.problems] : [] };
    },
    locks: MOD_LOCKS[MOD_ID],
    extraValidate: (field, value) => {
      if (field !== STATE_REFRESH_FIELD) return null;
      const problems = [];
      const list = cfg.readNumberList(value, null, cfg.LIMITS[STATE_REFRESH_FIELD], field, problems);
      return list === null || problems.length > 0 ? "BAD_VALUE" : null;
    },
  });
}

module.exports = { MOD_ID, NEED, createAudProvider };
