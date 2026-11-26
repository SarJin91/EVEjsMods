"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEYS = Object.freeze({
  enabled: "EVEJS_INDUSTRY_ORPHAN_CLEANUP",
  log: "EVEJS_INDUSTRY_ORPHAN_CLEANUP_LOG",
});

const DEFAULTS = Object.freeze({
  enabled: true,
  log: true,
});

const BOOLEAN_FIELDS = Object.freeze(["enabled", "log"]);

function readEnvFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return {};
  }
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ["\"", "'"].includes(value[0]) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function parseBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return { ok: true, value: true };
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return { ok: true, value: false };
  return { ok: false };
}

const { IGNORE_ENV: OVERRIDE_IGNORE_ENV, overridePathOf, readOverrideFile } = require("./lib/settingsOverride");

const OVERRIDE_DATA_ID = "industryOrphanCleanup";

function resolveDataDir(env, modDir) {
  const configured = String((env && env.EVEJS_DATA_ROOT) || "").trim();
  const root = configured ? path.resolve(configured)
    : path.join(path.resolve(modDir || __dirname, "..", ".."), "_local");
  return path.join(root, "mods", OVERRIDE_DATA_ID);
}

function overrideEnvOf(modDir, env, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const preview = opts.overrideValues !== null && typeof opts.overrideValues === "object"
    && !Array.isArray(opts.overrideValues) && env[OVERRIDE_IGNORE_ENV] !== "1";
  const values = preview ? opts.overrideValues
    : readOverrideFile(opts.overrideFilePath || overridePathOf(resolveDataDir(env, modDir)), env).values;
  const out = {};
  for (const field of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(values, field) || typeof KEYS[field] !== "string") continue;
    const value = values[field];
    const kind = typeof DEFAULTS[field];
    if (typeof value === kind && (kind === "boolean" || (kind === "number" && Number.isFinite(value)))) {
      out[KEYS[field]] = String(value);
    }
  }
  return out;
}

function load(modDir, environment = process.env, options = {}) {
  const env = environment || {};
  const fileValues = readEnvFile(path.join(modDir, ".env"));
  const overEnv = overrideEnvOf(modDir, env, options);
  const pick = (key) => (!isBlank(overEnv[key]) ? overEnv[key] : !isBlank(env[key]) ? env[key] : fileValues[key]);
  const problems = [];
  const values = {};

  for (const field of BOOLEAN_FIELDS) {
    const key = KEYS[field];
    const raw = pick(key);
    if (isBlank(raw)) {
      values[field] = DEFAULTS[field];
      continue;
    }
    const parsed = parseBoolean(raw);
    if (!parsed.ok) {
      problems.push(`${key} must be a boolean (1/0, true/false, on/off), got ${JSON.stringify(String(raw))}`);
      values[field] = DEFAULTS[field];
      continue;
    }
    values[field] = parsed.value;
  }

  return Object.freeze({ ...values, problems: Object.freeze(problems) });
}

module.exports = {
  BOOLEAN_FIELDS,
  DEFAULTS,
  KEYS,
  load,
  parseBoolean,
  readEnvFile,
  resolveDataDir,
};
