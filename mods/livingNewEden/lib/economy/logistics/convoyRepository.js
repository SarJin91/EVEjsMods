"use strict";

const { KIND_APPLY } = require("../../persistence/journal");
const { toBind, stateListSql } = require("../../persistence/repository");
const S = require("../schema");
const { canTransitionConvoy } = require("./convoyMachine");
const { unitVolume } = require("./cargo");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const OPEN_JSON = JSON.stringify(S.CONVOY_OPEN_STATES);
const OPEN_LIT = stateListSql(S.CONVOY_OPEN_STATES, S.CONVOY_STATES);
const WRECK_END_REASONS = Object.freeze(["FLEET_DESTROYED", "CARRIERS_LOST"]);
const TOTAL_FIELDS = Object.freeze(["convoysStarted", "convoysDelivered", "convoysAborted", "convoysLost",
  "unitsLoaded", "unitsDelivered", "unitsLost"]);
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isCargo = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).every((k) => unitVolume(k) !== null && Number.isSafeInteger(v[k]) && v[k] > 0);
const nullOr = (check) => (v) => v === null || check(v);
const isStationId = (v) => isText(v, S.MAX_ID_LENGTH);
const PATCH = Object.freeze({
  phaseSeq: ["phase_seq", isCount],
  watchRound: ["watch_round", isCount],
  operationId: ["operation_id", nullOr((v) => isText(v, S.MAX_ID_LENGTH))],
  destStationId: ["dest_station_id", isStationId],
  destSystemId: ["dest_system_id", isId],
  deliveredStationId: ["delivered_station_id", nullOr(isStationId)],
  cargo: ["cargo_json", nullOr(isCargo)],
  carriersAtLoad: ["carriers_at_load", nullOr((v) => Number.isSafeInteger(v) && v >= 1)],
  delivered: ["delivered_json", nullOr(isCargo)],
  lostUnits: ["lost_units", isCount],
  cargoVolume: ["cargo_volume", isCount],
  loadedAt: ["loaded_at", nullOr(isTime)],
  endedAt: ["ended_at", nullOr(isTime)],
  endReason: ["end_reason", nullOr((v) => isText(v, S.MAX_END_REASON_LENGTH))],
});
const JSON_FIELDS = Object.freeze(["cargo", "delivered"]);

const invalid = (detail) => ({ ok: false, reason: "LOGISTICS_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const parse = (text) => (text === null || text === undefined ? null : JSON.parse(text));

function toConvoy(row) {
  return Object.freeze({
    convoyId: row.convoy_id, idempotencyKey: row.idempotency_key, factionId: row.faction_id, fleetId: row.fleet_id,
    operationId: row.operation_id, purpose: row.purpose, sourceStationId: row.source_station_id,
    sourceSystemId: row.source_system_id, destStationId: row.dest_station_id, destSystemId: row.dest_system_id,
    deliveredStationId: row.delivered_station_id, state: row.state, phaseSeq: row.phase_seq,
    watchRound: row.watch_round, plan: Object.freeze(parse(row.plan_json)), cargo: Object.freeze(parse(row.cargo_json)),
    carriersAtLoad: row.carriers_at_load, delivered: Object.freeze(parse(row.delivered_json)),
    lostUnits: row.lost_units, cargoVolume: row.cargo_volume, dispatchedAt: row.dispatched_at,
    loadedAt: row.loaded_at, endedAt: row.ended_at, endReason: row.end_reason, createdAt: row.created_at,
    updatedAt: row.updated_at, version: row.version,
  });
}

function toTotals(row) {
  return Object.freeze({ factionId: row.faction_id, convoysStarted: row.convoys_started,
    convoysDelivered: row.convoys_delivered, convoysAborted: row.convoys_aborted, convoysLost: row.convoys_lost,
    unitsLoaded: row.units_loaded, unitsDelivered: row.units_delivered, unitsLost: row.units_lost,
    updatedAt: row.updated_at, version: row.version });
}

function createConvoyRepository(deps) {
  const { journal, clock } = deps;
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("convoyRepository: journal");
  if (!clock || typeof clock.now !== "function") throw new TypeError("convoyRepository: clock");
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const sat = (c) => `${c} = min(${S.MAX_TOTAL}, ${c} + excluded.${c})`;
    s = {
      updates: new Map(),
      byId: db.prepare("SELECT * FROM world_convoys WHERE convoy_id = ?"),
      openByFleet: db.prepare(`SELECT * FROM world_convoys WHERE fleet_id = ?
        AND state IN ${S.CONVOY_OPEN_STATES_SQL}`),
      listOpen: db.prepare(`SELECT * FROM world_convoys WHERE state IN (SELECT value FROM json_each(?))
        AND convoy_id > ? ORDER BY convoy_id LIMIT ?`),
      listInTransit: db.prepare(`SELECT * FROM world_convoys WHERE state = '${S.CONVOY_IN_TRANSIT}'
        AND convoy_id > ? ORDER BY convoy_id LIMIT ?`),
      openOfFaction: db.prepare(`SELECT * FROM world_convoys WHERE faction_id = ?
        AND state IN ${OPEN_LIT} ORDER BY convoy_id LIMIT ?`),
      countOpenFaction: db.prepare(`SELECT count(*) AS n FROM world_convoys WHERE faction_id = ?
        AND state IN ${OPEN_LIT}`),
      insert: db.prepare(`INSERT INTO world_convoys (convoy_id, idempotency_key, faction_id, fleet_id, operation_id,
        purpose, source_station_id, source_system_id, dest_station_id, dest_system_id, delivered_station_id, state,
        phase_seq, watch_round, plan_json, cargo_json, carriers_at_load, delivered_json, lost_units, cargo_volume,
        dispatched_at, loaded_at, ended_at, end_reason, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, NULL, ?, ?, 1)`),
      totalsUpsert: db.prepare(`INSERT INTO world_convoy_totals (faction_id, convoys_started, convoys_delivered,
        convoys_aborted, convoys_lost, units_loaded, units_delivered, units_lost, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (faction_id) DO UPDATE SET ${["convoys_started", "convoys_delivered", "convoys_aborted",
    "convoys_lost", "units_loaded", "units_delivered", "units_lost"].map(sat).join(", ")},
        updated_at = excluded.updated_at, version = version + 1`),
      totalsOf: db.prepare("SELECT * FROM world_convoy_totals WHERE faction_id = ?"),
      totalsAll: db.prepare("SELECT * FROM world_convoy_totals ORDER BY faction_id"),
      pruneIds: db.prepare(`SELECT convoy_id FROM world_convoys WHERE faction_id = ? AND ended_at IS NOT NULL
        AND ended_at < ? ORDER BY ended_at, convoy_id LIMIT ?`),
      watch: db.prepare(`UPDATE world_convoys SET watch_round = ?, phase_seq = coalesce(?, phase_seq), updated_at = ?,
        version = version + 1
        WHERE convoy_id = ?`),
      deleteConvoy: db.prepare("DELETE FROM world_convoys WHERE convoy_id = ?"),
      recentEnded: db.prepare(`SELECT faction_id, state, count(*) AS convoys, coalesce(sum(lost_units), 0) AS lost
        FROM world_convoys WHERE ended_at IS NOT NULL AND ended_at >= ? GROUP BY faction_id, state`),
      recentDelivered: db.prepare(`SELECT faction_id, delivered_json FROM world_convoys WHERE state = 'DELIVERED'
        AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY convoy_id LIMIT ?`),
      lastEnded: db.prepare(`SELECT * FROM world_convoys WHERE faction_id = ? AND ended_at IS NOT NULL
        AND purpose = ? ORDER BY ended_at DESC, convoy_id DESC LIMIT 1`),
      lostSince: db.prepare(`SELECT convoy_id, faction_id, fleet_id, lost_units, ended_at FROM world_convoys
        WHERE state = '${S.CONVOY_LOST}' AND end_reason IN (${WRECK_END_REASONS.map((r) => `'${r}'`).join(", ")})
        AND ended_at IS NOT NULL AND ended_at >= ?
        ORDER BY ended_at DESC, convoy_id DESC LIMIT ?`),
    };
    cache.set(db, s);
    return s;
  }

  function readNow() {
    const now = clock.now();
    return isTime(now) ? now : undefined;
  }

  function addTotals(db, factionId, deltas, now) {
    const d = deltas || {};
    for (const k of Object.keys(d)) {
      if (!TOTAL_FIELDS.includes(k) || !isCount(d[k])) return invalid(`totals.${k}`);
    }
    stmts(db).totalsUpsert.run(toBind(factionId), ...TOTAL_FIELDS.map((k) => toBind(Math.min(S.MAX_TOTAL, d[k] || 0))),
      toBind(now));
    return { ok: true };
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function convoyIdOfKey(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    if (found.found && found.entry.kind === KIND_APPLY && found.entry.aggregateType === S.CONVOY_AGGREGATE) {
      return { ok: true, convoyId: found.entry.aggregateId, duplicate: true };
    }
    if (found.found) return { ok: false, reason: "IDEMPOTENCY_CONFLICT", detail: key };
    return { ok: true, convoyId: null, duplicate: false };
  }

  function createConvoy(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isText(spec.convoyId, S.MAX_ID_LENGTH) || !isText(spec.idempotencyKey, S.MAX_KEY_LENGTH)
      || !isId(spec.factionId) || !isText(spec.fleetId, S.MAX_ID_LENGTH) || !isText(spec.operationId, S.MAX_ID_LENGTH)
      || !S.CONVOY_PURPOSES.includes(spec.purpose) || !isStationId(spec.sourceStationId) || !isId(spec.sourceSystemId)
      || !isStationId(spec.destStationId) || !isId(spec.destSystemId) || !isCargo(spec.plan)
      || Object.keys(spec.plan).length === 0 || !isCount(spec.cargoVolume) || !isTime(spec.dispatchedAt)) {
      return invalid("spec");
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const payload = { convoyId: spec.convoyId, factionId: spec.factionId, fleetId: spec.fleetId,
      operationId: spec.operationId, purpose: spec.purpose, sourceStationId: spec.sourceStationId,
      destStationId: spec.destStationId, plan: spec.plan };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.CONVOY_AGGREGATE, id: spec.convoyId },
      eventType: S.EVENT_CONVOY_CREATED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(spec.convoyId)) return { ok: false, reason: "CONVOY_EXISTS", convoyId: spec.convoyId };
      s.insert.run(spec.convoyId, spec.idempotencyKey, toBind(spec.factionId), spec.fleetId, spec.operationId,
        spec.purpose, spec.sourceStationId, toBind(spec.sourceSystemId), spec.destStationId, toBind(spec.destSystemId),
        S.CONVOY_TO_SOURCE, JSON.stringify(spec.plan), toBind(spec.cargoVolume), toBind(spec.dispatchedAt),
        toBind(now), toBind(now));
      return addTotals(db, spec.factionId, { convoysStarted: 1 }, now);
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true, convoyId: spec.convoyId };
  }

  function transitionConvoy(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.convoyId, S.MAX_ID_LENGTH)) return invalid("convoyId");
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1) return invalid("expectedVersion");
    const edge = canTransitionConvoy(change.from, change.to);
    if (!edge.ok) return edge;
    const patch = change.patch || {};
    const sets = [];
    const values = [];
    for (const k of Object.keys(patch).sort()) {
      const spec = PATCH[k];
      if (!spec || !spec[1](patch[k])) return invalid(`patch.${k}`);
      sets.push(`${spec[0]} = ?`);
      values.push(JSON_FIELDS.includes(k) && patch[k] !== null ? JSON.stringify(patch[k]) : toBind(patch[k]));
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.CONVOY_AGGREGATE, id: change.convoyId },
      eventType: S.EVENT_CONVOY_TRANSITION, payload: { convoyId: change.convoyId, from: change.from, to: change.to } },
    (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.convoyId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", convoyId: change.convoyId };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.state !== change.from) return { ok: false, reason: "STATE_MISMATCH", expected: change.from,
        actual: row.state };
      const sql = `UPDATE world_convoys SET ${[...sets, "state = ?", "updated_at = ?", "version = version + 1"]
        .join(", ")} WHERE convoy_id = ? AND version = ?`;
      if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
      s.updates.get(sql).run(...values, change.to, toBind(now), change.convoyId, toBind(change.expectedVersion));
      if (change.totals) {
        const t = addTotals(db, row.faction_id, change.totals, now);
        if (!t.ok) return t;
      }
      return { ok: true, convoy: toConvoy(s.byId.get(change.convoyId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(change.convoyId);
      return { ok: true, duplicate: true, convoy: row ? toConvoy(row) : null };
    }
    changes += 1;
    return { ok: true, duplicate: false, convoy: r.value.convoy };
  }

  function watchConvoy(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.convoyId, S.MAX_ID_LENGTH) || !S.CONVOY_OPEN_STATES.includes(change.state)
      || !isCount(change.watchRound) || !Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1
      || (change.phaseSeq !== undefined && !isCount(change.phaseSeq))) {
      return invalid("watch");
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.CONVOY_AGGREGATE, id: change.convoyId },
      eventType: S.EVENT_CONVOY_WAIT, payload: { convoyId: change.convoyId, state: change.state,
        watchRound: change.watchRound,
        ...(change.phaseSeq === undefined ? {} : { phaseSeq: change.phaseSeq }) } }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.convoyId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", convoyId: change.convoyId };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.state !== change.state) return { ok: false, reason: "STATE_MISMATCH", expected: change.state,
        actual: row.state };
      s.watch.run(toBind(change.watchRound), change.phaseSeq === undefined ? null : toBind(change.phaseSeq), toBind(now),
        change.convoyId);
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true };
  }

  function prune(tx, factionId, before, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId) || !isTime(before) || !isCount(limit)) return invalid("prune");
    if (limit === 0) return { ok: true, pruned: 0 };
    const s = stmts(tx);
    const ids = s.pruneIds.all(toBind(factionId), toBind(before), toBind(limit)).map((r) => r.convoy_id);
    for (const id of ids) s.deleteConvoy.run(id);
    if (ids.length > 0) changes += 1;
    return { ok: true, pruned: ids.length };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    convoyIdOfKey,
    createConvoy,
    transitionConvoy,
    watchConvoy,
    prune,
    getConvoy: (tx, convoyId) => read(tx, (s) => {
      const row = s.byId.get(convoyId);
      return { ok: true, convoy: row ? toConvoy(row) : null };
    }),
    findOpenByFleet: (tx, fleetId) => read(tx, (s) => {
      const row = s.openByFleet.get(fleetId);
      return { ok: true, convoy: row ? toConvoy(row) : null };
    }),
    listOpen: (tx, opts) => read(tx, (s) => ({ ok: true, convoys: s.listOpen.all(OPEN_JSON,
      (opts && opts.after) || "", toBind((opts && opts.limit) || 1)).map(toConvoy) })),
    listInTransit: (tx, opts) => read(tx, (s) => ({ ok: true, convoys: s.listInTransit.all(
      (opts && opts.after) || "", toBind((opts && opts.limit) || 1)).map(toConvoy) })),
    listOpenOfFaction: (tx, factionId, limit) => read(tx, (s) => ({ ok: true,
      convoys: s.openOfFaction.all(toBind(factionId), toBind(limit)).map(toConvoy) })),
    countOpenOfFaction: (tx, factionId) => read(tx, (s) => ({ ok: true,
      count: s.countOpenFaction.get(toBind(factionId)).n })),
    getTotals: (tx, factionId) => read(tx, (s) => {
      const row = s.totalsOf.get(toBind(factionId));
      return { ok: true, totals: row ? toTotals(row) : null };
    }),
    listTotals: (tx) => read(tx, (s) => ({ ok: true, totals: s.totalsAll.all().map(toTotals) })),
    recentEnded: (tx, since) => read(tx, (s) => ({ ok: true, rows: s.recentEnded.all(toBind(since)) })),
    recentDelivered: (tx, since, limit) => read(tx, (s) => ({ ok: true,
      rows: s.recentDelivered.all(toBind(since), toBind(limit)).map((r) => ({ factionId: r.faction_id,
        delivered: parse(r.delivered_json) || {} })) })),
    lostSince: (tx, since, limit) => {
      if (!isTime(since) || !Number.isSafeInteger(limit) || limit < 1) return invalid("lostSince");
      return read(tx, (s) => ({ ok: true, rows: s.lostSince.all(toBind(since), toBind(limit)).map((r) => ({
        convoyId: r.convoy_id, factionId: r.faction_id, fleetId: r.fleet_id, lostUnits: r.lost_units,
        endedAt: r.ended_at })) }));
    },
    findLastEndedOfFaction: (tx, factionId, purpose) => {
      if (!isId(factionId) || !S.CONVOY_PURPOSES.includes(purpose)) return invalid("findLastEndedOfFaction");
      return read(tx, (s) => {
        const row = s.lastEnded.get(toBind(factionId), purpose);
        return { ok: true, convoy: row ? toConvoy(row) : null };
      });
    },
    getChangeCount: () => changes,
  });
}

const deliveredCache = new WeakMap();
const MAX_DELIVERED_PAGE = 5000;

function listDeliveredConvoysAfter(tx, spec) {
  if (txMissing(tx)) return TX_REQUIRED;
  if (!spec || !isId(spec.factionId) || !isTime(spec.afterAt) || typeof spec.afterKey !== "string"
    || spec.afterKey.length > S.MAX_ID_LENGTH || !isTime(spec.untilAt) || !Number.isSafeInteger(spec.limit)
    || spec.limit < 1 || spec.limit > MAX_DELIVERED_PAGE) {
    return invalid("deliveredAfter");
  }
  let stmt = deliveredCache.get(tx);
  if (!stmt) {
    stmt = tx.prepare(`SELECT convoy_id, ended_at, dest_system_id FROM world_convoys
      WHERE faction_id = ? AND ended_at IS NOT NULL AND ended_at <= ?
      AND (ended_at > ? OR (ended_at = ? AND convoy_id > ?))
      AND state = 'DELIVERED' ORDER BY ended_at, convoy_id LIMIT ?`);
    deliveredCache.set(tx, stmt);
  }
  const rows = stmt.all(toBind(spec.factionId), toBind(spec.untilAt), toBind(spec.afterAt), toBind(spec.afterAt),
    spec.afterKey, toBind(spec.limit));
  return { ok: true, rows: rows.map((r) => Object.freeze({ id: r.convoy_id, endedAt: Number(r.ended_at),
    systemId: Number(r.dest_system_id) })) };
}

module.exports = { createConvoyRepository, toConvoy, listDeliveredConvoysAfter };
