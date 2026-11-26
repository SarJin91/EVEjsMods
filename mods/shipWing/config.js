"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { OVERRIDE_FILE_NAME, IGNORE_ENV: OVERRIDE_IGNORE_ENV, overridePathOf, readOverrideFile } =
  require("./lib/settingsOverride");

const MOD_ID = "shipWing";
const SOURCE_OVERRIDE = "override";
const MAX_OVERRIDE_UNKNOWN_WARNINGS = 10;
const OVERRIDE_KEY_SHOWN_CHARS = 80;
const ENV_PREFIX = "EVEJS_SHIPWING_";
const STATE_FILE_NAME = "wings.json";
const CLIENT_WINDOW_POLL_MIN_MS = 1000;
const ORDER_RANGE_OVER_CONTROL_M = 15000;

function row(key, type, def, extra = {}) {
  const env = ENV_PREFIX + key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  return Object.freeze({ key, env, type, def, ...extra });
}

const SCHEMA = Object.freeze([
  row("enabled", "bool", false),
  row("maxWingPerPilot", "int", 2, { min: 1, max: 10 }),
  row("controlRangeMeters", "int", 20000, { min: 1000, max: 250000 }),
  row("outOfRangeGraceMs", "int", 10000, { min: 0, max: 600000 }),
  row("launchOffsetMeters", "int", 500, { min: 0, max: 50000 }),
  row("followRangeMeters", "int", 1500, { min: 0, max: 100000 }),
  row("followRetuneMs", "int", 1000, { min: 100, max: 60000 }),
  row("recallRangeMeters", "int", 2500, { min: 0, max: 100000 }),
  row("recallTimeoutMs", "int", 60000, { min: 1000, max: 3600000 }),
  row("tickIntervalMs", "int", 500, { min: 50, max: 10000 }),
  row("tickBudgetMs", "int", 2, { min: 1, max: 1000 }),
  row("commandCooldownMs", "int", 2000, { min: 0, max: 60000 }),
  row("guardMaxScannedIds", "int", 4096, { min: 1, max: 100000 }),
  row("guardErrorLogIntervalMs", "int", 60000, { min: 1000, max: 3600000 }),
  row("telemetryIntervalMs", "int", 600000, { min: 10000, max: 86400000 }),
  row("chatTrigger", "trigger", "!wing"),
  row("clientWindowEnabled", "bool", false),
  row("clientWindowStateMinIntervalMs", "int", 1000, { min: 100, max: 60000 }),
  row("clientWindowMaxCommandsPerSecond", "int", 5, { min: 1, max: 50 }),
  row("clientWindowMaxShipsPerCommand", "int", 20, { min: 1, max: 100 }),
  row("clientWindowReportMinIntervalMs", "int", 60000, { min: 1000, max: 3600000 }),
  row("clientWindowOpenMinIntervalMs", "int", 1000, { min: 0, max: 60000 }),
  row("clientWindowPollMs", "int", 5000, { min: 0, max: 60000 }),
  row("clientWindowHpRefreshMs", "int", 1000, { min: 250, max: 10000 }),
  row("clientWindowRowReasonMs", "int", 8000, { min: 1000, max: 60000 }),
  row("clientWindowAutoOpen", "bool", true),
  row("clientWindowMaxRows", "int", 30, { min: 10, max: 100 }),
  row("clientWindowActiveChars", "int", 24, { min: 0, max: 60 }),
  row("hpWarnPct", "int", 90, { min: 1, max: 99 }),
  row("hpCriticalPct", "int", 50, { min: 1, max: 99 }),
  row("clientWindowButtonColors", "bool", true),
  row("clientWindowEventMinIntervalMs", "int", 1000, { min: 0, max: 60000 }),
  row("clientWindowOpenAtLoginEnabled", "bool", true),
  row("clientWindowLoginOpenDelayMs", "int", 3000, { min: 0, max: 30000 }),
  row("uiPrefsMaxPilots", "int", 4096, { min: 1, max: 100000 }),
  row("clientWindowHandshakeHashes", "hashList",
    Object.freeze(["7aaa72247049b38d3f656f3b2c602877a8bcf0d9ff0af68f1795ff1327565ba7"]), { min: 1, max: 8 }),
  row("durableWreck", "bool", true),
  row("conditionWriteBack", "bool", true),
  row("lossSettleRetryMs", "int", 5000, { min: 500, max: 600000 }),
  row("lossSettleMaxAttempts", "int", 20, { min: 1, max: 1000 }),
  row("lossRecordRetentionMs", "int", 30000, { min: 5000, max: 3600000 }),
  row("lossSkipInsurance", "bool", true),
  row("lossOnMissingTwin", "bool", true),
  row("miningEnabled", "bool", false),
  row("commandMirrorEnabled", "bool", false),
  row("commandMirrorReturnEnabled", "bool", false),
  row("commandMirrorEngageEnabled", "bool", true),
  row("commandMirrorEngageCopyDefault", "bool", false),
  row("miningSearchRangeMeters", "int", 15000, { min: 1000, max: 100000 }),
  row("miningOrderRangeMeters", "int", 30000, { min: 1000, max: 250000 }),
  row("miningRangeBufferMeters", "int", 500, { min: 0, max: 10000 }),
  row("miningClaimPenaltyMeters", "int", 2000, { min: 0, max: 50000 }),
  row("miningMaxSeeksPerTick", "int", 2, { min: 1, max: 50 }),
  row("miningUnloadAtPercent", "int", 95, { min: 10, max: 100 }),
  row("miningTransferRangeMeters", "int", 2500, { min: 500, max: 20000 }),
  row("miningSeekRetryMs", "int", 10000, { min: 1000, max: 600000 }),
  row("miningFullRetryMs", "int", 30000, { min: 1000, max: 600000 }),
  row("miningLedgerEnabled", "bool", true),
  row("miningOverflowCanEnabled", "bool", true),
  row("miningOverflowMaxCansPerOwner", "int", 3, { min: 1, max: 20 }),
  row("miningOverflowCanLifetimeMs", "int", 7200000, { min: 600000, max: 86400000 }),
  row("miningOverflowCanMinRemainingMs", "int", 600000, { min: 0, max: 3600000 }),
  row("miningOverflowOnEnd", "bool", true),
  row("miningRealCargoEnabled", "bool", false),
  row("miningRealCargoIntervalMs", "int", 10000, { min: 0, max: 600000 }),
  row("miningRealCargoMaxDepositsPerTick", "int", 4, { min: 1, max: 50 }),
  row("miningRealCargoUseCargoHold", "bool", true),
  row("miningRealCargoStoreEnabled", "bool", true),
  row("cargoPanelEnabled", "bool", false),
  row("cargoMoveMinIntervalMs", "int", 1000, { min: 0, max: 60000 }),
  row("cargoMoveMaxItems", "int", 20, { min: 1, max: 100 }),
  row("cargoListMaxRows", "int", 60, { min: 5, max: 500 }),
  row("combatEnabled", "bool", false),
  row("combatAssistOnLaunch", "bool", true),
  row("combatDefendWhenAttacked", "bool", true),
  row("combatAllowDrifterTargets", "bool", false),
  row("combatAllowNpcStructureTargets", "bool", true),
  row("combatEngageRangeMeters", "int", 15000, { min: 1000, max: 250000 }),
  row("combatOrbitMaxMeters", "int", 5000, { min: 500, max: 100000 }),
  row("combatReacquireMs", "int", 2000, { min: 100, max: 60000 }),
  row("combatMaxVolleysPerTick", "int", 16, { min: 1, max: 500 }),
  row("combatFxEnabled", "bool", true),
  row("combatAmmoWriteBack", "bool", true),
  row("combatApproachRetuneMs", "int", 2000, { min: 500, max: 60000 }),
  row("combatApproachTimeoutMs", "int", 30000, { min: 1000, max: 600000 }),
  row("combatAutoTargetEnabled", "bool", true),
  row("combatAutoTargetRangeMeters", "int", 30000, { min: 1000, max: 250000 }),
  row("combatAutoScansPerTick", "int", 4, { min: 1, max: 50 }),
  row("combatAutoScanMaxEntities", "int", 2000, { min: 100, max: 20000 }),
  row("combatMissilesEnabled", "bool", false),
  row("combatPrecursorEnabled", "bool", false),
  row("combatPrecursorSpoolKeepCycles", "int", 1, { min: 0, max: 10 }),
  row("combatVortonEnabled", "bool", false),
  row("combatVortonArcsEnabled", "bool", true),
  row("combatAreaEnabled", "bool", false),
  row("combatAreaAllowHighsec", "bool", false),
  row("combatAreaHoldWhenBystander", "bool", false),
  row("combatBreacherEnabled", "bool", false),
  row("combatBombsEnabled", "bool", false),
  row("combatBombMaxAngleDeg", "int", 10, { min: 1, max: 90 }),
  row("combatAmmoReceiptPruneEnabled", "bool", true),
  row("combatAmmoReceiptPruneMaxPerPass", "int", 500, { min: 1, max: 100000 }),
  row("combatAmmoReceiptPruneIntervalMs", "int", 3600000, { min: 0, max: 86400000 }),
  row("combatAmmoReceiptPruneMinAgeMs", "int", 3600000, { min: 0, max: 604800000 }),
  row("activeModulesEnabled", "bool", false),
  row("activeCapUnstablePolicy", "enum", "shed", { values: Object.freeze(["shed", "disable", "refuse"]) }),
  row("activeCapStableFactorPct", "int", 100, { min: 10, max: 200 }),
  row("activeCapIncludeWeapons", "bool", false),
  row("activeCapNosCreditPct", "int", 0, { min: 0, max: 100 }),
  row("activeCapShedRemoteLast", "bool", false),
  row("activeLocalRepStartPct", "int", 70, { min: 1, max: 99 }),
  row("activeLocalRepStopPct", "int", 95, { min: 2, max: 100 }),
  row("activeMaxCyclesPerTick", "int", 32, { min: 1, max: 1000 }),
  row("activeFxEnabled", "bool", true),
  row("activeRetryMs", "int", 5000, { min: 100, max: 600000 }),
  row("logiEnabled", "bool", false),
  row("logiRepairThresholdPct", "int", 90, { min: 1, max: 100 }),
  row("logiRetargetMs", "int", 1000, { min: 100, max: 60000 }),
  row("logiApproachMeters", "int", 5000, { min: 500, max: 100000 }),
  row("logiMoveLeaseMs", "int", 3000, { min: 500, max: 60000 }),
  row("logiCapTransferEnabled", "bool", false),
  row("activePropEnabled", "bool", false),
  row("activePropMinDistanceMeters", "int", 5000, { min: 0, max: 250000 }),
  row("ewarEnabled", "bool", false),
  row("ewarRetryMs", "int", 2000, { min: 100, max: 60000 }),
  row("ewarMaxCyclesPerTick", "int", 32, { min: 1, max: 1000 }),
  row("ewarOrphanSweepMs", "int", 10000, { min: 1000, max: 600000 }),
  row("safeLogoffAbortOnOrder", "bool", false),
  row("safeLogoffBlockWhileDeployed", "bool", false),
  row("burstEnabled", "bool", false),
  row("burstShipStatsEnabled", "bool", true),
  row("burstMaxRebuildsPerTick", "int", 8, { min: 1, max: 1000 }),
  row("dronesEnabled", "bool", false),
  row("droneDefaultMode", "enum", "auto", { values: Object.freeze(["auto", "off"]) }),
  row("droneMaxPerCopy", "int", 5, { min: 1, max: 25 }),
  row("droneMaxPerPilot", "int", 0, { min: 0, max: 100 }),
  row("droneIdleRecallMs", "int", 60000, { min: 0, max: 3600000 }),
  row("droneLaunchesPerTick", "int", 5, { min: 1, max: 50 }),
  row("droneMaxCyclesPerTick", "int", 16, { min: 1, max: 500 }),
  row("droneFxEnabled", "bool", true),
  row("droneRepairEnabled", "bool", false),
  row("droneMiningEnabled", "bool", false),
  row("droneReclaimOnBoot", "bool", true),
  row("npcAggroEnabled", "bool", false),
  row("formationEnabled", "bool", true),
  row("formationSpacingMeters", "int", 1000, { min: 100, max: 20000 }),
  row("formationMaxDistanceMeters", "int", 12000, { min: 1000, max: 250000 }),
  row("formationRetuneMs", "int", 1000, { min: 250, max: 60000 }),
  row("formationRepointMeters", "int", 150, { min: 10, max: 10000 }),
  row("formationLeadMs", "int", 1000, { min: 0, max: 10000 }),
  row("formationWedgeAngleDeg", "int", 45, { min: 10, max: 80 }),
  row("formationMaxPilots", "int", 10000, { min: 100, max: 1000000 }),
  row("formationMineMarginMeters", "int", 500, { min: 0, max: 10000 }),
  row("formationMineHysteresisMeters", "int", 1000, { min: 0, max: 20000 }),
  row("formationRelaunchEnabled", "bool", true),
  row("formationRelaunchTimeoutMs", "int", 120000, { min: 10000, max: 600000 }),
  row("formationRelaunchPerTick", "int", 4, { min: 1, max: 20 }),
  row("salvageEnabled", "bool", false),
  row("salvageSearchRangeMeters", "int", 15000, { min: 1000, max: 100000 }),
  row("salvageLeashMarginMeters", "int", 2500, { min: 500, max: 20000 }),
  row("salvageSeekRetryMs", "int", 10000, { min: 1000, max: 600000 }),
  row("salvageFullRetryMs", "int", 30000, { min: 1000, max: 600000 }),
  row("salvageMinFreeCargoM3", "int", 1, { min: 0, max: 1000 }),
  row("salvageMaxSeeksPerTick", "int", 2, { min: 1, max: 50 }),
  row("droneSalvageEnabled", "bool", false),
  row("salvageDroneWorkRangeMeters", "int", 5000, { min: 500, max: 50000 }),
  row("boardEnabled", "bool", false),
  row("boardRangeMeters", "int", 6550, { min: 0, max: 6550 }),
  row("boardCooldownMs", "int", 3000, { min: 0, max: 60000 }),
  row("boardOrphanEnabled", "bool", false),
  row("boardOrphanGraceMs", "int", 120000, { min: 10000, max: 600000 }),
  row("boardHostRangeMeters", "int", 5000, { min: 0, max: 5000 }),
  row("boardResendRemoval", "bool", true),
  row("boardBackStowEnabled", "bool", true),
  row("boardBackStowMaxAgeMs", "int", 1800000, { min: 0, max: 86400000 }),
  row("boardBackCargoUnloadEnabled", "bool", false),
  row("boardBackCargoMaxStacks", "int", 50, { min: 1, max: 500 }),
  row("scoopReturnEnabled", "bool", true),
  row("debug", "bool", false),
]);

const SCHEMA_BY_KEY = new Map(SCHEMA.map((r) => [r.key, r]));
const SCHEMA_BY_ENV = new Map(SCHEMA.map((r) => [r.env, r]));

const TRUE_WORDS = Object.freeze(["1", "true", "yes", "on"]);
const FALSE_WORDS = Object.freeze(["0", "false", "no", "off"]);
const TRIGGER_RE = /^![A-Za-z0-9_-]{1,31}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseValue(r, raw) {
  if (r.type === "bool") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    const word = String(raw).trim().toLowerCase();
    if (TRUE_WORDS.includes(word)) return { ok: true, value: true };
    if (FALSE_WORDS.includes(word)) return { ok: true, value: false };
    return { ok: false };
  }
  if (r.type === "int") {
    if (typeof raw !== "number" && typeof raw !== "string") return { ok: false };
    const text = String(raw).trim();
    if (text === "") return { ok: false };
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < r.min || n > r.max) return { ok: false };
    return { ok: true, value: n };
  }
  if (r.type === "trigger") {
    if (typeof raw !== "string") return { ok: false };
    const text = raw.trim();
    return TRIGGER_RE.test(text) ? { ok: true, value: text } : { ok: false };
  }
  if (r.type === "hashList") {
    let parts;
    if (typeof raw === "string") parts = raw.split(",");
    else if (Array.isArray(raw) && raw.every((p) => typeof p === "string")) parts = raw;
    else return { ok: false };
    const hashes = parts.map((p) => p.trim().toLowerCase());
    if (hashes.length < r.min || hashes.length > r.max || !hashes.every((h) => HASH_RE.test(h))) return { ok: false };
    return { ok: true, value: Object.freeze([...new Set(hashes)]) };
  }
  if (r.type === "enum") {
    if (typeof raw !== "string") return { ok: false };
    const word = raw.trim().toLowerCase();
    return r.values.includes(word) ? { ok: true, value: word } : { ok: false };
  }
  return { ok: false };
}

function describe(r) {
  if (r.type === "int") return `an integer ${r.min}..${r.max}`;
  if (r.type === "bool") return "true/false (1/0)";
  if (r.type === "hashList") return `${r.min}..${r.max} comma-separated sha256 hashes (64 hex characters)`;
  if (r.type === "enum") return `one of ${r.values.join("|")}`;
  return "! followed by 1-31 letters, digits, _ or -";
}

function parseEnvFile(text, warnings) {
  const values = {};
  String(text).replace(/^\uFEFF/, "").split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const at = line.indexOf("=");
    if (at <= 0) {
      warnings.push(`.env line ${index + 1} is not KEY=value - ignored`);
      return;
    }
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  });
  return values;
}

function resolveDataDir(env, modDir) {
  const configured = String((env && env.EVEJS_DATA_ROOT) || "").trim();
  const root = configured ? path.resolve(configured) : path.join(path.resolve(modDir, "..", ".."), "_local");
  return path.join(root, "mods", MOD_ID);
}

function resolveConfig(input) {
  const warnings = [...(input.fileWarnings || [])];
  const errors = [...(input.fileErrors || [])];
  const settings = isPlainObject(input.settings) ? input.settings : {};
  const envFile = isPlainObject(input.envFile) ? input.envFile : {};
  const env = input.env || {};
  const overrides = isPlainObject(input.overrides) ? input.overrides : {};
  const values = {};
  const sources = {};
  for (const r of SCHEMA) {
    values[r.key] = r.def;
    sources[r.key] = "default";
  }
  for (const key of Object.keys(settings)) {
    const r = SCHEMA_BY_KEY.get(key);
    if (!r) {
      warnings.push(`settings.json: unknown key "${key}" - ignored`);
      continue;
    }
    const parsed = parseValue(r, settings[key]);
    if (parsed.ok) {
      values[key] = parsed.value;
      sources[key] = "settings.json";
    } else {
      warnings.push(`settings.json: ${key} must be ${describe(r)} - keeping ${JSON.stringify(values[key])}`);
    }
  }
  for (const [layer, label] of [[envFile, ".env"], [env, "environment"]]) {
    for (const name of Object.keys(layer)) {
      if (!name.startsWith(ENV_PREFIX)) continue;
      const raw = layer[name];
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      const r = SCHEMA_BY_ENV.get(name);
      if (!r) {
        warnings.push(`${label}: unknown key ${name} - ignored`);
        continue;
      }
      const parsed = parseValue(r, String(raw));
      if (parsed.ok) {
        values[r.key] = parsed.value;
        sources[r.key] = label;
      } else {
        warnings.push(`${label}: ${name} must be ${describe(r)} - keeping ${JSON.stringify(values[r.key])}`);
      }
    }
  }
  let overridden = 0;
  let unknown = 0;
  for (const key of Object.keys(overrides)) {
    const r = SCHEMA_BY_KEY.get(key);
    if (!r) {
      unknown += 1;
      if (unknown <= MAX_OVERRIDE_UNKNOWN_WARNINGS) {
        const shown = key.length > OVERRIDE_KEY_SHOWN_CHARS ? `${key.slice(0, OVERRIDE_KEY_SHOWN_CHARS)}...` : key;
        warnings.push(`${OVERRIDE_FILE_NAME}: unknown key ${JSON.stringify(shown)} - ignored`);
      }
      continue;
    }
    const parsed = parseValue(r, overrides[key]);
    if (parsed.ok) {
      values[key] = parsed.value;
      sources[key] = SOURCE_OVERRIDE;
      overridden += 1;
    } else {
      warnings.push(`${OVERRIDE_FILE_NAME}: ${key} must be ${describe(r)} - keeping ${JSON.stringify(values[key])}`);
    }
  }
  if (unknown > MAX_OVERRIDE_UNKNOWN_WARNINGS) {
    warnings.push(`${OVERRIDE_FILE_NAME}: +${unknown - MAX_OVERRIDE_UNKNOWN_WARNINGS} more unknown keys - ignored`);
  }
  if (overridden > 0) warnings.push(`${overridden} keys overridden in game (${OVERRIDE_FILE_NAME})`);
  if (values.clientWindowEnabled === true && values.enabled !== true) {
    warnings.push("clientWindowEnabled has no effect while enabled is off");
  }
  if (values.clientWindowPollMs > 0 && values.clientWindowPollMs < CLIENT_WINDOW_POLL_MIN_MS) {
    warnings.push(`clientWindowPollMs raised to ${CLIENT_WINDOW_POLL_MIN_MS}`);
    values.clientWindowPollMs = CLIENT_WINDOW_POLL_MIN_MS;
  }
  if (values.hpCriticalPct >= values.hpWarnPct) {
    const warn = SCHEMA_BY_KEY.get("hpWarnPct").def;
    const critical = SCHEMA_BY_KEY.get("hpCriticalPct").def;
    warnings.push(`hpCriticalPct (${values.hpCriticalPct}) is not below hpWarnPct (${values.hpWarnPct}) `
      + `- using the defaults ${warn} and ${critical}`);
    values.hpWarnPct = warn;
    values.hpCriticalPct = critical;
    sources.hpWarnPct = "default";
    sources.hpCriticalPct = "default";
  }
  for (const key of ["miningEnabled", "commandMirrorEnabled", "combatEnabled", "activeModulesEnabled",
    "safeLogoffAbortOnOrder", "safeLogoffBlockWhileDeployed", "burstEnabled", "dronesEnabled", "npcAggroEnabled",
    "salvageEnabled", "cargoPanelEnabled"]) {
    if (values[key] === true && values.enabled !== true) warnings.push(`${key} has no effect while enabled is off`);
  }
  if (values.formationEnabled === true && values.enabled !== true && sources.formationEnabled !== "default") {
    warnings.push("formationEnabled has no effect while enabled is off");
  }
  if (values.formationRelaunchEnabled === true && values.formationEnabled !== true
    && sources.formationRelaunchEnabled !== "default") {
    warnings.push("formationRelaunchEnabled has no effect while formationEnabled is off");
  }
  if (values.formationEnabled === true && values.formationMaxDistanceMeters >= values.controlRangeMeters) {
    warnings.push(`formationMaxDistanceMeters (${values.formationMaxDistanceMeters}) is not below controlRangeMeters `
      + `(${values.controlRangeMeters}) - slots outside control range - twins would end OUT_OF_RANGE`);
  }
  if (values.dronesEnabled === true && values.combatEnabled !== true) {
    warnings.push("dronesEnabled without combatEnabled - combat drones off");
  }
  if (values.boardBackCargoUnloadEnabled === true
    && (values.boardEnabled !== true || values.boardBackStowEnabled !== true)) {
    warnings.push("boardBackCargoUnloadEnabled has no effect while boardEnabled/boardBackStowEnabled is off");
  }
  if (values.miningRealCargoEnabled === true && values.miningEnabled !== true) {
    warnings.push("miningRealCargoEnabled has no effect while miningEnabled is off");
  }
  if (values.droneMiningEnabled === true && (values.dronesEnabled !== true || values.miningEnabled !== true)) {
    warnings.push("droneMiningEnabled without dronesEnabled and miningEnabled - drone mining off");
  }
  if (values.droneSalvageEnabled === true && (values.dronesEnabled !== true || values.salvageEnabled !== true)) {
    warnings.push("droneSalvageEnabled without dronesEnabled and salvageEnabled - drone salvage off");
  }
  if (values.npcAggroEnabled === true && values.enabled === true && values.combatEnabled !== true) {
    warnings.push("npcAggroEnabled without combatEnabled - twins cannot fire back");
  }
  if (values.burstShipStatsEnabled === true && values.burstEnabled !== true && sources.burstShipStatsEnabled
    !== "default") {
    warnings.push("burstShipStatsEnabled has no effect while burstEnabled is off");
  }
  if (values.commandMirrorReturnEnabled === true && values.commandMirrorEnabled !== true) {
    warnings.push("commandMirrorReturnEnabled has no effect while commandMirrorEnabled is off");
  }
  if (values.commandMirrorEngageEnabled === true && values.commandMirrorEnabled !== true
    && sources.commandMirrorEngageEnabled !== "default") {
    warnings.push("commandMirrorEngageEnabled has no effect while commandMirrorEnabled is off");
  }
  if (values.commandMirrorEngageCopyDefault === true && values.commandMirrorEngageEnabled !== true) {
    warnings.push("commandMirrorEngageCopyDefault has no effect while commandMirrorEngageEnabled is off");
  }
  if (values.combatMissilesEnabled === true && values.combatEnabled !== true) {
    warnings.push("combatMissilesEnabled has no effect while combatEnabled is off - twins fire no missiles");
  }
  if (values.combatPrecursorEnabled === true && values.combatEnabled !== true) {
    warnings.push("combatPrecursorEnabled has no effect while combatEnabled is off - twins fire no Precursor weapons");
  }
  if (values.combatVortonEnabled === true && values.combatEnabled !== true) {
    warnings.push("combatVortonEnabled has no effect while combatEnabled is off - twins fire no Vorton Projectors");
  }
  if (values.combatAreaEnabled === true && values.combatEnabled !== true) {
    warnings.push("combatAreaEnabled has no effect while combatEnabled is off - twins fire no smartbombs or point "
      + "defense");
  }
  if (values.combatBreacherEnabled === true && values.combatEnabled !== true) {
    warnings.push("combatBreacherEnabled has no effect while combatEnabled is off - twins fire no breacher pods");
  }
  if (values.combatBombsEnabled === true && values.combatEnabled !== true) {
    warnings.push("combatBombsEnabled has no effect while combatEnabled is off - twins launch no bombs");
  }
  if (values.combatAutoTargetEnabled === true && values.combatEnabled !== true
    && sources.combatAutoTargetEnabled !== "default") {
    warnings.push("combatAutoTargetEnabled has no effect while combatEnabled is off");
  }
  if (values.combatAllowNpcStructureTargets === true && values.combatEnabled !== true
    && sources.combatAllowNpcStructureTargets !== "default") {
    warnings.push("combatAllowNpcStructureTargets has no effect while combatEnabled is off");
  }
  if (values.combatAutoTargetRangeMeters > values.combatEngageRangeMeters
    && sources.combatAutoTargetRangeMeters !== "default") {
    warnings.push(`combatAutoTargetRangeMeters (${values.combatAutoTargetRangeMeters}) is above `
      + `combatEngageRangeMeters (${values.combatEngageRangeMeters}) - the engage range limits auto targets`);
  }
  if (values.logiEnabled === true && values.activeModulesEnabled !== true) {
    warnings.push("logiEnabled has no effect while activeModulesEnabled is off - remote repair off");
    values.logiEnabled = false;
  }
  if (values.activePropEnabled === true && values.activeModulesEnabled !== true) {
    warnings.push("activePropEnabled has no effect while activeModulesEnabled is off - AB/MWD off");
    values.activePropEnabled = false;
  }
  if (values.ewarEnabled === true && values.activeModulesEnabled !== true) {
    warnings.push("ewarEnabled without activeModulesEnabled - twins use no EWAR");
  }
  if (values.ewarEnabled === true && values.combatEnabled !== true) {
    warnings.push("ewarEnabled without combatEnabled - twins have no EWAR target");
  }
  if (values.miningSearchRangeMeters > values.controlRangeMeters) {
    warnings.push(`miningSearchRangeMeters (${values.miningSearchRangeMeters}) is above controlRangeMeters `
      + `(${values.controlRangeMeters}) - twins would mine out of control range`);
  }
  if (values.salvageSearchRangeMeters > values.controlRangeMeters) {
    warnings.push(`salvageSearchRangeMeters (${values.salvageSearchRangeMeters}) is above controlRangeMeters `
      + `(${values.controlRangeMeters}) - twins would salvage out of control range`);
  }
  if (values.miningOrderRangeMeters < values.miningSearchRangeMeters) {
    warnings.push(`miningOrderRangeMeters (${values.miningOrderRangeMeters}) is below miningSearchRangeMeters `
      + `(${values.miningSearchRangeMeters}) - rocks the pilot names reach less far than the nearby search`);
  }
  if (values.miningOrderRangeMeters > values.controlRangeMeters + ORDER_RANGE_OVER_CONTROL_M) {
    warnings.push(`miningOrderRangeMeters (${values.miningOrderRangeMeters}) is above controlRangeMeters + `
      + `${ORDER_RANGE_OVER_CONTROL_M} (${values.controlRangeMeters + ORDER_RANGE_OVER_CONTROL_M}) - a twin flying `
      + "to such a rock may leave control range on the way");
  }
  if (values.combatOrbitMaxMeters > values.controlRangeMeters) {
    warnings.push(`combatOrbitMaxMeters (${values.combatOrbitMaxMeters}) is above controlRangeMeters `
      + `(${values.controlRangeMeters}) - a twin in orbit may leave control range`);
  }
  if (values.activeLocalRepStopPct <= values.activeLocalRepStartPct) {
    const startDef = SCHEMA_BY_KEY.get("activeLocalRepStartPct").def;
    const stopDef = SCHEMA_BY_KEY.get("activeLocalRepStopPct").def;
    warnings.push(`activeLocalRepStopPct (${values.activeLocalRepStopPct}) is not above activeLocalRepStartPct `
      + `(${values.activeLocalRepStartPct}) - using the defaults ${startDef} and ${stopDef}`);
    values.activeLocalRepStartPct = startDef;
    values.activeLocalRepStopPct = stopDef;
    sources.activeLocalRepStartPct = "default";
    sources.activeLocalRepStopPct = "default";
  }
  if (values.logiRetargetMs >= values.logiMoveLeaseMs) {
    const retargetDef = SCHEMA_BY_KEY.get("logiRetargetMs").def;
    const leaseDef = SCHEMA_BY_KEY.get("logiMoveLeaseMs").def;
    warnings.push(`logiRetargetMs (${values.logiRetargetMs}) is not below logiMoveLeaseMs `
      + `(${values.logiMoveLeaseMs}) - using the defaults ${retargetDef} and ${leaseDef}`);
    values.logiRetargetMs = retargetDef;
    values.logiMoveLeaseMs = leaseDef;
    sources.logiRetargetMs = "default";
    sources.logiMoveLeaseMs = "default";
  }
  const dataDir = resolveDataDir(env, input.modDir);
  const config = Object.freeze({ ...values, dataDir, stateFile: path.join(dataDir, STATE_FILE_NAME) });
  return { ok: errors.length === 0, config, sources, warnings, errors };
}

function failedConfig(err) {
  const values = Object.fromEntries(SCHEMA.map((r) => [r.key, r.def]));
  return {
    ok: false,
    config: Object.freeze({ ...values, enabled: false }),
    sources: {},
    warnings: [],
    errors: [`config_load_failed: ${(err && err.message) || err}`],
  };
}

function readOptional(readFile, file, errors, label) {
  try {
    return readFile(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    errors.push(`${label}: cannot read (${(err && err.message) || err})`);
    return null;
  }
}

function loadConfig(options = {}) {
  try {
    const env = options.env || process.env;
    const modDir = options.modDir || __dirname;
    const readFile = options.readFile || ((file) => fs.readFileSync(file, "utf8"));
    const fileErrors = [];
    const fileWarnings = [];
    let settings = null;
    const settingsText = readOptional(readFile, path.join(modDir, "settings.json"), fileErrors, "settings.json");
    if (settingsText !== null) {
      try {
        settings = JSON.parse(String(settingsText).replace(/^\uFEFF/, ""));
        if (!isPlainObject(settings)) {
          fileErrors.push("settings.json: root is not an object");
          settings = null;
        }
      } catch (err) {
        fileErrors.push(`settings.json: not valid JSON (${err.message})`);
      }
    }
    const envText = readOptional(readFile, path.join(modDir, ".env"), fileWarnings, ".env");
    const envFile = envText === null ? {} : parseEnvFile(envText, fileWarnings);
    const preview = isPlainObject(options.overrideValues) && env[OVERRIDE_IGNORE_ENV] !== "1";
    const overrideRead = preview ? { values: options.overrideValues, warnings: [] }
      : readOverrideFile(options.overrideFilePath || overridePathOf(resolveDataDir(env, modDir)), env);
    fileWarnings.push(...overrideRead.warnings);
    return resolveConfig({ settings, envFile, env, modDir, fileErrors, fileWarnings, overrides: overrideRead.values });
  } catch (err) {
    return failedConfig(err);
  }
}

module.exports = {
  MOD_ID, ENV_PREFIX, STATE_FILE_NAME, SCHEMA, parseEnvFile, resolveDataDir, resolveConfig, loadConfig,
};
