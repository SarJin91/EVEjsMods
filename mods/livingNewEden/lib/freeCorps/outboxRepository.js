"use strict";

const { toBind } = require("../persistence/repository");
const { OUTBOX_KINDS, MAX_OUTBOX_PAYLOAD, MAX_OUTBOX_ERROR } = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const CAS_CONFLICT = Object.freeze({ ok: false, reason: "CAS_CONFLICT" });
const DUPLICATE = Object.freeze({ ok: false, reason: "DUPLICATE" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isKey = (v) => typeof v === "string" && v.length >= 12 && v.length <= 96;
const isKind = (v) => OUTBOX_KINDS.includes(v);
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const errorOf = (e) => String(e === null || e === undefined ? "" : e).slice(0, MAX_OUTBOX_ERROR);

const COLUMNS = "key, kind, payload, state, attempts, next_at, created_at, attempted_at, ended_at, result_id, "
  + "last_error, version";

function rowOf(r) {
  return Object.freeze({ key: r.key, kind: r.kind, payload: r.payload, state: r.state, attempts: num(r.attempts),
    next_at: num(r.next_at), created_at: num(r.created_at), attempted_at: num(r.attempted_at),
    ended_at: num(r.ended_at), result_id: num(r.result_id), last_error: r.last_error === undefined ? null
      : r.last_error, version: num(r.version) });
}

function isUnique(err) {
  return Boolean(err && typeof err.code === "string"
    && (err.code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || err.code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")))
    || Boolean(err && /UNIQUE constraint failed/.test(String(err.message)));
}

function createFreeCorpOutboxRepository() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      insert: db.prepare("INSERT INTO world_free_corp_outbox (key, kind, payload, state, attempts, next_at, created_at, "
        + "attempted_at, ended_at, result_id, last_error, version) VALUES (?, ?, ?, 'PENDING', 0, ?, ?, NULL, NULL, "
        + "NULL, NULL, 1)"),
      countPending: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_outbox WHERE state = 'PENDING' AND kind = ?"),
      lastAttempt: db.prepare("SELECT MAX(attempted_at) AS at FROM world_free_corp_outbox "
        + "WHERE attempted_at IS NOT NULL AND kind = ?"),
      nextDue: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_outbox WHERE state = 'PENDING' AND kind = ? `
        + "AND next_at <= ? ORDER BY next_at, key LIMIT 1"),
      claim: db.prepare("UPDATE world_free_corp_outbox SET attempts = attempts + 1, attempted_at = ?, "
        + "version = version + 1 WHERE key = ? AND version = ? AND state = 'PENDING'"),
      complete: db.prepare("UPDATE world_free_corp_outbox SET state = 'DONE', ended_at = ?, result_id = ?, "
        + "last_error = NULL, version = version + 1 WHERE key = ? AND version = ? AND state = 'PENDING'"),
      retry: db.prepare("UPDATE world_free_corp_outbox SET next_at = ?, last_error = ?, version = version + 1 "
        + "WHERE key = ? AND version = ? AND state = 'PENDING'"),
      fail: db.prepare("UPDATE world_free_corp_outbox SET state = 'FAILED', ended_at = ?, last_error = ?, "
        + "version = version + 1 WHERE key = ? AND version = ? AND state = 'PENDING'"),
      expire: db.prepare("UPDATE world_free_corp_outbox SET state = 'FAILED', ended_at = ?, last_error = 'EXPIRED', "
        + "version = version + 1 WHERE key IN (SELECT key FROM world_free_corp_outbox WHERE state = 'PENDING' "
        + "AND kind = ? AND created_at < ? ORDER BY next_at, key LIMIT ?)"),
      prune: db.prepare("DELETE FROM world_free_corp_outbox WHERE key IN (SELECT key FROM world_free_corp_outbox "
        + "WHERE state <> 'PENDING' AND ended_at < ? ORDER BY ended_at, key LIMIT ?)"),
      endedSince: db.prepare("SELECT state, COUNT(*) AS n FROM world_free_corp_outbox WHERE state <> 'PENDING' "
        + "AND ended_at >= ? AND kind = ? GROUP BY state ORDER BY state"),
      lastResult: db.prepare("SELECT result_id FROM world_free_corp_outbox WHERE state <> 'PENDING' AND kind = ? "
        + "AND result_id IS NOT NULL ORDER BY ended_at DESC, key DESC LIMIT 1"),
      recent: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_outbox WHERE kind = ? `
        + "ORDER BY created_at DESC, key DESC LIMIT ?"),
      get: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_outbox WHERE key = ?`),
    };
    cache.set(db, s);
    return s;
  }

  function enqueueInTx(tx, { key, kind, payload, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key)) return invalid("key");
    if (!isKind(kind)) return invalid("kind");
    if (!isTime(now)) return invalid("now");
    if (!payload || typeof payload !== "object") return invalid("payload");
    let text;
    try {
      text = JSON.stringify(payload);
    } catch (_err) {
      return invalid("payload");
    }
    if (typeof text !== "string" || text.length > MAX_OUTBOX_PAYLOAD) return invalid("payload");
    try {
      stmts(tx).insert.run(key, kind, text, toBind(now), toBind(now));
    } catch (err) {
      if (isUnique(err)) return DUPLICATE;
      throw err;
    }
    return { ok: true, key };
  }

  function countPendingInTx(tx, { kind } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKind(kind)) return invalid("kind");
    const r = stmts(tx).countPending.get(kind);
    return { ok: true, count: num(r.n) };
  }

  function lastAttemptAtInTx(tx, { kind } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKind(kind)) return invalid("kind");
    const r = stmts(tx).lastAttempt.get(kind);
    return { ok: true, at: r ? num(r.at) : null };
  }

  function nextDueInTx(tx, { kind, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKind(kind)) return invalid("kind");
    if (!isTime(now)) return invalid("now");
    const r = stmts(tx).nextDue.get(kind, toBind(now));
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function claimInTx(tx, { key, expectedVersion, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key) || !isId(expectedVersion) || !isTime(now)) return invalid("claim");
    const info = stmts(tx).claim.run(toBind(now), key, toBind(expectedVersion));
    return info.changes === 1 ? { ok: true, version: expectedVersion + 1 } : CAS_CONFLICT;
  }

  function completeInTx(tx, { key, expectedVersion, now, resultId } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key) || !isId(expectedVersion) || !isTime(now) || !isId(resultId)) return invalid("complete");
    const info = stmts(tx).complete.run(toBind(now), toBind(resultId), key, toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function retryInTx(tx, { key, expectedVersion, nextAt, error } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key) || !isId(expectedVersion) || !isTime(nextAt)) return invalid("retry");
    const info = stmts(tx).retry.run(toBind(nextAt), errorOf(error), key, toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function failInTx(tx, { key, expectedVersion, now, error } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key) || !isId(expectedVersion) || !isTime(now)) return invalid("fail");
    const info = stmts(tx).fail.run(toBind(now), errorOf(error), key, toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function expireInTx(tx, { kind, before, now, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKind(kind)) return invalid("kind");
    if (!isTime(before) || !isTime(now) || !isId(limit)) return invalid("before/now/limit");
    const info = stmts(tx).expire.run(toBind(now), kind, toBind(before), toBind(limit));
    return { ok: true, expired: Number(info.changes) };
  }

  function pruneInTx(tx, { before, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isId(limit)) return invalid("before/limit");
    return { ok: true, deleted: Number(stmts(tx).prune.run(toBind(before), toBind(limit)).changes) };
  }

  function statsInTx(tx, { kind, since } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKind(kind)) return invalid("kind");
    if (!isTime(since)) return invalid("since");
    const s = stmts(tx);
    const pending = num(s.countPending.get(kind).n);
    let doneSince = 0;
    let failedSince = 0;
    for (const r of s.endedSince.all(toBind(since), kind)) {
      if (r.state === "DONE") doneSince = num(r.n);
      else if (r.state === "FAILED") failedSince = num(r.n);
    }
    const last = s.lastResult.get(kind);
    return { ok: true, pending, doneSince, failedSince, lastResultId: last ? num(last.result_id) : null };
  }

  function recentInTx(tx, { kind, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKind(kind)) return invalid("kind");
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).recent.all(kind, toBind(limit)).map(rowOf) };
  }

  function getInTx(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key)) return invalid("key");
    const r = stmts(tx).get.get(key);
    return { ok: true, row: r ? rowOf(r) : null };
  }

  return Object.freeze({ enqueueInTx, countPendingInTx, lastAttemptAtInTx, nextDueInTx, claimInTx, completeInTx,
    retryInTx, failInTx, expireInTx, pruneInTx, statsInTx, recentInTx, getInTx });
}

module.exports = { createFreeCorpOutboxRepository };
