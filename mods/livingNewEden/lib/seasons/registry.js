"use strict";

const MAX_KINDS = 8;
const RESERVED = Object.freeze(["INVASION_SURGE", "PIRATE_SURGE"]);
const KIND_RE = /^[A-Z][A-Z0-9_]{2,23}$/;
const AGGREGATE_RE = /^[a-z][a-z0-9_]*$/;
const MAX_OWNER_CHARS = 32;
const MAX_AGGREGATES = 4;
const MAX_WEIGHT = 1000;
const REQUIRED = Object.freeze(["propose", "scoreEntries"]);
const OPTIONAL = Object.freeze(["refKeysOf", "readRefsInTx", "startInTx", "stageInTx", "endInTx"]);

const BUILTIN = new WeakMap();

function isKind(k) {
  if (!k || typeof k !== "object") return false;
  if (typeof k.kind !== "string" || !KIND_RE.test(k.kind)) return false;
  if (typeof k.owner !== "string" || k.owner === "" || k.owner.length > MAX_OWNER_CHARS) return false;
  if (!Number.isSafeInteger(k.version) || k.version < 1) return false;
  if (!Number.isSafeInteger(k.weight) || k.weight < 1 || k.weight > MAX_WEIGHT) return false;
  const a = k.journalAggregates;
  if (!Array.isArray(a) || a.length > MAX_AGGREGATES || !a.every((t) => typeof t === "string" && AGGREGATE_RE.test(t))
    || new Set(a).size !== a.length) return false;
  if (!REQUIRED.every((f) => typeof k[f] === "function")) return false;
  return OPTIONAL.every((f) => k[f] === undefined || typeof k[f] === "function");
}

function createCrisisRegistry() {
  const kinds = new Map();

  function add(k, builtin) {
    if (!isKind(k)) return { ok: false, reason: "BAD_KIND" };
    if (!builtin && RESERVED.includes(k.kind)) return { ok: false, reason: "RESERVED" };
    if (kinds.has(k.kind)) return { ok: false, reason: "DUPLICATE" };
    if (kinds.size >= MAX_KINDS) return { ok: false, reason: "FULL" };
    const entry = Object.freeze({ ...k, journalAggregates: Object.freeze([...k.journalAggregates]) });
    kinds.set(k.kind, entry);
    return {
      ok: true,
      unregister() {
        if (kinds.get(entry.kind) === entry) kinds.delete(entry.kind);
      },
    };
  }

  function register(k) {
    return add(k, false);
  }

  function get(kind) {
    return typeof kind === "string" ? kinds.get(kind) || null : null;
  }

  function list() {
    return Object.freeze([...kinds.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1))
      .map((k) => Object.freeze({ kind: k.kind, owner: k.owner, version: k.version, weight: k.weight })));
  }

  const facade = Object.freeze({ register, get, list });
  BUILTIN.set(facade, (k) => add(k, true));
  return facade;
}

function registerBuiltin(registry, kind) {
  const add = registry ? BUILTIN.get(registry) : undefined;
  if (typeof add !== "function") return { ok: false, reason: "NOT_A_REGISTRY" };
  return add(kind);
}

module.exports = { createCrisisRegistry, registerBuiltin, MAX_KINDS, RESERVED };
