"use strict";

const { toBind } = require("../persistence/repository");
const { CORP_STATES, OPEN_STATES, MAX_MEMBERS, MAX_END_REASON_LENGTH } = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const CAS_CONFLICT = Object.freeze({ ok: false, reason: "CAS_CONFLICT" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));

const COLUMNS = "corp_id, archetype, state, open, name, ticker, sec_band, home_system_id, home_station_id, "
  + "home_station_corp_id, race_faction_id, members_target, corporation_id, isk, struggle_count, seed, name_attempt, "
  + "venture_seq, next_at, founded_at, updated_at, ended_at, end_reason, merged_into, version, "
  + "recover_until, recover_crew, ventures_done, ventures_lost, isk_earned, isk_lost, last_review_at, "
  + "recruited, "
  + "structure_seq, "
  + "ceo_character_id, ceo_source_corporation_id, ceo_released";
const INT_COLUMNS = Object.freeze(["corp_id", "open", "home_system_id", "home_station_id", "home_station_corp_id",
  "race_faction_id", "members_target", "corporation_id", "isk", "struggle_count", "seed", "name_attempt",
  "venture_seq", "next_at", "founded_at", "updated_at", "ended_at", "merged_into", "version", "recover_until",
  "recover_crew", "ventures_done", "ventures_lost", "isk_earned", "isk_lost", "last_review_at", "recruited",
  "structure_seq", "ceo_character_id", "ceo_source_corporation_id", "ceo_released"]);
const ADVANCE_COUNTERS = Object.freeze(["isk", "struggle_count", "venture_seq", "recover_until", "recover_crew",
  "ventures_done", "ventures_lost", "isk_earned", "isk_lost", "last_review_at", "next_at"]);

function rowOf(r) {
  const out = { ...r };
  for (const c of INT_COLUMNS) out[c] = num(r[c]);
  return Object.freeze(out);
}

function isUnique(err) {
  return Boolean(err && typeof err.code === "string" && err.code.startsWith("SQLITE_CONSTRAINT_UNIQUE"))
    || Boolean(err && /UNIQUE constraint failed/.test(String(err.message)));
}

function createFreeCorpRepository() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      due: db.prepare(`SELECT ${COLUMNS} FROM world_free_corps WHERE open = 1 AND next_at <= ? `
        + "ORDER BY next_at, corp_id LIMIT ?"),
      stats: db.prepare("SELECT COALESCE(MAX(corp_id), 0) AS maxCorpId, COALESCE(MAX(founded_at), 0) AS lastFoundedAt, "
        + "COALESCE(SUM(open), 0) AS open, COALESCE(SUM(state = 'FOUNDING'), 0) AS founding, "
        + "COALESCE(SUM(state = 'REFUSED'), 0) AS refused, "
        + "COALESCE(SUM(CASE state WHEN 'FOUNDING' THEN members_target - recruited - (ceo_character_id IS NOT NULL) "
        + "ELSE 0 END), 0) AS pendingMembers, "
        + "COALESCE(SUM(open = 1 AND archetype = 'hunter'), 0) AS hunters, "
        + "COALESCE(SUM(open = 1 AND archetype = 'structure'), 0) AS structureCorps, "
        + "(SELECT COUNT(*) FROM world_free_corp_wh_homes WHERE open = 1) AS whCorps "
        + "FROM world_free_corps"),
      getOpen: db.prepare(`SELECT ${COLUMNS} FROM world_free_corps WHERE corp_id = ? AND open = 1`),
      get: db.prepare(`SELECT ${COLUMNS} FROM world_free_corps WHERE corp_id = ?`),
      credit: db.prepare("UPDATE world_free_corps SET isk = isk + ?, isk_earned = isk_earned + ?, updated_at = ?, "
        + "version = version + 1 WHERE corp_id = ?"),
      debit: db.prepare("UPDATE world_free_corps SET isk = isk - ?, updated_at = ?, version = version + 1 "
        + "WHERE corp_id = ? AND isk >= ?"),
      refund: db.prepare("UPDATE world_free_corps SET isk = isk + ?, updated_at = ?, version = version + 1 "
        + "WHERE corp_id = ?"),
      openBrief: db.prepare("SELECT corp_id, archetype, state, home_system_id FROM world_free_corps WHERE open = 1 "
        + "ORDER BY next_at, corp_id LIMIT ?"),
      home: db.prepare("SELECT COUNT(*) AS n FROM world_free_corps WHERE open = 1 AND home_system_id = ?"),
      taken: db.prepare("SELECT 1 AS hit FROM world_free_corps WHERE name = ? OR ticker = ? LIMIT 1"),
      insert: db.prepare(`INSERT INTO world_free_corps (corp_id, archetype, state, open, name, ticker, sec_band,
        home_system_id, home_station_id, home_station_corp_id, race_faction_id, members_target, corporation_id, isk,
        struggle_count, seed, name_attempt, venture_seq, next_at, founded_at, updated_at, ended_at, end_reason,
        merged_into, version, recruited, ceo_character_id, ceo_source_corporation_id) VALUES (?, ?, 'FOUNDING', 1, ?, ?,
        ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, 0, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?, ?)`),
      ceoRelease: db.prepare("SELECT corp_id, corporation_id, version FROM world_free_corps "
        + "WHERE open = 0 AND ceo_released = 0 AND state IN ('DISSOLVED','MERGED') ORDER BY ended_at, corp_id LIMIT ?"),
      ceoReleased: db.prepare("UPDATE world_free_corps SET ceo_released = ?, updated_at = ? "
        + "WHERE corp_id = ? AND ceo_released = 0"),
      clearCeo: db.prepare("UPDATE world_free_corps SET ceo_character_id = NULL, ceo_source_corporation_id = NULL, "
        + "version = version + 1, updated_at = ? WHERE corp_id = ? AND open = 1 AND ceo_character_id = ?"),
      activate: db.prepare("UPDATE world_free_corps SET state = 'ACTIVE', corporation_id = ?, next_at = ?, "
        + "version = version + 1, updated_at = ? WHERE corp_id = ? AND version = ? AND state = 'FOUNDING'"),
      refuse: db.prepare("UPDATE world_free_corps SET state = 'REFUSED', open = 0, ended_at = ?, end_reason = ?, "
        + "version = version + 1, updated_at = ? WHERE corp_id = ? AND version = ? AND state = 'FOUNDING'"),
      reschedule: db.prepare("UPDATE world_free_corps SET next_at = ?, "
        + "corporation_id = COALESCE(?, corporation_id), version = version + 1, updated_at = ? "
        + "WHERE corp_id = ? AND version = ? AND state = ?"),
      advance: db.prepare("UPDATE world_free_corps SET state = ?, open = ?, isk = ?, struggle_count = ?, "
        + "members_target = ?, venture_seq = ?, recover_until = ?, recover_crew = ?, ventures_done = ?, "
        + "ventures_lost = ?, isk_earned = ?, isk_lost = ?, last_review_at = ?, next_at = ?, "
        + "corporation_id = COALESCE(?, corporation_id), ended_at = ?, end_reason = ?, "
        + "recruited = COALESCE(?, recruited), merged_into = COALESCE(?, merged_into), "
        + "structure_seq = COALESCE(?, structure_seq), version = version + 1, "
        + "updated_at = ? WHERE corp_id = ? AND version = ? AND state = ?"),
      partners: db.prepare("SELECT corp_id, home_system_id, isk, members_target, recruited, version FROM world_free_corps "
        + "WHERE open = 1 AND state = 'ACTIVE' AND archetype = ? AND isk >= ? ORDER BY isk DESC, corp_id LIMIT ?"),
      adjustRecruited: db.prepare("UPDATE world_free_corps SET recruited = recruited + ?, version = version + 1, "
        + "updated_at = ? WHERE corp_id = ? AND open = 1 AND recruited + ? BETWEEN 0 AND members_target - 1"),
      view: db.prepare(`SELECT ${COLUMNS} FROM world_free_corps ORDER BY open DESC, corp_id LIMIT ?`),
      counts: db.prepare("SELECT state, archetype, sec_band AS secBand, COUNT(*) AS n FROM world_free_corps "
        + "GROUP BY state, archetype, sec_band ORDER BY state, archetype, sec_band"),
    };
    cache.set(db, s);
    return s;
  }

  function listDueInTx(tx, { now, limit }) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(now) || !isId(limit)) return invalid("now/limit");
    const rows = stmts(tx).due.all(toBind(now), toBind(limit + 1)).map(rowOf);
    const truncated = rows.length > limit;
    return { ok: true, rows: truncated ? rows.slice(0, limit) : rows, truncated };
  }

  function statsInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const r = stmts(tx).stats.get();
    return { ok: true, maxCorpId: num(r.maxCorpId), lastFoundedAt: num(r.lastFoundedAt), open: num(r.open),
      founding: num(r.founding), refused: num(r.refused), pendingMembers: num(r.pendingMembers),
      hunters: num(r.hunters), structureCorps: num(r.structureCorps), whCorps: num(r.whCorps) };
  }

  function getOpenInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    const r = stmts(tx).getOpen.get(toBind(corpId));
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function getInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    const r = stmts(tx).get.get(toBind(corpId));
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function creditIskInTx(tx, { corpId, isk, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(isk) || !isTime(at)) return invalid("credit");
    const s = stmts(tx);
    const r = s.get.get(toBind(corpId));
    if (!r) return { ok: false, reason: "NOT_FOUND" };
    const row = rowOf(r);
    if (!Number.isSafeInteger(row.isk + isk) || !Number.isSafeInteger(row.isk_earned + isk)) return invalid("isk");
    const info = s.credit.run(toBind(isk), toBind(isk), toBind(at), toBind(corpId));
    return info.changes === 1 ? { ok: true, open: row.open === 1 } : { ok: false, reason: "NOT_FOUND" };
  }

  function debitIskInTx(tx, { corpId, isk, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(isk) || !isTime(at)) return invalid("debit");
    const s = stmts(tx);
    const info = s.debit.run(toBind(isk), toBind(at), toBind(corpId), toBind(isk));
    if (info.changes === 1) return { ok: true };
    return s.get.get(toBind(corpId)) ? { ok: false, reason: "INSUFFICIENT" } : { ok: false, reason: "NOT_FOUND" };
  }

  function refundIskInTx(tx, { corpId, isk, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(isk) || !isTime(at)) return invalid("refund");
    const s = stmts(tx);
    const r = s.get.get(toBind(corpId));
    if (!r) return { ok: false, reason: "NOT_FOUND" };
    const row = rowOf(r);
    if (!Number.isSafeInteger(row.isk + isk)) return invalid("isk");
    const info = s.refund.run(toBind(isk), toBind(at), toBind(corpId));
    return info.changes === 1 ? { ok: true, open: row.open === 1 } : { ok: false, reason: "NOT_FOUND" };
  }

  function listOpenBriefInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).openBrief.all(toBind(limit + 1)).map((r) => Object.freeze({ corp_id: num(r.corp_id),
      archetype: r.archetype, state: r.state, home_system_id: num(r.home_system_id) }));
    const truncated = rows.length > limit;
    return { ok: true, rows: truncated ? rows.slice(0, limit) : rows, truncated };
  }

  function countOpenInHomeInTx(tx, systemId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    return { ok: true, count: num(stmts(tx).home.get(toBind(systemId)).n) };
  }

  function nameOrTickerTakenInTx(tx, name, ticker) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof name !== "string" || typeof ticker !== "string") return invalid("name/ticker");
    return { ok: true, taken: stmts(tx).taken.get(name, ticker) !== undefined };
  }

  function insertFoundingInTx(tx, row, at) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!row || !isId(row.corp_id) || !isTime(at)) return invalid("row/at");
    const recruited = row.recruited === undefined || row.recruited === null ? 0 : row.recruited;
    if (!Number.isSafeInteger(recruited) || recruited < 0 || recruited >= row.members_target) return invalid("recruited");
    const ceo = row.ceo_character_id === undefined || row.ceo_character_id === null ? null : row.ceo_character_id;
    const ceoFrom = row.ceo_source_corporation_id === undefined || row.ceo_source_corporation_id === null ? null
      : row.ceo_source_corporation_id;
    if ((ceo === null) !== (ceoFrom === null) || (ceo !== null && (!isId(ceo) || !isId(ceoFrom)))) return invalid("ceo");
    try {
      stmts(tx).insert.run(toBind(row.corp_id), row.archetype, row.name, row.ticker, row.sec_band,
        toBind(row.home_system_id), toBind(row.home_station_id),
        row.home_station_corp_id === null ? null : toBind(row.home_station_corp_id), toBind(row.race_faction_id),
        toBind(row.members_target), toBind(row.isk), toBind(row.seed), toBind(row.name_attempt), toBind(row.next_at),
        toBind(row.founded_at), toBind(at), toBind(recruited), ceo === null ? null : toBind(ceo),
        ceoFrom === null ? null : toBind(ceoFrom));
    } catch (err) {
      if (isUnique(err)) return { ok: false, reason: "DUPLICATE" };
      throw err;
    }
    return { ok: true, corpId: row.corp_id };
  }

  function activateInTx(tx, { corpId, expectedVersion, corporationId, nextAt, at }) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(expectedVersion) || !isId(corporationId) || !isTime(nextAt) || !isTime(at)) {
      return invalid("activate");
    }
    const info = stmts(tx).activate.run(toBind(corporationId), toBind(nextAt), toBind(at), toBind(corpId),
      toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function refuseInTx(tx, { corpId, expectedVersion, reason, at }) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(expectedVersion) || typeof reason !== "string" || reason === "" || !isTime(at)) {
      return invalid("refuse");
    }
    const info = stmts(tx).refuse.run(toBind(at), reason.slice(0, 64), toBind(at), toBind(corpId),
      toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function rescheduleInTx(tx, { corpId, expectedVersion, state, nextAt, corporationId, at }) {
    if (txMissing(tx)) return TX_REQUIRED;
    const corp = corporationId === undefined || corporationId === null ? null : corporationId;
    if (!isId(corpId) || !isId(expectedVersion) || !Object.values(CORP_STATES).includes(state) || !isTime(nextAt)
      || !isTime(at) || (corp !== null && !isId(corp))) {
      return invalid("reschedule");
    }
    const info = stmts(tx).reschedule.run(toBind(nextAt), corp === null ? null : toBind(corp), toBind(at),
      toBind(corpId), toBind(expectedVersion), state);
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function advanceCorpInTx(tx, { corpId, expectedVersion, expectedState, row, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    const states = Object.values(CORP_STATES);
    if (!isId(corpId) || !isId(expectedVersion) || !states.includes(expectedState) || !isTime(at) || !row) {
      return invalid("advance");
    }
    for (const c of ADVANCE_COUNTERS) if (!isTime(row[c])) return invalid(c);
    if (!Number.isSafeInteger(row.members_target) || row.members_target < 1 || row.members_target > MAX_MEMBERS) {
      return invalid("members_target");
    }
    if (!states.includes(row.state) || (row.open !== 0 && row.open !== 1)
      || (row.open === 1) !== OPEN_STATES.includes(row.state)) {
      return invalid("state/open");
    }
    const corp = row.corporation_id === undefined || row.corporation_id === null ? null : row.corporation_id;
    if (corp !== null && !isId(corp)) return invalid("corporation_id");
    const ended = row.ended_at === undefined || row.ended_at === null ? null : row.ended_at;
    if ((ended === null) !== (row.open === 1) || (ended !== null && !isTime(ended))) return invalid("ended_at");
    const reason = typeof row.end_reason === "string" && row.end_reason !== ""
      ? row.end_reason.slice(0, MAX_END_REASON_LENGTH) : null;
    const recruited = row.recruited === undefined || row.recruited === null ? null : row.recruited;
    if (recruited !== null && (!Number.isSafeInteger(recruited) || recruited < 0 || recruited >= row.members_target)) {
      return invalid("recruited");
    }
    const mergedInto = row.merged_into === undefined || row.merged_into === null ? null : row.merged_into;
    if (mergedInto !== null && !isId(mergedInto)) return invalid("merged_into");
    const structureSeq = row.structure_seq === undefined || row.structure_seq === null ? null : row.structure_seq;
    if (structureSeq !== null && !isTime(structureSeq)) return invalid("structure_seq");
    const info = stmts(tx).advance.run(row.state, toBind(row.open), toBind(row.isk), toBind(row.struggle_count),
      toBind(row.members_target), toBind(row.venture_seq), toBind(row.recover_until), toBind(row.recover_crew),
      toBind(row.ventures_done), toBind(row.ventures_lost), toBind(row.isk_earned), toBind(row.isk_lost),
      toBind(row.last_review_at), toBind(row.next_at), corp === null ? null : toBind(corp),
      ended === null ? null : toBind(ended), reason, recruited === null ? null : toBind(recruited),
      mergedInto === null ? null : toBind(mergedInto), structureSeq === null ? null : toBind(structureSeq),
      toBind(at), toBind(corpId), toBind(expectedVersion), expectedState);
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function mergePartnersInTx(tx, { archetype, minIsk, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof archetype !== "string" || !isTime(minIsk) || !isId(limit)) return invalid("partners");
    const rows = stmts(tx).partners.all(archetype, toBind(minIsk), toBind(limit)).map((r) => Object.freeze({
      corp_id: num(r.corp_id), home_system_id: num(r.home_system_id), isk: num(r.isk),
      members_target: num(r.members_target), recruited: num(r.recruited), version: num(r.version) }));
    return { ok: true, rows };
  }

  function adjustRecruitedInTx(tx, { corpId, delta, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !Number.isSafeInteger(delta) || delta === 0 || !isTime(at)) return invalid("adjust");
    const info = stmts(tx).adjustRecruited.run(toBind(delta), toBind(at), toBind(corpId), toBind(delta));
    return { ok: true, changed: info.changes === 1 };
  }

  function listCeoReleaseInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).ceoRelease.all(toBind(limit)).map((r) => Object.freeze({ corp_id: num(r.corp_id),
      corporation_id: num(r.corporation_id), version: num(r.version) }));
    return { ok: true, rows };
  }

  function markCeoReleasedInTx(tx, { corpId, value, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || (value !== 1 && value !== 2) || !isTime(at)) return invalid("ceoReleased");
    const info = stmts(tx).ceoReleased.run(toBind(value), toBind(at), toBind(corpId));
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "CONFLICT" };
  }

  function clearCeoInTx(tx, { corpId, characterId, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(characterId) || !isTime(at)) return invalid("clearCeo");
    const info = stmts(tx).clearCeo.run(toBind(at), toBind(corpId), toBind(characterId));
    return { ok: true, cleared: info.changes === 1 };
  }

  function listForViewInTx(tx, { limit }) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).view.all(toBind(limit + 1)).map(rowOf);
    const truncated = rows.length > limit;
    return { ok: true, rows: truncated ? rows.slice(0, limit) : rows, truncated };
  }

  function countsForViewInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const rows = stmts(tx).counts.all().map((r) => Object.freeze({ state: r.state, archetype: r.archetype,
      secBand: r.secBand, n: num(r.n) }));
    return { ok: true, rows };
  }

  return Object.freeze({ listDueInTx, statsInTx, getOpenInTx, getInTx, creditIskInTx, debitIskInTx, refundIskInTx, listOpenBriefInTx, countOpenInHomeInTx, nameOrTickerTakenInTx, insertFoundingInTx,
    activateInTx, refuseInTx, rescheduleInTx, advanceCorpInTx, mergePartnersInTx, adjustRecruitedInTx,
    listCeoReleaseInTx, markCeoReleasedInTx, clearCeoInTx, listForViewInTx, countsForViewInTx });
}

module.exports = { createFreeCorpRepository };
