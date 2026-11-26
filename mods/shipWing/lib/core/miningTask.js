"use strict";

const { surfaceDistance: vecSurfaceDistance } = require("../util/vec");

function round6(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function posInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSized(hold) {
  return Boolean(hold && hold.sized === true);
}

function sizeHold(hold, resourceState) {
  if (!hold || typeof hold !== "object" || hold.sized === true) return hold;
  if (!(hold.capacityByFlag instanceof Map)) hold.capacityByFlag = new Map();
  if (!(hold.items instanceof Map)) hold.items = new Map();
  if (!Number.isFinite(hold.usedM3)) hold.usedM3 = 0;
  hold.resourceState = resourceState || null;
  hold.flagByType = new Map();
  hold.usedByFlag = new Map();
  hold.unitM3ByType = new Map();
  hold.sized = true;
  return hold;
}

function holdSpace(hold, typeID, resolve) {
  if (!isSized(hold) || !posInt(typeID)) return { flag: 0, freeM3: 0 };
  let flag = hold.flagByType.get(typeID);
  if (flag === undefined) {
    flag = Number(resolve.flagOf(hold.resourceState, typeID)) || 0;
    hold.flagByType.set(typeID, flag);
  }
  if (!posInt(flag)) return { flag: 0, freeM3: 0 };
  let capacity = hold.capacityByFlag.get(flag);
  if (capacity === undefined) {
    capacity = Math.max(0, Number(resolve.capacityOf(hold.resourceState, flag)) || 0);
    hold.capacityByFlag.set(flag, capacity);
  }
  return { flag, freeM3: Math.max(0, round6(capacity - (hold.usedByFlag.get(flag) || 0))) };
}

function holdAdd(hold, flag, typeID, quantity, unitM3) {
  if (!isSized(hold) || !posInt(flag) || !posInt(typeID) || !posInt(quantity) || !(Number(unitM3) > 0)) {
    return { ok: false, reason: "BAD_INPUT" };
  }
  const m3 = round6(quantity * unitM3);
  const capacity = hold.capacityByFlag.get(flag) || 0;
  const used = hold.usedByFlag.get(flag) || 0;
  if (round6(used + m3) > capacity) return { ok: false, reason: "NO_SPACE" };
  hold.items.set(typeID, (hold.items.get(typeID) || 0) + quantity);
  hold.usedByFlag.set(flag, round6(used + m3));
  hold.usedM3 = round6(hold.usedM3 + m3);
  hold.unitM3ByType.set(typeID, Number(unitM3));
  return { ok: true, m3 };
}

function holdTake(hold, flag, typeID, quantity, unitM3) {
  if (!isSized(hold) || !posInt(flag) || !posInt(typeID) || !posInt(quantity) || !(Number(unitM3) > 0)) {
    return { ok: false, reason: "BAD_INPUT" };
  }
  const have = hold.items.get(typeID) || 0;
  const taken = Math.min(have, quantity);
  const m3 = round6(taken * unitM3);
  if (have - taken > 0) hold.items.set(typeID, have - taken);
  else hold.items.delete(typeID);
  hold.usedByFlag.set(flag, Math.max(0, round6((hold.usedByFlag.get(flag) || 0) - m3)));
  hold.usedM3 = Math.max(0, round6(hold.usedM3 - m3));
  return { ok: true, quantity: taken, m3 };
}

const MINE_SUB = Object.freeze(["SEEK", "APPROACH", "LOCK", "MINING", "UNLOAD_TRAVEL", "UNLOAD", "FULL"]);
const ENGINE_ACTIVATE_REFUSAL = Object.freeze([
  "MODULE_NOT_ONLINE", "MODULE_ALREADY_ACTIVE", "MODULE_NOT_FOUND", "SHIP_NOT_FOUND", "TARGET_NOT_LOCKED",
  "TARGET_OUT_OF_RANGE", "TARGET_NOT_FOUND", "OTHER",
]);
const ENGINE_COUNTER_NAMES = Object.freeze([
  "mining.seek", "mining.seek.none", "mining.seek.ownerTargetOutOfRange", "mining.approach.hostLeft",
  "mining.mine.hostLeft", "mining.lock.refused",
  ...ENGINE_ACTIVATE_REFUSAL.map((code) => `mining.engine.activateRefused.${code}`),
  "mining.unload.ok", "mining.unload.partial", "mining.unload.grantFailed", "mining.unload.hostInvalid",
  "mining.full", "mining.oreLostM3",
  "mining.formation.fromSlot", "mining.formation.toRock",
  "mining.overflow.ok", "mining.overflow.partial", "mining.overflow.canNew", "mining.overflow.m3",
  "mining.overflow.onEnd",
  ...["CAN_LIMIT", "CAN_TYPE", "CREATE_FAILED", "SPAWN_FAILED", "GRANT_FAILED", "CAN_FULL", "NO_SCENE"]
    .map((code) => `mining.overflow.refused.${code}`),
  "mining.real.deposit", "mining.real.m3", "mining.real.own", "mining.real.store", "mining.real.partial",
  "mining.real.targetInvalid", "mining.real.storeInvalid", "mining.real.grantFailed", "mining.real.grantThrew",
  "mining.real.onEnd",
]);
const OVERFLOW_END_REASONS = Object.freeze([
  "WARP", "JUMPED", "LOGOFF", "DOCKED", "HOST_CHANGED", "HOST_GONE", "OUT_OF_RANGE", "RECALL_TIMEOUT",
]);
const REFUSED_ROUNDS_TO_SEEK = 2;
const MOVES = Object.freeze({ controlsMovement: true });
const FREE = Object.freeze({ controlsMovement: false });
const LEASH_SUB = Object.freeze(["APPROACH", "LOCK", "MINING"]);

function posNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function createMineEngine(deps) {
  const access = deps.access;
  const ts = deps.scene;
  const config = deps.config || {};
  const hookReady = typeof deps.hookReady === "function" ? deps.hookReady : () => false;
  const isBlocked = typeof deps.isBlocked === "function" ? deps.isBlocked : () => false;
  const cargoStoreOf = typeof deps.cargoStoreOf === "function" ? deps.cargoStoreOf : () => 0;
  const realOn = config.miningRealCargoEnabled === true && typeof access.deposit === "function";
  const counters = Object.fromEntries(ENGINE_COUNTER_NAMES.map((name) => [name, 0]));
  const claims = new Map();
  let budgetNowMs = null;
  let seeksLeft = 0;
  let depositsLeft = 0;

  function bump(name, by = 1) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] = round6(counters[name] + by);
  }

  function claim(m, rockId) {
    m.rockId = rockId;
    m.claimed = true;
    m.orbitRockId = null;
    m.orbitCheckAtMs = 0;
    m.fromSlot = null;
    claims.set(rockId, (claims.get(rockId) || 0) + 1);
  }

  function release(m) {
    if (!m || m.claimed !== true) return;
    const left = (claims.get(m.rockId) || 0) - 1;
    if (left > 0) claims.set(m.rockId, left);
    else claims.delete(m.rockId);
    m.claimed = false;
  }

  function initMine(rt, record) {
    const r = record || {};
    rt.mine = {
      ownerCharacterId: Number(r.ownerCharacterId) || 0, hostShipId: Number(r.hostShipId) || 0,
      twinEntityId: Number(r.twinEntityId) || 0, rockId: null, claimed: false, modules: [], workRangeM: 0,
      approachIssued: false, refusedRounds: 0, retryAtByModule: new Map(), oreLostCounted: false,
      orbitRockId: null, orbitCheckAtMs: 0,
      ordered: false,
      fromSlot: null,
      shipItemId: Number(r.shipItemId) || 0, nextDepositAtMs: 0,
    };
    return rt.mine;
  }

  function familiesOf(mods) {
    return new Set(mods.map((m) => m.family));
  }

  function deactivateAll(scene, twin, m) {
    if (!scene || !twin || !m) return;
    for (const mod of m.modules) {
      if (ts.activeEffect(twin, mod.moduleId)) ts.deactivate(scene, twin, mod.moduleId, "manual");
    }
  }

  function toSeek(rt, m, scene, twin, retryAtMs) {
    deactivateAll(scene, twin, m);
    release(m);
    m.rockId = null;
    m.ordered = false;
    m.approachIssued = false;
    m.refusedRounds = 0;
    m.fromSlot = null;
    rt.sub = "SEEK";
    rt.nextActionAtMs = retryAtMs;
  }

  function minesFromSlot(m, ctx) {
    const was = m.fromSlot;
    let now = false;
    if (ctx.formation === true && typeof ctx.formationSlot === "function" && m.rockId && m.workRangeM > 0) {
      const point = ctx.formationSlot();
      const rock = point ? ts.entity(ctx.scene, m.rockId) : null;
      if (rock && rock.position) {
        const d = vecSurfaceDistance(point, ctx.twin.radius, rock.position, rock.radius);
        const reach = m.workRangeM - config.formationMineMarginMeters;
        const hyst = Math.min(config.formationMineHysteresisMeters, Math.max(0, reach) / 2);
        now = was === false ? d <= reach - hyst : d <= reach;
      }
    }
    if (ctx.formation !== true) {
      if (was === true) leaveSlot(m);
      m.fromSlot = null;
      return false;
    }
    if (now === was) return now;
    m.fromSlot = now;
    if (now) {
      bump("mining.formation.fromSlot");
    } else {
      bump("mining.formation.toRock");
      leaveSlot(m);
    }
    return now;
  }

  function leaveSlot(m) {
    m.approachIssued = false;
    m.orbitRockId = null;
    m.orbitCheckAtMs = 0;
  }

  function hostNear(scene, host, rockId, limitM) {
    const d = access.rockDistanceM(scene, host, rockId);
    if (d && d.ok === true) return d.distanceM <= limitM;
    return !(d && d.reason === "NO_ROCK");
  }

  function orderRangeM() {
    const order = Number(config.miningOrderRangeMeters);
    return Number.isFinite(order) && order > 0 ? order : config.miningSearchRangeMeters;
  }

  function hostLeftLimitM(m) {
    const base = m.ordered === true ? Math.max(config.miningSearchRangeMeters, orderRangeM())
      : config.miningSearchRangeMeters;
    return base + config.miningTransferRangeMeters;
  }

  function systemOf(scene) {
    return scene ? Number(scene.systemID || scene.solarSystemID) || 0 : 0;
  }

  function unload(rt, m, scene) {
    if (isBlocked(m.hostShipId)) {
      bump("mining.unload.hostInvalid");
      return { ok: false, reason: "HOST_INVALID", movedM3: 0, leftM3: rt.hold.usedM3 };
    }
    const out = access.unload(rt.hold, { ownerCharacterId: m.ownerCharacterId, hostShipId: m.hostShipId,
      systemId: systemOf(scene) }) || { ok: false, reason: "GRANT_FAILED", movedM3: 0, leftM3: rt.hold.usedM3 };
    if (out.reason === "HOST_INVALID") bump("mining.unload.hostInvalid");
    if (posNum(out.grantFailed) > 0) bump("mining.unload.grantFailed", out.grantFailed);
    const left = posNum(out.leftM3);
    if (out.ok === true && left === 0) bump("mining.unload.ok");
    else if (posNum(out.movedM3) > 0) bump("mining.unload.partial");
    return out;
  }

  function jettison(rt, m, scene, twin, onEnd) {
    if (typeof access.jettison !== "function" || !scene || !twin) return false;
    const out = access.jettison(rt.hold, { ownerCharacterId: m.ownerCharacterId, scene, twin,
      nowMs: ts.simNow(scene) });
    if (!out) return false;
    const moved = posNum(out.movedM3);
    if (moved > 0) bump("mining.overflow.m3", moved);
    if (out.created === true) bump("mining.overflow.canNew");
    if (onEnd && moved > 0) bump("mining.overflow.onEnd");
    const empty = out.ok === true && !(posNum(out.leftM3) > 0);
    if (empty) {
      if (!onEnd) bump("mining.overflow.ok");
      return true;
    }
    if (moved > 0) bump("mining.overflow.partial");
    if (out.ok !== true) bump(`mining.overflow.refused.${out.reason}`);
    return false;
  }

  function depositStep(rt, m, onEnd) {
    let storeId = 0;
    try {
      storeId = Number(cargoStoreOf(m.hostShipId)) || 0;
    } catch (_err) {
      storeId = 0;
    }
    let out = null;
    try {
      out = access.deposit(rt.hold, { ownerCharacterId: m.ownerCharacterId, hostShipId: m.hostShipId,
        shipItemId: m.shipItemId, storeShipItemId: storeId });
    } catch (_err) {
      out = null;
    }
    if (!out) return false;
    if (out.storeInvalid === true) bump("mining.real.storeInvalid");
    if (out.ok !== true) {
      if (out.reason === "TARGET_INVALID") bump("mining.real.targetInvalid");
      return false;
    }
    const moved = posNum(out.movedM3);
    if (moved > 0) bump("mining.real.deposit");
    if (moved > 0) bump("mining.real.m3", moved);
    if (posNum(out.ownM3) > 0) bump("mining.real.own", out.ownM3);
    if (posNum(out.storeM3) > 0) bump("mining.real.store", out.storeM3);
    if (posNum(out.grantFailed) > 0) bump("mining.real.grantFailed", out.grantFailed);
    if (posNum(out.grantThrew) > 0) bump("mining.real.grantThrew", out.grantThrew);
    if (onEnd && moved > 0) bump("mining.real.onEnd");
    const empty = !(posNum(out.leftM3) > 0);
    if (!empty && moved > 0) bump("mining.real.partial");
    return empty;
  }

  function unloadStep(rt, m, scene, twin, host, nowMs) {
    const out = unload(rt, m, scene);
    if (out.ok === true && !(posNum(out.leftM3) > 0)) {
      rt.sub = "SEEK";
      rt.nextActionAtMs = nowMs;
      return;
    }
    if (out.reason !== "HOST_INVALID" && jettison(rt, m, scene, twin, false)) {
      rt.sub = "SEEK";
      rt.nextActionAtMs = nowMs;
      return;
    }
    bump("mining.full");
    rt.sub = "FULL";
    rt.nextActionAtMs = nowMs + config.miningFullRetryMs;
    if (host) ts.followHost(scene, twin, host.itemID, Math.floor(config.miningTransferRangeMeters / 2));
  }

  function activateAll(rt, m, scene, twin, nowMs) {
    const out = { tried: 0, ok: 0, refused: 0 };
    for (const mod of access.miningModules(twin)) {
      const id = Number(mod.module.itemID);
      const effect = ts.activeEffect(twin, id);
      if (effect && effect.targetID === m.rockId) {
        out.ok += 1;
        continue;
      }
      if ((m.retryAtByModule.get(id) || 0) > nowMs) continue;
      if (effect) ts.deactivate(scene, twin, id, "manual");
      m.retryAtByModule.set(id, nowMs + config.miningSeekRetryMs);
      out.tried += 1;
      const done = ts.activate(scene, twin, mod.module, mod.effectName, m.rockId);
      if (done && done.ok === true) {
        out.ok += 1;
        continue;
      }
      out.refused += 1;
      const code = ENGINE_ACTIVATE_REFUSAL.includes(done && done.reason) ? done.reason : "OTHER";
      bump(`mining.engine.activateRefused.${code}`);
      rt.lastRefusal = code;
    }
    return out;
  }

  function seek(rt, m, ctx, nowMs) {
    const { scene, twin, host } = ctx;
    if (nowMs < rt.nextActionAtMs || seeksLeft <= 0) return;
    seeksLeft -= 1;
    const mods = access.miningModules(twin);
    m.modules = mods.map((mod) => ({ moduleId: Number(mod.module.itemID), effectName: mod.effectName }));
    if (rt.targetId && !hostNear(scene, host, rt.targetId, orderRangeM())) {
      rt.targetId = null;
      bump("mining.seek.ownerTargetOutOfRange");
    }
    const ownerTargets = rt.targetId ? [rt.targetId] : [];
    for (const id of ts.targetsOf(scene, host)) if (!ownerTargets.includes(id)) ownerTargets.push(id);
    bump("mining.seek");
    const picked = mods.length === 0 ? null : access.pickRock(scene, { twin, host, ownerTargets, claims,
      rangeM: config.miningSearchRangeMeters, ownerRangeM: orderRangeM(), penaltyM: config.miningClaimPenaltyMeters,
      families: familiesOf(mods) });
    const workRangeM = picked ? access.workRangeM(scene, twin, m.ownerCharacterId, mods) : 0;
    if (!picked || !(workRangeM > 0)) {
      bump("mining.seek.none");
      rt.lastRefusal = mods.length === 0 ? "NO_MINING_MODULE" : "NO_MINEABLE";
      rt.nextActionAtMs = nowMs + config.miningSeekRetryMs;
      if (host && ctx.formation !== true) ts.followHost(scene, twin, host.itemID, config.followRangeMeters);
      return;
    }
    claim(m, picked.rockId);
    m.ordered = picked.ordered === true;
    m.workRangeM = workRangeM;
    m.approachIssued = false;
    m.refusedRounds = 0;
    m.retryAtByModule = new Map();
    rt.lastRefusal = null;
    rt.sub = "APPROACH";
  }

  function approachStep(rt, m, ctx, nowMs, fromSlot) {
    const { scene, twin, host } = ctx;
    const state = access.rockState(scene, m.rockId);
    if (!state || !(state.remaining > 0)) {
      toSeek(rt, m, scene, twin, nowMs);
      return;
    }
    if (!hostNear(scene, host, m.rockId, hostLeftLimitM(m))) {
      bump("mining.approach.hostLeft");
      toSeek(rt, m, scene, twin, nowMs);
      return;
    }
    const rock = ts.entity(scene, m.rockId);
    if (rock && ts.surfaceDistance(scene, twin, rock) <= m.workRangeM) {
      rt.sub = "LOCK";
      return;
    }
    if (fromSlot) return;
    if (!m.approachIssued) {
      ts.approach(scene, twin, m.rockId, Math.max(0, m.workRangeM - config.miningRangeBufferMeters));
      m.approachIssued = true;
    }
  }

  function orbitRock(m, scene, twin, nowMs) {
    if (!m.rockId || nowMs < m.orbitCheckAtMs) return;
    const steady = m.orbitRockId === m.rockId && twin.mode === "ORBIT"
      && Math.trunc(Number(twin.targetEntityID)) === m.rockId;
    if (steady) return;
    const ok = ts.orbit(scene, twin, m.rockId, Math.max(0, m.workRangeM - config.miningRangeBufferMeters)) === true;
    m.orbitRockId = ok ? m.rockId : null;
    m.orbitCheckAtMs = nowMs + (ok ? config.followRetuneMs : config.miningSeekRetryMs);
  }

  function lockStep(rt, m, ctx, nowMs, fromSlot) {
    const { scene, twin } = ctx;
    const rock = ts.entity(scene, m.rockId);
    const locked = rock ? ts.lock(scene, twin, rock, { keepIds: [m.rockId] })
      : { ok: false, reason: "TARGET_NOT_FOUND" };
    if (!locked || locked.ok !== true) {
      bump("mining.lock.refused");
      rt.lastRefusal = "NO_MINEABLE";
      toSeek(rt, m, scene, twin, nowMs + config.miningSeekRetryMs);
      return;
    }
    rt.sub = "MINING";
    if (!fromSlot) orbitRock(m, scene, twin, nowMs);
    const round = activateAll(rt, m, scene, twin, nowMs);
    m.refusedRounds = round.tried > 0 && round.ok === 0 ? 1 : 0;
  }

  function miningStep(rt, m, ctx, nowMs, fromSlot) {
    const { scene, twin, host } = ctx;
    const state = access.rockState(scene, m.rockId);
    if (!state || !(state.remaining > 0)) {
      toSeek(rt, m, scene, twin, nowMs);
      return;
    }
    const fill = access.holdFill(rt.hold);
    const noRoom = fill.freeForType(state.yieldTypeID) < state.unitVolume;
    if (noRoom && !(rt.hold.usedM3 > 0)) {
      rt.lastRefusal = "NO_MINEABLE";
      toSeek(rt, m, scene, twin, nowMs + config.miningSeekRetryMs);
      return;
    }
    if (fill.pct >= config.miningUnloadAtPercent || noRoom) {
      deactivateAll(scene, twin, m);
      release(m);
      m.rockId = null;
      m.ordered = false;
      m.fromSlot = null;
      if (ctx.formation === true && nearHost(ctx)) {
        rt.sub = "UNLOAD";
        unloadStep(rt, m, scene, twin, host, nowMs);
        return;
      }
      rt.sub = "UNLOAD_TRAVEL";
      if (host) ts.followHost(scene, twin, host.itemID, Math.floor(config.miningTransferRangeMeters / 2));
      return;
    }
    if (fromSlot) {
      const rock = ts.entity(scene, m.rockId);
      if (!rock || ts.surfaceDistance(scene, twin, rock) > m.workRangeM) return;
    } else {
      orbitRock(m, scene, twin, nowMs);
    }
    const round = activateAll(rt, m, scene, twin, nowMs);
    if (round.ok > 0) m.refusedRounds = 0;
    else if (round.tried > 0) m.refusedRounds += 1;
    if (m.refusedRounds >= REFUSED_ROUNDS_TO_SEEK) toSeek(rt, m, scene, twin, nowMs + config.miningSeekRetryMs);
  }

  function nearHost(ctx) {
    return Boolean(ctx.host) && ts.surfaceDistance(ctx.scene, ctx.twin, ctx.host) <= config.miningTransferRangeMeters;
  }

  return {
    name: "mine",

    canRun(twin, _adapter, ctx = {}) {
      if (hookReady() !== true || !twin) return { ok: false, reason: "TASK_UNAVAILABLE" };
      const mods = access.miningModules(twin);
      if (mods.length === 0) return { ok: false, reason: "NO_MINING_MODULE" };
      if (ctx && ctx.targetId) {
        const checked = access.checkTarget(ctx.scene, twin, ctx.targetId, familiesOf(mods));
        if (!checked || checked.ok !== true) return { ok: false, reason: "TARGET_INVALID" };
        const host = ts.entity(ctx.scene, ctx.record && ctx.record.hostShipId);
        if (!hostNear(ctx.scene, host, ctx.targetId, orderRangeM())) {
          return { ok: false, reason: "TARGET_INVALID" };
        }
      }
      return { ok: true };
    },

    start(rt, opts = {}) {
      const old = rt.mine;
      if (old) {
        deactivateAll(opts.scene, opts.twin, old);
        release(old);
      }
      const m = initMine(rt, opts.record);
      if (old) m.oreLostCounted = old.oreLostCounted;
      rt.sub = "SEEK";
      rt.nextActionAtMs = 0;
    },

    step(rt, ctx = {}) {
      if (ctx.nowMs !== budgetNowMs) {
        budgetNowMs = ctx.nowMs;
        seeksLeft = config.miningMaxSeeksPerTick;
        depositsLeft = config.miningRealCargoMaxDepositsPerTick;
      }
      if (!ctx.scene || !ctx.twin) return MOVES;
      const m = rt.mine || initMine(rt, ctx.record);
      const nowMs = Number(ctx.nowMs) || 0;
      if (!MINE_SUB.includes(rt.sub)) rt.sub = "SEEK";
      if (realOn && rt.hold && rt.hold.usedM3 > 0 && nowMs >= m.nextDepositAtMs && depositsLeft > 0) {
        depositsLeft -= 1;
        const empty = depositStep(rt, m, false);
        m.nextDepositAtMs = nowMs + config.miningRealCargoIntervalMs;
        if (empty && (rt.sub === "UNLOAD_TRAVEL" || rt.sub === "UNLOAD" || rt.sub === "FULL")) {
          rt.sub = "SEEK";
          rt.nextActionAtMs = nowMs;
        }
      }
      if ((rt.sub === "LOCK" || rt.sub === "MINING") && m.ordered === true && m.rockId
        && !hostNear(ctx.scene, ctx.host, m.rockId, hostLeftLimitM(m))) {
        bump("mining.mine.hostLeft");
        toSeek(rt, m, ctx.scene, ctx.twin, nowMs);
      }
      const fromSlot = LEASH_SUB.includes(rt.sub) && m.rockId ? minesFromSlot(m, ctx) : false;
      switch (rt.sub) {
        case "SEEK": seek(rt, m, ctx, nowMs); break;
        case "APPROACH": approachStep(rt, m, ctx, nowMs, fromSlot); break;
        case "LOCK": lockStep(rt, m, ctx, nowMs, fromSlot); break;
        case "MINING": miningStep(rt, m, ctx, nowMs, fromSlot); break;
        case "UNLOAD_TRAVEL":
          if (nearHost(ctx)) {
            rt.sub = "UNLOAD";
            unloadStep(rt, m, ctx.scene, ctx.twin, ctx.host, nowMs);
          }
          break;
        case "UNLOAD": unloadStep(rt, m, ctx.scene, ctx.twin, ctx.host, nowMs); break;
        case "FULL":
          if (nowMs < rt.nextActionAtMs) break;
          if (nearHost(ctx)) {
            unloadStep(rt, m, ctx.scene, ctx.twin, ctx.host, nowMs);
          } else {
            rt.sub = "UNLOAD_TRAVEL";
            if (ctx.host) {
              ts.followHost(ctx.scene, ctx.twin, ctx.host.itemID, Math.floor(config.miningTransferRangeMeters / 2));
            }
          }
          break;
        default: break;
      }
      if (ctx.formation === true && m.fromSlot === null && m.rockId && LEASH_SUB.includes(rt.sub)) {
        minesFromSlot(m, ctx);
      }
      const inSlot = ctx.formation === true
        && (rt.sub === "SEEK" || (m.fromSlot === true && m.rockId && LEASH_SUB.includes(rt.sub)));
      if (m.ordered === true && m.rockId && LEASH_SUB.includes(rt.sub)) {
        return { controlsMovement: !inSlot, leashAnchorId: m.rockId };
      }
      return inSlot ? FREE : MOVES;
    },

    stop(rt, _reason, ctx = {}) {
      const m = rt.mine;
      if (!m) return;
      const scene = ctx && ctx.scene ? ctx.scene : null;
      const twin = scene ? ts.entity(scene, m.twinEntityId) : null;
      deactivateAll(scene, twin, m);
      release(m);
      m.rockId = null;
    },

    beforeEnd(rt, reason, ctx = {}) {
      const toHost = reason === "RECALL_DONE" || reason === "BOARDED";
      if (!(rt.hold && rt.hold.usedM3 > 0)) return;
      if (realOn) depositStep(rt, rt.mine || initMine(rt, ctx && ctx.record), true);
      if ((!toHost && !OVERFLOW_END_REASONS.includes(reason)) || !(rt.hold.usedM3 > 0)) return;
      const m = rt.mine || initMine(rt, ctx && ctx.record);
      const scene = ctx && ctx.scene ? ctx.scene : null;
      if (toHost) unload(rt, m, scene);
      if (config.miningOverflowOnEnd === true && scene && posNum(rt.hold.usedM3) > 0) {
        jettison(rt, m, scene, ts.entity(scene, m.twinEntityId), true);
      }
    },

    dispose(rt, _reason) {
      const m = rt.mine || initMine(rt, null);
      release(m);
      const lost = rt.hold ? posNum(rt.hold.usedM3) : 0;
      if (lost > 0 && m.oreLostCounted !== true) {
        m.oreLostCounted = true;
        bump("mining.oreLostM3", lost);
      }
    },

    stats: () => ({ counters: { ...counters }, claims: claims.size }),
  };
}

module.exports = {
  isSized, sizeHold, holdSpace, holdAdd, holdTake, round6,
  MINE_SUB, ENGINE_ACTIVATE_REFUSAL, ENGINE_COUNTER_NAMES, OVERFLOW_END_REASONS, createMineEngine,
};
