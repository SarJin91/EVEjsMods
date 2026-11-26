"use strict";

const { LOCK, MOD_LOCKS } = require("../lockSpec");
const { flatRow, createFlatProvider, ROW_TYPES } = require("./flatKit");

const MOD_ID = "blueprintDrops";
const NEED = Object.freeze({ DEFAULTS: "object", NESTED_KEYS: "array", loadConfig: "function",
  resolveDataDir: "function" });
const RESONATOR_FLAG_KEY = "resonatorsEnabled";
const RESONATOR_ENV = "EVEJS_BPDROPS_RESONATORS_ENABLED";
const ENV_OF_KEY = Object.freeze({ [RESONATOR_FLAG_KEY]: RESONATOR_ENV,
  factionLootEnabled: "EVEJS_BPDROPS_FACTION_LOOT_ENABLED" });
const envNameOf = (key) => (Object.prototype.hasOwnProperty.call(ENV_OF_KEY, key) ? ENV_OF_KEY[key] : null);
const CHANCE_KEYS = Object.freeze(["componentChance", "resonatorEliteChance", "componentCtrEliteChance"]);
const INTEGER_RANGES = Object.freeze({
  copyMaxRuns: Object.freeze({ min: 1 }),
  copyMaxMaterialEfficiency: Object.freeze({ min: 0, max: 10 }),
  copyMaxTimeEfficiency: Object.freeze({ min: 0, max: 20 }),
  resonatorSummaryEvery: Object.freeze({ min: 0 }),
  resonatorEliteQuantityMultiplier: Object.freeze({ min: 1 }),
  factionLootMaxEntriesPerWreck: Object.freeze({ min: 0, max: 6 }),
  factionLootRareCapPerHour: Object.freeze({ min: 0 }),
  factionLootSummaryEvery: Object.freeze({ min: 0 }),
  factionLootFillerMaxEntries: Object.freeze({ min: 0, max: 6 }),
  factionLootEpicCapPerHour: Object.freeze({ min: 0 }),
});

const isChanceKey = (key) => /^chance/.test(key) || /Share$/.test(key) || CHANCE_KEYS.includes(key);

function rowsOf(cfg) {
  const rows = [];
  for (const [key, def] of Object.entries(cfg.DEFAULTS)) {
    const env = envNameOf(key);
    const spec = { key, default: def, env };
    if (cfg.NESTED_KEYS.includes(key)) spec.type = "string";
    else if (typeof def === "boolean") spec.type = "boolean";
    else if (typeof def !== "number") continue;
    else if (Object.prototype.hasOwnProperty.call(INTEGER_RANGES, key)) {
      Object.assign(spec, { type: "integer", ...INTEGER_RANGES[key] });
    } else if (isChanceKey(key)) Object.assign(spec, { type: "number", min: 0, max: 1 });
    else Object.assign(spec, { type: "number", min: 0 });
    rows.push(flatRow(spec, null));
  }
  return rows.filter((r) => ROW_TYPES.includes(r.type));
}

function locksOf(cfg) {
  const base = MOD_LOCKS[MOD_ID];
  const keys = { ...base.keys };
  for (const key of cfg.NESTED_KEYS) if (!keys[key]) keys[key] = LOCK.UNSUPPORTED_TYPE;
  return Object.freeze({ ...base, keys: Object.freeze(keys) });
}

function createBlueprintDropsProvider(deps) {
  const loaded = deps && deps.loaded;
  if (!loaded || loaded.ok !== true || !loaded.exports) {
    return { ok: false, reason: (loaded && loaded.reason) || "CONFIG_MISSING" };
  }
  const cfg = loaded.exports;
  const env = deps.env || process.env;
  const modDir = loaded.modDir;
  const manifest = loaded.manifest || { displayName: null, fields: {} };
  return createFlatProvider({
    modId: MOD_ID,
    title: manifest.displayName || MOD_ID,
    dataDir: cfg.resolveDataDir(env, modDir),
    env,
    rows: rowsOf(cfg),
    envOf: (key) => (envNameOf(key) ? [envNameOf(key)] : []),
    load: (overrideValues) => {
      const r = cfg.loadConfig(overrideValues === null ? { env, modDir } : { env, modDir, overrideValues });
      return { values: { ...r.settings }, warnings: [...r.warnings], errors: [] };
    },
    locks: locksOf(cfg),
  });
}

module.exports = { MOD_ID, NEED, createBlueprintDropsProvider };
