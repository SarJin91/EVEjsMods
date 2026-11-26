"use strict";

const { MOD_LOCKS } = require("../lockSpec");
const { createLocks } = require("../locks");
const { toSettingRow, manifestRowExtra, defaultDataDirOf } = require("./rowKit");

const MOD_ID = "droneClassBalance";
const NEED = Object.freeze({ classes: "object" });
const APPLY_RESTART = "restart";
const ROW_TYPES = Object.freeze(["boolean", "integer", "number"]);
const MAX_KEY_CHARS = 64;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(exportsObj, dotted) {
  let node = exportsObj;
  for (const part of dotted.split(".")) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, part)) return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}

function rowsOf(manifestFields) {
  const rows = [];
  for (const [key, field] of Object.entries(isPlainObject(manifestFields) ? manifestFields : {})) {
    const extra = manifestRowExtra(manifestFields, key);
    const type = ROW_TYPES.includes(extra.type) ? extra.type : "string";
    const row = { key, default: isPlainObject(field) && field.default !== undefined ? field.default : null, env: null };
    if (typeof extra.min === "number") row.min = extra.min;
    if (typeof extra.max === "number") row.max = extra.max;
    rows.push(toSettingRow(row, { type, group: extra.group, label: extra.label, description: extra.description,
      step: extra.step, secret: false }));
  }
  return rows;
}

function createDroneClassBalanceProvider(deps) {
  const loaded = deps && deps.loaded;
  if (!loaded || loaded.ok !== true || !loaded.exports) {
    return { ok: false, reason: (loaded && loaded.reason) || "CONFIG_MISSING" };
  }
  const cfg = loaded.exports;
  const env = deps.env || process.env;
  const manifest = loaded.manifest || { displayName: null, fields: {} };
  const rows = Object.freeze(rowsOf(manifest.fields));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const locks = createLocks(MOD_LOCKS[MOD_ID]);
  const lockOf = (key) => locks.locked(byKey.get(key) || { key: String(key) });

  function current() {
    const out = {};
    for (const row of rows) out[row.key] = valueAt(cfg, row.key);
    return out;
  }

  function resolve(overrides) {
    const values = current();
    const sources = {};
    for (const row of rows) {
      const v = values[row.key];
      sources[row.key] = v === row.default || (v === null && row.default === 0) ? "default" : "file";
    }
    const warnings = Object.keys(isPlainObject(overrides) ? overrides : {}).map((key) => {
      const shown = key.length > MAX_KEY_CHARS ? `${key.slice(0, MAX_KEY_CHARS)}...` : key;
      return byKey.has(key) ? `${key}: locked (READ_ONLY) - ignored` : `${shown}: unknown key - ignored`;
    });
    return { ok: true, values, sources, warnings, errors: [] };
  }

  return { ok: true, provider: Object.freeze({
    modId: MOD_ID,
    title: manifest.displayName || MOD_ID,
    dataDir: defaultDataDirOf(env, loaded.modDir, MOD_ID),
    rows: () => rows,
    resolve,
    current,
    validate: (key) => (byKey.has(key) ? { ok: false, reason: "BAD_VALUE" } : { ok: false, reason: "UNKNOWN_KEY" }),
    locked: lockOf,
    apply: () => APPLY_RESTART,
  }) };
}

module.exports = { MOD_ID, NEED, createDroneClassBalanceProvider };
