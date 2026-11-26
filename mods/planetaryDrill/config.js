"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEYS = Object.freeze({
  enabled: "EVEJS_PDRILL_ENABLED",
  baseUnitsPerHour: "EVEJS_PDRILL_BASE_UNITS_PER_HOUR",
  cycleSeconds: "EVEJS_PDRILL_CYCLE_SECONDS",
  storageCycles: "EVEJS_PDRILL_STORAGE_CYCLES",
  maxPerSystem: "EVEJS_PDRILL_MAX_PER_SYSTEM",
  maxPerCorporation: "EVEJS_PDRILL_MAX_PER_CORPORATION",
  launchTypeID: "EVEJS_PDRILL_LAUNCH_TYPE_ID",
  drillItemsOnly: "EVEJS_PDRILL_DRILL_ITEMS_ONLY",
});

const DEFAULTS = Object.freeze({
  enabled: false,
  baseUnitsPerHour: 20000,
  cycleSeconds: 3600,
  storageCycles: 168,
  maxPerSystem: 3,
  maxPerCorporation: 10,
  launchTypeID: 340100,
  drillItemsOnly: false,
});

const BOOLEAN_FIELDS = Object.freeze(["enabled", "drillItemsOnly"]);

const LAUNCH_TYPE_RANGE = Object.freeze([340000, 349999]);

const INTEGER_RANGES = Object.freeze({
  baseUnitsPerHour: Object.freeze([1, 10000000]),
  cycleSeconds: Object.freeze([60, 86400]),
  storageCycles: Object.freeze([1, 10000]),
  maxPerSystem: Object.freeze([0, 1000]),
  maxPerCorporation: Object.freeze([0, 100000]),
});

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

function parseInteger(value, [min, max]) {
  const text = String(value).trim();
  if (!/^-?\d+$/u.test(text)) return { ok: false };
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) return { ok: false };
  return { ok: true, value: number };
}

const { IGNORE_ENV: OVERRIDE_IGNORE_ENV, overridePathOf, readOverrideFile } = require("./lib/settingsOverride");

const OVERRIDE_DATA_ID = "planetaryDrill";

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

  for (const [field, range] of Object.entries(INTEGER_RANGES)) {
    const key = KEYS[field];
    const raw = pick(key);
    if (isBlank(raw)) {
      values[field] = DEFAULTS[field];
      continue;
    }
    const parsed = parseInteger(raw, range);
    if (!parsed.ok) {
      problems.push(`${key} must be an integer ${range[0]}..${range[1]}, got ${JSON.stringify(String(raw))}`);
      values[field] = DEFAULTS[field];
      continue;
    }
    values[field] = parsed.value;
  }

  {
    const key = KEYS.launchTypeID;
    const raw = pick(key);
    values.launchTypeID = DEFAULTS.launchTypeID;
    if (!isBlank(raw)) {
      const parsed = parseInteger(raw, [0, LAUNCH_TYPE_RANGE[1]]);
      if (!parsed.ok || (parsed.value !== 0 && parsed.value < LAUNCH_TYPE_RANGE[0])) {
        problems.push(`${key} must be 0 (off) or an integer ${LAUNCH_TYPE_RANGE[0]}..${LAUNCH_TYPE_RANGE[1]}, got ${JSON.stringify(String(raw))}`);
      } else {
        values.launchTypeID = parsed.value;
      }
    }
  }

  return Object.freeze({ ...values, problems: Object.freeze(problems) });
}

module.exports = {
  BOOLEAN_FIELDS,
  DEFAULTS,
  INTEGER_RANGES,
  KEYS,
  LAUNCH_TYPE_RANGE,
  load,
  parseBoolean,
  parseInteger,
  readEnvFile,
  resolveDataDir,
};
