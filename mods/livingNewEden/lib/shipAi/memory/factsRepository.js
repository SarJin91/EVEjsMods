"use strict";

const { toBind } = require("../../persistence/repository");
const S = require("../schema");
const { normalizeLine } = require("../../chatterAi/filter");
const { MEMORY_ABORT } = require("./summaryRepository");
const { normKeyOf, queryWordsOf, scoreFact, DAY_MS, IMPORTANCE_MAX } = require("./extract");
const { checkInjection } = require("./guard");

const FORGET_MAX = 5;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const txMissing = (db) => !db || db.inTransaction !== true;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const failed = (err) => ({ ok: false, reason: "SHIP_AI_SQL_FAILED",
  detail: String((err && err.message) || err).slice(0, 120) });

function toFact(r) {
  return Object.freeze({ id: Number(r.fact_id), category: String(r.category), content: String(r.content),
    normKey: String(r.norm_key), importance: Number(r.importance), source: String(r.source),
    createdAt: Number(r.created_at), lastUsedAt: Number(r.last_used_at), expiresAt: Number(r.expires_at) });
}

function createShipAiFactsRepository() {
  const cache = new WeakMap();
  let lastFailure = null;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.FACTS_TABLE;
    s = {
      expire: db.prepare(`DELETE FROM ${T} WHERE player_character_id = ? AND expires_at < ?`),
      all: db.prepare(`SELECT * FROM ${T} WHERE player_character_id = ? ORDER BY fact_id`),
      byKey: db.prepare(`SELECT fact_id, importance, expires_at FROM ${T} WHERE player_character_id = ? AND norm_key = ?`),
      insert: db.prepare(`INSERT INTO ${T} (player_character_id, category, content, norm_key, importance, source,
        created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      bump: db.prepare(`UPDATE ${T} SET importance = ?, last_used_at = ?, expires_at = ? WHERE fact_id = ?`),
      touch: db.prepare(`UPDATE ${T} SET last_used_at = ? WHERE fact_id = ?`),
      del: db.prepare(`DELETE FROM ${T} WHERE fact_id = ?`),
      delOwn: db.prepare(`DELETE FROM ${T} WHERE fact_id = ? AND player_character_id = ?`),
      delAll: db.prepare(`DELETE FROM ${T} WHERE player_character_id = ?`),
      recent: db.prepare(`SELECT * FROM ${T} WHERE player_character_id = ? ORDER BY fact_id DESC LIMIT ?`),
      keys: db.prepare(`SELECT norm_key FROM ${T} WHERE player_character_id = ? ORDER BY fact_id`),
      count: db.prepare(`SELECT COUNT(*) AS n FROM ${T}`),
    };
    cache.set(db, s);
    return s;
  }

  const abort = (err) => {
    lastFailure = failed(err);
    throw MEMORY_ABORT;
  };

  const expire = (st, playerId, nowMs) => Number(st.expire.run(toBind(playerId), toBind(nowMs)).changes);

  function upsertFactsInTx(tx, playerId, facts, nowMs, settings) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId) || !Array.isArray(facts) || !isTime(nowMs) || !settings
      || !isId(settings.maxFactsPerCharacter)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "facts" };
    }
    for (const f of facts) {
      if (!f || !S.FACT_CATEGORIES.includes(f.category) || typeof f.content !== "string" || f.content === ""
        || !Number.isSafeInteger(f.importance) || f.importance < 1 || f.importance > IMPORTANCE_MAX
        || !S.FACT_SOURCES.includes(f.source) || !isId(f.ttlDays)) {
        return { ok: false, reason: "INVALID_INPUT", detail: "fact" };
      }
    }
    try {
      const st = stmts(tx);
      const out = { ok: true, inserted: 0, bumped: 0, evicted: 0, expired: expire(st, playerId, nowMs), ids: [] };
      for (const f of facts) {
        const key = normKeyOf(f.category, f.content);
        const expiresAt = nowMs + f.ttlDays * DAY_MS;
        const cur = st.byKey.get(toBind(playerId), key);
        if (cur) {
          const importance = Math.min(IMPORTANCE_MAX, Math.max(Number(cur.importance), f.importance) + 1);
          st.bump.run(toBind(importance), toBind(nowMs), toBind(Math.max(Number(cur.expires_at), expiresAt)),
            toBind(Number(cur.fact_id)));
          out.bumped += 1;
          out.ids.push(Number(cur.fact_id));
        } else {
          const r = st.insert.run(toBind(playerId), f.category, f.content, key, toBind(f.importance), f.source,
            toBind(nowMs), toBind(nowMs), toBind(expiresAt));
          out.inserted += 1;
          out.ids.push(Number(r.lastInsertRowid));
        }
      }
      const rows = st.all.all(toBind(playerId)).map(toFact);
      if (rows.length > settings.maxFactsPerCharacter) {
        const none = new Set();
        const order = rows.map((r) => ({ id: r.id, score: scoreFact(r, none, nowMs) }))
          .sort((a, b) => a.score - b.score || a.id - b.id);
        for (const victim of order.slice(0, rows.length - settings.maxFactsPerCharacter)) {
          st.del.run(toBind(victim.id));
          out.evicted += 1;
        }
        const gone = new Set(order.slice(0, out.evicted).map((v) => v.id));
        out.ids = out.ids.filter((id) => !gone.has(id));
      }
      return out;
    } catch (err) {
      return abort(err);
    }
  }

  function selectTopK(tx, playerId, queryText, k, nowMs, maxChars) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId) || !Number.isSafeInteger(k) || k < 0 || !isTime(nowMs) || !Number.isSafeInteger(maxChars)
      || maxChars < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "selectTopK" };
    }
    try {
      const st = stmts(tx);
      const expired = expire(st, playerId, nowMs);
      if (k === 0 || maxChars === 0) return { ok: true, facts: [], expired, skipped: 0 };
      const words = queryWordsOf(queryText);
      const ranked = st.all.all(toBind(playerId)).map(toFact)
        .map((f) => ({ f, score: scoreFact(f, words, nowMs) }))
        .sort((a, b) => b.score - a.score || b.f.id - a.f.id);
      const facts = [];
      let chars = 0;
      let skipped = 0;
      for (const { f } of ranked) {
        if (facts.length >= k) break;
        if (!checkInjection(f.content).ok) {
          skipped += 1;
          continue;
        }
        const size = f.category.length + 2 + f.content.length;
        if (chars + size > maxChars) continue;
        chars += size;
        facts.push(Object.freeze({ id: f.id, category: f.category, content: f.content }));
      }
      return { ok: true, facts, expired, skipped };
    } catch (err) {
      return abort(err);
    }
  }

  function touchInTx(tx, factIds, nowMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(factIds) || !factIds.every(isId) || !isTime(nowMs)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "touch" };
    }
    try {
      const st = stmts(tx);
      let touched = 0;
      for (const id of factIds) touched += Number(st.touch.run(toBind(nowMs), toBind(id)).changes);
      return { ok: true, touched };
    } catch (err) {
      return abort(err);
    }
  }

  function listForPlayer(tx, playerId, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId) || !isId(limit)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId/limit" };
    try {
      return { ok: true, facts: stmts(tx).recent.all(toBind(playerId), toBind(limit)).map(toFact) };
    } catch (err) {
      return failed(err);
    }
  }

  function keysForPlayer(tx, playerId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      return { ok: true, keys: stmts(tx).keys.all(toBind(playerId)).map((r) => String(r.norm_key)) };
    } catch (err) {
      return failed(err);
    }
  }

  function forgetMatchingInTx(tx, playerId, needle) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      const st = stmts(tx);
      if (isId(needle)) return { ok: true, deleted: Number(st.delOwn.run(toBind(needle), toBind(playerId)).changes) };
      const n = normalizeLine(String(needle ?? ""));
      if (n === "") return { ok: false, reason: "INVALID_INPUT", detail: "needle" };
      const hits = st.all.all(toBind(playerId)).map(toFact).filter((f) => normalizeLine(f.content).includes(n))
        .sort((a, b) => b.id - a.id).slice(0, FORGET_MAX);
      for (const f of hits) st.del.run(toBind(f.id));
      return { ok: true, deleted: hits.length };
    } catch (err) {
      return abort(err);
    }
  }

  function forgetAllInTx(tx, playerId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      return { ok: true, deleted: Number(stmts(tx).delAll.run(toBind(playerId)).changes) };
    } catch (err) {
      return abort(err);
    }
  }

  function countAll(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    try {
      return { ok: true, count: Number(stmts(tx).count.get().n) };
    } catch (err) {
      return failed(err);
    }
  }

  const lastWriteFailure = () => lastFailure;

  return Object.freeze({ upsertFactsInTx, selectTopK, touchInTx, listForPlayer, keysForPlayer, forgetMatchingInTx,
    forgetAllInTx, countAll, lastWriteFailure });
}

module.exports = { createShipAiFactsRepository, FORGET_MAX };
