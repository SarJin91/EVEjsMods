"use strict";

const { toBind } = require("../../persistence/repository");
const S = require("./schema");
const { canTransition } = require("./machine");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const nullOr = (check) => (v) => v === null || check(v);
const PATCH = Object.freeze({
  creditedMs: ["credited_ms", isCount],
  lastSampleAt: ["last_sample_at", isTime],
  planJson: ["plan_json", nullOr((v) => isText(v, S.MAX_JSON_LENGTH))],
  lossJson: ["loss_json", nullOr((v) => isText(v, S.MAX_JSON_LENGTH))],
  endReason: ["end_reason", nullOr((v) => isText(v, S.MAX_END_REASON_LENGTH))],
  endedAt: ["ended_at", nullOr(isTime)],
});

const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;

function parseJson(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function toRaid(row) {
  return Object.freeze({
    raidId: row.raid_id, targetKind: row.target_kind, targetId: row.target_id, systemId: row.system_id,
    ownerCorpId: row.owner_corp_id, attackerFactionId: row.attacker_faction_id, operationId: row.operation_id,
    state: row.state, open: row.open === 1, phaseSeq: row.phase_seq, creditedMs: row.credited_ms,
    lastSampleAt: row.last_sample_at, startedAt: row.started_at, wallDeadlineAt: row.wall_deadline_at,
    plan: parseJson(row.plan_json), loss: parseJson(row.loss_json), endReason: row.end_reason, endedAt: row.ended_at,
    createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
  });
}

function createHarvestRaidRepository(deps) {
  const journal = deps && deps.journal;
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("harvestRaidRepository: journal");
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE_NAME;
    s = {
      updates: new Map(),
      byId: db.prepare(`SELECT * FROM ${T} WHERE raid_id = ?`),
      openByTarget: db.prepare(`SELECT * FROM ${T} WHERE target_kind = ? AND target_id = ? AND open = 1`),
      lastByTarget: db.prepare(`SELECT * FROM ${T} WHERE target_kind = ? AND target_id = ?
        ORDER BY started_at DESC, raid_id DESC LIMIT 1`),
      lastOwnerStart: db.prepare(`SELECT max(started_at) AS t FROM ${T} WHERE owner_corp_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (raid_id, target_kind, target_id, system_id, owner_corp_id,
        attacker_faction_id, operation_id, state, open, phase_seq, credited_ms, last_sample_at, started_at,
        wall_deadline_at, plan_json, loss_json, end_reason, ended_at, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1)`),
      sample: db.prepare(`UPDATE ${T} SET credited_ms = ?, last_sample_at = ?, updated_at = ?, version = version + 1
        WHERE raid_id = ? AND version = ? AND state = ? AND open = 1`),
      listOpen: db.prepare(`SELECT * FROM ${T} WHERE open = 1 AND raid_id > ? ORDER BY raid_id LIMIT ?`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE open = 1`),
      countFaction: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE attacker_faction_id = ? AND open = 1`),
      pruneIds: db.prepare(`SELECT raid_id FROM ${T} WHERE open = 0 AND ended_at < ? ORDER BY ended_at, raid_id
        LIMIT ?`),
      deleteRaid: db.prepare(`DELETE FROM ${T} WHERE raid_id = ?`),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function validStart(spec) {
    return Boolean(spec && isText(spec.raidId, S.MAX_ID_LENGTH) && S.TARGET_KINDS.includes(spec.targetKind)
      && isId(spec.targetId) && isId(spec.systemId) && isId(spec.ownerCorpId) && isId(spec.attackerFactionId)
      && (spec.operationId === null || isText(spec.operationId, S.MAX_ID_LENGTH)) && isTime(spec.at)
      && isTime(spec.wallDeadlineAt) && spec.wallDeadlineAt >= spec.at);
  }

  function createRaid(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!validStart(spec)) return invalid("spec");
    const payload = { raidId: spec.raidId, targetKind: spec.targetKind, targetId: spec.targetId,
      systemId: spec.systemId, ownerCorpId: spec.ownerCorpId, attackerFactionId: spec.attackerFactionId,
      operationId: spec.operationId, wallDeadlineAt: spec.wallDeadlineAt };
    const r = journal.applyOnce(tx, { key: S.startKey(spec.raidId), aggregate: { type: S.AGGREGATE, id: spec.raidId },
      eventType: S.EVENT_WARNED, payload }, (db) => {
      const s = stmts(db);
      if (s.openByTarget.get(spec.targetKind, toBind(spec.targetId))) {
        return { ok: false, reason: "RAID_OPEN", targetId: spec.targetId };
      }
      if (s.byId.get(spec.raidId)) return { ok: false, reason: "RAID_EXISTS", raidId: spec.raidId };
      s.insert.run(spec.raidId, spec.targetKind, toBind(spec.targetId), toBind(spec.systemId),
        toBind(spec.ownerCorpId), toBind(spec.attackerFactionId), spec.operationId, S.WARNED, toBind(spec.at),
        toBind(spec.at), toBind(spec.wallDeadlineAt), toBind(spec.at), toBind(spec.at));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    return { ok: true, raidId: spec.raidId, duplicate: r.duplicate === true };
  }

  function sample(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const raid = change && change.raid;
    if (!raid || !isText(raid.raidId, S.MAX_ID_LENGTH) || !isId(raid.version)
      || (raid.state !== S.WARNED && raid.state !== S.RAIDING) || !isCount(change.creditedMs)
      || !isTime(change.lastSampleAt) || !isTime(change.at)) return invalid("sample");
    const info = stmts(tx).sample.run(toBind(change.creditedMs), toBind(change.lastSampleAt), toBind(change.at),
      raid.raidId, toBind(raid.version), raid.state);
    if (Number(info.changes) !== 1) return { ok: false, reason: "VERSION_CONFLICT", raidId: raid.raidId };
    return { ok: true, version: raid.version + 1 };
  }

  function transition(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const raid = change && change.raid;
    if (!raid || !isText(raid.raidId, S.MAX_ID_LENGTH) || !isId(raid.version) || !isCount(raid.phaseSeq)) {
      return invalid("raid");
    }
    if (!isTime(change.at)) return invalid("at");
    const edge = canTransition(raid.state, change.to);
    if (!edge.ok) return edge;
    const patch = change.patch || {};
    const sets = [];
    const values = [];
    for (const k of Object.keys(patch).sort()) {
      const spec = PATCH[k];
      if (!spec || !spec[1](patch[k])) return invalid(`patch.${k}`);
      sets.push(`${spec[0]} = ?`);
      values.push(patch[k] === null ? null : (typeof patch[k] === "number" ? toBind(patch[k]) : patch[k]));
    }
    const closing = S.END_STATES.includes(change.to);
    const payload = { raidId: raid.raidId, targetKind: raid.targetKind, targetId: raid.targetId,
      systemId: raid.systemId, ownerCorpId: raid.ownerCorpId, attackerFactionId: raid.attackerFactionId,
      from: raid.state, to: change.to, endReason: patch.endReason === undefined ? null : patch.endReason,
      ...(change.to === S.SETTLED ? { loss: Array.isArray(change.loss) ? change.loss : [] } : {}) };
    const r = journal.applyOnce(tx, { key: S.transitionKey(raid.raidId, raid.phaseSeq),
      aggregate: { type: S.AGGREGATE, id: raid.raidId },
      eventType: change.to === S.SETTLED ? S.EVENT_SETTLED : S.EVENT_TRANSITION, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(raid.raidId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", raidId: raid.raidId };
      if (row.state !== raid.state) return { ok: false, reason: "STATE_MISMATCH", expected: raid.state,
        actual: row.state };
      if (row.version !== raid.version) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: raid.version, actualVersion: row.version };
      }
      const sql = `UPDATE ${S.TABLE_NAME} SET ${[...sets, "state = ?", "open = ?", "phase_seq = phase_seq + 1",
        "updated_at = ?", "version = version + 1"].join(", ")} WHERE raid_id = ? AND version = ?`;
      if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
      s.updates.get(sql).run(...values, change.to, toBind(closing ? 0 : 1), toBind(change.at), raid.raidId,
        toBind(raid.version));
      return { ok: true, raid: toRaid(s.byId.get(raid.raidId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(raid.raidId);
      return { ok: true, duplicate: true, raid: row ? toRaid(row) : null };
    }
    return { ok: true, duplicate: false, raid: r.value.raid };
  }

  function pruneEnded(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || !isTime(opts.before) || !isCount(opts.limit)) return invalid("prune");
    if (opts.limit === 0) return { ok: true, deleted: 0 };
    const s = stmts(tx);
    const victims = s.pruneIds.all(toBind(opts.before), toBind(opts.limit)).map((r) => r.raid_id);
    for (const id of victims) s.deleteRaid.run(id);
    return { ok: true, deleted: victims.length };
  }

  function countOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const f = opts && opts.attackerFactionId !== undefined ? opts.attackerFactionId : null;
    if (f !== null && !isId(f)) return invalid("attackerFactionId");
    const s = stmts(tx);
    const row = f !== null ? s.countFaction.get(toBind(f)) : s.countAll.get();
    return { ok: true, count: Number(row.n) };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));
  const kindOk = (kind) => S.TARGET_KINDS.includes(kind);

  return Object.freeze({
    createRaid,
    sample,
    transition,
    pruneEnded,
    countOpen,
    getRaid: (tx, raidId) => read(tx, (s) => {
      if (!isText(raidId, S.MAX_ID_LENGTH)) return invalid("raidId");
      const row = s.byId.get(raidId);
      return { ok: true, raid: row ? toRaid(row) : null };
    }),
    getOpenByTarget: (tx, kind, targetId) => read(tx, (s) => {
      if (!kindOk(kind) || !isId(targetId)) return invalid("target");
      const row = s.openByTarget.get(kind, toBind(targetId));
      return { ok: true, raid: row ? toRaid(row) : null };
    }),
    getLastByTarget: (tx, kind, targetId) => read(tx, (s) => {
      if (!kindOk(kind) || !isId(targetId)) return invalid("target");
      const row = s.lastByTarget.get(kind, toBind(targetId));
      return { ok: true, raid: row ? toRaid(row) : null };
    }),
    getLastOwnerStart: (tx, ownerCorpId) => read(tx, (s) => {
      if (!isId(ownerCorpId)) return invalid("ownerCorpId");
      const row = s.lastOwnerStart.get(toBind(ownerCorpId));
      return { ok: true, startedAt: row && row.t !== null && row.t !== undefined ? Number(row.t) : null };
    }),
    listOpen: (tx, opts) => read(tx, (s) => {
      const limit = opts && isCount(opts.limit) ? opts.limit : 0;
      const after = opts && typeof opts.afterRaidId === "string" ? opts.afterRaidId : "";
      const rows = s.listOpen.all(after, toBind(limit + 1));
      return { ok: true, raids: rows.slice(0, limit).map(toRaid), truncated: rows.length > limit };
    }),
  });
}

module.exports = { createHarvestRaidRepository, toRaid };
