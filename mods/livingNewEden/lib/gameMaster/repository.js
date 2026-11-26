"use strict";

const S = require("./schema");

const C = S.CYCLES_TABLE;
const T = S.THREADS_TABLE;
const A = S.ACTIVITY_TABLE;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const nOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const sOrNull = (v) => (v === null || v === undefined ? null : String(v));

function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function toCycle(row) {
  return Object.freeze({ cycleAt: Number(row.cycle_at), state: row.state, attempts: Number(row.attempts),
    source: sOrNull(row.source), reason: sOrNull(row.reason), threadId: sOrNull(row.thread_id),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
}

function toThread(row) {
  const results = parseJson(row.step_results, []);
  return Object.freeze({
    threadId: row.thread_id,
    cycleAt: Number(row.cycle_at),
    arc: row.arc,
    source: row.source,
    factionId: Number(row.faction_id),
    actorFactionId: nOrNull(row.actor_faction_id),
    anchorSystemId: Number(row.anchor_system_id),
    plan: parseJson(row.plan_json, null),
    state: row.state,
    outcome: sOrNull(row.outcome),
    stepNo: Number(row.step_no),
    stepState: row.step_state,
    stepHandle: parseJson(row.step_handle, null),
    stepDueAt: Number(row.step_due_at),
    stepRetries: Number(row.step_retries),
    stepResults: Object.freeze(Array.isArray(results) ? results : []),
    deadlineAt: Number(row.deadline_at),
    seed: Number(row.seed),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    endedAt: nOrNull(row.ended_at),
  });
}

const PATCH_COLUMNS = Object.freeze({
  state: ["state", (v) => v],
  outcome: ["outcome", (v) => (v === null ? null : v)],
  stepNo: ["step_no", (v) => v],
  stepState: ["step_state", (v) => v],
  stepHandle: ["step_handle", (v) => (v === null ? null : JSON.stringify(v))],
  stepDueAt: ["step_due_at", (v) => v],
  stepRetries: ["step_retries", (v) => v],
  stepResults: ["step_results", (v) => JSON.stringify(v)],
  endedAt: ["ended_at", (v) => v],
});

function createGameMasterRepository() {
  function insertCycleInTx(tx, spec) {
    const { cycleAt, now } = spec || {};
    if (!isTime(cycleAt)) return invalid("cycleAt");
    if (!isTime(now)) return invalid("now");
    if (tx.prepare(`SELECT cycle_at FROM ${C} WHERE cycle_at = ?`).get(cycleAt)) return { ok: true, inserted: false };
    tx.prepare(`INSERT INTO ${C} (cycle_at, state, attempts, source, reason, thread_id, created_at, updated_at)
      VALUES (?, 'DRAFTING', 0, NULL, NULL, NULL, ?, ?)`).run(cycleAt, now, now);
    return { ok: true, inserted: true };
  }

  function readCycleInTx(tx, cycleAt) {
    const row = tx.prepare(`SELECT * FROM ${C} WHERE cycle_at = ?`).get(cycleAt);
    return row ? toCycle(row) : null;
  }

  function listCyclesInTx(tx, spec) {
    const limit = spec && spec.limit;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: tx.prepare(`SELECT * FROM ${C} ORDER BY cycle_at DESC LIMIT ?`).all(limit).map(toCycle) };
  }

  function updateCycleInTx(tx, spec) {
    const s = spec || {};
    if (!isTime(s.cycleAt)) return invalid("cycleAt");
    if (!Object.values(S.STATE_CYCLE).includes(s.fromState)) return invalid("fromState");
    if (!Object.values(S.STATE_CYCLE).includes(s.toState)) return invalid("toState");
    if (!isTime(s.now)) return invalid("now");
    const source = s.source === undefined ? null : s.source;
    if (source !== null && !Object.values(S.SOURCES).includes(source)) return invalid("source");
    const reason = s.reason === undefined || s.reason === null ? null
      : String(s.reason).slice(0, S.MAX_REASON_LENGTH);
    const threadId = s.threadId === undefined ? null : s.threadId;
    if (threadId !== null && !isText(threadId, 40)) return invalid("threadId");
    const delta = s.attemptsDelta === undefined ? 0 : s.attemptsDelta;
    if (!isTime(delta)) return invalid("attemptsDelta");
    const info = tx.prepare(`UPDATE ${C} SET state = ?, source = coalesce(?, source), reason = ?,
      thread_id = coalesce(?, thread_id), attempts = attempts + ?, updated_at = ? WHERE cycle_at = ? AND state = ?`)
      .run(s.toState, source, reason, threadId, delta, s.now, s.cycleAt, s.fromState);
    return { ok: true, changed: info.changes === 1 };
  }

  function insertThreadInTx(tx, r) {
    if (!r || !isText(r.threadId, 40)) return invalid("threadId");
    if (!isTime(r.cycleAt)) return invalid("cycleAt");
    if (!isText(r.arc, 24)) return invalid("arc");
    if (!Object.values(S.SOURCES).includes(r.source)) return invalid("source");
    if (!isId(r.factionId)) return invalid("factionId");
    if (r.actorFactionId !== null && !isId(r.actorFactionId)) return invalid("actorFactionId");
    if (!isId(r.anchorSystemId)) return invalid("anchorSystemId");
    if (!isText(r.planJson, S.MAX_PLAN_BYTES)) return invalid("planJson");
    if (!isTime(r.stepDueAt) || !isTime(r.deadlineAt) || !isTime(r.seed) || !isTime(r.now)) return invalid("time");
    const seen = tx.prepare(`SELECT thread_id FROM ${T} WHERE thread_id = ? OR cycle_at = ?`).get(r.threadId, r.cycleAt);
    if (seen) return { ok: false, reason: "DUPLICATE" };
    tx.prepare(`INSERT INTO ${T} (thread_id, cycle_at, arc, source, faction_id, actor_faction_id, anchor_system_id,
      plan_json, state, outcome, step_no, step_state, step_handle, step_due_at, step_retries, step_results,
      deadline_at, seed, version, created_at, updated_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, 0, 'PENDING', NULL, ?, 0, '[]', ?, ?, 1, ?, ?, NULL)`)
      .run(r.threadId, r.cycleAt, r.arc, r.source, r.factionId, r.actorFactionId, r.anchorSystemId, r.planJson,
        r.stepDueAt, r.deadlineAt, r.seed, r.now, r.now);
    return { ok: true };
  }

  function readThreadInTx(tx, threadId) {
    const row = tx.prepare(`SELECT * FROM ${T} WHERE thread_id = ?`).get(threadId);
    return row ? toThread(row) : null;
  }

  function listDueThreadsInTx(tx, spec) {
    const { now, limit } = spec || {};
    if (!isTime(now)) return invalid("now");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${T} WHERE state = 'ACTIVE' AND step_due_at <= ?
      ORDER BY step_due_at, thread_id LIMIT ?`).all(now, limit);
    return { ok: true, rows: rows.map(toThread) };
  }

  function listActiveThreadsInTx(tx, spec) {
    const limit = spec && spec.limit;
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${T} WHERE state = 'ACTIVE' ORDER BY cycle_at, thread_id LIMIT ?`)
      .all(limit);
    return { ok: true, rows: rows.map(toThread) };
  }

  function hasActiveThreadInTx(tx) {
    return Boolean(tx.prepare(`SELECT 1 AS one FROM ${T} WHERE state = 'ACTIVE' LIMIT 1`).get());
  }

  function countActiveThreadsInTx(tx) {
    const row = tx.prepare(`SELECT count(*) AS n FROM ${T} WHERE state = 'ACTIVE'`).get();
    return row ? Number(row.n) : 0;
  }

  function listThreadsInTx(tx, spec) {
    const limit = spec && spec.limit;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: tx.prepare(`SELECT * FROM ${T} ORDER BY cycle_at DESC LIMIT ?`).all(limit)
      .map(toThread) };
  }

  function updateThreadInTx(tx, spec) {
    const { threadId, version, patch, now } = spec || {};
    if (!isText(threadId, 40)) return invalid("threadId");
    if (!isId(version)) return invalid("version");
    if (!isTime(now)) return invalid("now");
    if (!patch || typeof patch !== "object") return invalid("patch");
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      const col = PATCH_COLUMNS[key];
      if (!col) return invalid(`patch.${key}`);
      sets.push(`${col[0]} = ?`);
      values.push(col[1](value));
    }
    if (sets.length === 0) return invalid("patch");
    const info = tx.prepare(`UPDATE ${T} SET ${sets.join(", ")}, version = version + 1, updated_at = ?
      WHERE thread_id = ? AND version = ?`).run(...values, now, threadId, version);
    return { ok: true, changed: info.changes === 1 };
  }

  function listRecentThreadsInTx(tx, spec) {
    const { sinceCycleAt, limit } = spec || {};
    if (!Number.isSafeInteger(sinceCycleAt)) return invalid("sinceCycleAt");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT arc, anchor_system_id, cycle_at FROM ${T} WHERE cycle_at >= ?
      ORDER BY cycle_at DESC LIMIT ?`).all(sinceCycleAt, limit);
    return { ok: true, rows: rows.map((r) => Object.freeze({ arc: r.arc, anchorSystemId: Number(r.anchor_system_id),
      cycleAt: Number(r.cycle_at) })) };
  }

  function upsertActivityInTx(tx, spec) {
    const { bucketAt, regionId, add } = spec || {};
    if (!isTime(bucketAt)) return invalid("bucketAt");
    if (!isId(regionId)) return invalid("regionId");
    if (!isId(add)) return invalid("add");
    const seen = tx.prepare(`SELECT samples FROM ${A} WHERE bucket_at = ? AND region_id = ?`).get(bucketAt, regionId);
    if (seen) {
      tx.prepare(`UPDATE ${A} SET samples = samples + ? WHERE bucket_at = ? AND region_id = ?`)
        .run(add, bucketAt, regionId);
    } else {
      tx.prepare(`INSERT INTO ${A} (bucket_at, region_id, samples) VALUES (?, ?, ?)`).run(bucketAt, regionId, add);
    }
    return { ok: true };
  }

  function readActivityInTx(tx, spec) {
    const { bucketAt, limit } = spec || {};
    if (!isTime(bucketAt)) return invalid("bucketAt");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT region_id, samples FROM ${A} WHERE bucket_at = ?
      ORDER BY samples DESC, region_id LIMIT ?`).all(bucketAt, limit);
    return { ok: true, rows: rows.map((r) => Object.freeze({ regionId: Number(r.region_id),
      samples: Number(r.samples) })) };
  }

  function purgeInTx(tx, spec) {
    const { beforeAt, limit } = spec || {};
    if (!isTime(beforeAt)) return invalid("beforeAt");
    if (!isId(limit)) return invalid("limit");
    let left = limit;
    left -= tx.prepare(`DELETE FROM ${T} WHERE thread_id IN (SELECT thread_id FROM ${T}
      WHERE ended_at IS NOT NULL AND ended_at < ? ORDER BY ended_at LIMIT ?)`).run(beforeAt, left).changes;
    if (left > 0) {
      left -= tx.prepare(`DELETE FROM ${C} WHERE cycle_at IN (SELECT c.cycle_at FROM ${C} c WHERE c.cycle_at < ?
        AND NOT EXISTS (SELECT 1 FROM ${T} t WHERE t.cycle_at = c.cycle_at AND t.state = 'ACTIVE')
        ORDER BY c.cycle_at LIMIT ?)`).run(beforeAt, left).changes;
    }
    if (left > 0) {
      left -= tx.prepare(`DELETE FROM ${A} WHERE (bucket_at, region_id) IN (SELECT bucket_at, region_id FROM ${A}
        WHERE bucket_at < ? ORDER BY bucket_at, region_id LIMIT ?)`).run(beforeAt, left).changes;
    }
    return { ok: true, deleted: limit - left };
  }

  return Object.freeze({ insertCycleInTx, readCycleInTx, listCyclesInTx, updateCycleInTx, insertThreadInTx,
    readThreadInTx, listDueThreadsInTx, listActiveThreadsInTx, hasActiveThreadInTx, countActiveThreadsInTx,
    listThreadsInTx, updateThreadInTx, listRecentThreadsInTx, upsertActivityInTx, readActivityInTx, purgeInTx });
}

module.exports = { createGameMasterRepository };
