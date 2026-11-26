"use strict";

const { characterIdOf } = require("./vendor");

const GUARDED = Symbol.for("shipWing.guarded");
const HANDLER_PREFIX = "Handle_";
const MAX_DEPTH = 2;
const DIGITS = /^[0-9]{1,20}$/;

const READ_ONLY = Object.freeze({
  ShipService: Object.freeze([
    "Handle_GetDirtTimestamp", "Handle_GetDisplayKillCounterValue", "Handle_GetFittedItems",
    "Handle_GetKillCounter", "Handle_GetModules", "Handle_GetShipConfiguration", "Handle_GetShipFittingInfo",
    "Handle_GetShipKillCounter", "Handle_GetTurretModules",
    "Handle_MachoBindObject", "Handle_MachoResolveObject",
  ]),
  InvBrokerService: Object.freeze([
    "Handle_GetAvailableTurretSlots", "Handle_GetCapacity", "Handle_GetContainerContents",
    "Handle_GetDamageForCrystals", "Handle_GetInventory", "Handle_GetInventoryFromId", "Handle_GetItem",
    "Handle_GetItemByID", "Handle_GetItemDescriptor", "Handle_GetItems", "Handle_GetSelfInvItem",
    "Handle_GetPriceForItems",
    "Handle_List", "Handle_ListByFlags", "Handle_ListDroneBay", "Handle_ListFighterBay", "Handle_ListFuelBay",
    "Handle_MachoBindObject", "Handle_MachoResolveObject",
    "Handle_ValidateItemCanBeOpened", "Handle_ValidateItemListCanBeOpened",
    "Handle_HasExistingPasswordSet", "Handle_ALSCConfigGet", "Handle_ALSCLogGet",
  ]),
});

function isObj(value) {
  return value !== null && typeof value === "object";
}

function listHandlers(proto) {
  if (!isObj(proto) && typeof proto !== "function") return [];
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (!name.startsWith(HANDLER_PREFIX)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    return Boolean(descriptor) && typeof descriptor.value === "function";
  }).sort();
}

function toId(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && DIGITS.test(value)) return Number(value);
  return null;
}

function childrenOf(value) {
  if (Array.isArray(value)) return value;
  if (!isObj(value)) return null;
  if ((value.type === "list" || value.type === "tuple") && Array.isArray(value.items)) return value.items;
  if (value.type === "dict" && Array.isArray(value.entries)) {
    return value.entries.map((e) => (Array.isArray(e) ? e[1] : e));
  }
  return null;
}

function collectIds(args, kwargs, maxIds) {
  const ids = [];
  let overflow = false;
  function visit(value, depth) {
    if (overflow) return;
    const id = toId(value);
    if (id !== null) {
      if (id <= 0) return;
      if (ids.length >= maxIds) {
        overflow = true;
        return;
      }
      ids.push(id);
      return;
    }
    if (depth > MAX_DEPTH) return;
    const children = childrenOf(value);
    if (children) {
      for (const child of children) visit(child, depth + 1);
      return;
    }
    if (depth === 0 && isObj(value) && !Array.isArray(value) && value.type === undefined) {
      for (const key of Object.keys(value)) visit(value[key], depth + 1);
    }
  }
  for (const arg of Array.isArray(args) ? args : [args]) visit(arg, 0);
  if (kwargs !== undefined && kwargs !== null) visit(kwargs, 0);
  return { ids, overflow };
}

function invBrokerContextIds(service, session) {
  if (!service || typeof service._getBoundContext !== "function") return [];
  const context = service._getBoundContext(session);
  if (!isObj(context)) return [];
  return [toId(context.inventoryID), toId(context.locationID)].filter((id) => id !== null && id > 0);
}

function plainTopLevelIds(args, maxIds) {
  const ids = [];
  const take = (value) => {
    const id = toId(value);
    if (id !== null && id > 0) ids.push(id);
  };
  for (const arg of Array.isArray(args) ? args : [args]) {
    if (Array.isArray(arg)) for (const value of arg) take(value);
    else take(arg);
    if (ids.length > maxIds) return null;
  }
  return ids;
}

function createGuardErrorReporter(options) {
  const log = options && options.log;
  const intervalMs = Number(options && options.intervalMs) || 0;
  const now = options && typeof options.now === "function" ? options.now : () => Date.now();
  let lastAtMs = null;
  let suppressed = 0;
  return function reportGuardError(name, err) {
    try {
      const t = now();
      if (lastAtMs !== null && t - lastAtMs < intervalMs) {
        suppressed += 1;
        return;
      }
      const more = suppressed > 0 ? ` (${suppressed} more since the last line)` : "";
      suppressed = 0;
      lastAtMs = t;
      if (log && typeof log.log === "function") {
        log.log(`guard error in ${name} - ${String((err && err.message) || err).slice(0, 200)}${more}`);
      }
    } catch (_err) {
    }
  };
}

function createGuardFactory(options) {
  const counters = options.counters;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  function bump(name) {
    counters[name] = (counters[name] || 0) + 1;
  }
  function verdict(service, args, session, kwargs) {
    const { ids, overflow } = collectIds(args, kwargs, options.maxScannedIds);
    if (overflow) return "overflow";
    for (const id of ids) if (options.wing.isBlocked(id)) return "blocked";
    if (options.contextIds) {
      for (const id of options.contextIds(service, session)) if (options.wing.isBlocked(id)) return "blocked";
    }
    return null;
  }
  function fallbackVerdict(args, session) {
    try {
      const ids = plainTopLevelIds(args, options.maxScannedIds);
      if (ids === null) return "overflow";
      for (const id of ids) if (options.wing.isBlocked(id)) return "blocked";
      return null;
    } catch (_err) {
    }
    try {
      const charId = characterIdOf(session);
      if (charId > 0 && typeof options.wing.ownsBlocked === "function" && options.wing.ownsBlocked(charId) === true) {
        return "blocked";
      }
    } catch (_err) {
    }
    return null;
  }
  return function guard(name, original) {
    function shipWingGuard(args, session, kwargs) {
      let decision = null;
      try {
        if (options.wing.blockedCount() > 0) decision = verdict(this, args, session, kwargs);
      } catch (err) {
        bump("guard.error");
        onError(name, err);
        decision = fallbackVerdict(args, session);
      }
      if (decision !== null) {
        bump(`guard.refused.${name}`);
        if (decision === "overflow") bump("guard.overflow");
        const notify = decision === "overflow" ? options.overflowText : options.notifyText;
        options.refuse(notify);
        throw new Error(notify);
      }
      return original.apply(this, arguments);
    }
    for (const symbol of Object.getOwnPropertySymbols(original)) {
      if (symbol !== GUARDED) shipWingGuard[symbol] = original[symbol];
    }
    shipWingGuard[GUARDED] = true;
    return shipWingGuard;
  };
}

function guardPrototype(proto, readOnly, guard) {
  const result = { ok: true, guarded: [], readOnly: [], already: [], failed: [] };
  const skip = new Set(readOnly);
  for (const name of listHandlers(proto)) {
    if (skip.has(name)) {
      result.readOnly.push(name);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor.value[GUARDED] === true) {
      result.already.push(name);
      continue;
    }
    try {
      if (descriptor.configurable) {
        Object.defineProperty(proto, name, { ...descriptor, value: guard(name, descriptor.value) });
      } else if (descriptor.writable) {
        proto[name] = guard(name, descriptor.value);
      } else {
        throw new Error("not writable");
      }
      result.guarded.push(name);
    } catch (_err) {
      result.failed.push(name);
    }
  }
  result.ok = result.failed.length === 0 && result.guarded.length + result.already.length > 0;
  return result;
}

function alreadyGuarded(proto, readOnly) {
  const skip = new Set(readOnly);
  return listHandlers(proto).filter((name) => !skip.has(name) && proto[name] && proto[name][GUARDED] === true);
}

function installGuards(input) {
  const counters = {};
  const src = isObj(input) ? input : {};
  const services = [["ShipService", src.ShipService], ["InvBrokerService", src.InvBrokerService]];
  for (const [label, cls] of services) {
    if (typeof cls !== "function" || !isObj(cls.prototype)) return { ok: false, reason: `no_class:${label}`, counters };
  }
  if (typeof src.throwWrappedUserError !== "function") {
    return { ok: false, reason: "no_throwWrappedUserError", counters };
  }
  if (!src.wing || typeof src.wing.blockedCount !== "function" || typeof src.wing.isBlocked !== "function") {
    return { ok: false, reason: "no_wing_service", counters };
  }
  const config = src.config || {};
  const trigger = config.chatTrigger || "!wing";
  const base = {
    wing: src.wing,
    refuse: (notify) => src.throwWrappedUserError("CustomNotify", { notify }),
    maxScannedIds: config.guardMaxScannedIds,
    notifyText: `Ship is deployed as a wing copy. Use ${trigger} return first.`,
    overflowText: `Too many items in one move while a wing copy is deployed (limit ${config.guardMaxScannedIds}). `
      + "Move fewer items at once.",
    counters,
    onError: typeof src.onError === "function" ? src.onError : undefined,
  };
  const shipAlready = alreadyGuarded(src.ShipService.prototype, READ_ONLY.ShipService);
  const invAlready = alreadyGuarded(src.InvBrokerService.prototype, READ_ONLY.InvBrokerService);
  if (shipAlready.length + invAlready.length > 0) {
    const none = (already) => ({ ok: false, guarded: [], readOnly: [], already, failed: [] });
    return { ok: false, reason: "GUARDS_ALREADY_INSTALLED", ship: none(shipAlready), invBroker: none(invAlready),
      counters };
  }
  const ship = guardPrototype(src.ShipService.prototype, READ_ONLY.ShipService, createGuardFactory(base));
  const invBroker = guardPrototype(src.InvBrokerService.prototype, READ_ONLY.InvBrokerService,
    createGuardFactory({ ...base, contextIds: invBrokerContextIds }));
  const ok = ship.ok && invBroker.ok;
  return { ok, reason: ok ? null : "wrap_failed", ship, invBroker, counters };
}

function installGuardsFromGame(adapter, wing, config, options = {}) {
  if (!adapter || typeof adapter.isConsumerAvailable !== "function" || !adapter.isConsumerAvailable("guards")) {
    return { ok: false, reason: "probe_guards_unavailable", counters: {} };
  }
  const loaded = {};
  for (const [key, rel] of [["ship", "services/ship/shipService"], ["inv", "services/inventory/invBrokerService"],
    ["macho", "common/machoErrors"]]) {
    const r = adapter.requireGame(rel);
    if (!r.ok) return { ok: false, reason: `require_failed:${rel}:${r.reason}`, counters: {} };
    loaded[key] = r.exports;
  }
  const cfg = config || {};
  return installGuards({
    ShipService: loaded.ship, InvBrokerService: loaded.inv,
    throwWrappedUserError: loaded.macho && loaded.macho.throwWrappedUserError, wing, config: cfg,
    onError: createGuardErrorReporter({ log: options.log, intervalMs: cfg.guardErrorLogIntervalMs, now: options.now }),
  });
}

module.exports = {
  GUARDED, READ_ONLY, MAX_DEPTH,
  listHandlers, collectIds, plainTopLevelIds, invBrokerContextIds, createGuardErrorReporter, createGuardFactory,
  guardPrototype, installGuards, installGuardsFromGame,
};
