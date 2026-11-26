"use strict";

const { createEntry, isDue, pause, applyCycleResult, createTickBudget } = require("./cycleSchedule");
const { FAMILY_LAYER, CYCLE_REASON, layerPct: layerPctOf, candidates, pick, allowedIds } = require("./logiPolicy");
const { distance: centerDistance } = require("../util/vec");

const STOP_REASON = Object.freeze(["FULL", "DISPOSED"]);
const SIDECAR_COUNTER_NAMES = Object.freeze([
  "active.localRep.cycle", "active.localRep.applied", "active.localRep.error", "active.localRep.noAmmo",
  ...STOP_REASON.map((r) => `active.localRep.stop.${r}`),
  "active.cycles.deferred", "active.sidecar.noPlan",
]);
const LOGI_COUNTER_NAMES = Object.freeze([
  "logi.cycle.start", "logi.cycle.ok", "logi.cycle.error", ...CYCLE_REASON.map((r) => `logi.cycle.skip.${r}`),
  "logi.target.host", "logi.target.twin", "logi.target.none", "logi.repairedHp", "logi.range.error",
  "logi.move.lease", "logi.move.stuck",
  "logi.move.hold",
  "logi.formation.repick",
]);
const PROP_COUNTER_NAMES = Object.freeze(["prop.on", "prop.off", "prop.error"]);
const PROP_MOVE_MODES = Object.freeze(["FOLLOW", "ORBIT", "GOTO"]);
const STEERING_MODES = Object.freeze(["FOLLOW", "ORBIT"]);
const MINING_SUBS = Object.freeze(["LOCK", "MINING"]);
const AT_WORK_SUBS = Object.freeze({ MINE: MINING_SUBS, SALVAGE: Object.freeze(["LOCK", "SALVAGING"]) });

function selfSteering(rt) {
  return Boolean(rt) && Object.prototype.hasOwnProperty.call(AT_WORK_SUBS, rt.task);
}
const FULL_PCT = 100;
const FREE = Object.freeze({ controlsMovement: false });
const MOVES = Object.freeze({ controlsMovement: true });

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : 0;
}

function layerPct(twin, layer) {
  const cs = twin && twin.conditionState && typeof twin.conditionState === "object" ? twin.conditionState : {};
  if (layer === "shield") return num(cs.shieldCharge, 1) * FULL_PCT;
  if (layer === "armor") return (1 - num(cs.armorDamage, 0)) * FULL_PCT;
  if (layer === "structure") return (1 - num(cs.damage, 0)) * FULL_PCT;
  return FULL_PCT;
}

function leaseValid(rt, simMs) {
  const lease = rt && rt.moveLease;
  return Boolean(lease && lease.by === "logi" && !selfSteering(rt) && Number(lease.untilSimMs) > simMs);
}

function propNow(rt) {
  const p = rt && rt.active && rt.active.prop ? rt.active.prop : null;
  return p && p.on === true && p.state && typeof p.state === "object" ? p.state : null;
}

function createActiveSidecar(deps) {
  const access = deps.access;
  const ts = deps.scene;
  const config = deps.config || {};
  const isTwin = typeof deps.isTwin === "function" ? deps.isTwin : () => true;
  const logi = deps.logi && typeof deps.logi === "object" ? deps.logi : null;
  const prop = deps.prop && typeof deps.prop === "object" ? deps.prop : null;
  const wingTwins = typeof deps.wingTwins === "function" ? deps.wingTwins : () => [];
  const logiOn = logi !== null && config.logiEnabled === true;
  const propOn = prop !== null && config.activePropEnabled === true;
  const counters = Object.fromEntries([...SIDECAR_COUNTER_NAMES, ...LOGI_COUNTER_NAMES, ...PROP_COUNTER_NAMES]
    .map((name) => [name, 0]));
  const budget = createTickBudget(config.activeMaxCyclesPerTick);

  function bump(name, by = 1) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += by;
  }

  function skip(result) {
    const reason = result && typeof result.reason === "string" ? result.reason : "ERROR";
    bump(CYCLE_REASON.includes(reason) ? `logi.cycle.skip.${reason}` : "logi.cycle.error");
  }

  function stateOf(rt) {
    if (rt.active === undefined) {
      const plan = rt.launch && rt.launch.active ? rt.launch.active : null;
      const reps = plan && Array.isArray(plan.localRep) ? plan.localRep : [];
      const remotes = logiOn && plan && Array.isArray(plan.remote)
        ? plan.remote.filter((r) => r && FAMILY_LAYER[r.family]) : [];
      const propRep = propOn && plan && Array.isArray(plan.prop) && plan.prop[0] ? plan.prop[0] : null;
      if (!plan) bump("active.sidecar.noPlan");
      rt.active = reps.length === 0 && remotes.length === 0 && !propRep ? null : {
        disposed: false,
        localRep: reps.map((rep) => ({ rep, entry: createEntry(rep.moduleId, "localRep"), cycling: false,
          effectState: null })),
        remote: remotes.map((rep) => ({ rep, entry: createEntry(rep.moduleId, "remote"), effectState: null,
          range: null, retargetAtSimMs: 0, targetKind: null, stuck: null })),
        prop: propRep ? { rep: propRep, entry: createEntry(propRep.moduleId, "prop"), on: false, state: null } : null,
      };
    }
    return rt.active;
  }

  function stepLocal(a, e, c) {
    const { scene, twin, owner, simMs, nowMs } = c;
    if (e.entry.applyAtSimMs !== null) {
      if (simMs < e.entry.applyAtSimMs) return true;
      const applied = access.applyLocalCycle(scene, twin, e.rep, e.effectState, simMs, owner);
      e.entry.applyAtSimMs = null;
      e.effectState = null;
      bump(applied && applied.ok === true ? "active.localRep.applied" : "active.localRep.error");
      if (!c.alive()) return false;
    }
    const pct = layerPct(twin, e.rep.layer);
    if (!e.cycling && pct < config.activeLocalRepStartPct) e.cycling = true;
    if (e.cycling && pct >= config.activeLocalRepStopPct) {
      e.cycling = false;
      bump("active.localRep.stop.FULL");
      return true;
    }
    if (!e.cycling || !isDue(e.entry, simMs)) return true;
    if (!budget.take(nowMs)) {
      bump("active.cycles.deferred");
      return true;
    }
    const result = access.runLocalCycle(scene, twin, e.rep, owner, simMs);
    applyCycleResult(e.entry, result, simMs, config.activeRetryMs);
    if (result && result.ok === true) {
      bump("active.localRep.cycle");
      const data = result.data || {};
      if (data.timing === "end") {
        e.entry.applyAtSimMs = simMs + result.durationMs;
        e.effectState = data.effectState || null;
      } else {
        bump("active.localRep.applied");
      }
    } else {
      bump(result && result.reason === "NO_AMMO" ? "active.localRep.noAmmo" : "active.localRep.error");
    }
    return c.alive();
  }

  function ruleOf(c) {
    if (!c.rule) {
      const { scene, twin, host, owner } = c;
      const own = [];
      for (const t of wingTwins(owner) || []) {
        const id = toInt(t && t.twinEntityId);
        if (id <= 0 || id === toInt(twin.itemID)) continue;
        const entity = ts.entity(scene, id);
        if (entity) own.push(entity);
      }
      const list = candidates({ twin, host, wingTwins: own, ownerCharId: owner,
        sameScene: (entity) => !access.isGone(scene, entity) && logi.canInteract(twin, entity) === true });
      const ids = allowedIds(list);
      c.rule = { list, ids, isAllowed: (id) => ids.has(toInt(id)) };
    }
    return c.rule;
  }

  function release(rt, e) {
    const lease = rt.moveLease;
    if (lease && lease.by === "logi" && lease.hold !== true && lease.moduleId === e.rep.moduleId) rt.moveLease = null;
  }

  function hold(rt, e, c, target, untilSimMs) {
    if (selfSteering(rt) || c.formation === true) return;
    const { scene, twin, simMs } = c;
    const lease = rt.moveLease;
    if (leaseValid(rt, simMs) && lease.hold === true) {
      if (untilSimMs > Number(lease.untilSimMs)) lease.untilSimMs = untilSimMs;
      return;
    }
    const id = toInt(target.itemID);
    rt.moveLease = { by: "logi", hold: true, moduleId: e.rep.moduleId, targetId: id, sinceSimMs: simMs, untilSimMs };
    bump("logi.move.hold");
    if (rt.task === "HOLD") return;
    const steering = STEERING_MODES.includes(twin.mode) && toInt(twin.targetEntityID) === id;
    if (!steering) ts.approach(scene, twin, id, Math.min(e.range.optimalM, config.logiApproachMeters));
  }

  function move(rt, e, c, target, distanceM) {
    if (selfSteering(rt) || c.formation === true) return;
    const { scene, twin, simMs } = c;
    const id = toInt(target.itemID);
    if (e.stuck && e.stuck.targetId === id && !(distanceM < e.stuck.distanceM)) return;
    e.stuck = null;
    const lease = rt.moveLease;
    const approachM = Math.min(e.range.optimalM, config.logiApproachMeters);
    const valid = leaseValid(rt, simMs);
    if (valid && lease.hold === true) return;
    if (valid && lease.moduleId !== e.rep.moduleId) return;
    if (!valid || lease.targetId !== id) {
      rt.moveLease = { by: "logi", moduleId: e.rep.moduleId, targetId: id, sinceSimMs: simMs,
        untilSimMs: simMs + config.logiMoveLeaseMs, renewAtSimMs: simMs + config.logiRetargetMs,
        lastDistanceM: distanceM, progressAtSimMs: simMs };
      bump("logi.move.lease");
      ts.approach(scene, twin, id, approachM);
      return;
    }
    if (simMs < lease.renewAtSimMs) return;
    if (distanceM < lease.lastDistanceM) {
      lease.lastDistanceM = distanceM;
      lease.progressAtSimMs = simMs;
    }
    if (simMs - lease.progressAtSimMs >= config.logiMoveLeaseMs) {
      bump("logi.move.stuck");
      rt.moveLease = null;
      e.stuck = { targetId: id, distanceM };
      return;
    }
    lease.untilSimMs = simMs + config.logiMoveLeaseMs;
    lease.renewAtSimMs = simMs + config.logiRetargetMs;
    ts.approach(scene, twin, id, approachM);
  }

  function dropTarget(rt, e) {
    e.entry.targetId = null;
    e.targetKind = null;
    release(rt, e);
  }

  function stepRemote(rt, e, c) {
    const { scene, twin, owner, simMs, nowMs } = c;
    if (e.entry.applyAtSimMs !== null) {
      if (simMs < e.entry.applyAtSimMs) return true;
      const done = logi.finishCycle(scene, twin, e.effectState, simMs, ruleOf(c).isAllowed);
      e.entry.applyAtSimMs = null;
      e.effectState = null;
      if (done && done.ok === true) {
        bump("logi.cycle.ok");
        bump("logi.repairedHp", Math.max(0, Math.round(num(done.appliedAmount, 0))));
      } else {
        skip(done);
      }
      e.retargetAtSimMs = simMs;
      if (!c.alive()) return false;
    }
    if (!isDue(e.entry, simMs)) return true;
    const rule = ruleOf(c);
    if (simMs >= e.retargetAtSimMs) {
      const filtered = c.formation === true && Boolean(e.range);
      const inReach = filtered
        ? pick(rule.list.filter((x) => ts.surfaceDistance(scene, twin, x.entity) <= e.range.optimalM + e.range.falloffM),
          e.rep.family, config.logiRepairThresholdPct)
        : null;
      const picked = inReach || pick(rule.list, e.rep.family, config.logiRepairThresholdPct);
      e.pickInReach = filtered;
      e.retargetAtSimMs = simMs + config.logiRetargetMs;
      bump(`logi.target.${picked ? picked.kind : "none"}`);
      const id = picked ? toInt(picked.entity.itemID) : null;
      if (id !== e.entry.targetId) {
        release(rt, e);
        e.stuck = null;
      }
      e.entry.targetId = id;
      e.targetKind = picked ? picked.kind : null;
    }
    const chosen = e.entry.targetId === null ? null
      : rule.list.find((x) => toInt(x.entity.itemID) === e.entry.targetId) || null;
    if (!chosen || !(layerPctOf(chosen.entity, FAMILY_LAYER[e.rep.family]) < config.logiRepairThresholdPct)) {
      dropTarget(rt, e);
      return true;
    }
    const target = chosen.entity;
    if (!e.range) {
      const got = logi.rangeOf(scene, twin, e.rep, target.itemID, owner);
      if (!got || got.ok !== true) {
        bump("logi.range.error");
        pause(e.entry, config.logiRetargetMs, simMs, got && got.reason);
        dropTarget(rt, e);
        return true;
      }
      e.range = { optimalM: num(got.optimalM, 0), falloffM: num(got.falloffM, 0) };
    }
    const distanceM = ts.surfaceDistance(scene, twin, target);
    if (!(distanceM <= e.range.optimalM + e.range.falloffM)) {
      if (rt.task === "HOLD") {
        release(rt, e);
        e.stuck = null;
        bump("logi.cycle.skip.TARGET_OUT_OF_RANGE");
        pause(e.entry, config.logiRetargetMs, simMs, "TARGET_OUT_OF_RANGE");
        return true;
      }
      if (c.formation === true) {
        if (e.pickInReach !== true) {
          bump("logi.formation.repick");
          e.retargetAtSimMs = simMs;
        }
        return true;
      }
      move(rt, e, c, target, distanceM);
      return true;
    }
    release(rt, e);
    e.stuck = null;
    if (!budget.take(nowMs)) {
      bump("active.cycles.deferred");
      return true;
    }
    const result = logi.startCycle(scene, twin, e.rep, target.itemID, owner, simMs, rule.isAllowed);
    applyCycleResult(e.entry, result, simMs, config.logiRetargetMs);
    if (result && result.ok === true) {
      bump("logi.cycle.start");
      e.entry.applyAtSimMs = simMs + result.durationMs;
      e.effectState = (result.data && result.data.effectState) || null;
      hold(rt, e, c, target, e.entry.applyAtSimMs);
    } else {
      skip(result);
      e.retargetAtSimMs = 0;
    }
    return c.alive();
  }

  function wantsProp(c) {
    const { scene, twin } = c;
    if (c.mining === true || !PROP_MOVE_MODES.includes(twin.mode)) return false;
    let distanceM = NaN;
    const targetId = twin.mode === "GOTO" ? 0 : toInt(twin.targetEntityID);
    if (targetId > 0) {
      const target = ts.entity(scene, targetId);
      distanceM = target ? ts.surfaceDistance(scene, twin, target) : NaN;
    } else if (twin.targetPoint && typeof twin.targetPoint === "object") {
      distanceM = centerDistance(twin.position, twin.targetPoint);
    }
    return Number.isFinite(distanceM) && distanceM > config.activePropMinDistanceMeters;
  }

  function stepProp(a, c) {
    const p = a.prop;
    const { scene, twin, owner, simMs, nowMs } = c;
    if (!isDue(p.entry, simMs)) return true;
    const want = wantsProp(c);
    if (want === p.on) return true;
    if (want && !p.state) {
      const got = prop.attrsOf(twin, p.rep, owner);
      if (!got || got.ok !== true) {
        bump("prop.error");
        pause(p.entry, config.followRetuneMs, simMs, got && got.reason);
        return true;
      }
      p.state = got.state;
    }
    if (!budget.take(nowMs)) {
      bump("active.cycles.deferred");
      return true;
    }
    const result = prop.apply(scene, twin, want ? p.state : null, want ? null : p.state);
    if (result && result.ok === true) {
      p.on = want;
      bump(want ? "prop.on" : "prop.off");
      pause(p.entry, result.durationMs, simMs, null);
    } else {
      p.on = null;
      bump("prop.error");
      applyCycleResult(p.entry, result, simMs, config.followRetuneMs);
    }
    return c.alive();
  }

  function step(rt, ctx = {}) {
    if (rt && rt.ending === true) {
      if (rt.moveLease && rt.moveLease.by === "logi") rt.moveLease = null;
      return FREE;
    }
    const a = rt ? stateOf(rt) : null;
    const { scene, twin, record } = ctx;
    if (!a || a.disposed || !scene || !twin || !record) return FREE;
    const simMs = ts.simNow(scene);
    if (selfSteering(rt) && rt.moveLease) rt.moveLease = null;
    const formation = ctx.formation === true;
    if (formation && rt.moveLease && rt.moveLease.by === "logi") rt.moveLease = null;
    const c = { scene, twin, host: ctx.host || null, owner: record.ownerCharacterId, simMs,
      nowMs: Number(ctx.nowMs) || 0, rule: null, formation,
      mining: selfSteering(rt) && AT_WORK_SUBS[rt.task].includes(rt.sub),
      alive: () => !a.disposed && isTwin(twin) && !access.isGone(scene, twin) };
    for (const e of a.localRep) {
      if (a.disposed || !stepLocal(a, e, c)) return FREE;
    }
    for (const e of a.remote) {
      if (a.disposed || !stepRemote(rt, e, c)) return FREE;
    }
    if (a.prop && !a.disposed && !stepProp(a, c)) return FREE;
    return leaseValid(rt, simMs) ? MOVES : FREE;
  }

  function dispose(rt, _reason) {
    const a = rt && rt.active ? rt.active : null;
    if (rt && rt.moveLease && rt.moveLease.by === "logi") rt.moveLease = null;
    if (!a || a.disposed) return;
    a.disposed = true;
    a.prop = null;
    if (a.localRep.some((e) => e.cycling || e.entry.applyAtSimMs !== null)) bump("active.localRep.stop.DISPOSED");
  }

  function view(rt) {
    const a = rt && rt.active ? rt.active : null;
    if (!a) return null;
    const out = { propOn: a.prop ? a.prop.on === true : false,
      localRepOn: a.localRep.some((e) => e.cycling === true) };
    if (a.remote.length > 0) {
      const busy = a.remote.find((e) => e.entry.targetId !== null && e.targetKind);
      out.repairing = busy ? busy.targetKind : null;
    }
    return out;
  }

  function stats() {
    const own = { ...counters };
    const fromAccess = access && typeof access.stats === "function" ? access.stats() : null;
    const fromLogi = logi && typeof logi.stats === "function" ? logi.stats() : null;
    const fromProp = prop && typeof prop.stats === "function" ? prop.stats() : null;
    return { counters: { ...own, ...(fromAccess && fromAccess.counters ? fromAccess.counters : {}),
      ...(fromLogi && fromLogi.counters ? fromLogi.counters : {}),
      ...(fromProp && fromProp.counters ? fromProp.counters : {}) } };
  }

  return { name: "active", step, dispose, view, stats, propNow };
}

module.exports = { STOP_REASON, SIDECAR_COUNTER_NAMES, LOGI_COUNTER_NAMES, PROP_COUNTER_NAMES, PROP_MOVE_MODES,
  layerPct, leaseValid, propNow, createActiveSidecar };
