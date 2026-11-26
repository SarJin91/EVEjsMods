"use strict";

const { defineTable, updateWithVersion, toBind } = require("../persistence/repository");
const { isValidTransition, OPEN_STATES, TERMINAL_STATES } = require("./eventMachine");
const S = require("./schema");

const EVENTS_TABLE = defineTable({
  name: S.TABLE,
  idColumn: "event_id",
  columns: ["state", "due_at", "ended_at", "result_reference", "result_json", "sites_created", "cleanup_pending",
    "updated_at"],
});

const PATCH_KEYS = Object.freeze(["state", "due_at", "ended_at", "result_reference", "result_json", "sites_created",
  "cleanup_pending"]);

const INSERT_COLUMNS = Object.freeze(["event_id", "plan_key", "event_type", "catalog_version", "system_id",
  "faction_id", "campaign_id", "cause", "template_id", "template_ids", "label", "state", "spawn_budget",
  "created_at", "due_at", "expires_at", "seed", "reason_json", "updated_at"]);

const OPEN_SQL = OPEN_STATES.map((s) => `'${s}'`).join(", ");
const TERMINAL_SQL = TERMINAL_STATES.map((s) => `'${s}'`).join(", ");
const MAX_UINT32 = 0xffffffff;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

const cache = new WeakMap();

function stmts(tx) {
  let s = cache.get(tx);
  if (s) return s;
  s = {
    insert: tx.prepare(`INSERT INTO ${S.TABLE} (${INSERT_COLUMNS.join(", ")})
      VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})`),
    byPlanKey: tx.prepare(`SELECT event_id FROM ${S.TABLE} WHERE plan_key = ?`),
    byId: tx.prepare(`SELECT * FROM ${S.TABLE} WHERE event_id = ?`),
    stateOf: tx.prepare(`SELECT state, version FROM ${S.TABLE} WHERE event_id = ?`),
    open: tx.prepare(`SELECT * FROM ${S.TABLE} WHERE state IN ('PLANNED', 'ACTIVE', 'COMPLETING')
      ORDER BY due_at, event_id LIMIT ?`),
    pending: tx.prepare(`SELECT * FROM ${S.TABLE} WHERE cleanup_pending IS NOT NULL
      ORDER BY ended_at, event_id LIMIT ?`),
    recent: tx.prepare(`SELECT system_id, event_type, created_at, spawn_budget, result_reference FROM ${S.TABLE}
      WHERE created_at > ? ORDER BY created_at DESC, event_id LIMIT ?`),
    countOpenSystem: tx.prepare(`SELECT COUNT(*) AS n FROM ${S.TABLE}
      WHERE system_id = ? AND state IN (${OPEN_SQL})`),
    activeSystem: tx.prepare(`SELECT * FROM ${S.TABLE} WHERE system_id = ? AND state = 'ACTIVE'
      ORDER BY created_at DESC, event_id LIMIT ?`),
    deleteEnded: tx.prepare(`DELETE FROM ${S.TABLE} WHERE event_id IN (SELECT event_id FROM ${S.TABLE}
      WHERE ended_at IS NOT NULL AND ended_at < ? AND state IN (${TERMINAL_SQL}) ORDER BY ended_at LIMIT ?)`),
  };
  cache.set(tx, s);
  return s;
}

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

function parse(text, corrupt) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    corrupt.flag = true;
    return null;
  }
}

function rowOf(r) {
  if (!r) return null;
  const corrupt = { flag: false };
  const templateIds = parse(r.template_ids, corrupt);
  const reason = parse(r.reason_json, corrupt);
  const result = parse(r.result_json, corrupt);
  const idsOk = Array.isArray(templateIds) && templateIds.every((t) => typeof t === "string");
  if (!idsOk) corrupt.flag = true;
  return Object.freeze({
    eventId: r.event_id, planKey: r.plan_key, eventType: r.event_type, catalogVersion: Number(r.catalog_version),
    systemId: Number(r.system_id), factionId: Number(r.faction_id), campaignId: r.campaign_id, cause: r.cause,
    templateId: r.template_id, templateIds: idsOk ? Object.freeze(templateIds) : null, label: r.label,
    state: r.state, spawnBudget: Number(r.spawn_budget), sitesCreated: Number(r.sites_created),
    createdAt: Number(r.created_at), dueAt: Number(r.due_at), expiresAt: Number(r.expires_at),
    endedAt: num(r.ended_at), seed: Number(r.seed), reason, resultReference: r.result_reference, result,
    cleanupPending: r.cleanup_pending, updatedAt: Number(r.updated_at), version: Number(r.version),
    corrupt: corrupt.flag,
  });
}

function isText(v, max) {
  return typeof v === "string" && v.length >= 1 && v.length <= max;
}

function isTime(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isPositiveId(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function planProblem(plan, eventId, now, reasonJson, idsJson) {
  if (!plan || typeof plan !== "object") return "plan";
  if (!isText(eventId, S.MAX_EVENT_ID_LENGTH)) return "eventId";
  if (!isText(plan.planKey, S.MAX_PLAN_KEY_LENGTH)) return "planKey";
  if (!isText(plan.eventType, S.MAX_EVENT_TYPE_LENGTH)) return "eventType";
  if (!Number.isSafeInteger(plan.catalogVersion) || plan.catalogVersion < 1) return "catalogVersion";
  if (!isPositiveId(plan.systemId)) return "systemId";
  if (!isPositiveId(plan.factionId)) return "factionId";
  if (plan.campaignId !== null && plan.campaignId !== undefined && !isText(plan.campaignId, S.MAX_CAMPAIGN_ID_LENGTH)) {
    return "campaignId";
  }
  if (!isText(plan.cause, S.MAX_CAUSE_LENGTH)) return "cause";
  const ids = plan.templateIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > S.MAX_SPAWN_BUDGET
    || !ids.every((t) => typeof t === "string" && t.length > 0)) return "templateIds";
  if (!isText(plan.label, S.MAX_LABEL_LENGTH)) return "label";
  if (!isTime(now) || !isTime(plan.dueAt) || !isTime(plan.expiresAt)) return "time";
  if (!Number.isSafeInteger(plan.seed) || plan.seed < 0 || plan.seed > MAX_UINT32) return "seed";
  if (reasonJson.length > S.MAX_JSON_LENGTH) return "reason";
  if (idsJson.length > S.MAX_JSON_LENGTH) return "templateIds";
  return null;
}

function insertPlannedInTx(tx, plan, { eventId, now } = {}) {
  if (txMissing(tx)) return TX_REQUIRED;
  let reasonJson;
  let idsJson;
  try {
    reasonJson = JSON.stringify(plan && plan.reason !== undefined ? plan.reason : {}) || "{}";
    idsJson = JSON.stringify(plan && plan.templateIds) || "";
  } catch (_err) {
    return { ok: false, reason: "PLAN_INVALID", detail: "json" };
  }
  const problem = planProblem(plan, eventId, now, reasonJson, idsJson);
  if (problem) return { ok: false, reason: "PLAN_INVALID", detail: problem };
  const s = stmts(tx);
  const existing = s.byPlanKey.get(plan.planKey);
  if (existing) return { ok: true, inserted: false, eventId: existing.event_id };
  s.insert.run(eventId, plan.planKey, plan.eventType, toBind(plan.catalogVersion), toBind(plan.systemId),
    toBind(plan.factionId), plan.campaignId === undefined ? null : plan.campaignId, plan.cause, plan.templateIds[0],
    idsJson, plan.label, "PLANNED", toBind(plan.templateIds.length), toBind(now), toBind(plan.dueAt),
    toBind(plan.expiresAt), toBind(plan.seed), reasonJson, toBind(now));
  return { ok: true, inserted: true, eventId };
}

function limitOf(limit) {
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
}

function listOpen(tx, { limit } = {}) {
  if (txMissing(tx)) return TX_REQUIRED;
  const n = limitOf(limit);
  const rows = stmts(tx).open.all(toBind(n + 1));
  return { ok: true, events: rows.slice(0, n).map(rowOf), truncated: rows.length > n };
}

function listPendingCleanup(tx, { limit } = {}) {
  if (txMissing(tx)) return TX_REQUIRED;
  return { ok: true, events: stmts(tx).pending.all(toBind(limitOf(limit))).map(rowOf) };
}

function listRecent(tx, { sinceAt, limit } = {}) {
  if (txMissing(tx)) return TX_REQUIRED;
  const n = limitOf(limit);
  const rows = stmts(tx).recent.all(toBind(Math.max(0, Math.floor(Number(sinceAt) || 0))), toBind(n + 1));
  return { ok: true, truncated: rows.length > n, rows: rows.slice(0, n).map((r) => Object.freeze({
    systemId: Number(r.system_id), eventType: r.event_type, createdAt: Number(r.created_at),
    spawnBudget: Number(r.spawn_budget), resultReference: r.result_reference ?? null })) };
}

function transitionInTx(tx, eventId, expectedVersion, patch, now) {
  if (txMissing(tx)) return TX_REQUIRED;
  if (!patch || typeof patch !== "object") return { ok: false, reason: "REPO_INVALID_INPUT", detail: "patch" };
  if (!isTime(now)) return { ok: false, reason: "REPO_INVALID_INPUT", detail: "now" };
  const full = { updated_at: now };
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCH_KEYS.includes(key)) return { ok: false, reason: "REPO_INVALID_INPUT", detail: `patch: ${key}` };
    full[key] = key === "result_json" && value !== null && typeof value === "object" ? JSON.stringify(value) : value;
  }
  if (typeof full.result_json === "string" && full.result_json.length > S.MAX_JSON_LENGTH) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "result_json" };
  }
  if (full.cleanup_pending !== undefined && full.cleanup_pending !== null
    && !S.CLEANUP_REASONS.includes(full.cleanup_pending)) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "cleanup_pending" };
  }
  if (full.state !== undefined) {
    const cur = stmts(tx).stateOf.get(eventId);
    if (!cur) return { ok: false, reason: "ROW_NOT_FOUND" };
    if (Number(cur.version) !== expectedVersion) return { ok: false, reason: "VERSION_CONFLICT" };
    if (full.state !== cur.state && !isValidTransition(cur.state, full.state)) {
      return { ok: false, reason: "TRANSITION_INVALID", detail: `${cur.state}->${full.state}` };
    }
  }
  return updateWithVersion(tx, EVENTS_TABLE, eventId, expectedVersion, full);
}

function deleteEndedBefore(tx, before, limit) {
  if (txMissing(tx)) return TX_REQUIRED;
  return { ok: true, deleted: stmts(tx).deleteEnded.run(toBind(Math.max(0, before)), toBind(limitOf(limit))).changes };
}

function countOpenInSystem(tx, systemId) {
  if (txMissing(tx)) return TX_REQUIRED;
  return { ok: true, count: Number(stmts(tx).countOpenSystem.get(toBind(systemId)).n) };
}

function listActiveInSystem(tx, systemId, { limit } = {}) {
  if (txMissing(tx)) return TX_REQUIRED;
  const n = limitOf(limit);
  const rows = stmts(tx).activeSystem.all(toBind(systemId), toBind(n + 1));
  return { ok: true, events: rows.slice(0, n).map(rowOf), truncated: rows.length > n };
}

function getEvent(tx, eventId) {
  if (txMissing(tx)) return TX_REQUIRED;
  return { ok: true, event: rowOf(stmts(tx).byId.get(String(eventId))) };
}

module.exports = {
  EVENTS_TABLE,
  rowOf,
  insertPlannedInTx,
  listOpen,
  listPendingCleanup,
  listRecent,
  transitionInTx,
  deleteEndedBefore,
  countOpenInSystem,
  listActiveInSystem,
  getEvent,
};
