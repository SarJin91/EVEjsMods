"use strict";

const { toBind } = require("../../persistence/repository");
const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isRel = (v) => v === -10 || v === 10;
const txMissing = (db) => !db || db.inTransaction !== true;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const failed = (err) => ({ ok: false, reason: "CONTACTS_SQL_FAILED",
  detail: String((err && err.message) || err).slice(0, 120) });
const relOrNull = (v) => (v === null || v === undefined ? null : Number(v));

function toRow(r) {
  return Object.freeze({ characterId: Number(r.character_id), contactId: Number(r.contact_id),
    factionId: Number(r.faction_id), level: r.level, state: r.state, writtenRel: Number(r.written_rel),
    prevRel: relOrNull(r.prev_rel), changedAt: Number(r.changed_at), releaseReason: r.release_reason || null,
    version: Number(r.version) });
}

function createLocalContactsRepository() {
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE_NAME;
    const L = S.LIVE_SQL;
    s = {
      ofCharacter: db.prepare(`SELECT * FROM ${T} WHERE character_id = ? ORDER BY contact_id`),
      liveCharacters: db.prepare(`SELECT DISTINCT character_id FROM ${T} WHERE ${L} AND character_id > ?
        ORDER BY character_id LIMIT ?`),
      counts: db.prepare(`SELECT sum(CASE WHEN ${L} THEN 1 ELSE 0 END) AS live,
        sum(CASE WHEN state = 'RELEASED' THEN 1 ELSE 0 END) AS released FROM ${T}`),
      insert: db.prepare(`INSERT INTO ${T} (character_id, contact_id, faction_id, level, state, written_rel, prev_rel,
        changed_at, release_reason, version) VALUES (?, ?, ?, ?, 'ADDING', ?, NULL, ?, NULL, 1)`),
      update: db.prepare(`UPDATE ${T} SET state = ?, written_rel = ?, prev_rel = ?, changed_at = ?, release_reason = ?,
        version = version + 1 WHERE character_id = ? AND contact_id = ? AND version = ? AND ${L}`),
      remove: db.prepare(`DELETE FROM ${T} WHERE character_id = ? AND contact_id = ? AND version = ? AND ${L}`),
      removeLiveOfCharacter: db.prepare(`DELETE FROM ${T} WHERE character_id = ? AND ${L}`),
    };
    cache.set(db, s);
    return s;
  }

  function listForCharacter(db, characterId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(characterId)) return { ok: false, reason: "INVALID_INPUT", detail: "characterId" };
    try {
      return { ok: true, rows: stmts(db).ofCharacter.all(toBind(characterId)).map(toRow) };
    } catch (err) {
      return failed(err);
    }
  }

  function listLiveCharacters(db, afterId, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !isId(limit)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "afterId/limit" };
    }
    try {
      return { ok: true, ids: stmts(db).liveCharacters.all(toBind(afterId), toBind(limit))
        .map((r) => Number(r.character_id)) };
    } catch (err) {
      return failed(err);
    }
  }

  function countRows(db) {
    if (txMissing(db)) return TX_REQUIRED;
    try {
      const r = stmts(db).counts.get() || {};
      return { ok: true, live: Number(r.live || 0), released: Number(r.released || 0) };
    } catch (err) {
      return failed(err);
    }
  }

  function insertAdding(db, row) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!row || !isId(row.characterId) || !isId(row.contactId) || !isId(row.factionId) || !S.LEVELS.includes(row.level)
      || !isRel(row.writtenRel) || !Number.isSafeInteger(row.changedAt) || row.changedAt < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "row" };
    }
    try {
      stmts(db).insert.run(toBind(row.characterId), toBind(row.contactId), toBind(row.factionId), row.level,
        toBind(row.writtenRel), toBind(row.changedAt));
      return { ok: true };
    } catch (err) {
      if (String((err && err.code) || "").startsWith("SQLITE_CONSTRAINT")) return { ok: false, reason: "DUPLICATE" };
      return failed(err);
    }
  }

  function updateRow(db, key, version, next) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!key || !isId(key.characterId) || !isId(key.contactId) || !isId(version) || !next
      || !S.STATES.includes(next.state) || !isRel(next.writtenRel)
      || !(next.prevRel === null || isRel(next.prevRel)) || !Number.isSafeInteger(next.changedAt) || next.changedAt < 0
      || !(next.releaseReason === null || Object.values(S.RELEASE_REASONS).includes(next.releaseReason))) {
      return { ok: false, reason: "INVALID_INPUT", detail: "update" };
    }
    try {
      const info = stmts(db).update.run(next.state, toBind(next.writtenRel),
        next.prevRel === null ? null : toBind(next.prevRel), toBind(next.changedAt), next.releaseReason,
        toBind(key.characterId), toBind(key.contactId), toBind(version));
      return info.changes === 1 ? { ok: true } : { ok: false, reason: "VERSION_CONFLICT" };
    } catch (err) {
      return failed(err);
    }
  }

  function deleteRow(db, key, version) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!key || !isId(key.characterId) || !isId(key.contactId) || !isId(version)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "delete" };
    }
    try {
      const info = stmts(db).remove.run(toBind(key.characterId), toBind(key.contactId), toBind(version));
      return info.changes === 1 ? { ok: true } : { ok: false, reason: "VERSION_CONFLICT" };
    } catch (err) {
      return failed(err);
    }
  }

  function deleteLiveOfCharacter(db, characterId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(characterId)) return { ok: false, reason: "INVALID_INPUT", detail: "characterId" };
    try {
      return { ok: true, removed: stmts(db).removeLiveOfCharacter.run(toBind(characterId)).changes };
    } catch (err) {
      return failed(err);
    }
  }

  return Object.freeze({ listForCharacter, listLiveCharacters, countRows, insertAdding, updateRow, deleteRow,
    deleteLiveOfCharacter });
}

module.exports = { createLocalContactsRepository };
