"use strict";

const fs = require("fs");
const path = require("path");
const { IGNORE_ENV: OVERRIDE_IGNORE_ENV, overridePathOf, readOverrideFile } = require("./lib/settingsOverride");

const DATA_ID = "scenePerfFix";

const DEFAULTS = Object.freeze({
  skipInertWrecks: true,
  inertKinds: ["wreck"],
  inertSpeedEpsilon: 0.001,
  cacheItemNameLookups: true,
  itemNameCacheMax: 5000,
  statsLogMinutes: 10,
});

const ENV = Object.freeze({
  skipInertWrecks: "EVEJS_SCENEPERF_SKIP_WRECKS",
  inertKinds: "EVEJS_SCENEPERF_INERT_KINDS",
  inertSpeedEpsilon: "EVEJS_SCENEPERF_INERT_SPEED",
  cacheItemNameLookups: "EVEJS_SCENEPERF_NAME_CACHE",
  itemNameCacheMax: "EVEJS_SCENEPERF_NAME_CACHE_MAX",
  statsLogMinutes: "EVEJS_SCENEPERF_STATS_MINUTES",
});

function parseValue(key, raw) {
  const def = DEFAULTS[key];
  if (typeof def === "boolean") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return def;
  }
  if (typeof def === "number") {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : def;
  }
  if (Array.isArray(def)) {
    const list = Array.isArray(raw) ? raw : String(raw).split(",");
    const clean = list.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
    return clean.length > 0 ? clean : def;
  }
  return def;
}

function resolveDataDir(env, modDir) {
  const configured = String((env && env.EVEJS_DATA_ROOT) || "").trim();
  const root = configured ? path.resolve(configured) : path.join(path.resolve(modDir, "..", ".."), "_local");
  return path.join(root, "mods", DATA_ID);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKind(value, def) {
  if (typeof def === "boolean") return typeof value === "boolean";
  if (typeof def === "number") return typeof value === "number" && Number.isFinite(value);
  if (Array.isArray(def)) return typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
  return false;
}

function overrideValuesOf(options, env) {
  if (isPlainObject(options.overrideValues) && env[OVERRIDE_IGNORE_ENV] !== "1") return options.overrideValues;
  return readOverrideFile(options.overrideFilePath
    || overridePathOf(resolveDataDir(env, options.modDir || __dirname)), env).values;
}

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const settingsPath = options.settingsPath || path.join(__dirname, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) || {};
  } catch (_error) {
    settings = {};
  }
  const over = overrideValuesOf(options, env);
  const config = {};
  for (const key of Object.keys(DEFAULTS)) {
    let value = DEFAULTS[key];
    if (Object.prototype.hasOwnProperty.call(settings, key)) value = parseValue(key, settings[key]);
    if (env[ENV[key]] !== undefined && env[ENV[key]] !== "") value = parseValue(key, env[ENV[key]]);
    if (Object.prototype.hasOwnProperty.call(over, key) && sameKind(over[key], DEFAULTS[key])) {
      value = parseValue(key, over[key]);
    }
    config[key] = value;
  }
  return Object.freeze(config);
}

module.exports = { DEFAULTS, ENV, loadConfig, resolveDataDir };
