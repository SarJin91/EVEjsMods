"use strict";

const { toBind } = require("../persistence/repository");
const { MEMBER_STATES: MS } = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const CAS_CONFLICT = Object.freeze({ ok: false, reason: "CAS_CONFLICT" });
const DUPLICATE = Object.freeze({ ok: false, reason: "DUPLICATE" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));

const COLUMNS = "character_id, origin_corp_id, corp_id, state, vendor_corporation_id, moves, joined_at, left_at, "
  + "updated_at, version";

function rowOf(r) {
  return Object.freeze({ character_id: num(r.character_id), origin_corp_id: num(r.origin_corp_id),
    corp_id: num(r.corp_id), state: r.state, vendor_corporation_id: num(r.vendor_corporation_id), moves: num(r.moves),
    joined_at: num(r.joined_at), left_at: num(r.left_at), updated_at: num(r.updated_at), version: num(r.version) });
}

function isUnique(err) {
  return Boolean(err && typeof err.code === "string"
    && (err.code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || err.code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")))
    || Boolean(err && /UNIQUE constraint failed/.test(String(err.message)));
}

function createFreeCorpMembersRepository() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      get: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_members WHERE character_id = ?`),
      countFree: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_members WHERE state = 'FREE'"),
      countAny: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_members"),
      listFree: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_members WHERE state = 'FREE' `
        + "ORDER BY left_at, character_id LIMIT ?"),
      byCorp: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_members WHERE corp_id = ? `
        + "AND state IN ('JOINING','MEMBER') ORDER BY character_id"),
      membersOf: db.prepare("SELECT character_id FROM world_free_corp_members WHERE corp_id = ? AND state = 'MEMBER' "
        + "ORDER BY character_id"),
      insert: db.prepare(`INSERT INTO world_free_corp_members (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, 1)`),
      move: db.prepare("UPDATE world_free_corp_members SET corp_id = ?, state = ?, moves = moves + 1, joined_at = NULL, "
        + "left_at = ?, updated_at = ?, version = version + 1 WHERE character_id = ? AND version = ?"),
      member: db.prepare("UPDATE world_free_corp_members SET state = 'MEMBER', joined_at = ?, vendor_corporation_id = ?, "
        + "updated_at = ?, version = version + 1 WHERE character_id = ? AND version = ? AND state = 'JOINING'"),
      lost: db.prepare("UPDATE world_free_corp_members SET state = 'LOST', corp_id = NULL, joined_at = NULL, "
        + "updated_at = ?, version = version + 1 WHERE character_id = ? AND version = ? AND state = 'JOINING'"),
      vendor: db.prepare("UPDATE world_free_corp_members SET vendor_corporation_id = ?, updated_at = ?, "
        + "version = version + 1 WHERE character_id = ? AND version = ?"),
      del: db.prepare("DELETE FROM world_free_corp_members WHERE character_id = ? AND version = ?"),
      stats: db.prepare("SELECT state, COUNT(*) AS n FROM world_free_corp_members GROUP BY state ORDER BY state"),
      recent: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_members ORDER BY updated_at DESC, character_id DESC `
        + "LIMIT ?"),
    };
    cache.set(db, s);
    return s;
  }

  function getInTx(tx, characterId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(characterId)) return invalid("characterId");
    const r = stmts(tx).get.get(toBind(characterId));
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function countFreeInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: num(stmts(tx).countFree.get().n) };
  }

  function countAnyInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: num(stmts(tx).countAny.get().n) };
  }

  function listFreeInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).listFree.all(toBind(limit)).map(rowOf) };
  }

  function listByCorpInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    return { ok: true, rows: stmts(tx).byCorp.all(toBind(corpId)).map(rowOf) };
  }

  function listMembersOfCorpsInTx(tx, corpIds) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(corpIds) || !corpIds.every(isId)) return invalid("corpIds");
    const s = stmts(tx);
    const byCorp = new Map();
    for (const corpId of [...new Set(corpIds)]) {
      const ids = s.membersOf.all(toBind(corpId)).map((r) => num(r.character_id));
      if (ids.length > 0) byCorp.set(corpId, ids);
    }
    return { ok: true, byCorp };
  }

  function insertInTx(tx, row, now) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!row || !isId(row.character_id) || !isId(row.origin_corp_id) || !isId(row.vendor_corporation_id)
      || !isTime(now)) {
      return invalid("row");
    }
    const corp = row.corp_id === null || row.corp_id === undefined ? null : row.corp_id;
    if (row.state === MS.FREE ? corp !== null : !(row.state === MS.JOINING && isId(corp))) return invalid("state");
    try {
      stmts(tx).insert.run(toBind(row.character_id), toBind(row.origin_corp_id), corp === null ? null : toBind(corp),
        row.state, toBind(row.vendor_corporation_id), toBind(now), toBind(now));
    } catch (err) {
      if (isUnique(err)) return DUPLICATE;
      throw err;
    }
    return { ok: true, moves: 1, version: 1 };
  }

  function moveInTx(tx, { characterId, expectedVersion, corpId, state, now, moves } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    const corp = corpId === null || corpId === undefined ? null : corpId;
    if (!isId(characterId) || !isId(expectedVersion) || !isTime(now) || !isId(moves)) return invalid("move");
    if (state === MS.FREE ? corp !== null : !(state === MS.JOINING && isId(corp))) return invalid("state");
    const info = stmts(tx).move.run(corp === null ? null : toBind(corp), state, toBind(now), toBind(now),
      toBind(characterId), toBind(expectedVersion));
    return info.changes === 1 ? { ok: true, moves: moves + 1, version: expectedVersion + 1 } : CAS_CONFLICT;
  }

  function settleInTx(tx, { characterId, expectedVersion, state, vendorCorporationId, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(characterId) || !isId(expectedVersion) || !isTime(now)) return invalid("settle");
    const s = stmts(tx);
    let info;
    if (state === MS.MEMBER) {
      if (!isId(vendorCorporationId)) return invalid("vendorCorporationId");
      info = s.member.run(toBind(now), toBind(vendorCorporationId), toBind(now), toBind(characterId),
        toBind(expectedVersion));
    } else if (state === MS.LOST) {
      info = s.lost.run(toBind(now), toBind(characterId), toBind(expectedVersion));
    } else {
      return invalid("state");
    }
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function noteVendorCorporationInTx(tx, { characterId, expectedVersion, vendorCorporationId, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(characterId) || !isId(expectedVersion) || !isId(vendorCorporationId) || !isTime(now)) {
      return invalid("vendor");
    }
    const info = stmts(tx).vendor.run(toBind(vendorCorporationId), toBind(now), toBind(characterId),
      toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function deleteInTx(tx, { characterId, expectedVersion } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(characterId) || !isId(expectedVersion)) return invalid("delete");
    const info = stmts(tx).del.run(toBind(characterId), toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function statsInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const out = { ok: true, free: 0, joining: 0, member: 0, lost: 0 };
    for (const r of stmts(tx).stats.all()) {
      const n = num(r.n);
      if (r.state === MS.FREE) out.free = n;
      else if (r.state === MS.JOINING) out.joining = n;
      else if (r.state === MS.MEMBER) out.member = n;
      else if (r.state === MS.LOST) out.lost = n;
    }
    return out;
  }

  function recentInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).recent.all(toBind(limit)).map(rowOf) };
  }

  return Object.freeze({ getInTx, countFreeInTx, countAnyInTx, listFreeInTx, listByCorpInTx, listMembersOfCorpsInTx,
    insertInTx, moveInTx, settleInTx, noteVendorCorporationInTx, deleteInTx, statsInTx, recentInTx });
}

module.exports = { createFreeCorpMembersRepository };
