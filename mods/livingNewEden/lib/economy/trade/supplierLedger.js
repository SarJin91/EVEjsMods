"use strict";

const SUPPLIER_TABLE = "world_supplier_standing";
const MAX = Number.MAX_SAFE_INTEGER;

const DDL = `
CREATE TABLE world_supplier_standing (
  character_id INTEGER NOT NULL CHECK (character_id > 0),
  faction_id   INTEGER NOT NULL CHECK (faction_id > 0),
  day          INTEGER NOT NULL CHECK (day >= 0),
  credit_isk   INTEGER NOT NULL DEFAULT 0 CHECK (credit_isk >= 0),
  wts_isk      INTEGER NOT NULL DEFAULT 0 CHECK (wts_isk >= 0),
  gain_micro   INTEGER NOT NULL DEFAULT 0 CHECK (gain_micro >= 0),
  grants       INTEGER NOT NULL DEFAULT 0 CHECK (grants >= 0),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (character_id, faction_id, day)
) WITHOUT ROWID;
`;

function upSupplierStanding(db) {
  db.exec(DDL);
}

const ZERO = Object.freeze({ creditIsk: 0, wtsIsk: 0, gainMicro: 0, grants: 0 });
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const sat = (v) => Math.min(MAX, Number(v) || 0);

function readWindowInTx(tx, characterId, factionId, today, windowDays) {
  if (!isPosInt(characterId)) return invalid("characterId");
  if (!isPosInt(factionId)) return invalid("factionId");
  if (!isNonNegInt(today)) return invalid("today");
  if (!isPosInt(windowDays)) return invalid("windowDays");
  const rows = tx.prepare(`SELECT day, credit_isk, wts_isk, gain_micro, grants FROM ${SUPPLIER_TABLE}
    WHERE character_id = ? AND faction_id = ? AND day > ? ORDER BY day`).all(characterId, factionId, today - windowDays);
  let todayRow = ZERO;
  const win = { creditIsk: 0, wtsIsk: 0, gainMicro: 0 };
  for (const r of rows) {
    const d = Number(r.day);
    if (d === today) {
      todayRow = { creditIsk: sat(r.credit_isk), wtsIsk: sat(r.wts_isk), gainMicro: sat(r.gain_micro),
        grants: sat(r.grants) };
    } else if (d < today) {
      win.creditIsk = sat(win.creditIsk + sat(r.credit_isk));
      win.wtsIsk = sat(win.wtsIsk + sat(r.wts_isk));
      win.gainMicro = sat(win.gainMicro + sat(r.gain_micro));
    }
  }
  return { ok: true, today: { ...todayRow }, window: win };
}

function addInTx(tx, characterId, factionId, day, add, at) {
  if (!isPosInt(characterId)) return invalid("characterId");
  if (!isPosInt(factionId)) return invalid("factionId");
  if (!isNonNegInt(day)) return invalid("day");
  if (!isNonNegInt(at)) return invalid("at");
  const a = add || {};
  const v = [a.creditIsk, a.wtsIsk, a.gainMicro, a.grants].map((x) => (x === undefined ? 0 : x));
  if (!v.every(isNonNegInt)) return invalid("add");
  tx.prepare(`INSERT INTO ${SUPPLIER_TABLE} (character_id, faction_id, day, credit_isk, wts_isk, gain_micro, grants,
      updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (character_id, faction_id, day) DO UPDATE SET
      credit_isk = min(${MAX}, credit_isk + excluded.credit_isk),
      wts_isk = min(${MAX}, wts_isk + excluded.wts_isk),
      gain_micro = min(${MAX}, gain_micro + excluded.gain_micro),
      grants = min(${MAX}, grants + excluded.grants),
      updated_at = excluded.updated_at`)
    .run(characterId, factionId, day, v[0], v[1], v[2], v[3], at);
  return { ok: true };
}

function pruneInTx(tx, characterId, factionId, beforeDayInclusive) {
  if (!isPosInt(characterId)) return invalid("characterId");
  if (!isPosInt(factionId)) return invalid("factionId");
  if (!Number.isSafeInteger(beforeDayInclusive)) return invalid("beforeDayInclusive");
  if (beforeDayInclusive < 0) return { ok: true, deleted: 0 };
  const r = tx.prepare(`DELETE FROM ${SUPPLIER_TABLE} WHERE character_id = ? AND faction_id = ? AND day <= ?`)
    .run(characterId, factionId, beforeDayInclusive);
  return { ok: true, deleted: Number(r.changes) || 0 };
}

module.exports = { SUPPLIER_TABLE, upSupplierStanding, readWindowInTx, addInTx, pruneInTx };
