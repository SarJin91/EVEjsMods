"use strict";

const S = require("../world/salvageSchema");
const { ACTION, planSalvageOutbound, planSalvageRecovery, planSalvageReturn, planSalvageDelivery } =
  require("../fleets/salvageOps");
const { nextReconcileKey } = require("./reconcileSlots");

const PULSE_EVENT = "SALVAGE_PULSE";
const ADVANCE_EVENT = "SALVAGE_JOB_ADVANCE";
const DELIVERY_EVENT = "SALVAGE_DELIVERY";
const PULSE_AGGREGATE_ID = "salvage";
const DELIVERY_REASON = "SALVAGE_DELIVERY";
const STATION_MODE_READY = "ready";
const JOB_CREATE_ROWS = 3;
const PULSE_ROWS_FIXED = 2;
const TRANSIENT_REASONS = Object.freeze(["STATIONS_NOT_READY", "GRAPH_NOT_READY"]);
const ROUTE_SKIP_REASONS = Object.freeze(["TOO_FAR", "UNREACHABLE", "UNKNOWN_SYSTEM"]);
const STOCK_FULL_REASONS = Object.freeze(["STOCK_CAP", "STOCK_ITEMS_LIMIT"]);
const HOME_LOST_REASONS = Object.freeze(["STATION_DESTROYED", "ROW_NOT_FOUND"]);
const COUNTER_NAMES = Object.freeze(["pulses", "pulseSkipped", "jobsCreated", "noHome", "tooLate", "refused",
  "recovering", "collected", "returned", "jobsCompleted", "jobsExhausted", "jobsFailed", "unitsRecovered",
  "unitsDropped", "stale", "reconciled", "reconcileExhausted"]);
const PAYLOAD_KEYS = "jobId,phaseSeq";
const MAX_DETAIL = 120;
const SAVEPOINT_ABORT = Symbol("salvage-savepoint-abort");

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parsePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (Object.keys(p).sort().join() !== PAYLOAD_KEYS) return null;
  if (typeof p.jobId !== "string" || p.jobId.length < 1 || p.jobId.length > S.MAX_JOB_ID_LENGTH) return null;
  if (!Number.isSafeInteger(p.phaseSeq) || p.phaseSeq < 1) return null;
  return { jobId: p.jobId, phaseSeq: p.phaseSeq };
}

function createSalvageService(deps) {
  const { store, salvage, wrecks, scheduler, clock, config } = deps;
  const P = config.salvage;
  const maxQuantity = config.stations && Number.isSafeInteger(config.stations.maxStockQuantity)
    && config.stations.maxStockQuantity > 0 ? config.stations.maxStockQuantity : S.MAX_UNITS;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = "ready";
  let lastRefusal = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `salvage.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function stationsNow() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const mode = st && typeof st.getMode === "function" ? call(() => st.getMode(), "off") : "off";
    const ready = mode === STATION_MODE_READY && st && st.locator && st.repository;
    return { mode, locator: ready ? st.locator : null, repository: ready ? st.repository : null };
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "SALVAGE_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function enqueueStep(tx, type, jobId, phaseSeq, dueAt) {
    const r = scheduler.enqueue(type, jobId, dueAt, { jobId, phaseSeq }, S.dueKey(jobId, phaseSeq),
      { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "step" };
    return { ok: true };
  }

  function findHome(tx, factionId, systemId) {
    const st = stationsNow();
    if (!st.locator) return { ok: false, reason: "STATIONS_NOT_READY" };
    const g = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
    if (!g || typeof g.findRoute !== "function") return { ok: false, reason: "GRAPH_NOT_READY" };
    const found = st.locator.findNearestStations(tx, { factionId, fromSystemId: systemId });
    if (!found || found.ok !== true) return found || { ok: false, reason: "STATIONS_READ_FAILED" };
    for (const target of found.targets) {
      const has = st.locator.hasRepairStation(tx, factionId, target);
      if (!has || has.ok !== true) return has || { ok: false, reason: "STATIONS_READ_FAILED" };
      if (has.stationId === null) continue;
      const route = g.findRoute(systemId, target, { maxJumps: P.maxJumps });
      if (!route || route.ok !== true) {
        if (route && ROUTE_SKIP_REASONS.includes(route.reason)) continue;
        return { ok: false, reason: (route && route.reason) || "ROUTE_FAILED" };
      }
      return { ok: true, home: { stationId: has.stationId, systemId: target, jumps: route.jumps } };
    }
    return { ok: true, home: null };
  }

  function closeField(tx, spec, endReason) {
    const r = salvage.insertJobInTx(tx, { fieldId: spec.fieldId, factionId: spec.factionId, systemId: spec.systemId,
      homeStationId: null, homeSystemId: null, jumps: 0, state: S.SALVAGE_JOB_FAILED, endReason,
      travelMs: 0, recoveryMs: 0, nextAt: null, at: spec.at }, S.jobKey(spec.fieldId));
    if (!r.ok) return r;
    return { ok: true, jobId: S.jobIdOf(spec.fieldId), created: false, closed: endReason, duplicate: r.duplicate };
  }

  function registerSalvageOpportunity(tx, spec) {
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!spec || typeof spec.fieldId !== "string" || !isTime(spec.at)) {
      return { ok: false, reason: "SALVAGE_INVALID_INPUT" };
    }
    const found = findHome(tx, spec.factionId, spec.systemId);
    if (!found.ok) return found;
    if (!found.home) return closeField(tx, spec, "NO_HOME");
    const plan = planSalvageOutbound({ fieldId: spec.fieldId, factionId: spec.factionId, systemId: spec.systemId,
      homeStationId: found.home.stationId, homeSystemId: found.home.systemId, jumps: found.home.jumps,
      shipsLost: spec.shipsLost, at: spec.at }, P);
    if (!plan.ok) return plan;
    if (isTime(spec.expiresAt) && plan.intent.dueAt + plan.recoveryMs >= spec.expiresAt) {
      return closeField(tx, spec, "TOO_LATE");
    }
    const key = S.jobKey(spec.fieldId);
    const r = salvage.insertJobInTx(tx, { fieldId: spec.fieldId, factionId: spec.factionId, systemId: spec.systemId,
      homeStationId: found.home.stationId, homeSystemId: found.home.systemId, jumps: found.home.jumps,
      state: S.SALVAGE_JOB_OUTBOUND, endReason: null, travelMs: plan.travelMs, recoveryMs: plan.recoveryMs,
      nextAt: plan.intent.dueAt, at: spec.at }, key);
    if (!r.ok) return r;
    if (r.duplicate) return { ok: true, jobId: S.jobIdOf(spec.fieldId), created: false, duplicate: true };
    const ev = enqueueStep(tx, ADVANCE_EVENT, r.jobId, 1, plan.intent.dueAt);
    if (!ev.ok) return ev;
    return { ok: true, jobId: r.jobId, created: true };
  }

  function processSalvageJobs(tx, params) {
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    const at = params && params.at;
    if (!isTime(at)) return { ok: false, reason: "SALVAGE_INVALID_INPUT" };
    const out = { ok: true, created: 0, active: 0, noHome: 0, tooLate: 0, refused: 0, skipped: null };
    const counted = salvage.countActive(tx);
    if (!counted.ok) return counted;
    out.active = counted.count;
    const room = Math.min(P.maxActiveJobs - counted.count, P.maxNewJobsPerPulse);
    if (room <= 0) {
      out.skipped = "MAX_ACTIVE_JOBS";
      return out;
    }
    const list = salvage.listCandidates(tx, { at, limit: room });
    if (!list.ok) return list;
    for (const f of list.fields) {
      const spec = { fieldId: f.fieldId, factionId: f.winnerFactionId, systemId: f.systemId, shipsLost: f.shipsLost,
        expiresAt: f.expiresAt, at };
      const guarded = (fn) => {
        try {
          return inSavepoint(tx, fn);
        } catch (err) {
          if (tx.inTransaction !== true) throw err;
          return { ok: false, reason: `SALVAGE_THREW: ${messageOf(err)}` };
        }
      };
      const r = guarded(() => registerSalvageOpportunity(tx, spec));
      if (r && r.ok) {
        if (r.created) {
          out.created += 1;
          out.active += 1;
        }
        if (r.closed === "NO_HOME") out.noHome += 1;
        if (r.closed === "TOO_LATE") out.tooLate += 1;
        continue;
      }
      const reason = (r && r.reason) || "SALVAGE_FAILED";
      if (TRANSIENT_REASONS.includes(reason)) {
        out.skipped = reason;
        break;
      }
      out.refused += 1;
      lastRefusal = `${f.fieldId}:${reason}`.slice(0, MAX_DETAIL);
      guarded(() => closeField(tx, spec, "REFUSED"));
    }
    return out;
  }

  function readStep(tx, p, states) {
    const j = salvage.getJob(tx, p.jobId);
    if (!j.ok) return j;
    const job = j.job;
    if (!job || job.phaseSeq !== p.phaseSeq || !states.includes(job.state) || !isTime(job.nextAt)) {
      return { ok: true, stale: true };
    }
    return { ok: true, job };
  }

  function readField(tx, fieldId) {
    const r = wrecks.get(tx, fieldId);
    if (!r || !r.ok) return r || { ok: false, reason: "WRECKS_READ_FAILED" };
    return { ok: true, field: r.field };
  }

  function move(tx, job, to, extra) {
    const key = S.phaseKey(job.jobId, job.phaseSeq);
    const m = salvage.transitionInTx(tx, { jobId: job.jobId, expectedVersion: job.version, from: job.state, to,
      at: job.nextAt, ...extra }, key);
    if (m.ok && m.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
    return m;
  }

  function endJob(tx, job, to, reason, out) {
    const m = move(tx, job, to, { endReason: reason });
    if (!m.ok) return m;
    out.action = to;
    out.reason = reason;
    return { ok: true, ...out };
  }

  function advanceSalvageJob(tx, p) {
    const out = { action: "STALE", reason: null };
    const read = readStep(tx, p, [S.SALVAGE_JOB_OUTBOUND, S.SALVAGE_JOB_RECOVERING, S.SALVAGE_JOB_RETURNING]);
    if (!read.ok) return read;
    if (read.stale) return { ok: true, ...out };
    const job = read.job;
    const at = job.nextAt;
    out.jobId = job.jobId;
    if (job.state === S.SALVAGE_JOB_RETURNING) {
      const m = move(tx, job, S.SALVAGE_JOB_DELIVERY_PENDING, { nextAt: at });
      if (!m.ok) return m;
      const e = enqueueStep(tx, DELIVERY_EVENT, job.jobId, m.phaseSeq, at);
      if (!e.ok) return e;
      out.action = S.SALVAGE_JOB_DELIVERY_PENDING;
      return { ok: true, ...out };
    }
    const fr = readField(tx, job.fieldId);
    if (!fr.ok) return fr;
    const field = fr.field;
    if (job.state === S.SALVAGE_JOB_OUTBOUND) {
      const d = planSalvageRecovery(job, field, at);
      if (!d.ok) return { ...d, permanent: true };
      if (d.action === ACTION.EXHAUST) return endJob(tx, job, S.SALVAGE_JOB_EXHAUSTED, d.reason, out);
      const m = move(tx, job, S.SALVAGE_JOB_RECOVERING, { nextAt: d.nextAt });
      if (!m.ok) return m;
      const e = enqueueStep(tx, ADVANCE_EVENT, job.jobId, m.phaseSeq, d.nextAt);
      if (!e.ok) return e;
      out.action = S.SALVAGE_JOB_RECOVERING;
      return { ok: true, ...out };
    }
    return collectSalvage(tx, job, field, out);
  }

  function collectSalvage(tx, job, field, out) {
    const at = job.nextAt;
    const d = planSalvageReturn(job, field, at, P.claimPermille);
    if (!d.ok) return { ...d, permanent: true };
    if (d.action === ACTION.EXHAUST) return endJob(tx, job, S.SALVAGE_JOB_EXHAUSTED, d.reason, out);
    const taken = wrecks.recordSalvageInTx(tx, { fieldId: field.fieldId, expectedVersion: field.version,
      salvageUnits: d.salvaged.salvageUnits, lootUnits: d.salvaged.lootUnits, at }, S.collectKey(job.jobId));
    if (!taken.ok) return { ...taken, stage: "collect" };
    if (taken.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.collectKey(job.jobId) };
    const m = move(tx, job, S.SALVAGE_JOB_RETURNING, { nextAt: d.nextAt, salvageUnits: d.haul.salvage,
      lootUnits: d.haul.loot });
    if (!m.ok) return m;
    const e = enqueueStep(tx, ADVANCE_EVENT, job.jobId, m.phaseSeq, d.nextAt);
    if (!e.ok) return e;
    out.action = S.SALVAGE_JOB_RETURNING;
    out.collected = d.haul.salvage + d.haul.loot;
    return { ok: true, ...out };
  }

  function creditSalvageToFaction(tx, p) {
    const out = { action: "STALE", reason: null };
    const read = readStep(tx, p, [S.SALVAGE_JOB_DELIVERY_PENDING]);
    if (!read.ok) return read;
    if (read.stale) return { ok: true, ...out };
    const job = read.job;
    out.jobId = job.jobId;
    const st = stationsNow();
    if (!st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const sr = st.repository.getStation(tx, job.homeStationId);
    if (!sr || !sr.ok) return sr || { ok: false, reason: "STATIONS_READ_FAILED" };
    const d = planSalvageDelivery(job, sr.record, maxQuantity);
    if (!d.ok) return { ...d, permanent: true };
    out.dropped = job.salvageUnits + job.lootUnits - (d.action === ACTION.DELIVER ? d.units : 0);
    if (d.action === ACTION.FAIL) return endJob(tx, job, S.SALVAGE_JOB_FAILED, d.reason, out);
    const stock = st.repository.applyStockChange(tx, { stationId: job.homeStationId, key: S.deliverKey(job.jobId),
      reason: DELIVERY_REASON, at: job.nextAt, deltas: d.deltas });
    if (!stock || !stock.ok) {
      const reason = (stock && stock.reason) || "STOCK_FAILED";
      out.dropped = job.salvageUnits + job.lootUnits;
      if (STOCK_FULL_REASONS.includes(reason)) return endJob(tx, job, S.SALVAGE_JOB_FAILED, "STOCK_FULL", out);
      if (HOME_LOST_REASONS.includes(reason)) return endJob(tx, job, S.SALVAGE_JOB_FAILED, "HOME_LOST", out);
      return { ...(stock || {}), ok: false, reason, stage: "stock" };
    }
    if (stock.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.deliverKey(job.jobId) };
    out.delivered = d.units;
    return endJob(tx, job, S.SALVAGE_JOB_DELIVERED, "DELIVERED", out);
  }

  function onStepCommitted(v) {
    if (!v || v.ok !== true) return;
    bump("unitsDropped", v.dropped || 0);
    switch (v.action) {
      case "STALE": bump("stale"); break;
      case S.SALVAGE_JOB_RECOVERING: bump("recovering"); break;
      case S.SALVAGE_JOB_RETURNING: bump("collected"); bump("unitsRecovered", v.collected || 0); break;
      case S.SALVAGE_JOB_DELIVERY_PENDING: bump("returned"); break;
      case S.SALVAGE_JOB_DELIVERED: bump("jobsCompleted"); break;
      case S.SALVAGE_JOB_EXHAUSTED: bump("jobsExhausted"); break;
      case S.SALVAGE_JOB_FAILED:
        bump("jobsFailed");
        log(`salvage: job ${v.jobId} FAILED ${v.reason}`);
        break;
      default: break;
    }
  }

  function stepHandler(name, body) {
    return (ev) => {
      try {
        const p = parsePayload(ev && ev.payload);
        if (!p) return { ok: false, reason: "SALVAGE_PAYLOAD_INVALID", permanent: true };
        if (state === "stopped") return { ok: false, reason: "SALVAGE_STOPPED" };
        return { ok: true, outcome: "STEP", effect: (tx) => {
          const r = body(tx, p);
          if (!r || r.ok !== true) lastRefusal = `${name}:${(r && r.reason) || "STEP_FAILED"}`;
          return r;
        }, onCommitted: onStepCommitted };
      } catch (err) {
        return { ok: false, reason: `SALVAGE_STEP_FAILED: ${messageOf(err)}` };
      }
    };
  }

  function pulseHandler(ev, hctx) {
    try {
      if (state === "stopped") return { ok: false, reason: "SALVAGE_STOPPED" };
      const now = hctx && isTime(hctx.now) ? hctx.now : clock.now();
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : now;
      const I = P.pulseIntervalMs;
      const bucket = Math.floor(at / I) + 1;
      return { ok: true, outcome: "PULSE", effect: (tx) => processSalvageJobs(tx, { at }),
        reschedule: { eventType: PULSE_EVENT, aggregateId: PULSE_AGGREGATE_ID, dueAt: bucket * I,
          payload: { intervalMs: I, round: bucket }, idempotencyKey: S.pulseKey(I, bucket) },
        onCommitted: (v) => {
          bump("pulses");
          if (!v || v.ok !== true) return;
          bump("jobsCreated", v.created);
          bump("noHome", v.noHome);
          bump("tooLate", v.tooLate);
          bump("refused", v.refused);
          if (v.skipped) bump("pulseSkipped");
          metric("gauge", "salvage.activeJobs", v.active);
        } };
    } catch (err) {
      return { ok: false, reason: `SALVAGE_PULSE_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      const I = P.pulseIntervalMs;
      const bucket = Math.floor(clock.now() / I) + 1;
      const r = scheduler.enqueue(PULSE_EVENT, PULSE_AGGREGATE_ID, bucket * I, { intervalMs: I, round: bucket },
        S.pulseKey(I, bucket));
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      return { ok: true, duplicate: r.duplicate === true, dueAt: bucket * I };
    } catch (err) {
      return { ok: false, reason: `BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function reconcile() {
    try {
      const listed = store.transaction("salvage.reconcileRead", (tx) => salvage.listOpen(tx,
        { limit: P.reconcileMaxJobs }));
      const r = listed.ok ? listed.value : listed;
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
      let enqueued = 0;
      let exhausted = 0;
      for (const job of r.jobs) {
        const slot = nextReconcileKey(scheduler, { dueKey: S.dueKey(job.jobId, job.phaseSeq),
          baseKey: S.reconcileKey(job.jobId, job.phaseSeq), maxAttempts: P.reconcileMaxAttempts });
        if (!slot.ok) return slot;
        if (slot.open) continue;
        if (slot.exhausted) {
          exhausted += 1;
          log(`salvage: reconcile ${job.jobId} exhausted ${P.reconcileMaxAttempts} attempts`);
          continue;
        }
        const type = job.state === S.SALVAGE_JOB_DELIVERY_PENDING ? DELIVERY_EVENT : ADVANCE_EVENT;
        const e = scheduler.enqueue(type, job.jobId, job.nextAt, { jobId: job.jobId, phaseSeq: job.phaseSeq }, slot.key);
        if (e && e.ok && !e.duplicate) enqueued += 1;
        else if (!e || !e.ok) log(`salvage: reconcile ${job.jobId} refused ${(e && e.reason) || "?"}`);
      }
      bump("reconciled", enqueued);
      bump("reconcileExhausted", exhausted);
      return { ok: true, open: r.jobs.length, truncated: r.truncated, enqueued, exhausted };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  return Object.freeze({
    registerSalvageOpportunity,
    processSalvageJobs,
    advanceSalvageJob,
    creditSalvageToFaction,
    pulseHandler,
    advanceHandler: stepHandler("advance", advanceSalvageJob),
    deliveryHandler: stepHandler("delivery", creditSalvageToFaction),
    bootstrap,
    reconcile,
    getStatus: () => Object.freeze({ state, counters: Object.freeze({ ...counters }), lastRefusal }),
    stop() {
      state = "stopped";
    },
    isStopped: () => state === "stopped",
  });
}

const pulseRowBound = (maxNewJobsPerPulse) => JOB_CREATE_ROWS * maxNewJobsPerPulse + PULSE_ROWS_FIXED;

module.exports = { createSalvageService, parsePayload, pulseRowBound, PULSE_EVENT, ADVANCE_EVENT, DELIVERY_EVENT,
  COUNTER_NAMES };
