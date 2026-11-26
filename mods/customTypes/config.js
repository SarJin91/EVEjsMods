"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEYS = Object.freeze({
  enabled: "EVEJS_CUSTOMTYPES_ENABLED",
  cleanup: "EVEJS_CUSTOMTYPES_CLEANUP",
});

const DEFAULTS = Object.freeze({
  enabled: false,
  cleanup: false,
});

const BOOLEAN_FIELDS = Object.freeze(["enabled", "cleanup"]);

function readEnvFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return {};
  }
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ["\"", "'"].includes(value[0]) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function parseBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return { ok: true, value: true };
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return { ok: true, value: false };
  return { ok: false };
}

const { IGNORE_ENV: OVERRIDE_IGNORE_ENV, overridePathOf, readOverrideFile } = require("./lib/settingsOverride");

const OVERRIDE_DATA_ID = "customTypes";

function resolveDataDir(env, modDir) {
  const configured = String((env && env.EVEJS_DATA_ROOT) || "").trim();
  const root = configured ? path.resolve(configured)
    : path.join(path.resolve(modDir || __dirname, "..", ".."), "_local");
  return path.join(root, "mods", OVERRIDE_DATA_ID);
}

function overrideEnvOf(modDir, env, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const preview = opts.overrideValues !== null && typeof opts.overrideValues === "object"
    && !Array.isArray(opts.overrideValues) && env[OVERRIDE_IGNORE_ENV] !== "1";
  const values = preview ? opts.overrideValues
    : readOverrideFile(opts.overrideFilePath || overridePathOf(resolveDataDir(env, modDir)), env).values;
  const out = {};
  for (const field of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(values, field) || typeof KEYS[field] !== "string") continue;
    const value = values[field];
    const kind = typeof DEFAULTS[field];
    if (typeof value === kind && (kind === "boolean" || (kind === "number" && Number.isFinite(value)))) {
      out[KEYS[field]] = String(value);
    }
  }
  return out;
}

function load(modDir, environment = process.env, options = {}) {
  const env = environment || {};
  const fileValues = readEnvFile(path.join(modDir, ".env"));
  const overEnv = overrideEnvOf(modDir, env, options);
  const pick = (key) => (!isBlank(overEnv[key]) ? overEnv[key] : !isBlank(env[key]) ? env[key] : fileValues[key]);
  const problems = [];
  const values = {};

  for (const field of BOOLEAN_FIELDS) {
    const key = KEYS[field];
    const raw = pick(key);
    if (isBlank(raw)) {
      values[field] = DEFAULTS[field];
      continue;
    }
    const parsed = parseBoolean(raw);
    if (!parsed.ok) {
      problems.push(`${key} must be a boolean (1/0, true/false, on/off), got ${JSON.stringify(String(raw))}`);
      values[field] = DEFAULTS[field];
      continue;
    }
    values[field] = parsed.value;
  }

  const shopLoaded = loadShop(pick, values.enabled);
  const traceLoaded = loadTrace(pick);
  return Object.freeze({
    ...values,
    problems: Object.freeze(problems),
    shop: shopLoaded.shop,
    shopProblems: shopLoaded.problems,
    trace: traceLoaded.trace,
    traceProblems: traceLoaded.problems,
  });
}

const TRACE_KEYS = Object.freeze({
  enabled: "EVEJS_CUSTOMTYPES_CONNECTJOB_TRACE",
  windowMinutes: "EVEJS_CUSTOMTYPES_CONNECTJOB_TRACE_MINUTES",
});

const TRACE_DEFAULTS = Object.freeze({ enabled: true, windowMinutes: 10 });
const TRACE_MINUTES_RANGE = Object.freeze([1, 1440]);

function loadTrace(pick) {
  const problems = [];
  const trace = { ...TRACE_DEFAULTS };
  const rawEnabled = pick(TRACE_KEYS.enabled);
  if (!isBlank(rawEnabled)) {
    const parsed = parseBoolean(rawEnabled);
    if (parsed.ok) trace.enabled = parsed.value;
    else problems.push(`${TRACE_KEYS.enabled} must be a boolean (1/0, true/false, on/off), got ${JSON.stringify(String(rawEnabled))}`);
  }
  const rawMinutes = pick(TRACE_KEYS.windowMinutes);
  if (!isBlank(rawMinutes)) {
    const parsed = parseIntInRange(rawMinutes, TRACE_MINUTES_RANGE[0], TRACE_MINUTES_RANGE[1]);
    if (parsed.ok) trace.windowMinutes = parsed.value;
    else {
      problems.push(`${TRACE_KEYS.windowMinutes} must be an integer ${TRACE_MINUTES_RANGE[0]}-${TRACE_MINUTES_RANGE[1]}, `
        + `got ${JSON.stringify(String(rawMinutes))}`);
    }
  }
  if (problems.length > 0) trace.enabled = false;
  return { trace: Object.freeze(trace), problems: Object.freeze(problems) };
}

const SHOP_PREFIX = "EVEJS_CUSTOMTYPES_SHOP_";

const SHOP_DEFAULTS = Object.freeze({
  enabled: false,
  delist: false,
  liveContractRead: false,
  stations: Object.freeze([60003760, 60008494, 60011866, 60004588, 60005686]),
  issuerCorporationID: 1000129,
  issuerAccountKey: 1000,
  contractsPerType: 3,
  blueprintKind: "original",
  copyRuns: 10,
  contractDays: 30,
  renewHours: 24,
  price: Object.freeze({
    P1: 2000000, P2: 8000000, P3: 25000000, P4: 60000000, drill: 150000000, default: 10000000,
    officer: 1000000000,
  }),
  officerStations: Object.freeze([60003760]),
  officerContractsPerType: 1,
  priceOverrides: Object.freeze(new Map()),
  passSeconds: 30,
  firstPassSeconds: 30,
  maxActionsPerPass: 40,
  backoffMaxMinutes: 30,
});

const MAX_ISK = 1e12;

const SHOP_INT_FIELDS = Object.freeze({
  issuerCorporationID: ["ISSUER_CORPORATION_ID", 1, 2147483647],
  issuerAccountKey: ["ISSUER_ACCOUNT_KEY", 1000, 1006],
  contractsPerType: ["CONTRACTS_PER_TYPE", 1, 10],
  officerContractsPerType: ["OFFICER_CONTRACTS_PER_TYPE", 0, 10],
  copyRuns: ["COPY_RUNS", 1, 1000],
  contractDays: ["CONTRACT_DAYS", 1, 90],
  renewHours: ["RENEW_HOURS", 1, 168],
  passSeconds: ["PASS_SECONDS", 10, 3600],
  firstPassSeconds: ["FIRST_PASS_SECONDS", 0, 3600],
  maxActionsPerPass: ["MAX_ACTIONS_PER_PASS", 1, 500],
  backoffMaxMinutes: ["BACKOFF_MAX_MINUTES", 1, 240],
});

const SHOP_PRICE_FIELDS = Object.freeze({
  P1: "PRICE_P1", P2: "PRICE_P2", P3: "PRICE_P3", P4: "PRICE_P4", drill: "PRICE_DRILL", default: "PRICE_DEFAULT",
  officer: "PRICE_OFFICER",
});

const MAX_SHOP_STATIONS = 20;

function parseIntInRange(value, min, max) {
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return { ok: false };
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return { ok: false };
  return { ok: true, value: parsed };
}

function parseIdList(value) {
  const parts = String(value).split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0 || parts.length > MAX_SHOP_STATIONS) return { ok: false };
  const ids = [];
  for (const part of parts) {
    const parsed = parseIntInRange(part, 1, Number.MAX_SAFE_INTEGER);
    if (!parsed.ok || ids.includes(parsed.value)) return { ok: false };
    ids.push(parsed.value);
  }
  return { ok: true, value: ids };
}

function parsePriceOverrides(value) {
  const map = new Map();
  const parts = String(value).split(",").map((part) => part.trim()).filter((part) => part !== "");
  for (const part of parts) {
    const match = /^(\d+)\s*=\s*(\d+)$/u.exec(part);
    if (!match) return { ok: false };
    const typeID = parseIntInRange(match[1], 1, Number.MAX_SAFE_INTEGER);
    const isk = parseIntInRange(match[2], 1, MAX_ISK);
    if (!typeID.ok || !isk.ok || map.has(typeID.value)) return { ok: false };
    map.set(typeID.value, isk.value);
  }
  return { ok: true, value: map };
}

function loadShop(pick, modEnabled) {
  const problems = [];
  const shop = {
    ...SHOP_DEFAULTS,
    price: { ...SHOP_DEFAULTS.price },
  };
  const key = (suffix) => `${SHOP_PREFIX}${suffix}`;
  const read = (suffix) => {
    const raw = pick(key(suffix));
    return isBlank(raw) ? null : raw;
  };
  const bad = (suffix, raw, expected) => {
    problems.push(`${key(suffix)} must be ${expected}, got ${JSON.stringify(String(raw))}`);
  };

  for (const [field, suffix] of [["enabled", "ENABLED"], ["delist", "DELIST"],
    ["liveContractRead", "LIVE_CONTRACT_READ"]]) {
    const raw = read(suffix);
    if (raw === null) continue;
    const parsed = parseBoolean(raw);
    if (parsed.ok) shop[field] = parsed.value;
    else bad(suffix, raw, "a boolean (1/0, true/false, on/off)");
  }
  for (const [field, suffix] of [["stations", "STATIONS"], ["officerStations", "OFFICER_STATIONS"]]) {
    const raw = read(suffix);
    if (raw === null) continue;
    const parsed = parseIdList(raw);
    if (parsed.ok) shop[field] = Object.freeze(parsed.value);
    else bad(suffix, raw, `a list of 1-${MAX_SHOP_STATIONS} distinct station IDs`);
  }
  for (const [field, [suffix, min, max]] of Object.entries(SHOP_INT_FIELDS)) {
    const raw = read(suffix);
    if (raw === null) continue;
    const parsed = parseIntInRange(raw, min, max);
    if (parsed.ok) shop[field] = parsed.value;
    else bad(suffix, raw, `an integer ${min}-${max}`);
  }
  const kind = read("BLUEPRINT_KIND");
  if (kind !== null) {
    const normalized = String(kind).trim().toLowerCase();
    if (normalized === "original" || normalized === "copy") shop.blueprintKind = normalized;
    else bad("BLUEPRINT_KIND", kind, "original or copy");
  }
  for (const [priceClass, suffix] of Object.entries(SHOP_PRICE_FIELDS)) {
    const raw = read(suffix);
    if (raw === null) continue;
    const parsed = parseIntInRange(raw, 1, MAX_ISK);
    if (parsed.ok) shop.price[priceClass] = parsed.value;
    else bad(suffix, raw, `an ISK amount 1-${MAX_ISK}`);
  }
  const overrides = read("PRICE_OVERRIDES");
  if (overrides !== null) {
    const parsed = parsePriceOverrides(overrides);
    if (parsed.ok) shop.priceOverrides = parsed.value;
    else bad("PRICE_OVERRIDES", overrides, `a list typeID=isk (isk 1-${MAX_ISK}, each typeID once)`);
  }
  if (shop.renewHours >= shop.contractDays * 24) {
    problems.push(`${key("RENEW_HOURS")} (${shop.renewHours}) must be below ${key("CONTRACT_DAYS")}*24 `
      + `(${shop.contractDays * 24})`);
  }
  if (shop.enabled && !modEnabled) {
    problems.push(`${key("ENABLED")}=1 needs ${KEYS.enabled}=1`);
  }
  shop.price = Object.freeze(shop.price);
  return { shop: Object.freeze(shop), problems: Object.freeze(problems) };
}

module.exports = {
  BOOLEAN_FIELDS,
  DEFAULTS,
  KEYS,
  SHOP_DEFAULTS,
  SHOP_PREFIX,
  TRACE_DEFAULTS,
  TRACE_KEYS,
  load,
  parseBoolean,
  parseIdList,
  parseIntInRange,
  parsePriceOverrides,
  readEnvFile,
  resolveDataDir,
};
