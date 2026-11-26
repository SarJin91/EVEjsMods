"use strict";

const { toBind } = require("../persistence/repository");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNeg = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));

function createChatterReads() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      speakerCorp: db.prepare("SELECT corp_id, archetype, state, name, ticker, home_system_id FROM world_free_corps "
        + "WHERE corp_id = ?"),
      openVentureDetail: db.prepare("SELECT kind, state, system_id, crew, yield_isk FROM world_free_corp_ventures "
        + "WHERE open = 1 AND corp_id = ?"),
      lastClosed: db.prepare("SELECT kind, state, end_reason, target_system_id, crew_lost, yield_isk, ended_at "
        + "FROM world_free_corp_ventures WHERE corp_id = ? AND open = 0 ORDER BY seq DESC LIMIT 1"),
      news: db.prepare("SELECT v.venture_id, v.kind, v.state, v.target_system_id, v.crew_lost, v.yield_isk, "
        + "v.ended_at, c.name, c.archetype FROM world_free_corp_ventures v JOIN world_free_corps c "
        + "ON c.corp_id = v.corp_id WHERE v.open = 0 AND v.ended_at >= ? AND (v.ended_at > ? OR v.venture_id > ?) "
        + "AND ((v.state = 'LOST' AND v.crew_lost >= ?) OR (v.state = 'DONE' AND v.kind <> 'BUILD' "
        + "AND v.yield_isk >= ?)) ORDER BY v.ended_at, v.venture_id LIMIT ?"),
    };
    cache.set(db, s);
    return s;
  }

  function speakerCorpInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    const r = stmts(tx).speakerCorp.get(toBind(corpId));
    return { ok: true, rows: r ? [Object.freeze({ corpId: num(r.corp_id), archetype: String(r.archetype),
      state: String(r.state), name: String(r.name), ticker: String(r.ticker),
      homeSystemId: num(r.home_system_id) })] : [] };
  }

  function openVentureDetailInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    const r = stmts(tx).openVentureDetail.get(toBind(corpId));
    return { ok: true, rows: r ? [Object.freeze({ kind: String(r.kind), state: String(r.state),
      systemId: num(r.system_id), crew: num(r.crew), yieldIsk: num(r.yield_isk) })] : [] };
  }

  function lastClosedInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    const r = stmts(tx).lastClosed.get(toBind(corpId));
    return { ok: true, rows: r ? [Object.freeze({ kind: String(r.kind), state: String(r.state),
      endReason: r.end_reason === null || r.end_reason === undefined ? null : String(r.end_reason),
      targetSystemId: num(r.target_system_id), crewLost: num(r.crew_lost), yieldIsk: num(r.yield_isk),
      endedAt: num(r.ended_at) })] : [] };
  }

  function newsInTx(tx, q) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!q || !isNonNeg(q.afterAt) || !isId(q.minCrewLost) || !isNonNeg(q.minYieldIsk) || !isId(q.limit)
      || !(q.afterId === undefined || q.afterId === null || typeof q.afterId === "string")) {
      return invalid("afterAt/afterId/minCrewLost/minYieldIsk/limit");
    }
    const afterId = typeof q.afterId === "string" ? q.afterId : "";
    const rows = stmts(tx).news.all(toBind(q.afterAt), toBind(q.afterAt), afterId, toBind(q.minCrewLost),
      toBind(q.minYieldIsk), toBind(q.limit))
      .map((r) => Object.freeze({ ventureId: String(r.venture_id), kind: String(r.kind), state: String(r.state),
        targetSystemId: num(r.target_system_id), crewLost: num(r.crew_lost), yieldIsk: num(r.yield_isk),
        endedAt: num(r.ended_at), corpName: String(r.name), archetype: String(r.archetype) }));
    return { ok: true, rows };
  }

  return Object.freeze({ speakerCorpInTx, openVentureDetailInTx, lastClosedInTx, newsInTx });
}

module.exports = { createChatterReads };
