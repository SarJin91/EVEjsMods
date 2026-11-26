"use strict";

const { REFUSAL, TASK_DROP_REASON } = require("./reasons");

const VERB_TASK = Object.freeze({ mine: "MINE", hold: "HOLD", attack: "ATTACK", salvage: "SALVAGE" });
const TASK_ENGINE = Object.freeze({ MINE: "mine", ATTACK: "attack", SALVAGE: "salvage" });
const TASK_VERBS = Object.freeze(Object.keys(VERB_TASK));

const COUNTER_NAMES = Object.freeze([
  "task.error",
  ...TASK_VERBS.map((verb) => `task.order.ok.${verb}`),
  ...REFUSAL.map((reason) => `task.order.refused.${reason}`),
  ...TASK_DROP_REASON.map((reason) => `task.drop.${reason}`),
]);

function emptyHold() {
  return { capacityByFlag: new Map(), items: new Map(), usedM3: 0 };
}

function targetOf(opts) {
  const id = opts && Number(opts.targetId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function createWingTasks(deps = {}) {
  const engines = deps.engines && typeof deps.engines === "object" ? deps.engines : {};
  const sidecars = Array.isArray(deps.sidecars) ? deps.sidecars.filter((s) => s && typeof s === "object") : [];
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const log = deps.log || { debug() {} };
  const config = deps.config && typeof deps.config === "object" ? deps.config : {};
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const tasks = new Map();

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function engineOf(task) {
    const key = TASK_ENGINE[task];
    const engine = key ? engines[key] : null;
    return engine && typeof engine === "object" ? engine : null;
  }

  function guarded(engine, method, args, fallback) {
    if (!engine || typeof engine[method] !== "function") return fallback;
    try {
      return engine[method](...args);
    } catch (err) {
      bump("task.error");
      log.debug(`task engine ${engine.name || "?"}.${method} threw - ${(err && err.message) || err}`);
      return fallback;
    }
  }

  function create(task) {
    return { task, mode: null, targetId: null, sub: null, sinceMs: clock.now(), hold: emptyHold(), claim: 0,
      nextActionAtMs: 0, lastRefusal: null, suspended: false, ran: new Set(), launch: emptyLaunch(), ending: false,
      mirrorEngage: config.commandMirrorEngageCopyDefault === true };
  }

  function emptyLaunch(launch) {
    const map = launch && launch.syntheticToReal;
    const active = launch && launch.active && typeof launch.active === "object" ? launch.active : null;
    return { syntheticToReal: map instanceof Map ? map : new Map(), active };
  }

  function disposeSidecars(rt, reason, shipItemId, scene = null) {
    for (const sidecar of sidecars) {
      guarded(sidecar, "dispose", [rt, reason, { shipItemId, scene: scene || null }], undefined);
    }
  }

  function enginesOf(rt) {
    const out = [];
    const current = engineOf(rt.task);
    if (current) out.push(current);
    for (const key of rt.ran instanceof Set ? rt.ran : []) {
      const engine = engines[key];
      if (engine && typeof engine === "object" && !out.includes(engine)) out.push(engine);
    }
    return out;
  }

  function refuse(reason) {
    bump(`task.order.refused.${reason}`);
    return { ok: false, reason };
  }

  function supports(verb) {
    const task = VERB_TASK[verb];
    if (!task) return false;
    return TASK_ENGINE[task] === undefined || engineOf(task) !== null;
  }

  function start(record, launch = {}) {
    const id = record && record.shipItemId;
    const old = tasks.get(id);
    if (old) {
      guarded(engineOf(old.task), "stop", [old, "RESTARTED", { record, scene: null }], undefined);
      for (const engine of enginesOf(old)) guarded(engine, "dispose", [old, "RESTARTED"], undefined);
      disposeSidecars(old, "RESTARTED", id);
    }
    const rt = create("FOLLOW");
    rt.launch = emptyLaunch(launch);
    tasks.set(id, rt);
    return { ok: true, task: "FOLLOW" };
  }

  function order(record, _runtime, verb, opts = {}) {
    const task = VERB_TASK[verb];
    if (!task) return refuse("UNSUPPORTED_VERB");
    if (!record || !Number.isSafeInteger(record.shipItemId)) return refuse("NOT_DEPLOYED");
    const engine = engineOf(task);
    const id = record.shipItemId;
    let targetId = targetOf(opts);
    if (TASK_ENGINE[task] !== undefined) {
      if (!engine) return refuse("TASK_UNAVAILABLE");
      const can = guarded(engine, "canRun", [opts.twin || null, opts.adapter || null,
        { targetId, scene: opts.scene || null, record, mode: opts.mode || null, rt: tasks.get(id) || null,
          source: opts.source || null }],
      { ok: false, reason: "TASK_UNAVAILABLE" });
      if (!can || can.ok !== true) {
        return refuse(can && REFUSAL.includes(can.reason) ? can.reason : "TASK_UNAVAILABLE");
      }
      if (targetId === null) targetId = targetOf(can);
    }
    let rt = tasks.get(id);
    if (!rt) {
      rt = create("FOLLOW");
      tasks.set(id, rt);
    }
    guarded(engine, "accept", [rt, { targetId, source: opts.source || null, mode: opts.mode || null }], undefined);
    if (rt.task === task && rt.targetId === targetId) {
      bump(`task.order.ok.${verb}`);
      return { ok: true, task };
    }
    if (rt.task !== task) {
      guarded(engineOf(rt.task), "stop", [rt, "ORDER", { record, scene: opts.scene || null }], undefined);
    }
    rt.task = task;
    rt.targetId = targetId;
    rt.sub = null;
    rt.mode = null;
    rt.sinceMs = clock.now();
    rt.lastRefusal = null;
    guarded(engine, "start", [rt, { ...opts, targetId, record }], undefined);
    if (engine && rt.ran instanceof Set) rt.ran.add(TASK_ENGINE[task]);
    bump(`task.order.ok.${verb}`);
    return { ok: true, task };
  }

  function step(record, _runtime, ctx) {
    const rt = record ? tasks.get(record.shipItemId) : undefined;
    if (!rt || rt.suspended === true) return { controlsMovement: false };
    const engine = engineOf(rt.task);
    const stepCtx = { ...ctx, record };
    const out = engine ? guarded(engine, "step", [rt, stepCtx], null) : null;
    let moves = Boolean(out && out.controlsMovement === true);
    for (const sidecar of sidecars) {
      if (tasks.get(record.shipItemId) !== rt) break;
      const side = guarded(sidecar, "step", [rt, stepCtx], undefined);
      if (side && side.controlsMovement === true) moves = true;
    }
    const anchor = out && Number(out.leashAnchorId);
    if (Number.isSafeInteger(anchor) && anchor > 0) return { controlsMovement: moves, leashAnchorId: anchor };
    return { controlsMovement: moves };
  }

  function suspend(shipItemId, reason, ctx = {}) {
    const rt = tasks.get(shipItemId);
    if (!rt || rt.suspended === true) return;
    rt.suspended = true;
    guarded(engineOf(rt.task), "stop", [rt, reason, ctx || {}], undefined);
    for (const sidecar of sidecars) guarded(sidecar, "suspend", [rt, reason, ctx || {}], undefined);
  }

  function beforeEnd(record, runtime, reason) {
    const rt = record ? tasks.get(record.shipItemId) : undefined;
    if (!rt) return;
    rt.ending = true;
    const scene = runtime && runtime.scene ? runtime.scene : null;
    for (const engine of enginesOf(rt)) guarded(engine, "beforeEnd", [rt, reason, { record, scene }], undefined);
    for (const sidecar of sidecars) guarded(sidecar, "beforeEnd", [rt, reason, { record, scene }], undefined);
  }

  function drop(shipItemId, reason, ctx = {}) {
    const rt = tasks.get(shipItemId);
    if (!rt) return;
    tasks.delete(shipItemId);
    if (rt.suspended !== true) guarded(engineOf(rt.task), "stop", [rt, reason, ctx || {}], undefined);
    for (const engine of enginesOf(rt)) guarded(engine, "dispose", [rt, reason], undefined);
    disposeSidecars(rt, reason, shipItemId, ctx && ctx.scene);
    bump(`task.drop.${TASK_DROP_REASON.includes(reason) ? reason : "FORGOTTEN"}`);
  }

  function dropAll(reason) {
    for (const id of [...tasks.keys()]) drop(id, reason);
  }

  function releaseEffects(sceneOf) {
    for (const [id, rt] of tasks) {
      let scene = null;
      try {
        scene = typeof sceneOf === "function" ? sceneOf(id) || null : null;
      } catch (_err) {
        scene = null;
      }
      for (const sidecar of sidecars) guarded(sidecar, "release", [rt, "STOPPED", { scene }], undefined);
    }
  }

  function view(shipItemId) {
    const rt = tasks.get(shipItemId);
    if (!rt) return null;
    let sub = null;
    if ((rt.task === "MINE" || rt.task === "SALVAGE") && typeof rt.sub === "string") sub = rt.sub;
    if (rt.task === "ATTACK" && typeof rt.mode === "string") sub = rt.mode;
    let targetId = rt.targetId;
    let wait = null;
    let weaponless = false;
    const extra = guarded(engineOf(rt.task), "view", [rt], null);
    if (extra && typeof extra === "object") {
      const id = extra.targetId;
      if (id === null || (Number.isSafeInteger(id) && id > 0)) targetId = id;
      wait = typeof extra.wait === "string" ? extra.wait : null;
      weaponless = extra.weaponless === true;
    }
    const out = { task: rt.task, targetId, holdM3: rt.hold.usedM3, sub, wait };
    if (weaponless) out.weaponless = true;
    return out;
  }

  function stats() {
    const all = { ...counters };
    for (const engine of [...Object.values(engines), ...sidecars]) {
      const out = engine && typeof engine.stats === "function" ? guarded(engine, "stats", [], null) : null;
      if (out && out.counters && typeof out.counters === "object") Object.assign(all, out.counters);
    }
    return { tasks: tasks.size, counters: all };
  }

  function activeOf(shipItemId) {
    const rt = tasks.get(shipItemId);
    const plan = rt && rt.launch ? rt.launch.active : null;
    if (!plan || !plan.summary || typeof plan.summary !== "object") return null;
    const out = { ...plan.summary };
    for (const sidecar of sidecars) {
      const extra = typeof sidecar.view === "function" ? guarded(sidecar, "view", [rt], null) : null;
      if (extra && typeof extra === "object") Object.assign(out, extra);
    }
    return out;
  }

  function sidecarViews(shipItemId) {
    const rt = tasks.get(shipItemId);
    if (!rt) return null;
    let out = null;
    for (const sidecar of sidecars) {
      const extra = typeof sidecar.view === "function" ? guarded(sidecar, "view", [rt], null) : null;
      if (extra && typeof extra === "object") out = { ...(out || {}), ...extra };
    }
    return out;
  }

  function setMirrorEngage(shipItemId, on) {
    const rt = tasks.get(shipItemId);
    if (!rt) return { ok: false, reason: "NOT_DEPLOYED" };
    rt.mirrorEngage = on === true;
    return { ok: true, on: rt.mirrorEngage };
  }

  function mirrorEngageOf(shipItemId) {
    const rt = tasks.get(shipItemId);
    return rt ? rt.mirrorEngage === true : null;
  }

  return {
    supports,
    start,
    setMirrorEngage,
    mirrorEngageOf,
    order,
    step,
    suspend,
    beforeEnd,
    drop,
    dropAll,
    releaseEffects,
    view,
    activeOf,
    sidecarViews,
    context: (shipItemId) => tasks.get(shipItemId) || null,
    size: () => tasks.size,
    stats,
  };
}

module.exports = { VERB_TASK, TASK_VERBS, COUNTER_NAMES, createWingTasks };
