"use strict";

const { createEntry, isDue, pause, applyCycleResult, createTickBudget } = require("./cycleSchedule");

const COMBAT_MODE = Object.freeze(["ASSIST", "ATTACK", "IDLE"]);
const ASSIST_SOURCE = Object.freeze(["host", "mirror", "defend", "auto", "none", "noWeapons"]);
const EXPLICIT_SOURCES = Object.freeze(["window", "chat"]);
const DEFERRED = Object.freeze({ deferred: true });
const LOCK_REFUSAL = Object.freeze([
  "TARGET_NOT_FOUND", "TARGET_OUT_OF_RANGE", "TARGET_LOCK_LIMIT_REACHED", "TARGET_JAMMED", "TARGET_TETHERED",
  "TARGET_INVULNERABLE", "TARGET_NOT_TARGETABLE", "SENSORS_RECALIBRATING", "TARGET_LOCK_FAILED", "OTHER",
]);
const ENGINE_COUNTER_NAMES = Object.freeze([
  "combat.volley.deferred",
  ...ASSIST_SOURCE.map((s) => `combat.assist.${s}`),
  ...LOCK_REFUSAL.map((code) => `combat.lock.refused.${code}`),
  "combat.approach.timeout",
  "combat.ammo.writeBack.ok", "combat.ammo.writeBack.failed", "combat.ammo.writeBack.noMap",
  "combat.ammo.empty",
  "combat.assist.droneOnly",
  "combat.auto.armed", "combat.auto.scan", "combat.auto.scan.deferred",
]);
const TARGET_INVALID_REASONS = Object.freeze(["BREACHER_TARGET_INVALID"]);
const STEERING_MODES = Object.freeze(["FOLLOW", "ORBIT"]);
const FREE = Object.freeze({ controlsMovement: false });
const MOVES = Object.freeze({ controlsMovement: true });

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

const AMMO_RECEIPT_PREFIX = "wing-ammo:";
const AMMO_RECEIPT_OPERATION = "consume-inventory-item-quantity";

function ammoReceiptKey(shipItemId, launchedAtMs, realChargeItemId) {
  return `${AMMO_RECEIPT_PREFIX}${shipItemId}:${launchedAtMs}:${realChargeItemId}`;
}

function chargesUsedOf(data) {
  if (!data) return 0;
  if (Object.prototype.hasOwnProperty.call(data, "chargesUsed")) {
    const n = Number(data.chargesUsed);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }
  return data.chargeMode === "stack" ? 1 : 0;
}

function createAttackEngine(deps) {
  const access = deps.access;
  const ts = deps.scene;
  const config = deps.config || {};
  const isTwin = typeof deps.isTwin === "function" ? deps.isTwin : () => true;
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const droneWeapons = typeof deps.droneWeapons === "function" ? deps.droneWeapons : () => false;
  const counters = Object.fromEntries(ENGINE_COUNTER_NAMES.map((name) => [name, 0]));
  const budget = createTickBudget(config.combatMaxVolleysPerTick);
  const scanBudget = createTickBudget(config.combatAutoScansPerTick);
  const scans = new WeakMap();

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function autoOn() {
    if (config.combatAutoTargetEnabled !== true) return false;
    if (typeof access.autoCandidates !== "function" || typeof access.autoAvailable !== "function") return false;
    try {
      return access.autoAvailable() === true;
    } catch (_err) {
      return false;
    }
  }

  function scanFor(scene, twin, host, nowMs) {
    const hostId = toInt(host && host.itemID, 0);
    if (hostId <= 0 || !scene || typeof scene !== "object") return [];
    let memo = scans.get(scene);
    if (!memo || memo.nowMs !== nowMs) {
      memo = { nowMs, byHost: new Map() };
      scans.set(scene, memo);
    }
    if (memo.byHost.has(hostId)) return memo.byHost.get(hostId);
    if (!scanBudget.take(nowMs)) {
      bump("combat.auto.scan.deferred");
      return DEFERRED;
    }
    bump("combat.auto.scan");
    const out = access.autoCandidates(scene, twin, host, {
      rangeM: Math.min(config.combatAutoTargetRangeMeters, config.combatEngageRangeMeters),
      maxEntities: config.combatAutoScanMaxEntities,
    });
    const list = out && out.ok === true && Array.isArray(out.candidates) ? out.candidates : [];
    memo.byHost.set(hostId, list);
    return list;
  }

  function autoPick(c, ctx, nowMs, usable) {
    const { scene, twin, host } = ctx;
    const list = scanFor(scene, twin, host, nowMs);
    if (list === DEFERRED) return DEFERRED;
    const locked = new Set(ts.targetsOf(scene, host));
    const threats = new Set([...access.threatsOf(scene, host), ...access.threatsOf(scene, twin)]);
    const tier = (id) => (locked.has(id) ? 0 : (threats.has(id) ? 1 : 2));
    const ordered = list.filter((e) => e && toInt(e.id, 0) > 0)
      .sort((a, b) => tier(a.id) - tier(b.id) || a.hostDistanceM - b.hostDistanceM || a.id - b.id);
    for (const { id } of ordered) {
      if (id === c.autoSkipId && nowMs < c.autoSkipUntilMs) continue;
      if (usable(id)) return id;
    }
    return null;
  }

  function combatOf(rt) {
    if (!rt.combat) {
      rt.combat = { weapons: null, used: new Map(), initial: new Map(), targetId: null, lockedTargetId: null,
        lockRetryAtSimMs: 0, lastMirrorTargetId: null, nextReacquireAtMs: 0, approach: null, range: null,
        rangeKey: null, rangeRetryAtSimMs: null, ammoPlan: null, active: false,
        empty: new Set(), invalidFor: new Map(),
        auto: false, wait: null, autoSkipId: null, autoSkipUntilMs: 0 };
    }
    return rt.combat;
  }

  function weaponsOf(c, twin) {
    if (c.weapons === null && twin) {
      c.weapons = access.listWeapons(twin, { countUnsupported: true })
        .map((weapon) => ({ entry: createEntry(weapon.moduleId, "volley"), weapon }));
      for (const { weapon } of c.weapons) {
        const id = toInt(weapon.chargeItemId, 0);
        if (id > 0 && !c.initial.has(id)) c.initial.set(id, Math.max(0, toInt(weapon.chargeQuantity, 0)));
      }
    }
    return c.weapons || [];
  }

  function outcome(rt, c) {
    return rt.mode !== "IDLE" && c.targetId !== null ? MOVES : FREE;
  }

  function allowed(scene, twin, host, id) {
    const target = ts.entity(scene, id);
    const checked = access.checkTarget(scene, twin, host, target);
    return checked && checked.ok === true ? target : null;
  }

  function disarm(c) {
    c.auto = false;
    c.wait = null;
    c.autoSkipId = null;
  }

  function dropTarget(c) {
    c.targetId = null;
    c.lockedTargetId = null;
    c.approach = null;
  }

  function lose(rt, c, retryAtMs) {
    dropTarget(c);
    if (rt.mode === "ATTACK") {
      rt.mode = config.combatAssistOnLaunch === true || c.auto === true ? "ASSIST" : "IDLE";
      rt.targetId = null;
    }
    c.nextReacquireAtMs = retryAtMs;
  }

  function acquire(c, ctx, nowMs, mirrorOn) {
    if (nowMs < c.nextReacquireAtMs) return;
    c.nextReacquireAtMs = nowMs + config.combatReacquireMs;
    const { scene, twin, host } = ctx;
    const usable = (id) => (fightable(c, toInt(id, 0)) ? allowed(scene, twin, host, id) : null);
    let picked = null;
    let source = "none";
    for (const id of access.hostWeaponTargets(host)) {
      if (usable(id)) {
        picked = id;
        source = "host";
        break;
      }
    }
    if (picked === null && mirrorOn !== false && c.lastMirrorTargetId && usable(c.lastMirrorTargetId)) {
      picked = c.lastMirrorTargetId;
      source = "mirror";
    }
    if (picked === null && config.combatDefendWhenAttacked === true) {
      const ids = [...new Set([...access.threatsOf(scene, twin), ...access.threatsOf(scene, host)])]
        .sort((a, b) => a - b);
      let best = Infinity;
      for (const id of ids) {
        const target = usable(id);
        const d = target ? ts.surfaceDistance(scene, twin, target) : Infinity;
        if (target && d < best) {
          best = d;
          picked = id;
        }
      }
      if (picked !== null) source = "defend";
    }
    if (picked === null && c.targetId !== null && usable(c.targetId)) {
      c.wait = null;
      return;
    }
    if (picked === null && c.auto === true && autoOn()) {
      const id = autoPick(c, ctx, nowMs, usable);
      if (id === DEFERRED) {
        c.nextReacquireAtMs = nowMs;
        return;
      }
      if (id !== null) {
        picked = id;
        source = "auto";
      }
    }
    c.wait = picked === null && c.auto === true ? "NO_TARGET" : null;
    bump(`combat.assist.${source}`);
    if (picked !== c.targetId) {
      dropTarget(c);
      c.targetId = picked;
    }
  }

  function rangeOf(c, twin, weapons, simMs) {
    const armed = weapons.filter(({ weapon }) => weapon.steers !== false && canHit(c, weapon, c.targetId));
    const shortest = armed.length > 0;
    const pool = shortest ? armed : weapons.filter(({ weapon }) => weapon.steers === false);
    const key = pool.map(({ weapon }) => weapon.moduleId).join(",");
    const retryDue = c.rangeRetryAtSimMs !== null && simMs >= c.rangeRetryAtSimMs;
    if (c.rangeKey !== key || retryDue) {
      let best = null;
      let failed = false;
      for (const { weapon } of pool) {
        const out = access.weaponRange(twin, weapon);
        if (out && out.ok !== true && out.reason === "ERROR") failed = true;
        if (!out || out.ok !== true) continue;
        const reach = out.optimalM + out.falloffM;
        if (best === null || (shortest ? reach < best.reach : reach > best.reach)) {
          best = { optimalM: out.optimalM, falloffM: out.falloffM, reach, keepsMoving: weapon.keepsMoving === true };
        }
      }
      c.range = best ? { optimalM: best.optimalM, falloffM: best.falloffM, keepsMoving: best.keepsMoving } : null;
      c.rangeKey = key;
      c.rangeRetryAtSimMs = failed ? simMs + config.combatReacquireMs : null;
    }
    return c.range;
  }

  function leaseValid(rt, simMs) {
    const lease = rt.moveLease;
    return Boolean(lease && Number(lease.untilSimMs) > simMs);
  }

  function move(rt, c, ctx, target, weapons, simMs) {
    const { scene, twin } = ctx;
    const range = rangeOf(c, twin, weapons, simMs);
    if (!range) return "NEAR";
    const d = ts.surfaceDistance(scene, twin, target);
    const near = d <= range.optimalM + range.falloffM;
    if (leaseValid(rt, simMs)) {
      c.approach = null;
      return near ? "NEAR" : "FAR";
    }
    if (ctx.formation === true) {
      c.approach = null;
      return near ? "NEAR" : "FAR";
    }
    const a = c.approach;
    if (near && range.keepsMoving === true) {
      if (!a || a.targetId !== c.targetId || a.stopped === true || a.keepsMoving !== true) {
        ts.approach(scene, twin, c.targetId, 0);
        c.approach = { targetId: c.targetId, stopped: false, keepsMoving: true };
      }
      return "NEAR";
    }
    if (near) {
      if (!a || a.targetId !== c.targetId || a.stopped !== true) {
        ts.stop(scene, twin);
        c.approach = { targetId: c.targetId, stopped: true };
      }
      return "NEAR";
    }
    const orbitM = Math.min(range.optimalM, config.combatOrbitMaxMeters);
    if (!a || a.targetId !== c.targetId || a.stopped === true || a.keepsMoving === true) {
      ts.approach(scene, twin, c.targetId, orbitM);
      c.approach = { targetId: c.targetId, stopped: false, sinceSimMs: simMs, lastIssuedSimMs: simMs, lastDistM: d };
      return "FAR";
    }
    if (simMs - a.sinceSimMs >= config.combatApproachTimeoutMs) {
      bump("combat.approach.timeout");
      return "TIMEOUT";
    }
    if (simMs - a.lastIssuedSimMs >= config.combatApproachRetuneMs) {
      const steering = STEERING_MODES.includes(twin.mode) && toInt(twin.targetEntityID, 0) === c.targetId;
      if (!steering || d >= a.lastDistM) ts.approach(scene, twin, c.targetId, orbitM);
      a.lastIssuedSimMs = simMs;
      a.lastDistM = d;
    }
    return "FAR";
  }

  function ensureLock(c, ctx, target, weapons, simMs) {
    const { scene, twin } = ctx;
    if (c.lockedTargetId === c.targetId && ts.targetsOf(scene, twin).includes(c.targetId)) return true;
    c.lockedTargetId = null;
    if (simMs < c.lockRetryAtSimMs) return false;
    const locked = ts.lock(scene, twin, target, { keepIds: [] });
    if (locked && locked.ok === true) {
      c.lockedTargetId = c.targetId;
      return true;
    }
    const code = LOCK_REFUSAL.includes(locked && locked.reason) ? locked.reason : "OTHER";
    bump(`combat.lock.refused.${code}`);
    c.lockRetryAtSimMs = simMs + config.combatReacquireMs;
    for (const { entry, weapon } of weapons) {
      if (weapon.needsLock !== false) pause(entry, config.combatReacquireMs, simMs, "NOT_LOCKED");
    }
    return false;
  }

  function ammoLeft(c, weapon) {
    if (c.empty instanceof Set && c.empty.has(weapon.moduleId)) return 0;
    const id = toInt(weapon.chargeItemId, 0);
    if (id <= 0) return weapon.needsAmmo === true ? 0 : Infinity;
    return (c.initial.get(id) || 0) - (c.used.get(id) || 0);
  }

  function canHit(c, weapon, targetId) {
    if (ammoLeft(c, weapon) <= 0) return false;
    return !(c.invalidFor instanceof Map && targetId !== null && c.invalidFor.get(weapon.moduleId) === targetId);
  }

  function fightable(c, targetId) {
    if (c.droneOnly === true) return true;
    return (c.weapons || []).some(({ weapon }) => canHit(c, weapon, targetId));
  }

  function dry(rt, c) {
    if (c.dry !== true) {
      c.dry = true;
      bump("combat.ammo.empty");
    }
    c.wait = null;
    dropTarget(c);
    if (rt.mode === "ATTACK" || rt.targetId !== null) {
      rt.mode = "ASSIST";
      rt.targetId = null;
    }
    return FREE;
  }

  function volleys(rt, c, ctx, target, weapons, simMs, nowMs, locked) {
    const { scene, twin, host } = ctx;
    for (const { entry, weapon } of weapons) {
      if (locked !== true && weapon.needsLock !== false) continue;
      if (c.invalidFor.get(weapon.moduleId) === c.targetId) continue;
      if (!isDue(entry, simMs)) continue;
      if (ammoLeft(c, weapon) <= 0) {
        pause(entry, config.combatReacquireMs, simMs, "NO_AMMO");
        continue;
      }
      const checked = access.checkTarget(scene, twin, host, target);
      if (!checked || checked.ok !== true) {
        lose(rt, c, nowMs);
        return outcome(rt, c);
      }
      if (!budget.take(nowMs)) {
        bump("combat.volley.deferred");
        continue;
      }
      const result = access.fireVolley(scene, twin, weapon, target, simMs, { ammoLeft: ammoLeft(c, weapon), host });
      applyCycleResult(entry, result, simMs, config.combatReacquireMs);
      if (result && result.ok !== true && result.reason === "NO_AMMO") c.empty.add(weapon.moduleId);
      if (result && result.ok !== true && TARGET_INVALID_REASONS.includes(result.reason)) {
        c.invalidFor.set(weapon.moduleId, c.targetId);
      }
      const data = result && result.ok === true && result.data ? result.data : null;
      const chargeId = data ? toInt(data.chargeItemId, 0) : 0;
      const usedNow = chargesUsedOf(data);
      if (chargeId > 0 && usedNow > 0) c.used.set(chargeId, (c.used.get(chargeId) || 0) + usedNow);
      if (c.active !== true || !isTwin(twin) || access.isGone(scene, twin)) return FREE;
      if ((data && data.destroyed === true) || access.isGone(scene, target)) {
        lose(rt, c, nowMs);
        return outcome(rt, c);
      }
    }
    return outcome(rt, c);
  }

  function droneOnlyStep(rt, c, ctx, nowMs) {
    c.droneOnly = droneWeapons(ctx.twin, ctx) === true;
    if (!c.droneOnly) return FREE;
    if (rt.mode === "ASSIST") acquire(c, ctx, nowMs, rt.mirrorEngage !== false);
    if (rt.mode === "IDLE" || c.targetId === null) return FREE;
    if (!allowed(ctx.scene, ctx.twin, ctx.host, c.targetId)) lose(rt, c, nowMs);
    return FREE;
  }

  const engine = {
    name: "attack",

    canRun(twin, _adapter, ctx = {}) {
      if (!twin) return { ok: false, reason: "TASK_UNAVAILABLE" };
      const rt = ctx.rt || null;
      if (rt && rt.ending === true) return { ok: false, reason: "ENDING" };
      if (access.listWeapons(twin).length === 0) {
        if (droneWeapons(twin, ctx) !== true) {
          if (ctx.mode === "ASSIST") bump("combat.assist.noWeapons");
          return { ok: false, reason: "NO_WEAPONS" };
        }
        bump("combat.assist.droneOnly");
      }
      const known = rt && rt.combat && Array.isArray(rt.combat.weapons) ? rt.combat.weapons : [];
      if (known.length > 0 && known.every(({ weapon }) => ammoLeft(rt.combat, weapon) <= 0)) {
        return { ok: false, reason: "NO_AMMO" };
      }
      if (ctx.mode === "ASSIST") return { ok: true };
      const scene = ctx.scene || null;
      const record = ctx.record || {};
      const host = ts.entity(scene, record.hostShipId);
      const hittable = (id) => known.length === 0 || fightable(rt.combat, id);
      if (ctx.targetId) {
        const checked = access.checkTarget(scene, twin, host, ts.entity(scene, ctx.targetId));
        if (!checked || checked.ok !== true) return { ok: false, reason: (checked && checked.reason) || "NO_TARGET" };
        return hittable(ctx.targetId) ? { ok: true } : { ok: false, reason: "TARGET_INVALID" };
      }
      let firstRefusal = null;
      for (const id of access.hostWeaponTargets(host)) {
        const checked = access.checkTarget(scene, twin, host, ts.entity(scene, id));
        if (checked && checked.ok === true && hittable(id)) return { ok: true, targetId: id };
        if (firstRefusal === null && checked) firstRefusal = checked.ok === true ? "TARGET_INVALID" : checked.reason;
      }
      for (const id of ts.targetsOf(scene, host)) {
        if (allowed(scene, twin, host, id) && hittable(id)) return { ok: true, targetId: id };
      }
      if (autoOn() && EXPLICIT_SOURCES.includes(ctx.source)) return { ok: true };
      return { ok: false, reason: firstRefusal || "NO_TARGET" };
    },

    accept(rt, opts = {}) {
      const c = combatOf(rt);
      const id = toInt(opts.targetId, 0);
      if (opts.source === "mirror" && id > 0) c.lastMirrorTargetId = id;
      c.auto = autoOn() && EXPLICIT_SOURCES.includes(opts.source);
      c.wait = null;
      if (c.auto) {
        bump("combat.auto.armed");
        c.nextReacquireAtMs = 0;
        if (rt.task === "ATTACK" && rt.mode === "IDLE") rt.mode = "ASSIST";
      }
    },

    start(rt, opts = {}) {
      const c = combatOf(rt);
      c.active = true;
      weaponsOf(c, opts.twin || null);
      dropTarget(c);
      c.lockRetryAtSimMs = 0;
      c.nextReacquireAtMs = 0;
      if (opts.mode === "ASSIST" || rt.targetId === null) {
        rt.mode = "ASSIST";
      } else {
        rt.mode = "ATTACK";
        c.targetId = rt.targetId;
      }
    },

    step(rt, ctx = {}) {
      const c = combatOf(rt);
      const { scene, twin, host } = ctx;
      if (!scene || !twin || c.active !== true || !COMBAT_MODE.includes(rt.mode)) return FREE;
      if (rt.ending === true) return FREE;
      const nowMs = Number(ctx.nowMs) || 0;
      const simMs = ts.simNow(scene);
      const weapons = weaponsOf(c, twin);
      if (weapons.length === 0) return droneOnlyStep(rt, c, ctx, nowMs);
      if (weapons.every(({ weapon }) => ammoLeft(c, weapon) <= 0)) return dry(rt, c);
      if (rt.mode === "ASSIST") acquire(c, ctx, nowMs, rt.mirrorEngage !== false);
      if (rt.mode === "IDLE" || c.targetId === null) return FREE;
      const target = fightable(c, c.targetId) ? allowed(scene, twin, host, c.targetId) : null;
      if (!target) {
        lose(rt, c, nowMs);
        return outcome(rt, c);
      }
      const moved = move(rt, c, ctx, target, weapons, simMs);
      if (moved === "TIMEOUT") {
        if (c.auto === true) {
          c.autoSkipId = c.targetId;
          c.autoSkipUntilMs = nowMs + config.combatApproachTimeoutMs;
        }
        lose(rt, c, nowMs + config.combatReacquireMs);
        return outcome(rt, c);
      }
      const needsAnyLock = weapons.some(({ weapon }) => weapon.needsLock !== false);
      const locked = needsAnyLock ? ensureLock(c, ctx, target, weapons, simMs) : true;
      if (moved !== "NEAR") return MOVES;
      return volleys(rt, c, ctx, target, weapons, simMs, nowMs, locked);
    },

    stop(rt, _reason, _ctx) {
      const c = rt.combat;
      if (!c) return;
      c.active = false;
      disarm(c);
      dropTarget(c);
    },

    beforeEnd(rt, _reason, ctx = {}) {
      rt.ending = true;
      const c = rt.combat;
      if (config.combatAmmoWriteBack !== true || !c) return;
      const record = ctx && ctx.record ? ctx.record : null;
      if (c.ammoPlan === null) {
        const byReal = new Map();
        const map = rt.launch && rt.launch.syntheticToReal instanceof Map ? rt.launch.syntheticToReal : null;
        for (const [syntheticId, n] of [...c.used.entries()].sort((a, b) => a[0] - b[0])) {
          if (!(n > 0)) continue;
          const realId = map ? toInt(map.get(syntheticId), 0) : 0;
          if (realId <= 0) {
            bump("combat.ammo.writeBack.noMap");
            continue;
          }
          byReal.set(realId, (byReal.get(realId) || 0) + n);
        }
        c.ammoPlan = [...byReal.entries()].map(([realChargeItemId, quantity]) => ({ realChargeItemId, quantity,
          done: false }));
      }
      for (const item of c.ammoPlan) {
        if (item.done) continue;
        if (!record || !Number.isSafeInteger(record.shipItemId)) {
          bump("combat.ammo.writeBack.failed");
          continue;
        }
        const shipItemId = record.shipItemId;
        const out = access.consumeAmmo(item.realChargeItemId, item.quantity, {
          receiptKey: ammoReceiptKey(shipItemId, record.launchedAtMs, item.realChargeItemId),
          fingerprint: { shipItemId, realChargeItemId: item.realChargeItemId, quantity: item.quantity },
        });
        if (!out || out.ok !== true) {
          bump("combat.ammo.writeBack.failed");
          continue;
        }
        item.done = true;
        bump("combat.ammo.writeBack.ok");
        if (Array.isArray(out.changes) && out.changes.length > 0) emit(record.ownerCharacterId, out.changes);
      }
    },

    dispose(rt, _reason) {
      if (!rt.combat) return;
      rt.combat.active = false;
      disarm(rt.combat);
    },

    view(rt) {
      const c = rt && rt.combat;
      const running = Boolean(c && c.active === true && rt.task === "ATTACK");
      const out = {
        targetId: running ? c.targetId : rt.targetId,
        wait: running && c.auto === true && typeof c.wait === "string" ? c.wait : null,
      };
      if (running && Array.isArray(c.weapons) && c.weapons.length === 0) out.weaponless = true;
      return out;
    },

    stats: () => ({ counters: { ...counters } }),
  };
  const stepEngine = engine.step;
  engine.step = (rt, ctx = {}) => {
    const out = stepEngine(rt, ctx);
    return ctx.formation === true ? FREE : out;
  };
  return engine;
}

module.exports = {
  COMBAT_MODE, ASSIST_SOURCE, EXPLICIT_SOURCES, LOCK_REFUSAL, ENGINE_COUNTER_NAMES, AMMO_RECEIPT_PREFIX, AMMO_RECEIPT_OPERATION,
  ammoReceiptKey, createAttackEngine,
};
