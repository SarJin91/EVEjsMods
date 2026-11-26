"use strict";

const { toBind } = require("../../persistence/repository");
const { TABLE_NAME, CAMP_OUTCOMES, END_REASONS } = require("./schema");

const T = TABLE_NAME;
const MAX_DETAIL_BYTES = 1024;
const CREATE_KEYS = Object.freeze(["campId", "factionId", "fleetId", "operationId", "systemId", "seed", "plannedAt",
  "arriveAt", "untilAt", "detail"]);
const EDGES = Object.freeze({ PLANNED: Object.freeze(["ACTIVE", "ENDED"]), ACTIVE: Object.freeze(["ENDED"]) });

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= 200;
const invalid = (detail) => ({ ok: false, reason: "LOWSEC_INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));

function parseDetail(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function toCamp(row) {
  return Object.freeze({
    campId: row.camp_id,
    idempotencyKey: row.idempotency_key,
    factionId: num(row.faction_id),
    fleetId: row.fleet_id,
    operationId: row.operation_id,
    systemId: num(row.system_id),
    state: row.state,
    outcome: row.outcome,
    endReason: row.end_reason,
    seed: num(row.seed),
    plannedAt: num(row.planned_at),
    arriveAt: num(row.arrive_at),
    untilAt: num(row.until_at),
    activeFrom: num(row.active_from),
    stepSeq: num(row.step_seq),
    watchRound: num(row.watch_round),
    intercepts: num(row.intercepts),
    lastInterceptAt: num(row.last_intercept_at),
    endedAt: num(row.ended_at),
    detail: Object.freeze(parseDetail(row.detail_json) || {}),
    updatedAt: num(row.updated_at),
    version: num(row.version),
  });
}

function uniqueRefusal(err) {
  const text = String((err && err.message) || "");
  if (text.includes("system_id")) return { ok: false, reason: "CAMP_SYSTEM_TAKEN" };
  if (text.includes("fleet_id")) return { ok: false, reason: "CAMP_FLEET_TAKEN" };
  return { ok: false, reason: "CAMP_KEY_TAKEN" };
}

const isUnique = (err) => Boolean(err && (err.code === "SQLITE_CONSTRAINT_UNIQUE"
  || err.code === "SQLITE_CONSTRAINT_PRIMARYKEY"));

function createCampRepository() {
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      insert: db.prepare(`INSERT INTO ${T} (camp_id, idempotency_key, faction_id, fleet_id, operation_id, system_id,
        state, outcome, end_reason, seed, planned_at, arrive_at, until_at, active_from, step_seq, watch_round,
        intercepts, last_intercept_at, ended_at, detail_json, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, 'PLANNED', NULL, NULL, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, NULL, ?, ?, 1)`),
      byId: db.prepare(`SELECT * FROM ${T} WHERE camp_id = ?`),
      byKey: db.prepare(`SELECT * FROM ${T} WHERE idempotency_key = ?`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state IN ('PLANNED','ACTIVE') AND until_at > ?`),
      countFaction: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ? AND state IN ('PLANNED','ACTIVE')
        AND until_at > ?`),
      listOpen: db.prepare(`SELECT * FROM ${T} WHERE state IN ('PLANNED','ACTIVE') AND until_at > ? AND camp_id > ?
        ORDER BY camp_id LIMIT ?`),
      activate: db.prepare(`UPDATE ${T} SET state = 'ACTIVE', active_from = ?, step_seq = ?, watch_round = ?,
        updated_at = ?, version = version + 1 WHERE camp_id = ? AND version = ? AND state = 'PLANNED'`),
      end: db.prepare(`UPDATE ${T} SET state = 'ENDED', outcome = ?, end_reason = ?, ended_at = ?,
        active_from = COALESCE(active_from, ?), updated_at = ?, version = version + 1
        WHERE camp_id = ? AND version = ? AND state = ?`),
      watch: db.prepare(`UPDATE ${T} SET step_seq = ?, watch_round = ?, updated_at = ?, version = version + 1
        WHERE camp_id = ? AND version = ? AND state IN ('PLANNED','ACTIVE')`),
      intercept: db.prepare(`UPDATE ${T} SET intercepts = intercepts + 1, last_intercept_at = ?,
        detail_json = json_set(COALESCE(detail_json, '{}'), '$.lastConvoyId', ?), updated_at = ?,
        version = version + 1 WHERE camp_id = ? AND version = ? AND state = 'ACTIVE'`),
      prune: db.prepare(`DELETE FROM ${T} WHERE camp_id IN (SELECT camp_id FROM ${T} WHERE state = 'ENDED'
        AND ended_at < ? ORDER BY ended_at, camp_id LIMIT ?)`),
    };
    perDb.set(db, s);
    return s;
  }

  function createCamp(tx, spec, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec !== "object") return invalid("spec");
    const extra = Object.keys(spec).find((k) => !CREATE_KEYS.includes(k));
    if (extra !== undefined) return invalid(`spec.${extra}`);
    if (!isText(idempotencyKey)) return invalid("idempotencyKey");
    for (const k of ["campId", "fleetId", "operationId"]) if (!isText(spec[k])) return invalid(k);
    if (spec.campId.length > 64) return invalid("campId");
    for (const k of ["factionId", "systemId"]) if (!isId(spec[k])) return invalid(k);
    if (!isCount(spec.seed)) return invalid("seed");
    if (!isTime(spec.plannedAt) || !isTime(spec.arriveAt) || spec.arriveAt < spec.plannedAt) return invalid("arriveAt");
    if (!isTime(spec.untilAt) || spec.untilAt <= spec.arriveAt) return invalid("untilAt");
    let detail;
    try {
      detail = JSON.stringify(spec.detail || {});
    } catch (_err) {
      return invalid("detail");
    }
    if (Buffer.byteLength(detail, "utf8") > MAX_DETAIL_BYTES) return invalid("detail: > 1 KiB");
    const s = stmts(tx);
    const earlier = s.byKey.get(idempotencyKey);
    if (earlier) return { ok: true, duplicate: true, camp: toCamp(earlier) };
    try {
      s.insert.run(spec.campId, idempotencyKey, toBind(spec.factionId), spec.fleetId, spec.operationId,
        toBind(spec.systemId), toBind(spec.seed), toBind(spec.plannedAt), toBind(spec.arriveAt), toBind(spec.untilAt),
        detail, toBind(spec.plannedAt));
    } catch (err) {
      if (isUnique(err) && tx.inTransaction === true) return uniqueRefusal(err);
      throw err;
    }
    return { ok: true, duplicate: false, camp: toCamp(s.byId.get(spec.campId)) };
  }

  function getCamp(tx, campId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(campId)) return invalid("campId");
    const row = stmts(tx).byId.get(campId);
    return { ok: true, camp: row ? toCamp(row) : null };
  }

  function countOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!isTime(o.liveAt)) return invalid("liveAt");
    if (o.factionId !== undefined && !isId(o.factionId)) return invalid("factionId");
    const row = o.factionId === undefined ? stmts(tx).countAll.get(toBind(o.liveAt))
      : stmts(tx).countFaction.get(toBind(o.factionId), toBind(o.liveAt));
    return { ok: true, count: Number(row.n) };
  }

  function listOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) return invalid("limit");
    const after = o.after === undefined ? "" : o.after;
    if (typeof after !== "string") return invalid("after");
    const liveAt = o.liveAt === undefined ? -1 : o.liveAt;
    if (liveAt !== -1 && !isTime(liveAt)) return invalid("liveAt");
    const rows = stmts(tx).listOpen.all(toBind(liveAt), after, toBind(o.limit));
    return { ok: true, camps: rows.map(toCamp), nextAfter: rows.length === o.limit ? rows[rows.length - 1].camp_id
      : null };
  }

  function transitionCamp(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || typeof change !== "object") return invalid("change");
    const { campId, expectedVersion, from, to } = change;
    const patch = change.patch || {};
    if (!isText(campId)) return invalid("campId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalid("expectedVersion");
    if (!EDGES[from] || !EDGES[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
    const s = stmts(tx);
    let info;
    if (to === "ACTIVE") {
      if (!isTime(patch.activeFrom) || !isCount(patch.stepSeq) || !isCount(patch.watchRound)) return invalid("patch");
      info = s.activate.run(toBind(patch.activeFrom), toBind(patch.stepSeq), toBind(patch.watchRound),
        toBind(patch.activeFrom), campId, toBind(expectedVersion));
    } else {
      if (!CAMP_OUTCOMES.includes(patch.outcome)) return invalid("patch.outcome");
      if (!END_REASONS.includes(patch.endReason)) return invalid("patch.endReason");
      if (!isTime(patch.endedAt)) return invalid("patch.endedAt");
      info = s.end.run(patch.outcome, patch.endReason, toBind(patch.endedAt), toBind(patch.endedAt),
        toBind(patch.endedAt), campId,
        toBind(expectedVersion), from);
    }
    if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
    return { ok: true, camp: toCamp(s.byId.get(campId)) };
  }

  function watchCamp(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || typeof change !== "object") return invalid("change");
    const { campId, expectedVersion, stepSeq, watchRound, at } = change;
    if (!isText(campId)) return invalid("campId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalid("expectedVersion");
    if (!isCount(stepSeq) || !isCount(watchRound) || !isTime(at)) return invalid("change");
    const s = stmts(tx);
    const info = s.watch.run(toBind(stepSeq), toBind(watchRound), toBind(at), campId, toBind(expectedVersion));
    if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
    return { ok: true, camp: toCamp(s.byId.get(campId)) };
  }

  function noteIntercept(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || typeof change !== "object") return invalid("change");
    const { campId, expectedVersion, at, convoyId } = change;
    if (!isText(campId)) return invalid("campId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalid("expectedVersion");
    if (!isTime(at)) return invalid("at");
    if (!isText(convoyId)) return invalid("convoyId");
    const s = stmts(tx);
    const info = s.intercept.run(toBind(at), convoyId, toBind(at), campId, toBind(expectedVersion));
    if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
    return { ok: true, camp: toCamp(s.byId.get(campId)) };
  }

  function pruneEnded(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!Number.isSafeInteger(o.before)) return invalid("before");
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) return invalid("limit");
    if (o.before <= 0) return { ok: true, pruned: 0 };
    const info = stmts(tx).prune.run(toBind(o.before), toBind(o.limit));
    return { ok: true, pruned: Number(info.changes) };
  }

  return Object.freeze({ createCamp, getCamp, countOpen, listOpen, transitionCamp, watchCamp, noteIntercept,
    pruneEnded });
}

module.exports = { createCampRepository, toCamp };
