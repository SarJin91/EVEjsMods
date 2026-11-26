"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WORMHOLE_REGION_ID_MIN = 11000000;

const KEYS = Object.freeze({
  enabled: "EVEJS_MARKET_ALL_REGIONS",
  maxForeignRowsPerSide: "EVEJS_MARKET_ALL_REGIONS_MAX_FOREIGN_ROWS",
  cacheTtlMs: "EVEJS_MARKET_ALL_REGIONS_CACHE_TTL_MS",
  cacheMaxTypes: "EVEJS_MARKET_ALL_REGIONS_CACHE_MAX_TYPES",
  fanoutConcurrency: "EVEJS_MARKET_ALL_REGIONS_CONCURRENCY",
  includeWormholeRegions: "EVEJS_MARKET_ALL_REGIONS_INCLUDE_WORMHOLE",
  errorLogIntervalMs: "EVEJS_MARKET_ALL_REGIONS_ERROR_LOG_INTERVAL_MS",
  verbose: "EVEJS_MARKET_ALL_REGIONS_VERBOSE",
});

const DEFAULTS = Object.freeze({
  enabled: true,
  maxForeignRowsPerSide: 150,
  cacheTtlMs: 60000,
  cacheMaxTypes: 200,
  fanoutConcurrency: 8,
  includeWormholeRegions: false,
  errorLogIntervalMs: 60000,
  verbose: false,
});

const LIMITS = Object.freeze({
  maxForeignRowsPerSide: Object.freeze({ min: 0, max: 5000 }),
  cacheTtlMs: Object.freeze({ min: 0, max: 600000 }),
  cacheMaxTypes: Object.freeze({ min: 1, max: 100000 }),
  fanoutConcurrency: Object.freeze({ min: 1, max: 64 }),
  errorLogIntervalMs: Object.freeze({ min: 0, max: 3600000 }),
});

const BOOLEAN_FIELDS = Object.freeze(["enabled", "includeWormholeRegions", "verbose"]);

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

const OVERRIDE_DATA_ID = "marketAllRegions";

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

  for (const [field, range] of Object.entries(LIMITS)) {
    const key = KEYS[field];
    const raw = pick(key);
    if (isBlank(raw)) {
      values[field] = DEFAULTS[field];
      continue;
    }
    const numeric = Number(String(raw).trim());
    if (!Number.isInteger(numeric) || numeric < range.min || numeric > range.max) {
      problems.push(`${key} must be an integer between ${range.min} and ${range.max}, got ${JSON.stringify(String(raw))}`);
      values[field] = DEFAULTS[field];
      continue;
    }
    values[field] = numeric;
  }

  return Object.freeze({ ...values, problems: Object.freeze(problems) });
}

module.exports = {
  BOOLEAN_FIELDS,
  DEFAULTS,
  KEYS,
  LIMITS,
  WORMHOLE_REGION_ID_MIN,
  load,
  parseBoolean,
  readEnvFile,
  resolveDataDir,
};
