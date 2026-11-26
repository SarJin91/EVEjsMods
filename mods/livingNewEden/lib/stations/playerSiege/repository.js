"use strict";

const { KIND_APPLY } = require("../../persistence/journal");
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
  phaseSeq: ["phase_seq", isCount],
  waitRound: ["wait_round", isCount],
  phaseStartedAt: ["phase_started_at", isTime],
  phaseEndsAt: ["phase_ends_at", isTime],
  vendorState: ["vendor_state", nullOr((v) => isText(v, S.MAX_VENDOR_STATE_LENGTH))],
  vendorEndsAt: ["vendor_ends_at", nullOr(isTime)],
  attackerShips: ["attacker_ships", isCount],
  attackerStrength: ["attacker_strength", isCount],
  hits: ["hits", isCount],
  endedAt: ["ended_at", nullOr(isTime)],
  endReason: ["end_reason", nullOr((v) => isText(v, S.MAX_END_REASON_LENGTH))],
});

const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;

function toSiege(row) {
  return Object.freeze({
    siegeId: row.siege_id, idempotencyKey: row.idempotency_key, structureId: row.structure_id, siegeNo: row.siege_no,
    systemId: row.system_id, structureTypeId: row.structure_type_id, structureFamily: row.structure_family,
    ownerCorpId: row.owner_corp_id, ownerAllianceId: row.owner_alliance_id,
    attackerFactionId: row.attacker_faction_id, state: row.state, open: row.open === 1, phaseSeq: row.phase_seq,
    waitRound: row.wait_round, phaseStartedAt: row.phase_started_at, phaseEndsAt: row.phase_ends_at,
    vendorState: row.vendor_state, vendorEndsAt: row.vendor_ends_at, attackerShips: row.attacker_ships,
    attackerStrength: row.attacker_strength, hits: row.hits, startedAt: row.started_at, endedAt: row.ended_at,
    endReason: row.end_reason, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
  });
}

function createPlayerSiegeRepository(deps) {
  const journal = deps && deps.journal;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("playerSiegeRepository: journal");
  }
  const ids = deps.ids;
  if (!ids || typeof ids.next !== "function") throw new TypeError("playerSiegeRepository: ids");
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE_NAME;
    s = {
      updates: new Map(),
      byId: db.prepare(`SELECT * FROM ${T} WHERE siege_id = ?`),
      openByStructure: db.prepare(`SELECT * FROM ${T} WHERE structure_id = ? AND open = 1`),
      lastByStructure: db.prepare(`SELECT * FROM ${T} WHERE structure_id = ? ORDER BY siege_no DESC LIMIT 1`),
      maxNo: db.prepare(`SELECT coalesce(max(siege_no), 0) AS n FROM ${T} WHERE structure_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (siege_id, idempotency_key, structure_id, siege_no, system_id,
        structure_type_id, structure_family, owner_corp_id, owner_alliance_id, attacker_faction_id, state, open,
        phase_seq, wait_round, phase_started_at, phase_ends_at, vendor_state, vendor_ends_at, attacker_ships,
        attacker_strength, hits, started_at, ended_at, end_reason, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, 1)`),
      wait: db.prepare(`UPDATE ${T} SET wait_round = ?, phase_ends_at = ?, updated_at = ?, version = version + 1
        WHERE siege_id = ? AND version = ?`),
      listOpen: db.prepare(`SELECT * FROM ${T} WHERE open = 1 AND siege_id > ? ORDER BY siege_id LIMIT ?`),
      openInSystem: db.prepare(`SELECT * FROM ${T} WHERE system_id = ? AND open = 1 ORDER BY siege_id`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE open = 1`),
      countAttacker: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE attacker_faction_id = ? AND open = 1`),
      countOwner: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE owner_corp_id = ? AND open = 1`),
      pruneIds: db.prepare(`SELECT siege_id FROM ${T} AS a WHERE ended_at IS NOT NULL AND ended_at < ?
        AND EXISTS (SELECT 1 FROM ${T} AS b WHERE b.structure_id = a.structure_id AND b.siege_no > a.siege_no)
        ORDER BY ended_at, siege_id LIMIT ?`),
      deleteSiege: db.prepare(`DELETE FROM ${T} WHERE siege_id = ?`),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function validStart(spec) {
    return Boolean(spec && isId(spec.structureId) && isId(spec.siegeNo) && isId(spec.systemId)
      && isId(spec.structureTypeId) && isText(spec.structureFamily, S.MAX_FAMILY_LENGTH) && isId(spec.ownerCorpId)
      && (spec.ownerAllianceId === null || isId(spec.ownerAllianceId)) && isId(spec.attackerFactionId)
      && S.OPEN_STATES.includes(spec.state) && isTime(spec.at) && isTime(spec.phaseEndsAt)
      && spec.phaseEndsAt >= spec.at && isCount(spec.attackerShips) && isCount(spec.attackerStrength)
      && (spec.vendorState === null || isText(spec.vendorState, S.MAX_VENDOR_STATE_LENGTH))
      && (spec.vendorEndsAt === null || isTime(spec.vendorEndsAt)));
  }

  function createSiege(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(key, S.MAX_KEY_LENGTH)) return invalid("key");
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    if (found.found) {
      if (found.entry.kind === KIND_APPLY && found.entry.aggregateType === S.AGGREGATE) {
        return { ok: true, siegeId: found.entry.aggregateId, duplicate: true };
      }
      return { ok: false, reason: "IDEMPOTENCY_CONFLICT", detail: key };
    }
    if (!validStart(spec)) return invalid("spec");
    const siegeId = ids.next("ps");
    const payload = { siegeId, systemId: spec.systemId, structureId: spec.structureId,
      structureTypeId: spec.structureTypeId, ownerCorpId: spec.ownerCorpId, attackerFactionId: spec.attackerFactionId,
      state: spec.state, phaseEndsAt: spec.phaseEndsAt };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: siegeId },
      eventType: S.EVENT_STARTED, payload }, (db) => {
      const s = stmts(db);
      if (s.openByStructure.get(toBind(spec.structureId))) {
        return { ok: false, reason: "SIEGE_OPEN", structureId: spec.structureId };
      }
      s.insert.run(siegeId, key, toBind(spec.structureId), toBind(spec.siegeNo), toBind(spec.systemId),
        toBind(spec.structureTypeId), spec.structureFamily, toBind(spec.ownerCorpId),
        spec.ownerAllianceId === null ? null : toBind(spec.ownerAllianceId), toBind(spec.attackerFactionId),
        spec.state, toBind(spec.at), toBind(spec.phaseEndsAt), spec.vendorState,
        spec.vendorEndsAt === null ? null : toBind(spec.vendorEndsAt), toBind(spec.attackerShips),
        toBind(spec.attackerStrength), toBind(spec.at), toBind(spec.at), toBind(spec.at));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    return { ok: true, siegeId, duplicate: r.duplicate === true };
  }

  function transition(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(key, S.MAX_KEY_LENGTH + 64)) return invalid("key");
    const siege = change && change.siege;
    if (!siege || !isText(siege.siegeId, S.MAX_ID_LENGTH) || !isId(siege.version)) return invalid("siege");
    if (!isTime(change.at)) return invalid("at");
    const edge = canTransition(siege.state, change.to);
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
    const payload = { siegeId: siege.siegeId, systemId: siege.systemId, structureId: siege.structureId,
      structureTypeId: siege.structureTypeId, ownerCorpId: siege.ownerCorpId,
      attackerFactionId: siege.attackerFactionId, from: siege.state, to: change.to,
      endReason: patch.endReason === undefined ? null : patch.endReason,
      vendorState: patch.vendorState === undefined ? null : patch.vendorState,
      vendorEndsAt: patch.vendorEndsAt === undefined ? null : patch.vendorEndsAt };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: siege.siegeId },
      eventType: S.EVENT_TRANSITION, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(siege.siegeId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", siegeId: siege.siegeId };
      if (row.state !== siege.state) return { ok: false, reason: "STATE_MISMATCH", expected: siege.state,
        actual: row.state };
      if (row.version !== siege.version) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: siege.version, actualVersion: row.version };
      }
      const sql = `UPDATE ${S.TABLE_NAME} SET ${[...sets, "state = ?", "open = ?", "updated_at = ?",
        "version = version + 1"].join(", ")} WHERE siege_id = ? AND version = ?`;
      if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
      s.updates.get(sql).run(...values, change.to, toBind(closing ? 0 : 1), toBind(change.at), siege.siegeId,
        toBind(siege.version));
      return { ok: true, siege: toSiege(s.byId.get(siege.siegeId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(siege.siegeId);
      return { ok: true, duplicate: true, siege: row ? toSiege(row) : null };
    }
    return { ok: true, duplicate: false, siege: r.value.siege };
  }

  function noteWait(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(key, S.MAX_KEY_LENGTH + 64)) return invalid("key");
    const siege = change && change.siege;
    if (!siege || !isText(siege.siegeId, S.MAX_ID_LENGTH) || !isId(siege.version) || !isCount(change.waitRound)
      || !isTime(change.dueAt) || change.dueAt < siege.phaseStartedAt || !isTime(change.at)) {
      return invalid("wait");
    }
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: siege.siegeId },
      eventType: S.EVENT_WAIT, payload: { siegeId: siege.siegeId, waitRound: change.waitRound, dueAt: change.dueAt,
        why: String(change.why || "") } }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(siege.siegeId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", siegeId: siege.siegeId };
      if (row.open !== 1) return { ok: false, reason: "STATE_MISMATCH", actual: row.state };
      if (row.version !== siege.version) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: siege.version, actualVersion: row.version };
      }
      s.wait.run(toBind(change.waitRound), toBind(change.dueAt), toBind(change.at), siege.siegeId,
        toBind(siege.version));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    return { ok: true, duplicate: r.duplicate === true };
  }

  function pruneEnded(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || !isTime(opts.before) || !isCount(opts.limit)) return invalid("prune");
    if (opts.limit === 0) return { ok: true, deleted: 0 };
    const s = stmts(tx);
    const victims = s.pruneIds.all(toBind(opts.before), toBind(opts.limit)).map((r) => r.siege_id);
    for (const id of victims) s.deleteSiege.run(id);
    return { ok: true, deleted: victims.length };
  }

  function countOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const f = opts && opts.attackerFactionId !== undefined ? opts.attackerFactionId : null;
    const c = opts && opts.ownerCorpId !== undefined ? opts.ownerCorpId : null;
    if (f !== null && !isId(f)) return invalid("attackerFactionId");
    if (c !== null && !isId(c)) return invalid("ownerCorpId");
    const s = stmts(tx);
    let row;
    if (f !== null) row = s.countAttacker.get(toBind(f));
    else if (c !== null) row = s.countOwner.get(toBind(c));
    else row = s.countAll.get();
    return { ok: true, count: row.n };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    createSiege,
    transition,
    noteWait,
    pruneEnded,
    countOpen,
    getSiege: (tx, siegeId) => read(tx, (s) => {
      if (!isText(siegeId, S.MAX_ID_LENGTH)) return invalid("siegeId");
      const row = s.byId.get(siegeId);
      return { ok: true, siege: row ? toSiege(row) : null };
    }),
    getOpenByStructure: (tx, structureId) => read(tx, (s) => {
      if (!isId(structureId)) return invalid("structureId");
      const row = s.openByStructure.get(toBind(structureId));
      return { ok: true, siege: row ? toSiege(row) : null };
    }),
    getLastByStructure: (tx, structureId) => read(tx, (s) => {
      if (!isId(structureId)) return invalid("structureId");
      const row = s.lastByStructure.get(toBind(structureId));
      return { ok: true, siege: row ? toSiege(row) : null };
    }),
    nextSiegeNo: (tx, structureId) => read(tx, (s) => {
      if (!isId(structureId)) return invalid("structureId");
      return { ok: true, siegeNo: s.maxNo.get(toBind(structureId)).n + 1 };
    }),
    listOpen: (tx, opts) => read(tx, (s) => {
      const limit = opts && isCount(opts.limit) ? opts.limit : 0;
      const after = opts && typeof opts.afterSiegeId === "string" ? opts.afterSiegeId : "";
      const rows = s.listOpen.all(after, toBind(limit + 1));
      return { ok: true, sieges: rows.slice(0, limit).map(toSiege), truncated: rows.length > limit };
    }),
    listOpenInSystem: (tx, systemId) => read(tx, (s) => {
      if (!isId(systemId)) return invalid("systemId");
      return { ok: true, sieges: s.openInSystem.all(toBind(systemId)).map(toSiege) };
    }),
  });
}

module.exports = { createPlayerSiegeRepository, toSiege };
