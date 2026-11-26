"use strict";

const { recordOf } = require("./sessionPresence");

const NOTIFY_ID_TYPE = "clientID";
const HANDLER_NAME_RE = /^[A-Z][A-Za-z]{0,31}$/;
const SERVICE_NAME_RE = /^[a-z][A-Za-z]{2,31}$/;
const WIRE_LIMITS = Object.freeze({ maxDepth: 3, maxItems: 128, maxStringBytes: 256 });
const STRING_DESCRIPTORS = Object.freeze(["wstring", "rawstr", "token"]);
const DETACHED = "JOB_BOARD_UNAVAILABLE";
const DETACHED_REASON_RE = /^[A-Z][A-Z_]{0,39}$/;

const BAD = Symbol("bad");

function isObj(value) {
  return value !== null && typeof value === "object";
}

function fromWire(value) {
  const lim = WIRE_LIMITS;
  const text = (s) => (Buffer.byteLength(s, "utf8") <= lim.maxStringBytes ? s : BAD);
  const conv = (v, depth) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isSafeInteger(v) ? v : BAD;
    if (typeof v === "bigint") {
      return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : BAD;
    }
    if (typeof v === "string") return text(v);
    if (Buffer.isBuffer(v)) return v.length <= lim.maxStringBytes ? v.toString("latin1") : BAD;
    const items = Array.isArray(v) ? v
      : (isObj(v) && (v.type === "list" || v.type === "tuple") && Array.isArray(v.items) ? v.items : null);
    if (items) {
      if (depth >= lim.maxDepth || items.length > lim.maxItems) return BAD;
      const out = [];
      for (const item of items) {
        const c = conv(item, depth + 1);
        if (c === BAD) return BAD;
        out.push(c);
      }
      return out;
    }
    if (isObj(v) && STRING_DESCRIPTORS.includes(v.type) && typeof v.value === "string") return text(v.value);
    return BAD;
  };
  try {
    const out = conv(value, 0);
    return out === BAD ? { ok: false, reason: "BAD_ARGS" } : { ok: true, value: out };
  } catch (_err) {
    return { ok: false, reason: "BAD_ARGS" };
  }
}

function isPlainObject(value) {
  if (!isObj(value) || Array.isArray(value) || Buffer.isBuffer(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toWire(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value;
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  if (Array.isArray(value)) return value.map(toWire);
  if (isPlainObject(value)) {
    return { type: "dict", entries: Object.keys(value).map((key) => [key, toWire(value[key])]) };
  }
  return null;
}

function callerOf(session) {
  const corp = Number(isObj(session) ? (session.corporationID || session.corpid) : 0);
  const corporationId = Number.isSafeInteger(corp) && corp > 0 ? corp : 0;
  const rec = recordOf(session);
  if (rec) return { characterId: rec.characterId, systemId: rec.systemId, corporationId };
  const id = Number(isObj(session) ? (session.characterID || session.charid) : 0);
  return { characterId: Number.isSafeInteger(id) && id > 0 ? id : 0, systemId: null, corporationId };
}

function createServiceClass(BaseService, name, handlers, hooks) {
  class LneClientService extends BaseService {
    constructor() {
      super(name);
    }
  }
  const tokens = new WeakMap();
  const tokenOf = (session, characterId) => {
    if (!isObj(session)) return null;
    const seen = tokens.get(session);
    if (seen && seen.characterId === characterId) return seen.token;
    const token = Object.freeze({});
    tokens.set(session, { characterId, token });
    return token;
  };
  for (const method of Object.keys(handlers)) {
    const handler = handlers[method];
    Object.defineProperty(LneClientService.prototype, `Handle_${method}`, {
      configurable: true, writable: true, enumerable: false,
      value: function lneClientHandle(args, session) {
        try {
          if (hooks.isDetached()) return toWire({ ok: false, reason: hooks.detachedReason || DETACHED });
          const converted = fromWire(Array.isArray(args) ? args : []);
          const caller = callerOf(session);
          const result = handler({ characterId: caller.characterId, systemId: caller.systemId,
            corporationId: caller.corporationId, args: converted.ok ? converted.value : null, badArgs: !converted.ok,
            session: tokenOf(session, caller.characterId) });
          return result === true ? true : toWire(result);
        } catch (err) {
          try {
            if (typeof hooks.log === "function") {
              hooks.log(`${name}.${method} failed - ${String((err && err.message) || err).slice(0, 120)}`);
            }
          } catch (_err) {
          }
          return toWire({ ok: false, reason: "INTERNAL" });
        }
      },
    });
  }
  return LneClientService;
}

function registerClientServiceWith(BaseService, world, spec) {
  if (typeof BaseService !== "function" || typeof BaseService.prototype.callMethod !== "function") {
    return { ok: false, reason: "BASE_SERVICE_DRIFT" };
  }
  const name = spec && spec.name;
  const handlers = spec && isObj(spec.handlers) ? spec.handlers : null;
  if (typeof name !== "string" || !SERVICE_NAME_RE.test(name) || !handlers || Object.keys(handlers).length === 0
    || Object.keys(handlers).some((m) => !HANDLER_NAME_RE.test(m) || typeof handlers[m] !== "function")) {
    return { ok: false, reason: "BAD_SPEC" };
  }
  const manager = isObj(world) ? world.serviceManager : null;
  if (!isObj(manager) || typeof manager.register !== "function" || typeof manager.lookup !== "function") {
    return { ok: false, reason: "NO_SERVICE_MANAGER" };
  }
  let detached = false;
  const detachedReason = typeof spec.detachedReason === "string" && DETACHED_REASON_RE.test(spec.detachedReason)
    ? spec.detachedReason : DETACHED;
  try {
    if (manager.lookup(name)) return { ok: false, reason: "SERVICE_NAME_TAKEN" };
    const ServiceClass = createServiceClass(BaseService, name, { ...handlers },
      { isDetached: () => detached, log: spec.log, detachedReason });
    const service = new ServiceClass();
    manager.register(service);
    if (manager.lookup(name) !== service) return { ok: false, reason: "REGISTER_FAILED" };
    return { ok: true, unregister: () => {
      detached = true;
    } };
  } catch (err) {
    return { ok: false, reason: "REGISTER_FAILED", detail: String((err && err.message) || err).slice(0, 120) };
  }
}

function sendClientNotificationWith(registryExports, characterId, type, payload) {
  if (!Number.isSafeInteger(characterId) || characterId <= 0 || typeof type !== "string"
    || !/^On\w{1,60}$/.test(type)) {
    return { ok: false, reason: "BAD_INPUT" };
  }
  if (!registryExports || typeof registryExports.getSessions !== "function") {
    return { ok: false, reason: "SEND_FAILED", detail: "getSessions" };
  }
  try {
    let session = null;
    for (const s of registryExports.getSessions() || []) {
      if (callerOf(s).characterId === characterId) {
        session = s;
        break;
      }
    }
    if (!session) return { ok: false, reason: "NO_SESSION" };
    if (typeof session.sendNotification !== "function") return { ok: false, reason: "SEND_FAILED", detail: "method" };
    if (session.socket && session.socket.destroyed) return { ok: false, reason: "NO_SESSION" };
    session.sendNotification(type, NOTIFY_ID_TYPE, [toWire(payload)]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "SEND_FAILED", detail: String((err && err.message) || err).slice(0, 120) };
  }
}

module.exports = {
  NOTIFY_ID_TYPE, WIRE_LIMITS, fromWire, toWire, callerOf, registerClientServiceWith, sendClientNotificationWith,
};
