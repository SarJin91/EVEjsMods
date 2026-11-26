"use strict";

const { toBind } = require("../../persistence/repository");
const { TABLE_NAME } = require("./schema");
const D = require("../data/capsuleers");

const T = TABLE_NAME;
const MAX_MEMBERS = 16;
const CREATE_KEYS = Object.freeze(["slot", "factionId", "name", "ticker", "baseSystemId", "baseStationId",
  "baseStationCorpId", "raceFactionId", "iskBalance", "seed", "at"]);

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1;
const invalid = (detail) => ({ ok: false, reason: "CAPSULEERS_INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const isUnique = (err) => Boolean(err && (err.code === "SQLITE_CONSTRAINT_UNIQUE"
  || err.code === "SQLITE_CONSTRAINT_PRIMARYKEY"));

function parseMembers(text) {
  if (typeof text !== "string" || text === "") return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter(isId) : [];
  } catch (_err) {
    return [];
  }
}

function toCorp(row) {
  return Object.freeze({
    corpSlot: num(row.corp_slot),
    factionId: num(row.faction_id),
    name: row.name,
    ticker: row.ticker,
    state: row.state,
    reason: row.reason,
    baseSystemId: num(row.base_system_id),
    baseStationId: num(row.base_station_id),
    baseStationCorpId: num(row.base_station_corp_id),
    raceFactionId: num(row.race_faction_id),
    corporationId: num(row.corporation_id),
    ceoCharacterId: num(row.ceo_character_id),
    memberIds: Object.freeze(parseMembers(row.member_ids_json)),
    iskBalance: num(row.isk_balance),
    fleetsBought: num(row.fleets_bought),
    seed: num(row.seed),
    foundedAt: num(row.founded_at),
    activatedAt: num(row.activated_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    version: num(row.version),
  });
}

function uniqueRefusal(err) {
  const text = String((err && err.message) || "");
  if (text.includes("base_system_id")) return { ok: false, reason: "BASE_TAKEN" };
  if (text.includes("corporation_id")) return { ok: false, reason: "CORPORATION_TAKEN" };
  return { ok: false, reason: "SLOT_TAKEN" };
}

function createCorpRepository() {
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      insert: db.prepare(`INSERT INTO ${T} (corp_slot, faction_id, name, ticker, state, reason, base_system_id,
        base_station_id, base_station_corp_id, race_faction_id, corporation_id, ceo_character_id, member_ids_json,
        isk_balance, fleets_bought, seed, founded_at, activated_at, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, 'FOUNDING', NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, ?, ?, NULL, ?, ?, 1)`),
      bySlot: db.prepare(`SELECT * FROM ${T} WHERE corp_slot = ?`),
      list: db.prepare(`SELECT * FROM ${T} ORDER BY corp_slot LIMIT ?`),
      activate: db.prepare(`UPDATE ${T} SET state = 'ACTIVE', corporation_id = ?, ceo_character_id = ?,
        member_ids_json = ?, name = ?, ticker = ?, activated_at = ?, updated_at = ?, version = version + 1
        WHERE corp_slot = ? AND version = ? AND state = 'FOUNDING'`),
      refuse: db.prepare(`UPDATE ${T} SET state = 'REFUSED', reason = ?, updated_at = ?, version = version + 1
        WHERE corp_slot = ? AND version = ? AND state = 'FOUNDING'`),
      credit: db.prepare(`UPDATE ${T} SET isk_balance = isk_balance + ?, updated_at = ?, version = version + 1
        WHERE corp_slot = ? AND version = ? AND state = 'ACTIVE' AND isk_balance + ? <= ?`),
      debit: db.prepare(`UPDATE ${T} SET isk_balance = isk_balance - ?, fleets_bought = fleets_bought + 1,
        updated_at = ?, version = version + 1 WHERE corp_slot = ? AND version = ? AND state = 'ACTIVE'
        AND isk_balance >= ?`),
      members: db.prepare(`UPDATE ${T} SET member_ids_json = ?, updated_at = ?, version = version + 1
        WHERE corp_slot = ? AND version = ? AND state = 'ACTIVE'`),
    };
    perDb.set(db, s);
    return s;
  }

  function after(tx, slot, info, refusal) {
    if (info.changes !== 1) return refusal;
    return { ok: true, corp: toCorp(stmts(tx).bySlot.get(toBind(slot))) };
  }

  function createCorp(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec !== "object") return invalid("spec");
    const extra = Object.keys(spec).find((k) => !CREATE_KEYS.includes(k));
    if (extra !== undefined) return invalid(`spec.${extra}`);
    for (const k of ["slot", "factionId", "baseSystemId", "baseStationId", "raceFactionId"]) {
      if (!isId(spec[k])) return invalid(k);
    }
    if (spec.baseStationCorpId !== null && !isId(spec.baseStationCorpId)) return invalid("baseStationCorpId");
    if (typeof spec.name !== "string" || spec.name.length < 1 || spec.name.length > 50) return invalid("name");
    if (typeof spec.ticker !== "string" || !/^[A-Z0-9]{2,5}$/.test(spec.ticker)) return invalid("ticker");
    for (const k of ["iskBalance", "seed", "at"]) if (!isCount(spec[k])) return invalid(k);
    const s = stmts(tx);
    try {
      s.insert.run(toBind(spec.slot), toBind(spec.factionId), spec.name, spec.ticker, toBind(spec.baseSystemId),
        toBind(spec.baseStationId), spec.baseStationCorpId === null ? null : toBind(spec.baseStationCorpId),
        toBind(spec.raceFactionId), toBind(spec.iskBalance), toBind(spec.seed), toBind(spec.at), toBind(spec.at),
        toBind(spec.at));
    } catch (err) {
      if (isUnique(err) && tx.inTransaction === true) return uniqueRefusal(err);
      throw err;
    }
    return { ok: true, corp: toCorp(s.bySlot.get(toBind(spec.slot))) };
  }

  function getCorp(tx, slot) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(slot)) return invalid("slot");
    const row = stmts(tx).bySlot.get(toBind(slot));
    return { ok: true, corp: row ? toCorp(row) : null };
  }

  function listCorps(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) return invalid("limit");
    return { ok: true, corps: stmts(tx).list.all(toBind(o.limit)).map(toCorp) };
  }

  function activate(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isId(c.slot) || !isVersion(c.expectedVersion)) return invalid("slot/expectedVersion");
    if (!isId(c.corporationId) || !isId(c.ceoCharacterId)) return invalid("corporationId/ceoCharacterId");
    if (!Array.isArray(c.memberIds) || c.memberIds.length > MAX_MEMBERS || !c.memberIds.every(isId)) {
      return invalid("memberIds");
    }
    if (typeof c.name !== "string" || c.name.length < 1 || c.name.length > 50) return invalid("name");
    if (typeof c.ticker !== "string" || c.ticker.length < 2 || c.ticker.length > 5) return invalid("ticker");
    if (!isCount(c.at)) return invalid("at");
    let info;
    try {
      info = stmts(tx).activate.run(toBind(c.corporationId), toBind(c.ceoCharacterId), JSON.stringify(c.memberIds),
        c.name, c.ticker, toBind(c.at), toBind(c.at), toBind(c.slot), toBind(c.expectedVersion));
    } catch (err) {
      if (isUnique(err) && tx.inTransaction === true) return uniqueRefusal(err);
      throw err;
    }
    return after(tx, c.slot, info, { ok: false, reason: "VERSION_CONFLICT" });
  }

  function refuse(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isId(c.slot) || !isVersion(c.expectedVersion)) return invalid("slot/expectedVersion");
    if (typeof c.reason !== "string" || c.reason.length < 1) return invalid("reason");
    if (!isCount(c.at)) return invalid("at");
    const info = stmts(tx).refuse.run(c.reason.slice(0, 64), toBind(c.at), toBind(c.slot),
      toBind(c.expectedVersion));
    return after(tx, c.slot, info, { ok: false, reason: "VERSION_CONFLICT" });
  }

  function credit(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isId(c.slot) || !isVersion(c.expectedVersion)) return invalid("slot/expectedVersion");
    if (!isId(c.amount) || !isId(c.maxBalance) || !isCount(c.at)) return invalid("amount/maxBalance/at");
    const info = stmts(tx).credit.run(toBind(c.amount), toBind(c.at), toBind(c.slot), toBind(c.expectedVersion),
      toBind(c.amount), toBind(c.maxBalance));
    return after(tx, c.slot, info, { ok: false, reason: "WALLET_REFUSED" });
  }

  function debitForFleet(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isId(c.slot) || !isVersion(c.expectedVersion)) return invalid("slot/expectedVersion");
    if (!isId(c.amount) || !isCount(c.at)) return invalid("amount/at");
    const info = stmts(tx).debit.run(toBind(c.amount), toBind(c.at), toBind(c.slot), toBind(c.expectedVersion),
      toBind(c.amount));
    return after(tx, c.slot, info, { ok: false, reason: "WALLET_REFUSED" });
  }

  function setMembers(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isId(c.slot) || !isVersion(c.expectedVersion)) return invalid("slot/expectedVersion");
    if (!Array.isArray(c.memberIds) || c.memberIds.length < 1 || c.memberIds.length > D.MAX_MEMBERS
      || !c.memberIds.every(isId) || new Set(c.memberIds).size !== c.memberIds.length) return invalid("memberIds");
    if (!isCount(c.at)) return invalid("at");
    const s = stmts(tx);
    const sorted = c.memberIds.slice().sort((a, b) => a - b);
    const info = s.members.run(JSON.stringify(sorted), toBind(c.at), toBind(c.slot), toBind(c.expectedVersion));
    if (info.changes === 1) return { ok: true, corp: toCorp(s.bySlot.get(toBind(c.slot))) };
    const row = s.bySlot.get(toBind(c.slot));
    if (!row || row.state !== "ACTIVE") return { ok: false, reason: "STATE_CHANGED" };
    return { ok: false, reason: "VERSION_CONFLICT" };
  }

  return Object.freeze({ createCorp, getCorp, listCorps, activate, refuse, credit, debitForFleet, setMembers });
}

module.exports = { createCorpRepository, toCorp };
