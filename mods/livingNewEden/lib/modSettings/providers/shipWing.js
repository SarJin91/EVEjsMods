"use strict";

const { SHIP_WING_LOCKS, createLocks } = require("../locks");
const { flattenOver, validateRow, toSettingRow, groupOf } = require("./rowKit");

const MOD_ID = "shipWing";
const TITLE = "Ship Wing";
const APPLY_RESTART = "restart";
const TYPE_OF = Object.freeze({ bool: "boolean", int: "integer", enum: "enum", trigger: "string", hashList: "string" });

function createShipWingProvider(deps) {
  const loaded = deps && deps.loaded;
  if (!loaded || loaded.ok !== true || !loaded.exports) {
    return { ok: false, reason: (loaded && loaded.reason) || "CONFIG_MISSING" };
  }
  const cfg = loaded.exports;
  if (!Array.isArray(cfg.SCHEMA) || typeof cfg.loadConfig !== "function" || typeof cfg.resolveDataDir !== "function") {
    return { ok: false, reason: "CONFIG_SHAPE" };
  }
  const env = deps.env || process.env;
  const modDir = loaded.modDir;
  const schema = cfg.SCHEMA;
  const keys = schema.map((r) => r.key);
  const locks = createLocks(SHIP_WING_LOCKS);
  const byKey = new Map(schema.map((r) => [r.key, r]));
  let rowsMemo = null;

  function rows() {
    if (rowsMemo === null) {
      rowsMemo = Object.freeze(schema.map((r) => toSettingRow(r, { type: TYPE_OF[r.type] || "string",
        group: groupOf(r.key), label: null, description: null, secret: locks.isSecret(r) })));
    }
    return rowsMemo;
  }

  function resolve(overrides) {
    const r = cfg.loadConfig({ env, modDir, overrideValues: overrides && typeof overrides === "object" ? overrides : {} });
    return { ok: r.ok === true, values: flattenOver(r.config, keys, false), sources: { ...r.sources },
      warnings: [...r.warnings], errors: [...r.errors] };
  }

  function current() {
    const r = cfg.loadConfig({ env, modDir });
    return flattenOver(r.config, keys, false);
  }

  function validate(key, value) {
    const row = byKey.get(key);
    if (!row) return { ok: false, reason: "UNKNOWN_KEY" };
    return validateRow({ type: TYPE_OF[row.type] || "string", min: row.min, max: row.max, values: row.values }, value);
  }

  return { ok: true, provider: Object.freeze({
    modId: MOD_ID,
    title: TITLE,
    dataDir: cfg.resolveDataDir(env, modDir),
    rows,
    resolve,
    current,
    validate,
    locked: (key) => locks.locked(byKey.get(key) || null),
    apply: () => APPLY_RESTART,
  }) };
}

module.exports = { MOD_ID, createShipWingProvider };
