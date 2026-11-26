"use strict";

const { toBind } = require("../../persistence/repository");
const S = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const VERSION_CONFLICT = Object.freeze({ ok: false, reason: "VERSION_CONFLICT" });
const MAX_PAGE = 5000;

const ROW_COLUMNS = "system_id, mil_points, ind_points, trade_points, mil_trend, ind_trend, trade_trend, "
  + "controller_faction_id, decay_permille, anchor_at, last_input_at, kill_window_at, kill_window_points, "
  + "invested_isk_total, created_at, updated_at, version";

const INVEST_COLUMNS = "invest_id, idempotency_key, character_id, system_id, index_kind, amount_isk, points, state, "
  + "end_reason, attempts, next_attempt_at, created_at, updated_at, version";
const DUPLICATE = Object.freeze({ ok: false, reason: "DUPLICATE" });
const NOT_FOUND = Object.freeze({ ok: false, reason: "NOT_FOUND" });

const txMissing = (tx) => !tx || tx.inTransaction !== true;
const invalid = (detail) => ({ ok: false, reason: "INVALID", detail });
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isLimit = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_PAGE;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const isPoints = (v) => Number.isSafeInteger(v) && v >= 0 && v <= S.MAX_POINTS_CAP;
const isTrend = (v) => v === -1 || v === 0 || v === 1;

function rowOf(r) {
  return Object.freeze({ systemId: Number(r.system_id), mil: Number(r.mil_points), ind: Number(r.ind_points),
    trade: Number(r.trade_points), milTrend: Number(r.mil_trend), indTrend: Number(r.ind_trend),
    tradeTrend: Number(r.trade_trend), controllerFactionId: num(r.controller_faction_id),
    decayPermille: Number(r.decay_permille), anchorAt: Number(r.anchor_at), lastInputAt: num(r.last_input_at),
    killWindowAt: Number(r.kill_window_at), killWindowPoints: Number(r.kill_window_points),
    investedIskTotal: Number(r.invested_isk_total), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    version: Number(r.version) });
}

function cursorOf(r) {
  return Object.freeze({ source: r.source, afterAt: Number(r.after_at), afterNo: Number(r.after_no),
    afterKey: r.after_key, facts: Number(r.facts), updatedAt: Number(r.updated_at), version: Number(r.version) });
}

function investOf(r) {
  return Object.freeze({ investId: r.invest_id, idempotencyKey: r.idempotency_key, characterId: Number(r.character_id),
    systemId: Number(r.system_id), kind: r.index_kind, amount: Number(r.amount_isk), points: Number(r.points),
    state: r.state, endReason: r.end_reason, attempts: Number(r.attempts), nextAttemptAt: num(r.next_attempt_at),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), version: Number(r.version) });
}

function badField(row) {
  if (!row || typeof row !== "object") return "row";
  if (!isId(row.systemId)) return "systemId";
  for (const k of ["mil", "ind", "trade"]) if (!isPoints(row[k])) return k;
  for (const k of ["milTrend", "indTrend", "tradeTrend"]) if (!isTrend(row[k])) return k;
  if (row.controllerFactionId !== null && !isId(row.controllerFactionId)) return "controllerFactionId";
  if (!Number.isSafeInteger(row.decayPermille) || row.decayPermille < 1 || row.decayPermille > 10000) {
    return "decayPermille";
  }
  for (const k of ["anchorAt", "killWindowAt", "killWindowPoints", "createdAt"]) if (!isTime(row[k])) return k;
  if (row.lastInputAt !== null && !isTime(row.lastInputAt)) return "lastInputAt";
  if (!isTime(row.investedIskTotal) || row.investedIskTotal > S.MAX_ISK_TOTAL) return "investedIskTotal";
  if (!isTime(row.version)) return "version";
  return null;
}

function createDevIndicesRepository() {
  const perDb = new WeakMap();

  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      byId: db.prepare(`SELECT ${ROW_COLUMNS} FROM ${S.TABLES.SYSTEMS} WHERE system_id = ?`),
      page: db.prepare(`SELECT ${ROW_COLUMNS} FROM ${S.TABLES.SYSTEMS} WHERE system_id > ? ORDER BY system_id LIMIT ?`),
      oldest: db.prepare(`SELECT ${ROW_COLUMNS} FROM ${S.TABLES.SYSTEMS} WHERE anchor_at < ?
        ORDER BY anchor_at, system_id LIMIT ?`),
      insert: db.prepare(`INSERT INTO ${S.TABLES.SYSTEMS} (system_id, mil_points, ind_points, trade_points, mil_trend,
        ind_trend, trade_trend, controller_faction_id, decay_permille, anchor_at, last_input_at, kill_window_at,
        kill_window_points, invested_isk_total, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`),
      update: db.prepare(`UPDATE ${S.TABLES.SYSTEMS} SET mil_points = ?, ind_points = ?, trade_points = ?,
        mil_trend = ?, ind_trend = ?, trade_trend = ?, controller_faction_id = ?, decay_permille = ?, anchor_at = ?,
        last_input_at = ?, kill_window_at = ?, kill_window_points = ?, invested_isk_total = ?, updated_at = ?,
        version = version + 1 WHERE system_id = ? AND version = ?`),
      remove: db.prepare(`DELETE FROM ${S.TABLES.SYSTEMS} WHERE system_id = ? AND version = ?`),
      cursor: db.prepare(`SELECT source, after_at, after_no, after_key, facts, updated_at, version
        FROM ${S.TABLES.CURSORS} WHERE source = ?`),
      upsertCursor: db.prepare(`INSERT INTO ${S.TABLES.CURSORS} (source, after_at, after_no, after_key, facts,
        updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (source) DO UPDATE SET after_at = excluded.after_at, after_no = excluded.after_no,
        after_key = excluded.after_key, facts = excluded.facts, updated_at = excluded.updated_at,
        version = ${S.TABLES.CURSORS}.version + 1`),
      listCursors: db.prepare(`SELECT source, after_at, after_no, after_key, facts, updated_at, version
        FROM ${S.TABLES.CURSORS} ORDER BY source`),
      investById: db.prepare(`SELECT ${INVEST_COLUMNS} FROM ${S.TABLES.INVESTMENTS} WHERE invest_id = ?`),
      investByKey: db.prepare(`SELECT ${INVEST_COLUMNS} FROM ${S.TABLES.INVESTMENTS} WHERE idempotency_key = ?`),
      characterIsk: db.prepare(`SELECT coalesce(sum(amount_isk), 0) AS n FROM ${S.TABLES.INVESTMENTS}
        WHERE character_id = ? AND created_at >= ? AND state IN ('PENDING', 'APPLIED')`),
      systemPoints: db.prepare(`SELECT coalesce(sum(points), 0) AS n FROM ${S.TABLES.INVESTMENTS}
        WHERE system_id = ? AND created_at >= ? AND state IN ('PENDING', 'APPLIED')`),
      investInsert: db.prepare(`INSERT INTO ${S.TABLES.INVESTMENTS} (invest_id, idempotency_key, character_id,
        system_id, index_kind, amount_isk, points, state, end_reason, attempts, next_attempt_at, created_at, updated_at,
        version) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, 0, ?, ?, ?, 1)`),
      investUpdate: db.prepare(`UPDATE ${S.TABLES.INVESTMENTS} SET state = ?, end_reason = ?, attempts = ?,
        next_attempt_at = ?, updated_at = ?, version = version + 1 WHERE invest_id = ? AND version = ?`),
      investDue: db.prepare(`SELECT ${INVEST_COLUMNS} FROM ${S.TABLES.INVESTMENTS}
        WHERE state = 'PENDING' AND next_attempt_at <= ? ORDER BY next_attempt_at, invest_id LIMIT ?`),
      investPending: db.prepare(`SELECT count(*) AS n FROM ${S.TABLES.INVESTMENTS} WHERE state = 'PENDING'`),
      investOld: db.prepare(`SELECT invest_id FROM ${S.TABLES.INVESTMENTS} WHERE state = ? AND updated_at < ?
        ORDER BY updated_at LIMIT ?`),
      investDelete: db.prepare(`DELETE FROM ${S.TABLES.INVESTMENTS} WHERE invest_id = ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function getInTx(tx, systemId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    const r = stmts(tx).byId.get(toBind(systemId));
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function listPageInTx(tx, afterSystemId, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(afterSystemId)) return invalid("afterSystemId");
    if (!isLimit(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).page.all(toBind(afterSystemId), toBind(limit)).map(rowOf) };
  }

  function listOldestInTx(tx, beforeAt, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(beforeAt)) return invalid("beforeAt");
    if (!isLimit(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).oldest.all(toBind(beforeAt), toBind(limit)).map(rowOf) };
  }

  function upsertInTx(tx, row, now) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = badField(row);
    if (bad) return invalid(bad);
    if (!isTime(now)) return invalid("now");
    const s = stmts(tx);
    const state = [row.mil, row.ind, row.trade, row.milTrend, row.indTrend, row.tradeTrend, row.controllerFactionId,
      row.decayPermille, row.anchorAt, row.lastInputAt, row.killWindowAt, row.killWindowPoints];
    if (row.version === 0) {
      s.insert.run(...[row.systemId, ...state, row.investedIskTotal, row.createdAt, now].map(toBind));
      return { ok: true, row: Object.freeze({ ...row, updatedAt: now, version: 1 }) };
    }
    const r = s.update.run(...[...state, row.investedIskTotal, now, row.systemId, row.version].map(toBind));
    if (r.changes !== 1) return VERSION_CONFLICT;
    return { ok: true, row: Object.freeze({ ...row, updatedAt: now, version: row.version + 1 }) };
  }

  function deleteInTx(tx, systemId, version) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    if (!isId(version)) return invalid("version");
    return stmts(tx).remove.run(toBind(systemId), toBind(version)).changes === 1 ? { ok: true } : VERSION_CONFLICT;
  }

  function readCursorInTx(tx, source) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!S.SOURCES.includes(source)) return invalid("source");
    const r = stmts(tx).cursor.get(source);
    return { ok: true, cursor: r ? cursorOf(r) : null };
  }

  function writeCursorInTx(tx, c, now) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!c || !S.SOURCES.includes(c.source)) return invalid("source");
    if (!isTime(c.afterAt) || !isTime(c.afterNo) || !isTime(c.facts)) return invalid("cursor");
    const key = c.afterKey === undefined ? "" : c.afterKey;
    if (typeof key !== "string" || key.length > 64) return invalid("afterKey");
    if (!isTime(now)) return invalid("now");
    stmts(tx).upsertCursor.run(c.source, toBind(c.afterAt), toBind(c.afterNo), key, toBind(c.facts), toBind(now));
    return { ok: true };
  }

  function listCursorsInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, cursors: stmts(tx).listCursors.all().map(cursorOf) };
  }

  function getInvestInTx(tx, investId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof investId !== "string" || investId.length < 1 || investId.length > 32) return invalid("investId");
    const r = stmts(tx).investById.get(investId);
    return { ok: true, invest: r ? investOf(r) : null };
  }

  function findInvestByKeyInTx(tx, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 80) {
      return invalid("idempotencyKey");
    }
    const r = stmts(tx).investByKey.get(idempotencyKey);
    return { ok: true, invest: r ? investOf(r) : null };
  }

  function sumInvestSinceInTx(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isId(spec.characterId) || !isId(spec.systemId) || !isTime(spec.since)) return invalid("sum");
    const s = stmts(tx);
    return { ok: true, characterIsk: Number(s.characterIsk.get(toBind(spec.characterId), toBind(spec.since)).n),
      systemPoints: Number(s.systemPoints.get(toBind(spec.systemId), toBind(spec.since)).n) };
  }

  function insertInvestInTx(tx, inv, now) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!inv || typeof inv.investId !== "string" || inv.investId.length < 1 || inv.investId.length > 32) {
      return invalid("investId");
    }
    if (typeof inv.idempotencyKey !== "string" || inv.idempotencyKey.length < 1 || inv.idempotencyKey.length > 80) {
      return invalid("idempotencyKey");
    }
    if (!isId(inv.characterId) || !isId(inv.systemId)) return invalid("ids");
    if (!S.KINDS.includes(inv.kind)) return invalid("kind");
    if (!isId(inv.amount) || inv.amount > S.MAX_INVEST_ISK) return invalid("amount");
    if (!isTime(inv.points)) return invalid("points");
    if (!isTime(now)) return invalid("now");
    const s = stmts(tx);
    if (s.investByKey.get(inv.idempotencyKey)) return DUPLICATE;
    s.investInsert.run(inv.investId, inv.idempotencyKey, toBind(inv.characterId), toBind(inv.systemId), inv.kind,
      toBind(inv.amount), toBind(inv.points), toBind(now), toBind(now), toBind(now));
    return { ok: true, invest: investOf(s.investById.get(inv.investId)) };
  }

  function updateInvestInTx(tx, change, now) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || typeof change.investId !== "string" || !isId(change.version)) return invalid("investId");
    if (!Object.values(S.INVEST_STATES).includes(change.state)) return invalid("state");
    if (change.endReason !== null && (typeof change.endReason !== "string" || change.endReason.length > 32)) {
      return invalid("endReason");
    }
    if (!isTime(change.attempts)) return invalid("attempts");
    if (change.nextAttemptAt !== null && !isTime(change.nextAttemptAt)) return invalid("nextAttemptAt");
    if (!isTime(now)) return invalid("now");
    const s = stmts(tx);
    const r = s.investUpdate.run(change.state, change.endReason, toBind(change.attempts), toBind(change.nextAttemptAt),
      toBind(now), change.investId, toBind(change.version));
    if (r.changes !== 1) return s.investById.get(change.investId) ? VERSION_CONFLICT : NOT_FOUND;
    return { ok: true, invest: investOf(s.investById.get(change.investId)) };
  }

  function listDueInvestsInTx(tx, now, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(now)) return invalid("now");
    if (!isLimit(limit)) return invalid("limit");
    return { ok: true, invests: stmts(tx).investDue.all(toBind(now), toBind(limit)).map(investOf) };
  }

  function countPendingInvestsInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, pending: Number(stmts(tx).investPending.get().n) };
  }

  function pruneInvestsInTx(tx, before, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before)) return invalid("before");
    if (!isLimit(limit)) return invalid("limit");
    const s = stmts(tx);
    let pruned = 0;
    for (const state of [S.INVEST_STATES.APPLIED, S.INVEST_STATES.REFUSED]) {
      if (pruned >= limit) break;
      const ids = s.investOld.all(state, toBind(before), toBind(limit - pruned)).map((r) => r.invest_id);
      for (const id of ids) s.investDelete.run(id);
      pruned += ids.length;
    }
    return { ok: true, pruned };
  }

  return Object.freeze({ getInTx, listPageInTx, listOldestInTx, upsertInTx, deleteInTx, readCursorInTx,
    writeCursorInTx, listCursorsInTx, getInvestInTx, findInvestByKeyInTx, sumInvestSinceInTx, insertInvestInTx, updateInvestInTx,
    listDueInvestsInTx, countPendingInvestsInTx, pruneInvestsInTx });
}

module.exports = { createDevIndicesRepository, ROW_COLUMNS, INVEST_COLUMNS };
