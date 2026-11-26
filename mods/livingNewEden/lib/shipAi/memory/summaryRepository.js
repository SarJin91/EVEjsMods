"use strict";

const { toBind } = require("../../persistence/repository");
const { createAbortSentinel } = require("../../persistence/store");
const S = require("../schema");

const MEMORY_ABORT = createAbortSentinel("shipAi.memory");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const txMissing = (db) => !db || db.inTransaction !== true;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const failed = (err) => ({ ok: false, reason: "SHIP_AI_SQL_FAILED",
  detail: String((err && err.message) || err).slice(0, 120) });

function createShipAiSummaryRepository() {
  const cache = new WeakMap();
  let lastFailure = null;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.SUMMARIES_TABLE;
    s = {
      get: db.prepare(`SELECT version, text, covers_through_seq, updated_at FROM ${T} WHERE player_character_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (player_character_id, version, text, covers_through_seq, updated_at)
        VALUES (?, 1, ?, ?, ?)`),
      update: db.prepare(`UPDATE ${T} SET version = version + 1, text = ?, covers_through_seq = ?, updated_at = ?
        WHERE player_character_id = ? AND covers_through_seq < ?`),
      del: db.prepare(`DELETE FROM ${T} WHERE player_character_id = ?`),
    };
    cache.set(db, s);
    return s;
  }

  const abort = (err) => {
    lastFailure = failed(err);
    throw MEMORY_ABORT;
  };

  function readSummary(tx, playerId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      const r = stmts(tx).get.get(toBind(playerId));
      return { ok: true, row: r ? Object.freeze({ version: Number(r.version), text: String(r.text),
        coversThroughSeq: Number(r.covers_through_seq), updatedAt: Number(r.updated_at) }) : null };
    } catch (err) {
      return failed(err);
    }
  }

  function writeSummaryInTx(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || typeof s.text !== "string" || !Number.isSafeInteger(s.coversThroughSeq)
      || s.coversThroughSeq < 0 || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "summary" };
    }
    try {
      const st = stmts(tx);
      const cur = st.get.get(toBind(s.playerId));
      if (!cur) {
        st.insert.run(toBind(s.playerId), s.text, toBind(s.coversThroughSeq), toBind(s.nowMs));
        return { ok: true, version: 1 };
      }
      if (Number(cur.covers_through_seq) >= s.coversThroughSeq) return { ok: false, reason: "STALE" };
      st.update.run(s.text, toBind(s.coversThroughSeq), toBind(s.nowMs), toBind(s.playerId),
        toBind(s.coversThroughSeq));
      return { ok: true, version: Number(cur.version) + 1 };
    } catch (err) {
      return abort(err);
    }
  }

  function deleteInTx(tx, playerId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      return { ok: true, deleted: Number(stmts(tx).del.run(toBind(playerId)).changes) };
    } catch (err) {
      return abort(err);
    }
  }

  const lastWriteFailure = () => lastFailure;

  return Object.freeze({ readSummary, writeSummaryInTx, deleteInTx, lastWriteFailure });
}

module.exports = { createShipAiSummaryRepository, MEMORY_ABORT };
