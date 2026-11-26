"use strict";

const { MOD_LOCKS } = require("../lockSpec");
const { flatRow, createFlatProvider } = require("./flatKit");

const MOD_ID = "npcKillsGiveSp";
const NEED = Object.freeze({ DEFAULTS: "object", ENV_KEYS: "object", NUMERIC_RULES: "object", BOOLEAN_KEYS: "array",
  loadConfig: "function", resolveDataDir: "function" });

function rowsOf(cfg, manifestFields) {
  const rows = [];
  for (const [key, def] of Object.entries(cfg.DEFAULTS)) {
    const env = typeof cfg.ENV_KEYS[key] === "string" ? cfg.ENV_KEYS[key] : null;
    const rule = Object.prototype.hasOwnProperty.call(cfg.NUMERIC_RULES, key) ? cfg.NUMERIC_RULES[key] : null;
    if (cfg.BOOLEAN_KEYS.includes(key)) {
      rows.push(flatRow({ key, default: def, env, type: "boolean" }, manifestFields));
    } else if (rule) {
      const spec = { key, default: def, env, type: rule.integer ? "integer" : "number" };
      if (Number.isFinite(rule.min)) spec.min = rule.min;
      if (Number.isFinite(rule.max) && rule.max !== Number.MAX_SAFE_INTEGER) spec.max = rule.max;
      rows.push(flatRow(spec, manifestFields));
    }
  }
  return rows;
}

function createNpcKillsGiveSpProvider(deps) {
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
    rows: rowsOf(cfg, manifest.fields),
    envOf: (key) => (typeof cfg.ENV_KEYS[key] === "string" ? [cfg.ENV_KEYS[key]] : []),
    load: (overrideValues) => {
      const r = cfg.loadConfig(overrideValues === null ? { env, modDir } : { env, modDir, overrideValues });
      return { values: r.config, sources: r.sources, warnings: [...r.warnings], errors: [...r.errors] };
    },
    locks: MOD_LOCKS[MOD_ID],
  });
}

module.exports = { MOD_ID, NEED, createNpcKillsGiveSpProvider };
