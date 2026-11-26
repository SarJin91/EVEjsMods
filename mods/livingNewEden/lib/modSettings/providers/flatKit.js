"use strict";

const { createLocks } = require("../locks");
const { flattenOver, validateRow, toSettingRow, manifestRowExtra } = require("./rowKit");

const APPLY_RESTART = "restart";
const MAX_KEY_CHARS = 64;
const ROW_TYPES = Object.freeze(["boolean", "integer", "number", "enum", "string"]);
const SOURCE_OF = Object.freeze({ "settings.override.json": "override", environment: "env", ".env": "file",
  "settings.json": "file", default: "default" });

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function clip(text) {
  const s = String(text);
  return s.length > MAX_KEY_CHARS ? `${s.slice(0, MAX_KEY_CHARS)}...` : s;
}

function flatRow(spec, manifestFields, opts = {}) {
  const extra = manifestRowExtra(manifestFields, spec.key);
  const row = { key: spec.key, default: spec.default, env: spec.env };
  let type = spec.type;
  for (const k of ["min", "max"]) if (typeof spec[k] === "number") row[k] = spec[k];
  if (opts.preferManifest === true) {
    if (extra.type !== null && extra.type !== "enum") type = extra.type;
    for (const k of ["min", "max"]) if (typeof extra[k] === "number") row[k] = extra[k];
  }
  if (Array.isArray(spec.values)) row.values = spec.values;
  const out = toSettingRow(row, { type, group: extra.group, label: extra.label, description: extra.description,
    step: extra.step, secret: false });
  return spec.nullable === true ? Object.freeze({ ...out, nullable: true }) : out;
}

function createFlatProvider(spec) {
  if (!spec || typeof spec.load !== "function" || typeof spec.envOf !== "function" || !Array.isArray(spec.rows)
    || !spec.locks) {
    return { ok: false, reason: "CONFIG_SHAPE" };
  }
  const env = spec.env || process.env;
  const rows = Object.freeze([...spec.rows]);
  const keys = rows.map((r) => r.key);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const locks = createLocks(spec.locks);
  const lockOf = (key) => locks.locked(byKey.get(key) || null);

  function validate(key, value) {
    const row = byKey.get(key);
    if (!row) return { ok: false, reason: "UNKNOWN_KEY" };
    const r = validateRow(row, value);
    if (!r.ok) return r;
    const why = typeof spec.extraValidate === "function" ? spec.extraValidate(key, value) : null;
    return why ? { ok: false, reason: why } : r;
  }

  function envSet(key) {
    return spec.envOf(key).some((name) => {
      if (typeof name !== "string" || name === "") return false;
      const v = env[name];
      return v !== undefined && v !== null && String(v).trim() !== "";
    });
  }

  function sourcesOf(values, accepted, modSources) {
    const out = {};
    for (const row of rows) {
      const key = row.key;
      if (hasOwn(modSources, key) && hasOwn(SOURCE_OF, modSources[key])) out[key] = SOURCE_OF[modSources[key]];
      else if (hasOwn(accepted, key)) out[key] = "override";
      else if (envSet(key)) out[key] = "env";
      else if (!sameValue(values[key], row.default)) out[key] = "file";
      else out[key] = "default";
    }
    return out;
  }

  function resolve(overrides) {
    const input = isPlainObject(overrides) ? overrides : {};
    const refused = [];
    const accepted = {};
    for (const [key, value] of Object.entries(input)) {
      if (!byKey.has(key)) {
        refused.push(`${clip(key)}: unknown key - ignored`);
        continue;
      }
      const lock = lockOf(key);
      if (lock.locked === true) {
        refused.push(`${key}: locked (${lock.reason}) - ignored`);
        continue;
      }
      const v = validate(key, value);
      if (!v.ok) {
        refused.push(`${key}: ${v.reason} - ignored`);
        continue;
      }
      accepted[key] = value;
    }
    const loaded = spec.load(accepted);
    const values = flattenOver(loaded.values, keys, false);
    const errors = Array.isArray(loaded.errors) ? [...loaded.errors] : [];
    return { ok: errors.length === 0, values, sources: sourcesOf(values, accepted, loaded.sources),
      warnings: [...refused, ...(Array.isArray(loaded.warnings) ? loaded.warnings : [])], errors };
  }

  return { ok: true, provider: Object.freeze({
    modId: spec.modId,
    title: spec.title,
    dataDir: spec.dataDir,
    rows: () => rows,
    resolve,
    current: () => flattenOver(spec.load(null).values, keys, false),
    validate,
    locked: lockOf,
    apply: () => APPLY_RESTART,
  }) };
}

module.exports = { ROW_TYPES, flatRow, createFlatProvider };
