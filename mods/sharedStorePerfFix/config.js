"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_PIN_ROWS, MAX_PIN_ROWS, MIN_PIN_ROWS } = require("./lib/plannerPin");

const KEYS = Object.freeze({
  enabled: "EVEJS_SSPF_ENABLED",
  pinRows: "EVEJS_SSPF_PIN_ROWS",
  busyTimeoutMs: "EVEJS_SSPF_BUSY_TIMEOUT_MS",
  mirrorSkip: "EVEJS_SSPF_MIRROR_SKIP",
});

const DEFAULTS = Object.freeze({
  enabled: true,
  pinRows: DEFAULT_PIN_ROWS,
  busyTimeoutMs: 0,
  mirrorSkip: true,
});

const INTEGER_RANGES = Object.freeze({
  pinRows: Object.freeze([MIN_PIN_ROWS, MAX_PIN_ROWS]),
  busyTimeoutMs: Object.freeze([0, 120000]),
});

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
    if (value.length >= 2 && ["\"", "'"].includes(value[0]) && value.endsWith(value[0])) value = value.slice(1, -1);
    if (key) result[key] = value;
  }
  return result;
}

function readSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function parseBoolean(value) {
  if (typeof value === "boolean") return { ok: true, value };
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return { ok: true, value: true };
  if (["0", "false", "no", "off"].includes(normalized)) return { ok: true, value: false };
  return { ok: false };
}

function parseInteger(value, [min, max]) {
  const text = String(value).trim();
  if (!/^-?\d+$/u.test(text)) return { ok: false };
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) return { ok: false };
  return { ok: true, value: number };
}

function load(modDir = __dirname, environment = process.env, options = {}) {
  const env = environment || {};
  const settings = readSettings(options.settingsPath || path.join(modDir, "settings.json"));
  const fileValues = readEnvFile(options.envFilePath || path.join(modDir, ".env"));
  const problems = [];
  const values = {};
  for (const field of Object.keys(DEFAULTS)) {
    const key = KEYS[field];
    let raw = settings[field];
    let source = "settings.json";
    if (!isBlank(fileValues[key])) {
      raw = fileValues[key];
      source = ".env";
    }
    if (!isBlank(env[key])) {
      raw = env[key];
      source = "environment";
    }
    if (isBlank(raw)) {
      values[field] = DEFAULTS[field];
      continue;
    }
    const parsed = typeof DEFAULTS[field] === "boolean" ? parseBoolean(raw) : parseInteger(raw, INTEGER_RANGES[field]);
    if (!parsed.ok) {
      const expected = typeof DEFAULTS[field] === "boolean"
        ? "a boolean (1/0, true/false, on/off)"
        : `an integer in ${INTEGER_RANGES[field][0]}..${INTEGER_RANGES[field][1]}`;
      problems.push(`${key} (${source}) must be ${expected}, got ${JSON.stringify(String(raw))}`);
      values[field] = DEFAULTS[field];
      continue;
    }
    values[field] = parsed.value;
  }
  return Object.freeze({ ...values, problems: Object.freeze(problems) });
}

module.exports = { DEFAULTS, INTEGER_RANGES, KEYS, load, parseBoolean, parseInteger, readEnvFile };
