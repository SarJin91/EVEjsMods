"use strict";

const { TABLE, SCORES_TABLE, REWARDS_TABLE, STATE, LEG, REWARD_STATE, keyOfReward } = require("./schema");

const COLUMNS = `season_no, state, open, crisis_kind, crisis_owner, crisis_version, crisis_json, seed, starts_at,
  ends_at, stage, stage_count, stage_due_at, meter_defense, meter_crisis, outcome, close_reason, closed_at, reset_at,
  journal_cursor, payout_cursor_at, payout_cursor_key, planned_retries, created_at, updated_at, version`;
const REWARD_COLUMNS = `reward_key, season_no, character_id, rank, points, tier, outcome, isk_amount, item_type_id,
  item_qty, station_id, isk_state, item_state, mail_state, state, attempts, next_attempt_at, last_error,
  mail_sender_id, mail_sent_date, mail_message_id, planned_at, updated_at, version`;
const HEAVY_PAYOUTS_TABLE = "world_heavy_event_payouts";
const REWARD_PATCH_COLUMNS = Object.freeze({ stationId: "station_id", iskState: "isk_state", itemState: "item_state",
  mailState: "mail_state", state: "state", attempts: "attempts", nextAttemptAt: "next_attempt_at",
  lastError: "last_error", mailSenderId: "mail_sender_id", mailSentDate: "mail_sent_date",
  mailMessageId: "mail_message_id" });

const PATCH_COLUMNS = Object.freeze({ state: "state", crisisKind: "crisis_kind", crisisOwner: "crisis_owner",
  crisisVersion: "crisis_version", crisis: "crisis_json", startsAt: "starts_at", endsAt: "ends_at", stage: "stage",
  stageDueAt: "stage_due_at", meterDefense: "meter_defense", meterCrisis: "meter_crisis", outcome: "outcome",
  closeReason: "close_reason", closedAt: "closed_at", journalCursor: "journal_cursor",
  payoutCursorAt: "payout_cursor_at", payoutCursorKey: "payout_cursor_key", plannedRetries: "planned_retries" });

const messageOf = (err) => String((err && err.message) || err).slice(0, 160);
const num = (v) => (v === null || v === undefined ? null : Number(v));

function parseCrisis(text) {
  try {
    const c = JSON.parse(text);
    return { factionId: Number.isSafeInteger(c.factionId) ? c.factionId : null,
      regionIds: Array.isArray(c.regionIds) ? c.regionIds.filter((r) => Number.isSafeInteger(r)) : [],
      params: c.params && typeof c.params === "object" ? c.params : {} };
  } catch (_err) {
    return { factionId: null, regionIds: [], params: {} };
  }
}

function rowOf(r) {
  if (!r) return null;
  return Object.freeze({ seasonNo: num(r.season_no), state: r.state, open: num(r.open) === 1,
    crisisKind: r.crisis_kind, crisisOwner: r.crisis_owner, crisisVersion: num(r.crisis_version),
    crisis: Object.freeze(parseCrisis(r.crisis_json)), seed: num(r.seed), startsAt: num(r.starts_at),
    endsAt: num(r.ends_at), stage: num(r.stage), stageCount: num(r.stage_count), stageDueAt: num(r.stage_due_at),
    meterDefense: num(r.meter_defense), meterCrisis: num(r.meter_crisis), outcome: r.outcome || null,
    closeReason: r.close_reason || null, closedAt: num(r.closed_at), resetAt: num(r.reset_at),
    journalCursor: num(r.journal_cursor), payoutCursorAt: num(r.payout_cursor_at),
    payoutCursorKey: String(r.payout_cursor_key || ""), plannedRetries: num(r.planned_retries),
    createdAt: num(r.created_at), updatedAt: num(r.updated_at), version: num(r.version) });
}

function rewardOf(r) {
  if (!r) return null;
  return Object.freeze({ rewardKey: r.reward_key, seasonNo: num(r.season_no), characterId: num(r.character_id),
    rank: num(r.rank), points: num(r.points), tier: r.tier, outcome: r.outcome, iskAmount: num(r.isk_amount),
    itemTypeId: num(r.item_type_id), itemQty: num(r.item_qty), stationId: num(r.station_id), iskState: r.isk_state,
    itemState: r.item_state, mailState: r.mail_state, state: r.state, attempts: num(r.attempts),
    nextAttemptAt: num(r.next_attempt_at), lastError: r.last_error || null, mailSenderId: num(r.mail_sender_id),
    mailSentDate: r.mail_sent_date === null || r.mail_sent_date === undefined ? null : String(r.mail_sent_date),
    mailMessageId: num(r.mail_message_id), plannedAt: num(r.planned_at), updatedAt: num(r.updated_at),
    version: num(r.version) });
}

function crisisJsonOf(crisis) {
  return JSON.stringify({ factionId: crisis.factionId === undefined ? null : crisis.factionId,
    regionIds: crisis.regionIds || [], params: crisis.params || {} });
}

function createSeasonRepository() {
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      open: db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE open = 1`),
      byNo: db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE season_no = ?`),
      last: db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} ORDER BY season_no DESC LIMIT 1`),
      lastArchived: db.prepare(`SELECT max(season_no) AS n FROM ${TABLE} WHERE state = '${STATE.ARCHIVED}'`),
      insert: db.prepare(`INSERT INTO ${TABLE} (season_no, state, open, crisis_kind, crisis_owner, crisis_version,
        crisis_json, seed, starts_at, ends_at, stage, stage_count, stage_due_at, meter_defense, meter_crisis,
        journal_cursor, planned_retries, created_at, updated_at, version)
        VALUES (?, '${STATE.PLANNED}', 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, 0, ?, ?, 1)`),
      scoreUpdate: db.prepare(`UPDATE ${SCORES_TABLE} SET points = min(${Number.MAX_SAFE_INTEGER}, points + ?),
        kills = kills + ?, defenses = defenses + ?, last_at = max(last_at, ?), version = version + 1
        WHERE season_no = ? AND character_id = ?`),
      scoreInsert: db.prepare(`INSERT INTO ${SCORES_TABLE} (season_no, character_id, points, kills, defenses, last_at,
        version) VALUES (?, ?, ?, ?, ?, ?, 1)`),
      scoreCount: db.prepare(`SELECT count(*) AS n FROM ${SCORES_TABLE} WHERE season_no = ?`),
      scoreOne: db.prepare(`SELECT points, kills, defenses, last_at FROM ${SCORES_TABLE}
        WHERE season_no = ? AND character_id = ?`),
      scoreAhead: db.prepare(`SELECT count(*) AS n FROM ${SCORES_TABLE} WHERE season_no = ? AND (points > ?
        OR (points = ? AND (last_at < ? OR (last_at = ? AND character_id < ?))))`),
      ranked: db.prepare(`SELECT character_id, points, last_at FROM ${SCORES_TABLE} WHERE season_no = ?
        ORDER BY points DESC, last_at, character_id LIMIT ?`),
      pruneScores: db.prepare(`DELETE FROM ${SCORES_TABLE} WHERE (season_no, character_id) IN (
        SELECT s.season_no, s.character_id FROM ${SCORES_TABLE} s JOIN ${TABLE} w ON w.season_no = s.season_no
        WHERE w.state = '${STATE.ARCHIVED}' AND w.closed_at < ? LIMIT ?)`),
      heavyAfter: db.prepare(`SELECT payout_key, character_id, system_id, planned_at FROM ${HEAVY_PAYOUTS_TABLE}
        WHERE (planned_at, payout_key) > (?, ?) AND planned_at < ? ORDER BY planned_at, payout_key LIMIT ?`),
      rewardInsert: db.prepare(`INSERT INTO ${REWARDS_TABLE} (reward_key, season_no, character_id, rank, points, tier,
        outcome, isk_amount, item_type_id, item_qty, station_id, isk_state, item_state, mail_state, state, attempts,
        next_attempt_at, last_error, mail_sender_id, mail_sent_date, mail_message_id, planned_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, ?, 1)
        ON CONFLICT (reward_key) DO NOTHING`),
      rewardByKey: db.prepare(`SELECT ${REWARD_COLUMNS} FROM ${REWARDS_TABLE} WHERE reward_key = ?`),
      rewardPending: db.prepare(`SELECT count(*) AS n FROM ${REWARDS_TABLE} WHERE state = '${REWARD_STATE.PENDING}'`),
      rewardDue: db.prepare(`SELECT ${REWARD_COLUMNS} FROM ${REWARDS_TABLE}
        WHERE state = '${REWARD_STATE.PENDING}' AND next_attempt_at <= ? ORDER BY next_attempt_at, reward_key LIMIT ?`),
      rewardNextDue: db.prepare(`SELECT min(next_attempt_at) AS t, count(*) AS n FROM ${REWARDS_TABLE}
        WHERE state = '${REWARD_STATE.PENDING}' AND next_attempt_at > ?`),
      titles: db.prepare(`SELECT season_no, tier FROM ${REWARDS_TABLE} WHERE character_id = ?
        ORDER BY season_no DESC LIMIT ?`),
      top: db.prepare(`SELECT character_id, points, kills, defenses FROM ${SCORES_TABLE} WHERE season_no = ?
        ORDER BY points DESC, last_at, character_id LIMIT ?`),
      history: db.prepare(`SELECT season_no, outcome, closed_at FROM ${TABLE} WHERE state = '${STATE.ARCHIVED}'
        ORDER BY season_no DESC LIMIT ?`),
      champion: db.prepare(`SELECT character_id FROM ${REWARDS_TABLE} WHERE reward_key > ? AND reward_key < ?
        AND rank = 1 LIMIT 1`),
      rewardFailed: db.prepare(`SELECT count(*) AS n FROM ${REWARDS_TABLE} WHERE state = '${REWARD_STATE.FAILED}'`),
    };
    perDb.set(db, s);
    return s;
  }

  function getOpenInTx(tx) {
    try {
      return { ok: true, row: rowOf(stmts(tx).open.get()) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function getInTx(tx, seasonNo) {
    try {
      return { ok: true, row: rowOf(stmts(tx).byNo.get(seasonNo)) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function getLastInTx(tx) {
    try {
      return { ok: true, row: rowOf(stmts(tx).last.get()) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function getLastArchivedNoInTx(tx) {
    try {
      const r = stmts(tx).lastArchived.get();
      return { ok: true, seasonNo: r && r.n !== null ? Number(r.n) : null };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function insertPlannedInTx(tx, spec) {
    try {
      const s = stmts(tx);
      if (s.byNo.get(spec.seasonNo)) return { ok: false, reason: "DUPLICATE" };
      if (s.open.get()) return { ok: false, reason: "OPEN_EXISTS" };
      s.insert.run(spec.seasonNo, spec.crisisKind, spec.crisisOwner, spec.crisisVersion, crisisJsonOf(spec.crisis),
        spec.seed, spec.startsAt, spec.endsAt, spec.stageCount, spec.stageDueAt, spec.now, spec.now);
      return { ok: true, row: rowOf(s.byNo.get(spec.seasonNo)) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function updateInTx(tx, seasonNo, expectVersion, patch) {
    try {
      if (!patch || !Number.isSafeInteger(patch.now)) return { ok: false, reason: "BAD_PATCH", detail: "now" };
      const sets = [];
      const args = [];
      for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        sets.push(`${column} = ?`);
        args.push(key === "crisis" ? crisisJsonOf(patch.crisis) : patch[key]);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "state")) {
        sets.push("open = ?");
        args.push(patch.state === STATE.ARCHIVED ? 0 : 1);
      }
      sets.push("updated_at = ?", "version = version + 1");
      args.push(patch.now, seasonNo, expectVersion);
      const info = tx.prepare(`UPDATE ${TABLE} SET ${sets.join(", ")} WHERE season_no = ? AND version = ?`)
        .run(...args);
      if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
      return { ok: true, row: rowOf(stmts(tx).byNo.get(seasonNo)) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function countScoresInTx(tx, seasonNo) {
    try {
      return { ok: true, count: Number(stmts(tx).scoreCount.get(seasonNo).n) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function upsertScoresInTx(tx, seasonNo, items, maxRows) {
    try {
      const s = stmts(tx);
      let count = Number(s.scoreCount.get(seasonNo).n);
      let written = 0;
      let capped = 0;
      for (const it of items) {
        const up = s.scoreUpdate.run(it.points, it.kills, it.defenses, it.lastAt, seasonNo, it.characterId);
        if (up.changes === 1) {
          written += 1;
          continue;
        }
        if (count >= maxRows) {
          capped += 1;
          continue;
        }
        s.scoreInsert.run(seasonNo, it.characterId, it.points, it.kills, it.defenses, it.lastAt);
        count += 1;
        written += 1;
      }
      return { ok: true, written, capped };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function listRankedInTx(tx, seasonNo, limit) {
    try {
      const rows = stmts(tx).ranked.all(seasonNo, limit).map((r) => ({ characterId: num(r.character_id),
        points: num(r.points), lastAt: num(r.last_at) }));
      return { ok: true, rows };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function pruneScoresInTx(tx, before, limit) {
    try {
      return { ok: true, deleted: stmts(tx).pruneScores.run(before, limit).changes };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function scoreOfInTx(tx, seasonNo, characterId, titlesLimit) {
    try {
      const s = stmts(tx);
      let points = 0;
      let rank = null;
      if (seasonNo !== null) {
        const r = s.scoreOne.get(seasonNo, characterId);
        if (r) {
          points = num(r.points);
          const l = num(r.last_at);
          rank = 1 + Number(s.scoreAhead.get(seasonNo, points, points, l, l, characterId).n);
        }
      }
      const titles = s.titles.all(characterId, titlesLimit).map((t) => ({ seasonNo: num(t.season_no), tier: t.tier }));
      return { ok: true, points, rank, titles };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function observerInTx(tx, seasonNo, topLimit, historyLimit) {
    try {
      const s = stmts(tx);
      const top = seasonNo === null ? [] : s.top.all(seasonNo, topLimit).map((r, i) => ({ rank: i + 1,
        characterId: num(r.character_id), points: num(r.points), kills: num(r.kills), defenses: num(r.defenses) }));
      const history = s.history.all(historyLimit).map((r) => {
        const no = num(r.season_no);
        const c = s.champion.get(`season:${no}:`, `season:${no};`);
        return { seasonNo: no, outcome: r.outcome || null, closedAt: num(r.closed_at),
          championId: c ? num(c.character_id) : null };
      });
      return { ok: true, top, history, rewards: { pending: Number(s.rewardPending.get().n),
        failed: Number(s.rewardFailed.get().n) } };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function listHeavyPayoutsAfterInTx(tx, afterAt, afterKey, endsAt, limit) {
    try {
      const rows = stmts(tx).heavyAfter.all(afterAt, afterKey, endsAt, limit).map((r) => ({
        payoutKey: String(r.payout_key), characterId: num(r.character_id), systemId: num(r.system_id),
        plannedAt: num(r.planned_at) }));
      return { ok: true, rows };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function insertRewardsInTx(tx, rewards, meta) {
    try {
      const s = stmts(tx);
      let inserted = 0;
      let pending = 0;
      for (const r of rewards) {
        const isk = r.iskAmount > 0 ? LEG.PENDING : LEG.SKIPPED;
        const item = r.itemTypeId > 0 ? LEG.PENDING : LEG.SKIPPED;
        const mail = meta.mailEnabled === true ? LEG.PENDING : LEG.SKIPPED;
        const open = [isk, item, mail].includes(LEG.PENDING);
        const state = open ? REWARD_STATE.PENDING : REWARD_STATE.DONE;
        const info = s.rewardInsert.run(keyOfReward(meta.seasonNo, r.characterId), meta.seasonNo, r.characterId,
          r.rank, r.points, r.tier, meta.outcome, r.iskAmount, r.itemTypeId, r.itemQty, isk, item, mail, state,
          meta.now, meta.now, meta.now);
        if (info.changes === 1) {
          inserted += 1;
          if (open) pending += 1;
        }
      }
      return { ok: true, inserted, pending };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function countPendingRewardsInTx(tx) {
    try {
      return { ok: true, pending: Number(stmts(tx).rewardPending.get().n) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function listDueRewardsInTx(tx, limit, now) {
    try {
      const s = stmts(tx);
      const rewards = s.rewardDue.all(now, limit).map(rewardOf);
      const rest = s.rewardNextDue.get(now);
      return { ok: true, rewards, nextDueAt: rest && rest.t !== null ? Number(rest.t) : null,
        waiting: rest ? Number(rest.n) : 0 };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function getRewardInTx(tx, rewardKey) {
    try {
      return { ok: true, reward: rewardOf(stmts(tx).rewardByKey.get(rewardKey)) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function updateRewardInTx(tx, rewardKey, expectVersion, patch) {
    try {
      if (!patch || !Number.isSafeInteger(patch.now)) return { ok: false, reason: "BAD_PATCH", detail: "now" };
      const sets = [];
      const args = [];
      for (const [key, column] of Object.entries(REWARD_PATCH_COLUMNS)) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        sets.push(`${column} = ?`);
        args.push(patch[key]);
      }
      sets.push("updated_at = ?", "version = version + 1");
      args.push(patch.now, rewardKey, expectVersion);
      const info = tx.prepare(`UPDATE ${REWARDS_TABLE} SET ${sets.join(", ")} WHERE reward_key = ? AND version = ?`)
        .run(...args);
      if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
      return { ok: true, reward: rewardOf(stmts(tx).rewardByKey.get(rewardKey)) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({ getOpenInTx, getInTx, getLastInTx, getLastArchivedNoInTx, insertPlannedInTx, updateInTx,
    countScoresInTx, upsertScoresInTx, listRankedInTx, pruneScoresInTx, scoreOfInTx, listHeavyPayoutsAfterInTx,
    insertRewardsInTx, countPendingRewardsInTx, listDueRewardsInTx, getRewardInTx, updateRewardInTx, observerInTx });
}

module.exports = { createSeasonRepository };
