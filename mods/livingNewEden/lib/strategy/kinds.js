"use strict";

const TARGET_KINDS = Object.freeze(["system"]);
const OCCUPATION_SIGNALS = Object.freeze([null, "RECON", "INVASION"]);
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const WINDOW_KEY_RE = /^[a-zA-Z]{1,64}$/;

class Invalid extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
  }
}

const fail = (path) => {
  throw new Invalid(path);
};
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const bool = (v, path) => {
  if (typeof v !== "boolean") fail(path);
};
const oneOf = (list) => (v, path) => {
  if (!list.includes(v)) fail(path);
};
const listOf = (list, min) => (v, path) => {
  if (!Array.isArray(v) || v.length < min || new Set(v).size !== v.length) fail(path);
  v.forEach((x, i) => oneOf(list)(x, `${path}[${i}]`));
};

function fieldsOf(ctx) {
  return {
    kind: (v, p) => {
      if (typeof v !== "string" || !KIND_RE.test(v)) fail(p);
    },
    operationType: oneOf(ctx.operationTypes),
    objective: oneOf(ctx.objectives),
    fleetRoles: listOf(ctx.fleetRoles, 1),
    mobilizeRole: oneOf(ctx.fleetRoles),
    offensive: bool,
    opensFront: bool,
    captures: bool,
    targetKinds: listOf(TARGET_KINDS, 1),
    windowKey: (v, p) => {
      if (typeof v !== "string" || !WINDOW_KEY_RE.test(v)) fail(p);
    },
    needsIntel: bool,
    needsCanOccupy: bool,
    enabled: bool,
    occupationSignal: (v, p) => {
      if (!OCCUPATION_SIGNALS.includes(v)) fail(p);
    },
    inPlace: bool,
  };
}

function createOperationKinds(data, ctx) {
  try {
    if (!isPlainObject(ctx)) fail("ctx");
    for (const name of ["operationTypes", "objectives", "fleetRoles"]) {
      if (!Array.isArray(ctx[name]) || ctx[name].length === 0) fail(`ctx.${name}`);
    }
    if (!isPlainObject(data) || !Number.isSafeInteger(data.version) || data.version < 1) fail("version");
    if (!Array.isArray(data.kinds) || data.kinds.length === 0) fail("kinds");
    const fields = fieldsOf(ctx);
    const byKind = new Map();
    data.kinds.forEach((k, i) => {
      const at = `kinds[${i}]`;
      if (!isPlainObject(k)) fail(at);
      for (const key of Object.keys(k)) if (!Object.prototype.hasOwnProperty.call(fields, key)) fail(`${at}.${key}`);
      for (const [key, check] of Object.entries(fields)) {
        if (k[key] === undefined) fail(`${at}.${key}`);
        check(k[key], `${at}.${key}`);
      }
      if (!k.fleetRoles.includes(k.mobilizeRole)) fail(`${at}.mobilizeRole`);
      if (byKind.has(k.kind)) fail(`${at}.kind`);
      byKind.set(k.kind, Object.freeze({ ...k, fleetRoles: Object.freeze([...k.fleetRoles]),
        targetKinds: Object.freeze([...k.targetKinds]) }));
    });
    const list = Object.freeze([...byKind.values()]);
    return { ok: true, kinds: Object.freeze({ version: data.version, list,
      get: (kind) => byKind.get(String(kind)) || null }) };
  } catch (err) {
    const detail = err instanceof Invalid ? err.detail : `internal: ${String((err && err.message) || err)}`;
    return { ok: false, reason: "KINDS_INVALID", detail };
  }
}

module.exports = { createOperationKinds, TARGET_KINDS };
