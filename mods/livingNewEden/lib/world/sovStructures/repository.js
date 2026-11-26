"use strict";

const { toBind } = require("../../persistence/repository");
const S = require("./schema");
const { canTransitionSov } = require("./machine");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const txMissing = (db) => !db || db.inTransaction !== true;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const failed = (err) => ({ ok: false, reason: "SOV_SQL_FAILED",
  detail: String((err && err.message) || err).slice(0, 120) });
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const bindOrNull = (v) => (v === null || v === undefined ? null : toBind(v));

function toStructure(row) {
  return Object.freeze({
    structureId: row.structure_id, systemId: Number(row.system_id), factionId: Number(row.faction_id),
    origin: row.origin, state: row.state, endReason: row.end_reason, claimSeq: numOrNull(row.claim_seq),
    attempt: Number(row.attempt), claimCapturedAt: numOrNull(row.claim_captured_at), costIsk: Number(row.cost_isk),
    dueAt: numOrNull(row.due_at), onlineAt: numOrNull(row.online_at),
    attackerFactionId: numOrNull(row.attacker_faction_id), attackStartedAt: numOrNull(row.attack_started_at),
    endedAt: numOrNull(row.ended_at), endedByFactionId: numOrNull(row.ended_by_faction_id),
    evejsItemId: numOrNull(row.evejs_item_id), physicalAt: numOrNull(row.physical_at), version: Number(row.version),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  });
}

function createSovStructureRepository() {
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE_NAME;
    const L = S.LIVE_SQL;
    s = {
      byId: db.prepare(`SELECT * FROM ${T} WHERE structure_id = ?`),
      liveInSystem: db.prepare(`SELECT * FROM ${T} WHERE system_id = ? AND state IN ${L} ORDER BY structure_id`),
      attempts: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE system_id = ? AND faction_id = ? AND claim_seq = ?`),
      anchoringOfFaction: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ? AND state IN ${L}
        AND state = 'ANCHORING'`),
      live: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state IN ${L}`),
      anchoringPage: db.prepare(`SELECT * FROM ${T} WHERE state IN ${L} AND state = 'ANCHORING' AND structure_id > ?
        ORDER BY structure_id LIMIT ?`),
      insertAnchoring: db.prepare(`INSERT INTO ${T} (structure_id, system_id, faction_id, origin, state, end_reason,
        claim_seq, attempt, claim_captured_at, cost_isk, due_at, online_at, attacker_faction_id, attack_started_at,
        ended_at, ended_by_faction_id, evejs_item_id, physical_at, version, created_at, updated_at)
        VALUES (?, ?, ?, 'ANCHORED', 'ANCHORING', NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        ?, ?)`),
      toOnline: db.prepare(`UPDATE ${T} SET state = 'ONLINE', online_at = ?, updated_at = ?, version = version + 1
        WHERE structure_id = ? AND version = ? AND state = 'ANCHORING'`),
      toEnd: db.prepare(`UPDATE ${T} SET state = ?, end_reason = ?, ended_at = ?, ended_by_faction_id = ?,
        updated_at = ?, version = version + 1 WHERE structure_id = ? AND version = ? AND state = ?`),
      bind: db.prepare(`UPDATE ${T} SET claim_captured_at = ?, updated_at = ?, version = version + 1
        WHERE structure_id = ? AND version = ? AND state = 'ONLINE'`),
      siege: db.prepare(`UPDATE ${T} SET attacker_faction_id = ?, attack_started_at = ?, updated_at = ?,
        version = version + 1 WHERE structure_id = ? AND version = ? AND state IN ${L}`),
      controlPage: db.prepare(`SELECT t.*, s.controller_faction_id AS sys_controller,
        s.occupation_state AS sys_state, s.occupier_faction_id AS sys_occupier
        FROM ${T} t LEFT JOIN world_system_state s ON s.system_id = t.system_id
        WHERE t.state IN ${L} AND t.structure_id > ? ORDER BY t.structure_id LIMIT ?`),
      healPage: db.prepare(`SELECT t.* FROM ${T} t JOIN world_system_state s ON s.system_id = t.system_id
        WHERE t.state = 'DESTROYED' AND t.end_reason IN ('SIEGE','LIVE_KILL') AND t.structure_id > ?
          AND s.controller_faction_id = t.faction_id AND s.captured_at = t.claim_captured_at
        ORDER BY t.structure_id LIMIT ?`),
      adoptPage: db.prepare(`SELECT s.system_id, s.controller_faction_id, s.captured_at FROM world_system_state s
        WHERE s.captured_at IS NOT NULL AND s.controller_faction_id IS NOT NULL AND s.system_id > ?
          AND NOT EXISTS (SELECT 1 FROM ${T} t WHERE t.system_id = s.system_id AND t.state IN ${L})
          AND NOT EXISTS (SELECT 1 FROM ${T} u WHERE u.system_id = s.system_id
                            AND u.faction_id = s.controller_faction_id AND u.claim_captured_at = s.captured_at)
        ORDER BY s.system_id LIMIT ?`),
      adoptPendingOf: db.prepare(`SELECT s.controller_faction_id FROM world_system_state s
        WHERE s.system_id = ? AND s.captured_at IS NOT NULL AND s.controller_faction_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${T} t WHERE t.system_id = s.system_id AND t.state IN ${L})
          AND NOT EXISTS (SELECT 1 FROM ${T} u WHERE u.system_id = s.system_id
                            AND u.faction_id = s.controller_faction_id AND u.claim_captured_at = s.captured_at)`),
      insertGrandfathered: db.prepare(`INSERT OR IGNORE INTO ${T} (structure_id, system_id, faction_id, origin, state,
        end_reason, claim_seq, attempt, claim_captured_at, cost_isk, due_at, online_at, attacker_faction_id,
        attack_started_at, ended_at, ended_by_faction_id, evejs_item_id, physical_at, version, created_at, updated_at)
        VALUES (?, ?, ?, 'GRANDFATHERED', 'ONLINE', NULL, NULL, 1, ?, 0, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        ?, ?)`),
      prunePage: db.prepare(`SELECT t.rowid AS rid FROM ${T} t
        WHERE t.state IN ('DESTROYED','ENDED') AND t.updated_at < ? AND t.rowid > ? AND t.evejs_item_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM world_system_state s WHERE s.system_id = t.system_id
                            AND s.controller_faction_id = t.faction_id AND s.captured_at = t.claim_captured_at)
        ORDER BY t.rowid LIMIT ?`),
      pruneRow: db.prepare(`DELETE FROM ${T} WHERE rowid = ? AND state IN ('DESTROYED','ENDED')`),
      panel: db.prepare(`SELECT * FROM ${T} WHERE (? IS NULL OR system_id = ?)
        ORDER BY (state IN ${L}) DESC, updated_at DESC, structure_id LIMIT ?`),
      physicalPage: db.prepare(`SELECT * FROM ${T} WHERE evejs_item_id IS NOT NULL ORDER BY structure_id LIMIT ?`),
      physicalCount: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE evejs_item_id IS NOT NULL`),
      recordPhysical: db.prepare(`UPDATE ${T} SET evejs_item_id = ?, physical_at = ?
        WHERE structure_id = ? AND evejs_item_id IS ?`),
    };
    cache.set(db, s);
    return s;
  }

  function getById(db, structureId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isText(structureId, S.MAX_ID_LENGTH)) return invalid("structureId");
    try {
      const row = stmts(db).byId.get(structureId);
      return { ok: true, structure: row ? toStructure(row) : null };
    } catch (err) {
      return failed(err);
    }
  }

  function listLiveInSystem(db, systemId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    try {
      return { ok: true, structures: stmts(db).liveInSystem.all(toBind(systemId)).map(toStructure) };
    } catch (err) {
      return failed(err);
    }
  }

  function countAttempts(db, systemId, factionId, claimSeq) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(systemId) || !isId(factionId) || !isCount(claimSeq)) return invalid("attempts");
    try {
      const r = stmts(db).attempts.get(toBind(systemId), toBind(factionId), toBind(claimSeq));
      return { ok: true, count: Number(r.n) };
    } catch (err) {
      return failed(err);
    }
  }

  function countLimits(db, factionId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    try {
      const s = stmts(db);
      return { ok: true, anchoringOfFaction: Number(s.anchoringOfFaction.get(toBind(factionId)).n),
        live: Number(s.live.get().n) };
    } catch (err) {
      return failed(err);
    }
  }

  function countLive(db) {
    if (txMissing(db)) return TX_REQUIRED;
    try {
      return { ok: true, live: Number(stmts(db).live.get().n) };
    } catch (err) {
      return failed(err);
    }
  }

  function listAnchoringPage(db, afterId, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (typeof afterId !== "string" || !(Number.isSafeInteger(limit) && limit > 0)) return invalid("page");
    try {
      return { ok: true, structures: stmts(db).anchoringPage.all(afterId, toBind(limit)).map(toStructure) };
    } catch (err) {
      return failed(err);
    }
  }

  function insertAnchoring(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const p = spec || {};
    if (!isText(p.structureId, S.MAX_ID_LENGTH) || !isId(p.systemId) || !isId(p.factionId) || !isCount(p.claimSeq)
      || !isId(p.attempt) || !isCount(p.costIsk) || !isTime(p.dueAt) || !isTime(p.at)) return invalid("spec");
    try {
      const s = stmts(db);
      s.insertAnchoring.run(p.structureId, toBind(p.systemId), toBind(p.factionId), toBind(p.claimSeq),
        toBind(p.attempt), toBind(p.costIsk), toBind(p.dueAt), toBind(p.at), toBind(p.at));
      return { ok: true, structure: toStructure(s.byId.get(p.structureId)) };
    } catch (err) {
      return failed(err);
    }
  }

  function transition(db, change) {
    if (txMissing(db)) return TX_REQUIRED;
    const c = change || {};
    const st = c.structure;
    if (!st || !isText(st.structureId, S.MAX_ID_LENGTH) || !isId(st.version) || !isTime(c.at)) return invalid("change");
    const edge = canTransitionSov(st.state, c.to);
    if (!edge.ok) return edge;
    const terminal = S.TERMINAL_STATES.includes(c.to);
    if (terminal && !S.END_REASONS.includes(c.reason)) return invalid("reason");
    if (terminal && c.byFactionId !== undefined && c.byFactionId !== null && !isId(c.byFactionId)) {
      return invalid("byFactionId");
    }
    try {
      const s = stmts(db);
      const r = terminal
        ? s.toEnd.run(c.to, c.reason, toBind(c.at), bindOrNull(c.byFactionId), toBind(c.at), st.structureId,
          toBind(st.version), st.state)
        : s.toOnline.run(toBind(c.at), toBind(c.at), st.structureId, toBind(st.version));
      if (Number(r.changes) !== 1) return { ok: false, reason: "VERSION_CONFLICT", structureId: st.structureId };
      return { ok: true, structure: toStructure(s.byId.get(st.structureId)) };
    } catch (err) {
      return failed(err);
    }
  }

  function bindCapture(db, structure, capturedAt, at) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!structure || !isText(structure.structureId, S.MAX_ID_LENGTH) || !isId(structure.version)
      || !isTime(capturedAt) || !isTime(at)) return invalid("bind");
    try {
      const s = stmts(db);
      const r = s.bind.run(toBind(capturedAt), toBind(at), structure.structureId, toBind(structure.version));
      if (Number(r.changes) !== 1) return { ok: false, reason: "VERSION_CONFLICT", structureId: structure.structureId };
      return { ok: true, structure: toStructure(s.byId.get(structure.structureId)) };
    } catch (err) {
      return failed(err);
    }
  }

  function setSiege(db, structure, attackerFactionId, at) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!structure || !isText(structure.structureId, S.MAX_ID_LENGTH) || !isId(structure.version) || !isTime(at)
      || (attackerFactionId !== null && !isId(attackerFactionId))) return invalid("siege");
    try {
      const s = stmts(db);
      const r = s.siege.run(bindOrNull(attackerFactionId), attackerFactionId === null ? null : toBind(at), toBind(at),
        structure.structureId, toBind(structure.version));
      if (Number(r.changes) !== 1) return { ok: false, reason: "VERSION_CONFLICT", structureId: structure.structureId };
      return { ok: true, structure: toStructure(s.byId.get(structure.structureId)) };
    } catch (err) {
      return failed(err);
    }
  }

  function listControlPage(db, afterId, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (typeof afterId !== "string" || !(Number.isSafeInteger(limit) && limit > 0)) return invalid("page");
    try {
      const rows = stmts(db).controlPage.all(afterId, toBind(limit));
      return { ok: true, rows: rows.map((row) => Object.freeze({ structure: toStructure(row),
        claim: Object.freeze({ controllerFactionId: numOrNull(row.sys_controller), state: row.sys_state || null,
          occupierFactionId: numOrNull(row.sys_occupier) }) })) };
    } catch (err) {
      return failed(err);
    }
  }

  function listHealPage(db, afterId, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (typeof afterId !== "string" || !(Number.isSafeInteger(limit) && limit > 0)) return invalid("page");
    try {
      return { ok: true, structures: stmts(db).healPage.all(afterId, toBind(limit)).map(toStructure) };
    } catch (err) {
      return failed(err);
    }
  }

  function listAdoptPage(db, afterSystemId, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isCount(afterSystemId) || !(Number.isSafeInteger(limit) && limit > 0)) return invalid("page");
    try {
      const rows = stmts(db).adoptPage.all(toBind(afterSystemId), toBind(limit));
      return { ok: true, systems: rows.map((r) => Object.freeze({ systemId: Number(r.system_id),
        factionId: Number(r.controller_faction_id), capturedAt: Number(r.captured_at) })) };
    } catch (err) {
      return failed(err);
    }
  }

  function adoptPendingOf(db, systemId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    try {
      const r = stmts(db).adoptPendingOf.get(toBind(systemId));
      return { ok: true, factionId: r ? Number(r.controller_faction_id) : null };
    } catch (err) {
      return failed(err);
    }
  }

  function insertGrandfathered(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const p = spec || {};
    if (!isId(p.systemId) || !isId(p.factionId) || !isTime(p.capturedAt) || !isTime(p.at)) return invalid("spec");
    const structureId = S.grandfatheredIdOf(p.systemId, p.factionId, p.capturedAt);
    if (!isText(structureId, S.MAX_ID_LENGTH)) return invalid("structureId");
    try {
      const r = stmts(db).insertGrandfathered.run(structureId, toBind(p.systemId), toBind(p.factionId),
        toBind(p.capturedAt), toBind(p.at), toBind(p.at), toBind(p.at));
      return { ok: true, inserted: Number(r.changes) === 1, structureId };
    } catch (err) {
      return failed(err);
    }
  }

  function pruneTerminal(db, before, afterRowId, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isTime(before) || !isCount(afterRowId) || !(Number.isSafeInteger(limit) && limit > 0)) return invalid("prune");
    try {
      const s = stmts(db);
      const ids = s.prunePage.all(toBind(before), toBind(afterRowId), toBind(limit)).map((r) => Number(r.rid));
      let deleted = 0;
      for (const rid of ids) deleted += Number(s.pruneRow.run(toBind(rid)).changes);
      return { ok: true, read: ids.length, deleted, lastRowId: ids.length > 0 ? ids[ids.length - 1] : afterRowId };
    } catch (err) {
      return failed(err);
    }
  }

  function listForPanel(db, systemId, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if ((systemId !== null && !isId(systemId)) || !(Number.isSafeInteger(limit) && limit > 0)) return invalid("panel");
    try {
      const sys = systemId === null ? null : toBind(systemId);
      const rows = stmts(db).panel.all(sys, sys, toBind(limit + 1));
      return { ok: true, structures: rows.slice(0, limit).map(toStructure), truncated: rows.length > limit };
    } catch (err) {
      return failed(err);
    }
  }

  function listPhysical(db, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!(Number.isSafeInteger(limit) && limit > 0)) return invalid("limit");
    try {
      const s = stmts(db);
      return { ok: true, structures: s.physicalPage.all(toBind(limit)).map(toStructure),
        count: Number(s.physicalCount.get().n) };
    } catch (err) {
      return failed(err);
    }
  }

  function recordPhysical(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const p = spec || {};
    if (!isText(p.structureId, S.MAX_ID_LENGTH) || (p.expectedItemId !== null && !isId(p.expectedItemId))
      || (p.itemId !== null && !isId(p.itemId)) || !isTime(p.at)) return invalid("physical");
    try {
      const r = stmts(db).recordPhysical.run(bindOrNull(p.itemId), p.itemId === null ? null : toBind(p.at),
        p.structureId, bindOrNull(p.expectedItemId));
      return { ok: true, changed: Number(r.changes) === 1 };
    } catch (err) {
      return failed(err);
    }
  }

  return Object.freeze({ getById, listLiveInSystem, countAttempts, countLimits, countLive, listAnchoringPage,
    insertAnchoring, transition, bindCapture, setSiege, listControlPage, listHealPage, listAdoptPage,
    adoptPendingOf, insertGrandfathered, pruneTerminal, listForPanel, listPhysical, recordPhysical });
}

module.exports = { createSovStructureRepository, toStructure };
