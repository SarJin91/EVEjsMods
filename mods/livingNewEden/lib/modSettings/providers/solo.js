"use strict";

const { MOD_LOCKS } = require("../lockSpec");
const { flatRow, createFlatProvider, ROW_TYPES } = require("./flatKit");

const MOD_ID = "soloProgressionBalance";
const NEED = Object.freeze({ DEFAULTS: "object", KEYS: "object", SMB_RATIO_PERMILLE_RANGE: "object",
  load: "function", resolveDataDir: "function" });
const ID_LIST_FIELD = "smbExcludedGroupIds";
const RATIO_FIELD = "smbRatioPermille";
const NON_NEGATIVE_FIELD = "smbMaxCapacityM3";
const SCALE_RE = /Scale$/;
const ID_LIST_RE = /^\s*\d+(\s*,\s*\d+)*\s*$/;

const listText = (value) => (Array.isArray(value) ? value.join(",") : value);

function rowsOf(cfg, manifestFields) {
  const rows = [];
  for (const [key, def] of Object.entries(cfg.DEFAULTS)) {
    const env = typeof cfg.KEYS[key] === "string" ? cfg.KEYS[key] : null;
    const spec = { key, default: def, env };
    if (typeof def === "boolean") spec.type = "boolean";
    else if (key === ID_LIST_FIELD) Object.assign(spec, { type: "string", default: listText(def) });
    else if (key === RATIO_FIELD) {
      Object.assign(spec, { type: "integer", min: cfg.SMB_RATIO_PERMILLE_RANGE.min,
        max: cfg.SMB_RATIO_PERMILLE_RANGE.max });
    } else if (key === NON_NEGATIVE_FIELD) Object.assign(spec, { type: "number", min: 0 });
    else if (SCALE_RE.test(key) && typeof def === "number") spec.type = "number";
    else continue;
    rows.push(flatRow(spec, manifestFields));
  }
  return rows.filter((r) => ROW_TYPES.includes(r.type));
}

function extraValidate(key, value) {
  if (SCALE_RE.test(key)) return value > 0 ? null : "OUT_OF_RANGE";
  if (key !== ID_LIST_FIELD) return null;
  if (!ID_LIST_RE.test(value)) return "BAD_VALUE";
  return value.split(",").every((part) => Number(part.trim()) > 0) ? null : "BAD_VALUE";
}

function createSoloProvider(deps) {
  const loaded = deps && deps.loaded;
  if (!loaded || loaded.ok !== true || !loaded.exports) {
    return { ok: false, reason: (loaded && loaded.reason) || "CONFIG_MISSING" };
  }
  const cfg = loaded.exports;
  const env = deps.env || process.env;
  const modDir = loaded.modDir;
  const manifest = loaded.manifest || { displayName: null, fields: {} };
  const rows = rowsOf(cfg, manifest.fields);
  return createFlatProvider({
    modId: MOD_ID,
    title: manifest.displayName || MOD_ID,
    dataDir: cfg.resolveDataDir(env, modDir),
    env,
    rows,
    envOf: (key) => (typeof cfg.KEYS[key] === "string" ? [cfg.KEYS[key]] : []),
    load: (overrideValues) => {
      const r = cfg.load(modDir, env, overrideValues === null ? undefined : { overrideValues });
      const values = {};
      for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(r, row.key)) {
          values[row.key] = row.key === ID_LIST_FIELD ? listText(r[row.key]) : r[row.key];
        }
      }
      return { values, warnings: [], errors: Array.isArray(r.problems) ? [...r.problems] : [] };
    },
    locks: MOD_LOCKS[MOD_ID],
    extraValidate,
  });
}

module.exports = { MOD_ID, NEED, createSoloProvider };
