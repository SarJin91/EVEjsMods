"use strict";

const { toBind } = require("../persistence/repository");
const S = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const LIVE_SQL = "('ACTIVE','PENDING_DEPLOY')";
const ENDED_SQL = "('CANCELLED','DESTROYED','RETIRED')";

function toSentry(row) {
  return Object.freeze({
    sentryId: row.sentry_id, ownerKind: row.owner_kind, factionId: row.faction_id, ownerCorpId: row.owner_corp_id,
    characterId: row.anchored_by_character_id, itemId: row.item_id, typeId: row.type_id, systemId: row.system_id,
    anchorKind: row.anchor_kind, anchorId: row.anchor_id, slot: row.slot, state: row.state, armedAt: row.armed_at,
    costIsk: row.cost_isk, ammoGrants: row.ammo_grants, endReason: row.end_reason, createdAt: row.created_at,
    updatedAt: row.updated_at, endedAt: row.ended_at, version: row.version,
  });
}

function createSentryRepository(deps) {
  const journal = deps && deps.journal;
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("sentryRepository: journal");
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE_NAME;
    s = {
      byId: db.prepare(`SELECT * FROM ${T} WHERE sentry_id = ?`),
      byItem: db.prepare(`SELECT * FROM ${T} WHERE item_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (sentry_id, owner_kind, faction_id, owner_corp_id, anchored_by_character_id,
        item_id, type_id, system_id, anchor_kind, anchor_id, slot, state, armed_at, cost_isk, ammo_grants, end_reason,
        created_at, updated_at, ended_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, NULL, ?, ?, NULL, 1)`),
      change: db.prepare(`UPDATE ${T} SET state = ?, end_reason = ?, ended_at = ?, armed_at = ?, system_id = ?,
        anchor_kind = ?, anchor_id = ?, owner_corp_id = ?, anchored_by_character_id = ?, updated_at = ?,
        version = version + 1 WHERE sentry_id = ? AND version = ?`),
      countAnchor: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE anchor_kind = ? AND anchor_id = ?
        AND state IN ${LIVE_SQL}`),
      countSystemOwner: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE system_id = ? AND owner_corp_id = ?
        AND state IN ${LIVE_SQL}`),
      countOwner: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE owner_corp_id = ? AND state IN ${LIVE_SQL}`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state IN ${LIVE_SQL}`),
      systemOwnerByType: db.prepare(`SELECT type_id, count(*) AS n FROM ${T} WHERE system_id = ? AND owner_corp_id = ?
        AND state IN ${LIVE_SQL} GROUP BY type_id`),
      ownerByType: db.prepare(`SELECT type_id, count(*) AS n FROM ${T} WHERE owner_corp_id = ? AND state IN ${LIVE_SQL}
        GROUP BY type_id`),
      systemByType: db.prepare(`SELECT type_id, count(*) AS n FROM ${T} WHERE system_id = ? AND state IN ${LIVE_SQL}
        GROUP BY type_id`),
      listActive: db.prepare(`SELECT * FROM ${T} WHERE state = 'ACTIVE' AND sentry_id > ? ORDER BY sentry_id
        LIMIT ?`),
      pruneIds: db.prepare(`SELECT sentry_id FROM ${T} WHERE state IN ${ENDED_SQL} AND ended_at < ?
        ORDER BY ended_at, sentry_id LIMIT ?`),
      deleteRow: db.prepare(`DELETE FROM ${T} WHERE sentry_id = ?`),
      insertPending: db.prepare(`INSERT INTO ${T} (sentry_id, owner_kind, faction_id, owner_corp_id,
        anchored_by_character_id, item_id, type_id, system_id, anchor_kind, anchor_id, slot, state, armed_at, cost_isk,
        ammo_grants, end_reason, created_at, updated_at, ended_at, version)
        VALUES (?, 'faction', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'PENDING_DEPLOY', NULL, ?, 0, NULL, ?, ?, NULL, 1)`),
      activate: db.prepare(`UPDATE ${T} SET state = 'ACTIVE', item_id = ?, armed_at = ?, ammo_grants = ?,
        updated_at = ?, version = version + 1 WHERE sentry_id = ? AND version = ? AND state = 'PENDING_DEPLOY'`),
      ammo: db.prepare(`UPDATE ${T} SET ammo_grants = ammo_grants + 1, updated_at = ?, version = version + 1
        WHERE sentry_id = ? AND version = ? AND state = 'ACTIVE'`),
      countFaction: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ? AND state IN ${LIVE_SQL}`),
      countFactionSystem: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ? AND system_id = ?
        AND state IN ${LIVE_SQL}`),
      slotsOnAnchor: db.prepare(`SELECT slot FROM ${T} WHERE anchor_kind = ? AND anchor_id = ? AND state IN ${LIVE_SQL}
        ORDER BY slot`),
      listFaction: db.prepare(`SELECT * FROM ${T} WHERE faction_id = ? AND state IN ${LIVE_SQL} ORDER BY sentry_id
        LIMIT ?`),
      anchorsInSystem: db.prepare(`SELECT anchor_kind, anchor_id, count(*) AS n FROM ${T} WHERE system_id = ?
        AND state IN ${LIVE_SQL} GROUP BY anchor_kind, anchor_id`),
      listLive: db.prepare(`SELECT * FROM ${T} WHERE state IN ${LIVE_SQL} ORDER BY system_id, sentry_id LIMIT ?`),
      listLiveInSystem: db.prepare(`SELECT * FROM ${T} WHERE system_id = ? AND state IN ${LIVE_SQL}
        ORDER BY sentry_id LIMIT ?`),
      liveBySystem: db.prepare(`SELECT system_id, count(*) AS n FROM ${T} WHERE state IN ${LIVE_SQL}
        GROUP BY system_id ORDER BY system_id LIMIT ?`),
      freeSystemOwner: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE anchor_kind = 'space' AND system_id = ?
        AND owner_corp_id = ? AND state IN ${LIVE_SQL}`),
      freeOwner: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE anchor_kind = 'space' AND owner_corp_id = ?
        AND state IN ${LIVE_SQL}`),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);
  const bindOrNull = (v) => (v === null || v === undefined ? null : toBind(v));

  function validInsert(spec) {
    return Boolean(spec && isText(spec.sentryId, S.MAX_ID_LENGTH) && S.OWNER_KINDS.includes(spec.ownerKind)
      && (spec.factionId === null || isId(spec.factionId)) && isId(spec.ownerCorpId)
      && (spec.characterId === null || isId(spec.characterId)) && isId(spec.itemId) && isId(spec.typeId)
      && isId(spec.systemId) && S.ANCHOR_KINDS.includes(spec.anchorKind) && isId(spec.anchorId)
      && isTime(spec.armedAt) && isTime(spec.at));
  }

  function insertActive(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!validInsert(spec)) return invalid("spec");
    const key = S.insertKey(spec.sentryId, spec.at);
    const payload = spec.adopted === true ? { sentryId: spec.sentryId, itemId: spec.itemId }
      : { sentryId: spec.sentryId, itemId: spec.itemId, systemId: spec.systemId, anchorKind: spec.anchorKind,
        anchorId: spec.anchorId, ownerCorpId: spec.ownerCorpId, characterId: spec.characterId };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: spec.sentryId },
      eventType: spec.adopted === true ? S.EVENT_ADOPTED : S.EVENT_ANCHORED, payload }, (db) => {
      const s = stmts(db);
      if (s.byItem.get(toBind(spec.itemId))) return { ok: false, reason: "ITEM_HAS_ROW", itemId: spec.itemId };
      if (s.byId.get(spec.sentryId)) return { ok: false, reason: "SENTRY_EXISTS", sentryId: spec.sentryId };
      s.insert.run(spec.sentryId, spec.ownerKind, bindOrNull(spec.factionId), toBind(spec.ownerCorpId),
        bindOrNull(spec.characterId), toBind(spec.itemId), toBind(spec.typeId), toBind(spec.systemId),
        spec.anchorKind, toBind(spec.anchorId), S.ACTIVE, toBind(spec.armedAt), toBind(spec.at), toBind(spec.at));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    const row = stmts(tx).byId.get(spec.sentryId);
    return { ok: true, duplicate: r.duplicate === true, sentry: row ? toSentry(row) : null };
  }

  function transition(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const sentry = change && change.sentry;
    if (!sentry || !isText(sentry.sentryId, S.MAX_ID_LENGTH) || !isId(sentry.version) || !isTime(sentry.createdAt)) {
      return invalid("sentry");
    }
    if (!isTime(change.at) || !isText(change.reason, 32)) return invalid("change");
    const edges = S.TRANSITIONS[sentry.state];
    if (!edges || !edges.includes(change.to)) {
      return { ok: false, reason: "TRANSITION_INVALID", from: sentry.state, to: change.to };
    }
    const ending = S.END_STATES.includes(change.to);
    const p = change.placement || null;
    if (!ending && (!isTime(change.armedAt) || !p || !isId(p.systemId) || !S.ANCHOR_KINDS.includes(p.anchorKind)
      || !isId(p.anchorId) || !isId(p.ownerCorpId) || !(p.characterId === null || isId(p.characterId)))) {
      return invalid("placement");
    }
    if (ending && !S.END_REASONS.includes(change.reason)) return invalid("reason");
    const key = S.stateKey(sentry.sentryId, sentry.createdAt, sentry.version);
    const payload = { sentryId: sentry.sentryId, from: sentry.state, to: change.to, reason: change.reason };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: sentry.sentryId },
      eventType: S.EVENT_STATE, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(sentry.sentryId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", sentryId: sentry.sentryId };
      if (row.version !== sentry.version) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: sentry.version, actualVersion: row.version };
      }
      if (row.state !== sentry.state) return { ok: false, reason: "STATE_MISMATCH", actual: row.state };
      if (ending) {
        s.change.run(change.to, change.reason, toBind(change.at), row.armed_at, row.system_id, row.anchor_kind,
          row.anchor_id, row.owner_corp_id, row.anchored_by_character_id, toBind(change.at), sentry.sentryId,
          toBind(sentry.version));
      } else {
        s.change.run(change.to, null, null, toBind(change.armedAt), toBind(p.systemId), p.anchorKind,
          toBind(p.anchorId), toBind(p.ownerCorpId), bindOrNull(p.characterId), toBind(change.at), sentry.sentryId,
          toBind(sentry.version));
      }
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    const row = stmts(tx).byId.get(sentry.sentryId);
    return { ok: true, duplicate: r.duplicate === true, sentry: row ? toSentry(row) : null };
  }

  function pruneEnded(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || !isTime(opts.before) || !isCount(opts.limit)) return invalid("prune");
    if (opts.limit === 0) return { ok: true, deleted: 0 };
    const s = stmts(tx);
    const victims = s.pruneIds.all(toBind(opts.before), toBind(opts.limit)).map((r) => r.sentry_id);
    for (const id of victims) s.deleteRow.run(id);
    return { ok: true, deleted: victims.length };
  }

  function countLive(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!S.ANCHOR_KINDS.includes(o.anchorKind) || !isId(o.anchorId) || !isId(o.systemId) || !isId(o.ownerCorpId)) {
      return invalid("count");
    }
    if (o.typeIds !== undefined && (!Array.isArray(o.typeIds) || !o.typeIds.every(isId))) return invalid("typeIds");
    const s = stmts(tx);
    const base = { perAnchor: s.countAnchor.get(o.anchorKind, toBind(o.anchorId)).n, total: s.countAll.get().n };
    if (o.typeIds === undefined) {
      return { ok: true, counts: { perAnchor: base.perAnchor,
        perSystemOwner: s.countSystemOwner.get(toBind(o.systemId), toBind(o.ownerCorpId)).n,
        perOwner: s.countOwner.get(toBind(o.ownerCorpId)).n, total: base.total } };
    }
    const types = new Set(o.typeIds);
    const sum = (rows) => rows.reduce((n, r) => n + (types.has(Number(r.type_id)) ? Number(r.n) : 0), 0);
    return { ok: true, counts: { perAnchor: base.perAnchor,
      perSystemOwner: sum(s.systemOwnerByType.all(toBind(o.systemId), toBind(o.ownerCorpId))),
      perOwner: sum(s.ownerByType.all(toBind(o.ownerCorpId))),
      perSystem: sum(s.systemByType.all(toBind(o.systemId))), total: base.total } };
  }

  function countFreeLive(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!isId(o.systemId) || !isId(o.ownerCorpId)) return invalid("count");
    const s = stmts(tx);
    return { ok: true, counts: {
      perSystemOwner: Number(s.freeSystemOwner.get(toBind(o.systemId), toBind(o.ownerCorpId)).n),
      perOwner: Number(s.freeOwner.get(toBind(o.ownerCorpId)).n) } };
  }

  function insertPending(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isText(spec.sentryId, S.MAX_ID_LENGTH) || !isId(spec.factionId) || !isId(spec.ownerCorpId)
      || !isId(spec.typeId) || !isId(spec.systemId) || !S.ANCHOR_KINDS.includes(spec.anchorKind)
      || spec.anchorKind === S.SPACE_ANCHOR
      || !isId(spec.anchorId) || !isCount(spec.slot) || !isCount(spec.costIsk) || !isTime(spec.at)) {
      return invalid("spec");
    }
    const payload = { sentryId: spec.sentryId, factionId: spec.factionId, systemId: spec.systemId,
      anchorKind: spec.anchorKind, anchorId: spec.anchorId, slot: spec.slot, typeId: spec.typeId,
      costIsk: spec.costIsk };
    const r = journal.applyOnce(tx, { key: S.insertKey(spec.sentryId, spec.at),
      aggregate: { type: S.AGGREGATE, id: spec.sentryId }, eventType: S.EVENT_BUILD_REQUESTED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(spec.sentryId)) return { ok: false, reason: "SENTRY_EXISTS", sentryId: spec.sentryId };
      s.insertPending.run(spec.sentryId, toBind(spec.factionId), toBind(spec.ownerCorpId), toBind(spec.typeId),
        toBind(spec.systemId), spec.anchorKind, toBind(spec.anchorId), toBind(spec.slot), toBind(spec.costIsk),
        toBind(spec.at), toBind(spec.at));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    const row = stmts(tx).byId.get(spec.sentryId);
    return { ok: true, duplicate: r.duplicate === true, sentry: row ? toSentry(row) : null };
  }

  function versioned(tx, sentry, payload, write) {
    const key = S.stateKey(sentry.sentryId, sentry.createdAt, sentry.version);
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: sentry.sentryId },
      eventType: S.EVENT_STATE, payload }, (db) => {
      const changed = write(stmts(db)).changes;
      if (changed !== 1) {
        const row = stmts(db).byId.get(sentry.sentryId);
        return row ? { ok: false, reason: "VERSION_CONFLICT", actual: row.state, actualVersion: row.version }
          : { ok: false, reason: "ROW_NOT_FOUND", sentryId: sentry.sentryId };
      }
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    const row = stmts(tx).byId.get(sentry.sentryId);
    return { ok: true, duplicate: r.duplicate === true, sentry: row ? toSentry(row) : null };
  }

  function activatePending(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    const sentry = c.sentry;
    if (!sentry || !isText(sentry.sentryId, S.MAX_ID_LENGTH) || !isId(sentry.version) || !isTime(sentry.createdAt)
      || sentry.state !== S.PENDING_DEPLOY || !isId(c.itemId) || !isTime(c.armedAt) || !isCount(c.ammoGrants)
      || !isTime(c.at)) return invalid("activate");
    return versioned(tx, sentry, { sentryId: sentry.sentryId, from: S.PENDING_DEPLOY, to: S.ACTIVE, reason: "DEPLOYED",
      itemId: c.itemId }, (s) => s.activate.run(toBind(c.itemId), toBind(c.armedAt), toBind(c.ammoGrants),
      toBind(c.at), sentry.sentryId, toBind(sentry.version)));
  }

  function noteAmmoGrant(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    const sentry = c.sentry;
    if (!sentry || !isText(sentry.sentryId, S.MAX_ID_LENGTH) || !isId(sentry.version) || !isTime(sentry.createdAt)
      || sentry.state !== S.ACTIVE || !isTime(c.at)) return invalid("ammo");
    return versioned(tx, sentry, { sentryId: sentry.sentryId, from: S.ACTIVE, to: S.ACTIVE, reason: "AMMO_TOPUP",
      n: sentry.ammoGrants }, (s) => s.ammo.run(toBind(c.at), sentry.sentryId, toBind(sentry.version)));
  }

  function countFactionLive(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!isId(o.factionId) || !isId(o.systemId) || !S.ANCHOR_KINDS.includes(o.anchorKind) || !isId(o.anchorId)) {
      return invalid("count");
    }
    const s = stmts(tx);
    return { ok: true, counts: {
      perFaction: s.countFaction.get(toBind(o.factionId)).n,
      perFactionSystem: s.countFactionSystem.get(toBind(o.factionId), toBind(o.systemId)).n,
      perAnchor: s.countAnchor.get(o.anchorKind, toBind(o.anchorId)).n,
      total: s.countAll.get().n,
      slots: s.slotsOnAnchor.all(o.anchorKind, toBind(o.anchorId)).map((r) => r.slot),
    } };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    insertActive,
    insertPending,
    activatePending,
    noteAmmoGrant,
    countFactionLive,
    listFactionLive: (tx, factionId, limit) => read(tx, (s) => {
      if (!isId(factionId) || !isCount(limit)) return invalid("faction");
      const rows = s.listFaction.all(toBind(factionId), toBind(limit + 1));
      return { ok: true, sentries: rows.slice(0, limit).map(toSentry), truncated: rows.length > limit };
    }),
    countAnchorsInSystem: (tx, systemId) => read(tx, (s) => {
      if (!isId(systemId)) return invalid("systemId");
      return { ok: true, anchors: s.anchorsInSystem.all(toBind(systemId)).map((r) => ({ anchorKind: r.anchor_kind,
        anchorId: Number(r.anchor_id), count: Number(r.n) })) };
    }),
    listLive: (tx, opts) => read(tx, (s) => {
      const o = opts || {};
      if (!isId(o.limit) || (o.systemId !== null && o.systemId !== undefined && !isId(o.systemId))) {
        return invalid("opts");
      }
      const rows = isId(o.systemId) ? s.listLiveInSystem.all(toBind(o.systemId), toBind(o.limit + 1))
        : s.listLive.all(toBind(o.limit + 1));
      return { ok: true, sentries: rows.slice(0, o.limit).map(toSentry), truncated: rows.length > o.limit };
    }),
    countLiveBySystem: (tx, limit) => read(tx, (s) => {
      if (!isId(limit)) return invalid("limit");
      const rows = s.liveBySystem.all(toBind(limit + 1));
      return { ok: true, systems: rows.slice(0, limit).map((r) => ({ systemId: Number(r.system_id),
        count: Number(r.n) })), truncated: rows.length > limit };
    }),
    transition,
    pruneEnded,
    countLive,
    countFreeLive,
    countAllLive: (tx) => read(tx, (s) => ({ ok: true, count: s.countAll.get().n })),
    getById: (tx, sentryId) => read(tx, (s) => {
      if (!isText(sentryId, S.MAX_ID_LENGTH)) return invalid("sentryId");
      const row = s.byId.get(sentryId);
      return { ok: true, sentry: row ? toSentry(row) : null };
    }),
    getByItem: (tx, itemId) => read(tx, (s) => {
      if (!isId(itemId)) return invalid("itemId");
      const row = s.byItem.get(toBind(itemId));
      return { ok: true, sentry: row ? toSentry(row) : null };
    }),
    listActive: (tx, opts) => read(tx, (s) => {
      const limit = opts && isCount(opts.limit) ? opts.limit : 0;
      const after = opts && typeof opts.afterSentryId === "string" ? opts.afterSentryId : "";
      const rows = s.listActive.all(after, toBind(limit + 1));
      return { ok: true, sentries: rows.slice(0, limit).map(toSentry), truncated: rows.length > limit };
    }),
  });
}

module.exports = { createSentryRepository, toSentry };
