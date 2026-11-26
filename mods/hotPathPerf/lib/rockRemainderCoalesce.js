"use strict";

const KEY = "miningRockRemainingByID";
const AIR_TEMPLATE_ID = "evejs.air-tutorial:9245";
const MISSION_KEY = "missionMining";
const NOT_FOUND = "DUNGEON_INSTANCE_NOT_FOUND";
const HOOK_NAME = "hotPathPerf.rockRemainder";
const DETAIL_MAX = 200;
const FLUSH_REASONS = Object.freeze(["timer", "zero", "foreign", "dispose", "reset", "shutdown", "limit", "disable"]);

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfRock", { value: true });
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

function recordDrivesScene(ref) {
  const spawn = isObject(ref) && isObject(ref.spawnState) ? ref.spawnState : null;
  if (!spawn) return false;
  if (hasOwn(spawn, MISSION_KEY)) return true;
  if (spawn.retailResourceRevision === 1) return true;
  return isObject(spawn.populationHints) && spawn.populationHints.retailResourceRevision === 1;
}

function emptyWindow() {
  const flushes = {};
  for (const r of FLUSH_REASONS) flushes[r] = 0;
  return {
    intercepted: 0, buffered: 0, noop: 0, flushes, written: 0,
    droppedNotFound: 0, droppedShutdown: 0, writeErrors: 0, writeWarned: false,
    passAir: 0, passMission: 0, passNoDisposeHook: 0, passDurable: 0, flushMaxMs: 0, maxAgeMs: 0,
  };
}

function createRockRemainderCoalesce(options) {
  const config = options.config;
  const log = options.log;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || defaultSetTimer;
  const clearTimer = options.clearTimer || defaultClearTimer;
  const coalesceMs = Math.max(0, Number(config.rockRemainderCoalesceMs) || 0);
  const maxInstances = Math.max(0, Math.floor(Number(config.rockRemainderCoalesceMaxInstances) || 0));

  const priv = {
    dungeon: null, store: null, original: null, disabledReason: null,
    hooks: { dispose: false, reset: false },
    pending: new Map(),
    timer: null, flushing: false, hookRegistered: false,
    window: emptyWindow(),
  };

  function setDungeonDeps(m) {
    if (priv.dungeon) return true;
    if (!isObject(m) || typeof m.getInstanceRef !== "function") return false;
    priv.dungeon = { getInstanceRef: (id) => m.getInstanceRef(id) };
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

  function baseMapOf(ref) {
    const spawn = ref && isObject(ref.spawnState) ? ref.spawnState : null;
    return spawn && isObject(spawn[KEY]) ? spawn[KEY] : {};
  }

  function flushInstance(instanceID, reason) {
    const entry = priv.pending.get(instanceID);
    if (!entry) return { ok: false, reason: "NOT_PENDING" };
    if (!priv.original) {
      priv.pending.delete(instanceID);
      return { ok: false, reason: "ERROR" };
    }
    const w = priv.window;
    const started = now();
    priv.flushing = true;
    try {
      let ref;
      try {
        ref = priv.dungeon.getInstanceRef(instanceID);
      } catch (_error) {
        ref = { spawnState: { [KEY]: entry.lastBase } };
      }
      if (!ref) {
        w.droppedNotFound += 1;
        return { ok: false, reason: "NOT_FOUND" };
      }
      const map = { ...baseMapOf(ref) };
      for (const [k, v] of entry.rocks) map[k] = v;
      const age = started - entry.firstAtMs;
      if (age > w.maxAgeMs) w.maxAgeMs = age;
      try {
        priv.original(instanceID, { [KEY]: map }, entry.lastNowMs !== undefined ? { nowMs: entry.lastNowMs } : {});
      } catch (error) {
        if (error && error.dungeonError === NOT_FOUND) {
          w.droppedNotFound += 1;
          return { ok: false, reason: "NOT_FOUND" };
        }
        w.writeErrors += 1;
        if (!w.writeWarned) {
          w.writeWarned = true;
          log(`WARN rockRemainderCoalesce write failed (instance=${instanceID} reason=${reason}): ${fit(error && error.message || error)}`);
        }
        return { ok: false, reason: "WRITE_FAILED" };
      }
      if (hasOwn(w.flushes, reason)) w.flushes[reason] += 1;
      w.written += 1;
      return { ok: true, written: 1 };
    } catch (error) {
      w.writeErrors += 1;
      return { ok: false, reason: "ERROR" };
    } finally {
      priv.flushing = false;
      priv.pending.delete(instanceID);
      const ms = now() - started;
      if (ms > w.flushMaxMs) w.flushMaxMs = ms;
    }
  }

  function flushAll(reason) {
    stopTimer();
    if (priv.disabledReason) return { ok: false, reason: "DISABLED" };
    if (priv.pending.size === 0) return { ok: true, written: 0, dropped: 0 };
    if (!priv.original || !priv.dungeon) return { ok: false, reason: "NO_DEPS" };
    try {
      if (reason !== "shutdown" && priv.store && priv.store.isShutdownInProgress()) {
        const dropped = priv.pending.size;
        priv.window.droppedShutdown += dropped;
        priv.pending.clear();
        return { ok: true, written: 0, dropped };
      }
      let written = 0;
      let dropped = 0;
      for (const id of [...priv.pending.keys()]) {
        const r = flushInstance(id, reason);
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
    if (priv.pending.size > 0 && priv.original && priv.dungeon) {
      try { flushAll("disable"); } catch (_error) {}
    }
    stopTimer();
    priv.pending.clear();
    priv.disabledReason = reason;
    log(`WARN rockRemainderCoalesce disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function armTimer() {
    if (priv.timer !== null || coalesceMs <= 0) return;
    priv.timer = setTimer(() => {
      priv.timer = null;
      try {
        flushAll("timer");
      } catch (error) {
        log(`WARN rockRemainderCoalesce timer error: ${fit(error && error.message || error)}`);
      }
    }, coalesceMs);
  }

  function registerHook() {
    if (priv.hookRegistered || !priv.store) return;
    priv.hookRegistered = true;
    try {
      priv.store.registerShutdownHook(HOOK_NAME, () => { flushAll("shutdown"); });
    } catch (error) {
      log(`WARN rockRemainderCoalesce shutdown hook not registered: ${fit(error && error.message || error)}`);
    }
  }

  function isOwnShape(patch, opts) {
    if (isObject(opts) && (opts.durable === true || opts.force === true || opts.forceWrite === true)) return false;
    for (const k of Object.keys(patch)) if (k !== KEY) return false;
    return true;
  }

  function overlay(base, foreignMap, rocks) {
    const out = { ...foreignMap };
    for (const [k, v] of rocks) {
      if (hasOwn(foreignMap, k) && foreignMap[k] !== base[k]) {
        const theirs = Number(foreignMap[k]);
        out[k] = Number.isFinite(theirs) ? Math.min(theirs, v) : v;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function bufferOwn(instanceID, map, opts) {
    const ref = priv.dungeon.getInstanceRef(instanceID);
    if (!ref) return undefined;
    if (ref.templateID === AIR_TEMPLATE_ID) {
      priv.window.passAir += 1;
      return undefined;
    }
    if (recordDrivesScene(ref)) {
      priv.window.passMission += 1;
      return undefined;
    }
    const w = priv.window;
    w.intercepted += 1;
    const base = baseMapOf(ref);
    const id = Number(instanceID);
    let entry = priv.pending.get(id);
    let changed = false;
    let zero = false;
    for (const k of Object.keys(map)) {
      const v = map[k];
      if (v === base[k]) continue;
      if (entry && entry.rocks.get(k) === v) continue;
      if (!entry) {
        entry = { instanceID: id, rocks: new Map(), firstAtMs: now(), lastNowMs: undefined, lastBase: base };
        priv.pending.set(id, entry);
      }
      entry.rocks.set(k, v);
      changed = true;
      if (v === 0) zero = true;
    }
    if (!changed) {
      w.noop += 1;
      return null;
    }
    w.buffered += 1;
    entry.lastBase = base;
    if (isObject(opts) && opts.nowMs !== undefined) entry.lastNowMs = opts.nowMs;
    if (zero) flushInstance(id, "zero");
    if (priv.pending.size > maxInstances) {
      const oldest = priv.pending.keys().next().value;
      flushInstance(oldest, "limit");
    }
    if (priv.pending.size > 0) armTimer();
    registerHook();
    return null;
  }

  function wrapMerge(original) {
    priv.original = original;
    const wrapped = function mergeSpawnState(instanceID, patch, opts) {
      if (priv.disabledReason || priv.flushing || !priv.dungeon || !priv.store || coalesceMs === 0 ||
        !isObject(patch) || !(hasOwn(patch, KEY) || (hasOwn(patch, MISSION_KEY) && priv.pending.has(Number(instanceID))))) {
        return original.apply(this, arguments);
      }
      if (!priv.hooks.dispose) {
        priv.window.passNoDisposeHook += 1;
        return original.apply(this, arguments);
      }
      let foreignPatch = null;
      try {
        if (!isOwnShape(patch, opts)) {
          if (isObject(opts) && (opts.durable === true || opts.force === true || opts.forceWrite === true)) {
            priv.window.passDurable += 1;
          }
          const entry = priv.pending.get(Number(instanceID));
          if (!entry) return original.apply(this, arguments);
          const ref = priv.dungeon.getInstanceRef(instanceID);
          const base = ref ? baseMapOf(ref) : entry.lastBase;
          const theirs = hasOwn(patch, KEY) ? (isObject(patch[KEY]) ? patch[KEY] : {}) : base;
          foreignPatch = { ...patch, [KEY]: overlay(base, theirs, entry.rocks) };
          priv.pending.delete(Number(instanceID));
          priv.window.flushes.foreign += 1;
        } else {
          const map = isObject(patch[KEY]) ? patch[KEY] : null;
          if (map) {
            const r = bufferOwn(instanceID, map, opts);
            if (r === null) return null;
          }
        }
      } catch (error) {
        disable("error", String(error && error.message || error));
        return original.apply(this, arguments);
      }
      if (foreignPatch) return original.call(this, instanceID, foreignPatch, opts);
      return original.apply(this, arguments);
    };
    return markWrapped(wrapped, original);
  }

  function wrapFlushPoint(original, reason) {
    priv.hooks[reason] = true;
    const wrapped = function hotPathPerfRockFlush() {
      if (priv.pending.size > 0) {
        try {
          flushAll(reason);
        } catch (error) {
          log(`WARN rockRemainderCoalesce flush error (${reason}): ${fit(error && error.message || error)}`);
        }
      }
      return original.apply(this, arguments);
    };
    return markWrapped(wrapped, original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return priv.dungeon && priv.store ? "ready" : "waiting";
  }

  function rockCount() {
    let n = 0;
    for (const e of priv.pending.values()) n += e.rocks.size;
    return n;
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      disabledReason: priv.disabledReason,
      state: stateText(),
      hooks: { ...priv.hooks },
      pendingInstances: priv.pending.size,
      pendingRocks: rockCount(),
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
    const line = `stats rockRemainderCoalesce state=${stateText()} pending=${priv.pending.size}/${rockCount()} ` +
      `intercepted=${w.intercepted} buffered=${w.buffered} noop=${w.noop} ` +
      `flushes=${FLUSH_REASONS.filter((r) => r !== "disable").map((r) => `${r}:${w.flushes[r]}`).join(",")} ` +
      `written=${w.written} dropped=notFound:${w.droppedNotFound},shutdown:${w.droppedShutdown} writeErrors=${w.writeErrors} ` +
      `passthrough=air:${w.passAir},mission:${w.passMission},noDisposeHook:${w.passNoDisposeHook},durable:${w.passDurable} ` +
      `flushMaxMs=${w.flushMaxMs} maxAgeMs=${w.maxAgeMs}`;
    priv.window = emptyWindow();
    return [line];
  }

  return {
    setDungeonDeps, setStoreDeps, wrapMerge, wrapFlushPoint, flushAll, flushInstance,
    disable, status, statsSnapshot, drainStatsLines,
  };
}

module.exports = { createRockRemainderCoalesce, AIR_TEMPLATE_ID, MISSION_KEY, KEY, HOOK_NAME, FLUSH_REASONS };
