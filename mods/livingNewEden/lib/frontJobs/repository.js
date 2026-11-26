"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isTime = (v) => Number.isSafeInteger(v);
const isText = (v) => typeof v === "string" && v !== "";
const LIST_DONE_MAX = 64;

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function jobOf(r) {
  return Object.freeze({ jobId: r.job_id, day: Number(r.day), slot: Number(r.slot), kind: r.kind, state: r.state,
    issuerFactionId: Number(r.issuer_faction_id), targetFactionId: num(r.target_faction_id),
    systemId: Number(r.system_id), regionId: num(r.region_id), targetCount: Number(r.target_count), ref: r.ref,
    iskAmount: Number(r.isk_amount), lpAmount: Number(r.lp_amount), lpCorporationId: num(r.lp_corporation_id),
    standingMicro: Number(r.standing_micro), maxCompletions: Number(r.max_completions),
    completions: Number(r.completions), description: r.description, createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at), updatedAt: Number(r.updated_at), version: Number(r.version) });
}

function progressOf(r) {
  return Object.freeze({ jobId: r.job_id, characterId: Number(r.character_id), progress: Number(r.progress),
    state: r.state, firstAt: Number(r.first_at), lastAt: Number(r.last_at), doneAt: num(r.done_at) });
}

function payoutOf(r) {
  return Object.freeze({ payoutKey: r.payout_key, jobId: r.job_id, characterId: Number(r.character_id),
    issuerFactionId: Number(r.issuer_faction_id), systemId: Number(r.system_id),
    lpCorporationId: num(r.lp_corporation_id), iskAmount: Number(r.isk_amount), lpAmount: Number(r.lp_amount),
    standingMicro: Number(r.standing_micro), description: r.description, iskState: r.isk_state, lpState: r.lp_state,
    stdState: r.std_state, state: r.state, attempts: Number(r.attempts), nextAttemptAt: Number(r.next_attempt_at),
    lastError: r.last_error, plannedAt: Number(r.planned_at), updatedAt: Number(r.updated_at) });
}

function validJob(j) {
  if (!j || typeof j !== "object") return "job";
  if (!isText(j.jobId) || j.jobId.length < 8 || j.jobId.length > 96) return "jobId";
  if (!isNonNegInt(j.day)) return "day";
  if (!isNonNegInt(j.slot)) return "slot";
  if (!S.KINDS.includes(j.kind)) return "kind";
  if (!isId(j.issuerFactionId)) return "issuerFactionId";
  if (j.targetFactionId !== null && !isId(j.targetFactionId)) return "targetFactionId";
  if (!isId(j.systemId)) return "systemId";
  if (j.regionId !== null && !isId(j.regionId)) return "regionId";
  if (!isId(j.targetCount)) return "targetCount";
  if (j.ref !== null && typeof j.ref !== "string") return "ref";
  if (!isNonNegInt(j.iskAmount)) return "iskAmount";
  if (!isNonNegInt(j.lpAmount)) return "lpAmount";
  if (j.lpCorporationId !== null && !isId(j.lpCorporationId)) return "lpCorporationId";
  if (!isNonNegInt(j.standingMicro)) return "standingMicro";
  if (!isId(j.maxCompletions)) return "maxCompletions";
  if (!isText(j.description) || j.description.length > S.MAX_DESCRIPTION) return "description";
  if (!isTime(j.createdAt)) return "createdAt";
  if (!isTime(j.expiresAt) || j.expiresAt <= j.createdAt) return "expiresAt";
  return null;
}

function createFrontJobRepository() {
  function countJobsOfDayInTx(tx, day) {
    if (!isNonNegInt(day)) return invalid("day");
    const row = tx.prepare(`SELECT count(*) AS n FROM ${S.JOBS_TABLE} WHERE day = ?`).get(day);
    return { ok: true, count: Number(row.n) };
  }

  function insertJobInTx(tx, job) {
    const bad = validJob(job);
    if (bad) return invalid(bad);
    tx.prepare(`INSERT INTO ${S.JOBS_TABLE} (job_id, day, slot, kind, state, issuer_faction_id, target_faction_id,
      system_id, region_id, target_count, ref, isk_amount, lp_amount, lp_corporation_id, standing_micro,
      max_completions, completions, description, created_at, expires_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)`)
      .run(job.jobId, job.day, job.slot, job.kind, S.JOB_STATE.OPEN, job.issuerFactionId, job.targetFactionId,
        job.systemId, job.regionId, job.targetCount, job.ref, job.iskAmount, job.lpAmount, job.lpCorporationId,
        job.standingMicro, job.maxCompletions, job.description, job.createdAt, job.expiresAt, job.createdAt);
    return { ok: true };
  }

  function getJobInTx(tx, jobId) {
    if (!isText(jobId)) return invalid("jobId");
    const r = tx.prepare(`SELECT * FROM ${S.JOBS_TABLE} WHERE job_id = ?`).get(jobId);
    return { ok: true, job: r ? jobOf(r) : null };
  }

  function hasJobWithRefInTx(tx, kind, ref) {
    if (!S.KINDS.includes(kind)) return invalid("kind");
    if (!isText(ref)) return invalid("ref");
    const r = tx.prepare(`SELECT 1 AS x FROM ${S.JOBS_TABLE} WHERE kind = ? AND ref = ? LIMIT 1`).get(kind, ref);
    return { ok: true, exists: Boolean(r) };
  }

  function listOpenOfKindInTx(tx, kind, limit) {
    if (!S.KINDS.includes(kind)) return invalid("kind");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.JOBS_TABLE} WHERE state = 'OPEN' AND kind = ?
      ORDER BY system_id, job_id LIMIT ?`).all(kind, limit);
    return { ok: true, jobs: rows.map(jobOf) };
  }

  function listDayInTx(tx, day) {
    if (!isNonNegInt(day)) return invalid("day");
    const rows = tx.prepare(`SELECT * FROM ${S.JOBS_TABLE} WHERE day = ? ORDER BY slot`).all(day);
    return { ok: true, jobs: rows.map(jobOf) };
  }

  function expireDueInTx(tx, now, limit) {
    if (!isTime(now)) return invalid("now");
    if (!isId(limit)) return invalid("limit");
    const r = tx.prepare(`UPDATE ${S.JOBS_TABLE} SET state = 'EXPIRED', updated_at = ?,
      version = version + 1
      WHERE job_id IN (SELECT job_id FROM ${S.JOBS_TABLE} WHERE state = 'OPEN' AND expires_at <= ?
        ORDER BY expires_at, job_id LIMIT ?)`).run(now, now, limit);
    return { ok: true, expired: Number(r.changes) };
  }

  function getProgressInTx(tx, jobId, characterId) {
    if (!isText(jobId)) return invalid("jobId");
    if (!isId(characterId)) return invalid("characterId");
    const r = tx.prepare(`SELECT * FROM ${S.PROGRESS_TABLE} WHERE job_id = ? AND character_id = ?`)
      .get(jobId, characterId);
    return { ok: true, progress: r ? progressOf(r) : null };
  }

  function writeProgressInTx(tx, p) {
    const { jobId, characterId, progress, state, at, doneAt } = p || {};
    if (!isText(jobId)) return invalid("jobId");
    if (!isId(characterId)) return invalid("characterId");
    if (!isNonNegInt(progress)) return invalid("progress");
    if (!Object.values(S.PROGRESS_STATE).includes(state)) return invalid("state");
    if (!isTime(at)) return invalid("at");
    const done = state === S.PROGRESS_STATE.DONE ? doneAt : null;
    if (state === S.PROGRESS_STATE.DONE && !isTime(done)) return invalid("doneAt");
    tx.prepare(`INSERT INTO ${S.PROGRESS_TABLE} (job_id, character_id, progress, state, first_at, last_at, done_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (job_id, character_id) DO UPDATE SET progress = excluded.progress, state = excluded.state,
        last_at = max(last_at, excluded.last_at), done_at = excluded.done_at`)
      .run(jobId, characterId, progress, state, at, at, done);
    return { ok: true };
  }

  function countDoneSinceInTx(tx, characterId, sinceMs) {
    if (!isId(characterId)) return invalid("characterId");
    if (!isTime(sinceMs)) return invalid("sinceMs");
    const row = tx.prepare(`SELECT count(*) AS n FROM ${S.PROGRESS_TABLE}
      WHERE state = 'DONE' AND character_id = ? AND done_at >= ?`).get(characterId, sinceMs);
    return { ok: true, count: Number(row.n) };
  }

  function listDoneOfCharacterInTx(tx, q) {
    const { characterId, sinceMs, limit } = q || {};
    if (!isId(characterId)) return invalid("characterId");
    if (!isTime(sinceMs)) return invalid("sinceMs");
    if (!isId(limit) || limit > LIST_DONE_MAX) return invalid("limit");
    const rows = tx.prepare(`SELECT p.job_id, p.done_at, j.kind, j.description, j.system_id, j.issuer_faction_id,
      j.isk_amount, j.lp_amount, j.standing_micro, pay.state AS payout_state
      FROM ${S.PROGRESS_TABLE} p JOIN ${S.JOBS_TABLE} j ON j.job_id = p.job_id
      LEFT JOIN ${S.PAYOUTS_TABLE} pay ON pay.payout_key = p.job_id || ':' || p.character_id
      WHERE p.character_id = ? AND p.state = 'DONE' AND p.done_at >= ?
      ORDER BY p.done_at DESC, p.job_id LIMIT ?`).all(characterId, sinceMs, limit);
    return { ok: true, rows: rows.map((r) => Object.freeze({ jobId: r.job_id, kind: r.kind, description: r.description,
      systemId: Number(r.system_id), issuerFactionId: Number(r.issuer_faction_id), iskAmount: Number(r.isk_amount),
      lpAmount: Number(r.lp_amount), standingMicro: Number(r.standing_micro), doneAt: Number(r.done_at),
      payoutState: r.payout_state === null || r.payout_state === undefined ? null : String(r.payout_state) })) };
  }

  function completeJobInTx(tx, jobId, expectedVersion, at) {
    if (!isText(jobId)) return invalid("jobId");
    if (!isId(expectedVersion)) return invalid("expectedVersion");
    if (!isTime(at)) return invalid("at");
    const r = tx.prepare(`UPDATE ${S.JOBS_TABLE} SET completions = completions + 1, version = version + 1,
      updated_at = ?, state = CASE WHEN completions + 1 >= max_completions THEN 'FILLED' ELSE state END
      WHERE job_id = ? AND version = ? AND state = 'OPEN'`).run(at, jobId, expectedVersion);
    if (Number(r.changes) !== 1) return { ok: false, reason: "VERSION_MISMATCH" };
    const row = tx.prepare(`SELECT state FROM ${S.JOBS_TABLE} WHERE job_id = ?`).get(jobId);
    return { ok: true, filled: Boolean(row) && row.state === S.JOB_STATE.FILLED };
  }

  function insertPayoutInTx(tx, job, characterId, at) {
    if (!job || !isText(job.jobId)) return invalid("job");
    if (!isId(characterId)) return invalid("characterId");
    if (!isTime(at)) return invalid("at");
    const L = S.LEG_STATE;
    const isk = job.iskAmount > 0 ? L.PENDING : L.SKIPPED;
    const lp = job.lpAmount > 0 && isId(job.lpCorporationId) ? L.PENDING : L.SKIPPED;
    const std = job.standingMicro > 0 ? L.PENDING : L.SKIPPED;
    const state = [isk, lp, std].every((s) => s === L.SKIPPED) ? S.ROW_STATE.PAID : S.ROW_STATE.PENDING;
    const payoutKey = S.payoutKeyOf(job.jobId, characterId);
    tx.prepare(`INSERT INTO ${S.PAYOUTS_TABLE} (payout_key, job_id, character_id, issuer_faction_id, system_id,
      lp_corporation_id, isk_amount, lp_amount, standing_micro, description, isk_state, lp_state, std_state, state,
      attempts, next_attempt_at, last_error, planned_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`)
      .run(payoutKey, job.jobId, characterId, job.issuerFactionId, job.systemId, job.lpCorporationId, job.iskAmount,
        job.lpAmount, job.standingMicro, job.description, isk, lp, std, state, at, at, at);
    return { ok: true, payoutKey, state };
  }

  function listProgressOfCharacterInTx(tx, characterId, jobIds) {
    if (!isId(characterId)) return invalid("characterId");
    if (!Array.isArray(jobIds) || !jobIds.every(isText)) return invalid("jobIds");
    if (jobIds.length === 0) return { ok: true, rows: [] };
    const marks = jobIds.map(() => "?").join(", ");
    const rows = tx.prepare(`SELECT * FROM ${S.PROGRESS_TABLE} WHERE character_id = ? AND job_id IN (${marks})`)
      .all(characterId, ...jobIds);
    return { ok: true, rows: rows.map(progressOf) };
  }

  function listDuePayoutsInTx(tx, now, limit) {
    if (!isTime(now)) return invalid("now");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.PAYOUTS_TABLE} WHERE state = 'PENDING' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, payout_key LIMIT ?`).all(now, limit);
    return { ok: true, rows: rows.map(payoutOf) };
  }

  function markPayoutInTx(tx, m) {
    if (!m || !isText(m.payoutKey)) return invalid("payoutKey");
    const legs = Object.values(S.LEG_STATE);
    for (const leg of ["iskState", "lpState", "stdState"]) if (!legs.includes(m[leg])) return invalid(leg);
    if (!Object.values(S.ROW_STATE).includes(m.state)) return invalid("state");
    if (!isNonNegInt(m.attempts)) return invalid("attempts");
    if (!isTime(m.nextAttemptAt)) return invalid("nextAttemptAt");
    if (m.lastError !== null && typeof m.lastError !== "string") return invalid("lastError");
    if (!isTime(m.now)) return invalid("now");
    const r = tx.prepare(`UPDATE ${S.PAYOUTS_TABLE} SET isk_state = ?, lp_state = ?, std_state = ?, state = ?,
      attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE payout_key = ? AND state = 'PENDING'`).run(m.iskState, m.lpState, m.stdState, m.state, m.attempts,
      m.nextAttemptAt, m.lastError, m.now, m.payoutKey);
    return { ok: true, changed: Number(r.changes) === 1 };
  }

  function pruneInTx(tx, jobsBefore, payoutsBefore, limit) {
    if (!isTime(jobsBefore)) return invalid("jobsBefore");
    if (!isTime(payoutsBefore)) return invalid("payoutsBefore");
    if (!isId(limit)) return invalid("limit");
    const progress = tx.prepare(`DELETE FROM ${S.PROGRESS_TABLE} WHERE (job_id, character_id) IN (
      SELECT p.job_id, p.character_id FROM ${S.PROGRESS_TABLE} p JOIN ${S.JOBS_TABLE} j ON j.job_id = p.job_id
      WHERE j.created_at < ? AND j.state <> 'OPEN' LIMIT ?)`).run(jobsBefore, limit);
    const jobs = tx.prepare(`DELETE FROM ${S.JOBS_TABLE} WHERE job_id IN (
      SELECT j.job_id FROM ${S.JOBS_TABLE} j WHERE j.created_at < ? AND j.state <> 'OPEN'
        AND NOT EXISTS (SELECT 1 FROM ${S.PROGRESS_TABLE} p WHERE p.job_id = j.job_id)
      ORDER BY j.created_at LIMIT ?)`).run(jobsBefore, limit);
    const payouts = tx.prepare(`DELETE FROM ${S.PAYOUTS_TABLE} WHERE payout_key IN (
      SELECT payout_key FROM ${S.PAYOUTS_TABLE} WHERE state <> 'PENDING' AND updated_at < ?
      ORDER BY updated_at LIMIT ?)`).run(payoutsBefore, limit);
    return { ok: true, progress: Number(progress.changes), jobs: Number(jobs.changes),
      payouts: Number(payouts.changes) };
  }

  function listEligibleProgressInTx(tx, jobId, minProgress) {
    if (!isText(jobId)) return invalid("jobId");
    if (!isId(minProgress)) return invalid("minProgress");
    const rows = tx.prepare(`SELECT * FROM ${S.PROGRESS_TABLE} WHERE job_id = ? AND state = 'ACTIVE' AND progress >= ?
      ORDER BY last_at DESC, character_id`).all(jobId, minProgress);
    return { ok: true, rows: rows.map(progressOf) };
  }

  function closeJobInTx(tx, jobId, toState, at) {
    if (!isText(jobId)) return invalid("jobId");
    if (toState !== S.JOB_STATE.FILLED && toState !== S.JOB_STATE.EXPIRED) return invalid("toState");
    if (!isTime(at)) return invalid("at");
    const r = tx.prepare(`UPDATE ${S.JOBS_TABLE} SET state = ?, updated_at = ?, version = version + 1
      WHERE job_id = ? AND state = 'OPEN'`).run(toState, at, jobId);
    return { ok: true, changed: Number(r.changes) === 1 };
  }

  return Object.freeze({ countJobsOfDayInTx, insertJobInTx, getJobInTx, hasJobWithRefInTx, listOpenOfKindInTx,
    listDayInTx,
    expireDueInTx, getProgressInTx, writeProgressInTx, countDoneSinceInTx, completeJobInTx, insertPayoutInTx,
    listProgressOfCharacterInTx, listDuePayoutsInTx, markPayoutInTx, pruneInTx, listEligibleProgressInTx,
    closeJobInTx, listDoneOfCharacterInTx });
}

module.exports = { createFrontJobRepository };
