// Structure adapted from X-Eve xEveRuntime.runDueWork (pass guard, refusal on unhealthy persistence, policy per pass, budget checked before each job; see CREDITS.md).

"use strict";

const { fallbackPolicy, WORK_CLASS_ORDER, MODE, MODE_LEVEL } = require("../telemetry/loadGovernor");
const { createWorkBudget } = require("./workBudget");
const { ALL_PRIORITIES } = require("./dueIndex");
const { priorityOfWorkClass, getEventType } = require("./eventTypes");
const { STATE } = require("./schema");
const { createSlowOpLog } = require("../telemetry/slowOps");

const STORE_REASONS = Object.freeze(["STORE_SUSPENDED", "STORE_CLOSED"]);
const STORE_STATE_REASON = Object.freeze({ suspended: "STORE_SUSPENDED", closed: "STORE_CLOSED" });
const MAX_QUARANTINE_LOG_LINES = 3;
const MAX_TYPES_IN_SLOW_LINE = 5;
const RELEASE_GONE = Object.freeze(["EVENT_STATE_INVALID", "EVENT_NOT_FOUND"]);
const LATENESS_METRIC = Object.freeze(Object.fromEntries(WORK_CLASS_ORDER
  .map((wc) => [wc, `scheduler.lateness.${wc.toLowerCase()}`])));
const STOPPED_BY_METRIC = Object.freeze({ time: "scheduler.stoppedBy.time", items: "scheduler.stoppedBy.items",
  write: "scheduler.stoppedBy.write" });

function messageOf(err) {
  return String((err && err.message) || err);
}

function noop() {}

function isThenable(value) {
  return Boolean(value && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function");
}

function typesOf(typeStats) {
  if (typeStats.size === 0) return "-";
  const rows = [...typeStats].sort((a, b) => b[1].maxMs - a[1].maxMs);
  const shown = rows.slice(0, MAX_TYPES_IN_SLOW_LINE)
    .map(([type, s]) => `${type}:${s.n}/${(Math.round(s.maxMs * 10) / 10).toFixed(1)}`);
  return `${shown.join(",")}${rows.length > MAX_TYPES_IN_SLOW_LINE ? `,+${rows.length - MAX_TYPES_IN_SLOW_LINE}` : ""}`;
}

function isStoreReason(reason) {
  return STORE_REASONS.includes(reason);
}

function validPolicy(policy) {
  return Boolean(policy && typeof policy === "object" && policy.classes && typeof policy.classes === "object"
    && typeof policy.budgetMs === "number" && typeof policy.maxJobs === "number");
}

function createPassRunner(deps) {
  const { queue, handlers, store, clock, nowMs, getGovernor, limits, settings, metrics, logger } = deps;
  const isActive = deps.isActive;
  const onSuspend = deps.onSuspend;
  const normalBudget = { budgetMs: limits.maxSchedulerWorkMs, maxJobs: limits.maxDueEventsPerPass };
  const pendingRelease = [];
  const loggedErrors = new Set();
  let passRunning = false;
  let lastEmergency = null;
  let episode = null;
  let lastEpisode = null;
  let episodes = 0;
  const adaptive = settings.adaptiveClaimBatch === true;
  const costAlpha = adaptive ? settings.costEwmaAlpha : 0;
  let costEwmaMs = adaptive ? settings.costEwmaInitialMs : 0;
  const slowLog = createSlowOpLog({ slowOpMs: settings.slowOpMs, perMin: settings.slowOpLogPerMin, nowMs, logger });
  const noteOp = metrics && typeof metrics.noteOp === "function" ? metrics.noteOp : noop;
  const pacer = deps.pacer && typeof deps.pacer.allowance === "function" ? deps.pacer : null;
  let pacingActive = false;
  const reescalationWindowMs = Number.isFinite(settings.reescalationWindowMs) ? settings.reescalationWindowMs : null;
  let lastBaseLevel = null;
  let lastCatchUpStart = null;
  const latenessByType = settings.latenessDetail === true ? new Map() : null;
  const latenessSlowMs = settings.latenessSlowMs;
  const latenessTopTypes = settings.latenessTopTypes;

  function noteLateness(type, lateMs) {
    if (latenessByType === null || type === null) return;
    metrics.observe(LATENESS_METRIC[type.workClass], lateMs);
    const over = lateMs >= latenessSlowMs ? 1 : 0;
    const row = latenessByType.get(type.eventType);
    if (row === undefined) {
      latenessByType.set(type.eventType, { n: 1, sumMs: lateMs, maxMs: lateMs, over });
      return;
    }
    row.n += 1;
    row.sumMs += lateMs;
    if (lateMs > row.maxMs) row.maxMs = lateMs;
    row.over += over;
  }

  function nextBatch(jobs, maxJobs, remainingMs) {
    const base = Math.min(settings.claimBatchSize, maxJobs - jobs);
    if (!adaptive || !(costEwmaMs > 0)) return base;
    return Math.min(base, Math.max(1, Math.floor(Math.max(0, remainingMs) / costEwmaMs)));
  }

  function governor() {
    try {
      const gov = typeof getGovernor === "function" ? getGovernor() : null;
      return gov && typeof gov.evaluate === "function" ? gov : null;
    } catch (_err) {
      return null;
    }
  }

  function govStatus(gov) {
    try {
      const st = gov && typeof gov.getStatus === "function" ? gov.getStatus() : null;
      return st && typeof st === "object" ? st : null;
    } catch (_err) {
      return null;
    }
  }

  function emergencyCount(gov) {
    const st = govStatus(gov);
    const n = st && st.counts ? st.counts.emergencySamples : null;
    return Number.isFinite(n) ? n : null;
  }

  function noteBaseLevel(st, now) {
    const level = st !== null && Object.prototype.hasOwnProperty.call(MODE_LEVEL, st.baseMode)
      ? MODE_LEVEL[st.baseMode] : null;
    if (level === null) return;
    const before = lastBaseLevel;
    lastBaseLevel = level;
    if (before === null || level <= before || reescalationWindowMs === null || lastCatchUpStart === null) return;
    if (lastCatchUpStart.counted || now - lastCatchUpStart.startedAt > reescalationWindowMs) return;
    lastCatchUpStart.counted = true;
    metrics.count("scheduler.catchUpReescalations");
  }

  function baseline() {
    lastEmergency = emergencyCount(governor());
  }

  function policyOf(gov) {
    if (!gov) return fallbackPolicy("governor_unavailable", normalBudget);
    try {
      const policy = gov.evaluate();
      return validPolicy(policy) ? policy : fallbackPolicy("governor_failed", normalBudget);
    } catch (_err) {
      return fallbackPolicy("governor_failed", normalBudget);
    }
  }

  function spikesSinceLastPass(gov) {
    const n = emergencyCount(gov);
    if (n === null) return 0;
    const before = lastEmergency;
    lastEmergency = n;
    if (before === null || n < before) return 0;
    return n - before;
  }

  function logOnce(reason, line) {
    if (loggedErrors.has(reason)) return;
    loggedErrors.add(reason);
    logger.log(line);
  }

  function publishGauges(now) {
    const cap = settings.backlogCountCap;
    metrics.gauge("scheduler.parked", queue.parkedCount());
    if (latenessByType !== null) {
      const oldestDue = queue.nextDueAt(ALL_PRIORITIES);
      metrics.gauge("scheduler.oldestDueAgeMs", oldestDue === null ? 0 : Math.max(0, now - oldestDue));
    }
    if (cap < 1) return;
    metrics.gauge("scheduler.dueBacklog", queue.countDue(now, cap).count);
    metrics.gauge("scheduler.catchUpBacklog", queue.countDue(Math.max(0, now - settings.catchUpLagMs), cap).count);
  }

  function skip(reason, mode) {
    metrics.count("scheduler.passSkipped");
    queue.bump();
    return { ok: true, skipped: true, reason, mode };
  }

  async function runPass() {
    if (passRunning) return { ok: false, reason: "PASS_RUNNING" };
    passRunning = true;
    try {
      return await runPassInner();
    } catch (err) {
      metrics.count("scheduler.passErrors");
      logOnce("PASS_THREW", `scheduler: pass failed - ${messageOf(err)}`);
      return { ok: false, reason: "PASS_THREW", detail: messageOf(err) };
    } finally {
      passRunning = false;
    }
  }

  async function runPassInner() {
    if (!queue.isReady()) return { ok: false, reason: "SCHEDULER_STOPPED" };
    const storeState = typeof store.getState === "function" ? store.getState() : "open";
    if (STORE_STATE_REASON[storeState]) {
      const reason = STORE_STATE_REASON[storeState];
      const detail = typeof store.getStateReason === "function" ? store.getStateReason() : undefined;
      onSuspend(reason, detail || undefined);
      return { ok: false, reason, ...(detail ? { detail: String(detail) } : {}) };
    }

    const ctx = { suspended: null, retried: 0, quarantined: 0, done: 0, writeMs: 0, logLines: 0, released: 0 };

    const timed = (fn) => {
      const at = nowMs();
      try {
        return fn();
      } finally {
        ctx.writeMs += nowMs() - at;
      }
    };

    const suspend = (reason, detail) => {
      if (ctx.suspended) return;
      ctx.suspended = { reason, detail };
      onSuspend(reason, detail);
    };

    function release(eventId, error, permanent, eventType, deferUntil) {
      const opts = Number.isSafeInteger(deferUntil) ? { permanent: false, deferUntil } : { permanent };
      const r = timed(() => queue.retryOrQuarantine(eventId, error, opts));
      if (r && r.ok) {
        if (r.state === STATE.RETRY) ctx.retried += 1;
        else {
          ctx.quarantined += 1;
          if (ctx.logLines < MAX_QUARANTINE_LOG_LINES) {
            ctx.logLines += 1;
            logger.log(`scheduler: quarantined ${eventId} ${eventType || r.eventType || "?"} ${r.lastError}`);
          }
        }
        return true;
      }
      const reason = (r && r.reason) || "RELEASE_FAILED";
      if (isStoreReason(reason)) suspend(reason, r.detail);
      return reason;
    }

    const keepPending = (item) => {
      if (pendingRelease.length < limits.maxDueEventsPerPass) pendingRelease.push(item);
      else metrics.count("scheduler.releaseDropped");
    };

    if (pendingRelease.length > 0) {
      const waiting = pendingRelease.splice(0, pendingRelease.length);
      for (const item of waiting) {
        if (ctx.suspended) {
          pendingRelease.push(item);
          continue;
        }
        const r = release(item.eventId, item.error, item.permanent, item.eventType, item.deferUntil);
        if (r === true) ctx.released += 1;
        else if (RELEASE_GONE.includes(r)) queue.forget(item.eventId);
        else keepPending(item);
      }
      if (ctx.suspended) return { ok: false, reason: ctx.suspended.reason, detail: ctx.suspended.detail };
    }

    const gov = governor();
    const policy = policyOf(gov);
    const spikes = spikesSinceLastPass(gov);
    let now = clock.now();
    if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: "PASS_THREW", detail: "clock.now" };
    publishGauges(now);
    const st = govStatus(gov);
    noteBaseLevel(st, now);
    const grant = pacer !== null && st !== null && st.tickAvailable === true ? pacer.beginPass() : null;
    pacingActive = grant !== null;
    if (policy.mode === MODE.SHED) return skip("SHED", policy.mode);
    if (spikes > 0) return skip("emergency_since_last_pass", policy.mode);
    if (!(policy.budgetMs > 0) || !(policy.maxJobs >= 1)) return skip("no_budget", policy.mode);
    const workClasses = WORK_CLASS_ORDER.filter((wc) => policy.classes[wc] && policy.classes[wc].admitted === true);
    if (workClasses.length === 0) return skip("no_admitted_class", policy.mode);

    const priorities = workClasses.map(priorityOfWorkClass).filter((p) => ALL_PRIORITIES.includes(p));
    const oldest = queue.nextDueAt(priorities);
    const catchUp = oldest !== null && now - oldest >= settings.catchUpLagMs;
    const maxJobs = Math.floor(catchUp ? Math.min(policy.maxJobs, limits.maxCatchUpEventsPerPass) : policy.maxJobs);

    if (catchUp && episode === null) {
      episodes += 1;
      const backlog = settings.backlogCountCap < 1 ? 0
        : queue.countDue(Math.max(0, now - settings.catchUpLagMs), settings.backlogCountCap).count;
      episode = { startedAt: now, lagMs: now - oldest, backlog, passes: 0, events: 0, maxPerPass: 0 };
      lastCatchUpStart = { startedAt: now, counted: false };
      metrics.count("scheduler.catchUpEpisodes");
      metrics.gauge("scheduler.catchUpActive", 1);
      logger.log(`scheduler: catch-up start lag=${episode.lagMs} backlog=${backlog}`);
    }

    function dispatch(ev) {
      const handler = handlers.get(ev.eventType);
      taken.set(ev.eventType, (taken.get(ev.eventType) || 0) + 1);
      const lateMs = Math.max(0, now - ev.dueAt);
      metrics.observe("scheduler.lateness", lateMs);
      const type = getEventType(ev.eventType);
      noteLateness(type, lateMs);
      if (!handler) return unclaim(ev);
      const coalesced = Boolean(type && type.periodic === true && lateMs >= settings.catchUpLagMs);
      if (coalesced) metrics.count("scheduler.periodicCoalesced");
      const anchorAt = coalesced ? now : ev.dueAt;
      let res;
      try {
        res = handler(ev, { now, lateMs, catchUp, anchorAt });
      } catch (err) {
        metrics.count("scheduler.handlerErrors");
        return fail(ev, err, false);
      }
      if (isThenable(res)) {
        res.then(noop, noop);
        metrics.count("scheduler.handlerErrors");
        return fail(ev, "HANDLER_ASYNC", false);
      }
      if (!res || typeof res !== "object") {
        metrics.count("scheduler.handlerErrors");
        return fail(ev, "HANDLER_INVALID_RESULT", false);
      }
      if (res.ok !== true) {
        const why = res.reason || "HANDLER_REFUSED";
        if (Number.isSafeInteger(res.deferUntil)) return fail(ev, why, false, res.deferUntil);
        return fail(ev, why, res.permanent === true);
      }
      const effect = typeof res.effect === "function" ? res.effect : null;
      const next = res.reschedule && typeof res.reschedule === "object" ? res.reschedule : null;
      let effectValue;
      const effectFn = (effect || next) ? (tx, event) => {
        if (effect) {
          const v = effect(tx, event);
          if (isThenable(v)) {
            v.then(noop, noop);
            return { ok: false, reason: "EFFECT_ASYNC" };
          }
          if (v && typeof v === "object" && v.ok === false) return v;
          effectValue = v;
        }
        if (next) {
          const r = queue.enqueue(next.eventType || event.eventType,
            next.aggregateId !== undefined ? next.aggregateId : event.aggregateId, next.dueAt,
            next.payload !== undefined ? next.payload : {}, next.idempotencyKey, { tx, chained: true });
          if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "RESCHEDULE_FAILED" };
        }
        return { ok: true };
      } : undefined;
      const c = timed(() => queue.complete(ev.eventId, typeof res.outcome === "string" ? res.outcome : "OK",
        effectFn));
      if (c && c.ok) {
        ctx.done += 1;
        if (typeof res.onCommitted === "function" && c.alreadyDone !== true) {
          try {
            res.onCommitted(effectValue);
          } catch (_err) {
            metrics.count("scheduler.onCommittedErrors");
          }
        }
        return true;
      }
      const reason = (c && c.reason) || "COMPLETE_FAILED";
      if (isStoreReason(reason)) {
        suspend(reason, c.detail);
        return reason;
      }
      if (reason === "EFFECT_FAILED") return fail(ev, c.error, false);
      if (reason === "EFFECT_REFUSED") {
        return fail(ev, (c.refusal && c.refusal.reason) || "EFFECT_REFUSED",
          Boolean(c.refusal && c.refusal.permanent === true));
      }
      return fail(ev, c.detail ? `${reason}: ${c.detail}` : reason, false);
    }

    function unclaim(ev) {
      const r = typeof queue.unclaim === "function" ? timed(() => queue.unclaim(ev)) : null;
      if (r && r.ok) return true;
      const reason = (r && r.reason) || "UNCLAIM_FAILED";
      if (isStoreReason(reason)) {
        suspend(reason, r.detail);
        return reason;
      }
      if (RELEASE_GONE.includes(reason)) {
        queue.forget(ev.eventId);
        return reason;
      }
      return fail(ev, "NO_HANDLER", false);
    }

    function fail(ev, error, permanent, deferUntil) {
      const r = release(ev.eventId, error, permanent, ev.eventType, deferUntil);
      if (r === true || isStoreReason(r)) return r;
      if (RELEASE_GONE.includes(r)) queue.forget(ev.eventId);
      else keepPending({ eventId: ev.eventId, error, permanent, eventType: ev.eventType, deferUntil });
      return r;
    }

    const taken = new Map();
    const typeStats = new Map();
    const remainingOf = (type) => {
      const quota = typeof handlers.quotaOf === "function" ? handlers.quotaOf(type) : null;
      const base = quota === null ? Infinity : quota;
      const used = taken.get(type) || 0;
      if (grant === null || base - used <= 0) return base - used;
      return Math.min(base, pacer.allowance(type, nowMs(), grant)) - used;
    };

    const budget = createWorkBudget({ budgetMs: settings.sliceMs });
    let workMs = 0;
    let segmentAt = nowMs();
    const work = () => workMs + (nowMs() - segmentAt);
    let jobs = 0;
    let yields = 0;
    let stoppedBy = "empty";
    for (;;) {
      const batchAt = nowMs();
      const batch = nextBatch(jobs, maxJobs, Math.min(policy.budgetMs - work(),
        store.limits.maxWriteMsPerPass - ctx.writeMs));
      const claimed = timed(() => queue.claimDue(now, batch, Math.max(0, policy.budgetMs - work()),
        { workClasses, onlyHandled: true, remainingOf }));
      if (!claimed || !claimed.ok) {
        const reason = (claimed && claimed.reason) || "CLAIM_FAILED";
        if (isStoreReason(reason)) {
          suspend(reason, claimed.detail);
          stoppedBy = "suspended";
        } else {
          stoppedBy = "error";
          logOnce(`claim:${reason}`, `scheduler: claim failed - ${reason}`);
        }
        break;
      }
      let stoppedMidBatch = false;
      for (const ev of claimed.events) {
        if (!queue.isReady()) {
          stoppedMidBatch = true;
          break;
        }
        jobs += 1;
        const dispatchAt = nowMs();
        dispatch(ev);
        const dispatchMs = nowMs() - dispatchAt;
        noteOp("sched", ev.eventType, dispatchAt, dispatchMs);
        if (pacer !== null) pacer.observe(ev.eventType, dispatchMs);
        if (grant !== null) {
          if (grant.heavyType === ev.eventType) metrics.count("scheduler.heavyDispatched");
          else if (grant.unmeasured.has(ev.eventType)) metrics.count("scheduler.heavyUnmeasured");
          pacer.noteDispatch(ev.eventType, dispatchAt, grant);
        }
        const stat = typeStats.get(ev.eventType);
        if (stat === undefined) typeStats.set(ev.eventType, { n: 1, maxMs: dispatchMs });
        else {
          stat.n += 1;
          if (dispatchMs > stat.maxMs) stat.maxMs = dispatchMs;
        }
        if (ctx.suspended) break;
      }
      if (ctx.suspended) {
        stoppedBy = "suspended";
        break;
      }
      if (stoppedMidBatch) {
        stoppedBy = "stopped";
        break;
      }
      if (adaptive && claimed.events.length > 0) {
        const perEvent = Math.max(0, nowMs() - batchAt) / claimed.events.length;
        costEwmaMs = costAlpha * perEvent + (1 - costAlpha) * costEwmaMs;
      }
      if (claimed.events.length === 0 && claimed.stoppedBy !== "items") {
        stoppedBy = claimed.stoppedBy === "time" ? "time" : "empty";
        break;
      }
      if (jobs >= maxJobs) {
        stoppedBy = "items";
        break;
      }
      if (work() >= policy.budgetMs) {
        stoppedBy = "time";
        break;
      }
      if (ctx.writeMs >= store.limits.maxWriteMsPerPass) {
        stoppedBy = "write";
        break;
      }
      if (claimed.stoppedBy === "time") {
        stoppedBy = "time";
        break;
      }
      if (claimed.stoppedBy === "empty") {
        stoppedBy = "empty";
        break;
      }
      workMs = work();
      if (await budget.checkpoint()) yields += 1;
      segmentAt = nowMs();
      if (!isActive() || !queue.isReady()) {
        stoppedBy = "stopped";
        break;
      }
      now = clock.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        stoppedBy = "error";
        break;
      }
    }
    workMs = work();
    budget.finish();

    metrics.count("scheduler.passes");
    if (catchUp) metrics.count("scheduler.catchUpPasses");
    if (stoppedBy === "time" || stoppedBy === "items" || stoppedBy === "write") {
      metrics.count("scheduler.budgetExhausted");
      if (latenessByType !== null) metrics.count(STOPPED_BY_METRIC[stoppedBy]);
    }
    if (yields > 0) metrics.count("scheduler.passYields", yields);
    metrics.observe("scheduler.passMs", workMs);
    if (slowLog.isSlow(workMs)) {
      metrics.count("scheduler.slowPasses");
      slowLog.log(`scheduler: slow pass ${Math.round(workMs * 100) / 100}ms jobs=${jobs} catchUp=${catchUp ? 1 : 0}`
        + ` types=${typesOf(typeStats)}`);
    }
    if (episode !== null) {
      if (catchUp) {
        episode.passes += 1;
        episode.events += jobs;
        if (jobs > episode.maxPerPass) episode.maxPerPass = jobs;
      } else {
        const ended = Object.freeze({ passes: episode.passes, events: episode.events, maxPerPass: episode.maxPerPass,
          lagMs: episode.lagMs, backlog: episode.backlog, startedAt: episode.startedAt, endedAt: now });
        episode = null;
        lastEpisode = ended;
        metrics.gauge("scheduler.catchUpActive", 0);
        logger.log(`scheduler: catch-up done passes=${ended.passes} events=${ended.events}`
          + ` maxPerPass=${ended.maxPerPass} in ${ended.endedAt - ended.startedAt}ms`);
      }
    }
    if (queue.isReady()) publishGauges(now);
    if (grant !== null) {
      metrics.gauge("scheduler.heavyTokens", pacer.tokens(nowMs()));
      metrics.gauge("scheduler.heavyTypes", pacer.heavyCount());
    }
    queue.bump();
    return { ok: true, skipped: false, mode: policy.mode, phase: policy.phase, catchUp, jobs, done: ctx.done,
      retried: ctx.retried, quarantined: ctx.quarantined, parkedNew: queue.takeParkedNew(), released: ctx.released,
      stoppedBy, workMs, writeMs: ctx.writeMs, yields };
  }

  function closeEpisode() {
    if (episode === null) return;
    episode = null;
    metrics.gauge("scheduler.catchUpActive", 0);
  }

  function getCostEwmaMs() {
    return adaptive ? costEwmaMs : null;
  }

  function getCatchUp() {
    return Object.freeze({ active: episode !== null, episodes, lastEpisode,
      current: episode === null ? null : Object.freeze({ ...episode }) });
  }

  function getPacing() {
    if (pacer === null) return null;
    return Object.freeze({ ...pacer.getStatus(nowMs()), active: pacingActive });
  }

  function getLatenessByType() {
    if (latenessByType === null) return null;
    const rows = [...latenessByType].sort((a, b) => b[1].maxMs - a[1].maxMs || b[1].n - a[1].n
      || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const types = rows.slice(0, latenessTopTypes).map(([type, s]) => Object.freeze({ type, n: s.n,
      avgMs: Math.round(s.sumMs / s.n), maxMs: s.maxMs, over: s.over }));
    return Object.freeze({ types: Object.freeze(types), more: rows.length - types.length });
  }

  return Object.freeze({ runPass, baseline, getCatchUp, closeEpisode, getCostEwmaMs, getPacing, getLatenessByType });
}

module.exports = { createPassRunner, MAX_QUARANTINE_LOG_LINES };
