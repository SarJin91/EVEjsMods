// Port of the X-Eve counters miningRuns / oreUnitsMined / mineralUnitsRefined / miningDepositsDelivered (see CREDITS.md).

"use strict";

const { KIND_APPLY } = require("../../persistence/journal");
const { toBind, stateListSql } = require("../../persistence/repository");
const S = require("../schema");
const { canTransitionTrip } = require("./tripMachine");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const OPEN_JSON = JSON.stringify(S.OPEN_TRIP_STATES);
const OPEN_LIT = stateListSql(S.OPEN_TRIP_STATES, S.TRIP_STATES);
const BAD_STATES_JSON = JSON.stringify(S.MINING_BAD_END_STATES);
const BAD_REASONS_JSON = JSON.stringify(S.MINING_BAD_END_REASONS);
const TOTAL_FIELDS = Object.freeze(["tripsStarted", "tripsDelivered", "tripsAborted", "tripsLost", "oreUnits",
  "mineralUnits", "lostMineralUnits"]);
const TOTAL_COLUMNS = Object.freeze({ tripsStarted: "trips_started", tripsDelivered: "trips_delivered",
  tripsAborted: "trips_aborted", tripsLost: "trips_lost", oreUnits: "ore_units", mineralUnits: "mineral_units",
  lostMineralUnits: "lost_mineral_units" });
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isCargo = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).every((k) => /^type:\d+$/.test(k) && Number.isSafeInteger(v[k]) && v[k] > 0);
const nullOr = (check) => (v) => v === null || check(v);
const PATCH = Object.freeze({
  phaseSeq: ["phase_seq", isCount],
  watchRound: ["watch_round", isCount],
  returnOperationId: ["return_operation_id", nullOr((v) => isText(v, S.MAX_ID_LENGTH))],
  returnSystemId: ["return_system_id", nullOr(isId)],
  deliveredStationId: ["delivered_station_id", nullOr((v) => isText(v, S.MAX_ID_LENGTH))],
  shipsAtLoad: ["ships_at_load", nullOr((v) => Number.isSafeInteger(v) && v >= 1)],
  cargo: ["cargo_json", nullOr(isCargo)],
  delivered: ["delivered_json", nullOr(isCargo)],
  lostUnits: ["lost_units", isCount],
  miningStartedAt: ["mining_started_at", nullOr(isTime)],
  miningEndsAt: ["mining_ends_at", nullOr(isTime)],
  loadedAt: ["loaded_at", nullOr(isTime)],
  endedAt: ["ended_at", nullOr(isTime)],
  endReason: ["end_reason", nullOr((v) => isText(v, S.MAX_END_REASON_LENGTH))],
});
const JSON_FIELDS = Object.freeze(["cargo", "delivered"]);

const invalid = (detail) => ({ ok: false, reason: "MINING_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const parse = (text) => (text === null || text === undefined ? null : JSON.parse(text));

function toTrip(row) {
  return Object.freeze({
    tripId: row.trip_id, idempotencyKey: row.idempotency_key, factionId: row.faction_id, fleetId: row.fleet_id,
    outboundOperationId: row.outbound_operation_id, returnOperationId: row.return_operation_id,
    originSystemId: row.origin_system_id, beltSystemId: row.belt_system_id, returnSystemId: row.return_system_id,
    deliveredStationId: row.delivered_station_id, state: row.state, phaseSeq: row.phase_seq,
    watchRound: row.watch_round, secClass: row.sec_class, richnessPermille: row.richness_permille,
    shipsAtLoad: row.ships_at_load, cargo: Object.freeze(parse(row.cargo_json)),
    delivered: Object.freeze(parse(row.delivered_json)), lostUnits: row.lost_units, dispatchedAt: row.dispatched_at,
    miningStartedAt: row.mining_started_at, miningEndsAt: row.mining_ends_at, loadedAt: row.loaded_at,
    endedAt: row.ended_at, endReason: row.end_reason, createdAt: row.created_at, updatedAt: row.updated_at,
    version: row.version,
  });
}

function toTotals(row) {
  return Object.freeze({ factionId: row.faction_id, tripsStarted: row.trips_started,
    tripsDelivered: row.trips_delivered, tripsAborted: row.trips_aborted, tripsLost: row.trips_lost,
    oreUnits: row.ore_units, mineralUnits: row.mineral_units, lostMineralUnits: row.lost_mineral_units,
    updatedAt: row.updated_at, version: row.version });
}

function createTripRepository(deps) {
  const { journal, clock } = deps;
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("tripRepository: journal");
  if (!clock || typeof clock.now !== "function") throw new TypeError("tripRepository: clock");
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      updates: new Map(),
      byId: db.prepare("SELECT * FROM world_mining_trips WHERE trip_id = ?"),
      openByFleet: db.prepare(`SELECT * FROM world_mining_trips WHERE fleet_id = ?
        AND state IN ${S.OPEN_TRIP_STATES_SQL}`),
      listOpen: db.prepare(`SELECT * FROM world_mining_trips WHERE state IN (SELECT value FROM json_each(?))
        AND trip_id > ? ORDER BY trip_id LIMIT ?`),
      openOfFaction: db.prepare(`SELECT * FROM world_mining_trips WHERE faction_id = ?
        AND state IN ${OPEN_LIT} ORDER BY trip_id LIMIT ?`),
      countOpenBelt: db.prepare(`SELECT count(*) AS n FROM world_mining_trips WHERE belt_system_id = ?
        AND state IN ('OUTBOUND','MINING','RETURNING')`),
      countOpenFaction: db.prepare(`SELECT count(*) AS n FROM world_mining_trips WHERE faction_id = ?
        AND state IN ${OPEN_LIT}`),
      insert: db.prepare(`INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id,
        outbound_operation_id, return_operation_id, origin_system_id, belt_system_id, return_system_id,
        delivered_station_id, state, phase_seq, watch_round, sec_class, richness_permille, ships_at_load, cargo_json,
        delivered_json, lost_units, dispatched_at, mining_started_at, mining_ends_at, loaded_at, ended_at, end_reason,
        created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 0, 0, ?, ?, NULL, NULL, NULL, 0, ?, NULL, NULL, NULL, NULL,
        NULL, ?, ?, 1)`),
      totalsUpsert: db.prepare(`INSERT INTO world_mining_totals (faction_id, trips_started, trips_delivered,
        trips_aborted, trips_lost, ore_units, mineral_units, lost_mineral_units, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (faction_id) DO UPDATE SET trips_started = trips_started + excluded.trips_started,
        trips_delivered = trips_delivered + excluded.trips_delivered,
        trips_aborted = trips_aborted + excluded.trips_aborted, trips_lost = trips_lost + excluded.trips_lost,
        ore_units = ore_units + excluded.ore_units, mineral_units = mineral_units + excluded.mineral_units,
        lost_mineral_units = lost_mineral_units + excluded.lost_mineral_units, updated_at = excluded.updated_at,
        version = version + 1`),
      totalsOf: db.prepare("SELECT * FROM world_mining_totals WHERE faction_id = ?"),
      totalsAll: db.prepare("SELECT * FROM world_mining_totals ORDER BY faction_id"),
      pruneIds: db.prepare(`SELECT trip_id FROM world_mining_trips WHERE faction_id = ? AND ended_at IS NOT NULL
        AND ended_at < ? ORDER BY ended_at, trip_id LIMIT ?`),
      watch: db.prepare(`UPDATE world_mining_trips SET watch_round = ?, updated_at = ?, version = version + 1
        WHERE trip_id = ?`),
      deleteTrip: db.prepare("DELETE FROM world_mining_trips WHERE trip_id = ?"),
      recentByFaction: db.prepare(`SELECT faction_id, state, count(*) AS trips,
        coalesce(sum(lost_units), 0) AS lost FROM world_mining_trips WHERE ended_at IS NOT NULL AND ended_at >= ?
        GROUP BY faction_id, state`),
      recentDelivered: db.prepare(`SELECT faction_id, belt_system_id, delivered_json FROM world_mining_trips
        WHERE state = 'DELIVERED' AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY trip_id LIMIT ?`),
      openCounts: db.prepare(`SELECT faction_id, state, count(*) AS n FROM world_mining_trips
        WHERE state IN ('OUTBOUND','MINING','RETURNING') GROUP BY faction_id, state`),
      minerTargets: db.prepare(`SELECT t.trip_id, t.faction_id, t.fleet_id, t.belt_system_id, t.sec_class,
        t.mining_ends_at, f.ship_count FROM world_mining_trips t JOIN virtual_fleets f ON f.fleet_id = t.fleet_id
        WHERE t.state IN ('OUTBOUND','MINING','RETURNING') AND t.state = 'MINING'
        AND t.faction_id <> ? AND t.mining_ends_at > ?
        AND f.state = 'STAGED' AND f.current_system_id = t.belt_system_id
        ORDER BY t.mining_ends_at DESC, t.trip_id LIMIT ?`),
      badEndsByBelt: db.prepare(`SELECT belt_system_id AS s, count(*) AS n, max(ended_at) AS last
        FROM world_mining_trips
        WHERE faction_id = ? AND ended_at IS NOT NULL AND ended_at >= ?
          AND state IN (SELECT value FROM json_each(?))
          AND end_reason IN (SELECT value FROM json_each(?))
        GROUP BY belt_system_id HAVING count(*) >= ?
        ORDER BY last DESC, s LIMIT ?`),
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
    stmts(db).totalsUpsert.run(toBind(factionId), ...TOTAL_FIELDS.map((k) => toBind(d[k] || 0)), toBind(now));
    return { ok: true };
  }

  function unwrap(result) {
    if (result.reason === "APPLY_REFUSED") return result.refusal;
    return result;
  }

  function tripIdOfKey(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    if (found.found && found.entry.kind === KIND_APPLY && found.entry.aggregateType === S.TRIP_AGGREGATE) {
      return { ok: true, tripId: found.entry.aggregateId, duplicate: true };
    }
    if (found.found) return { ok: false, reason: "IDEMPOTENCY_CONFLICT", detail: key };
    return { ok: true, tripId: null, duplicate: false };
  }

  function createTrip(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isText(spec.tripId, S.MAX_ID_LENGTH) || !isText(spec.idempotencyKey, S.MAX_KEY_LENGTH)
      || !isId(spec.factionId) || !isText(spec.fleetId, S.MAX_ID_LENGTH)
      || !isText(spec.outboundOperationId, S.MAX_ID_LENGTH) || !isId(spec.originSystemId) || !isId(spec.beltSystemId)
      || !isText(spec.secClass, 16) || !Number.isSafeInteger(spec.richnessPermille) || spec.richnessPermille < 0
      || spec.richnessPermille > S.PERMILLE || !isTime(spec.dispatchedAt)) return invalid("spec");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const payload = { tripId: spec.tripId, factionId: spec.factionId, fleetId: spec.fleetId,
      outboundOperationId: spec.outboundOperationId, originSystemId: spec.originSystemId,
      beltSystemId: spec.beltSystemId, secClass: spec.secClass, richnessPermille: spec.richnessPermille };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.TRIP_AGGREGATE, id: spec.tripId },
      eventType: S.EVENT_TRIP_CREATED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(spec.tripId)) return { ok: false, reason: "TRIP_EXISTS", tripId: spec.tripId };
      s.insert.run(spec.tripId, spec.idempotencyKey, toBind(spec.factionId), spec.fleetId, spec.outboundOperationId,
        toBind(spec.originSystemId), toBind(spec.beltSystemId), S.OUTBOUND, spec.secClass,
        toBind(spec.richnessPermille), toBind(spec.dispatchedAt), toBind(now), toBind(now));
      return addTotals(db, spec.factionId, { tripsStarted: 1 }, now);
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true, tripId: spec.tripId };
  }

  function transitionTrip(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.tripId, S.MAX_ID_LENGTH)) return invalid("tripId");
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1) return invalid("expectedVersion");
    const edge = canTransitionTrip(change.from, change.to);
    if (!edge.ok) return edge;
    const patch = change.patch || {};
    const sets = [];
    const values = [];
    for (const k of Object.keys(patch).sort()) {
      const spec = PATCH[k];
      if (!spec) return invalid(`patch.${k}`);
      if (!spec[1](patch[k])) return invalid(`patch.${k}`);
      sets.push(`${spec[0]} = ?`);
      values.push(JSON_FIELDS.includes(k) && patch[k] !== null ? JSON.stringify(patch[k]) : toBind(patch[k]));
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.TRIP_AGGREGATE, id: change.tripId },
      eventType: S.EVENT_TRIP_TRANSITION, payload: { tripId: change.tripId, from: change.from, to: change.to } },
    (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.tripId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", tripId: change.tripId };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.state !== change.from) {
        return { ok: false, reason: "STATE_MISMATCH", expected: change.from, actual: row.state };
      }
      const sql = `UPDATE world_mining_trips SET ${[...sets, "state = ?", "updated_at = ?", "version = version + 1"]
        .join(", ")} WHERE trip_id = ? AND version = ?`;
      if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
      s.updates.get(sql).run(...values, change.to, toBind(now), change.tripId, toBind(change.expectedVersion));
      if (change.totals) {
        const t = addTotals(db, row.faction_id, change.totals, now);
        if (!t.ok) return t;
      }
      return { ok: true, trip: toTrip(s.byId.get(change.tripId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(change.tripId);
      return { ok: true, duplicate: true, trip: row ? toTrip(row) : null };
    }
    changes += 1;
    return { ok: true, duplicate: false, trip: r.value.trip };
  }

  function watchTrip(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.tripId, S.MAX_ID_LENGTH) || !S.OPEN_TRIP_STATES.includes(change.state)
      || !isCount(change.watchRound) || !Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1) {
      return invalid("watch");
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.TRIP_AGGREGATE, id: change.tripId },
      eventType: S.EVENT_TRIP_WAIT, payload: { tripId: change.tripId, state: change.state,
        watchRound: change.watchRound } }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.tripId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", tripId: change.tripId };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.state !== change.state) {
        return { ok: false, reason: "STATE_MISMATCH", expected: change.state, actual: row.state };
      }
      s.watch.run(toBind(change.watchRound), toBind(now), change.tripId);
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
    const ids = s.pruneIds.all(toBind(factionId), toBind(before), toBind(limit)).map((r) => r.trip_id);
    for (const id of ids) s.deleteTrip.run(id);
    if (ids.length > 0) changes += 1;
    return { ok: true, pruned: ids.length };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  function listMinerTargets(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isId(spec.excludeFactionId) || !isTime(spec.at) || !isCount(spec.limit)) {
      return invalid("minerTargets");
    }
    const rows = stmts(tx).minerTargets.all(toBind(spec.excludeFactionId), toBind(spec.at), toBind(spec.limit + 1));
    const targets = rows.slice(0, spec.limit).map((r) => Object.freeze({ tripId: r.trip_id, factionId: r.faction_id,
      fleetId: r.fleet_id, systemId: r.belt_system_id, secClass: r.sec_class, miningEndsAt: r.mining_ends_at,
      ships: r.ship_count }));
    return { ok: true, targets, truncated: rows.length > spec.limit };
  }

  function listBadEndsByBelt(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isId(spec.factionId) || !isTime(spec.since) || !isId(spec.minCount) || !isCount(spec.limit)) {
      return invalid("badEndsByBelt");
    }
    if (spec.limit === 0) return { ok: true, rows: [], truncated: false };
    const rows = stmts(tx).badEndsByBelt.all(toBind(spec.factionId), toBind(spec.since), BAD_STATES_JSON,
      BAD_REASONS_JSON, toBind(spec.minCount), toBind(spec.limit + 1));
    return { ok: true, rows: rows.slice(0, spec.limit).map((r) => Object.freeze({ systemId: r.s, n: r.n,
      lastEndedAt: r.last })), truncated: rows.length > spec.limit };
  }

  return Object.freeze({
    tripIdOfKey,
    createTrip,
    transitionTrip,
    watchTrip,
    prune,
    getTrip: (tx, tripId) => read(tx, (s) => {
      const row = s.byId.get(tripId);
      return { ok: true, trip: row ? toTrip(row) : null };
    }),
    findOpenByFleet: (tx, fleetId) => read(tx, (s) => {
      const row = s.openByFleet.get(fleetId);
      return { ok: true, trip: row ? toTrip(row) : null };
    }),
    listOpen: (tx, opts) => read(tx, (s) => ({ ok: true, trips: s.listOpen.all(OPEN_JSON, (opts && opts.after) || "",
      toBind((opts && opts.limit) || 1)).map(toTrip) })),
    listOpenOfFaction: (tx, factionId, limit) => read(tx, (s) => ({ ok: true,
      trips: s.openOfFaction.all(toBind(factionId), toBind(limit)).map(toTrip) })),
    countOpenInBelt: (tx, beltSystemId) => read(tx, (s) => ({ ok: true,
      count: s.countOpenBelt.get(toBind(beltSystemId)).n })),
    listMinerTargets,
    listBadEndsByBelt,
    countOpenOfFaction: (tx, factionId) => read(tx, (s) => ({ ok: true,
      count: s.countOpenFaction.get(toBind(factionId)).n })),
    getTotals: (tx, factionId) => read(tx, (s) => {
      const row = s.totalsOf.get(toBind(factionId));
      return { ok: true, totals: row ? toTotals(row) : null };
    }),
    listTotals: (tx) => read(tx, (s) => ({ ok: true, totals: s.totalsAll.all().map(toTotals) })),
    openCounts: (tx) => read(tx, (s) => ({ ok: true, rows: s.openCounts.all() })),
    recentEnded: (tx, since) => read(tx, (s) => ({ ok: true, rows: s.recentByFaction.all(toBind(since)) })),
    recentDelivered: (tx, since, limit) => read(tx, (s) => ({ ok: true,
      rows: s.recentDelivered.all(toBind(since), toBind(limit)).map((r) => ({ factionId: r.faction_id,
        beltSystemId: r.belt_system_id, delivered: parse(r.delivered_json) || {} })) })),
    getChangeCount: () => changes,
  });
}

const deliveredCache = new WeakMap();
const MAX_DELIVERED_PAGE = 5000;

function listDeliveredTripsAfter(tx, spec) {
  if (txMissing(tx)) return TX_REQUIRED;
  if (!spec || !isId(spec.factionId) || !isTime(spec.afterAt) || typeof spec.afterKey !== "string"
    || spec.afterKey.length > S.MAX_ID_LENGTH || !isTime(spec.untilAt) || !Number.isSafeInteger(spec.limit)
    || spec.limit < 1 || spec.limit > MAX_DELIVERED_PAGE) {
    return invalid("deliveredAfter");
  }
  let stmt = deliveredCache.get(tx);
  if (!stmt) {
    stmt = tx.prepare(`SELECT trip_id, ended_at, belt_system_id FROM world_mining_trips
      WHERE faction_id = ? AND ended_at IS NOT NULL AND ended_at <= ? AND (ended_at > ? OR (ended_at = ? AND trip_id > ?))
      AND state = 'DELIVERED' ORDER BY ended_at, trip_id LIMIT ?`);
    deliveredCache.set(tx, stmt);
  }
  const rows = stmt.all(toBind(spec.factionId), toBind(spec.untilAt), toBind(spec.afterAt), toBind(spec.afterAt),
    spec.afterKey, toBind(spec.limit));
  return { ok: true, rows: rows.map((r) => Object.freeze({ id: r.trip_id, endedAt: Number(r.ended_at),
    systemId: Number(r.belt_system_id) })) };
}

module.exports = { createTripRepository, toTrip, listDeliveredTripsAfter };
