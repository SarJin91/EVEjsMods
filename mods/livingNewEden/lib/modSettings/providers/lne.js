"use strict";

const path = require("node:path");

const configModule = require("../../../config");
const { LNE_LOCKS, createLocks } = require("../locks");
const { flattenOver, validateRow, toSettingRow } = require("./rowKit");

const MOD_ID = "livingNewEden";
const TITLE = "Living New Eden";
const APPLY_RESTART = "restart";
const TYPE_OF = Object.freeze({ boolean: "boolean", integer: "integer", number: "number", string: "string" });

function createLneProvider(deps = {}) {
  const modDir = deps.modDir || path.resolve(__dirname, "..", "..", "..");
  const env = deps.env || process.env;
  const loadConfig = typeof deps.loadConfig === "function" ? deps.loadConfig : configModule.loadConfig;
  const schema = configModule.SCHEMA;
  const locks = createLocks(LNE_LOCKS);
  const byKey = new Map(schema.map((row) => [row.key, row]));
  const dataDir = deps.config && typeof deps.config.dataDir === "string" ? deps.config.dataDir
    : configModule.resolveDataDir(env, modDir);
  let rowsMemo = null;

  function rows() {
    if (rowsMemo === null) {
      rowsMemo = Object.freeze(schema.map((row) => toSettingRow(row, {
        type: TYPE_OF[row.type] || "string",
        group: (row.launcher && row.launcher.group) || row.key.split(".")[0],
        label: row.launcher && row.launcher.label ? row.launcher.label : null,
        description: row.launcher && row.launcher.description ? row.launcher.description : null,
        step: row.launcher && row.launcher.step !== undefined ? row.launcher.step : undefined,
        secret: locks.isSecret(row),
      })));
    }
    return rowsMemo;
  }

  function resolve(overrides) {
    const r = loadConfig({ modDir, env, overrideValues: overrides && typeof overrides === "object" ? overrides : {} });
    return { ok: r.ok === true, values: flattenOver(r.config, schema.map((row) => row.key), true),
      sources: { ...r.sources }, warnings: [...r.warnings], errors: [...r.errors],
      config: r.config };
  }

  function flatten(config) {
    return flattenOver(config, schema.map((row) => row.key), true);
  }

  function validate(key, value) {
    const row = byKey.get(key);
    if (!row) return { ok: false, reason: "UNKNOWN_KEY" };
    return validateRow({ type: TYPE_OF[row.type] || "string", min: row.min, max: row.max }, value);
  }

  return { ok: true, provider: Object.freeze({
    modId: MOD_ID,
    title: TITLE,
    dataDir,
    rows,
    resolve,
    flatten,
    validate,
    locked: (key) => locks.locked(byKey.get(key) || null),
    apply: () => APPLY_RESTART,
  }) };
}

module.exports = { MOD_ID, createLneProvider };
