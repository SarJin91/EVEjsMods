"use strict";

const { PREFS_TABLE } = require("./schema");

const MAX_DETAIL = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function dbError(err) {
  return { ok: false, reason: "DB_ERROR", detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
}

function getInTx(db, characterId) {
  if (!isId(characterId)) return { ok: false, reason: "BAD_INPUT", detail: "characterId" };
  try {
    const row = db.prepare(`SELECT open_at_login FROM ${PREFS_TABLE} WHERE character_id = ?`).get(characterId);
    return { ok: true, openAtLogin: Boolean(row) && Number(row.open_at_login) === 1 };
  } catch (err) {
    return dbError(err);
  }
}

function setInTx(db, input) {
  const { characterId, on, nowMs } = input || {};
  if (!isId(characterId)) return { ok: false, reason: "BAD_INPUT", detail: "characterId" };
  if (typeof on !== "boolean") return { ok: false, reason: "BAD_INPUT", detail: "on" };
  if (!Number.isSafeInteger(nowMs)) return { ok: false, reason: "BAD_INPUT", detail: "nowMs" };
  try {
    db.prepare(`INSERT INTO ${PREFS_TABLE} (character_id, open_at_login, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET open_at_login = excluded.open_at_login,
      updated_at = excluded.updated_at`).run(characterId, on ? 1 : 0, nowMs);
    return { ok: true, openAtLogin: on };
  } catch (err) {
    return dbError(err);
  }
}

module.exports = { getInTx, setInTx };
