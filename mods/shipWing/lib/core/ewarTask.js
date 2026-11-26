"use strict";

const { createEntry, isDue, pause, applyCycleResult, createTickBudget } = require("./cycleSchedule");
const { EWAR_KIND, EWAR_REASON } = require("../adapter/ewarAccess");

const EWAR_STOP = Object.freeze(["TARGET_CHANGED", "NO_TARGET", "NOT_ALLOWED", "LOCK_LOST", "CYCLE_FAILED",
  "ENDING", "SUSPEND", "DISPOSE", "STOPPED"]);
const EWAR_COUNTER_NAMES = Object.freeze([
  ...EWAR_KIND.map((k) => `ewar.cycle.${k}`),
  ...EWAR_KIND.map((k) => `ewar.start.${k}`),
  ...EWAR_STOP.map((w) => `ewar.stop.${w}`),
  ...EWAR_REASON.map((r) => `ewar.skip.${r}`),
  "ewar.lock.requested", "ewar.lock.refused", "ewar.cycles.deferred", "ewar.nos.gj", "ewar.neut.gj", "ewar.nos.idle",
  "ewar.release.noScene", "ewar.sidecar.noPlan",
]);
const FREE = Object.freeze({ controlsMovement: false });

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toId(value) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function createEwarSidecar(deps) {
  const access = deps.access;
  const combat = deps.combat;
  const ts = deps.scene;
  const config = deps.config || {};
  const isTwin = typeof deps.isTwin === "function" ? deps.isTwin : () => true;
  const counters = Object.fromEntries(EWAR_COUNTER_NAMES.map((name) => [name, 0]));
  const budget = createTickBudget(config.ewarMaxCyclesPerTick);
  const sweepAtBySystem = new Map();

  function bump(name, by = 1) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += by;
  }

  function skip(reason) {
    const r = typeof reason === "string" && EWAR_REASON.includes(reason) ? reason : "OTHER";
    bump(`ewar.skip.${r}`);
    return r;
  }

  function stateOf(rt) {
    if (rt.ewar === undefined) {
      const plan = rt.launch && rt.launch.active ? rt.launch.active : null;
      if (!plan) bump("ewar.sidecar.noPlan");
      const reps = plan && Array.isArray(plan.ewar)
        ? plan.ewar.filter((rep) => rep && toId(rep.moduleId) && EWAR_KIND.includes(rep.kind)) : [];
      rt.ewar = reps.length === 0 ? null : { disposed: false, twinId: 0, lockRetryAtSimMs: 0,
        mods: reps.map((rep) => ({ rep, entry: createEntry(rep.moduleId, "ewar"), effectState: null, targetId: null,
          nextAtSimMs: null, range: null })) };
    }
    return rt.ewar;
  }

  function energy(kind, appliedGJ, nosIdle) {
    if (kind === "nos" || kind === "neut") bump(`ewar.${kind}.gj`, Math.max(0, Math.round(num(appliedGJ))));
    if (kind === "nos" && nosIdle === true) bump("ewar.nos.idle");
  }

  function clear(m) {
    m.effectState = null;
    m.targetId = null;
    m.nextAtSimMs = null;
  }

  function releaseOne(scene, twin, a, m, simMs, why) {
    access.release(scene, twin, a.twinId, m.effectState, simMs);
    clear(m);
    bump(`ewar.stop.${why}`);
  }

  function releaseAll(a, scene, why) {
    if (!a) return;
    for (const m of a.mods) {
      if (!m.effectState) continue;
      if (!scene) {
        clear(m);
        bump("ewar.release.noScene");
        continue;
      }
      releaseOne(scene, ts.entity(scene, a.twinId), a, m, ts.simNow(scene), why);
    }
  }

  function sweepDue(scene, simMs) {
    const systemId = Math.trunc(num(scene.systemID));
    const at = sweepAtBySystem.get(systemId);
    if (at !== undefined && simMs < at) return;
    sweepAtBySystem.set(systemId, simMs + config.ewarOrphanSweepMs);
    access.sweep(scene, simMs);
  }

  function allowedTarget(scene, twin, host, target) {
    if (!target) return false;
    try {
      return combat.targetAllowed(scene, twin, host, target) === true;
    } catch (_err) {
      return false;
    }
  }

  function stepModules(rt, a, c) {
    const { scene, twin, simMs, nowMs } = c;
    const T = rt.task === "ATTACK" && rt.combat ? toId(rt.combat.targetId) : null;
    const target = T ? ts.entity(scene, T) : null;
    const allowed = allowedTarget(scene, twin, c.host, target);
    let locked = T !== null && ts.targetsOf(scene, twin).includes(T);
    if (allowed && !locked && simMs >= a.lockRetryAtSimMs) {
      bump("ewar.lock.requested");
      const got = ts.lock(scene, twin, target, { keepIds: ts.targetsOf(scene, twin) });
      if (got && got.ok === true) {
        locked = true;
      } else {
        bump("ewar.lock.refused");
        a.lockRetryAtSimMs = simMs + config.ewarRetryMs;
      }
    }
    const isAllowed = (id) => id === T && allowed;
    const retry = config.ewarRetryMs;
    for (const m of a.mods) {
      if (!c.alive()) break;
      const kind = m.rep.kind;
      if (m.effectState) {
        let why = null;
        if (m.targetId !== T) why = T === null ? "NO_TARGET" : "TARGET_CHANGED";
        else if (!allowed) why = "NOT_ALLOWED";
        else if (!locked) why = "LOCK_LOST";
        if (why) releaseOne(scene, twin, a, m, simMs, why);
      }
      if (T === null || !allowed || !locked) continue;
      if (m.effectState) {
        if (simMs < m.nextAtSimMs) continue;
        if (!budget.take(nowMs)) {
          bump("ewar.cycles.deferred");
          continue;
        }
        const done = access.refreshCycle(scene, twin, m.effectState, simMs, isAllowed);
        if (done && done.ok === true) {
          const d = num(m.effectState.durationMs);
          m.nextAtSimMs = simMs + (d > 0 ? d : retry);
          bump(`ewar.cycle.${kind}`);
          energy(kind, done.appliedGJ, done.nosIdle);
        } else {
          clear(m);
          bump("ewar.stop.CYCLE_FAILED");
          pause(m.entry, retry, simMs, skip(done && done.reason));
        }
        continue;
      }
      if (!isDue(m.entry, simMs)) continue;
      if (!m.range) {
        const got = access.rangeOf(scene, twin, m.rep, T);
        if (!got || got.ok !== true) {
          pause(m.entry, retry, simMs, skip(got && got.reason));
          continue;
        }
        m.range = { optimalM: num(got.optimalM), falloffM: num(got.falloffM) };
      }
      if (ts.surfaceDistance(scene, twin, target) > m.range.optimalM + m.range.falloffM) {
        pause(m.entry, retry, simMs, skip("TARGET_OUT_OF_RANGE"));
        continue;
      }
      if (!budget.take(nowMs)) {
        bump("ewar.cycles.deferred");
        continue;
      }
      const result = access.startCycle(scene, twin, m.rep, T, simMs, isAllowed);
      const data = result && result.ok === true && result.data ? result.data : null;
      if (data && data.effectState) {
        m.effectState = data.effectState;
        m.targetId = T;
        m.nextAtSimMs = simMs + num(result.durationMs);
        m.entry.lastReason = null;
        bump(`ewar.start.${kind}`);
        bump(`ewar.cycle.${kind}`);
        energy(kind, data.appliedGJ, data.nosIdle);
      } else {
        applyCycleResult(m.entry, result && result.ok === true ? null : result, simMs, retry);
        skip(result && result.reason);
      }
    }
  }

  function step(rt, ctx = {}) {
    if (!rt) return FREE;
    if (rt.ending === true) {
      releaseAll(rt.ewar || null, ctx.scene || null, "ENDING");
      return FREE;
    }
    const { scene, twin } = ctx;
    if (!scene || !twin) return FREE;
    const simMs = ts.simNow(scene);
    const a = stateOf(rt);
    if (a && !a.disposed) {
      a.twinId = Math.trunc(num(twin.itemID));
      stepModules(rt, a, { scene, twin, host: ctx.host || null, simMs, nowMs: num(ctx.nowMs),
        alive: () => !a.disposed && isTwin(twin) });
    }
    sweepDue(scene, simMs);
    return FREE;
  }

  function suspend(rt, _reason, ctx = {}) {
    releaseAll(rt && rt.ewar ? rt.ewar : null, ctx && ctx.scene ? ctx.scene : null, "SUSPEND");
  }

  function beforeEnd(rt, _reason, ctx = {}) {
    releaseAll(rt && rt.ewar ? rt.ewar : null, ctx && ctx.scene ? ctx.scene : null, "ENDING");
  }

  function dispose(rt, _reason, extra = {}) {
    const a = rt && rt.ewar ? rt.ewar : null;
    if (!a) return;
    releaseAll(a, extra && extra.scene ? extra.scene : null, "DISPOSE");
    a.disposed = true;
  }

  function release(rt, _reason, ctx = {}) {
    releaseAll(rt && rt.ewar ? rt.ewar : null, ctx && ctx.scene ? ctx.scene : null, "STOPPED");
  }

  function view(rt) {
    const a = rt && rt.ewar ? rt.ewar : null;
    if (!a) return null;
    return { ewarOn: a.mods.filter((m) => m.effectState).map((m) => m.rep.kind) };
  }

  function stats() {
    const fromAccess = access && typeof access.stats === "function" ? access.stats() : null;
    return { counters: { ...counters, ...(fromAccess && fromAccess.counters ? fromAccess.counters : {}) } };
  }

  return { name: "ewar", step, suspend, beforeEnd, dispose, release, view, stats };
}

module.exports = { EWAR_STOP, EWAR_COUNTER_NAMES, createEwarSidecar };
