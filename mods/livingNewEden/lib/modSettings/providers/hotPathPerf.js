"use strict";

const { MOD_LOCKS } = require("../lockSpec");
const { flatRow, createFlatProvider, ROW_TYPES } = require("./flatKit");

const MOD_ID = "hotPathPerf";
const NEED = Object.freeze({ DEFAULTS: "object", ENV: "object", loadConfig: "function", resolveDataDir: "function" });
const CAP_EXPORT_OF = Object.freeze({
  tickStructuresMinIntervalMs: "TICK_STRUCTURES_MAX_INTERVAL_MS",
  structuresRefreshFreshMs: "TICK_STRUCTURES_MAX_INTERVAL_MS",
  schedulerMaxPending: "SCHEDULER_MAX_PENDING_CAP",
  schedulerRequestTimeoutMs: "SCHEDULER_REQUEST_TIMEOUT_CAP_MS",
  configSnapshotMemoRevalidateMs: "CONFIG_SNAPSHOT_MEMO_REVALIDATE_CAP_MS",
});

function defaultsRows(cfg, manifestFields, capExportOf) {
  const rows = [];
  for (const [key, def] of Object.entries(cfg.DEFAULTS)) {
    const env = typeof cfg.ENV[key] === "string" ? cfg.ENV[key] : null;
    const spec = { key, default: def, env };
    if (typeof def === "boolean") spec.type = "boolean";
    else if (typeof def === "number") {
      spec.type = Number.isInteger(def) ? "integer" : "number";
      spec.min = 0;
      const cap = capExportOf[key] ? cfg[capExportOf[key]] : undefined;
      if (Number.isFinite(cap)) spec.max = cap;
    } else spec.type = "string";
    rows.push(flatRow(spec, manifestFields, { preferManifest: true }));
  }
  return rows.filter((r) => ROW_TYPES.includes(r.type));
}

function createHotPathPerfProvider(deps) {
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
    rows: defaultsRows(cfg, manifest.fields, CAP_EXPORT_OF),
    envOf: (key) => (typeof cfg.ENV[key] === "string" ? [cfg.ENV[key]] : []),
    load: (overrideValues) => {
      const warnings = [];
      const warn = (m) => warnings.push(String(m));
      const values = cfg.loadConfig(overrideValues === null ? { env, modDir, warn }
        : { env, modDir, overrideValues, warn });
      return { values: { ...values }, warnings, errors: [] };
    },
    locks: MOD_LOCKS[MOD_ID],
  });
}

module.exports = { MOD_ID, NEED, defaultsRows, createHotPathPerfProvider };
