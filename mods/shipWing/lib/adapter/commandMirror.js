"use strict";

const { characterIdOf } = require("./vendor");
const { REFUSAL } = require("../core/reasons");

const MIRRORED = Symbol.for("shipWing.mirror");
const CONSUMER = "mirror";

function mirrorTargetOf(value) {
  const n = typeof value === "bigint" && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function argAt(args, index) {
  return Array.isArray(args) && args.length > index ? args[index] : null;
}

const HANDLERS = Object.freeze([
  Object.freeze({ service: "EntityService", module: "services/drone/entityService", method: "Handle_CmdEngage",
    counter: "engage", verb: "attack", engage: true, plan: (args) => {
      const targetId = mirrorTargetOf(argAt(args, 1));
      return targetId === null ? null : { verb: "attack", targetId };
    } }),
  Object.freeze({ service: "EntityService", module: "services/drone/entityService", method: "Handle_CmdMineRepeatedly",
    counter: "mine", verb: "mine", plan: (args) => {
      const targetId = mirrorTargetOf(argAt(args, 1));
      return targetId === null ? null : { verb: "mine", targetId };
    } }),
  Object.freeze({ service: "EntityService", module: "services/drone/entityService", method: "Handle_CmdReturnBay",
    counter: "returnBay", verb: "return", droneReturn: true, plan: () => ({ verb: "return" }) }),
  Object.freeze({ service: "EntityService", module: "services/drone/entityService", method: "Handle_CmdReturnHome",
    counter: "returnHome", verb: "hold", droneReturn: true, plan: () => ({ verb: "hold" }) }),
  Object.freeze({ service: "FighterMgrService", module: "services/fighter/fighterMgrService",
    method: "Handle_CmdActivateAbilitySlots", counter: "abilitySlots", verb: "attack", engage: true, plan: (args) => {
      const targetId = mirrorTargetOf(argAt(args, 2));
      return targetId === null ? null : { verb: "attack", targetId };
    } }),
  Object.freeze({ service: "FighterMgrService", module: "services/fighter/fighterMgrService",
    method: "Handle_RecallFightersToTubes", counter: "recallFighters", verb: "hold", engage: true,
    plan: () => ({ verb: "hold", onlyTask: "ATTACK" }) }),
]);

const COUNTER_NAMES = Object.freeze(HANDLERS.flatMap((h) => [
  `mirror.${h.counter}.mirrored`, `mirror.${h.counter}.error`, ...REFUSAL.map((r) => `mirror.${h.counter}.refused.${r}`),
  ...(h.droneReturn ? [`mirror.${h.counter}.skipped.partial`, `mirror.${h.counter}.skipped.unknown`] : []),
  ...(h.engage ? [`mirror.${h.counter}.skipped.disabled`, `mirror.${h.counter}.skipped.copyOff`] : []),
]));

function mirroredVerbs(returnEnabled, engageEnabled) {
  return new Set(HANDLERS.filter((h) => (!h.droneReturn || returnEnabled === true)
    && (!h.engage || engageEnabled === true)).map((h) => h.verb));
}

function isObj(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function commandedDroneIds(raw, out = new Set(), depth = 0) {
  if (raw === null || raw === undefined || depth > 8) return out;
  const items = Array.isArray(raw) ? raw : isObj(raw) && raw.type === "list" && Array.isArray(raw.items) ? raw.items
    : raw instanceof Set ? [...raw] : null;
  if (items) {
    for (const item of items) commandedDroneIds(item, out, depth + 1);
    return out;
  }
  const id = mirrorTargetOf(raw);
  if (id !== null) out.add(id);
  return out;
}

function droneCoverage(args, inSpace) {
  if (!Array.isArray(inSpace)) return "unknown";
  if (inSpace.length === 0) return "partial";
  const named = commandedDroneIds(argAt(args, 0));
  return inSpace.every((id) => named.has(id)) ? "all" : "partial";
}

function createCommandMirror(deps) {
  const protos = (deps && deps.protos) || {};
  const wing = deps && deps.wing;
  const log = (deps && deps.log) || {};
  const returnEnabled = Boolean(deps && deps.returnEnabled === true);
  const droneIdsInSpace = deps && typeof deps.droneIdsInSpace === "function" ? deps.droneIdsInSpace : null;
  const engageEnabled = Boolean(deps && deps.engageEnabled === true);
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let active = false;

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function debug(message) {
    try {
      if (typeof log.debug === "function") log.debug(message);
    } catch (_err) {
    }
  }

  function dronesBefore(entry, session) {
    if (!active || !entry.droneReturn || !returnEnabled) return undefined;
    try {
      const charId = characterIdOf(session);
      if (!(charId > 0) || wing.ownsBlocked(charId) !== true) return undefined;
      const ids = droneIdsInSpace ? droneIdsInSpace(session) : null;
      return Array.isArray(ids) ? ids : null;
    } catch (err) {
      debug(`command mirror ${entry.method} drone list failed - ${(err && err.message) || err}`);
      return null;
    }
  }

  function mirror(entry, args, session, inSpace) {
    try {
      if (entry.droneReturn) {
        if (!returnEnabled || inSpace === undefined) return;
        const coverage = droneCoverage(args, inSpace);
        if (coverage !== "all") {
          bump(`mirror.${entry.counter}.skipped.${coverage}`);
          return;
        }
      }
      if (entry.engage && !engageEnabled) {
        bump(`mirror.${entry.counter}.skipped.disabled`);
        return;
      }
      const plan = entry.plan(args);
      if (!plan) return;
      const charId = characterIdOf(session);
      if (!(charId > 0) || wing.ownsBlocked(charId) !== true) return;
      const view = wing.listWing(charId);
      const rows = view && Array.isArray(view.ships) ? view.ships : [];
      for (const row of rows) {
        if (!row || row.state !== "ACTIVE" || !(row.shipItemId > 0)) continue;
        if (plan.onlyTask && row.task !== plan.onlyTask) continue;
        if (entry.engage && row.mirrorEngage !== true) {
          bump(`mirror.${entry.counter}.skipped.copyOff`);
          continue;
        }
        const opts = plan.targetId ? { targetId: plan.targetId, source: "mirror" } : { source: "mirror" };
        const out = wing.orderCopy(charId, row.shipItemId, plan.verb, opts);
        if (out && out.ok === true) {
          bump(`mirror.${entry.counter}.mirrored`);
        } else {
          const reason = out && REFUSAL.includes(out.reason) ? out.reason : "TASK_UNAVAILABLE";
          bump(`mirror.${entry.counter}.refused.${reason}`);
        }
      }
    } catch (err) {
      bump(`mirror.${entry.counter}.error`);
      debug(`command mirror ${entry.method} failed - ${(err && err.message) || err}`);
    }
  }

  function wrapperFor(entry, base) {
    const wrapper = function shipWingCommandMirror(args, session) {
      const inSpace = dronesBefore(entry, session);
      const result = base.apply(this, arguments);
      if (active) mirror(entry, args, session, inSpace);
      return result;
    };
    for (const symbol of Object.getOwnPropertySymbols(base)) {
      if (symbol !== MIRRORED) wrapper[symbol] = base[symbol];
    }
    wrapper[MIRRORED] = true;
    return wrapper;
  }

  function setMethod(proto, method, descriptor, value) {
    if (descriptor.configurable) {
      Object.defineProperty(proto, method, { ...descriptor, value });
    } else if (descriptor.writable) {
      proto[method] = value;
    } else {
      throw new Error("not writable");
    }
  }

  function install() {
    const out = { ok: false, wrapped: [], already: [], failed: [] };
    const label = (entry) => `${entry.service}.${entry.method}`;
    if (!wing || typeof wing.ownsBlocked !== "function" || typeof wing.listWing !== "function"
      || typeof wing.orderCopy !== "function") {
      return { ...out, reason: "MIRROR_SEAM_UNAVAILABLE", failed: HANDLERS.map(label) };
    }
    const todo = [];
    for (const entry of HANDLERS) {
      const proto = protos[entry.service];
      const descriptor = isObj(proto) ? Object.getOwnPropertyDescriptor(proto, entry.method) : undefined;
      if (!descriptor || typeof descriptor.value !== "function"
        || (!descriptor.configurable && !descriptor.writable)) {
        out.failed.push(label(entry));
      } else if (descriptor.value[MIRRORED] === true) {
        out.already.push(label(entry));
      } else {
        todo.push({ entry, proto, descriptor });
      }
    }
    if (out.failed.length > 0) return { ...out, reason: "MIRROR_SEAM_UNAVAILABLE" };
    if (todo.length === 0) return { ...out, reason: "MIRROR_ALREADY_INSTALLED" };
    if (out.already.length > 0) return { ...out, reason: "MIRROR_PARTIAL_INSTALL" };
    const done = [];
    for (const item of todo) {
      try {
        setMethod(item.proto, item.entry.method, item.descriptor, wrapperFor(item.entry, item.descriptor.value));
        done.push(item);
      } catch (_err) {
        for (const prev of done.reverse()) {
          try {
            setMethod(prev.proto, prev.entry.method, prev.descriptor, prev.descriptor.value);
          } catch (_undoErr) {
          }
        }
        return { ...out, reason: "MIRROR_SEAM_UNAVAILABLE", failed: [label(item.entry)] };
      }
    }
    active = true;
    return { ...out, ok: true, wrapped: todo.map((item) => label(item.entry)) };
  }

  return Object.freeze({
    install,
    stop: () => {
      active = false;
    },
    isActive: () => active,
    stats: () => ({ counters: { ...counters } }),
  });
}

function installCommandMirrorFromGame(gameAdapter, deps) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable(CONSUMER)) {
    return { ok: false, reason: `probe_${CONSUMER}_unavailable` };
  }
  const protos = {};
  for (const entry of HANDLERS) {
    if (protos[entry.service]) continue;
    const loaded = gameAdapter.requireGame(entry.module);
    if (!loaded || !loaded.ok) return { ok: false, reason: `require_failed:${entry.module}:${loaded && loaded.reason}` };
    const cls = loaded.exports;
    protos[entry.service] = typeof cls === "function" ? cls.prototype : null;
  }
  const mirror = createCommandMirror({ protos, wing: deps && deps.wing, log: deps && deps.log,
    returnEnabled: deps && deps.returnEnabled, droneIdsInSpace: deps && deps.droneIdsInSpace,
    engageEnabled: deps && deps.engageEnabled });
  const out = mirror.install();
  if (!out.ok) {
    mirror.stop();
    const detail = out.failed.length > 0 ? `:${out.failed.join(",")}` : "";
    return { ok: false, reason: `${out.reason || "MIRROR_INSTALL_FAILED"}${detail}` };
  }
  return { ok: true, mirror, wrapped: out.wrapped };
}

module.exports = {
  MIRRORED, CONSUMER, HANDLERS, COUNTER_NAMES, mirrorTargetOf, mirroredVerbs, commandedDroneIds, droneCoverage,
  createCommandMirror, installCommandMirrorFromGame,
};
