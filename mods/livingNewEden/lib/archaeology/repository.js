"use strict";

const S = require("./schema");
const { isRewardList, rewardOfJson } = require("./reward");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const LORE_PENDING = "pending";
const MAX_FRAGMENT_TEXT = 400;

function placeholders(n) {
  return new Array(n).fill("?").join(",");
}

function parseRegions(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter(isId) : [];
  } catch (_err) {
    return [];
  }
}

function toChain(row) {
  return Object.freeze({
    chainId: row.chain_id,
    characterId: Number(row.character_id),
    seasonKey: row.season_key,
    chainNo: Number(row.chain_no),
    originInstanceId: Number(row.origin_instance_id),
    originOutcomeId: row.origin_outcome_id,
    originSystemId: Number(row.origin_system_id),
    theme: row.theme,
    seed: Number(row.seed),
    stageCount: Number(row.stage_count),
    stageNo: Number(row.stage_no),
    state: row.state,
    stageState: row.stage_state,
    stageKind: row.stage_kind,
    stageSystemId: Number(row.stage_system_id),
    stageEntrySystemId: numOrNull(row.stage_entry_system_id),
    stageRegionId: Number(row.stage_region_id),
    stageTemplateId: row.stage_template_id,
    stageFactionId: Number(row.stage_faction_id),
    stageSpawnNo: Number(row.stage_spawn_no),
    stageRelocations: Number(row.stage_relocations),
    stageDueAt: numOrNull(row.stage_due_at),
    visitedRegions: Object.freeze(parseRegions(row.visited_regions)),
    reward: rewardOfJson(row.reward_json === undefined ? null : row.reward_json),
    nextCheckAt: Number(row.next_check_at),
    deadlineAt: Number(row.deadline_at),
    endReason: row.end_reason === null ? null : row.end_reason,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    endedAt: numOrNull(row.ended_at),
  });
}

function getByOriginInTx(tx, instanceId, outcomeId) {
  const row = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE origin_instance_id = ? AND origin_outcome_id = ?`)
    .get(instanceId, String(outcomeId));
  return row ? toChain(row) : null;
}

function getByIdInTx(tx, chainId) {
  const row = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE chain_id = ?`).get(String(chainId));
  return row ? toChain(row) : null;
}

function getActiveByCharacterInTx(tx, characterId) {
  const row = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE character_id = ? AND state = 'ACTIVE'`).get(characterId);
  return row ? toChain(row) : null;
}

function hasActiveInTx(tx, characterId) {
  return getActiveByCharacterInTx(tx, characterId) !== null;
}

function seasonStatsInTx(tx, characterId, seasonKey, sinceAt) {
  const row = tx.prepare(`SELECT COALESCE(MAX(chain_no), 0) AS maxNo,
    COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS recent
    FROM ${S.TABLE} WHERE character_id = ? AND season_key = ?`).get(sinceAt, characterId, String(seasonKey));
  return { maxNo: Number(row.maxNo), recent: Number(row.recent) };
}

function lastEndedAtInTx(tx, characterId) {
  const row = tx.prepare(`SELECT MAX(ended_at) AS at FROM ${S.TABLE} WHERE character_id = ? AND ended_at IS NOT NULL`)
    .get(characterId);
  return row && row.at !== null && row.at !== undefined ? Number(row.at) : null;
}

function countActiveInTx(tx) {
  return Number(tx.prepare(`SELECT COUNT(*) AS n FROM ${S.TABLE} WHERE state = 'ACTIVE'`).get().n);
}

function insertChainInTx(tx, r) {
  if (!r || typeof r !== "object") return invalid("row");
  if (!isText(r.chainId, S.MAX_CHAIN_ID) || !r.chainId.startsWith(S.CHAIN_ID_PREFIX)) return invalid("chainId");
  if (!isId(r.characterId)) return invalid("characterId");
  if (!S.isSeasonKey(r.seasonKey)) return invalid("seasonKey");
  if (!isId(r.chainNo)) return invalid("chainNo");
  if (!isId(r.originInstanceId)) return invalid("originInstanceId");
  if (!isText(r.originOutcomeId, S.MAX_OUTCOME_ID)) return invalid("originOutcomeId");
  if (!isId(r.originSystemId)) return invalid("originSystemId");
  if (!Object.prototype.hasOwnProperty.call(S.THEME, r.theme)) return invalid("theme");
  if (!Number.isSafeInteger(r.seed) || r.seed < 0) return invalid("seed");
  if (!isId(r.stageCount) || r.stageCount > S.MAX_STAGE_COUNT) return invalid("stageCount");
  if (!Object.prototype.hasOwnProperty.call(S.STAGE_KIND, r.stageKind)) return invalid("stageKind");
  if (!isId(r.stageSystemId)) return invalid("stageSystemId");
  if (!isId(r.stageRegionId)) return invalid("stageRegionId");
  if (!isText(r.stageTemplateId, S.MAX_TEMPLATE_ID)) return invalid("stageTemplateId");
  if (!isId(r.stageFactionId)) return invalid("stageFactionId");
  if (!Array.isArray(r.visitedRegions) || !r.visitedRegions.every(isId)
    || r.visitedRegions.length > S.MAX_STAGE_COUNT + 1) return invalid("visitedRegions");
  if (!isTime(r.now)) return invalid("now");
  if (!isTime(r.deadlineAt) || r.deadlineAt <= r.now) return invalid("deadlineAt");
  if (!isTime(r.nextCheckAt)) return invalid("nextCheckAt");
  tx.prepare(`INSERT INTO ${S.TABLE} (chain_id, character_id, season_key, chain_no, origin_instance_id,
    origin_outcome_id, origin_system_id, theme, seed, stage_count, stage_no, state, stage_state, stage_kind,
    stage_system_id, stage_entry_system_id, stage_region_id, stage_template_id, stage_faction_id, visited_regions,
    next_check_at, deadline_at, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.chainId, r.characterId, r.seasonKey, r.chainNo, r.originInstanceId, r.originOutcomeId, r.originSystemId,
      r.theme, r.seed, r.stageCount, 1, S.CHAIN_STATE.ACTIVE, S.STAGE_STATE.REVEALED, r.stageKind, r.stageSystemId,
      null, r.stageRegionId, r.stageTemplateId, r.stageFactionId, JSON.stringify(r.visitedRegions), r.nextCheckAt,
      r.deadlineAt, 1, r.now, r.now);
  return { ok: true };
}

function listDueInTx(tx, now, limit) {
  if (!isTime(now)) return invalid("now");
  if (!isId(limit)) return invalid("limit");
  const rows = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE state = 'ACTIVE' AND next_check_at <= ?
    ORDER BY next_check_at, chain_id LIMIT ?`).all(now, limit);
  return { ok: true, chains: rows.map(toChain) };
}

function listActiveInTx(tx, limit) {
  if (!isId(limit)) return invalid("limit");
  const rows = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE state = 'ACTIVE' ORDER BY next_check_at, chain_id LIMIT ?`)
    .all(limit);
  return { ok: true, chains: rows.map(toChain) };
}

function endChainInTx(tx, chainId, version, o) {
  const p = o || {};
  if (!isText(chainId, S.MAX_CHAIN_ID)) return invalid("chainId");
  if (!isId(version)) return invalid("version");
  if (![S.CHAIN_STATE.COMPLETED, S.CHAIN_STATE.EXPIRED, S.CHAIN_STATE.STOLEN, S.CHAIN_STATE.CANCELLED]
    .includes(p.state)) return invalid("state");
  if (!Object.prototype.hasOwnProperty.call(S.END_REASON, p.endReason)) return invalid("endReason");
  if (!isTime(p.now)) return invalid("now");
  const r = tx.prepare(`UPDATE ${S.TABLE} SET state = ?, end_reason = ?, ended_at = ?, updated_at = ?,
    version = version + 1 WHERE chain_id = ? AND version = ? AND state = 'ACTIVE'`)
    .run(p.state, p.endReason, p.now, p.now, chainId, version);
  return { ok: true, changed: Number(r.changes) === 1 };
}

function rescheduleInTx(tx, chainId, version, nextCheckAt, now) {
  if (!isText(chainId, S.MAX_CHAIN_ID)) return invalid("chainId");
  if (!isId(version)) return invalid("version");
  if (!isTime(nextCheckAt)) return invalid("nextCheckAt");
  if (!isTime(now)) return invalid("now");
  const r = tx.prepare(`UPDATE ${S.TABLE} SET next_check_at = ?, updated_at = ?, version = version + 1
    WHERE chain_id = ? AND version = ? AND state = 'ACTIVE'`).run(nextCheckAt, now, chainId, version);
  return { ok: true, changed: Number(r.changes) === 1 };
}

const STAGE_COLUMNS = Object.freeze({
  stageNo: ["stage_no", (v) => isId(v) && v <= S.MAX_STAGE_COUNT],
  stageState: ["stage_state", (v) => Object.prototype.hasOwnProperty.call(S.STAGE_STATE, v)],
  stageKind: ["stage_kind", (v) => Object.prototype.hasOwnProperty.call(S.STAGE_KIND, v)],
  stageSystemId: ["stage_system_id", isId],
  stageRegionId: ["stage_region_id", isId],
  stageTemplateId: ["stage_template_id", (v) => isText(v, S.MAX_TEMPLATE_ID)],
  stageFactionId: ["stage_faction_id", isId],
  stageSpawnNo: ["stage_spawn_no", isTime],
  stageRelocations: ["stage_relocations", isTime],
  stageDueAt: ["stage_due_at", (v) => v === null || isTime(v)],
  visitedRegions: ["visited_regions", (v) => Array.isArray(v) && v.every(isId) && v.length <= S.MAX_STAGE_COUNT + 1],
  nextCheckAt: ["next_check_at", isTime],
  stageEntrySystemId: ["stage_entry_system_id", (v) => v === null || isId(v)],
  reward: ["reward_json", (v) => isRewardList(v) && JSON.stringify(v).length <= S.MAX_REWARD_JSON],
});
const JSON_COLUMNS = Object.freeze(["visitedRegions", "reward"]);

function updateStageInTx(tx, chainId, version, patch, now) {
  if (!isText(chainId, S.MAX_CHAIN_ID)) return invalid("chainId");
  if (!isId(version)) return invalid("version");
  if (!isTime(now)) return invalid("now");
  if (!patch || typeof patch !== "object") return invalid("patch");
  const sets = [];
  const args = [];
  for (const k of Object.keys(patch)) {
    const col = STAGE_COLUMNS[k];
    if (!col || !col[1](patch[k])) return invalid(k);
    sets.push(`${col[0]} = ?`);
    args.push(JSON_COLUMNS.includes(k) ? JSON.stringify(patch[k]) : patch[k]);
  }
  if (sets.length === 0) return invalid("patch");
  const r = tx.prepare(`UPDATE ${S.TABLE} SET ${sets.join(", ")}, updated_at = ?, version = version + 1
    WHERE chain_id = ? AND version = ? AND state = 'ACTIVE'`).run(...args, now, chainId, version);
  return { ok: true, changed: Number(r.changes) === 1 };
}

function toFragment(row) {
  return Object.freeze({ chainId: row.chain_id, stageNo: Number(row.stage_no), systemId: Number(row.system_id),
    regionId: Number(row.region_id), loreSource: row.lore_source, loreText: row.lore_text === null ? null : row.lore_text,
    hintText: row.hint_text === null ? null : row.hint_text, foundAt: Number(row.found_at),
    deliveredAt: numOrNull(row.delivered_at), loreAttempts: Number(row.lore_attempts) });
}

function getFragmentInTx(tx, chainId, stageNo) {
  const row = tx.prepare(`SELECT * FROM ${S.FRAGMENTS_TABLE} WHERE chain_id = ? AND stage_no = ?`)
    .get(String(chainId), stageNo);
  return row ? toFragment(row) : null;
}

function listFragmentsInTx(tx, chainId) {
  return tx.prepare(`SELECT * FROM ${S.FRAGMENTS_TABLE} WHERE chain_id = ? ORDER BY stage_no`).all(String(chainId))
    .map(toFragment);
}

function insertFragmentInTx(tx, f) {
  if (!f || typeof f !== "object") return invalid("fragment");
  if (!isText(f.chainId, S.MAX_CHAIN_ID)) return invalid("chainId");
  if (!isId(f.stageNo) || f.stageNo > S.MAX_STAGE_COUNT) return invalid("stageNo");
  if (!isId(f.systemId)) return invalid("systemId");
  if (!isId(f.regionId)) return invalid("regionId");
  if (!isTime(f.foundAt)) return invalid("foundAt");
  const r = tx.prepare(`INSERT INTO ${S.FRAGMENTS_TABLE} (chain_id, stage_no, system_id, region_id, lore_source,
    found_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (chain_id, stage_no) DO NOTHING`)
    .run(f.chainId, f.stageNo, f.systemId, f.regionId, LORE_PENDING, f.foundAt);
  return { ok: true, created: Number(r.changes) === 1 };
}

function deliverFragmentInTx(tx, chainId, stageNo, o) {
  const p = o || {};
  if (!isText(chainId, S.MAX_CHAIN_ID)) return invalid("chainId");
  if (!isId(stageNo)) return invalid("stageNo");
  if (!isText(p.loreSource, S.MAX_TEMPLATE_ID)) return invalid("loreSource");
  if (!isText(p.loreText, MAX_FRAGMENT_TEXT)) return invalid("loreText");
  if (!isText(p.hintText, MAX_FRAGMENT_TEXT)) return invalid("hintText");
  if (!isTime(p.now)) return invalid("now");
  const r = tx.prepare(`UPDATE ${S.FRAGMENTS_TABLE} SET lore_source = ?, lore_text = ?, hint_text = ?,
    delivered_at = ? WHERE chain_id = ? AND stage_no = ? AND delivered_at IS NULL`)
    .run(p.loreSource, p.loreText, p.hintText, p.now, chainId, stageNo);
  return { ok: true, changed: Number(r.changes) === 1 };
}

const LORE_AI = "ai";

function markLoreAskedInTx(tx, chainId, stageNo) {
  if (!isText(chainId, S.MAX_CHAIN_ID)) return invalid("chainId");
  if (!isId(stageNo) || stageNo > S.MAX_STAGE_COUNT) return invalid("stageNo");
  const r = tx.prepare(`UPDATE ${S.FRAGMENTS_TABLE} SET lore_attempts = 1 WHERE chain_id = ? AND stage_no = ?
    AND lore_attempts = 0 AND delivered_at IS NULL AND lore_source = ?`).run(chainId, stageNo, LORE_PENDING);
  return { ok: true, changed: Number(r.changes) === 1 };
}

function setAiLoreInTx(tx, chainId, stageNo, text) {
  if (!isText(chainId, S.MAX_CHAIN_ID)) return invalid("chainId");
  if (!isId(stageNo) || stageNo > S.MAX_STAGE_COUNT) return invalid("stageNo");
  if (!isText(text, MAX_FRAGMENT_TEXT)) return invalid("text");
  const r = tx.prepare(`UPDATE ${S.FRAGMENTS_TABLE} SET lore_source = ?, lore_text = ? WHERE chain_id = ?
    AND stage_no = ? AND delivered_at IS NULL AND lore_source = ? AND lore_attempts >= 1`)
    .run(LORE_AI, text, chainId, stageNo, LORE_PENDING);
  return { ok: true, changed: Number(r.changes) === 1 };
}

function countLoreAsksSinceInTx(tx, sinceMs) {
  if (!isTime(sinceMs)) return invalid("sinceMs");
  const row = tx.prepare(`SELECT COUNT(*) AS n FROM ${S.FRAGMENTS_TABLE} WHERE found_at >= ? AND lore_attempts > 0`)
    .get(sinceMs);
  return { ok: true, count: Number(row.n) };
}

function deleteEndedInTx(tx, before, limit) {
  if (!isTime(before)) return invalid("before");
  if (!isId(limit)) return invalid("limit");
  const ids = tx.prepare(`SELECT chain_id AS id FROM ${S.TABLE} WHERE ended_at IS NOT NULL AND ended_at < ?
    AND chain_no < (SELECT MAX(t2.chain_no) FROM ${S.TABLE} t2 WHERE t2.character_id = ${S.TABLE}.character_id
      AND t2.season_key = ${S.TABLE}.season_key)
    ORDER BY ended_at, chain_id LIMIT ?`).all(before, limit).map((x) => x.id);
  if (ids.length === 0) return { ok: true, deleted: 0 };
  const marks = placeholders(ids.length);
  tx.prepare(`DELETE FROM ${S.FRAGMENTS_TABLE} WHERE chain_id IN (${marks})`).run(...ids);
  const rows = tx.prepare(`DELETE FROM ${S.TABLE} WHERE chain_id IN (${marks})`).run(...ids);
  return { ok: true, deleted: Number(rows.changes) };
}

module.exports = { getByOriginInTx, getByIdInTx, getActiveByCharacterInTx, hasActiveInTx, seasonStatsInTx,
  lastEndedAtInTx, countActiveInTx, insertChainInTx, listDueInTx, listActiveInTx, endChainInTx, rescheduleInTx,
  deleteEndedInTx, toChain, updateStageInTx, getFragmentInTx, listFragmentsInTx, insertFragmentInTx,
  deliverFragmentInTx, LORE_PENDING, markLoreAskedInTx, setAiLoreInTx, countLoreAsksSinceInTx, LORE_AI };
