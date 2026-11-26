"use strict";

const { toBind } = require("../persistence/repository");
const S = require("./schema");
const { createAbortSentinel } = require("../persistence/store");

const APPEND_ABORT = createAbortSentinel("shipAi.turns.append");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const txMissing = (db) => !db || db.inTransaction !== true;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const failed = (err) => ({ ok: false, reason: "SHIP_AI_SQL_FAILED",
  detail: String((err && err.message) || err).slice(0, 120) });

function createShipAiTurnsRepository(settings) {
  const keep = settings && isId(settings.turnsKeep) ? settings.turnsKeep : 1;
  const cache = new WeakMap();
  let lastFailure = null;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TURNS_TABLE;
    s = {
      maxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${T} WHERE player_character_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (player_character_id, seq, role, text, created_at) VALUES (?, ?, ?, ?, ?)`),
      prune: db.prepare(`DELETE FROM ${T} WHERE player_character_id = ? AND seq <= ?`),
      recent: db.prepare(`SELECT seq, role, text, created_at FROM ${T} WHERE player_character_id = ?
        ORDER BY seq DESC LIMIT ?`),
    };
    cache.set(db, s);
    return s;
  }

  function appendExchangeInTx(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || typeof s.userText !== "string" || typeof s.aiText !== "string"
      || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "exchange" };
    }
    try {
      const st = stmts(tx);
      const seq = Number(st.maxSeq.get(toBind(s.playerId)).m) + 1;
      st.insert.run(toBind(s.playerId), toBind(seq), "user", s.userText, toBind(s.nowMs));
      st.insert.run(toBind(s.playerId), toBind(seq + 1), "assistant", s.aiText, toBind(s.nowMs));
      const last = seq + 1;
      const pruned = last > keep ? Number(st.prune.run(toBind(s.playerId), toBind(last - keep)).changes) : 0;
      return { ok: true, seq: last, pruned };
    } catch (err) {
      lastFailure = failed(err);
      throw APPEND_ABORT;
    }
  }

  function listRecent(tx, playerId, n) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId) || !Number.isSafeInteger(n) || n < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "playerId/n" };
    }
    if (n === 0) return { ok: true, rows: [] };
    try {
      const rows = stmts(tx).recent.all(toBind(playerId), toBind(n))
        .map((r) => Object.freeze({ seq: Number(r.seq), role: String(r.role), text: String(r.text) }));
      return { ok: true, rows: rows.reverse() };
    } catch (err) {
      return failed(err);
    }
  }

  const lastAppendFailure = () => lastFailure;

  function maxSeq(tx, playerId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      return { ok: true, seq: Number(stmts(tx).maxSeq.get(toBind(playerId)).m) };
    } catch (err) {
      return failed(err);
    }
  }

  function pruneCoveredInTx(tx, playerId, coversThroughSeq) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId) || !Number.isSafeInteger(coversThroughSeq) || coversThroughSeq < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "prune" };
    }
    try {
      const st = stmts(tx);
      const upTo = Math.min(coversThroughSeq, Number(st.maxSeq.get(toBind(playerId)).m) - keep);
      return { ok: true, pruned: upTo > 0 ? Number(st.prune.run(toBind(playerId), toBind(upTo)).changes) : 0 };
    } catch (err) {
      lastFailure = failed(err);
      throw APPEND_ABORT;
    }
  }

  function deleteAllInTx(tx, playerId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      return { ok: true, deleted: Number(stmts(tx).prune.run(toBind(playerId), toBind(Number.MAX_SAFE_INTEGER))
        .changes) };
    } catch (err) {
      lastFailure = failed(err);
      throw APPEND_ABORT;
    }
  }

  return Object.freeze({ appendExchangeInTx, listRecent, lastAppendFailure, maxSeq, pruneCoveredInTx,
    deleteAllInTx });
}

module.exports = { createShipAiTurnsRepository, APPEND_ABORT };
