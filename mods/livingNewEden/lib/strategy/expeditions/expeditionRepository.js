"use strict";

const { toBind } = require("../../persistence/repository");
const { TABLE_NAME, OUTCOMES, END_REASONS } = require("./schema");

const T = TABLE_NAME;
const MAX_DETAIL_BYTES = 1024;
const PERMILLE = 1000;
const CREATE_KEYS = Object.freeze(["expeditionId", "factionId", "fleetId", "operationId", "originSystemId",
  "systemId", "entryPairKey", "seed", "plannedAt", "arriveAt", "evacuateAt", "detail"]);
const EDGES = Object.freeze({
  PLANNED: Object.freeze(["ACTIVE", "EVACUATING", "CUT_OFF", "ENDED"]),
  ACTIVE: Object.freeze(["EVACUATING", "CUT_OFF", "ENDED"]),
  EVACUATING: Object.freeze(["EVACUATING", "CUT_OFF", "ENDED"]),
  CUT_OFF: Object.freeze(["CUT_OFF", "EVACUATING", "ENDED"]),
});
const PATCH_COLUMNS = Object.freeze({ activeFrom: "active_from", presencePermille: "presence_permille",
  stepSeq: "step_seq", watchRound: "watch_round", cutOffAt: "cut_off_at", decisionAt: "decision_at",
  returnOperationId: "return_operation_id", evacSeq: "evac_seq", outcome: "outcome", endReason: "end_reason",
  endedAt: "ended_at", holdOperationId: "hold_operation_id" });
const PATCH_KEYS = Object.freeze({
  ACTIVE: Object.freeze(["activeFrom", "presencePermille", "stepSeq", "watchRound"]),
  EVACUATING: Object.freeze(["returnOperationId", "evacSeq", "presencePermille", "stepSeq", "watchRound"]),
  CUT_OFF: Object.freeze(["cutOffAt", "decisionAt", "presencePermille", "stepSeq", "watchRound", "holdOperationId"]),
  ENDED: Object.freeze(["outcome", "endReason", "endedAt", "presencePermille"]),
});
const TEXT_PATCH = Object.freeze(["returnOperationId", "outcome", "endReason", "holdOperationId"]);

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= 200;
const invalid = (detail) => ({ ok: false, reason: "EXPEDITION_INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));

function parseDetail(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function toExpedition(row) {
  return Object.freeze({
    expeditionId: row.expedition_id,
    idempotencyKey: row.idempotency_key,
    factionId: num(row.faction_id),
    fleetId: row.fleet_id,
    operationId: row.operation_id,
    returnOperationId: row.return_operation_id,
    holdOperationId: row.hold_operation_id,
    originSystemId: num(row.origin_system_id),
    systemId: num(row.system_id),
    entryPairKey: row.entry_pair_key,
    state: row.state,
    outcome: row.outcome,
    endReason: row.end_reason,
    seed: num(row.seed),
    plannedAt: num(row.planned_at),
    arriveAt: num(row.arrive_at),
    evacuateAt: num(row.evacuate_at),
    activeFrom: num(row.active_from),
    presencePermille: num(row.presence_permille),
    cutOffAt: num(row.cut_off_at),
    decisionAt: num(row.decision_at),
    evacSeq: num(row.evac_seq),
    stepSeq: num(row.step_seq),
    watchRound: num(row.watch_round),
    endedAt: num(row.ended_at),
    detail: Object.freeze(parseDetail(row.detail_json) || {}),
    updatedAt: num(row.updated_at),
    version: num(row.version),
  });
}

function uniqueRefusal(err) {
  const text = String((err && err.message) || "");
  if (text.includes("system_id")) return { ok: false, reason: "EXPEDITION_SYSTEM_TAKEN" };
  if (text.includes("fleet_id")) return { ok: false, reason: "EXPEDITION_FLEET_TAKEN" };
  return { ok: false, reason: "EXPEDITION_KEY_TAKEN" };
}

const isUnique = (err) => Boolean(err && (err.code === "SQLITE_CONSTRAINT_UNIQUE"
  || err.code === "SQLITE_CONSTRAINT_PRIMARYKEY"));

function checkPatchValue(key, v) {
  if (TEXT_PATCH.includes(key)) return isText(v) ? null : invalid(`patch.${key}`);
  if (key === "presencePermille") return isCount(v) && v <= PERMILLE ? null : invalid("patch.presencePermille");
  return isCount(v) ? null : invalid(`patch.${key}`);
}

function createExpeditionRepository() {
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      insert: db.prepare(`INSERT INTO ${T} (expedition_id, idempotency_key, faction_id, fleet_id, operation_id,
        return_operation_id, hold_operation_id, origin_system_id, system_id, entry_pair_key, state, outcome,
        end_reason, seed, planned_at, arrive_at, evacuate_at, active_from, presence_permille, cut_off_at, decision_at,
        evac_seq, step_seq, watch_round, ended_at, detail_json, updated_at, version)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'PLANNED', NULL, NULL, ?, ?, ?, ?, NULL, 0, NULL, NULL, 0, 0, 0,
        NULL, ?, ?, 1)`),
      byId: db.prepare(`SELECT * FROM ${T} WHERE expedition_id = ?`),
      byKey: db.prepare(`SELECT * FROM ${T} WHERE idempotency_key = ?`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state <> 'ENDED'`),
      countFaction: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ? AND state <> 'ENDED'`),
      listOpen: db.prepare(`SELECT * FROM ${T} WHERE state <> 'ENDED' AND expedition_id > ?
        ORDER BY expedition_id LIMIT ?`),
      occupied: db.prepare(`SELECT system_id FROM ${T} WHERE state IN ('PLANNED','ACTIVE')
        ORDER BY system_id LIMIT ?`),
      watch: db.prepare(`UPDATE ${T} SET step_seq = ?, watch_round = ?, presence_permille = ?, updated_at = ?,
        version = version + 1 WHERE expedition_id = ? AND version = ? AND state = ?`),
      listEnded: db.prepare(`SELECT * FROM ${T} WHERE state = 'ENDED' ORDER BY ended_at DESC, expedition_id DESC
        LIMIT ?`),
      prune: db.prepare(`DELETE FROM ${T} WHERE expedition_id IN (SELECT expedition_id FROM ${T}
        WHERE state = 'ENDED' AND ended_at < ? ORDER BY ended_at, expedition_id LIMIT ?)`),
      transition: new Map(),
    };
    perDb.set(db, s);
    return s;
  }

  function transitionStmt(db, to, keys) {
    const s = stmts(db);
    const id = `${to}|${keys.join(",")}`;
    let st = s.transition.get(id);
    if (st) return st;
    const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(", ");
    st = db.prepare(`UPDATE ${T} SET state = ?, ${sets}${sets ? ", " : ""}updated_at = ?, version = version + 1
      WHERE expedition_id = ? AND version = ? AND state = ?`);
    s.transition.set(id, st);
    return st;
  }

  function createExpedition(tx, spec, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec !== "object") return invalid("spec");
    const extra = Object.keys(spec).find((k) => !CREATE_KEYS.includes(k));
    if (extra !== undefined) return invalid(`spec.${extra}`);
    if (!isText(idempotencyKey)) return invalid("idempotencyKey");
    for (const k of ["expeditionId", "fleetId", "operationId", "entryPairKey"]) if (!isText(spec[k])) return invalid(k);
    if (spec.expeditionId.length > 64) return invalid("expeditionId");
    if (spec.entryPairKey.length < 3 || spec.entryPairKey.length > 64) return invalid("entryPairKey");
    for (const k of ["factionId", "originSystemId", "systemId"]) if (!isId(spec[k])) return invalid(k);
    if (!isCount(spec.seed)) return invalid("seed");
    if (!isTime(spec.plannedAt) || !isTime(spec.arriveAt) || spec.arriveAt < spec.plannedAt) return invalid("arriveAt");
    if (!isTime(spec.evacuateAt) || spec.evacuateAt <= spec.arriveAt) return invalid("evacuateAt");
    let detail;
    try {
      detail = JSON.stringify(spec.detail || {});
    } catch (_err) {
      return invalid("detail");
    }
    if (Buffer.byteLength(detail, "utf8") > MAX_DETAIL_BYTES) return invalid("detail: > 1 KiB");
    const s = stmts(tx);
    const earlier = s.byKey.get(idempotencyKey);
    if (earlier) return { ok: true, duplicate: true, expedition: toExpedition(earlier) };
    try {
      s.insert.run(spec.expeditionId, idempotencyKey, toBind(spec.factionId), spec.fleetId, spec.operationId,
        toBind(spec.originSystemId), toBind(spec.systemId), spec.entryPairKey, toBind(spec.seed),
        toBind(spec.plannedAt), toBind(spec.arriveAt), toBind(spec.evacuateAt), detail, toBind(spec.plannedAt));
    } catch (err) {
      if (isUnique(err) && tx.inTransaction === true) return uniqueRefusal(err);
      throw err;
    }
    return { ok: true, duplicate: false, expedition: toExpedition(s.byId.get(spec.expeditionId)) };
  }

  function getExpedition(tx, expeditionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(expeditionId)) return invalid("expeditionId");
    const row = stmts(tx).byId.get(expeditionId);
    return { ok: true, expedition: row ? toExpedition(row) : null };
  }

  function countOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (o.factionId !== undefined && !isId(o.factionId)) return invalid("factionId");
    const row = o.factionId === undefined ? stmts(tx).countAll.get() : stmts(tx).countFaction.get(toBind(o.factionId));
    return { ok: true, count: Number(row.n) };
  }

  function listOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) return invalid("limit");
    const after = o.afterId === undefined ? "" : o.afterId;
    if (typeof after !== "string") return invalid("afterId");
    const rows = stmts(tx).listOpen.all(after, toBind(o.limit));
    return { ok: true, expeditions: rows.map(toExpedition),
      nextAfter: rows.length === o.limit ? rows[rows.length - 1].expedition_id : null };
  }

  function occupiedSystems(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) return invalid("limit");
    return { ok: true, systems: stmts(tx).occupied.all(toBind(o.limit)).map((r) => Number(r.system_id)) };
  }

  function transitionExpedition(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || typeof change !== "object") return invalid("change");
    const { expeditionId, expectedVersion, from, to } = change;
    const patch = change.patch || {};
    if (!isText(expeditionId)) return invalid("expeditionId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalid("expectedVersion");
    if (!EDGES[from] || !EDGES[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
    if (!isTime(change.at)) return invalid("at");
    const keys = Object.keys(patch).sort();
    const wrong = keys.find((k) => !PATCH_KEYS[to].includes(k));
    if (wrong !== undefined) return invalid(`patch.${wrong}`);
    for (const k of keys) {
      const bad = checkPatchValue(k, patch[k]);
      if (bad) return bad;
    }
    if (to === "ENDED") {
      if (!OUTCOMES.includes(patch.outcome)) return invalid("patch.outcome");
      if (!END_REASONS.includes(patch.endReason)) return invalid("patch.endReason");
      if (!isTime(patch.endedAt)) return invalid("patch.endedAt");
    }
    if (to === "CUT_OFF" && from !== "CUT_OFF" && (!isTime(patch.cutOffAt) || !isTime(patch.decisionAt))) {
      return invalid("patch.cutOff");
    }
    const values = keys.map((k) => (TEXT_PATCH.includes(k) ? patch[k] : toBind(patch[k])));
    const info = transitionStmt(tx, to, keys).run(to, ...values, toBind(change.at), expeditionId,
      toBind(expectedVersion), from);
    if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT", expeditionId };
    return { ok: true, expedition: toExpedition(stmts(tx).byId.get(expeditionId)) };
  }

  function watchExpedition(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || typeof change !== "object") return invalid("change");
    const { expeditionId, expectedVersion, state, stepSeq, watchRound, at } = change;
    if (!isText(expeditionId)) return invalid("expeditionId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalid("expectedVersion");
    if (!EDGES[state]) return invalid("state");
    if (!isCount(stepSeq) || !isCount(watchRound) || !isTime(at)) return invalid("change");
    const presence = change.presencePermille;
    if (!isCount(presence) || presence > PERMILLE) return invalid("presencePermille");
    const s = stmts(tx);
    const info = s.watch.run(toBind(stepSeq), toBind(watchRound), toBind(presence), toBind(at), expeditionId,
      toBind(expectedVersion), state);
    if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT", expeditionId };
    return { ok: true, expedition: toExpedition(s.byId.get(expeditionId)) };
  }

  function listEnded(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) return invalid("limit");
    return { ok: true, expeditions: stmts(tx).listEnded.all(toBind(o.limit)).map(toExpedition) };
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

  return Object.freeze({ createExpedition, getExpedition, countOpen, listOpen, listEnded, occupiedSystems,
    transitionExpedition, watchExpedition, pruneEnded });
}

module.exports = { createExpeditionRepository, toExpedition };
