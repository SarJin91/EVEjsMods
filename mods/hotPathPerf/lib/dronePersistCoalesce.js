"use strict";

const HOOK_NAME = "hotPathPerf.dronePersist";
const DETAIL_MAX = 200;
const MOTION_KEYS = Object.freeze([
  "position", "velocity", "direction", "targetPoint", "speedFraction",
  "followRange", "orbitDistance", "orbitNormal", "orbitSign",
]);
const MOTION_SET = new Set(MOTION_KEYS);
const CAS_KEYS = Object.freeze(["locationID", "flagID", "ownerID", "typeID", "singleton", "launcherID", "customInfo"]);
const FLUSH_REASONS = Object.freeze(["timer", "foreign", "dispose", "shutdown", "limit", "disable"]);
const COALESCED = Object.freeze({ success: true, coalesced: true });

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfDrone", { value: true });
  Object.defineProperty(wrapper, "__hotPathPerfOriginal", { value: original });
  return wrapper;
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
}

function defaultClearTimer(handle) {
  clearTimeout(handle);
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === "object";

function sameKeySet(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!hasOwn(b, k)) return false;
  return true;
}

function sameExceptMotion(a, b) {
  if (!isObject(a) || !isObject(b) || !sameKeySet(a, b)) return false;
  for (const k of Object.keys(a)) {
    if (k === "spaceState") continue;
    if (!Object.is(a[k], b[k])) return false;
  }
  const sa = a.spaceState;
  const sb = b.spaceState;
  if (!isObject(sa) || !isObject(sb) || !sameKeySet(sa, sb)) return false;
  for (const k of Object.keys(sa)) {
    if (MOTION_SET.has(k)) continue;
    if (!Object.is(sa[k], sb[k])) return false;
  }
  return true;
}

function pickMotion(spaceState) {
  const out = {};
  for (const k of MOTION_KEYS) if (hasOwn(spaceState, k)) out[k] = spaceState[k];
  return out;
}

function casEqual(cur, base) {
  if (!isObject(cur) || !isObject(base)) return false;
  for (const k of CAS_KEYS) if (!Object.is(cur[k], base[k])) return false;
  return JSON.stringify(cur.spaceState) === JSON.stringify(base.spaceState);
}

function emptyWindow() {
  const flushes = {};
  for (const r of FLUSH_REASONS) flushes[r] = 0;
  return {
    intercepted: 0, coalesced: 0, realFirst: 0, realInterval: 0, realChanged: 0, flushes,
    droppedCas: 0, droppedNotFound: 0, droppedShutdown: 0, writeErrors: 0, writeWarned: false,
    flushMaxMs: 0, maxAgeMs: 0,
  };
}

function createDronePersistCoalesce(options) {
  const config = options.config;
  const log = options.log;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || defaultSetTimer;
  const clearTimer = options.clearTimer || defaultClearTimer;
  const coalesceMs = Math.max(0, Number(config.dronePersistCoalesceMs) || 0);
  const maxItems = Math.max(0, Math.floor(Number(config.dronePersistCoalesceMaxItems) || 0));

  const priv = {
    items: null, drone: null, store: null, original: null, disabledReason: null,
    hooks: { scope: false, dispose: false },
    scene: null,
    tracked: new Map(),
    timer: null, flushing: false, hookRegistered: false,
    window: emptyWindow(),
  };

  function setItemStoreDeps(m) {
    if (priv.items) return true;
    if (!isObject(m) || typeof m.findItemById !== "function") return false;
    priv.items = { findItemById: (id) => m.findItemById(id) };
    return true;
  }

  function setDroneDeps(m) {
    if (priv.drone) return true;
    if (!isObject(m) || typeof m.isDroneEntity !== "function" || typeof m.DRONE_COMMAND_MINE !== "string" ||
      typeof m.STATE_MINING !== "number" || typeof m.STATE_APPROACHING !== "number") return false;
    priv.drone = {
      isDroneEntity: m.isDroneEntity,
      DRONE_COMMAND_MINE: m.DRONE_COMMAND_MINE,
      STATE_MINING: m.STATE_MINING,
      STATE_APPROACHING: m.STATE_APPROACHING,
    };
    return true;
  }

  function setStoreDeps(m) {
    if (priv.store) return true;
    if (!isObject(m) || typeof m.registerShutdownHook !== "function" || typeof m.isShutdownInProgress !== "function") return false;
    priv.store = {
      registerShutdownHook: (name, fn) => m.registerShutdownHook(name, fn),
      isShutdownInProgress: () => m.isShutdownInProgress() === true,
    };
    return true;
  }

  function stopTimer() {
    if (priv.timer === null) return;
    const handle = priv.timer;
    priv.timer = null;
    try { clearTimer(handle); } catch (_error) {}
  }

  function pendingCount() {
    let n = 0;
    for (const e of priv.tracked.values()) if (e.motion) n += 1;
    return n;
  }

  function warnWrite(id, reason, detail) {
    const w = priv.window;
    w.writeErrors += 1;
    if (!w.writeWarned) {
      w.writeWarned = true;
      log(`WARN dronePersistCoalesce write failed (item=${id} reason=${reason}): ${fit(detail)}`);
    }
  }

  function flushItem(id, reason) {
    const entry = priv.tracked.get(id);
    if (!entry) return { ok: false, reason: "NOT_TRACKED" };
    if (!entry.motion) return { ok: true, written: 0 };
    const w = priv.window;
    if (reason !== "shutdown" && priv.store && priv.store.isShutdownInProgress()) {
      w.droppedShutdown += 1;
      priv.tracked.delete(id);
      return { ok: false, reason: "SHUTDOWN" };
    }
    const started = now();
    if (entry.firstPendingAtMs !== null) {
      const age = started - entry.firstPendingAtMs;
      if (age > w.maxAgeMs) w.maxAgeMs = age;
    }
    try {
      const cur = priv.items ? priv.items.findItemById(id) : null;
      if (!cur) {
        w.droppedNotFound += 1;
        priv.tracked.delete(id);
        return { ok: false, reason: "NOT_FOUND" };
      }
      if (!casEqual(cur, entry.base)) {
        w.droppedCas += 1;
        priv.tracked.delete(id);
        return { ok: false, reason: "CAS" };
      }
      const motion = entry.motion;
      let r;
      priv.flushing = true;
      try {
        r = priv.original(id, (c) => ({ ...c, spaceState: { ...(isObject(c) ? c.spaceState : null), ...motion } }));
      } catch (error) {
        warnWrite(id, reason, error && error.message || error);
        priv.tracked.delete(id);
        return { ok: false, reason: "WRITE_FAILED" };
      } finally {
        priv.flushing = false;
      }
      if (r && r.success === true && isObject(r.data)) {
        entry.base = r.data;
        entry.lastRealAtMs = now();
        entry.motion = null;
        entry.firstPendingAtMs = null;
        if (hasOwn(w.flushes, reason)) w.flushes[reason] += 1;
        return { ok: true, written: 1 };
      }
      warnWrite(id, reason, r && r.errorMsg || "success!==true");
      priv.tracked.delete(id);
      return { ok: false, reason: "WRITE_FAILED" };
    } finally {
      const ms = now() - started;
      if (ms > w.flushMaxMs) w.flushMaxMs = ms;
    }
  }

  function flushAll(reason) {
    if (priv.disabledReason) return { ok: false, reason: "DISABLED" };
    if (pendingCount() === 0) return { ok: true, written: 0, dropped: 0 };
    if (!priv.original || !priv.items) return { ok: false, reason: "NO_DEPS" };
    try {
      let written = 0;
      let dropped = 0;
      for (const [id, entry] of [...priv.tracked]) {
        if (!entry.motion) continue;
        const r = flushItem(id, reason);
        if (r.ok) written += r.written;
        else dropped += 1;
      }
      return { ok: true, written, dropped };
    } catch (_error) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    try { flushAll("disable"); } catch (_error) {}
    stopTimer();
    priv.tracked.clear();
    priv.disabledReason = reason;
    log(`WARN dronePersistCoalesce disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function onTimer() {
    priv.timer = null;
    if (priv.disabledReason) return;
    try {
      const t = now();
      for (const [id, entry] of [...priv.tracked]) {
        const age = t - entry.lastRealAtMs;
        if (entry.motion) {
          if (age >= coalesceMs) flushItem(id, "timer");
        } else if (age >= 2 * coalesceMs) {
          priv.tracked.delete(id);
        }
      }
    } catch (error) {
      log(`WARN dronePersistCoalesce timer error: ${fit(error && error.message || error)}`);
    }
    if (priv.tracked.size > 0) armTimer();
  }

  function armTimer() {
    if (priv.timer !== null || coalesceMs <= 0 || priv.disabledReason) return;
    priv.timer = setTimer(onTimer, coalesceMs);
  }

  function registerHook() {
    if (priv.hookRegistered || !priv.store) return;
    priv.hookRegistered = true;
    try {
      priv.store.registerShutdownHook(HOOK_NAME, () => { flushAll("shutdown"); });
    } catch (error) {
      log(`WARN dronePersistCoalesce shutdown hook not registered: ${fit(error && error.message || error)}`);
    }
  }

  function enforceLimit() {
    while (priv.tracked.size > maxItems) {
      const oldest = priv.tracked.keys().next().value;
      flushItem(oldest, "limit");
      priv.tracked.delete(oldest);
    }
  }

  function isCandidate(id, updater) {
    const scene = priv.scene;
    const d = priv.drone;
    if (scene === null || !d || typeof updater !== "function" || typeof scene.getEntityByID !== "function") return false;
    const e = scene.getEntityByID(id);
    return Boolean(e) && d.isDroneEntity(e) === true && Number(e.itemID) === id && e.droneCommand === d.DRONE_COMMAND_MINE &&
      (e.activityState === d.STATE_MINING || e.activityState === d.STATE_APPROACHING);
  }

  function wrapUpdate(original, mode = "full") {
    const successOnly = mode === "successOnly";
    if (!successOnly) priv.original = original;
    const handle = function (self, args, itemId, updater) {
      if (priv.disabledReason || priv.flushing || coalesceMs === 0 || (priv.scene === null && priv.tracked.size === 0)) {
        return original.apply(self, args);
      }
      let kind = "pass";
      let id = 0;
      let counter = null;
      try {
        id = Number(itemId);
        const entry = priv.tracked.get(id);
        if (!isCandidate(id, updater)) {
          if (entry) {
            if (entry.motion) {
              flushItem(id, "foreign");
            }
            priv.tracked.delete(id);
          }
        } else {
          priv.window.intercepted += 1;
          if (!entry) {
            kind = "real";
            counter = "realFirst";
          } else if (now() - entry.lastRealAtMs >= coalesceMs) {
            kind = "real";
            counter = "realInterval";
          } else {
            const next = updater({ ...entry.base });
            if (!sameExceptMotion(next, entry.ref)) {
              kind = "real";
              counter = "realChanged";
            } else {
              entry.motion = pickMotion(next.spaceState);
              if (entry.firstPendingAtMs === null) entry.firstPendingAtMs = now();
              priv.window.coalesced += 1;
              armTimer();
              registerHook();
              enforceLimit();
              kind = "defer";
            }
          }
        }
      } catch (error) {
        disable("error", String(error && error.message || error));
        return original.apply(self, args);
      }
      if (kind === "defer") return COALESCED;
      const r = original.apply(self, args);
      if (kind === "real") {
        try {
          priv.window[counter] += 1;
          const base = r && r.success === true ? (successOnly ? priv.items.findItemById(id) : r.data) : null;
          if (isObject(base)) {
            const existing = priv.tracked.get(id);
            const fresh = { base, ref: updater({ ...base }), lastRealAtMs: now(), motion: null, firstPendingAtMs: null };
            if (existing) Object.assign(existing, fresh);
            else priv.tracked.set(id, fresh);
            armTimer();
            enforceLimit();
          } else {
            priv.tracked.delete(id);
          }
        } catch (error) {
          disable("error", String(error && error.message || error));
        }
      }
      return r;
    };
    const wrapped = successOnly
      ? function updateInventoryItemSuccessOnly(itemId, updater) { return handle(this, arguments, itemId, updater); }
      : function updateInventoryItem(itemId, updater) { return handle(this, arguments, itemId, updater); };
    return markWrapped(wrapped, original);
  }

  function wrapTickScope(original) {
    priv.hooks.scope = true;
    const wrapped = function tickScene(scene) {
      const prev = priv.scene;
      priv.scene = isObject(scene) ? scene : null;
      try {
        return original.apply(this, arguments);
      } finally {
        priv.scene = prev;
      }
    };
    return markWrapped(wrapped, original);
  }

  function wrapFlushPoint(original, reason) {
    priv.hooks[reason] = true;
    const wrapped = function hotPathPerfDroneFlush() {
      if (!priv.disabledReason && priv.tracked.size > 0) {
        try {
          flushAll(reason);
        } catch (error) {
          log(`WARN dronePersistCoalesce flush error (${reason}): ${fit(error && error.message || error)}`);
        }
      }
      return original.apply(this, arguments);
    };
    return markWrapped(wrapped, original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return priv.items && priv.drone && priv.store && priv.original ? "ready" : "waiting";
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      disabledReason: priv.disabledReason,
      state: stateText(),
      hooks: { ...priv.hooks },
      tracked: priv.tracked.size,
      pending: pendingCount(),
      timerArmed: priv.timer !== null,
      hookRegistered: priv.hookRegistered,
    };
  }

  function statsSnapshot() {
    const { flushes, ...rest } = priv.window;
    return { ...status(), ...rest, flushes: { ...flushes } };
  }

  function drainStatsLines() {
    const w = priv.window;
    const line = `stats dronePersistCoalesce state=${stateText()} tracked=${priv.tracked.size} pending=${pendingCount()} ` +
      `intercepted=${w.intercepted} coalesced=${w.coalesced} ` +
      `real=first:${w.realFirst},interval:${w.realInterval},changed:${w.realChanged} ` +
      `flushes=${FLUSH_REASONS.filter((r) => r !== "disable").map((r) => `${r}:${w.flushes[r]}`).join(",")} ` +
      `dropped=cas:${w.droppedCas},notFound:${w.droppedNotFound},shutdown:${w.droppedShutdown} writeErrors=${w.writeErrors} ` +
      `flushMaxMs=${w.flushMaxMs} maxAgeMs=${w.maxAgeMs}`;
    priv.window = emptyWindow();
    return [line];
  }

  return {
    setItemStoreDeps, setDroneDeps, setStoreDeps, wrapUpdate, wrapTickScope, wrapFlushPoint,
    flushAll, flushItem, disable, status, statsSnapshot, drainStatsLines,
  };
}

module.exports = {
  createDronePersistCoalesce, sameExceptMotion, casEqual, MOTION_KEYS, CAS_KEYS, HOOK_NAME, FLUSH_REASONS, COALESCED,
};
