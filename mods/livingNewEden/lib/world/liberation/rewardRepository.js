"use strict";

const S = require("./rewardSchema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isTime = (v) => Number.isSafeInteger(v);

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

function createRewardRepository() {
  function recordContributionInTx(tx, o) {
    const { systemId, controllerFactionId, characterId, at, windowStart, maxPerSystem } = o || {};
    if (!isId(systemId)) return invalid("systemId");
    if (!isId(controllerFactionId)) return invalid("controllerFactionId");
    if (!isId(characterId)) return invalid("characterId");
    if (!isTime(at)) return invalid("at");
    if (!isTime(windowStart)) return invalid("windowStart");
    if (!isId(maxPerSystem)) return invalid("maxPerSystem");
    const row = tx.prepare(`SELECT kills, last_at FROM ${S.CONTRIBUTIONS_TABLE}
      WHERE system_id = ? AND controller_faction_id = ? AND character_id = ?`)
      .get(systemId, controllerFactionId, characterId);
    if (row && row.last_at >= windowStart) {
      tx.prepare(`UPDATE ${S.CONTRIBUTIONS_TABLE} SET kills = kills + 1, last_at = max(last_at, ?)
        WHERE system_id = ? AND controller_faction_id = ? AND character_id = ?`)
        .run(at, systemId, controllerFactionId, characterId);
      return { ok: true, outcome: "UPDATED" };
    }
    const live = tx.prepare(`SELECT count(*) AS n FROM ${S.CONTRIBUTIONS_TABLE}
      WHERE system_id = ? AND last_at >= ?`).get(systemId, windowStart);
    if (live.n >= maxPerSystem) return { ok: true, outcome: "CAPPED" };
    if (row) {
      tx.prepare(`UPDATE ${S.CONTRIBUTIONS_TABLE} SET kills = 1, first_at = ?, last_at = ?
        WHERE system_id = ? AND controller_faction_id = ? AND character_id = ?`)
        .run(at, at, systemId, controllerFactionId, characterId);
      return { ok: true, outcome: "UPDATED" };
    }
    tx.prepare(`INSERT INTO ${S.CONTRIBUTIONS_TABLE} (system_id, controller_faction_id, character_id, kills, first_at,
      last_at) VALUES (?, ?, ?, 1, ?, ?)`).run(systemId, controllerFactionId, characterId, at, at);
    return { ok: true, outcome: "INSERTED" };
  }

  function windowArgs(o) {
    const { systemId, controllerFactionId, windowStart, limit } = o || {};
    if (!isId(systemId)) return invalid("systemId");
    if (!isId(controllerFactionId)) return invalid("controllerFactionId");
    if (!isTime(windowStart)) return invalid("windowStart");
    if (!isId(limit)) return invalid("limit");
    return { ok: true, systemId, controllerFactionId, windowStart, limit };
  }

  function listContributionsInTx(tx, o) {
    const a = windowArgs(o);
    if (!a.ok) return a;
    const rows = tx.prepare(`SELECT character_id, kills FROM ${S.CONTRIBUTIONS_TABLE}
      WHERE system_id = ? AND controller_faction_id = ? AND last_at >= ?
      ORDER BY kills DESC, character_id ASC LIMIT ?`).all(a.systemId, a.controllerFactionId, a.windowStart, a.limit);
    return { ok: true, rows: rows.map((r) => ({ characterId: r.character_id, kills: r.kills })) };
  }

  function clearContributionsInTx(tx, o) {
    const a = windowArgs(o);
    if (!a.ok) return a;
    const r = tx.prepare(`DELETE FROM ${S.CONTRIBUTIONS_TABLE}
      WHERE system_id = ? AND controller_faction_id = ? AND character_id IN (
        SELECT character_id FROM ${S.CONTRIBUTIONS_TABLE}
        WHERE system_id = ? AND controller_faction_id = ? AND last_at >= ? ORDER BY character_id LIMIT ?)`)
      .run(a.systemId, a.controllerFactionId, a.systemId, a.controllerFactionId, a.windowStart, a.limit);
    return { ok: true, deleted: Number(r.changes) };
  }

  function lastPayoutAtInTx(tx, systemId) {
    if (!isId(systemId)) return invalid("systemId");
    const row = tx.prepare(`SELECT max(planned_at) AS m FROM ${S.PAYOUTS_TABLE} WHERE system_id = ?`).get(systemId);
    return { ok: true, lastPlannedAt: row && row.m !== null && row.m !== undefined ? Number(row.m) : null };
  }

  function validPayout(r, i) {
    if (!r || typeof r !== "object") return `rows[${i}]`;
    if (typeof r.payoutKey !== "string" || r.payoutKey === "") return `rows[${i}].payoutKey`;
    if (typeof r.liberationKey !== "string" || r.liberationKey === "") return `rows[${i}].liberationKey`;
    if (!isId(r.systemId)) return `rows[${i}].systemId`;
    if (!isId(r.characterId)) return `rows[${i}].characterId`;
    if (!isId(r.controllerFactionId)) return `rows[${i}].controllerFactionId`;
    if (r.beneficiaryFactionId !== null && !isId(r.beneficiaryFactionId)) return `rows[${i}].beneficiaryFactionId`;
    if (r.lpCorporationId !== null && !isId(r.lpCorporationId)) return `rows[${i}].lpCorporationId`;
    if (!isId(r.kills)) return `rows[${i}].kills`;
    if (!isNonNegInt(r.iskAmount)) return `rows[${i}].iskAmount`;
    if (!isNonNegInt(r.lpAmount)) return `rows[${i}].lpAmount`;
    if (typeof r.description !== "string" || r.description === "" || r.description.length > S.MAX_DESCRIPTION) {
      return `rows[${i}].description`;
    }
    return null;
  }

  function insertPayoutsInTx(tx, rows, now) {
    if (!Array.isArray(rows)) return invalid("rows");
    if (!isNonNegInt(now)) return invalid("now");
    for (let i = 0; i < rows.length; i += 1) {
      const bad = validPayout(rows[i], i);
      if (bad) return invalid(bad);
    }
    const find = tx.prepare(`SELECT 1 AS x FROM ${S.PAYOUTS_TABLE} WHERE payout_key = ?`);
    const insert = tx.prepare(`INSERT INTO ${S.PAYOUTS_TABLE} (payout_key, liberation_key, system_id, character_id,
      controller_faction_id, beneficiary_faction_id, lp_corporation_id, kills, isk_amount, lp_amount, description,
      isk_state, lp_state, state, attempts, next_attempt_at, last_error, planned_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`);
    let inserted = 0;
    for (const r of rows) {
      if (find.get(r.payoutKey)) return { ok: false, reason: "PAYOUT_KEY_EXISTS", detail: r.payoutKey };
      const iskState = r.iskAmount > 0 ? S.LEG_STATE.PENDING : S.LEG_STATE.SKIPPED;
      const lpState = r.lpAmount > 0 && r.lpCorporationId !== null ? S.LEG_STATE.PENDING : S.LEG_STATE.SKIPPED;
      insert.run(r.payoutKey, r.liberationKey, r.systemId, r.characterId, r.controllerFactionId,
        r.beneficiaryFactionId, r.lpCorporationId, r.kills, r.iskAmount, r.lpAmount, r.description, iskState, lpState,
        S.ROW_STATE.PENDING, now, now, now);
      inserted += 1;
    }
    return { ok: true, inserted };
  }

  function payoutOf(r) {
    return { payoutKey: r.payout_key, systemId: Number(r.system_id), characterId: Number(r.character_id),
      lpCorporationId: r.lp_corporation_id === null || r.lp_corporation_id === undefined ? null
        : Number(r.lp_corporation_id),
      iskAmount: Number(r.isk_amount), lpAmount: Number(r.lp_amount), description: r.description,
      iskState: r.isk_state, lpState: r.lp_state, state: r.state, attempts: Number(r.attempts),
      nextAttemptAt: Number(r.next_attempt_at) };
  }

  function listDuePayoutsInTx(tx, now, limit) {
    if (!isTime(now)) return invalid("now");
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT payout_key, system_id, character_id, lp_corporation_id, isk_amount, lp_amount,
      description, isk_state, lp_state, state, attempts, next_attempt_at FROM ${S.PAYOUTS_TABLE}
      WHERE state = 'PENDING' AND next_attempt_at <= ? ORDER BY next_attempt_at, payout_key LIMIT ?`).all(now, limit);
    return { ok: true, rows: rows.map(payoutOf) };
  }

  const LEG_STATES = new Set(Object.values(S.LEG_STATE));
  const ROW_STATES = new Set(Object.values(S.ROW_STATE));

  function markPayoutInTx(tx, m) {
    const { payoutKey, iskState, lpState, state, attempts, nextAttemptAt, lastError, now } = m || {};
    if (typeof payoutKey !== "string" || payoutKey === "") return invalid("payoutKey");
    if (!LEG_STATES.has(iskState)) return invalid("iskState");
    if (!LEG_STATES.has(lpState)) return invalid("lpState");
    if (!ROW_STATES.has(state)) return invalid("state");
    if (!isNonNegInt(attempts)) return invalid("attempts");
    if (!isTime(nextAttemptAt)) return invalid("nextAttemptAt");
    if (lastError !== null && typeof lastError !== "string") return invalid("lastError");
    if (!isTime(now)) return invalid("now");
    const r = tx.prepare(`UPDATE ${S.PAYOUTS_TABLE} SET isk_state = ?, lp_state = ?, state = ?, attempts = ?,
      next_attempt_at = ?, last_error = ?, updated_at = ? WHERE payout_key = ? AND state = 'PENDING'`)
      .run(iskState, lpState, state, attempts, nextAttemptAt, lastError === null ? null
        : lastError.slice(0, S.MAX_DESCRIPTION), now, payoutKey);
    return { ok: true, changed: Number(r.changes) === 1 };
  }

  function prunePayoutsInTx(tx, olderThan, limit) {
    if (!isTime(olderThan)) return invalid("olderThan");
    if (!isId(limit)) return invalid("limit");
    const r = tx.prepare(`DELETE FROM ${S.PAYOUTS_TABLE} WHERE payout_key IN (
      SELECT payout_key FROM ${S.PAYOUTS_TABLE} WHERE state <> 'PENDING' AND updated_at < ?
      ORDER BY updated_at LIMIT ?)`).run(olderThan, limit);
    return { ok: true, deleted: Number(r.changes) };
  }

  function pruneContributionsInTx(tx, olderThan, limit) {
    if (!isTime(olderThan)) return invalid("olderThan");
    if (!isId(limit)) return invalid("limit");
    const r = tx.prepare(`DELETE FROM ${S.CONTRIBUTIONS_TABLE}
      WHERE (system_id, controller_faction_id, character_id) IN (
        SELECT system_id, controller_faction_id, character_id FROM ${S.CONTRIBUTIONS_TABLE}
        WHERE last_at < ? ORDER BY last_at LIMIT ?)`).run(olderThan, limit);
    return { ok: true, deleted: Number(r.changes) };
  }

  return Object.freeze({ recordContributionInTx, listContributionsInTx, clearContributionsInTx, lastPayoutAtInTx,
    insertPayoutsInTx, listDuePayoutsInTx, markPayoutInTx, prunePayoutsInTx, pruneContributionsInTx });
}

module.exports = { createRewardRepository };
