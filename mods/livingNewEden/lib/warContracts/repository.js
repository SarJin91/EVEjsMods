"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isTime = (v) => Number.isSafeInteger(v);
const isText = (v) => typeof v === "string" && v !== "";
const LEGS = Object.freeze(Object.values(S.LEG));
const SETTLE_TO = Object.freeze([S.STATE.AWARDED, S.STATE.CAPPED, S.STATE.LAPSED]);
const MAX_ERROR = 120;
const LIST_AWARDS_MAX = 64;

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function rowOf(r) {
  return Object.freeze({ offerId: r.offer_id, factionId: Number(r.faction_id), stationId: r.station_id,
    systemId: Number(r.system_id), itemKind: r.item_kind, itemKey: r.item_key, typeId: Number(r.type_id),
    quantity: Number(r.quantity), iskTotal: Number(r.isk_total), state: r.state, endReason: r.end_reason,
    characterId: num(r.character_id), lpCorporationId: num(r.lp_corporation_id), iskAmount: Number(r.isk_amount),
    lpAmount: Number(r.lp_amount), standingMicro: Number(r.standing_micro), description: r.description,
    iskState: r.isk_state, lpState: r.lp_state, stdState: r.std_state, payoutState: r.payout_state,
    attempts: Number(r.attempts), nextAttemptAt: num(r.next_attempt_at), lastError: r.last_error,
    adoptedAt: Number(r.adopted_at), awardedAt: num(r.awarded_at), endedAt: num(r.ended_at),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), version: Number(r.version) });
}

function validOpen(w) {
  if (!w || typeof w !== "object") return "row";
  if (!isText(w.offerId) || w.offerId.length < 4 || w.offerId.length > 64) return "offerId";
  if (!isId(w.factionId)) return "factionId";
  if (!isText(w.stationId) || w.stationId.length > 64) return "stationId";
  if (!isId(w.systemId)) return "systemId";
  if (!isText(w.itemKind) || w.itemKind.length > 16) return "itemKind";
  if (!isText(w.itemKey) || w.itemKey.length > 64) return "itemKey";
  if (!isId(w.typeId)) return "typeId";
  if (!isId(w.quantity)) return "quantity";
  if (!isNonNegInt(w.iskTotal)) return "iskTotal";
  if (w.lpCorporationId !== null && !isId(w.lpCorporationId)) return "lpCorporationId";
  if (!isNonNegInt(w.iskAmount)) return "iskAmount";
  if (!isNonNegInt(w.lpAmount)) return "lpAmount";
  if (!isNonNegInt(w.standingMicro)) return "standingMicro";
  if (!isText(w.description) || w.description.length > S.MAX_DESCRIPTION) return "description";
  if (!isTime(w.at)) return "at";
  return null;
}

function createWarContractRepository() {
  function getInTx(tx, offerId) {
    if (!isText(offerId)) return invalid("offerId");
    const r = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE offer_id = ?`).get(offerId);
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function insertOpenInTx(tx, w) {
    const bad = validOpen(w);
    if (bad) return invalid(bad);
    const r = tx.prepare(`INSERT INTO ${S.TABLE} (offer_id, faction_id, station_id, system_id, item_kind, item_key,
      type_id, quantity, isk_total, state, end_reason, character_id, lp_corporation_id, isk_amount, lp_amount,
      standing_micro, description, isk_state, lp_state, std_state, payout_state, attempts, next_attempt_at, last_error,
      adopted_at, awarded_at, ended_at, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, NULL,
        NULL, ?, ?, 1)
      ON CONFLICT (offer_id) DO NOTHING`)
      .run(w.offerId, w.factionId, w.stationId, w.systemId, w.itemKind, w.itemKey, w.typeId, w.quantity, w.iskTotal,
        S.STATE.OPEN, w.lpCorporationId, w.iskAmount, w.lpAmount, w.standingMicro, w.description, w.at, w.at, w.at);
    if (Number(r.changes) !== 1) return { ok: false, reason: "EXISTS" };
    return { ok: true };
  }

  function listOpenInTx(tx, opts) {
    const after = opts && typeof opts.afterOfferId === "string" ? opts.afterOfferId : "";
    const limit = opts && opts.limit;
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE state = 'OPEN' AND offer_id > ?
      ORDER BY offer_id LIMIT ?`).all(after, limit).map(rowOf);
    return { ok: true, rows, nextAfter: rows.length === limit ? rows[rows.length - 1].offerId : null };
  }

  function countOpenInTx(tx) {
    const row = tx.prepare(`SELECT count(*) AS n FROM ${S.TABLE} WHERE state = 'OPEN'`).get();
    return { ok: true, count: Number(row.n) };
  }

  function countAwardsSinceInTx(tx, characterId, sinceMs) {
    if (!isId(characterId)) return invalid("characterId");
    if (!isTime(sinceMs)) return invalid("sinceMs");
    const row = tx.prepare(`SELECT count(*) AS n FROM ${S.TABLE}
      WHERE character_id = ? AND awarded_at IS NOT NULL AND awarded_at >= ?`).get(characterId, sinceMs);
    return { ok: true, count: Number(row.n) };
  }

  function listAwardsOfCharacterInTx(tx, q) {
    const { characterId, sinceMs, limit } = q || {};
    if (!isId(characterId)) return invalid("characterId");
    if (!isTime(sinceMs)) return invalid("sinceMs");
    if (!isId(limit) || limit > LIST_AWARDS_MAX) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.TABLE}
      WHERE character_id = ? AND awarded_at IS NOT NULL AND awarded_at >= ?
      ORDER BY awarded_at DESC, offer_id LIMIT ?`).all(characterId, sinceMs, limit);
    return { ok: true, rows: rows.map(rowOf) };
  }

  function settleInTx(tx, s) {
    if (!s || !isText(s.offerId)) return invalid("offerId");
    if (!isId(s.expectedVersion)) return invalid("expectedVersion");
    if (!SETTLE_TO.includes(s.to)) return invalid("to");
    if (!isTime(s.at)) return invalid("at");
    let r;
    if (s.to === S.STATE.AWARDED) {
      if (!isId(s.characterId)) return invalid("characterId");
      const legs = s.legs || {};
      for (const leg of ["isk", "lp", "std"]) if (!LEGS.includes(legs[leg])) return invalid(`legs.${leg}`);
      if (s.payoutState !== S.PAYOUT.PENDING && s.payoutState !== S.PAYOUT.PAID) return invalid("payoutState");
      const endedAt = s.payoutState === S.PAYOUT.PAID ? s.at : null;
      r = tx.prepare(`UPDATE ${S.TABLE} SET state = ?, character_id = ?, awarded_at = ?, isk_state = ?, lp_state = ?,
        std_state = ?, payout_state = ?, next_attempt_at = ?, ended_at = ?, updated_at = ?, version = version + 1
        WHERE offer_id = ? AND state = 'OPEN' AND version = ?`).run(S.STATE.AWARDED, s.characterId, s.at, legs.isk,
        legs.lp, legs.std, s.payoutState, s.at, endedAt, s.at, s.offerId, s.expectedVersion);
    } else if (s.to === S.STATE.CAPPED) {
      if (!isId(s.characterId)) return invalid("characterId");
      r = tx.prepare(`UPDATE ${S.TABLE} SET state = ?, character_id = ?, end_reason = ?, ended_at = ?, updated_at = ?,
        version = version + 1 WHERE offer_id = ? AND state = 'OPEN' AND version = ?`).run(S.STATE.CAPPED,
        s.characterId, S.END_REASON_DAILY_CAP, s.at, s.at, s.offerId, s.expectedVersion);
    } else {
      if (!isText(s.reason)) return invalid("reason");
      r = tx.prepare(`UPDATE ${S.TABLE} SET state = ?, end_reason = ?, ended_at = ?, updated_at = ?,
        version = version + 1 WHERE offer_id = ? AND state = 'OPEN' AND version = ?`).run(S.STATE.LAPSED,
        s.reason.slice(0, S.MAX_END_REASON), s.at, s.at, s.offerId, s.expectedVersion);
    }
    return { ok: true, changed: Number(r.changes) === 1 };
  }

  function listDuePayoutsInTx(tx, now, limit) {
    if (!isTime(now)) return invalid("now");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE payout_state = 'PENDING' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, offer_id LIMIT ?`).all(now, limit);
    return { ok: true, rows: rows.map((r) => Object.freeze({ payoutKey: S.payoutKeyOf(r.offer_id),
      characterId: num(r.character_id), issuerFactionId: Number(r.faction_id), systemId: Number(r.system_id),
      lpCorporationId: num(r.lp_corporation_id), iskAmount: Number(r.isk_amount), lpAmount: Number(r.lp_amount),
      standingMicro: Number(r.standing_micro), description: r.description, iskState: r.isk_state,
      lpState: r.lp_state, stdState: r.std_state, attempts: Number(r.attempts),
      nextAttemptAt: Number(r.next_attempt_at) })) };
  }

  function markPayoutInTx(tx, m) {
    if (!m || !isText(m.payoutKey) || !m.payoutKey.startsWith(S.WAR_PAYOUT_KEY_PREFIX)
      || m.payoutKey.length <= S.WAR_PAYOUT_KEY_PREFIX.length) return invalid("payoutKey");
    for (const leg of ["iskState", "lpState", "stdState"]) if (!LEGS.includes(m[leg])) return invalid(leg);
    if (!Object.values(S.PAYOUT).includes(m.state)) return invalid("state");
    if (!isNonNegInt(m.attempts)) return invalid("attempts");
    if (!isTime(m.nextAttemptAt)) return invalid("nextAttemptAt");
    if (m.lastError !== null && typeof m.lastError !== "string") return invalid("lastError");
    if (!isTime(m.now)) return invalid("now");
    const offerId = m.payoutKey.slice(S.WAR_PAYOUT_KEY_PREFIX.length);
    const closed = m.state === S.PAYOUT.PAID || m.state === S.PAYOUT.FAILED;
    const lastError = m.lastError === null ? null : m.lastError.slice(0, MAX_ERROR);
    const r = tx.prepare(`UPDATE ${S.TABLE} SET isk_state = ?, lp_state = ?, std_state = ?, payout_state = ?,
      attempts = ?, next_attempt_at = ?, last_error = ?, ended_at = ?, updated_at = ?, version = version + 1
      WHERE offer_id = ? AND payout_state = 'PENDING'`).run(m.iskState, m.lpState, m.stdState, m.state, m.attempts,
      m.nextAttemptAt, lastError, closed ? m.now : null, m.now, offerId);
    return { ok: true, changed: Number(r.changes) === 1 };
  }

  function pruneInTx(tx, jobsBefore, payoutsBefore, limit) {
    if (!isTime(payoutsBefore)) return invalid("payoutsBefore");
    if (!isId(limit)) return invalid("limit");
    const r = tx.prepare(`DELETE FROM ${S.TABLE} WHERE offer_id IN (SELECT offer_id FROM ${S.TABLE}
      WHERE ended_at IS NOT NULL AND ended_at < ? AND (payout_state IS NULL OR payout_state <> 'PENDING')
      ORDER BY ended_at LIMIT ?)`).run(payoutsBefore, limit);
    return { ok: true, progress: 0, jobs: 0, payouts: Number(r.changes) };
  }

  function listEndedSinceInTx(tx, opts) {
    if (!opts || !isTime(opts.sinceMs)) return invalid("sinceMs");
    if (!isText(opts.reason)) return invalid("reason");
    if (!isId(opts.limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE ended_at IS NOT NULL AND ended_at >= ? AND end_reason = ?
      ORDER BY ended_at DESC, offer_id LIMIT ?`).all(opts.sinceMs, opts.reason, opts.limit).map(rowOf);
    return { ok: true, rows };
  }

  function listRecentEndedInTx(tx, limit) {
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE ended_at IS NOT NULL
      ORDER BY ended_at DESC, offer_id LIMIT ?`).all(limit).map(rowOf);
    return { ok: true, rows };
  }

  function sumsByFactionInTx(tx, sinceMs) {
    if (!isTime(sinceMs)) return invalid("sinceMs");
    const rows = tx.prepare(`SELECT faction_id, count(*) AS n, sum(lp_amount) AS lp, sum(standing_micro) AS std,
      sum(isk_amount) AS isk FROM ${S.TABLE} WHERE ended_at IS NOT NULL AND ended_at >= ? AND state = 'AWARDED'
      GROUP BY faction_id ORDER BY faction_id`).all(sinceMs);
    return { ok: true, rows: rows.map((r) => Object.freeze({ factionId: Number(r.faction_id), awarded: Number(r.n),
      lp: Number(r.lp), standingMicro: Number(r.std), isk: Number(r.isk) })) };
  }

  function payoutCountsInTx(tx, sinceMs) {
    if (!isTime(sinceMs)) return invalid("sinceMs");
    const pending = tx.prepare(`SELECT count(*) AS n FROM ${S.TABLE} WHERE payout_state = 'PENDING'`).get();
    const failed = tx.prepare(`SELECT count(*) AS n FROM ${S.TABLE} WHERE ended_at IS NOT NULL AND ended_at >= ?
      AND payout_state = 'FAILED'`).get(sinceMs);
    return { ok: true, pending: Number(pending.n), failed: Number(failed.n) };
  }

  return Object.freeze({ getInTx, insertOpenInTx, listOpenInTx, countOpenInTx, countAwardsSinceInTx, settleInTx,
    listDuePayoutsInTx, markPayoutInTx, pruneInTx, listEndedSinceInTx, listRecentEndedInTx, sumsByFactionInTx,
    payoutCountsInTx, listAwardsOfCharacterInTx });
}

module.exports = { createWarContractRepository };
