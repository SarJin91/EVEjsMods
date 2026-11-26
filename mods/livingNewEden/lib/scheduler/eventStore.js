"use strict";

const { stableJson, fingerprintWithPayloadJson } = require("../util/fingerprint");
const { toBind } = require("../persistence/repository");
const { getEventType } = require("./eventTypes");
const {
  TABLE_NAME, STATE, MAX_KEY_LENGTH, MAX_ERROR_LENGTH, MAX_OUTCOME_LENGTH, CLAIM_INTERRUPTED, LIVE_INDEX_WHERE,
} = require("./schema");
const LIVE = LIVE_INDEX_WHERE;

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const CLAIMABLE = Object.freeze([STATE.QUEUED, STATE.RETRY]);
const SCAN_KEYS_MAX_LIMIT = 10000;
const ROW_COLUMNS = "event_id, idempotency_key, event_type, aggregate_type, aggregate_id, priority, due_at, "
  + "payload, state, attempts, last_error, outcome, created_at, claimed_at, finished_at, version";

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

function invalid(detail) {
  return { ok: false, reason: "SCHEDULER_INVALID_INPUT", detail };
}

function charLength(text) {
  let n = 0;
  for (const _ch of text) n += 1;
  return n;
}

function isText(value, max) {
  return typeof value === "string" && value !== "" && charLength(value) <= max;
}

function truncateChars(text, max) {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

function errorText(error) {
  const raw = error instanceof Error ? error.message : String(error === undefined ? "" : error);
  return truncateChars(raw === "" ? "UNSPECIFIED_ERROR" : raw, MAX_ERROR_LENGTH);
}

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function toEvent(row) {
  const type = getEventType(row.event_type);
  return Object.freeze({
    eventId: row.event_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    priority: row.priority,
    workClass: type ? type.workClass : null,
    dueAt: row.due_at,
    payload: JSON.parse(row.payload),
    idempotencyKey: row.idempotency_key,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    outcome: row.outcome,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    version: row.version,
  });
}

function createEventStore(deps) {
  const { clock, ids, limits, onCount } = deps || {};
  if (!clock || typeof clock.now !== "function") throw new TypeError("createEventStore: clock.now() required");
  if (!ids || typeof ids.next !== "function") throw new TypeError("createEventStore: ids.next() required");
  if (!limits || typeof limits !== "object") throw new TypeError("createEventStore: limits required");
  for (const key of ["maxPayloadBytes", "maxAttempts", "retryBaseMs", "retryMaxMs"]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new TypeError(`createEventStore: limits.${key}`);
  }
  if (onCount !== undefined && typeof onCount !== "function") throw new TypeError("createEventStore: onCount");

  function count(name, detail) {
    if (!onCount) return;
    try {
      onCount(name, 1, detail);
    } catch (_err) {
    }
  }

  const cache = new WeakMap();
  function handles(db) {
    let h = cache.get(db);
    if (h) return h;
    h = {
      byKey: db.prepare(`SELECT event_id, state, due_at, priority, payload_hash, event_type, aggregate_id
        FROM ${TABLE_NAME}
        WHERE idempotency_key = ?`),
      fullByKey: db.prepare(`SELECT ${ROW_COLUMNS} FROM ${TABLE_NAME} WHERE idempotency_key = ?`),
      byId: db.prepare(`SELECT ${ROW_COLUMNS} FROM ${TABLE_NAME} WHERE event_id = ?`),
      insert: db.prepare(`INSERT INTO ${TABLE_NAME} (event_id, idempotency_key, event_type, aggregate_type,
        aggregate_id, priority, due_at, payload, payload_hash, state, attempts, created_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '${STATE.QUEUED}', 0, ?, 1)`),
      claim: db.prepare(`UPDATE ${TABLE_NAME} SET state = '${STATE.CLAIMED}', attempts = attempts + 1,
        claimed_at = ?, version = version + 1
        WHERE event_id IN (SELECT value FROM json_each(?)) AND state IN ('${STATE.QUEUED}', '${STATE.RETRY}')
          AND due_at <= ?
        RETURNING ${ROW_COLUMNS}`),
      peekMany: db.prepare(`SELECT event_id, state, due_at, priority, event_type FROM ${TABLE_NAME}
        WHERE event_id IN (SELECT value FROM json_each(?))`),
      done: db.prepare(`UPDATE ${TABLE_NAME} SET state = '${STATE.DONE}', outcome = ?, finished_at = ?,
        version = version + 1 WHERE event_id = ? AND state = '${STATE.CLAIMED}'`),
      retry: db.prepare(`UPDATE ${TABLE_NAME} SET state = '${STATE.RETRY}', due_at = ?, last_error = ?,
        version = version + 1 WHERE event_id = ? AND state = '${STATE.CLAIMED}'`),
      unclaim: db.prepare(`UPDATE ${TABLE_NAME} SET state = '${STATE.RETRY}', attempts = max(0, attempts - 1),
        claimed_at = NULL, version = version + 1 WHERE event_id = ? AND state = '${STATE.CLAIMED}'
        RETURNING event_id, priority, due_at, event_type`),
      defer: db.prepare(`UPDATE ${TABLE_NAME} SET state = '${STATE.RETRY}', attempts = max(0, attempts - 1),
        due_at = ?, last_error = ?, claimed_at = NULL, version = version + 1
        WHERE event_id = ? AND state = '${STATE.CLAIMED}'
        RETURNING event_id, priority, due_at, event_type, attempts`),
      quarantine: db.prepare(`UPDATE ${TABLE_NAME} SET state = '${STATE.QUARANTINED}', last_error = ?,
        finished_at = ?, version = version + 1 WHERE event_id = ? AND state = '${STATE.CLAIMED}'`),
      recover: db.prepare(`UPDATE ${TABLE_NAME}
        SET state = CASE WHEN attempts >= ? THEN '${STATE.QUARANTINED}' ELSE '${STATE.RETRY}' END,
          finished_at = CASE WHEN attempts >= ? THEN ? ELSE NULL END,
          last_error = ?, version = version + 1
        WHERE event_id IN (SELECT event_id FROM ${TABLE_NAME} WHERE ${LIVE} AND state = '${STATE.CLAIMED}'
          ORDER BY priority, due_at, event_id LIMIT ?)
        RETURNING state`),
      open: db.prepare(`SELECT event_id, priority, due_at, event_type FROM ${TABLE_NAME}
        WHERE ${LIVE} AND state IN ('${STATE.QUEUED}', '${STATE.RETRY}') ORDER BY priority, due_at, event_id`),
      countQuarantined: db.prepare(`SELECT count(*) AS n FROM ${TABLE_NAME}
        WHERE ${LIVE} AND state = '${STATE.QUARANTINED}'`),
      listQuarantined: db.prepare(`SELECT ${ROW_COLUMNS} FROM ${TABLE_NAME}
        WHERE ${LIVE} AND state = '${STATE.QUARANTINED}' ORDER BY priority, due_at, event_id LIMIT ?`),
      retention: null,
      liveOfType: null,
    };
    cache.set(db, h);
    return h;
  }

  function retentionHandles(db) {
    const h = handles(db);
    if (h.retention) return h.retention;
    h.retention = {
      purgeDoneKey: db.prepare(`DELETE FROM ${TABLE_NAME} WHERE idempotency_key = ? AND event_type = ?
        AND state = '${STATE.DONE}'`),
      stateByKey: db.prepare(`SELECT state FROM ${TABLE_NAME} WHERE idempotency_key = ?`),
      purgeDoneRange: db.prepare(`DELETE FROM ${TABLE_NAME} WHERE event_id IN (SELECT event_id FROM ${TABLE_NAME}
        WHERE idempotency_key >= ? AND idempotency_key < ? AND event_type = ? AND +state = '${STATE.DONE}'
          AND finished_at < ? ORDER BY idempotency_key LIMIT ?)`),
      scanFrom: db.prepare(`SELECT idempotency_key, event_type, state, finished_at FROM ${TABLE_NAME}
        WHERE idempotency_key >= ? AND idempotency_key < ? ORDER BY idempotency_key LIMIT ?`),
      scanAfter: db.prepare(`SELECT idempotency_key, event_type, state, finished_at FROM ${TABLE_NAME}
        WHERE idempotency_key > ? AND idempotency_key < ? ORDER BY idempotency_key LIMIT ?`),
      statesOf: db.prepare(`SELECT idempotency_key, state FROM ${TABLE_NAME}
        WHERE idempotency_key IN (SELECT value FROM json_each(?))`),
    };
    return h.retention;
  }

  function backoffMs(attempts) {
    return Math.min(limits.retryMaxMs, limits.retryBaseMs * 2 ** Math.max(0, attempts - 1));
  }

  function insert(tx, spec, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec !== "object") return invalid("spec");
    const type = getEventType(spec.eventType);
    if (!type) return { ok: false, reason: "UNKNOWN_EVENT_TYPE", eventType: String(spec.eventType) };
    let aggregateId;
    if (Number.isSafeInteger(spec.aggregateId)) aggregateId = String(spec.aggregateId);
    else if (isText(spec.aggregateId, MAX_KEY_LENGTH)) aggregateId = spec.aggregateId;
    else return invalid("aggregateId");
    if (!isTime(spec.dueAt)) return invalid("dueAt");
    if (!isText(spec.idempotencyKey, MAX_KEY_LENGTH)) return invalid("idempotencyKey");
    let json;
    let hash;
    try {
      json = stableJson(spec.payload);
      hash = fingerprintWithPayloadJson({ eventType: type.eventType, aggregateType: type.aggregateType,
        aggregateId }, json);
    } catch (err) {
      return invalid(`payload: ${(err && err.message) || err}`);
    }
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > limits.maxPayloadBytes) {
      return { ok: false, reason: "SCHEDULER_PAYLOAD_TOO_LARGE", bytes, limit: limits.maxPayloadBytes };
    }
    const now = clock.now();
    if (!isTime(now)) return invalid("clock.now");
    const h = handles(tx);
    const seen = h.byKey.get(spec.idempotencyKey);
    if (seen) {
      if (seen.payload_hash === hash) {
        count("scheduler.duplicates");
        return { ok: true, duplicate: true, eventId: seen.event_id, state: seen.state, dueAt: seen.due_at,
          priority: seen.priority };
      }
      count("scheduler.conflicts", { key: spec.idempotencyKey, eventType: type.eventType, aggregateId,
        existingEventId: seen.event_id, existingEventType: seen.event_type, existingAggregateId: seen.aggregate_id,
        existingState: seen.state });
      return { ok: false, reason: "IDEMPOTENCY_CONFLICT", eventId: seen.event_id };
    }
    if (opts && typeof opts.admit === "function") {
      const refusal = opts.admit(type);
      if (refusal) return refusal;
    }
    const eventId = ids.next("event");
    h.insert.run(eventId, spec.idempotencyKey, type.eventType, type.aggregateType, aggregateId,
      toBind(type.priority), toBind(spec.dueAt), json, hash, toBind(now));
    return { ok: true, duplicate: false, event: Object.freeze({ eventId, eventType: type.eventType,
      priority: type.priority, workClass: type.workClass, dueAt: spec.dueAt, idempotencyKey: spec.idempotencyKey }) };
  }

  function claim(tx, eventIds, now) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(eventIds) || !eventIds.every((id) => typeof id === "string" && id !== "")) {
      return invalid("eventIds");
    }
    if (!isTime(now)) return invalid("now");
    if (eventIds.length === 0) return { ok: true, events: [], requeue: [], stale: 0 };
    const h = handles(tx);
    const rows = h.claim.all(toBind(now), JSON.stringify(eventIds), toBind(now));
    const byId = new Map(rows.map((row) => [row.event_id, row]));
    const events = [];
    const missing = [];
    for (const id of eventIds) {
      const row = byId.get(id);
      if (row) events.push(toEvent(row));
      else missing.push(id);
    }
    const requeue = [];
    if (missing.length > 0) {
      for (const row of h.peekMany.all(JSON.stringify(missing))) {
        if (CLAIMABLE.includes(row.state) && row.due_at > now) {
          requeue.push({ eventId: row.event_id, priority: row.priority, dueAt: row.due_at,
            eventType: row.event_type });
        }
      }
    }
    return { ok: true, events, requeue, stale: missing.length - requeue.length };
  }

  function complete(tx, eventId, outcome, now, beforeDone) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(eventId, MAX_KEY_LENGTH)) return invalid("eventId");
    if (!isText(outcome, MAX_OUTCOME_LENGTH)) return invalid("outcome");
    if (!isTime(now)) return invalid("now");
    const h = handles(tx);
    const row = h.byId.get(eventId);
    if (!row) return { ok: false, reason: "EVENT_NOT_FOUND" };
    if (row.state === STATE.DONE) return { ok: true, alreadyDone: true, value: undefined };
    if (row.state !== STATE.CLAIMED) return { ok: false, reason: "EVENT_STATE_INVALID", state: row.state };
    const value = typeof beforeDone === "function" ? beforeDone(toEvent(row)) : undefined;
    const info = h.done.run(outcome, toBind(now), eventId);
    if (info.changes !== 1) return { ok: false, reason: "EVENT_STATE_INVALID", state: row.state };
    return { ok: true, alreadyDone: false, value };
  }

  function retry(tx, eventId, error, now, permanent) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(eventId, MAX_KEY_LENGTH)) return invalid("eventId");
    if (!isTime(now)) return invalid("now");
    const h = handles(tx);
    const row = h.byId.get(eventId);
    if (!row) return { ok: false, reason: "EVENT_NOT_FOUND" };
    if (row.state !== STATE.CLAIMED) return { ok: false, reason: "EVENT_STATE_INVALID", state: row.state };
    const text = errorText(error);
    if (permanent === true || row.attempts >= limits.maxAttempts) {
      h.quarantine.run(text, toBind(now), eventId);
      return { ok: true, state: STATE.QUARANTINED, attempts: row.attempts, priority: row.priority, lastError: text,
        eventType: row.event_type };
    }
    const dueAt = now + backoffMs(row.attempts);
    h.retry.run(toBind(dueAt), text, eventId);
    return { ok: true, state: STATE.RETRY, dueAt, attempts: row.attempts, priority: row.priority,
      eventType: row.event_type };
  }

  function unclaim(tx, eventId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(eventId, MAX_KEY_LENGTH)) return invalid("eventId");
    const row = handles(tx).unclaim.get(eventId);
    if (!row) return { ok: false, reason: "EVENT_STATE_INVALID" };
    return { ok: true, eventId: row.event_id, priority: row.priority, dueAt: row.due_at, eventType: row.event_type };
  }

  function defer(tx, eventId, dueAt, error) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(eventId, MAX_KEY_LENGTH)) return invalid("eventId");
    if (!isTime(dueAt)) return invalid("dueAt");
    const row = handles(tx).defer.get(toBind(dueAt), errorText(error), eventId);
    if (!row) return { ok: false, reason: "EVENT_STATE_INVALID" };
    return { ok: true, state: STATE.RETRY, deferred: true, eventId: row.event_id, priority: row.priority,
      dueAt: Number(row.due_at), attempts: Number(row.attempts), eventType: row.event_type };
  }

  function recoverClaimed(tx, limit, now) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Number.isSafeInteger(limit) || limit < 1) return invalid("limit");
    if (!isTime(now)) return invalid("now");
    const max = toBind(limits.maxAttempts);
    const rows = handles(tx).recover.all(max, max, toBind(now), CLAIM_INTERRUPTED, toBind(limit));
    const quarantined = rows.filter((r) => r.state === STATE.QUARANTINED).length;
    return { ok: true, retried: rows.length - quarantined, quarantined };
  }

  function loadOpen(tx, onRow) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof onRow !== "function") return invalid("onRow");
    let rows = 0;
    for (const row of handles(tx).open.iterate()) {
      onRow(row.event_id, row.priority, row.due_at, row.event_type);
      rows += 1;
    }
    return { ok: true, rows };
  }

  function findByKey(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(key, MAX_KEY_LENGTH)) return invalid("key");
    const row = handles(tx).fullByKey.get(key);
    return row ? { ok: true, found: true, event: toEvent(row) } : { ok: true, found: false };
  }

  function findLiveOfType(tx, eventType) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!getEventType(eventType)) return { ok: false, reason: "UNKNOWN_EVENT_TYPE", eventType: String(eventType) };
    const h = handles(tx);
    if (!h.liveOfType) {
      h.liveOfType = tx.prepare(`SELECT ${ROW_COLUMNS} FROM ${TABLE_NAME}
        WHERE ${LIVE} AND state IN ('${STATE.QUEUED}', '${STATE.RETRY}', '${STATE.CLAIMED}') AND event_type = ?
        ORDER BY priority, due_at, event_id LIMIT 1`);
    }
    const row = h.liveOfType.get(eventType);
    return row ? { ok: true, found: true, event: toEvent(row) } : { ok: true, found: false };
  }

  function countQuarantined(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: handles(tx).countQuarantined.get().n };
  }

  function listQuarantined(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Number.isSafeInteger(limit) || limit < 1) return invalid("limit");
    return { ok: true, events: handles(tx).listQuarantined.all(toBind(limit)).map(toEvent) };
  }

  function purgeDone(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec !== "object") return invalid("spec");
    if (!getEventType(spec.eventType)) {
      return { ok: false, reason: "UNKNOWN_EVENT_TYPE", eventType: String(spec.eventType) };
    }
    const h = retentionHandles(tx);
    if (spec.keys !== undefined) {
      if (!Array.isArray(spec.keys) || !spec.keys.every((k) => isText(k, MAX_KEY_LENGTH))) return invalid("keys");
      let deleted = 0;
      const notDone = [];
      for (const key of spec.keys) {
        const n = h.purgeDoneKey.run(key, spec.eventType).changes;
        if (n > 0) deleted += n;
        else if (h.stateByKey.get(key)) notDone.push(key);
      }
      return { ok: true, deleted, notDone };
    }
    if (!isText(spec.fromKey, MAX_KEY_LENGTH) || !isText(spec.toKey, MAX_KEY_LENGTH) || !(spec.fromKey < spec.toKey)) {
      return invalid("range");
    }
    if (!isTime(spec.finishedBefore)) return invalid("finishedBefore");
    if (!Number.isSafeInteger(spec.limit) || spec.limit < 1) return invalid("limit");
    const info = h.purgeDoneRange.run(spec.fromKey, spec.toKey, spec.eventType, toBind(spec.finishedBefore),
      toBind(spec.limit));
    return { ok: true, deleted: info.changes, notDone: [] };
  }

  function scanKeys(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec !== "object") return invalid("spec");
    if (!isText(spec.fromKey, MAX_KEY_LENGTH) || !isText(spec.toKey, MAX_KEY_LENGTH) || !(spec.fromKey < spec.toKey)) {
      return invalid("range");
    }
    const afterKey = spec.afterKey === undefined ? null : spec.afterKey;
    if (afterKey !== null && !isText(afterKey, MAX_KEY_LENGTH)) return invalid("afterKey");
    if (!Number.isSafeInteger(spec.limit) || spec.limit < 1 || spec.limit > SCAN_KEYS_MAX_LIMIT) return invalid("limit");
    const h = retentionHandles(tx);
    const raw = afterKey === null ? h.scanFrom.all(spec.fromKey, spec.toKey, toBind(spec.limit))
      : h.scanAfter.all(afterKey, spec.toKey, toBind(spec.limit));
    const rows = raw.map((r) => ({ key: r.idempotency_key, eventType: r.event_type, state: r.state,
      finishedAt: r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at) }));
    return { ok: true, rows };
  }

  function statesOf(tx, keys) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(keys) || keys.length > SCAN_KEYS_MAX_LIMIT || !keys.every((k) => isText(k, MAX_KEY_LENGTH))) {
      return invalid("keys");
    }
    const states = new Map();
    if (keys.length === 0) return { ok: true, states };
    for (const r of retentionHandles(tx).statesOf.all(JSON.stringify(keys))) states.set(r.idempotency_key, r.state);
    return { ok: true, states };
  }

  return Object.freeze({ insert, claim, complete, retry, defer, unclaim, recoverClaimed, loadOpen, findByKey,
    findLiveOfType, countQuarantined,
    listQuarantined, backoffMs, purgeDone, scanKeys, statesOf });
}

module.exports = { createEventStore, errorText };
