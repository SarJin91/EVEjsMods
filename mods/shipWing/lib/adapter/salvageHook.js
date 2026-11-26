"use strict";

const { twinShipItem } = require("./twinDogma");

const WRAPPED = Symbol.for("shipWing.salvage");
const RUNTIME_MODULE = "space/modules/salvagerRuntime";
const WRAPPED_EXPORTS = Object.freeze(["resolveSalvagerActivation", "executeSalvagerCycle"]);
const HOST_CALLBACKS = Object.freeze([
  "resolveCharacterID", "getEntityRuntimeShipItem", "getEntityRuntimeFittedItems", "getEntityRuntimeSkillMap",
  "resolveSession",
]);
const ACTIVATE_REFUSAL = Object.freeze([
  "TARGET_REQUIRED", "TARGET_NOT_FOUND", "TARGET_NOT_LOCKED", "UNSUPPORTED_MODULE", "TARGET_OUT_OF_RANGE",
  "SALVAGE_CHANCE_TOO_LOW",
]);
const CYCLE_REFUSAL = Object.freeze(["module", "target", "range", "cargo", "other"]);
const COUNTER_NAMES = Object.freeze([
  "salvage.cycle.ok", "salvage.cycle.error", "salvage.hook.error",
  "salvage.cycle.miss", "salvage.cycle.noHost", ...CYCLE_REFUSAL.map((r) => `salvage.cycle.refused.${r}`),
  "salvage.activate.blocked",
  ...ACTIVATE_REFUSAL.map((code) => `salvage.activate.refused.${code}`),
  "salvage.boundary.module", "salvage.boundary.noModule",
]);
const BOUNDARY_MODULE = "space/runtime/moduleCycleBoundarySnapshot";
const BOUNDARY_EXPORT = "resolveSalvagerCycleRuntimeSnapshot";
const BOUNDARY_ARITY = 5;
const BOUNDARY_WRAPPED = Symbol.for("shipWing.salvageBoundary");
const SALVAGE_TASK = "SALVAGE";

function isObj(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function createSalvageHook(input) {
  const target = input && input.salvagerRuntime;
  const deps = (input && input.deps) || {};
  const wing = input && input.wing;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const originals = new Map();
  const wrappers = new Map();
  let active = false;
  let installed = false;

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function twinFor(entity) {
    try {
      if (!entity || typeof entity !== "object" || wing.liveTwinCount() === 0) return null;
      return wing.twinOf(entity) || null;
    } catch (_err) {
      bump("salvage.hook.error");
      return null;
    }
  }

  function twinActivation(base, self, args, owner) {
    const twin = args.entity;
    const shipItem = twinShipItem(twin, deps);
    if (!shipItem) {
      bump("salvage.activate.refused.UNSUPPORTED_MODULE");
      return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
    }
    const out = base.call(self, {
      ...args,
      shipItem,
      fittedItems: Array.isArray(twin.fittedItems) ? twin.fittedItems : [],
      skillMap: twin.skillMap instanceof Map ? twin.skillMap : new Map(),
      activeModuleContexts: [],
      options: { ...(isObj(args.options) ? args.options : {}), characterID: owner.ownerCharacterId },
    });
    if (out && out.matched === true && !inSalvageTask(twin)) {
      bump("salvage.activate.blocked");
      return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
    }
    if (out && out.matched === true && out.success !== true && ACTIVATE_REFUSAL.includes(out.errorMsg)) {
      bump(`salvage.activate.refused.${out.errorMsg}`);
    }
    return out;
  }

  function inSalvageTask(twin) {
    const rt = wing.twinTaskContext(twin);
    return Boolean(rt && rt.task === SALVAGE_TASK);
  }

  function countCycle(out) {
    if (out && isObj(out.data) && out.data.salvaged === true) {
      bump("salvage.cycle.ok");
    } else if (out && out.success === true) {
      bump("salvage.cycle.miss");
    } else {
      const reason = out && CYCLE_REFUSAL.includes(out.stopReason) ? out.stopReason : "other";
      bump(`salvage.cycle.refused.${reason}`);
    }
  }

  function twinCycle(base, self, args, owner) {
    const twin = args.entity;
    const rt = wing.twinTaskContext(twin);
    const hostShipId = toInt(rt && rt.salvage && rt.salvage.hostShipId, 0);
    const scene = args.scene;
    const host = hostShipId > 0 && scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(hostShipId) : null;
    if (!host) {
      bump("salvage.cycle.noHost");
      return { success: false, stopReason: "cargo" };
    }
    const cb = isObj(args.callbacks) ? args.callbacks : {};
    const call = (name) => (typeof cb[name] === "function" ? cb[name](host) : null);
    const out = base.call(self, {
      ...args,
      callbacks: {
        ...cb,
        resolveCharacterID: () => owner.ownerCharacterId,
        getEntityRuntimeShipItem: () => call("getEntityRuntimeShipItem"),
        getEntityRuntimeFittedItems: () => call("getEntityRuntimeFittedItems") || [],
        getEntityRuntimeSkillMap: () => call("getEntityRuntimeSkillMap"),
        resolveSession: () => call("resolveSession"),
      },
    });
    countCycle(out);
    return out;
  }

  const TWIN_PATH = {
    resolveSalvagerActivation(base, self, args, owner) {
      try {
        return twinActivation(base, self, args, owner);
      } catch (_err) {
        bump("salvage.cycle.error");
        return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
      }
    },
    executeSalvagerCycle(base, self, args, owner) {
      try {
        return twinCycle(base, self, args, owner);
      } catch (_err) {
        bump("salvage.cycle.error");
        return { success: false, stopReason: "salvager" };
      }
    },
  };

  function makeWrapper(name, base) {
    const twinPath = TWIN_PATH[name];
    const wrapper = function shipWingSalvage() {
      if (!active) return base.apply(this, arguments);
      const args = arguments[0];
      const owner = isObj(args) ? twinFor(args.entity) : null;
      if (!owner) return base.apply(this, arguments);
      return twinPath(base, this, args, owner);
    };
    for (const symbol of Object.getOwnPropertySymbols(base)) {
      if (symbol !== WRAPPED) wrapper[symbol] = base[symbol];
    }
    wrapper[WRAPPED] = true;
    return wrapper;
  }

  function install() {
    if (!isObj(target) || WRAPPED_EXPORTS.some((name) => typeof target[name] !== "function") || !wing
      || typeof wing.twinOf !== "function" || typeof wing.liveTwinCount !== "function"
      || typeof wing.twinTaskContext !== "function" || typeof deps.buildRuntimeShipItemFromEntity !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE" };
    }
    if (installed || WRAPPED_EXPORTS.some((name) => target[name][WRAPPED] === true)) {
      return { ok: false, reason: "ALREADY" };
    }
    const done = [];
    for (const name of WRAPPED_EXPORTS) {
      const base = target[name];
      const wrapper = makeWrapper(name, base);
      try {
        target[name] = wrapper;
      } catch (_err) {
      }
      if (target[name] !== wrapper) {
        for (const prev of done) {
          if (target[prev] === wrappers.get(prev)) target[prev] = originals.get(prev);
        }
        return { ok: false, reason: "INSTALL_FAILED" };
      }
      originals.set(name, base);
      wrappers.set(name, wrapper);
      done.push(name);
    }
    installed = true;
    active = true;
    return { ok: true, installed: done };
  }

  function boundaryModule(entity, effectState) {
    if (!active) return null;
    const owner = twinFor(entity);
    if (!owner) return null;
    const fitted = Array.isArray(entity.fittedItems) ? entity.fittedItems : [];
    const id = toInt(effectState && effectState.moduleID, 0);
    const flag = toInt(effectState && effectState.moduleFlagID, 0);
    const found = (id > 0 && fitted.find((m) => toInt(m && m.itemID, 0) === id))
      || (flag > 0 && fitted.find((m) => toInt(m && m.flagID, 0) === flag)) || null;
    bump(found ? "salvage.boundary.module" : "salvage.boundary.noModule");
    return found;
  }

  function uninstall() {
    active = false;
    for (const [name, wrapper] of wrappers) {
      if (target[name] === wrapper) target[name] = originals.get(name);
    }
    installed = false;
  }

  return Object.freeze({
    install,
    uninstall,
    isActive: () => active,
    boundaryModule,
    stats: () => ({ counters: { ...counters } }),
  });
}

function wrapBoundaryExports(exportsObject, getHook) {
  const base = isObj(exportsObject) ? exportsObject[BOUNDARY_EXPORT] : null;
  if (typeof base !== "function" || typeof getHook !== "function") {
    return { ok: false, reason: "BOUNDARY_SEAM_UNAVAILABLE" };
  }
  if (base[BOUNDARY_WRAPPED] === true) return { ok: false, reason: "ALREADY" };
  if (base.length !== BOUNDARY_ARITY) return { ok: false, reason: "BOUNDARY_SIGNATURE" };
  const wrapper = function shipWingSalvageBoundary(_scene, entity, moduleItem, effectState, _nowMs) {
    let resolved = null;
    if (!moduleItem) {
      try {
        const hook = getHook();
        resolved = hook && typeof hook.boundaryModule === "function" ? hook.boundaryModule(entity, effectState) : null;
      } catch (_err) {
        resolved = null;
      }
    }
    if (!resolved) return base.apply(this, arguments);
    const args = Array.prototype.slice.call(arguments);
    args[2] = resolved;
    return base.apply(this, args);
  };
  for (const symbol of Object.getOwnPropertySymbols(base)) {
    if (symbol !== BOUNDARY_WRAPPED) wrapper[symbol] = base[symbol];
  }
  wrapper[BOUNDARY_WRAPPED] = true;
  try {
    exportsObject[BOUNDARY_EXPORT] = wrapper;
  } catch (_err) {
  }
  return exportsObject[BOUNDARY_EXPORT] === wrapper ? { ok: true } : { ok: false, reason: "INSTALL_FAILED" };
}

function installSalvageHook(salvagerRuntimeExports, input) {
  const hook = createSalvageHook({ salvagerRuntime: salvagerRuntimeExports, deps: input && input.deps,
    wing: input && input.wing });
  const out = hook.install();
  return out.ok ? { ...out, hook } : out;
}

const SALVAGE_MODULES = Object.freeze({
  salvagerRuntime: RUNTIME_MODULE,
  entityDogmaView: "space/runtime/entityDogmaView",
});

function installSalvageHookFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("salvage")) {
    return { ok: false, reason: "probe_salvage_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(SALVAGE_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  const deps = {
    buildRuntimeShipItemFromEntity: (...args) => game.entityDogmaView.buildRuntimeShipItemFromEntity(...args),
  };
  return installSalvageHook(game.salvagerRuntime, { wing: input && input.wing, deps });
}

module.exports = {
  WRAPPED, RUNTIME_MODULE, WRAPPED_EXPORTS, HOST_CALLBACKS, ACTIVATE_REFUSAL, CYCLE_REFUSAL, COUNTER_NAMES,
  SALVAGE_MODULES, BOUNDARY_MODULE, BOUNDARY_EXPORT, BOUNDARY_ARITY, BOUNDARY_WRAPPED,
  createSalvageHook, installSalvageHook, installSalvageHookFromGame, wrapBoundaryExports,
};
