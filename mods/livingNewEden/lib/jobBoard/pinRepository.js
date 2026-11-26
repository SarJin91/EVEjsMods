"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v);
const isRef = (v) => typeof v === "string" && v.length >= S.REF_MIN && v.length <= S.REF_MAX && /^[\x21-\x7e]+$/.test(v);

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

function createPinRepository() {
  function listOfCharacterInTx(tx, characterId) {
    if (!isId(characterId)) return invalid("characterId");
    const rows = tx.prepare(`SELECT job_ref, pinned_at, expires_at FROM ${S.PINS_TABLE} WHERE character_id = ?
      ORDER BY pinned_at, job_ref LIMIT ?`).all(characterId, S.MAX_PINS_LISTED);
    return { ok: true, rows: rows.map((r) => Object.freeze({ jobRef: r.job_ref, pinnedAt: Number(r.pinned_at),
      expiresAt: Number(r.expires_at) })) };
  }

  function insertInTx(tx, pin) {
    const { characterId, jobRef, pinnedAt, expiresAt } = pin || {};
    if (!isId(characterId)) return invalid("characterId");
    if (!isRef(jobRef)) return invalid("jobRef");
    if (!isTime(pinnedAt)) return invalid("pinnedAt");
    if (!isTime(expiresAt)) return invalid("expiresAt");
    const r = tx.prepare(`INSERT INTO ${S.PINS_TABLE} (character_id, job_ref, pinned_at, expires_at)
      VALUES (?, ?, ?, ?) ON CONFLICT (character_id, job_ref) DO NOTHING`)
      .run(characterId, jobRef, pinnedAt, expiresAt);
    return { ok: true, inserted: Number(r.changes) === 1 };
  }

  function deleteInTx(tx, characterId, jobRefs) {
    if (!isId(characterId)) return invalid("characterId");
    if (!Array.isArray(jobRefs) || jobRefs.length > S.MAX_PINS_LISTED || !jobRefs.every(isRef)) return invalid("jobRefs");
    if (jobRefs.length === 0) return { ok: true, deleted: 0 };
    const marks = jobRefs.map(() => "?").join(", ");
    const r = tx.prepare(`DELETE FROM ${S.PINS_TABLE} WHERE character_id = ? AND job_ref IN (${marks})`)
      .run(characterId, ...jobRefs);
    return { ok: true, deleted: Number(r.changes) };
  }

  function deleteExpiredOfCharacterInTx(tx, characterId, now) {
    if (!isId(characterId)) return invalid("characterId");
    if (!isTime(now)) return invalid("now");
    const r = tx.prepare(`DELETE FROM ${S.PINS_TABLE} WHERE character_id = ? AND expires_at <= ?`).run(characterId, now);
    return { ok: true, deleted: Number(r.changes) };
  }

  function pruneExpiredInTx(tx, now, batch) {
    if (!isTime(now)) return invalid("now");
    if (!isId(batch)) return invalid("batch");
    const r = tx.prepare(`DELETE FROM ${S.PINS_TABLE} WHERE (character_id, job_ref) IN (
      SELECT character_id, job_ref FROM ${S.PINS_TABLE} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`)
      .run(now, batch);
    return { ok: true, deleted: Number(r.changes) };
  }

  return Object.freeze({ listOfCharacterInTx, insertInTx, deleteInTx, deleteExpiredOfCharacterInTx,
    pruneExpiredInTx });
}

module.exports = { createPinRepository, isRef };
