"use strict";

const {
  JOURNAL_TABLE: T,
  JOURNAL_MAX_KEY_LENGTH,
  JOURNAL_MAX_NAME_LENGTH,
  JOURNAL_MAX_ERROR_LENGTH,
} = require("./migrations");
const { stableJson, fingerprintWithPayloadJson } = require("../util/fingerprint");

const KIND_APPLY = "APPLY";
const KIND_OUTBOX = "OUTBOX";
const STATE_PENDING = "PENDING";
const STATE_APPLIED = "APPLIED";
const STATE_FAILED = "FAILED";

const AGGREGATE_TYPE_RE = /^[a-z][a-z0-9_]*$/;
const EVENT_TYPE_RE = /^[A-Z][A-Z0-9_]*$/;

const REFUSED = Symbol("apply-refused");

const COLUMNS = "journal_id, idempotency_key, kind, aggregate_type, aggregate_id, event_type, payload, state, "
  + "created_at, applied_at, error";

function charLength(text) {
  let n = 0;
  for (const _ch of text) n += 1;
  return n;
}

function truncateChars(text, max) {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

function isText(value, max) {
  return typeof value === "string" && value !== "" && charLength(value) <= max;
}

function isJournalId(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function errorCode(err) {
  return err && typeof err.code === "string" ? err.code : undefined;
}

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

function invalid(detail) {
  return { ok: false, reason: "JOURNAL_INVALID_INPUT", detail };
}

function toEntry(row) {
  return {
    journalId: row.journal_id,
    key: row.idempotency_key,
    kind: row.kind,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    state: row.state,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    error: row.error,
    payload: JSON.parse(row.payload),
  };
}

function createJournal(opts) {
  if (!opts || typeof opts !== "object") throw new TypeError("createJournal: options missing");
  const { clock, maxPayloadBytes, maxRows, onCount } = opts;
  if (!clock || typeof clock.now !== "function") throw new TypeError("createJournal: clock.now must be a function");
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new TypeError(`createJournal: maxPayloadBytes must be a positive integer, got ${maxPayloadBytes}`);
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new TypeError(`createJournal: maxRows must be a positive integer, got ${maxRows}`);
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createJournal: onCount must be a function");
  }

  const count = (name, detail) => {
    if (!onCount) return;
    try {
      if (detail === undefined) onCount(name, 1);
      else onCount(name, 1, detail);
    } catch (_err) {
    }
  };

  const perDb = new WeakMap();
  function handles(db) {
    let h = perDb.get(db);
    if (h) return h;
    h = {
      byKey: db.prepare(`SELECT ${COLUMNS}, payload_hash FROM ${T} WHERE idempotency_key = ?`),
      byId: db.prepare(`SELECT journal_id, kind, state FROM ${T} WHERE journal_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (idempotency_key, kind, aggregate_type, aggregate_id, event_type, payload,
        payload_hash, state, created_at, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      markApplied: db.prepare(`UPDATE ${T} SET state = '${STATE_APPLIED}', applied_at = ?
        WHERE journal_id = ? AND kind = '${KIND_OUTBOX}' AND state = '${STATE_PENDING}'`),
      markFailed: db.prepare(`UPDATE ${T} SET state = '${STATE_FAILED}', error = ?
        WHERE journal_id = ? AND kind = '${KIND_OUTBOX}' AND state = '${STATE_PENDING}'`),
      pending: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state = '${STATE_PENDING}'
        ORDER BY created_at, journal_id LIMIT ?`),
      recent: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE journal_id > ? ORDER BY journal_id DESC LIMIT ?`),
      countRange: db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${T} WHERE idempotency_key >= ?
        AND idempotency_key < ? LIMIT ?)`),
      retention: null,
      tail: null,
      savepoint: null,
    };
    h.savepoint = db.transaction((holder, row, applyFn) => {
      holder.journalId = Number(h.insert.run(...row).lastInsertRowid);
      const value = applyFn(db, { journalId: holder.journalId });
      if (value && value.ok === false) {
        holder.refusal = value;
        throw REFUSED;
      }
      return value;
    });
    perDb.set(db, h);
    return h;
  }

  function retentionHandles(db) {
    const h = handles(db);
    if (h.retention) return h.retention;
    h.retention = {
      scanFrom: db.prepare(`SELECT journal_id, idempotency_key, kind, event_type, state, created_at, applied_at
        FROM ${T} WHERE idempotency_key >= ? AND idempotency_key < ? ORDER BY idempotency_key LIMIT ?`),
      scanAfter: db.prepare(`SELECT journal_id, idempotency_key, kind, event_type, state, created_at, applied_at
        FROM ${T} WHERE idempotency_key > ? AND idempotency_key < ? ORDER BY idempotency_key LIMIT ?`),
      scanRecent: db.prepare(`SELECT journal_id, idempotency_key, kind, event_type, state, created_at, applied_at
        FROM ${T} WHERE idempotency_key >= ? AND idempotency_key < ? ORDER BY journal_id DESC LIMIT ?`),
      purgeTerminal: db.prepare(`DELETE FROM ${T} WHERE journal_id IN (SELECT value FROM json_each(?))
        AND state IN ('${STATE_APPLIED}', '${STATE_FAILED}') AND idempotency_key >= ? AND idempotency_key < ?`),
    };
    return h.retention;
  }

  function tailHandles(db) {
    const h = handles(db);
    if (h.tail) return h.tail;
    h.tail = {
      after: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE journal_id > ? AND journal_id <= ?
        AND aggregate_type IN (SELECT value FROM json_each(?)) ORDER BY journal_id LIMIT ?`),
      head: db.prepare(`SELECT max(coalesce((SELECT max(journal_id) FROM ${T}), 0),
        coalesce((SELECT seq FROM sqlite_sequence WHERE name = '${T}'), 0)) AS h`),
    };
    return h.tail;
  }

  function readNow() {
    const now = clock.now();
    return Number.isSafeInteger(now) && now >= 0 ? now : undefined;
  }

  function prepareEntry(kind, spec) {
    if (!spec || typeof spec !== "object") return invalid("spec");
    if (!isText(spec.key, JOURNAL_MAX_KEY_LENGTH)) return invalid("key");
    const aggregate = spec.aggregate;
    if (!aggregate || typeof aggregate !== "object") return invalid("aggregate");
    if (!isText(aggregate.type, JOURNAL_MAX_NAME_LENGTH) || !AGGREGATE_TYPE_RE.test(aggregate.type)) {
      return invalid("aggregate.type");
    }
    let aggregateId;
    if (Number.isSafeInteger(aggregate.id)) aggregateId = String(aggregate.id);
    else if (isText(aggregate.id, JOURNAL_MAX_KEY_LENGTH)) aggregateId = aggregate.id;
    else return invalid("aggregate.id");
    if (!isText(spec.eventType, JOURNAL_MAX_NAME_LENGTH) || !EVENT_TYPE_RE.test(spec.eventType)) {
      return invalid("eventType");
    }
    let json;
    let hash;
    try {
      json = stableJson(spec.payload);
      hash = fingerprintWithPayloadJson({ kind, aggregateType: aggregate.type, aggregateId,
        eventType: spec.eventType }, json);
    } catch (err) {
      return invalid(`payload: ${(err && err.message) || err}`);
    }
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > maxPayloadBytes) {
      return { ok: false, reason: "JOURNAL_PAYLOAD_TOO_LARGE", bytes, limit: maxPayloadBytes };
    }
    return { ok: true, kind, key: spec.key, aggregateType: aggregate.type, aggregateId, eventType: spec.eventType,
      json, hash };
  }

  function existing(h, entry) {
    const row = h.byKey.get(entry.key);
    if (!row) return null;
    if (row.payload_hash === entry.hash) {
      count("journal.duplicate");
      return { ok: true, duplicate: true, journalId: row.journal_id, state: row.state };
    }
    count("journal.conflict", Object.freeze({ kind: entry.kind, key: entry.key, eventType: entry.eventType,
      aggregateType: entry.aggregateType, aggregateId: entry.aggregateId, journalId: row.journal_id,
      existingKind: row.kind, existingEventType: row.event_type, existingAggregateType: row.aggregate_type,
      existingAggregateId: row.aggregate_id }));
    return { ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: row.journal_id };
  }

  function applyOnce(tx, spec, applyFn) {
    if (txMissing(tx)) return TX_REQUIRED;
    const entry = prepareEntry(KIND_APPLY, spec);
    if (!entry.ok) return entry;
    if (typeof applyFn !== "function") return invalid("applyFn");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const h = handles(tx);
    const seen = existing(h, entry);
    if (seen) return seen;
    const row = [entry.key, KIND_APPLY, entry.aggregateType, entry.aggregateId, entry.eventType, entry.json,
      entry.hash, STATE_APPLIED, now, now];
    const holder = { journalId: undefined, refusal: undefined };
    try {
      const value = h.savepoint(holder, row, applyFn);
      return { ok: true, duplicate: false, journalId: holder.journalId, value };
    } catch (err) {
      if (tx.inTransaction !== true) throw err;
      if (err === REFUSED) return { ok: false, reason: "APPLY_REFUSED", refusal: holder.refusal };
      return { ok: false, reason: "APPLY_FAILED", error: err, code: errorCode(err) };
    }
  }

  function enqueueOutbox(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    const entry = prepareEntry(KIND_OUTBOX, spec);
    if (!entry.ok) return entry;
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const h = handles(tx);
    const seen = existing(h, entry);
    if (seen) return seen;
    const info = h.insert.run(entry.key, KIND_OUTBOX, entry.aggregateType, entry.aggregateId, entry.eventType,
      entry.json, entry.hash, STATE_PENDING, now, null);
    return { ok: true, duplicate: false, journalId: Number(info.lastInsertRowid) };
  }

  function explain(h, journalId) {
    const row = h.byId.get(journalId);
    if (!row) return { ok: false, reason: "JOURNAL_NOT_FOUND" };
    if (row.kind !== KIND_OUTBOX) return { ok: false, reason: "JOURNAL_NOT_OUTBOX" };
    return { state: row.state };
  }

  function markApplied(tx, journalId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isJournalId(journalId)) return invalid("journalId");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const h = handles(tx);
    if (h.markApplied.run(now, journalId).changes === 1) return { ok: true, alreadyApplied: false };
    const why = explain(h, journalId);
    if (why.ok === false) return why;
    if (why.state === STATE_APPLIED) return { ok: true, alreadyApplied: true };
    return { ok: false, reason: "JOURNAL_STATE_INVALID", state: why.state };
  }

  function markFailed(tx, journalId, detail) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isJournalId(journalId)) return invalid("journalId");
    if (typeof detail !== "string") return invalid("detail");
    const h = handles(tx);
    if (h.markFailed.run(truncateChars(detail, JOURNAL_MAX_ERROR_LENGTH), journalId).changes === 1) {
      return { ok: true, alreadyFailed: false };
    }
    const why = explain(h, journalId);
    if (why.ok === false) return why;
    if (why.state === STATE_FAILED) return { ok: true, alreadyFailed: true };
    return { ok: false, reason: "JOURNAL_STATE_INVALID", state: why.state };
  }

  function readLimit(options) {
    const limit = options && options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1) return undefined;
    return Math.min(limit, maxRows);
  }

  function listPending(tx, options) {
    if (txMissing(tx)) return TX_REQUIRED;
    const limit = readLimit(options);
    if (limit === undefined) return invalid("limit");
    return { ok: true, entries: handles(tx).pending.all(limit).map(toEntry), limit };
  }

  function listRecent(tx, options) {
    if (txMissing(tx)) return TX_REQUIRED;
    const limit = readLimit(options);
    if (limit === undefined) return invalid("limit");
    const afterId = options.afterId === undefined ? 0 : options.afterId;
    if (!Number.isSafeInteger(afterId) || afterId < 0) return invalid("afterId");
    return { ok: true, entries: handles(tx).recent.all(afterId, limit).map(toEntry), limit };
  }

  function findByKey(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(key, JOURNAL_MAX_KEY_LENGTH)) return invalid("key");
    const row = handles(tx).byKey.get(key);
    return row ? { ok: true, found: true, entry: toEntry(row) } : { ok: true, found: false };
  }

  function countKeyRange(tx, fromKey, toKey, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(fromKey, JOURNAL_MAX_KEY_LENGTH)) return invalid("fromKey");
    if (!isText(toKey, JOURNAL_MAX_KEY_LENGTH)) return invalid("toKey");
    if (!(fromKey < toKey)) return invalid("range");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRows) return invalid("limit");
    return { ok: true, count: handles(tx).countRange.get(fromKey, toKey, limit).n };
  }

  function checkRange(fromKey, toKey) {
    if (!isText(fromKey, JOURNAL_MAX_KEY_LENGTH)) return invalid("fromKey");
    if (!isText(toKey, JOURNAL_MAX_KEY_LENGTH)) return invalid("toKey");
    if (!(fromKey < toKey)) return invalid("range");
    return null;
  }

  function scanKeyRange(tx, fromKey, toKey, limit, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = checkRange(fromKey, toKey);
    if (bad) return bad;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRows) return invalid("limit");
    const h = retentionHandles(tx);
    let stmt;
    if (opts && opts.order === "recent") {
      if (opts && opts.after === true) return invalid("opts");
      stmt = h.scanRecent;
    } else {
      stmt = opts && opts.after === true ? h.scanAfter : h.scanFrom;
    }
    return { ok: true, rows: stmt.all(fromKey, toKey, limit).map((row) => ({ journalId: row.journal_id,
      key: row.idempotency_key, kind: row.kind, eventType: row.event_type, state: row.state,
      createdAt: row.created_at, appliedAt: row.applied_at })) };
  }

  function purgeTerminal(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec !== "object") return invalid("spec");
    const bad = checkRange(spec.fromKey, spec.toKey);
    if (bad) return bad;
    const ids = spec.journalIds;
    if (!Array.isArray(ids) || ids.length > maxRows || !ids.every(isJournalId)) return invalid("journalIds");
    if (ids.length === 0) return { ok: true, deleted: 0 };
    const info = retentionHandles(tx).purgeTerminal.run(JSON.stringify(ids), spec.fromKey, spec.toKey);
    return { ok: true, deleted: info.changes };
  }

  function listAfter(tx, options) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = options || {};
    if (!Number.isSafeInteger(o.afterId) || o.afterId < 0) return invalid("afterId");
    if (!Number.isSafeInteger(o.uptoId) || o.uptoId < o.afterId) return invalid("uptoId");
    const types = o.aggregateTypes;
    if (!Array.isArray(types) || types.length === 0 || types.length > maxRows
      || !types.every((t) => typeof t === "string" && AGGREGATE_TYPE_RE.test(t))) {
      return invalid("aggregateTypes");
    }
    if (!Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > maxRows) return invalid("limit");
    if (o.uptoId === o.afterId) return { ok: true, entries: [], scannedUpTo: o.uptoId };
    const entries = tailHandles(tx).after.all(o.afterId, o.uptoId, JSON.stringify(types), o.limit).map((row) => {
      const e = toEntry(row);
      e.journalId = Number(e.journalId);
      e.createdAt = Number(e.createdAt);
      return e;
    });
    const scannedUpTo = entries.length === o.limit ? entries[entries.length - 1].journalId : o.uptoId;
    return { ok: true, entries, scannedUpTo };
  }

  function headId(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, headId: Number(tailHandles(tx).head.get().h) };
  }

  return Object.freeze({ applyOnce, enqueueOutbox, markApplied, markFailed, listPending, listRecent, findByKey,
    countKeyRange, scanKeyRange, purgeTerminal, listAfter, headId });
}

module.exports = { createJournal, KIND_APPLY, KIND_OUTBOX, STATE_PENDING, STATE_APPLIED, STATE_FAILED };
