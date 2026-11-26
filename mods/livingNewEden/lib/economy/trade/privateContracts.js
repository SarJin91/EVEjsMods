"use strict";

const S = require("./schema");
const { defineTable, updateWithVersion, toBind } = require("../../persistence/repository");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const INVALID_INPUT = Object.freeze({ ok: false, reason: "TRADE_INVALID_INPUT" });
const NOT_FOUND = Object.freeze({ ok: false, reason: "NOT_FOUND" });
const VERSION_CONFLICT = Object.freeze({ ok: false, reason: "VERSION_CONFLICT" });

const PRIVATE_CONTRACTS_TABLE = defineTable({
  name: "world_trade_private",
  idColumn: "contract_id",
  columns: [
    "supplier_faction_id", "character_id", "offer_id",
    "ttl_ms", "expires_at", "state", "rejected_at", "created_at",
  ],
});

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isState = (v) => v === "OPEN" || v === "REJECTED" || v === "EXPIRED" || v === "CANCELLED";

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

function createPrivateContract(tx, spec) {
  if (tx.inTransaction !== true) return TX_REQUIRED;
  if (!spec ||
    !isId(spec.contractId) ||
    !isId(spec.supplierFactionId) ||
    !isId(spec.characterId) ||
    typeof spec.offerId !== "string" || spec.offerId === "" ||
    !isTime(spec.ttlMs) ||
    !isTime(spec.expiresAt) ||
    !isTime(spec.at)) {
    return INVALID_INPUT;
  }

  const s = stmts(tx.db);
  try {
    s.insert.run(
      toBind(spec.contractId),
      toBind(spec.supplierFactionId),
      toBind(spec.characterId),
      toBind(spec.offerId),
      toBind(spec.ttlMs),
      toBind(spec.expiresAt),
      toBind("OPEN"),
      toBind(null),
      toBind(spec.at),
      toBind(1),
    );
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg.includes("UNIQUE")) return { ok: false, reason: "CONTRACT_ID_TAKEN", detail: msg };
    return { ok: false, reason: "DB_ERROR", detail: msg };
  }

  const row = s.byId.get(toBind(spec.contractId));
  return { ok: true, contract: toPrivateContract(row) };
}

function listPrivateContracts(tx, factionId, opts = {}) {
  if (tx.inTransaction !== true) return TX_REQUIRED;
  if (!isId(factionId)) return INVALID_INPUT;

  const s = stmts(tx.db);
  const { state, supplierFactionId } = opts;

  let where = "supplier_faction_id = ?";
  const params = [factionId];

  if (state && isState(state)) {
    where += " AND state = ?";
    params.push(state);
  }
  if (supplierFactionId && isId(supplierFactionId)) {
    where += " AND supplier_faction_id = ?";
    params.push(supplierFactionId);
  }

  const sql = `SELECT * FROM world_trade_private WHERE ${where} ORDER BY created_at DESC`;
  const rows = s.db.prepare(sql).all(...params.map(toBind));
  return { ok: true, contracts: rows.map(toPrivateContract) };
}

function rejectPrivateContract(tx, contractId, reason, now) {
  if (tx.inTransaction !== true) return TX_REQUIRED;
  if (!isId(contractId) || typeof reason !== "string" || reason === "" || !isTime(now)) {
    return INVALID_INPUT;
  }

  const s = stmts(tx.db);
  const row = s.byId.get(toBind(contractId));
  if (!row) return NOT_FOUND;
  if (row.state !== "OPEN") return { ok: false, reason: "INVALID_TRANSITION", detail: `state=${row.state}` };

  const update = updateWithVersion(tx.db, PRIVATE_CONTRACTS_TABLE, contractId, row.version, {
    state: "REJECTED",
    rejected_at: now,
    updated_at: now,
  });
  if (!update.ok) return update;

  const updated = s.byId.get(toBind(contractId));
  return { ok: true, contract: toPrivateContract(updated) };
}

function expirePrivateContracts(tx, now) {
  if (tx.inTransaction !== true) return TX_REQUIRED;
  if (!isTime(now)) return INVALID_INPUT;

  const s = stmts(tx.db);
  const rows = s.db.prepare(
    "SELECT contract_id, version FROM world_trade_private WHERE state = 'OPEN' AND expires_at <= ?"
  ).all(toBind(now));

  let expired = 0;
  for (const row of rows) {
    const update = updateWithVersion(tx.db, PRIVATE_CONTRACTS_TABLE, row.contract_id, row.version, {
      state: "EXPIRED",
      updated_at: now,
    });
    if (update.ok) expired += 1;
  }
  return { ok: true, expired };
}

function cleanupRejected(tx, now, rejectedCleanupMs) {
  if (tx.inTransaction !== true) return TX_REQUIRED;
  if (!isTime(now) || !isTime(rejectedCleanupMs)) return INVALID_INPUT;

  const s = stmts(tx.db);
  const cutoff = now - rejectedCleanupMs;
  const rows = s.db.prepare(
    "SELECT contract_id FROM world_trade_private WHERE state = 'REJECTED' AND rejected_at IS NOT NULL AND rejected_at <= ?"
  ).all(toBind(cutoff));

  let deleted = 0;
  for (const row of rows) {
    const info = s.db.prepare("DELETE FROM world_trade_private WHERE contract_id = ?").run(toBind(row.contract_id));
    if (info.changes > 0) deleted += 1;
  }
  return { ok: true, deleted };
}

function toPrivateContract(row) {
  return Object.freeze({
    contractId: row.contract_id,
    supplierFactionId: row.supplier_faction_id,
    characterId: row.character_id,
    offerId: row.offer_id,
    ttlMs: row.ttl_ms,
    expiresAt: row.expires_at,
    state: row.state,
    rejectedAt: row.rejected_at,
    createdAt: row.created_at,
    version: row.version,
  });
}

const stmtsCache = new WeakMap();
function stmts(db) {
  let s = stmtsCache.get(db);
  if (s) return s;
  s = {
    db,
    byId: db.prepare("SELECT * FROM world_trade_private WHERE contract_id = ?"),
    insert: db.prepare(
      `INSERT INTO world_trade_private (contract_id, supplier_faction_id, character_id, offer_id,
        ttl_ms, expires_at, state, rejected_at, created_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
  };
  stmtsCache.set(db, s);
  return s;
}

module.exports = {
  createPrivateContract,
  listPrivateContracts,
  rejectPrivateContract,
  expirePrivateContracts,
  cleanupRejected,
};