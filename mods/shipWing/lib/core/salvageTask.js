"use strict";

const SALVAGE_SUB = Object.freeze(["SEEK", "APPROACH", "LOCK", "SALVAGING", "FULL"]);
const ENGINE_ACTIVATE_REFUSAL = Object.freeze([
  "MODULE_NOT_ONLINE", "MODULE_ALREADY_ACTIVE", "MODULE_NOT_FOUND", "SHIP_NOT_FOUND", "TARGET_NOT_LOCKED",
  "TARGET_OUT_OF_RANGE", "TARGET_NOT_FOUND", "TARGET_REQUIRED", "UNSUPPORTED_MODULE", "SALVAGE_CHANCE_TOO_LOW",
  "OTHER",
]);
const ENGINE_COUNTER_NAMES = Object.freeze([
  "salvage.seek", "salvage.seek.none", "salvage.hostLeft", "salvage.full", "salvage.lock.refused",
  "salvage.drones.stalled",
  "salvage.engine.activated",
  "salvage.engine.effectLost",
  ...ENGINE_ACTIVATE_REFUSAL.map((code) => `salvage.engine.activateRefused.${code}`),
]);
const REFUSED_ROUNDS_TO_SEEK = 2;
const MOVES = Object.freeze({ controlsMovement: true });
const FREE = Object.freeze({ controlsMovement: false });
const AT_WRECK = Object.freeze(["APPROACH", "LOCK", "SALVAGING"]);

function createSalvageEngine(deps) {
  const access = deps.access;
  const ts = deps.scene;
  const config = deps.config || {};
  const hookReady = typeof deps.hookReady === "function" ? deps.hookReady : () => false;
  const isBlocked = typeof deps.isBlocked === "function" ? deps.isBlocked : () => false;
  const droneSalvage = typeof deps.droneSalvage === "function" ? deps.droneSalvage : () => false;
  const droneProgress = typeof deps.droneSalvageProgress === "function" ? deps.droneSalvageProgress : () => null;
  function dronesOnly(twin, ctx, modules) {
    if (modules.length > 0) return false;
    try {
      return droneSalvage(twin, ctx) === true;
    } catch (_err) {
      return false;
    }
  }
  function progressOf(rt, wreckId) {
    try {
      const p = droneProgress(rt, wreckId);
      return p && typeof p === "object" ? p : null;
    } catch (_err) {
      return null;
    }
  }
  const counters = Object.fromEntries(ENGINE_COUNTER_NAMES.map((name) => [name, 0]));
  const claims = new Map();
  let budgetNowMs = null;
  let seeksLeft = 0;

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function claim(s, wreckId) {
    s.wreckId = wreckId;
    s.claimed = true;
    claims.set(wreckId, (claims.get(wreckId) || 0) + 1);
  }

  function release(s) {
    if (!s || s.claimed !== true) return;
    const left = (claims.get(s.wreckId) || 0) - 1;
    if (left > 0) claims.set(s.wreckId, left);
    else claims.delete(s.wreckId);
    s.claimed = false;
  }

  function initSalvage(rt, record) {
    const r = record || {};
    rt.salvage = {
      ownerCharacterId: Number(r.ownerCharacterId) || 0, hostShipId: Number(r.hostShipId) || 0,
      twinEntityId: Number(r.twinEntityId) || 0, wreckId: null, claimed: false, ordered: false, modules: [],
      workRangeM: 0, approachIssued: false, orbitIssued: false, orbitCheckAtMs: 0, refusedRounds: 0,
      retryAtByModule: new Map(),
      liveIds: new Set(),
      dronesIdleSinceMs: null, skipWreckId: null, skipUntilMs: 0,
    };
    return rt.salvage;
  }

  function deactivateAll(scene, twin, s) {
    if (!scene || !twin || !s) return;
    for (const mod of s.modules) {
      if (ts.activeEffect(twin, mod.moduleId)) ts.deactivate(scene, twin, mod.moduleId, "manual");
    }
    liveOf(s).clear();
  }

  function liveOf(s) {
    if (!(s.liveIds instanceof Set)) s.liveIds = new Set();
    return s.liveIds;
  }

  function clearWreck(s) {
    release(s);
    s.wreckId = null;
    s.ordered = false;
    s.approachIssued = false;
    s.orbitIssued = false;
    s.orbitCheckAtMs = 0;
    s.refusedRounds = 0;
    s.dronesIdleSinceMs = null;
    liveOf(s).clear();
  }

  function toSeek(rt, s, scene, twin, retryAtMs) {
    deactivateAll(scene, twin, s);
    clearWreck(s);
    rt.sub = "SEEK";
    rt.nextActionAtMs = retryAtMs;
  }

  function follow(ctx) {
    if (ctx.host && ctx.formation !== true) ts.followHost(ctx.scene, ctx.twin, ctx.host.itemID, config.followRangeMeters);
  }

  function leashM() {
    return config.salvageSearchRangeMeters + config.salvageLeashMarginMeters;
  }

  function hostNear(scene, host, wreckId) {
    const d = access.wreckDistanceM(scene, host, wreckId);
    if (d && d.ok === true) return d.distanceM <= leashM();
    return !(d && d.reason === "NO_WRECK");
  }

  function pickWreck(rt, ctx, skipId) {
    const { scene, host } = ctx;
    if (rt.targetId && !(access.isSalvageable(scene, rt.targetId) && hostNear(scene, host, rt.targetId))) {
      rt.targetId = null;
    }
    const ids = rt.targetId ? [rt.targetId] : [];
    for (const id of ts.targetsOf(scene, host)) if (!ids.includes(id)) ids.push(id);
    for (const id of ids) {
      if (id === skipId) continue;
      if (access.isSalvageable(scene, id) && hostNear(scene, host, id)) return { wreckId: id, ordered: true };
    }
    let best = null;
    for (const c of access.candidates(scene, host, config.salvageSearchRangeMeters)) {
      if (c.wreckId === skipId) continue;
      const n = claims.get(c.wreckId) || 0;
      if (n === 0) return { wreckId: c.wreckId, ordered: false };
      if (!best || n < best.n) best = { wreckId: c.wreckId, n };
    }
    return best ? { wreckId: best.wreckId, ordered: false } : null;
  }

  function seek(rt, s, ctx, nowMs) {
    const { scene, twin } = ctx;
    if (nowMs < rt.nextActionAtMs || seeksLeft <= 0) return;
    seeksLeft -= 1;
    bump("salvage.seek");
    s.modules = access.salvagerModules(twin).map((m) => ({ moduleId: m.moduleId, effectName: m.effectName }));
    const drones = dronesOnly(twin, { ...ctx, rt }, s.modules);
    const able = s.modules.length > 0 || drones;
    const picked = able ? pickWreck(rt, ctx, nowMs < s.skipUntilMs ? s.skipWreckId : null) : null;
    let workRangeM = 0;
    if (picked) workRangeM = drones ? config.salvageDroneWorkRangeMeters : access.workRangeM(scene, twin);
    if (!picked || !(workRangeM > 0)) {
      bump("salvage.seek.none");
      rt.lastRefusal = able ? "NO_WRECK" : "NO_SALVAGER";
      rt.nextActionAtMs = nowMs + config.salvageSeekRetryMs;
      follow(ctx);
      return;
    }
    claim(s, picked.wreckId);
    s.ordered = picked.ordered;
    s.workRangeM = workRangeM;
    s.approachIssued = false;
    s.orbitIssued = false;
    s.orbitCheckAtMs = 0;
    s.refusedRounds = 0;
    s.retryAtByModule = new Map();
    rt.lastRefusal = null;
    rt.sub = "APPROACH";
  }

  function wreckLost(rt, s, ctx, nowMs) {
    const { scene, twin, host } = ctx;
    if (!s.wreckId || !access.isSalvageable(scene, s.wreckId)) {
      toSeek(rt, s, scene, twin, nowMs);
      return true;
    }
    if (!hostNear(scene, host, s.wreckId)) {
      bump("salvage.hostLeft");
      toSeek(rt, s, scene, twin, nowMs);
      return true;
    }
    return false;
  }

  function approachStep(rt, s, ctx) {
    const { scene, twin } = ctx;
    const wreck = ts.entity(scene, s.wreckId);
    if (wreck && ts.surfaceDistance(scene, twin, wreck) <= s.workRangeM) {
      rt.sub = "LOCK";
      return;
    }
    if (!s.approachIssued) {
      ts.approach(scene, twin, s.wreckId, Math.max(0, s.workRangeM - config.miningRangeBufferMeters));
      s.approachIssued = true;
    }
  }

  function activateAll(rt, s, scene, twin, nowMs) {
    const out = { tried: 0, ok: 0 };
    const live = liveOf(s);
    for (const mod of access.salvagerModules(twin)) {
      const id = mod.moduleId;
      const effect = ts.activeEffect(twin, id);
      if (effect && effect.targetID === s.wreckId) {
        out.ok += 1;
        continue;
      }
      if (!effect && live.has(id)) {
        live.delete(id);
        bump("salvage.engine.effectLost");
      }
      if ((s.retryAtByModule.get(id) || 0) > nowMs) continue;
      if (effect) {
        ts.deactivate(scene, twin, id, "manual");
        live.delete(id);
      }
      s.retryAtByModule.set(id, nowMs + config.salvageSeekRetryMs);
      out.tried += 1;
      const done = ts.activate(scene, twin, mod.module, mod.effectName, s.wreckId);
      if (done && done.ok === true) {
        bump("salvage.engine.activated");
        live.add(id);
        out.ok += 1;
        continue;
      }
      const code = ENGINE_ACTIVATE_REFUSAL.includes(done && done.reason) ? done.reason : "OTHER";
      bump(`salvage.engine.activateRefused.${code}`);
      rt.lastRefusal = code;
    }
    return out;
  }

  function orbitWreck(s, scene, twin, nowMs) {
    if (!s.wreckId || nowMs < s.orbitCheckAtMs) return;
    const steady = s.orbitIssued && twin.mode === "ORBIT" && Math.trunc(Number(twin.targetEntityID)) === s.wreckId;
    if (steady) return;
    s.orbitIssued = ts.orbit(scene, twin, s.wreckId, Math.max(0, s.workRangeM - config.miningRangeBufferMeters))
      === true;
    s.orbitCheckAtMs = nowMs + (s.orbitIssued ? config.followRetuneMs : config.salvageSeekRetryMs);
  }

  function cargoFull(rt, s, ctx, nowMs) {
    const room = access.hostCargoFreeM3(s.ownerCharacterId, s.hostShipId);
    const free = room && room.ok === true ? room.freeM3 : 0;
    if (free >= config.salvageMinFreeCargoM3 && !isBlocked(s.hostShipId)) return false;
    toFull(rt, s, ctx, nowMs);
    return true;
  }

  function toFull(rt, s, ctx, nowMs) {
    bump("salvage.full");
    deactivateAll(ctx.scene, ctx.twin, s);
    clearWreck(s);
    rt.sub = "FULL";
    rt.nextActionAtMs = nowMs + config.salvageFullRetryMs;
    follow(ctx);
  }

  function dronesStalled(rt, s, ctx, nowMs) {
    const p = progressOf(rt, s.wreckId);
    if (!p) return false;
    const { scene, twin } = ctx;
    if (p.able !== true) {
      bump("salvage.drones.stalled");
      toSeek(rt, s, scene, twin, nowMs);
      return true;
    }
    if (p.done === "CARGO") {
      toFull(rt, s, ctx, nowMs);
      return true;
    }
    if (!p.done && Number(p.out) > 0) {
      s.dronesIdleSinceMs = null;
      return false;
    }
    if (!p.done) {
      if (s.dronesIdleSinceMs === null) s.dronesIdleSinceMs = nowMs;
      if (nowMs - s.dronesIdleSinceMs < config.salvageSeekRetryMs) return false;
    }
    bump("salvage.drones.stalled");
    s.skipWreckId = s.wreckId;
    s.skipUntilMs = nowMs + config.salvageFullRetryMs;
    toSeek(rt, s, scene, twin, nowMs + config.salvageSeekRetryMs);
    return true;
  }

  function lockStep(rt, s, ctx, nowMs) {
    const { scene, twin } = ctx;
    if (s.modules.length === 0) {
      if (cargoFull(rt, s, ctx, nowMs)) return;
      rt.sub = "SALVAGING";
      orbitWreck(s, scene, twin, nowMs);
      return;
    }
    const wreck = ts.entity(scene, s.wreckId);
    const locked = wreck ? ts.lock(scene, twin, wreck, { keepIds: [s.wreckId] })
      : { ok: false, reason: "TARGET_NOT_FOUND" };
    if (!locked || locked.ok !== true) {
      bump("salvage.lock.refused");
      rt.lastRefusal = "NO_WRECK";
      toSeek(rt, s, scene, twin, nowMs + config.salvageSeekRetryMs);
      return;
    }
    if (cargoFull(rt, s, ctx, nowMs)) return;
    rt.sub = "SALVAGING";
    orbitWreck(s, scene, twin, nowMs);
    const round = activateAll(rt, s, scene, twin, nowMs);
    s.refusedRounds = round.tried > 0 && round.ok === 0 ? 1 : 0;
  }

  function salvagingStep(rt, s, ctx, nowMs) {
    const { scene, twin } = ctx;
    if (cargoFull(rt, s, ctx, nowMs)) return;
    if (s.modules.length === 0 && dronesStalled(rt, s, ctx, nowMs)) return;
    orbitWreck(s, scene, twin, nowMs);
    const round = activateAll(rt, s, scene, twin, nowMs);
    if (round.ok > 0) s.refusedRounds = 0;
    else if (round.tried > 0) s.refusedRounds += 1;
    if (s.refusedRounds >= REFUSED_ROUNDS_TO_SEEK) toSeek(rt, s, scene, twin, nowMs + config.salvageSeekRetryMs);
  }

  function fullStep(rt, s, ctx, nowMs) {
    if (nowMs < rt.nextActionAtMs) return;
    const room = access.hostCargoFreeM3(s.ownerCharacterId, s.hostShipId);
    if (room && room.ok === true && room.freeM3 >= config.salvageMinFreeCargoM3 && !isBlocked(s.hostShipId)) {
      rt.sub = "SEEK";
      rt.nextActionAtMs = nowMs;
      return;
    }
    rt.nextActionAtMs = nowMs + config.salvageFullRetryMs;
    follow(ctx);
  }

  return {
    name: "salvage",

    canRun(twin, _adapter, ctx = {}) {
      if (hookReady() !== true || !twin) return { ok: false, reason: "TASK_UNAVAILABLE" };
      const modules = access.salvagerModules(twin);
      if (modules.length === 0 && !dronesOnly(twin, ctx, modules)) return { ok: false, reason: "NO_SALVAGER" };
      return { ok: true };
    },

    start(rt, opts = {}) {
      const old = rt.salvage;
      if (old) {
        deactivateAll(opts.scene, opts.twin, old);
        release(old);
      }
      initSalvage(rt, opts.record);
      if (rt.targetId && opts.scene && !access.isSalvageable(opts.scene, rt.targetId)) rt.targetId = null;
      rt.sub = "SEEK";
      rt.nextActionAtMs = 0;
    },

    step(rt, ctx = {}) {
      if (ctx.nowMs !== budgetNowMs) {
        budgetNowMs = ctx.nowMs;
        seeksLeft = config.salvageMaxSeeksPerTick;
      }
      if (!ctx.scene || !ctx.twin) return MOVES;
      const s = rt.salvage || initSalvage(rt, ctx.record);
      const nowMs = Number(ctx.nowMs) || 0;
      if (!SALVAGE_SUB.includes(rt.sub)) rt.sub = "SEEK";
      if (AT_WRECK.includes(rt.sub)) wreckLost(rt, s, ctx, nowMs);
      switch (rt.sub) {
        case "SEEK": seek(rt, s, ctx, nowMs); break;
        case "APPROACH": approachStep(rt, s, ctx); break;
        case "LOCK": lockStep(rt, s, ctx, nowMs); break;
        case "SALVAGING": salvagingStep(rt, s, ctx, nowMs); break;
        case "FULL": fullStep(rt, s, ctx, nowMs); break;
        default: break;
      }
      if (AT_WRECK.includes(rt.sub) && s.wreckId) return { controlsMovement: true, leashAnchorId: s.wreckId };
      return ctx.formation === true ? FREE : MOVES;
    },

    stop(rt, _reason, ctx = {}) {
      const s = rt.salvage;
      if (!s) return;
      const scene = ctx && ctx.scene ? ctx.scene : null;
      const twin = scene ? ts.entity(scene, s.twinEntityId) : null;
      deactivateAll(scene, twin, s);
      clearWreck(s);
    },

    beforeEnd(rt) {
      if (rt.salvage) clearWreck(rt.salvage);
    },

    dispose(rt) {
      if (rt.salvage) clearWreck(rt.salvage);
    },

    stats() {
      const extra = access && typeof access.stats === "function" ? access.stats() : null;
      return { counters: { ...counters, ...(extra && extra.counters ? extra.counters : {}) }, claims: claims.size };
    },
  };
}

module.exports = { SALVAGE_SUB, ENGINE_ACTIVATE_REFUSAL, ENGINE_COUNTER_NAMES, createSalvageEngine };
