"use strict";

const MAX_KINDS = 16;
const MAX_HINT_SOURCES = 6;
const RESERVED = Object.freeze(["NEWS", "NOTICE", "SITE", "WAIT"]);
const TYPE_RE = /^[A-Z][A-Z0-9_]{2,23}$/;
const SOURCE_KEY_RE = /^[a-z][A-Za-z0-9_]{1,31}$/;
const ASCII_RE = /^[\x20-\x7E]*$/;
const MAX_HINT_CHARS = 160;
const MAX_OWNER_CHARS = 32;
const MAX_PER_THREAD = 3;

const FUNCTIONS = Object.freeze(["validate", "startInTx", "pollInTx", "cancelInTx"]);

const BUILTIN = new WeakMap();

function isKind(kind) {
  if (!kind || typeof kind !== "object") return false;
  if (typeof kind.type !== "string" || !TYPE_RE.test(kind.type)) return false;
  if (typeof kind.owner !== "string" || kind.owner === "" || kind.owner.length > MAX_OWNER_CHARS) return false;
  if (!Number.isSafeInteger(kind.version) || kind.version < 1) return false;
  if (typeof kind.promptHint !== "string" || kind.promptHint.length > MAX_HINT_CHARS
    || !ASCII_RE.test(kind.promptHint)) return false;
  if (!Number.isSafeInteger(kind.maxPerThread) || kind.maxPerThread < 1 || kind.maxPerThread > MAX_PER_THREAD) {
    return false;
  }
  const d = kind.duration;
  if (!d || !Number.isSafeInteger(d.minMs) || !Number.isSafeInteger(d.maxMs) || d.minMs < 0 || d.minMs > d.maxMs) {
    return false;
  }
  return FUNCTIONS.every((f) => typeof kind[f] === "function");
}

function createStepRegistry() {
  const kinds = new Map();
  const sources = new Map();

  function add(kind, builtin) {
    if (!isKind(kind)) return { ok: false, reason: "BAD_KIND" };
    if (!builtin && RESERVED.includes(kind.type)) return { ok: false, reason: "RESERVED" };
    if (kinds.has(kind.type)) return { ok: false, reason: "DUPLICATE" };
    if (kinds.size >= MAX_KINDS) return { ok: false, reason: "FULL" };
    const entry = Object.freeze({ ...kind, duration: Object.freeze({ ...kind.duration }) });
    kinds.set(kind.type, entry);
    return {
      ok: true,
      unregister() {
        if (kinds.get(entry.type) === entry) kinds.delete(entry.type);
      },
    };
  }

  function register(kind) {
    return add(kind, false);
  }

  function get(type) {
    return typeof type === "string" ? kinds.get(type) || null : null;
  }

  function list() {
    return Object.freeze([...kinds.values()].sort((a, b) => (a.type < b.type ? -1 : 1))
      .map((k) => Object.freeze({ type: k.type, owner: k.owner, version: k.version, promptHint: k.promptHint,
        maxPerThread: k.maxPerThread })));
  }

  function registerHintSource(src) {
    if (!src || typeof src !== "object" || typeof src.key !== "string" || !SOURCE_KEY_RE.test(src.key)
      || typeof src.read !== "function") {
      return { ok: false, reason: "BAD_SOURCE" };
    }
    if (sources.has(src.key)) return { ok: false, reason: "DUPLICATE" };
    if (sources.size >= MAX_HINT_SOURCES) return { ok: false, reason: "FULL" };
    const entry = Object.freeze({ key: src.key, read: src.read });
    sources.set(src.key, entry);
    return {
      ok: true,
      unregister() {
        if (sources.get(entry.key) === entry) sources.delete(entry.key);
      },
    };
  }

  function listHintSources() {
    return Object.freeze([...sources.values()].sort((a, b) => (a.key < b.key ? -1 : 1)));
  }

  const facade = Object.freeze({ register, get, list, registerHintSource, listHintSources });
  BUILTIN.set(facade, (kind) => add(kind, true));
  return facade;
}

function registerBuiltin(registry, kind) {
  const add = registry ? BUILTIN.get(registry) : undefined;
  if (typeof add !== "function") return { ok: false, reason: "NOT_A_REGISTRY" };
  return add(kind);
}

module.exports = { createStepRegistry, registerBuiltin, MAX_KINDS, MAX_HINT_SOURCES, RESERVED };
