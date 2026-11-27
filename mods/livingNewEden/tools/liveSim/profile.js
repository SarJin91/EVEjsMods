"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { SCHEMA, ENV_PREFIX, loadConfig, resolveConfig, parseEnvFile, parseSettingsJson } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const WARN_NAMES_MAX = 20;
const DANGER_GROUP = "Danger";
const MODULE_KEY_RE = /^modules\.([A-Za-z]+)\.enabled$/;
const NO_SETTINGS_FILE = "liveSim.no-settings.json";
const NO_ENV_FILE = "liveSim.no-env";

const FORCED_OFF = Object.freeze([
  Object.freeze({ key: "modules.presence.enabled", reason: "the session registry of EveJS (players), as benchCampaign" }),
  Object.freeze({ key: "standings.enabled", reason: "standing writes into EveJS characters, as benchCampaign" }),
  Object.freeze({ key: "trade.enabled", reason: "contracts and wallets of EveJS, as benchCampaign" }),
  Object.freeze({ key: "trade.cleanupOnDisable", reason: "no EveJS orphans to clean, as benchCampaign" }),
  Object.freeze({ key: "trade.externalPriceEnabled", reason: "no network, as benchCampaign" }),
  Object.freeze({ key: "testing.accelerationEnabled", reason: "the scaled clock speeds up the trips already" }),
  Object.freeze({ key: "alerts.enabled", reason: "webhook (network, a secret of .env)" }),
  Object.freeze({ key: "gameMaster.aiEnabled",
    reason: "no network: the Game Master proposes from its arc templates (LLM lane plot off)" }),
]);

const FEATURE_OFF = Object.freeze([
  Object.freeze({ key: "crews.enabled", reason: "spawns EveJS NPC crews" }),
  Object.freeze({ key: "notices.enabled", reason: "player notices (EveJS mail / chat)" }),
  Object.freeze({ key: "frontChat.enabled", reason: "EveJS chat" }),
  Object.freeze({ key: "frontJobs.enabled", reason: "player jobs (EveJS)" }),
  Object.freeze({ key: "localPilots.enabled", reason: "local chat pilots (EveJS)" }),
  Object.freeze({ key: "localContacts.enabled", reason: "local contacts (EveJS)" }),
  Object.freeze({ key: "miningEncounters.enabled", reason: "spawns at player miners (EveJS)" }),
  Object.freeze({ key: "ambientRats.enabled", reason: "spawns EveJS rats" }),
  Object.freeze({ key: "heavyEvents.enabled", reason: "spawns EveJS event fleets" }),
  Object.freeze({ key: "fleetExposure.enabled", reason: "players near fleets (EveJS)" }),
  Object.freeze({ key: "capsuleers.enabled", reason: "player capsuleers (EveJS)" }),
]);

const SEAMLESS_OFF = Object.freeze([
  Object.freeze({ key: "world.beltNavy.standingAggroEnabled",
    reason: "beltNavy: no belt scene / hunt / spawn seam in liveAdapter (BELT_NAVY_SEAM_UNAVAILABLE)" }),
  Object.freeze({ key: "playerSiege.enabled",
    reason: "playerSiege: no player structure seam in liveAdapter (PLAYER_STRUCTURES_SEAM_UNAVAILABLE)" }),
  Object.freeze({ key: "sentries.enabled", reason: "sentries: no sentry seam in liveAdapter (SENTRY_SEAM_UNAVAILABLE)" }),
]);

function dangerModuleKeys(schema = SCHEMA) {
  return schema.filter((r) => MODULE_KEY_RE.test(r.key) && r.launcher && r.launcher.group === DANGER_GROUP)
    .map((r) => r.key);
}

function getPath(obj, key) {
  return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function setPath(obj, key, value) {
  const parts = key.split(".");
  let o = obj;
  for (const k of parts.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = value;
}

function refusal(reason, detail) {
  return { ok: false, reason, detail: String(detail) };
}

function readOptional(filePath, label) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, "utf8") };
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, text: null };
    return { ok: false, error: `${label}: could not be read (${(err && err.message) || err})` };
  }
}

function namesList(names) {
  const shown = names.slice(0, WARN_NAMES_MAX).join(", ");
  return names.length > WARN_NAMES_MAX ? `${shown}, +${names.length - WARN_NAMES_MAX}` : shown;
}

function mergeComposeEnvFile(composeEnv, entries, envFile, setEnvNames) {
  const list = Array.isArray(entries) ? entries
    : Object.entries(composeEnv || {}).map(([name, value]) => ({ name, value: String(value), fixed: false }));
  const file = envFile || {};
  const setNames = setEnvNames instanceof Set ? setEnvNames : new Set();
  const has = (k) => Object.prototype.hasOwnProperty.call(file, k);
  const layer = {};
  const ignoredFixed = [];
  const known = new Set();
  for (const e of list) {
    known.add(e.name);
    const fromFile = has(e.name) ? String(file[e.name]) : "";
    let value;
    if (e.fixed) {
      value = e.value;
      if (fromFile !== "" && fromFile !== e.value) ignoredFixed.push(e.name);
    } else {
      value = fromFile !== "" ? fromFile : e.value;
    }
    if (value !== "") layer[e.name] = value;
  }
  const skipped = Object.keys(file).filter((k) => k.startsWith(ENV_PREFIX) && !known.has(k) && !setNames.has(k));
  return { layer, skipped: skipped.sort(), ignoredFixed: ignoredFixed.sort() };
}

function loadWithCompose(o) {
  try {
    const fileErrors = [];
    const warnings = [];
    let settings = {};
    let envFile = {};
    const settingsRead = readOptional(o.settingsFilePath, "settings.json");
    if (!settingsRead.ok) fileErrors.push(settingsRead.error);
    else if (settingsRead.text !== null) {
      const parsed = parseSettingsJson(settingsRead.text);
      if (parsed.ok) settings = parsed.values;
      else fileErrors.push(parsed.error);
    }
    const envRead = readOptional(o.envFilePath, ".env");
    if (!envRead.ok) fileErrors.push(envRead.error);
    else if (envRead.text !== null) {
      const parsed = parseEnvFile(envRead.text);
      envFile = parsed.values;
      warnings.push(...parsed.warnings);
    }
    const merged = mergeComposeEnvFile(o.composeEnv, o.composeEntries || null, envFile, new Set(Object.keys(o.env || {})));
    if (merged.skipped.length > 0) {
      warnings.push(`env-file: ${merged.skipped.length} ${ENV_PREFIX}* keys outside compose environment: skipped as on `
        + `Docker (${namesList(merged.skipped)})`);
    }
    if (merged.ignoredFixed.length > 0) {
      warnings.push(`env-file: ${merged.ignoredFixed.length} keys fixed in compose: compose value kept as on Docker `
        + `(${namesList(merged.ignoredFixed)})`);
    }
    const result = resolveConfig({ settings, envFile: merged.layer, env: o.env, modDir: o.modDir, fileErrors });
    return { ...result, warnings: [...warnings, ...result.warnings] };
  } catch (err) {
    return { ok: false, errors: [`config_internal: ${(err && err.message) || err}`] };
  }
}

function buildLiveConfig(opts, deps) {
  const modDir = deps.modDir || MOD_DIR;
  const composeEnv = opts.composeEnv && typeof opts.composeEnv === "object" ? opts.composeEnv : null;
  const composeEntries = Array.isArray(opts.composeEntries) ? opts.composeEntries : null;
  const load = typeof deps.loadConfigFn === "function" ? deps.loadConfigFn
    : (composeEnv ? (o) => loadWithCompose({ ...o, composeEnv, composeEntries }) : loadConfig);
  const setEnv = {};
  for (const [key, value] of Object.entries(opts.set || {})) {
    const row = SCHEMA.find((r) => r.key === key);
    if (!row || !row.env) return refusal("CONFIG_UNKNOWN_KEY", key);
    setEnv[row.env] = String(value);
  }
  const loaded = load({ modDir, env: setEnv,
    settingsFilePath: opts.settings ? path.resolve(opts.settings) : path.join(deps.dataDir, NO_SETTINGS_FILE),
    envFilePath: opts.envFile ? path.resolve(opts.envFile) : path.join(deps.dataDir, NO_ENV_FILE) });
  if (!loaded || loaded.ok !== true) {
    return refusal("CONFIG_INVALID", ((loaded && loaded.errors) || ["no result"]).join("; "));
  }
  const config = JSON.parse(JSON.stringify(loaded.config));
  const forced = [];
  const force = (key, value, reason) => {
    const before = getPath(config, key);
    if (before === value) return;
    setPath(config, key, value);
    forced.push(`liveSim: forced ${key}=${value === "" ? '""' : value} (${reason})`);
  };
  force("dataDir", path.resolve(deps.dataDir), "separate folder");
  force("observer.enabled", true, "the observer of the simulation");
  force("observer.host", "127.0.0.1", "localhost only (a Docker .env has 0.0.0.0)");
  const portRow = SCHEMA.find((r) => r.key === "observer.port");
  force("observer.port", opts.port === null || opts.port === undefined ? portRow.default : opts.port, "--port");
  for (const row of FORCED_OFF) force(row.key, false, row.reason);
  for (const key of dangerModuleKeys()) force(key, false, "Danger: the bench adapter has no seam for it");
  force("backup.dir", "", "<dataDir>/backups (a Docker path does not exist here)");
  for (const row of FEATURE_OFF) force(row.key, false, row.reason);
  for (const row of SEAMLESS_OFF) force(row.key, false, row.reason);
  return { ok: true, config, warnings: [...loaded.warnings], forced,
    configResult: Object.freeze({ ...loaded, config }) };
}

module.exports = { buildLiveConfig, loadWithCompose, mergeComposeEnvFile, dangerModuleKeys, FORCED_OFF, FEATURE_OFF, SEAMLESS_OFF };
