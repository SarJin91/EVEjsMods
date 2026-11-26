"use strict";

const { characterIdOf: defaultCharacterIdOf } = require("./vendor");

const SERVICE_NAME = "shipWingSvc";
const NOTIFY = Object.freeze({ STATE: "OnShipWingState", OPEN: "OnShipWingOpen" });
const NOTIFY_ID_TYPE = "clientID";
const BASE_SERVICE_PATH = "services/baseService";
const WIRE_VERSION = 2;
const WIRE_LIMITS = Object.freeze({ maxDepth: 3, maxItems: 128, maxStringBytes: 256 });
const STRING_DESCRIPTORS = Object.freeze(["wstring", "rawstr", "token"]);

const BAD = Symbol("bad");

function isObj(value) {
  return value !== null && typeof value === "object";
}

function fromWire(value, limits = WIRE_LIMITS) {
  const lim = { ...WIRE_LIMITS, ...(isObj(limits) ? limits : {}) };

  function text(s) {
    return Buffer.byteLength(s, "utf8") <= lim.maxStringBytes ? s : BAD;
  }

  function list(items, depth) {
    if (depth >= lim.maxDepth || items.length > lim.maxItems) return BAD;
    const out = [];
    for (const item of items) {
      const v = conv(item, depth + 1);
      if (v === BAD) return BAD;
      out.push(v);
    }
    return out;
  }

  function conv(v, depth) {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isSafeInteger(v) ? v : BAD;
    if (typeof v === "bigint") {
      return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : BAD;
    }
    if (typeof v === "string") return text(v);
    if (Buffer.isBuffer(v)) return v.length <= lim.maxStringBytes ? v.toString("latin1") : BAD;
    if (Array.isArray(v)) return list(v, depth);
    if (!isObj(v)) return BAD;
    if ((v.type === "list" || v.type === "tuple") && Array.isArray(v.items)) return list(v.items, depth);
    if (STRING_DESCRIPTORS.includes(v.type) && typeof v.value === "string") return text(v.value);
    if (v.type === "dict" && Array.isArray(v.entries)) {
      if (depth >= lim.maxDepth || v.entries.length > lim.maxItems) return BAD;
      const out = new Map();
      for (const entry of v.entries) {
        if (!Array.isArray(entry) || entry.length !== 2) return BAD;
        const key = conv(entry[0], depth + 1);
        if (typeof key !== "string") return BAD;
        const val = conv(entry[1], depth + 1);
        if (val === BAD) return BAD;
        out.set(key, val);
      }
      return out;
    }
    return BAD;
  }

  try {
    const value2 = conv(value, 0);
    return value2 === BAD ? { ok: false, reason: "BAD_ARGS" } : { ok: true, value: value2 };
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

function refusalWire(extra) {
  return toWire({ v: WIRE_VERSION, ok: false, ...extra });
}

function createShipWingServiceClass(BaseService, channel, deps = {}) {
  const characterIdOf = typeof deps.characterIdOf === "function" ? deps.characterIdOf : defaultCharacterIdOf;
  const log = deps.log || null;

  function debug(method, err) {
    try {
      if (log && typeof log.debug === "function") {
        log.debug(`${SERVICE_NAME}.${method} failed - ${(err && err.message) || err}`);
      }
    } catch (_err) {
    }
  }

  function arg(args, index) {
    if (!Array.isArray(args) || index >= args.length) return { ok: true, value: null };
    return fromWire(args[index]);
  }

  function value(converted, fallback) {
    return converted.ok ? converted.value : fallback;
  }

  class ShipWingService extends BaseService {
    constructor() {
      super(SERVICE_NAME);
    }

    Handle_GetState(_args, session) {
      try {
        const result = channel.getState(characterIdOf(session), session);
        if (result && result.ok) return toWire(result.snapshot);
        return refusalWire({ reason: (result && result.reason) || "INTERNAL" });
      } catch (err) {
        debug("GetState", err);
        return refusalWire({ reason: "INTERNAL" });
      }
    }

    Handle_Command(args, session) {
      try {
        const input = {
          ids: value(arg(args, 0), undefined),
          verb: value(arg(args, 1), undefined),
          targetId: value(arg(args, 2), Number.NaN),
        };
        const result = channel.command(characterIdOf(session), input);
        if (result && result.ok) return toWire(result.result);
        return refusalWire({ reason: (result && result.reason) || "INTERNAL", commandID: null, results: [] });
      } catch (err) {
        debug("Command", err);
        return refusalWire({ reason: "INTERNAL", commandID: null, results: [] });
      }
    }

    Handle_SetDrones(args, session) {
      try {
        const input = {
          ids: value(arg(args, 0), undefined),
          mode: value(arg(args, 1), undefined),
        };
        const result = channel.setDrones(characterIdOf(session), input);
        if (result && result.ok) return toWire(result.result);
        return refusalWire({ reason: (result && result.reason) || "INTERNAL", results: [] });
      } catch (err) {
        debug("SetDrones", err);
        return refusalWire({ reason: "INTERNAL", results: [] });
      }
    }

    Handle_SetEngage(args, session) {
      try {
        const input = {
          ids: value(arg(args, 0), undefined),
          mode: value(arg(args, 1), undefined),
        };
        const result = channel.setEngage(characterIdOf(session), input);
        if (result && result.ok) return toWire(result.result);
        return refusalWire({ reason: (result && result.reason) || "INTERNAL", results: [] });
      } catch (err) {
        debug("SetEngage", err);
        return refusalWire({ reason: "INTERNAL", results: [] });
      }
    }

    Handle_SetFormation(args, session) {
      try {
        const result = channel.setFormation(characterIdOf(session), { name: value(arg(args, 0), undefined) });
        if (result && result.ok) return toWire(result.result);
        return refusalWire({ reason: (result && result.reason) || "INTERNAL", formation: null, persisted: null });
      } catch (err) {
        debug("SetFormation", err);
        return refusalWire({ reason: "INTERNAL", formation: null, persisted: null });
      }
    }

    Handle_Report(args, session) {
      try {
        channel.report(characterIdOf(session), {
          proto: value(arg(args, 0), undefined),
          clientBuild: value(arg(args, 1), undefined),
          items: value(arg(args, 2), undefined),
        });
      } catch (err) {
        debug("Report", err);
      }
      return true;
    }
  }

  if (typeof channel.getCargo === "function" && typeof channel.moveCargo === "function") {
    Object.defineProperty(ShipWingService.prototype, "Handle_GetCargo", {
      configurable: true, writable: true,
      value: function Handle_GetCargo(_args, session) {
        try {
          const result = channel.getCargo(characterIdOf(session));
          if (result && result.ok) return toWire(result.result);
          return refusalWire({ reason: (result && result.reason) || "INTERNAL", ships: [] });
        } catch (err) {
          debug("GetCargo", err);
          return refusalWire({ reason: "INTERNAL", ships: [] });
        }
      },
    });
    Object.defineProperty(ShipWingService.prototype, "Handle_MoveCargo", {
      configurable: true, writable: true,
      value: function Handle_MoveCargo(args, session) {
        try {
          const input = {
            ids: value(arg(args, 0), undefined),
            toShipItemId: value(arg(args, 1), undefined),
            toFlag: value(arg(args, 2), Number.NaN),
            quantity: value(arg(args, 3), Number.NaN),
          };
          const result = channel.moveCargo(characterIdOf(session), input);
          if (result && result.ok) return toWire(result.result);
          return refusalWire({ reason: (result && result.reason) || "INTERNAL", results: [] });
        } catch (err) {
          debug("MoveCargo", err);
          return refusalWire({ reason: "INTERNAL", results: [] });
        }
      },
    });
  }

  return ShipWingService;
}

function installClientServiceFromGame(adapter, world, channel, deps = {}) {
  if (!adapter || typeof adapter.isConsumerAvailable !== "function" || !adapter.isConsumerAvailable("clientWindow")) {
    return { ok: false, reason: "probe_clientWindow_unavailable" };
  }
  const loaded = adapter.requireGame(BASE_SERVICE_PATH);
  if (!loaded || !loaded.ok) return { ok: false, reason: `require_failed:${loaded && loaded.reason}` };
  if (typeof loaded.exports !== "function") return { ok: false, reason: "require_failed:not_a_class" };
  const manager = isObj(world) ? world.serviceManager : null;
  if (!isObj(manager) || typeof manager.register !== "function" || typeof manager.lookup !== "function") {
    return { ok: false, reason: "NO_SERVICE_MANAGER" };
  }
  try {
    if (manager.lookup(SERVICE_NAME)) return { ok: false, reason: "SERVICE_NAME_TAKEN" };
    const ServiceClass = createShipWingServiceClass(loaded.exports, channel, deps);
    const service = new ServiceClass();
    manager.register(service);
    if (manager.lookup(SERVICE_NAME) !== service) return { ok: false, reason: "REGISTER_FAILED" };
    return { ok: true, service };
  } catch (_err) {
    return { ok: false, reason: "REGISTER_FAILED" };
  }
}

function createNotifier(liveAdapter) {
  return function notify(charId, token, notifyType, snapshot) {
    if (!liveAdapter || typeof liveAdapter.findSession !== "function") return { ok: false, reason: "SEND_FAILED" };
    try {
      if (liveAdapter.findSession(charId) !== token) return { ok: false, reason: "SESSION_CHANGED" };
      if (!isObj(token) || typeof token.sendNotification !== "function") return { ok: false, reason: "SEND_FAILED" };
      if (!token.socket || token.socket.destroyed) return { ok: false, reason: "SESSION_CHANGED" };
      token.sendNotification(notifyType, NOTIFY_ID_TYPE, [toWire(snapshot)]);
      return { ok: true };
    } catch (_err) {
      return { ok: false, reason: "SEND_FAILED" };
    }
  };
}

module.exports = {
  SERVICE_NAME, NOTIFY, NOTIFY_ID_TYPE, WIRE_LIMITS, WIRE_VERSION,
  fromWire, toWire, createShipWingServiceClass, installClientServiceFromGame, createNotifier,
};
