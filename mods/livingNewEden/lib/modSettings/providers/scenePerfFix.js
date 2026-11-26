"use strict";

const { MOD_LOCKS } = require("../lockSpec");
const { createFlatProvider } = require("./flatKit");
const { defaultsRows } = require("./hotPathPerf");

const MOD_ID = "scenePerfFix";
const NEED = Object.freeze({ DEFAULTS: "object", ENV: "object", loadConfig: "function", resolveDataDir: "function" });
const NO_CAPS = Object.freeze({});

function createScenePerfFixProvider(deps) {
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
    rows: defaultsRows(cfg, manifest.fields, NO_CAPS),
    envOf: (key) => (typeof cfg.ENV[key] === "string" ? [cfg.ENV[key]] : []),
    load: (overrideValues) => {
      const values = cfg.loadConfig(overrideValues === null ? { env, modDir } : { env, modDir, overrideValues });
      return { values: { ...values }, warnings: [], errors: [] };
    },
    locks: MOD_LOCKS[MOD_ID],
  });
}

module.exports = { MOD_ID, NEED, createScenePerfFixProvider };
