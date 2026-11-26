"use strict";

const { toBind } = require("../../persistence/repository");
const S = require("./schema");
const { HELD, LOSS_REASONS } = require("./claimRules");

const T = S.CLAIM_TABLE;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "CAPSULEERS_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const isUnique = (err) => Boolean(err && (err.code === "SQLITE_CONSTRAINT_UNIQUE"
  || err.code === "SQLITE_CONSTRAINT_PRIMARYKEY"));

function toClaim(row) {
  return Object.freeze({
    claimId: row.claim_id, corpSlot: num(row.corp_slot), systemId: num(row.system_id), state: row.state,
    claimedAt: num(row.claimed_at), lostAt: num(row.lost_at), lostReason: row.lost_reason,
    createdAt: num(row.created_at), updatedAt: num(row.updated_at), version: num(row.version),
  });
}

function createClaimRepository() {
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      byId: db.prepare(`SELECT * FROM ${T} WHERE claim_id = ?`),
      heldBySystem: db.prepare(`SELECT * FROM ${T} WHERE system_id = ? AND state = 'HELD'`),
      listHeld: db.prepare(`SELECT * FROM ${T} WHERE state = 'HELD' ORDER BY claim_id LIMIT ?`),
      insert: db.prepare(`INSERT INTO ${T} (claim_id, corp_slot, system_id, state, claimed_at, lost_at, lost_reason,
        created_at, updated_at, version) VALUES (?, ?, ?, 'HELD', ?, NULL, NULL, ?, ?, 1)`),
      lose: db.prepare(`UPDATE ${T} SET state = 'LOST', lost_at = ?, lost_reason = ?, updated_at = ?,
        version = version + 1 WHERE claim_id = ? AND version = ? AND state = 'HELD'`),
      pruneIds: db.prepare(`SELECT claim_id FROM ${T} WHERE lost_at IS NOT NULL AND lost_at < ?
        ORDER BY lost_at, claim_id LIMIT ?`),
      deleteClaim: db.prepare(`DELETE FROM ${T} WHERE claim_id = ?`),
    };
    cache.set(db, s);
    return s;
  }

  function createClaimInDb(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const p = spec || {};
    if (!isText(p.claimId, S.MAX_ID_LENGTH) || !isId(p.slot) || !isId(p.systemId) || !isTime(p.at)) {
      return invalid("spec");
    }
    const s = stmts(db);
    if (s.byId.get(p.claimId)) return { ok: false, reason: "CLAIM_EXISTS", claimId: p.claimId };
    const held = s.heldBySystem.get(toBind(p.systemId));
    if (held) return { ok: false, reason: "CLAIM_TAKEN", claimId: held.claim_id };
    try {
      s.insert.run(p.claimId, toBind(p.slot), toBind(p.systemId), toBind(p.at), toBind(p.at), toBind(p.at));
    } catch (err) {
      if (isUnique(err) && db.inTransaction === true) return { ok: false, reason: "CLAIM_TAKEN" };
      throw err;
    }
    return { ok: true, claim: toClaim(s.byId.get(p.claimId)) };
  }

  function loseClaimInDb(db, change) {
    if (txMissing(db)) return TX_REQUIRED;
    const p = change || {};
    if (!isText(p.claimId, S.MAX_ID_LENGTH) || !Number.isSafeInteger(p.expectedVersion) || p.expectedVersion < 1
      || !LOSS_REASONS.includes(p.reason) || !isTime(p.at)) return invalid("change");
    const s = stmts(db);
    const row = s.byId.get(p.claimId);
    if (!row) return { ok: false, reason: "ROW_NOT_FOUND", claimId: p.claimId };
    if (row.state !== HELD) return { ok: false, reason: "STATE_CHANGED", state: row.state };
    if (Number(row.version) !== p.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: p.expectedVersion,
        actualVersion: Number(row.version) };
    }
    const info = s.lose.run(toBind(p.at), p.reason, toBind(p.at), p.claimId, toBind(p.expectedVersion));
    if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
    return { ok: true, claim: toClaim(s.byId.get(p.claimId)) };
  }

  function prune(tx, before, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isCount(limit)) return invalid("prune");
    if (limit === 0) return { ok: true, pruned: 0 };
    const s = stmts(tx);
    const ids = s.pruneIds.all(toBind(before), toBind(limit)).map((r) => r.claim_id);
    for (const id of ids) s.deleteClaim.run(id);
    return { ok: true, pruned: ids.length };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    createClaimInDb,
    loseClaimInDb,
    prune,
    listHeld: (tx, opts) => read(tx, (s) => {
      const o = opts || {};
      if (!isId(o.limit)) return invalid("limit");
      return { ok: true, claims: s.listHeld.all(toBind(o.limit)).map(toClaim) };
    }),
    findHeldBySystem: (tx, systemId) => read(tx, (s) => {
      if (!isId(systemId)) return invalid("systemId");
      const row = s.heldBySystem.get(toBind(systemId));
      return { ok: true, claim: row ? toClaim(row) : null };
    }),
    getClaim: (tx, claimId) => read(tx, (s) => {
      if (!isText(claimId, S.MAX_ID_LENGTH)) return invalid("claimId");
      const row = s.byId.get(claimId);
      return { ok: true, claim: row ? toClaim(row) : null };
    }),
  });
}

module.exports = { createClaimRepository, toClaim };
