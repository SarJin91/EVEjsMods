"use strict";

const { KIND_APPLY } = require("../../persistence/journal");
const { toBind } = require("../../persistence/repository");
const S = require("../schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const TOTAL_FIELDS = Object.freeze(["jobsStarted", "jobsDelivered", "jobsLost", "hullsStarted", "hullsDelivered",
  "hullsLost", "mineralsConsumed"]);
const TERMINAL = Object.freeze([S.JOB_DELIVERED, S.JOB_LOST]);
const ITEM_KEY_RE = /^group:[a-z_]{1,32}$/;
const MINERAL_KEY_RE = /^type:\d+$/;

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isBill = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0
  && Object.keys(v).every((k) => MINERAL_KEY_RE.test(k) && Number.isSafeInteger(v[k]) && v[k] > 0);
const invalid = (detail) => ({ ok: false, reason: "PRODUCTION_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;

function toJob(row) {
  return Object.freeze({
    jobId: row.job_id, idempotencyKey: row.idempotency_key, factionId: row.faction_id, stationId: row.station_id,
    systemId: row.system_id, hullGroup: row.hull_group, itemKey: row.item_key, runs: row.runs,
    recipesVersion: row.recipes_version, consumed: Object.freeze(JSON.parse(row.consumed_json)), runMs: row.run_ms,
    startedAt: row.started_at, dueAt: row.due_at, state: row.state, waitRound: row.wait_round,
    endedAt: row.ended_at, endReason: row.end_reason, createdAt: row.created_at, updatedAt: row.updated_at,
    version: row.version,
  });
}

function toTotals(row) {
  return Object.freeze({ factionId: row.faction_id, jobsStarted: row.jobs_started, jobsDelivered: row.jobs_delivered,
    jobsLost: row.jobs_lost, hullsStarted: row.hulls_started, hullsDelivered: row.hulls_delivered,
    hullsLost: row.hulls_lost, mineralsConsumed: row.minerals_consumed, updatedAt: row.updated_at,
    version: row.version });
}

function createJobRepository(deps) {
  const { journal, clock, hullGroups } = deps || {};
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("jobRepository: journal");
  if (!clock || typeof clock.now !== "function") throw new TypeError("jobRepository: clock");
  if (!Array.isArray(hullGroups) || hullGroups.length === 0) throw new TypeError("jobRepository: hullGroups");
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      byId: db.prepare("SELECT * FROM world_production_jobs WHERE job_id = ?"),
      insert: db.prepare(`INSERT INTO world_production_jobs (job_id, idempotency_key, faction_id, station_id,
        system_id, hull_group, item_key, runs, recipes_version, consumed_json, run_ms, started_at, due_at, state,
        wait_round, ended_at, end_reason, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, NULL, NULL, ?, ?, 1)`),
      end: db.prepare(`UPDATE world_production_jobs SET state = ?, ended_at = ?, end_reason = ?, updated_at = ?,
        version = version + 1 WHERE job_id = ? AND version = ?`),
      wait: db.prepare(`UPDATE world_production_jobs SET wait_round = ?, updated_at = ?, version = version + 1
        WHERE job_id = ? AND version = ?`),
      activeAtStation: db.prepare(`SELECT count(*) AS n FROM world_production_jobs WHERE station_id = ?
        AND faction_id = ? AND state = 'ACTIVE'`),
      activeOfFaction: db.prepare(`SELECT count(*) AS n FROM world_production_jobs WHERE faction_id = ?
        AND state = 'ACTIVE'`),
      listActiveOfFaction: db.prepare(`SELECT * FROM world_production_jobs WHERE faction_id = ? AND state = 'ACTIVE'
        ORDER BY job_id LIMIT ?`),
      listActive: db.prepare(`SELECT * FROM world_production_jobs WHERE state = 'ACTIVE' AND job_id > ?
        ORDER BY job_id LIMIT ?`),
      totalsUpsert: db.prepare(`INSERT INTO world_production_totals (faction_id, jobs_started, jobs_delivered,
        jobs_lost, hulls_started, hulls_delivered, hulls_lost, minerals_consumed, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (faction_id) DO UPDATE SET jobs_started = jobs_started + excluded.jobs_started,
        jobs_delivered = jobs_delivered + excluded.jobs_delivered, jobs_lost = jobs_lost + excluded.jobs_lost,
        hulls_started = hulls_started + excluded.hulls_started,
        hulls_delivered = hulls_delivered + excluded.hulls_delivered, hulls_lost = hulls_lost + excluded.hulls_lost,
        minerals_consumed = minerals_consumed + excluded.minerals_consumed, updated_at = excluded.updated_at,
        version = version + 1`),
      totalsOf: db.prepare("SELECT * FROM world_production_totals WHERE faction_id = ?"),
      totalsAll: db.prepare("SELECT * FROM world_production_totals ORDER BY faction_id"),
      pruneIds: db.prepare(`SELECT job_id FROM world_production_jobs WHERE faction_id = ? AND ended_at IS NOT NULL
        AND ended_at < ? ORDER BY ended_at, job_id LIMIT ?`),
      deleteJob: db.prepare("DELETE FROM world_production_jobs WHERE job_id = ?"),
      activeAll: db.prepare(`SELECT * FROM world_production_jobs WHERE state = 'ACTIVE' ORDER BY faction_id,
        station_id, job_id LIMIT ?`),
      recentEnded: db.prepare(`SELECT faction_id, state, count(*) AS jobs, coalesce(sum(runs), 0) AS hulls
        FROM world_production_jobs WHERE ended_at IS NOT NULL AND ended_at >= ? GROUP BY faction_id, state`),
    };
    cache.set(db, s);
    return s;
  }

  function readNow() {
    const now = clock.now();
    return isTime(now) ? now : undefined;
  }

  function addTotals(db, factionId, deltas, now) {
    const d = deltas || {};
    for (const k of Object.keys(d)) {
      if (!TOTAL_FIELDS.includes(k) || !isCount(d[k])) return invalid(`totals.${k}`);
    }
    stmts(db).totalsUpsert.run(toBind(factionId), ...TOTAL_FIELDS.map((k) => toBind(d[k] || 0)), toBind(now));
    return { ok: true };
  }

  const unwrap = (r) => (r.reason === "APPLY_REFUSED" ? r.refusal : r);

  function jobIdOfKey(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    if (found.found && found.entry.kind === KIND_APPLY && found.entry.aggregateType === S.JOB_AGGREGATE) {
      return { ok: true, jobId: found.entry.aggregateId, duplicate: true };
    }
    if (found.found) return { ok: false, reason: "IDEMPOTENCY_CONFLICT", detail: key };
    return { ok: true, jobId: null, duplicate: false };
  }

  function createJob(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isText(spec.jobId, S.MAX_ID_LENGTH) || !isText(spec.idempotencyKey, S.MAX_KEY_LENGTH)
      || !isId(spec.factionId) || !isText(spec.stationId, S.MAX_ID_LENGTH) || !isId(spec.systemId)
      || !hullGroups.includes(spec.hullGroup) || !isText(spec.itemKey, S.MAX_ITEM_KEY_LENGTH)
      || !ITEM_KEY_RE.test(spec.itemKey) || !Number.isSafeInteger(spec.runs) || spec.runs < 1 || spec.runs > S.MAX_RUNS
      || !isId(spec.recipesVersion) || !isBill(spec.consumed) || !isId(spec.runMs) || !isTime(spec.startedAt)
      || !isTime(spec.dueAt) || spec.dueAt < spec.startedAt) return invalid("spec");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const minerals = Object.values(spec.consumed).reduce((n, v) => n + v, 0);
    const payload = { jobId: spec.jobId, factionId: spec.factionId, stationId: spec.stationId,
      hullGroup: spec.hullGroup, runs: spec.runs, recipesVersion: spec.recipesVersion };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.JOB_AGGREGATE, id: spec.jobId },
      eventType: S.EVENT_JOB_CREATED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(spec.jobId)) return { ok: false, reason: "JOB_EXISTS", jobId: spec.jobId };
      s.insert.run(spec.jobId, spec.idempotencyKey, toBind(spec.factionId), spec.stationId, toBind(spec.systemId),
        spec.hullGroup, spec.itemKey, toBind(spec.runs), toBind(spec.recipesVersion), JSON.stringify(spec.consumed),
        toBind(spec.runMs), toBind(spec.startedAt), toBind(spec.dueAt), toBind(now), toBind(now));
      return addTotals(db, spec.factionId, { jobsStarted: 1, hullsStarted: spec.runs, mineralsConsumed: minerals },
        now);
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true, jobId: spec.jobId };
  }

  function endJob(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.jobId, S.MAX_ID_LENGTH) || !isId(change.expectedVersion)
      || !TERMINAL.includes(change.to) || !isTime(change.endedAt) || !isText(change.endReason, 32)) {
      return invalid("end");
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.JOB_AGGREGATE, id: change.jobId },
      eventType: S.EVENT_JOB_TRANSITION, payload: { jobId: change.jobId, from: S.JOB_ACTIVE, to: change.to,
        endReason: change.endReason } }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.jobId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", jobId: change.jobId };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.state !== S.JOB_ACTIVE) return { ok: false, reason: "STATE_MISMATCH", actual: row.state };
      s.end.run(change.to, toBind(change.endedAt), change.endReason, toBind(now), change.jobId,
        toBind(change.expectedVersion));
      if (change.totals) {
        const t = addTotals(db, row.faction_id, change.totals, now);
        if (!t.ok) return t;
      }
      return { ok: true, job: toJob(s.byId.get(change.jobId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) return { ok: true, duplicate: true };
    changes += 1;
    return { ok: true, duplicate: false, job: r.value.job };
  }

  function waitJob(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.jobId, S.MAX_ID_LENGTH) || !isId(change.expectedVersion)
      || !isCount(change.waitRound)) return invalid("wait");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.JOB_AGGREGATE, id: change.jobId },
      eventType: S.EVENT_JOB_WAIT, payload: { jobId: change.jobId, waitRound: change.waitRound } }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.jobId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", jobId: change.jobId };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.state !== S.JOB_ACTIVE) return { ok: false, reason: "STATE_MISMATCH", actual: row.state };
      s.wait.run(toBind(change.waitRound), toBind(now), change.jobId, toBind(change.expectedVersion));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true };
  }

  function prune(tx, factionId, before, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId) || !isTime(before) || !isCount(limit)) return invalid("prune");
    if (limit === 0) return { ok: true, pruned: 0 };
    const s = stmts(tx);
    const ids = s.pruneIds.all(toBind(factionId), toBind(before), toBind(limit)).map((r) => r.job_id);
    for (const id of ids) s.deleteJob.run(id);
    if (ids.length > 0) changes += 1;
    return { ok: true, pruned: ids.length };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    jobIdOfKey,
    createJob,
    endJob,
    waitJob,
    prune,
    getJob: (tx, jobId) => read(tx, (s) => {
      const row = s.byId.get(jobId);
      return { ok: true, job: row ? toJob(row) : null };
    }),
    countActiveAtStation: (tx, stationId, factionId) => read(tx, (s) => ({ ok: true,
      count: s.activeAtStation.get(stationId, toBind(factionId)).n })),
    countActiveOfFaction: (tx, factionId) => read(tx, (s) => ({ ok: true,
      count: s.activeOfFaction.get(toBind(factionId)).n })),
    listActiveOfFaction: (tx, factionId, limit) => read(tx, (s) => ({ ok: true,
      jobs: s.listActiveOfFaction.all(toBind(factionId), toBind(limit)).map(toJob) })),
    listActive: (tx, opts) => read(tx, (s) => ({ ok: true, jobs: s.listActive.all((opts && opts.after) || "",
      toBind((opts && opts.limit) || 1)).map(toJob) })),
    listActiveAll: (tx, limit) => read(tx, (s) => ({ ok: true, jobs: s.activeAll.all(toBind(limit)).map(toJob) })),
    recentEnded: (tx, since) => read(tx, (s) => ({ ok: true, rows: s.recentEnded.all(toBind(since)) })),
    getTotals: (tx, factionId) => read(tx, (s) => {
      const row = s.totalsOf.get(toBind(factionId));
      return { ok: true, totals: row ? toTotals(row) : null };
    }),
    listTotals: (tx) => read(tx, (s) => ({ ok: true, totals: s.totalsAll.all().map(toTotals) })),
    getChangeCount: () => changes,
  });
}

const deliveredCache = new WeakMap();
const MAX_DELIVERED_PAGE = 5000;

function listDeliveredJobsAfter(tx, spec) {
  if (txMissing(tx)) return TX_REQUIRED;
  if (!spec || !isId(spec.factionId) || !isTime(spec.afterAt) || typeof spec.afterKey !== "string"
    || spec.afterKey.length > S.MAX_ID_LENGTH || !isTime(spec.untilAt) || !Number.isSafeInteger(spec.limit)
    || spec.limit < 1 || spec.limit > MAX_DELIVERED_PAGE) {
    return invalid("deliveredAfter");
  }
  let stmt = deliveredCache.get(tx);
  if (!stmt) {
    stmt = tx.prepare(`SELECT job_id, ended_at, system_id FROM world_production_jobs
      WHERE faction_id = ? AND ended_at IS NOT NULL AND ended_at <= ? AND (ended_at > ? OR (ended_at = ? AND job_id > ?))
      AND state = 'DELIVERED' ORDER BY ended_at, job_id LIMIT ?`);
    deliveredCache.set(tx, stmt);
  }
  const rows = stmt.all(toBind(spec.factionId), toBind(spec.untilAt), toBind(spec.afterAt), toBind(spec.afterAt),
    spec.afterKey, toBind(spec.limit));
  return { ok: true, rows: rows.map((r) => Object.freeze({ id: r.job_id, endedAt: Number(r.ended_at),
    systemId: Number(r.system_id) })) };
}

module.exports = { createJobRepository, toJob, listDeliveredJobsAfter };
