"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const STALE = Object.freeze({ ok: false, reason: "STALE" });

function toAnnouncement(row) {
  return Object.freeze({
    operationId: row.operation_id,
    operationType: row.operation_type,
    factionId: Number(row.faction_id),
    defenderFactionId: row.defender_faction_id === null ? null : Number(row.defender_faction_id),
    targetSystemId: Number(row.target_system_id),
    etaAt: Number(row.eta_at),
    announcedAt: Number(row.announced_at),
    state: row.state,
    outcome: row.outcome,
    battleId: row.battle_id,
    checkRound: Number(row.check_round),
    recipients: Number(row.recipients),
    endMailed: Number(row.end_mailed) === 1,
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
    version: Number(row.version),
  });
}

function placeholders(n) {
  return new Array(n).fill("?").join(",");
}

function createBattleAnnounceRepository() {
  function getInTx(db, operationId) {
    if (!db) return invalid("db");
    if (!isText(operationId, S.MAX_OPERATION_ID)) return invalid("operationId");
    const row = db.prepare(`SELECT * FROM ${S.TABLE} WHERE operation_id = ?`).get(operationId);
    return { ok: true, announcement: row ? toAnnouncement(row) : null };
  }

  function countOpenInTx(db) {
    if (!db) return invalid("db");
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${S.TABLE} WHERE state = 'OPEN'`).get();
    return { ok: true, open: Number(row.n) };
  }

  function recipientFactsInTx(db, q) {
    const o = q || {};
    if (!db) return invalid("db");
    if (!Array.isArray(o.characterIds) || !o.characterIds.every(isId)) return invalid("characterIds");
    if (!isTime(o.since)) return invalid("since");
    if (!isId(o.targetSystemId)) return invalid("targetSystemId");
    const dayCount = new Map();
    const openSameTarget = new Set();
    if (o.characterIds.length === 0) return { ok: true, dayCount, openSameTarget };
    const marks = placeholders(o.characterIds.length);
    const counts = db.prepare(`SELECT character_id AS c, COUNT(*) AS n FROM ${S.RECIPIENTS_TABLE}
      WHERE character_id IN (${marks}) AND announced_at >= ? GROUP BY character_id`).all(...o.characterIds, o.since);
    for (const r of counts) dayCount.set(Number(r.c), Number(r.n));
    const same = db.prepare(`SELECT DISTINCT r.character_id AS c FROM ${S.RECIPIENTS_TABLE} r
      JOIN ${S.TABLE} a ON a.operation_id = r.operation_id
      WHERE r.character_id IN (${marks}) AND r.target_system_id = ? AND a.state = 'OPEN'`)
      .all(...o.characterIds, o.targetSystemId);
    for (const r of same) openSameTarget.add(Number(r.c));
    return { ok: true, dayCount, openSameTarget };
  }

  function createInTx(db, a) {
    const o = a || {};
    if (!db) return invalid("db");
    if (!isText(o.operationId, S.MAX_OPERATION_ID)) return invalid("operationId");
    if (!isText(o.operationType, S.MAX_OPERATION_TYPE)) return invalid("operationType");
    if (!isId(o.factionId)) return invalid("factionId");
    if (o.defenderFactionId !== null && !isId(o.defenderFactionId)) return invalid("defenderFactionId");
    if (!isId(o.targetSystemId)) return invalid("targetSystemId");
    if (!isTime(o.etaAt)) return invalid("etaAt");
    if (!isTime(o.announcedAt)) return invalid("announcedAt");
    if (!Array.isArray(o.characterIds) || o.characterIds.length === 0 || !o.characterIds.every(isId)
      || new Set(o.characterIds).size !== o.characterIds.length) return invalid("characterIds");
    if (db.prepare(`SELECT 1 FROM ${S.TABLE} WHERE operation_id = ?`).get(o.operationId)) {
      return { ok: true, duplicate: true, rows: 0 };
    }
    db.prepare(`INSERT INTO ${S.TABLE} (operation_id, operation_type, faction_id, defender_faction_id,
      target_system_id, eta_at, announced_at, state, outcome, battle_id, check_round, recipients, end_mailed, closed_at,
      version) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, 0, ?, 0, NULL, 1)`)
      .run(o.operationId, o.operationType, o.factionId, o.defenderFactionId, o.targetSystemId, o.etaAt, o.announcedAt,
        o.characterIds.length);
    const insert = db.prepare(`INSERT INTO ${S.RECIPIENTS_TABLE} (operation_id, character_id, target_system_id,
      announced_at) VALUES (?, ?, ?, ?)`);
    for (const c of o.characterIds) insert.run(o.operationId, c, o.targetSystemId, o.announcedAt);
    return { ok: true, duplicate: false, rows: 1 + o.characterIds.length };
  }

  function listRecipientsInTx(db, operationId, limit) {
    if (!db) return invalid("db");
    if (!isText(operationId, S.MAX_OPERATION_ID)) return invalid("operationId");
    if (!isId(limit)) return invalid("limit");
    const rows = db.prepare(`SELECT character_id AS c FROM ${S.RECIPIENTS_TABLE} WHERE operation_id = ?
      ORDER BY character_id LIMIT ?`).all(operationId, limit);
    return { ok: true, characterIds: rows.map((r) => Number(r.c)) };
  }

  function advanceRoundInTx(db, change) {
    const o = change || {};
    if (!db) return invalid("db");
    if (!isText(o.operationId, S.MAX_OPERATION_ID)) return invalid("operationId");
    if (!isId(o.expectedVersion)) return invalid("expectedVersion");
    if (!isTime(o.now)) return invalid("now");
    const r = db.prepare(`UPDATE ${S.TABLE} SET check_round = check_round + 1, version = version + 1
      WHERE operation_id = ? AND version = ? AND state = 'OPEN'`).run(o.operationId, o.expectedVersion);
    return r.changes === 1 ? { ok: true, version: o.expectedVersion + 1 } : STALE;
  }

  function closeInTx(db, change) {
    const o = change || {};
    if (!db) return invalid("db");
    if (!isText(o.operationId, S.MAX_OPERATION_ID)) return invalid("operationId");
    if (!isId(o.expectedVersion)) return invalid("expectedVersion");
    if (!Object.values(S.OUTCOME).includes(o.outcome)) return invalid("outcome");
    if (o.battleId !== null && !isText(o.battleId, S.MAX_BATTLE_ID)) return invalid("battleId");
    if (typeof o.endMailed !== "boolean") return invalid("endMailed");
    if (!isTime(o.now)) return invalid("now");
    const r = db.prepare(`UPDATE ${S.TABLE} SET state = 'CLOSED', outcome = ?, battle_id = ?, end_mailed = ?,
      closed_at = ?, version = version + 1 WHERE operation_id = ? AND version = ? AND state = 'OPEN'`)
      .run(o.outcome, o.battleId, o.endMailed ? 1 : 0, o.now, o.operationId, o.expectedVersion);
    return r.changes === 1 ? { ok: true, version: o.expectedVersion + 1 } : STALE;
  }

  function pruneInTx(db, q) {
    const o = q || {};
    if (!db) return invalid("db");
    if (!isTime(o.before)) return invalid("before");
    if (!isId(o.batch)) return invalid("batch");
    const ids = db.prepare(`SELECT operation_id AS id FROM ${S.TABLE} WHERE state = 'CLOSED' AND closed_at < ?
      ORDER BY closed_at, operation_id LIMIT ?`).all(o.before, o.batch).map((r) => r.id);
    if (ids.length === 0) return { ok: true, deleted: 0, rows: 0 };
    const marks = placeholders(ids.length);
    const recipients = db.prepare(`DELETE FROM ${S.RECIPIENTS_TABLE} WHERE operation_id IN (${marks})`).run(...ids);
    const rows = db.prepare(`DELETE FROM ${S.TABLE} WHERE operation_id IN (${marks})`).run(...ids);
    return { ok: true, deleted: rows.changes, rows: rows.changes + recipients.changes };
  }

  return Object.freeze({ getInTx, countOpenInTx, recipientFactsInTx, createInTx, listRecipientsInTx,
    advanceRoundInTx, closeInTx, pruneInTx });
}

module.exports = { createBattleAnnounceRepository, toAnnouncement };
