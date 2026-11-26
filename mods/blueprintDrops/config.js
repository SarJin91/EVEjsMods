"use strict";

const fs = require("node:fs");
const path = require("node:path");
const resonators = require("./lib/resonators");
const factionLoot = require("./lib/factionLoot");
const { DEFAULTS, NESTED_KEYS, mergeSettings } = require("./lib/settings");
const { IGNORE_ENV, overridePathOf, readOverrideFile } = require("./lib/settingsOverride");

const MOD_ID = "blueprintDrops";
const RESONATOR_FLAG_KEY = "resonatorsEnabled";
const FACTION_LOOT_FLAG_KEY = "factionLootEnabled";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function resolveDataDir(env, modDir) {
  const configured = String((env && env.EVEJS_DATA_ROOT) || "").trim();
  const root = configured ? path.resolve(configured)
    : path.join(path.resolve(modDir || __dirname, "..", ".."), "_local");
  return path.join(root, "mods", MOD_ID);
}

function readSettingsFile(modDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(modDir, "settings.json"), "utf8")) || {};
  } catch (_error) {
    return {};
  }
}

function scalarOverride(values) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (NESTED_KEYS.includes(key) || !hasOwn(values, key)) continue;
    const value = values[key];
    const kind = typeof DEFAULTS[key];
    if (typeof value === kind && (kind === "boolean" || (kind === "number" && Number.isFinite(value)))) {
      out[key] = value;
    }
  }
  return out;
}

function loadConfig({ env = process.env, modDir = __dirname, overrideValues, overrideFilePath } = {}) {
  const base = env || {};
  const warnings = [];
  let values;
  if (isPlainObject(overrideValues) && base[IGNORE_ENV] !== "1") {
    values = overrideValues;
  } else {
    const read = readOverrideFile(overrideFilePath || overridePathOf(resolveDataDir(base, modDir)), base);
    values = read.values;
    warnings.push(...read.warnings);
  }
  const over = scalarOverride(values);
  const file = readSettingsFile(modDir);
  const merged = mergeSettings({ ...(isPlainObject(file) ? file : {}), ...over });
  merged.resonatorsEnabled = hasOwn(over, RESONATOR_FLAG_KEY) ? over[RESONATOR_FLAG_KEY]
    : resonators.resolveResonatorFlag(merged, base);
  merged.factionLootEnabled = hasOwn(over, FACTION_LOOT_FLAG_KEY) ? over[FACTION_LOOT_FLAG_KEY]
    : factionLoot.resolveFactionLootFlag(merged, base);
  return { settings: merged, warnings };
}

module.exports = { MOD_ID, DEFAULTS, NESTED_KEYS, resolveDataDir, loadConfig };
