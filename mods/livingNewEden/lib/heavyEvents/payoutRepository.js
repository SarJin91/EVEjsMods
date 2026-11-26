"use strict";

const S = require("./payoutSchema");
const { FACTION_CATALOG } = require("../strategy/data/factionCatalog");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isTime = (v) => Number.isSafeInteger(v);
const isText = (v) => typeof v === "string" && v !== "";
const num = (v) => (v === null || v === undefined ? null : Number(v));

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

const LP_CORP_BY_FACTION = new Map(FACTION_CATALOG.filter((f) => isId(f.factionId) && isId(f.corporationId))
  .map((f) => [f.factionId, f.corporationId]));

const lpCorporationOf = (factionId) => LP_CORP_BY_FACTION.get(factionId) || null;

function participantsOf(seen, present, minPasses, max) {
  const passes = new Map();
  for (const [id, n] of (seen instanceof Map ? seen : new Map())) {
    if (isId(id) && Number.isSafeInteger(n) && n >= minPasses) passes.set(id, n);
  }
  for (const id of (Array.isArray(present) ? present : [])) {
    if (isId(id) && !passes.has(id)) passes.set(id, (seen instanceof Map && seen.get(id)) || 0);
  }
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 0;
  return [...passes].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([id]) => id);
}

function payoutOf(r) {
  return Object.freeze({ payoutKey: r.payout_key, eventId: r.event_id, characterId: Number(r.character_id),
    issuerFactionId: Number(r.issuer_faction_id), systemId: Number(r.system_id),
    lpCorporationId: num(r.lp_corporation_id), iskAmount: Number(r.isk_amount), lpAmount: Number(r.lp_amount),
    standingMicro: Number(r.standing_micro), description: r.description, iskState: r.isk_state, lpState: r.lp_state,
    stdState: r.std_state, state: r.state, attempts: Number(r.attempts), nextAttemptAt: Number(r.next_attempt_at),
    lastError: r.last_error, plannedAt: Number(r.planned_at), updatedAt: Number(r.updated_at) });
}

function createHeavyEventPayoutRepository() {
  function planPayoutsInTx(tx, p) {
    if (!p || !isText(p.eventId)) return invalid("eventId");
    if (!isId(p.issuerFactionId)) return invalid("issuerFactionId");
    if (!isId(p.systemId)) return invalid("systemId");
    if (!Array.isArray(p.characterIds) || !p.characterIds.every(isId)) return invalid("characterIds");
    for (const k of ["iskAmount", "lpAmount", "standingMicro"]) if (!isNonNegInt(p[k])) return invalid(k);
    if (!isTime(p.at)) return invalid("at");
    if (p.description !== undefined && !(typeof p.description === "string"
      && /^[\x20-\x7e]{1,120}$/.test(p.description))) return invalid("description");
    const description = p.description === undefined ? S.DESCRIPTION : p.description;
    const L = S.LEG_STATE;
    const lpCorporationId = lpCorporationOf(p.issuerFactionId);
    const isk = p.iskAmount > 0 ? L.PENDING : L.SKIPPED;
    const lp = p.lpAmount > 0 && lpCorporationId !== null ? L.PENDING : L.SKIPPED;
    const std = p.standingMicro > 0 ? L.PENDING : L.SKIPPED;
    const state = [isk, lp, std].every((s) => s === L.SKIPPED) ? S.ROW_STATE.PAID : S.ROW_STATE.PENDING;
    const stmt = tx.prepare(`INSERT INTO ${S.PAYOUTS_TABLE} (payout_key, event_id, character_id, issuer_faction_id,
      system_id, lp_corporation_id, isk_amount, lp_amount, standing_micro, description, isk_state, lp_state, std_state,
      state, attempts, next_attempt_at, last_error, planned_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?) ON CONFLICT(payout_key) DO NOTHING`);
    let planned = 0;
    for (const characterId of p.characterIds) {
      const r = stmt.run(S.payoutKeyOf(p.eventId, characterId), p.eventId, characterId, p.issuerFactionId, p.systemId,
        lpCorporationId, p.iskAmount, p.lpAmount, p.standingMicro, description, isk, lp, std, state, p.at, p.at,
        p.at);
      planned += Number(r.changes);
    }
    return { ok: true, planned, lpCorporationId };
  }

  function listDuePayoutsInTx(tx, now, limit) {
    if (!isTime(now)) return invalid("now");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.PAYOUTS_TABLE} WHERE state = 'PENDING' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, payout_key LIMIT ?`).all(now, limit);
    return { ok: true, rows: rows.map(payoutOf) };
  }

  function listPayoutsOfEventInTx(tx, eventId) {
    if (!isText(eventId)) return invalid("eventId");
    const rows = tx.prepare(`SELECT * FROM ${S.PAYOUTS_TABLE} WHERE event_id = ? ORDER BY payout_key`).all(eventId);
    return { ok: true, rows: rows.map(payoutOf) };
  }

  function listCharacterIdsOfEventInTx(tx, eventId, limit) {
    if (!isText(eventId)) return invalid("eventId");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT character_id FROM ${S.PAYOUTS_TABLE} WHERE event_id = ?
      ORDER BY character_id LIMIT ?`).all(eventId, limit);
    return { ok: true, characterIds: rows.map((r) => Number(r.character_id)) };
  }

  function listCharacterIdsByKeyPrefixInTx(tx, prefix, limit) {
    if (!isText(prefix) || !prefix.endsWith(":")) return invalid("prefix");
    if (!isId(limit)) return invalid("limit");
    const to = `${prefix.slice(0, -1)};`;
    const rows = tx.prepare(`SELECT DISTINCT character_id FROM ${S.PAYOUTS_TABLE}
      WHERE payout_key >= ? AND payout_key < ? ORDER BY character_id LIMIT ?`).all(prefix, to, limit);
    return { ok: true, characterIds: rows.map((r) => Number(r.character_id)) };
  }

  function markPayoutInTx(tx, m) {
    if (!m || !isText(m.payoutKey)) return invalid("payoutKey");
    const legs = Object.values(S.LEG_STATE);
    for (const leg of ["iskState", "lpState", "stdState"]) if (!legs.includes(m[leg])) return invalid(leg);
    if (!Object.values(S.ROW_STATE).includes(m.state)) return invalid("state");
    if (!isNonNegInt(m.attempts)) return invalid("attempts");
    if (!isTime(m.nextAttemptAt)) return invalid("nextAttemptAt");
    if (m.lastError !== null && typeof m.lastError !== "string") return invalid("lastError");
    if (!isTime(m.now)) return invalid("now");
    const r = tx.prepare(`UPDATE ${S.PAYOUTS_TABLE} SET isk_state = ?, lp_state = ?, std_state = ?, state = ?,
      attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE payout_key = ? AND state = 'PENDING'`).run(m.iskState, m.lpState, m.stdState, m.state, m.attempts,
      m.nextAttemptAt, m.lastError, m.now, m.payoutKey);
    return { ok: true, changed: Number(r.changes) === 1 };
  }

  function prunePayoutsInTx(tx, before, limit) {
    if (!isTime(before)) return invalid("before");
    if (!isId(limit)) return invalid("limit");
    const r = tx.prepare(`DELETE FROM ${S.PAYOUTS_TABLE} WHERE payout_key IN (
      SELECT payout_key FROM ${S.PAYOUTS_TABLE} WHERE state <> 'PENDING' AND updated_at < ?
      ORDER BY updated_at LIMIT ?)`).run(before, limit);
    return { ok: true, payouts: Number(r.changes) };
  }

  return Object.freeze({ planPayoutsInTx, listDuePayoutsInTx, listPayoutsOfEventInTx, listCharacterIdsOfEventInTx,
    listCharacterIdsByKeyPrefixInTx, markPayoutInTx, prunePayoutsInTx });
}

module.exports = { createHeavyEventPayoutRepository, participantsOf, lpCorporationOf };
