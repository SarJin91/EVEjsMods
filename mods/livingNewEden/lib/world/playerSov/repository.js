"use strict";

const { toBind } = require("../../persistence/repository");
const S = require("./schema");
const { canTransitionPlayerSov } = require("./machine");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const txMissing = (db) => !db || db.inTransaction !== true;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const failed = (err) => ({ ok: false, reason: S.CODES.SQL_FAILED,
  detail: String((err && err.message) || err).slice(0, 120) });
const isUnique = (err) => String((err && err.code) || "").startsWith("SQLITE_CONSTRAINT_UNIQUE")
  || String((err && err.code) || "").startsWith("SQLITE_CONSTRAINT_PRIMARYKEY");
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const bindOrNull = (v) => (v === null || v === undefined ? null : toBind(v));

function toClaim(row) {
  return Object.freeze({
    claimId: row.claim_id, systemId: Number(row.system_id), allianceId: Number(row.alliance_id),
    corpId: Number(row.corp_id), hubItemId: Number(row.hub_item_id), origin: row.origin, state: row.state,
    baseState: row.base_state, endReason: row.end_reason, attackerFactionId: numOrNull(row.attacker_faction_id),
    attackStartedAt: numOrNull(row.attack_started_at), reinforcedUntil: numOrNull(row.reinforced_until),
    retakeAttempts: Number(row.retake_attempts), firstSeenAt: Number(row.first_seen_at),
    heldSinceAt: numOrNull(row.held_since_at), endedAt: numOrNull(row.ended_at), version: Number(row.version),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  });
}

function nextColumns(claim, c) {
  const next = { state: c.to, baseState: claim.baseState, endReason: null, attackerFactionId: claim.attackerFactionId,
    attackStartedAt: claim.attackStartedAt, reinforcedUntil: claim.reinforcedUntil, heldSinceAt: claim.heldSinceAt,
    endedAt: null, retakeAttempts: claim.retakeAttempts };
  if (c.to === S.LOST) {
    next.endReason = c.reason;
    next.endedAt = c.at;
  } else if (c.to === S.SIEGED) {
    if (!isId(c.attackerFactionId)) return null;
    next.attackerFactionId = c.attackerFactionId;
    next.attackStartedAt = c.at;
  } else if (c.to === S.REINFORCED) {
    if (!isTime(c.reinforcedUntil)) return null;
    next.reinforcedUntil = c.reinforcedUntil;
  } else if (c.to === S.RETAKING) {
    next.retakeAttempts = claim.retakeAttempts + 1;
  } else if (claim.state === S.CAPTURING && c.to === S.HELD) {
    next.baseState = S.HELD;
    next.heldSinceAt = c.at;
  } else {
    if (c.to !== claim.baseState) return null;
    next.attackerFactionId = null;
    next.attackStartedAt = null;
    next.reinforcedUntil = null;
  }
  return next;
}

function createPlayerSovRepository() {
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE_NAME;
    const L = S.LIVE_SQL;
    s = {
      byId: db.prepare(`SELECT * FROM ${T} WHERE claim_id = ?`),
      liveInSystem: db.prepare(`SELECT * FROM ${T} WHERE system_id = ? AND state IN ${L}`),
      live: db.prepare(`SELECT * FROM ${T} WHERE state IN ${L} ORDER BY system_id`),
      liveCount: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state IN ${L}`),
      byState: db.prepare(`SELECT * FROM ${T} WHERE state IN ${L} AND state = ? AND updated_at <= ?
        ORDER BY updated_at, claim_id LIMIT ?`),
      insert: db.prepare(`INSERT INTO ${T} (claim_id, system_id, alliance_id, corp_id, hub_item_id, origin, state,
        base_state, end_reason, attacker_faction_id, attack_started_at, reinforced_until, retake_attempts,
        first_seen_at, held_since_at, ended_at, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?, NULL, 1, ?, ?)`),
      transition: db.prepare(`UPDATE ${T} SET state = ?, base_state = ?, end_reason = ?, attacker_faction_id = ?,
        attack_started_at = ?, reinforced_until = ?, held_since_at = ?, ended_at = ?, retake_attempts = ?,
        updated_at = ?, version = version + 1 WHERE claim_id = ? AND version = ? AND state = ?`),
      setBase: db.prepare(`UPDATE ${T} SET base_state = ?, held_since_at = coalesce(held_since_at, ?), updated_at = ?,
        version = version + 1 WHERE claim_id = ? AND version = ? AND state IN ${L}`),
      prunePage: db.prepare(`SELECT claim_id FROM ${T} WHERE state = 'LOST' AND updated_at < ?
        ORDER BY updated_at LIMIT ?`),
      pruneRow: db.prepare(`DELETE FROM ${T} WHERE claim_id = ? AND state = 'LOST'`),
      panel: db.prepare(`SELECT * FROM ${T} ORDER BY (state IN ${L}) DESC, updated_at DESC, claim_id LIMIT ?`),
      siegesOf: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE attacker_faction_id = ?
        AND state IN ('SIEGED','REINFORCED','RETAKING')`),
    };
    cache.set(db, s);
    return s;
  }

  function getById(db, claimId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isText(claimId, S.MAX_ID_LENGTH)) return invalid("claimId");
    try {
      const row = stmts(db).byId.get(claimId);
      return { ok: true, claim: row ? toClaim(row) : null };
    } catch (err) {
      return failed(err);
    }
  }

  function getLiveInSystem(db, systemId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    try {
      const row = stmts(db).liveInSystem.get(toBind(systemId));
      return { ok: true, claim: row ? toClaim(row) : null };
    } catch (err) {
      return failed(err);
    }
  }

  function listLive(db) {
    if (txMissing(db)) return TX_REQUIRED;
    try {
      return { ok: true, claims: stmts(db).live.all().map(toClaim) };
    } catch (err) {
      return failed(err);
    }
  }

  function countLive(db) {
    if (txMissing(db)) return TX_REQUIRED;
    try {
      return { ok: true, live: Number(stmts(db).liveCount.get().n) };
    } catch (err) {
      return failed(err);
    }
  }

  function countSiegesOf(db, factionId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    try {
      return { ok: true, count: Number(stmts(db).siegesOf.get(toBind(factionId)).n) };
    } catch (err) {
      return failed(err);
    }
  }

  function listByState(db, state, before, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!S.LIVE_STATES.includes(state) || !isTime(before) || !isId(limit)) return invalid("byState");
    try {
      return { ok: true, claims: stmts(db).byState.all(state, toBind(before), toBind(limit)).map(toClaim) };
    } catch (err) {
      return failed(err);
    }
  }

  function insertClaim(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const p = spec || {};
    if (!isId(p.systemId) || !isId(p.allianceId) || !isId(p.corpId) || !isId(p.hubItemId)
      || !S.ORIGINS.includes(p.origin) || !S.BASE_STATES.includes(p.state) || !isTime(p.at)) return invalid("spec");
    const claimId = S.claimIdOf(p.systemId, p.allianceId, p.hubItemId);
    if (claimId.length > S.MAX_ID_LENGTH) return invalid("claimId");
    try {
      const s = stmts(db);
      const old = s.byId.get(claimId);
      if ((old && old.state !== S.LOST) || s.liveInSystem.get(toBind(p.systemId))) {
        return { ok: false, reason: S.CODES.DUPLICATE, claimId };
      }
      const replacedLost = Boolean(old) && Number(s.pruneRow.run(claimId).changes) === 1;
      s.insert.run(claimId, toBind(p.systemId), toBind(p.allianceId), toBind(p.corpId), toBind(p.hubItemId), p.origin,
        p.state, p.state, toBind(p.at), p.state === S.HELD ? toBind(p.at) : null, toBind(p.at), toBind(p.at));
      const claim = toClaim(s.byId.get(claimId));
      return replacedLost ? { ok: true, claim, replacedLost: true } : { ok: true, claim };
    } catch (err) {
      if (isUnique(err)) return { ok: false, reason: S.CODES.DUPLICATE, claimId };
      return failed(err);
    }
  }

  function transition(db, change) {
    if (txMissing(db)) return TX_REQUIRED;
    const c = change || {};
    const claim = c.claim;
    if (!claim || !isText(claim.claimId, S.MAX_ID_LENGTH) || !isId(claim.version) || !isTime(c.at)) {
      return invalid("change");
    }
    const edge = canTransitionPlayerSov(claim.state, c.to, c.to === S.LOST ? c.reason : null);
    if (!edge.ok) return edge;
    const n = nextColumns(claim, c);
    if (n === null) return { ok: false, reason: S.CODES.TRANSITION_DENIED, from: claim.state, to: String(c.to) };
    try {
      const s = stmts(db);
      const r = s.transition.run(n.state, n.baseState, n.endReason, bindOrNull(n.attackerFactionId),
        bindOrNull(n.attackStartedAt), bindOrNull(n.reinforcedUntil), bindOrNull(n.heldSinceAt), bindOrNull(n.endedAt),
        toBind(n.retakeAttempts), toBind(c.at), claim.claimId, toBind(claim.version), claim.state);
      if (Number(r.changes) !== 1) return { ok: false, reason: S.CODES.VERSION_CONFLICT, claimId: claim.claimId };
      return { ok: true, claim: toClaim(s.byId.get(claim.claimId)) };
    } catch (err) {
      return failed(err);
    }
  }

  function setBase(db, claim, baseState, at) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!claim || !isText(claim.claimId, S.MAX_ID_LENGTH) || !isId(claim.version) || !S.BASE_STATES.includes(baseState)
      || !isTime(at)) return invalid("setBase");
    try {
      const s = stmts(db);
      const r = s.setBase.run(baseState, baseState === S.HELD ? toBind(at) : null, toBind(at), claim.claimId,
        toBind(claim.version));
      if (Number(r.changes) !== 1) return { ok: false, reason: S.CODES.VERSION_CONFLICT, claimId: claim.claimId };
      return { ok: true, claim: toClaim(s.byId.get(claim.claimId)) };
    } catch (err) {
      return failed(err);
    }
  }

  function pruneTerminal(db, before, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isTime(before) || !isId(limit)) return invalid("prune");
    try {
      const s = stmts(db);
      let pruned = 0;
      for (const row of s.prunePage.all(toBind(before), toBind(limit))) {
        pruned += Number(s.pruneRow.run(row.claim_id).changes);
      }
      return { ok: true, pruned };
    } catch (err) {
      return failed(err);
    }
  }

  function listForPanel(db, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    try {
      const rows = stmts(db).panel.all(toBind(limit + 1));
      return { ok: true, claims: rows.slice(0, limit).map(toClaim), truncated: rows.length > limit };
    } catch (err) {
      return failed(err);
    }
  }

  return Object.freeze({ getById, getLiveInSystem, listLive, countLive, countSiegesOf, listByState, insertClaim, transition, setBase,
    pruneTerminal, listForPanel });
}

module.exports = { createPlayerSovRepository, toClaim };
