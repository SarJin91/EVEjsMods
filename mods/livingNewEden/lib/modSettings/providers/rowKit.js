"use strict";

const path = require("node:path");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(obj, dotted) {
  let node = obj;
  for (const part of dotted.split(".")) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

function toSettingRow(row, extra) {
  const out = { key: row.key, type: extra.type, default: row.default !== undefined ? row.default : row.def };
  if (typeof row.min === "number") out.min = row.min;
  if (typeof row.max === "number") out.max = row.max;
  if (typeof extra.step === "number") out.step = extra.step;
  if (Array.isArray(row.values)) out.values = Object.freeze([...row.values]);
  Object.assign(out, { env: typeof row.env === "string" ? row.env : null, group: extra.group, label: extra.label,
    description: extra.description, secret: extra.secret === true });
  return Object.freeze(out);
}

function flattenOver(config, keys, nested) {
  const out = {};
  if (!isPlainObject(config)) return out;
  for (const key of keys) {
    const value = nested ? getPath(config, key) : (Object.prototype.hasOwnProperty.call(config, key) ? config[key]
      : undefined);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function validateRow(row, value) {
  if (row.type === "boolean") return typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: "BAD_TYPE" };
  if (row.type === "string") return typeof value === "string" ? { ok: true, value } : { ok: false, reason: "BAD_TYPE" };
  if (row.type === "enum") {
    if (typeof value !== "string") return { ok: false, reason: "BAD_TYPE" };
    return Array.isArray(row.values) && row.values.includes(value) ? { ok: true, value }
      : { ok: false, reason: "BAD_VALUE" };
  }
  const integer = row.type === "integer";
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    return { ok: false, reason: "BAD_TYPE" };
  }
  if ((typeof row.min === "number" && value < row.min) || (typeof row.max === "number" && value > row.max)) {
    return { ok: false, reason: "OUT_OF_RANGE" };
  }
  return { ok: true, value };
}

const BOOLEAN_TEXT = Object.freeze({ 1: true, 0: false, true: true, false: false });
const NUMBER_TEXT_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

function parseValueText(type, text) {
  const t = String(text ?? "").trim();
  if (type === "boolean") {
    const lower = t.toLowerCase();
    return Object.prototype.hasOwnProperty.call(BOOLEAN_TEXT, lower) ? { ok: true, value: BOOLEAN_TEXT[lower] }
      : { ok: false, reason: "BAD_TYPE" };
  }
  if (type === "integer" || type === "number") {
    return NUMBER_TEXT_RE.test(t) ? { ok: true, value: Number(t) } : { ok: false, reason: "BAD_TYPE" };
  }
  return { ok: true, value: t };
}

function groupOf(key) {
  const m = /^[a-z0-9]+/.exec(key);
  return m ? m[0] : key;
}

const MANIFEST_TYPES = Object.freeze(["boolean", "integer", "number", "enum", "string"]);

function manifestRowExtra(manifestFields, key) {
  const field = isPlainObject(manifestFields) && Object.prototype.hasOwnProperty.call(manifestFields, key)
    && isPlainObject(manifestFields[key]) ? manifestFields[key] : {};
  const text = (v) => (typeof v === "string" && v !== "" ? v : null);
  const out = { label: text(field.label), description: text(field.description), group: text(field.group) || groupOf(key),
    type: MANIFEST_TYPES.includes(field.type) ? field.type : null };
  for (const k of ["min", "max", "step"]) if (Number.isFinite(field[k])) out[k] = field[k];
  return out;
}

function defaultDataDirOf(env, modDir, dataId) {
  const configured = String((env && env.EVEJS_DATA_ROOT) || "").trim();
  const root = configured ? path.resolve(configured) : path.join(path.resolve(String(modDir), "..", ".."), "_local");
  return path.join(root, "mods", dataId);
}

module.exports = { toSettingRow, flattenOver, validateRow, parseValueText, groupOf, manifestRowExtra, defaultDataDirOf };
