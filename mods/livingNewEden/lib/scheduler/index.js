"use strict";

const { performance } = require("node:perf_hooks");
const { isModuleEnabled } = require("../../config");
const { WORK_CLASS } = require("../telemetry/loadGovernor");
const { createDueIndex, ALL_PRIORITIES } = require("./dueIndex");
const { createEventStore } = require("./eventStore");
const { priorityOfWorkClass, getEventType } = require("./eventTypes");
const { createHeavyPacer } = require("./heavyPacer");
const { STATE } = require("./schema");
const { buildSchedulerView } = require("./schedulerView");
const { createHandlerRegistry } = require("./handlers");
const { createAbortSentinel } = require("../persistence/store");
const { createPassRunner } = require("./pass");
const { createDriver } = require("./driver");

const STATE_READY = "ready";
const STATE_STOPPED = "stopped";
const STATE_UNAVAILABLE = "unavailable";
const REFUSAL_FIELDS = Object.freeze(["code", "detail", "rows", "limit"]);
const DEFER_MIN_MS = 1;
const QUEUE_FULL_MIN_PRIORITY = priorityOfWorkClass(WORK_CLASS.OPERATIONAL);
const SETTING_KEYS = Object.freeze(["maxAttempts", "retryBaseMs", "retryMaxMs", "maxOpenEvents", "maxPayloadBytes",
  "intervalMs", "claimBatchSize", "catchUpLagMs"]);
const SETTING_KEYS_ZERO_OK = Object.freeze(["backlogCountCap", "chainedHeadroom"]);
const SETTING_KEYS_NUMBER = Object.freeze(["sliceMs"]);
const LIMIT_KEYS_INTEGER = Object.freeze(["maxDueEventsPerPass", "maxCatchUpEventsPerPass"]);
const LIMIT_KEYS_NUMBER = Object.freeze(["maxSchedulerWorkMs"]);
const HEAVY_PACING_KEYS = Object.freeze([["heavyEventMs", 1, 1000, false], ["heavyPerWindow", 1, 64, true],
  ["heavyWindowMs", 1000, 600000, true], ["costEwmaAlpha", 0.01, 1, false],
  ["heavySampleCapFactor", 1, 100, false], ["heavyMinSamples", 1, 16, true]]);
const LATENESS_DETAIL_KEYS = Object.freeze([["latenessSlowMs", 1000, 600000], ["latenessTopTypes", 1, 100]]);
const EFFECT_ABORT = createAbortSentinel("scheduler-effect-abort");

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err);
}

function unwrap(result) {
  if (result && result.ok) return result.value;
  const out = { ok: false, reason: (result && result.reason) || "TX_FAILED" };
  for (const field of REFUSAL_FIELDS) {
    if (result && result[field] !== undefined && result[field] !== null) out[field] = result[field];
  }
  return out;
}

function createUnavailableScheduler(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const refuse = () => refusal;
  return Object.freeze({
    enqueue: refuse,
    enqueueMany: refuse,
    claimDue: refuse,
    complete: refuse,
    registerHandler: refuse,
    runPass: () => Promise.resolve(refusal),
    startPasses: refuse,
    retryOrQuarantine: refuse,
    findByKey: refuse,
    findLiveOfType: refuse,
    purgeDone: refuse,
    scanKeys: refuse,
    statesOf: refuse,
    getStatus: () => Object.freeze({ state: STATE_UNAVAILABLE, reason: refusal.reason }),
    stop: noop,
  });
}

function telemetryOf(telemetry) {
  const call = (kind, name, value) => {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  };
  return {
    count: (name, n = 1) => call("count", name, n),
    gauge: (name, value) => call("gauge", name, value),
    observe: (name, value) => call("observe", name, value),
    noteOp: (kind, label, startMs, ms) => {
      if (!telemetry || typeof telemetry.noteOp !== "function") return;
      try {
        telemetry.noteOp(kind, label, startMs, ms);
      } catch (_err) {
      }
    },
  };
}

function startScheduler(deps) {
  try {
    const { config, persistence, clock, ids } = deps || {};
    if (!isModuleEnabled(config, "scheduler")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    const settings = config.scheduler || {};
    for (const key of SETTING_KEYS) {
      if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) {
        return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `scheduler.${key}` };
      }
    }
    for (const key of SETTING_KEYS_ZERO_OK) {
      if (!Number.isSafeInteger(settings[key]) || settings[key] < 0) {
        return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `scheduler.${key}` };
      }
    }
    for (const key of SETTING_KEYS_NUMBER) {
      if (typeof settings[key] !== "number" || !Number.isFinite(settings[key]) || settings[key] <= 0) {
        return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `scheduler.${key}` };
      }
    }
    if (settings.adaptiveClaimBatch === true) {
      for (const key of ["costEwmaInitialMs", "costEwmaAlpha"]) {
        const v = settings[key];
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (key === "costEwmaAlpha" && v > 1)) {
          return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `scheduler.${key}` };
        }
      }
    }
    if (settings.heavyPacing === true) {
      for (const [key, min, max, integer] of HEAVY_PACING_KEYS) {
        const v = settings[key];
        if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max
            || (integer && !Number.isSafeInteger(v))) {
          return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `scheduler.${key}` };
        }
      }
    }
    if (settings.reescalationWindowMs !== undefined
        && (!Number.isSafeInteger(settings.reescalationWindowMs) || settings.reescalationWindowMs < 1)) {
      return { ok: false, reason: "SCHEDULER_START_FAILED", detail: "scheduler.reescalationWindowMs" };
    }
    if (settings.latenessDetail === true) {
      for (const [key, min, max] of LATENESS_DETAIL_KEYS) {
        const v = settings[key];
        if (!Number.isSafeInteger(v) || v < min || v > max) {
          return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `scheduler.${key}` };
        }
      }
    }
    const limits = config.limits || {};
    for (const key of LIMIT_KEYS_INTEGER) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
        return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `limits.${key}` };
      }
    }
    for (const key of LIMIT_KEYS_NUMBER) {
      if (typeof limits[key] !== "number" || !Number.isFinite(limits[key]) || limits[key] <= 0) {
        return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `limits.${key}` };
      }
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
    const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
    const metrics = telemetryOf(deps.telemetry || null);
    const store = persistence.store;
    const labelOn = Boolean(store) && typeof store.labelTx === "function";
    const eventStore = createEventStore({ clock, ids,
      limits: { maxPayloadBytes: settings.maxPayloadBytes, maxAttempts: settings.maxAttempts,
        retryBaseMs: settings.retryBaseMs, retryMaxMs: settings.retryMaxMs },
      onCount: (name, _n, detail) => {
        metrics.count(name);
        if (name === "scheduler.conflicts") noteConflict(detail);
      } });
    const conflictLogLimit = Number.isSafeInteger(settings.conflictLogLimit) && settings.conflictLogLimit > 0
      ? settings.conflictLogLimit : 0;
    let conflictsLogged = 0;
    function noteConflict(d) {
      if (conflictsLogged >= conflictLogLimit || !d || typeof d !== "object") return;
      conflictsLogged += 1;
      try {
        const text = (v) => (v === undefined || v === null ? "-" : String(v));
        const during = activeComplete !== null ? activeComplete.eventId : null;
        const duringType = during !== null && inFlight.has(during) ? inFlight.get(during).eventType : null;
        logger.log(`scheduler: idempotency conflict key=${text(d.key)} eventType=${text(d.eventType)} `
          + `aggregate=${text(d.aggregateId)} existing=${text(d.existingEventId)} ${text(d.existingEventType)} `
          + `${text(d.existingAggregateId)} ${text(d.existingState)} during=${text(during)} ${text(duringType)} `
          + `(${conflictsLogged}/${conflictLogLimit})`);
      } catch (_err) {
      }
    }
    const dueIndex = createDueIndex();
    const inFlight = new Map();
    const parked = new Map();
    let parkedTotal = 0;
    let parkedNew = 0;
    const handlers = createHandlerRegistry();
    const run = (op, fn) => unwrap(store.transaction(`scheduler.${op}`, fn));
    const maxRows = store.limits.maxRowsPerTransaction;

    const recovered = { retried: 0, quarantined: 0 };
    for (;;) {
      const slice = run("recover", (tx) => eventStore.recoverClaimed(tx, maxRows, clock.now()));
      if (!slice.ok) return { ok: false, reason: "SCHEDULER_RECOVERY_FAILED", detail: slice.reason };
      recovered.retried += slice.retried;
      recovered.quarantined += slice.quarantined;
      if (slice.retried + slice.quarantined < maxRows) break;
    }
    const rebuildAt = nowMs();
    const loaded = run("load", (tx) => eventStore.loadOpen(tx, (id, priority, dueAt, eventType) => dueIndex.add(id,
      priority, dueAt, eventType)));
    if (!loaded.ok) return { ok: false, reason: "SCHEDULER_START_FAILED", detail: `load: ${loaded.reason}` };
    const rebuildMs = nowMs() - rebuildAt;
    if (recovered.retried + recovered.quarantined > 0) {
      metrics.count("scheduler.recoveredClaims", recovered.retried + recovered.quarantined);
    }
    if (recovered.quarantined > 0) metrics.count("scheduler.quarantined", recovered.quarantined);
    metrics.gauge("scheduler.rebuildMs", rebuildMs);

    let state = STATE_READY;
    let seq = 0;
    let activeComplete = null;
    let driver = null;
    let passRunner = null;

    const openCount = () => dueIndex.size() + parkedTotal;

    function publish() {
      seq += 1;
      metrics.gauge("scheduler.open", openCount());
      metrics.gauge("scheduler.inFlight", inFlight.size);
    }

    const stopped = () => (state === STATE_READY ? null : { ok: false, reason: "SCHEDULER_STOPPED" });

    function admit(type) {
      if (type.priority < QUEUE_FULL_MIN_PRIORITY) return null;
      if (openCount() + inFlight.size < settings.maxOpenEvents) return null;
      metrics.count("scheduler.queueFull");
      return { ok: false, reason: "QUEUE_FULL", limit: settings.maxOpenEvents };
    }

    function admitChained(type) {
      if (type.priority < QUEUE_FULL_MIN_PRIORITY) return null;
      const open = openCount() + inFlight.size + activeComplete.pending.length;
      if (open < settings.maxOpenEvents) return null;
      const ceiling = settings.maxOpenEvents + settings.chainedHeadroom;
      if (open < ceiling) {
        metrics.count("scheduler.chainedOverLimit");
        return null;
      }
      metrics.count("scheduler.queueFull");
      return { ok: false, reason: "QUEUE_FULL", limit: ceiling, chained: true };
    }

    function accept(event) {
      dueIndex.add(event.eventId, event.priority, event.dueAt, event.eventType);
      metrics.count("scheduler.enqueued");
    }

    function enqueue(eventType, aggregateId, dueAt, payload, idempotencyKey, opts) {
      const refusal = stopped();
      if (refusal) return refusal;
      const spec = { eventType, aggregateId, dueAt, payload, idempotencyKey };
      const outer = opts && opts.tx;
      if (outer) {
        const chained = opts.chained === true && activeComplete !== null && activeComplete.tx === outer;
        const r = eventStore.insert(outer, spec, { admit: chained ? admitChained : admit });
        if (r.ok && !r.duplicate) {
          if (activeComplete && activeComplete.tx === outer) activeComplete.pending.push(r.event);
          else {
            accept(r.event);
            publish();
          }
        }
        return r;
      }
      const r = run("enqueue", (tx) => eventStore.insert(tx, spec, { admit }));
      if (r.ok && !r.duplicate) {
        accept(r.event);
        publish();
      }
      return r;
    }

    function enqueueMany(specs) {
      const refusal = stopped();
      if (refusal) return refusal;
      if (!Array.isArray(specs) || specs.length > maxRows) {
        return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail: "specs" };
      }
      const fresh = [];
      const r = run("enqueueMany", (tx) => {
        let duplicates = 0;
        for (const spec of specs) {
          const one = eventStore.insert(tx, { eventType: spec.eventType, aggregateId: spec.aggregateId,
            dueAt: spec.dueAt, payload: spec.payload, idempotencyKey: spec.idempotencyKey }, { admit });
          if (!one.ok) return { ok: true, duplicates, refusal: one };
          if (one.duplicate) duplicates += 1;
          else fresh.push(one.event);
        }
        return { ok: true, duplicates, refusal: null };
      });
      if (!r.ok) return r;
      for (const event of fresh) accept(event);
      if (fresh.length > 0) publish();
      return { ok: true, enqueued: fresh.length, duplicates: r.duplicates, refusal: r.refusal };
    }

    function claimDue(now, itemBudget, timeBudgetMs, opts) {
      const refusal = stopped();
      if (refusal) return refusal;
      if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail: "now" };
      if (!Number.isSafeInteger(itemBudget) || itemBudget < 1) {
        return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail: "itemBudget" };
      }
      if (typeof timeBudgetMs !== "number" || !Number.isFinite(timeBudgetMs) || timeBudgetMs < 0) {
        return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail: "timeBudgetMs" };
      }
      let priorities = ALL_PRIORITIES;
      if (opts && opts.workClasses !== undefined) {
        if (!Array.isArray(opts.workClasses)) {
          return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail: "workClasses" };
        }
        priorities = [];
        for (const wc of opts.workClasses) {
          const p = priorityOfWorkClass(wc);
          if (p === null) return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail: `workClass ${wc}` };
          priorities.push(p);
        }
      }
      const onlyHandled = Boolean(opts && opts.onlyHandled === true);
      const remainingOf = opts && opts.remainingOf !== undefined ? opts.remainingOf : null;
      if (remainingOf !== null && typeof remainingOf !== "function") {
        return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail: "remainingOf" };
      }
      const takenHere = new Map();
      const verdictOf = (onlyHandled || remainingOf) ? (entry) => {
        if (onlyHandled && handlers.get(entry.eventType) === null) return "park";
        if (remainingOf) {
          const used = takenHere.get(entry.eventType) || 0;
          if (remainingOf(entry.eventType) - used <= 0) return "hold";
          takenHere.set(entry.eventType, used + 1);
        }
        return "take";
      } : undefined;
      const startedAt = nowMs();
      const popped = dueIndex.popDue(now, { maxItems: Math.min(itemBudget, maxRows), priorities,
        overBudget: () => nowMs() - startedAt >= timeBudgetMs, accept: verdictOf });
      if (popped.held > 0) metrics.count("scheduler.quotaHeld", popped.held);
      for (const entry of popped.rejected) park(entry);
      if (popped.entries.length === 0) {
        if (popped.rejected.length > 0) publish();
        return { ok: true, events: [], stoppedBy: popped.stoppedBy, stale: 0 };
      }
      const r = run("claim", (tx) => eventStore.claim(tx, popped.entries.map((e) => e.eventId), now));
      if (!r.ok) {
        for (const e of popped.entries) dueIndex.add(e.eventId, e.priority, e.dueAt, e.eventType);
        return r;
      }
      for (const event of r.events) {
        inFlight.set(event.eventId, { priority: event.priority, eventType: event.eventType });
      }
      for (const e of r.requeue) dueIndex.add(e.eventId, e.priority, e.dueAt, e.eventType);
      if (r.events.length > 0) metrics.count("scheduler.claimed", r.events.length);
      if (r.stale > 0) metrics.count("scheduler.staleEntries", r.stale);
      metrics.observe("scheduler.claimMs", nowMs() - startedAt);
      publish();
      return { ok: true, events: r.events, stoppedBy: popped.stoppedBy, stale: r.stale };
    }

    function complete(eventId, outcome, effectFn) {
      const refusal = stopped();
      if (refusal) return refusal;
      if (effectFn !== undefined && typeof effectFn !== "function") {
        return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail: "effectFn" };
      }
      const holder = { error: undefined, refusal: undefined, failed: false, effectRan: false, lost: undefined };
      const pending = [];
      const result = store.transaction("scheduler.complete", (tx) => {
        if (labelOn) {
          const claimed = inFlight.get(eventId);
          if (claimed) store.labelTx(claimed.eventType);
        }
        activeComplete = { tx, pending, eventId };
        try {
          const beforeDone = effectFn ? (event) => {
            let value;
            holder.effectRan = true;
            try {
              value = effectFn(tx, event);
            } catch (err) {
              holder.failed = true;
              holder.error = err;
              throw err;
            }
            if (value && typeof value === "object" && value.ok === false) {
              holder.refusal = value;
              throw EFFECT_ABORT;
            }
            return value;
          } : undefined;
          const done = eventStore.complete(tx, eventId, outcome, clock.now(), beforeDone);
          if (!done.ok && holder.effectRan) {
            holder.lost = done;
            throw EFFECT_ABORT;
          }
          return done;
        } finally {
          activeComplete = null;
        }
      });
      if (!result.ok) {
        if (result.reason !== "TX_NESTED"
          && (result.error === EFFECT_ABORT || (holder.failed && result.error === holder.error))) {
          if (holder.lost) return { ok: false, reason: holder.lost.reason, detail: "effect_rolled_back" };
          return holder.failed
            ? { ok: false, reason: "EFFECT_FAILED", error: holder.error, detail: messageOf(holder.error) }
            : { ok: false, reason: "EFFECT_REFUSED", refusal: holder.refusal };
        }
        return unwrap(result);
      }
      const value = result.value;
      if (!value.ok) return value;
      inFlight.delete(eventId);
      for (const event of pending) accept(event);
      if (!value.alreadyDone) metrics.count("scheduler.completed");
      publish();
      return { ok: true, alreadyDone: value.alreadyDone, value: value.value };
    }

    function retryOrQuarantine(eventId, error, opts) {
      const refusal = stopped();
      if (refusal) return refusal;
      const permanent = Boolean(opts && opts.permanent === true);
      const now = clock.now();
      const deferUntil = opts && !permanent && Number.isSafeInteger(opts.deferUntil) && opts.deferUntil >= now
        ? Math.max(now + DEFER_MIN_MS, Math.min(opts.deferUntil, now + settings.retryMaxMs)) : null;
      const r = deferUntil !== null
        ? run("defer", (tx) => eventStore.defer(tx, eventId, deferUntil, error))
        : run("retry", (tx) => eventStore.retry(tx, eventId, error, now, permanent));
      if (!r.ok) return r;
      const known = inFlight.get(eventId);
      inFlight.delete(eventId);
      if (r.state === STATE.RETRY) {
        dueIndex.add(eventId, r.priority, r.dueAt, r.eventType || (known && known.eventType));
        metrics.count("scheduler.retried");
        if (r.deferred === true) metrics.count("scheduler.deferred");
      } else {
        metrics.count("scheduler.quarantined");
      }
      publish();
      return r;
    }

    function findByKey(key) {
      const refusal = stopped();
      if (refusal) return refusal;
      return run("findByKey", (tx) => eventStore.findByKey(tx, key));
    }

    function findLiveOfType(eventType, opts) {
      const refusal = stopped();
      if (refusal) return refusal;
      const outer = opts && opts.tx;
      if (outer) return eventStore.findLiveOfType(outer, eventType);
      return run("findLiveOfType", (tx) => eventStore.findLiveOfType(tx, eventType));
    }

    function purgeDone(spec, opts) {
      const refusal = stopped();
      if (refusal) return refusal;
      const outer = opts && opts.tx;
      if (!outer) return { ok: false, reason: "TX_REQUIRED" };
      return eventStore.purgeDone(outer, spec);
    }

    function scanKeys(spec, opts) {
      const refusal = stopped();
      if (refusal) return refusal;
      const outer = opts && opts.tx;
      if (!outer) return { ok: false, reason: "TX_REQUIRED" };
      return eventStore.scanKeys(outer, spec);
    }

    function statesOf(keys, opts) {
      const refusal = stopped();
      if (refusal) return refusal;
      const outer = opts && opts.tx;
      if (!outer) return { ok: false, reason: "TX_REQUIRED" };
      return eventStore.statesOf(outer, keys);
    }

    function getStatus() {
      let next = null;
      for (const p of ALL_PRIORITIES) {
        const at = dueIndex.nextDueAt(p);
        if (at !== null && (next === null || at < next)) next = at;
      }
      const parkedByType = {};
      for (const [type, entries] of parked) parkedByType[type] = entries.size;
      return Object.freeze({ state, open: openCount(), sizes: Object.freeze(dueIndex.sizes()),
        inFlight: inFlight.size, nextDueAt: next, recovered: Object.freeze({ ...recovered }), rebuildMs, seq,
        parked: Object.freeze(parkedByType), handlers: Object.freeze(handlers.types()),
        driver: driver ? driver.getStatus() : null, catchUp: passRunner ? passRunner.getCatchUp() : null,
        pacing: passRunner ? passRunner.getPacing() : null,
        latenessByType: passRunner ? passRunner.getLatenessByType() : null });
    }

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const r = views.registerView("scheduler", buildSchedulerView({ store, eventStore, getStatus }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`scheduler: view not registered - ${(r && r.reason) || "no result"}`);
    }

    function stop(reason) {
      if (state !== STATE_READY) return;
      state = STATE_STOPPED;
      if (driver) driver.stop(reason === undefined ? "stopped" : String(reason));
      if (passRunner) passRunner.closeEpisode();
      dueIndex.clear();
      inFlight.clear();
      parked.clear();
      parkedTotal = 0;
      seq += 1;
      if (viewHandle) {
        const handle = viewHandle;
        viewHandle = null;
        try {
          handle.unregister();
        } catch (_err) {
        }
      }
    }

    function park(entry) {
      let entries = parked.get(entry.eventType);
      if (!entries) {
        entries = new Map();
        parked.set(entry.eventType, entries);
      }
      if (!entries.has(entry.eventId)) {
        parkedTotal += 1;
        parkedNew += 1;
      }
      entries.set(entry.eventId, entry);
    }

    function unpark(eventType) {
      const entries = parked.get(eventType);
      if (!entries) return 0;
      parked.delete(eventType);
      parkedTotal -= entries.size;
      for (const e of entries.values()) dueIndex.add(e.eventId, e.priority, e.dueAt, e.eventType);
      return entries.size;
    }

    function registerHandler(eventType, fn, opts) {
      const refusal = stopped();
      if (refusal) return refusal;
      const r = handlers.register(eventType, fn, opts);
      if (!r.ok) return r;
      unpark(eventType);
      publish();
      return { ok: true, unregister: () => {
        r.unregister();
        if (state === STATE_READY) publish();
      } };
    }

    const passes = createPassRunner({
      queue: {
        claimDue, complete, retryOrQuarantine, enqueue,
        nextDueAt: (priorities) => {
          let next = null;
          for (const p of priorities) {
            const at = dueIndex.nextDueAt(p);
            if (at !== null && (next === null || at < next)) next = at;
          }
          return next;
        },
        countDue: (cutoff, cap) => dueIndex.countDue(cutoff, cap),
        parkedCount: () => parkedTotal,
        takeParkedNew: () => {
          const n = parkedNew;
          parkedNew = 0;
          return n;
        },
        forget: (eventId) => {
          if (inFlight.delete(eventId)) publish();
        },
        unclaim: (ev) => {
          const refusal = stopped();
          if (refusal) return refusal;
          const r = run("unclaim", (tx) => eventStore.unclaim(tx, ev.eventId));
          if (!r.ok) return r;
          inFlight.delete(ev.eventId);
          park({ eventId: r.eventId, priority: r.priority, dueAt: r.dueAt, eventType: r.eventType });
          publish();
          return r;
        },
        isReady: () => state === STATE_READY,
        bump: () => {
          seq += 1;
        },
      },
      handlers, store, clock, nowMs,
      getGovernor: typeof deps.getGovernor === "function" ? deps.getGovernor : () => null,
      limits: { maxDueEventsPerPass: limits.maxDueEventsPerPass, maxSchedulerWorkMs: limits.maxSchedulerWorkMs,
        maxCatchUpEventsPerPass: limits.maxCatchUpEventsPerPass },
      settings: { sliceMs: settings.sliceMs, claimBatchSize: settings.claimBatchSize,
        catchUpLagMs: settings.catchUpLagMs, backlogCountCap: settings.backlogCountCap,
        adaptiveClaimBatch: settings.adaptiveClaimBatch === true, costEwmaInitialMs: settings.costEwmaInitialMs,
        costEwmaAlpha: settings.costEwmaAlpha,
        slowOpMs: config.telemetry ? config.telemetry.slowOpMs : undefined,
        slowOpLogPerMin: config.telemetry ? config.telemetry.slowOpLogPerMin : undefined,
        reescalationWindowMs: settings.reescalationWindowMs,
        latenessDetail: settings.latenessDetail === true, latenessSlowMs: settings.latenessSlowMs,
        latenessTopTypes: settings.latenessTopTypes },
      pacer: settings.heavyPacing === true ? createHeavyPacer({ heavyEventMs: settings.heavyEventMs,
        perWindow: settings.heavyPerWindow, windowMs: settings.heavyWindowMs, alpha: settings.costEwmaAlpha,
        sampleCapFactor: settings.heavySampleCapFactor, minSamples: settings.heavyMinSamples,
        workClassOf: (t) => (getEventType(t) || {}).workClass || null }) : null,
      metrics, logger,
      isActive: () => {
        const st = driver.getState();
        return st !== "stopped" && st !== "suspended";
      },
      onSuspend: (reason, detail) => driver.suspend(reason, detail),
    });
    passRunner = passes;
    driver = createDriver({ runPass: passes.runPass, intervalMs: settings.intervalMs, setTimer: deps.setTimer,
      logger, onState: () => {
        seq += 1;
      } });

    function runPass() {
      return passes.runPass();
    }

    function startPasses() {
      const refusal = stopped();
      if (refusal) return refusal;
      if (driver.getState() !== "idle") return { ok: false, reason: "already_started" };
      passes.baseline();
      return driver.start();
    }

    publish();
    const scheduler = Object.freeze({ enqueue, enqueueMany, claimDue, complete, retryOrQuarantine, findByKey, getStatus,
      findLiveOfType, stop, purgeDone, scanKeys, statesOf,
      registerHandler, runPass, startPasses });
    return { ok: true, scheduler };
  } catch (err) {
    return { ok: false, reason: "SCHEDULER_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startScheduler, createUnavailableScheduler, QUEUE_FULL_MIN_PRIORITY };
