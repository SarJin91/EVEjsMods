"use strict";

const { MODULE_NAMES } = require("../../config");

const MASK = "***";
const FLAG_KEY_RE = /(^|\.)enabled$|Enabled$/;
const SECRET_WORDS = Object.freeze(new Set(["password", "passwd", "pwd", "secret", "token", "credential",
  "credentials", "auth", "apikey", "bearer", "passphrase"]));
const SECRET_PAIRS = Object.freeze([["api", "key"], ["private", "key"], ["access", "key"]]);
const SOURCE_DEFAULT = "default";
const STATE_ON = "on";
const STATE_OFF = "off";
const STATE_SHADOWED = "shadowed";
const STATE_REFUSED = "refused";
const STATE_UNKNOWN = "unknown";
const SHADOW_REASONS = Object.freeze(["disabled_by_config"]);
const SHADOW_REASON_PREFIXES = Object.freeze(["dependency_disabled:"]);

function isFlagRow(row) {
  return Boolean(row) && row.type === "boolean" && typeof row.key === "string" && FLAG_KEY_RE.test(row.key);
}

function wordsOf(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

function hasSecretWords(words) {
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  for (let i = 0; i + 1 < words.length; i += 1) {
    if (SECRET_PAIRS.some(([a, b]) => words[i] === a && words[i + 1] === b)) return true;
  }
  return false;
}

function isSecretRow(row) {
  if (!row || typeof row.key !== "string") return false;
  if (row.secret === true) return true;
  const last = row.key.split(".").pop();
  if (hasSecretWords(wordsOf(last))) return true;
  return typeof row.env === "string" && hasSecretWords(row.env.toLowerCase().split("_").filter((w) => w !== ""));
}

const secretCache = new WeakMap();

function secretRowsOf(schema) {
  if (!Array.isArray(schema)) return [];
  let rows = secretCache.get(schema);
  if (!rows) {
    rows = Object.freeze(schema.filter(isSecretRow));
    secretCache.set(schema, rows);
  }
  return rows;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const k of Object.keys(value)) out[k] = deepCopy(value[k]);
  return out;
}

function redactConfigValues(config, schema) {
  if (!isPlainObject(config)) return config === undefined ? null : config;
  const copy = deepCopy(config);
  for (const row of secretRowsOf(schema)) {
    if (getPath(copy, row.key) !== undefined) setPath(copy, row.key, MASK);
  }
  return copy;
}

function redactMessages(messages, schema) {
  if (!Array.isArray(messages)) return [];
  const secrets = secretRowsOf(schema);
  return messages.map((m) => {
    const text = String(m);
    const hit = secrets.find((row) => (typeof row.env === "string" && row.env !== "" && text.includes(row.env))
      || text.includes(row.key));
    return hit ? `<redacted: ${hit.key}>` : text;
  });
}

function serviceFlagKey(serviceName, schemaKeys) {
  const name = String(serviceName);
  for (const key of [`${name}.enabled`, `world.${name}.enabled`, `modules.${name}.enabled`]) {
    if (schemaKeys.has(key)) return key;
  }
  return null;
}

function ancestorKeys(key, moduleNames) {
  const segs = key.split(".");
  const out = [];
  if (key !== "enabled") out.push("enabled");
  if (segs.length > 1 && moduleNames.includes(segs[0])) out.push(`modules.${segs[0]}.enabled`);
  for (let i = 1; i < segs.length; i += 1) {
    const k = `${segs.slice(0, i).join(".")}.enabled`;
    if (k !== key && !out.includes(k)) out.push(k);
  }
  return out;
}

function isShadowReason(reason) {
  const text = String(reason || "");
  return SHADOW_REASONS.includes(text) || SHADOW_REASON_PREFIXES.some((p) => text.startsWith(p));
}

function serviceState(service) {
  if (!service) return { state: STATE_UNKNOWN, by: null };
  if (service.state === "running") return { state: STATE_ON, by: null };
  if (service.state === "disabled" && isShadowReason(service.reason)) {
    return { state: STATE_SHADOWED, by: String(service.reason) };
  }
  if (service.state === "disabled" || service.state === "failed") {
    return { state: STATE_REFUSED, by: String(service.reason || service.state) };
  }
  return { state: STATE_UNKNOWN, by: null };
}

function baseName(filePath) {
  return String(filePath).split(/[\\/]/).pop();
}

const PATH_CHAR = "[^\\s'\"`<>|]";
const PATH_RE = new RegExp(
  "(?<=^|[\\s'\"`(=,[:]|\\\\[nrt]|[Ff][Ii][Ll][Ee]:\\/\\/)(?:" +
    `[A-Za-z]:([\\\\/])${PATH_CHAR}*(?: ${PATH_CHAR}*\\1${PATH_CHAR}*)*` +
    `|(?:\\\\){1,4}[^\\s'"\`<>|\\\\/]+[\\\\/]${PATH_CHAR}*(?: ${PATH_CHAR}*\\\\${PATH_CHAR}*)*` +
    "|\\/(?!\\/)[^\\s'\"`<>|\\\\]*)",
  "g");
const PATH_MARK = "<path>/";

function redactPaths(text) {
  if (typeof text !== "string" || (!text.includes("/") && !text.includes("\\"))) return text;
  return text.replace(PATH_RE, (m) => {
    const trimmed = m.replace(/[\\/]+$/, "");
    if (m.startsWith("/") && trimmed.indexOf("/", 1) === -1) return m;
    return PATH_MARK + baseName(trimmed);
  });
}

function trimOrigin(origin, chars) {
  if (!(chars > 0) || typeof origin !== "string") return "";
  return origin.length > chars ? origin.slice(0, chars) : origin;
}

function describeConfig(input) {
  const schema = Array.isArray(input.schema) ? input.schema : [];
  const config = isPlainObject(input.config) ? input.config : {};
  const sources = isPlainObject(input.sources) ? input.sources : {};
  const moduleNames = Array.isArray(input.moduleNames) ? input.moduleNames : MODULE_NAMES;
  const originChars = Number.isFinite(input.originChars) ? input.originChars : 0;
  const schemaKeys = new Set(schema.map((r) => r.key));
  const secrets = new Set(secretRowsOf(schema).map((r) => r.key));

  const registry = input.services && Array.isArray(input.services.services) ? input.services.services : null;
  const serviceByFlag = new Map();
  const services = [];
  if (registry) {
    for (const s of registry) {
      const flag = serviceFlagKey(s.name, schemaKeys);
      services.push({ name: String(s.name), state: s.state || null, reason: s.reason || null, flag });
      if (flag && !serviceByFlag.has(flag)) serviceByFlag.set(flag, s);
    }
  } else if (Array.isArray(input.serviceNames)) {
    for (const name of input.serviceNames) {
      const flag = serviceFlagKey(name, schemaKeys);
      services.push({ name: String(name), state: null, reason: null, flag });
      if (flag && !serviceByFlag.has(flag)) {
        serviceByFlag.set(flag, { name: String(name), state: null, reason: null, detail: null });
      }
    }
  }

  const summary = { flags: 0, on: 0, off: 0, shadowed: 0, refused: 0, unknown: 0, differs: 0, pinned: 0,
    masked: secrets.size, bySource: {} };
  const flags = [];
  const overrides = [];
  for (const row of schema) {
    const value = getPath(config, row.key);
    const source = typeof sources[row.key] === "string" ? sources[row.key] : SOURCE_DEFAULT;
    const differs = value !== row.default;
    const pinned = source !== SOURCE_DEFAULT && !differs;
    const secret = secrets.has(row.key);
    const shownValue = secret ? MASK : (value === undefined ? null : value);
    const shownDefault = secret ? MASK : (row.default === undefined ? null : row.default);
    summary.bySource[source] = (summary.bySource[source] || 0) + 1;
    if (differs) summary.differs += 1;
    if (pinned) summary.pinned += 1;
    if (isFlagRow(row)) {
      let state = STATE_ON;
      let by = null;
      const hasService = serviceByFlag.has(row.key);
      const service = hasService ? serviceByFlag.get(row.key) : null;
      if (value === false) {
        state = STATE_OFF;
      } else {
        const ancestor = ancestorKeys(row.key, moduleNames)
          .find((k) => schemaKeys.has(k) && getPath(config, k) === false);
        if (ancestor) {
          state = STATE_SHADOWED;
          by = ancestor;
        } else if (hasService) {
          ({ state, by } = serviceState(service));
        }
      }
      summary.flags += 1;
      summary[state] += 1;
      flags.push({ key: row.key, value: shownValue, default: shownDefault, source, differs, pinned, state, by,
        service: service ? String(service.name) : null, serviceState: service ? service.state || null : null,
        origin: trimOrigin(row.origin, originChars) });
    } else if (source !== SOURCE_DEFAULT) {
      overrides.push({ key: row.key, value: shownValue, default: shownDefault, source, differs, pinned });
    }
  }
  return {
    summary,
    flags,
    overrides,
    services,
    warnings: redactMessages(input.warnings, schema),
    errors: redactMessages(input.errors, schema),
    masked: [...secrets],
  };
}

module.exports = {
  MASK,
  baseName,
  isFlagRow,
  isSecretRow,
  redactConfigValues,
  redactMessages,
  redactPaths,
  serviceFlagKey,
  describeConfig,
};
