"use strict";

const WRAPPED = Symbol.for("shipWing.npcAggroScope");
const SUSPEND_WRAPPED = Symbol.for("shipWing.npcAggroSuspend");
const ACCESSOR = Symbol.for("shipWing.npcAggroAccessor");
const CONSUMER = "npcAggro";
const BEHAVIOR_MODULE = "space/npc/npcBehaviorLoop";
const SCENE_MODULE = "space/runtime/solarSystemScene";
const SCENE_EXPORT = "SolarSystemScene";
const BEHAVIOR_EXPORTS = Object.freeze(["tickScene", "tickControllersByEntityID"]);
const SUSPEND_METHODS = Object.freeze(["activateGenericModule", "deactivateGenericModule", "launchMissile"]);
const COUNTERS = Object.freeze(["npcAggro.attached", "npcAggro.attachFailed", "npcAggro.scopes",
  "npcAggro.overwritten", "npcAggro.error"]);

function isObj(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isFn(value) {
  return typeof value === "function";
}

function posInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function intOr0(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : 0;
}

function copySymbols(from, to, own) {
  for (const symbol of Object.getOwnPropertySymbols(from)) {
    if (symbol === own) continue;
    try {
      to[symbol] = from[symbol];
    } catch (_err) {
    }
  }
}

function setMethod(proto, name, value) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(proto, name, { value, writable: true, configurable: true,
        enumerable: descriptor ? descriptor.enumerable : false });
    } else if (descriptor.writable) {
      proto[name] = value;
    } else {
      return false;
    }
  } catch (_err) {
    return false;
  }
  return proto[name] === value;
}

function createNpcAggro(deps = {}) {
  const log = deps && isObj(deps.log) ? deps.log : null;
  const counters = Object.fromEntries(COUNTERS.map((name) => [name, 0]));
  let active = false;
  let depth = 0;
  let suspended = 0;
  let wing = null;
  let hookOk = false;
  let suspendOk = false;
  let selfOk = false;
  let status = "armed";

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function debug(message) {
    try {
      if (log && isFn(log.debug)) log.debug(message);
    } catch (_err) {
    }
  }

  function liveTwins() {
    try {
      return Number(wing.liveTwinCount()) || 0;
    } catch (err) {
      bump("npcAggro.error");
      debug(`npc aggro liveTwinCount failed - ${(err && err.message) || err}`);
      return 0;
    }
  }

  function makeScopeWrapper(base) {
    return function shipWingNpcAggroScope() {
      if (!active || liveTwins() <= 0) return base.apply(this, arguments);
      const savedSuspended = suspended;
      depth += 1;
      suspended = 0;
      bump("npcAggro.scopes");
      try {
        return base.apply(this, arguments);
      } finally {
        depth -= 1;
        suspended = savedSuspended;
      }
    };
  }

  function makeSuspendWrapper(base) {
    return function shipWingNpcAggroSuspend() {
      if (depth === 0) return base.apply(this, arguments);
      suspended += 1;
      try {
        return base.apply(this, arguments);
      } finally {
        suspended -= 1;
      }
    };
  }

  function wrapBehaviorExports(exportsObject) {
    const refuse = (reason) => {
      status = `hook_${reason}`;
      return { ok: false, reason };
    };
    if (!isObj(exportsObject) || BEHAVIOR_EXPORTS.some((name) => !isFn(exportsObject[name]))) {
      return refuse("SHAPE_MISMATCH");
    }
    if (hookOk || BEHAVIOR_EXPORTS.some((name) => exportsObject[name][WRAPPED] === true)) {
      return refuse("ALREADY_WRAPPED");
    }
    const originals = {};
    for (const name of BEHAVIOR_EXPORTS) {
      const base = exportsObject[name];
      const wrapper = makeScopeWrapper(base);
      copySymbols(base, wrapper, WRAPPED);
      wrapper[WRAPPED] = true;
      let placed = false;
      try {
        exportsObject[name] = wrapper;
        placed = exportsObject[name] === wrapper;
      } catch (_err) {
        placed = false;
      }
      if (!placed) {
        for (const done of Object.keys(originals)) {
          try {
            exportsObject[done] = originals[done];
          } catch (_err) {
          }
        }
        return refuse("ASSIGN_FAILED");
      }
      originals[name] = base;
    }
    hookOk = true;
    return { ok: true };
  }

  function installSuspension(proto) {
    const refuse = (reason) => {
      status = `suspend_${reason}`;
      return { ok: false, reason };
    };
    if (!isObj(proto) || SUSPEND_METHODS.some((name) => !isFn(proto[name]))) return refuse("SEAM_UNAVAILABLE");
    if (suspendOk || SUSPEND_METHODS.some((name) => proto[name][SUSPEND_WRAPPED] === true)) {
      return refuse("ALREADY_INSTALLED");
    }
    const placed = [];
    for (const name of SUSPEND_METHODS) {
      const base = proto[name];
      const wrapper = makeSuspendWrapper(base);
      copySymbols(base, wrapper, SUSPEND_WRAPPED);
      wrapper[SUSPEND_WRAPPED] = true;
      if (!setMethod(proto, name, wrapper)) {
        for (const done of placed) setMethod(proto, done.name, done.base);
        return refuse("INSTALL_FAILED");
      }
      placed.push({ name, base });
    }
    suspendOk = true;
    return { ok: true };
  }

  function selfCheck(testing) {
    let ok = false;
    try {
      const resolve = isObj(testing) ? testing.resolveCombatActorClass : null;
      ok = isFn(resolve)
        && resolve({ kind: "ship", session: { characterID: 1 } }) === "player"
        && resolve({ kind: "ship", session: null }) === null;
    } catch (_err) {
      ok = false;
    }
    if (!ok) {
      status = "selfcheck_failed";
      return { ok: false, reason: "SELFCHECK_FAILED" };
    }
    selfOk = true;
    return { ok: true };
  }

  function activate(activateDeps) {
    if (!hookOk) return { ok: false, reason: "HOOK_NOT_APPLIED" };
    if (!selfOk) return { ok: false, reason: "SELFCHECK_MISSING" };
    if (!suspendOk) return { ok: false, reason: "SUSPEND_MISSING" };
    const w = activateDeps && activateDeps.wing;
    if (!isObj(w) || !isFn(w.twinOf) || !isFn(w.liveTwinCount)) return { ok: false, reason: "WING_UNAVAILABLE" };
    wing = w;
    active = true;
    status = "ok";
    return { ok: true };
  }

  function deactivate() {
    active = false;
  }

  function attach(entity) {
    if (!active) return { ok: false, reason: "NOT_ACTIVE" };
    const refuse = (reason) => {
      bump("npcAggro.attachFailed");
      return { ok: false, reason };
    };
    if (!isObj(entity) || entity.kind !== "ship" || !posInt(entity.itemID)) return refuse("NOT_A_TWIN");
    const owner = posInt(entity.pilotCharacterID) || posInt(entity.ownerID);
    if (!owner) return refuse("NO_OWNER");
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(entity, "session");
    } catch (_err) {
      return refuse("DEFINE_FAILED");
    }
    if (descriptor && isFn(descriptor.get) && descriptor.get[ACCESSOR] === true) return { ok: true };
    if (descriptor && descriptor.configurable === false) return refuse("DEFINE_FAILED");
    const base = descriptor && "value" in descriptor ? descriptor.value : null;
    const overlay = {
      characterID: owner,
      corporationID: intOr0(entity.corporationID),
      allianceID: intOr0(entity.allianceID),
      warFactionID: intOr0(entity.warFactionID),
      shipWingNpcAggro: true,
    };
    const get = function shipWingNpcAggroSession() {
      if (!active || depth === 0 || suspended > 0) return base;
      if (entity.destroying === true || entity.destructionState === "destroying"
        || entity.destructionState === "destroyed") {
        return base;
      }
      try {
        if (!wing.twinOf(entity)) return base;
      } catch (_err) {
        bump("npcAggro.error");
        return base;
      }
      return overlay;
    };
    get[ACCESSOR] = true;
    const set = function shipWingNpcAggroSessionSet(value) {
      try {
        Object.defineProperty(entity, "session", { value, writable: true, enumerable: true, configurable: true });
        bump("npcAggro.overwritten");
      } catch (_err) {
        bump("npcAggro.error");
      }
    };
    try {
      Object.defineProperty(entity, "session", { get, set, configurable: true, enumerable: false });
    } catch (_err) {
      return refuse("DEFINE_FAILED");
    }
    bump("npcAggro.attached");
    return { ok: true };
  }

  return Object.freeze({
    wrapBehaviorExports,
    installSuspension,
    selfCheck,
    activate,
    deactivate,
    attach,
    status: () => status,
    isActive: () => active,
    scope: () => ({ depth, suspended }),
    stats: () => ({ counters: { ...counters } }),
  });
}

function activateNpcAggroFromGame(gameAdapter, controller, hookResult, deps) {
  if (!isObj(controller)) return "error";
  if (!isObj(hookResult)) return "hook_not_applied";
  if (hookResult.ok !== true) return `hook_${hookResult.reason}`;
  if (!gameAdapter || !isFn(gameAdapter.isConsumerAvailable) || !gameAdapter.isConsumerAvailable(CONSUMER)) {
    return `probe_${CONSUMER}_unavailable`;
  }
  const behavior = gameAdapter.requireGame(BEHAVIOR_MODULE);
  const testing = behavior && behavior.ok && isObj(behavior.exports) ? behavior.exports.__testing : null;
  if (!controller.selfCheck(testing).ok) return "selfcheck_failed";
  const scene = gameAdapter.requireGame(SCENE_MODULE);
  const cls = scene && scene.ok && isObj(scene.exports) ? scene.exports[SCENE_EXPORT] : null;
  const installed = controller.installSuspension(isFn(cls) ? cls.prototype : null);
  if (!installed.ok) return `suspend_${installed.reason}`;
  const activated = controller.activate({ wing: deps && deps.wing });
  return activated.ok ? "ok" : "error";
}

module.exports = {
  WRAPPED, SUSPEND_WRAPPED, ACCESSOR, CONSUMER, BEHAVIOR_MODULE, SCENE_MODULE, SCENE_EXPORT, BEHAVIOR_EXPORTS,
  SUSPEND_METHODS, COUNTERS, createNpcAggro, activateNpcAggroFromGame,
};
