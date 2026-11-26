"use strict";

const { KIND_APPLY } = require("../../persistence/journal");
const { toBind } = require("../../persistence/repository");
const S = require("./schema");
const { canTransitionSiege } = require("./siegeMachine");

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
  endedAt: ["ended_at", nullOr(isTime)],
  endReason: ["end_reason", nullOr((v) => isText(v, S.MAX_END_REASON_LENGTH))],
  lostItems: ["lost_items", isCount],
  lostUnits: ["lost_units", (v) => isCount(v) && v <= S.MAX_TOTAL],
  attackerShips: ["attacker_ships", isCount],
  attackerStrength: ["attacker_strength", isCount],
});
const TOTAL_FIELDS = Object.freeze(["started", "won", "repelled", "besieged", "defended", "lost_destroyed",
  "lost_captured", "sacked", "gained_captured", "stock_units_lost"]);
const END_TOTALS = Object.freeze({
  REPELLED: [["repelled"], ["defended"]],
  DESTROYED: [["won"], ["lost_destroyed"]],
  CAPTURED: [["won", "gained_captured"], ["lost_captured"]],
  SACKED: [["won"], ["sacked"]],
});
const STOCK_ENDS = Object.freeze([S.DESTROYED, S.CAPTURED, S.SACKED]);

const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;

function toSiege(row) {
  return Object.freeze({
    siegeId: row.siege_id, idempotencyKey: row.idempotency_key, stationId: row.station_id, siegeNo: row.siege_no,
    systemId: row.system_id, ownerFactionId: row.owner_faction_id, attackerFactionId: row.attacker_faction_id,
    state: row.state, open: row.open === 1, phaseSeq: row.phase_seq, waitRound: row.wait_round,
    phaseStartedAt: row.phase_started_at, phaseEndsAt: row.phase_ends_at,
    plan: Object.freeze(JSON.parse(row.plan_json)), attackerShips: row.attacker_ships,
    attackerStrength: row.attacker_strength, lostItems: row.lost_items, lostUnits: row.lost_units,
    startedAt: row.started_at, endedAt: row.ended_at, endReason: row.end_reason, createdAt: row.created_at,
    updatedAt: row.updated_at, version: row.version,
  });
}

function toTotals(row) {
  return Object.freeze({ factionId: row.faction_id, started: row.started, won: row.won, repelled: row.repelled,
    besieged: row.besieged, defended: row.defended, lostDestroyed: row.lost_destroyed,
    lostCaptured: row.lost_captured, sacked: row.sacked, gainedCaptured: row.gained_captured,
    stockUnitsLost: row.stock_units_lost, updatedAt: row.updated_at, version: row.version });
}

function createSiegeRepository(deps) {
  const journal = deps && deps.journal;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("siegeRepository: journal");
  }
  const ids = deps.ids;
  if (!ids || typeof ids.next !== "function") throw new TypeError("siegeRepository: ids");
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.SIEGES_TABLE_NAME;
    const sat = (c) => `${c} = min(${S.MAX_TOTAL}, ${c} + excluded.${c})`;
    s = {
      updates: new Map(),
      byId: db.prepare(`SELECT * FROM ${T} WHERE siege_id = ?`),
      openByStation: db.prepare(`SELECT * FROM ${T} WHERE station_id = ? AND open = 1`),
      lastByStation: db.prepare(`SELECT * FROM ${T} WHERE station_id = ? ORDER BY siege_no DESC LIMIT 1`),
      lastByStationAttacker: db.prepare(`SELECT * FROM ${T} INDEXED BY world_station_sieges_no
        WHERE station_id = ? AND attacker_faction_id = ? ORDER BY siege_no DESC LIMIT 1`),
      maxNo: db.prepare(`SELECT coalesce(max(siege_no), 0) AS n FROM ${T} WHERE station_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (siege_id, idempotency_key, station_id, siege_no, system_id,
        owner_faction_id, attacker_faction_id, state, open, phase_seq, wait_round, phase_started_at, phase_ends_at,
        plan_json, attacker_ships, attacker_strength, lost_items, lost_units, started_at, ended_at, end_reason,
        created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL, ?, ?, 1)`),
      wait: db.prepare(`UPDATE ${T} SET wait_round = ?, updated_at = ?, version = version + 1
        WHERE siege_id = ? AND version = ?`),
      listOpen: db.prepare(`SELECT * FROM ${T} INDEXED BY world_station_sieges_open WHERE open = 1 AND siege_id > ?
        ORDER BY siege_id LIMIT ?`),
      openInSystem: db.prepare(`SELECT * FROM ${T} WHERE system_id = ? AND open = 1 ORDER BY siege_id`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE open = 1`),
      countAttacker: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE attacker_faction_id = ? AND open = 1`),
      pruneIds: db.prepare(`SELECT siege_id FROM ${T} AS a WHERE ended_at IS NOT NULL AND ended_at < ?
        AND EXISTS (SELECT 1 FROM ${T} AS b WHERE b.station_id = a.station_id AND b.siege_no > a.siege_no)
        ORDER BY ended_at, siege_id LIMIT ?`),
      deleteSiege: db.prepare(`DELETE FROM ${T} WHERE siege_id = ?`),
      totalsUpsert: db.prepare(`INSERT INTO ${S.TOTALS_TABLE_NAME} (faction_id, ${TOTAL_FIELDS.join(", ")},
        updated_at, version) VALUES (?, ${TOTAL_FIELDS.map(() => "?").join(", ")}, ?, 1)
        ON CONFLICT (faction_id) DO UPDATE SET ${TOTAL_FIELDS.map(sat).join(", ")},
        updated_at = excluded.updated_at, version = version + 1`),
      totalsOf: db.prepare(`SELECT * FROM ${S.TOTALS_TABLE_NAME} WHERE faction_id = ?`),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function addTotals(db, factionId, deltas, at) {
    stmts(db).totalsUpsert.run(toBind(factionId),
      ...TOTAL_FIELDS.map((k) => toBind(Math.min(S.MAX_TOTAL, deltas[k] || 0))), toBind(at));
  }

  function createSiege(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(key, S.MAX_KEY_LENGTH)) return invalid("key");
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    if (found.found) {
      if (found.entry.kind === KIND_APPLY && found.entry.aggregateType === S.SIEGE_AGGREGATE) {
        return { ok: true, siegeId: found.entry.aggregateId, duplicate: true };
      }
      return { ok: false, reason: "IDEMPOTENCY_CONFLICT", detail: key };
    }
    if (!spec || !isText(spec.stationId, S.MAX_ID_LENGTH) || !isId(spec.siegeNo) || !isId(spec.systemId)
      || !isId(spec.ownerFactionId) || !isId(spec.attackerFactionId)
      || spec.ownerFactionId === spec.attackerFactionId || !S.OPEN_SIEGE_STATES.includes(spec.state)
      || !isTime(spec.at) || !isTime(spec.phaseEndsAt) || spec.phaseEndsAt < spec.at
      || !isCount(spec.attackerShips) || !isCount(spec.attackerStrength) || !spec.plan || typeof spec.plan !== "object") {
      return invalid("spec");
    }
    const planJson = JSON.stringify(spec.plan);
    if (Buffer.byteLength(planJson, "utf8") > S.MAX_PLAN_BYTES) return invalid("plan");
    const siegeId = ids.next("sg");
    const payload = { stationId: spec.stationId, siegeNo: spec.siegeNo, systemId: spec.systemId,
      ownerFactionId: spec.ownerFactionId, attackerFactionId: spec.attackerFactionId, state: spec.state };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.SIEGE_AGGREGATE, id: siegeId },
      eventType: S.EVENT_SIEGE_STARTED, payload }, (db) => {
      const s = stmts(db);
      if (s.openByStation.get(spec.stationId)) return { ok: false, reason: "SIEGE_OPEN", stationId: spec.stationId };
      s.insert.run(siegeId, key, spec.stationId, toBind(spec.siegeNo), toBind(spec.systemId),
        toBind(spec.ownerFactionId), toBind(spec.attackerFactionId), spec.state, toBind(spec.at),
        toBind(spec.phaseEndsAt), planJson, toBind(spec.attackerShips), toBind(spec.attackerStrength),
        toBind(spec.at), toBind(spec.at), toBind(spec.at));
      addTotals(db, spec.attackerFactionId, { started: 1 }, spec.at);
      addTotals(db, spec.ownerFactionId, { besieged: 1 }, spec.at);
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, siegeId, duplicate: r.duplicate === true };
  }

  function transitionSiege(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(key, S.MAX_KEY_LENGTH + 64)) return invalid("key");
    if (!change || !isText(change.siegeId, S.MAX_ID_LENGTH)) return invalid("siegeId");
    if (!isId(change.expectedVersion)) return invalid("expectedVersion");
    if (!isTime(change.at)) return invalid("at");
    const edge = canTransitionSiege(change.from, change.to);
    if (!edge.ok) return edge;
    const patch = change.patch || {};
    const sets = [];
    const values = [];
    for (const k of Object.keys(patch).sort()) {
      const spec = PATCH[k];
      if (!spec || !spec[1](patch[k])) return invalid(`patch.${k}`);
      sets.push(`${spec[0]} = ?`);
      values.push(toBind(patch[k]));
    }
    const closing = S.END_SIEGE_STATES.includes(change.to);
    const payload = { siegeId: change.siegeId, from: change.from, to: change.to, patch: { ...patch } };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.SIEGE_AGGREGATE, id: change.siegeId },
      eventType: S.EVENT_SIEGE_TRANSITION, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.siegeId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", siegeId: change.siegeId };
      if (row.state !== change.from) return { ok: false, reason: "STATE_MISMATCH", expected: change.from,
        actual: row.state };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      const sql = `UPDATE ${S.SIEGES_TABLE_NAME} SET ${[...sets, "state = ?", "open = ?", "updated_at = ?",
        "version = version + 1"].join(", ")} WHERE siege_id = ? AND version = ?`;
      if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
      s.updates.get(sql).run(...values, change.to, toBind(closing ? 0 : 1), toBind(change.at), change.siegeId,
        toBind(change.expectedVersion));
      const ends = END_TOTALS[change.to];
      if (ends) {
        addTotals(db, row.attacker_faction_id, Object.fromEntries(ends[0].map((k) => [k, 1])), change.at);
        const owner = Object.fromEntries(ends[1].map((k) => [k, 1]));
        if (STOCK_ENDS.includes(change.to) && isCount(patch.lostUnits)) owner.stock_units_lost = patch.lostUnits;
        addTotals(db, row.owner_faction_id, owner, change.at);
      }
      return { ok: true, siege: toSiege(s.byId.get(change.siegeId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(change.siegeId);
      return { ok: true, duplicate: true, siege: row ? toSiege(row) : null };
    }
    changes += 1;
    return { ok: true, duplicate: false, siege: r.value.siege };
  }

  function noteWait(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(key, S.MAX_KEY_LENGTH + 64)) return invalid("key");
    if (!change || !isText(change.siegeId, S.MAX_ID_LENGTH) || !isCount(change.waitRound)
      || !isId(change.expectedVersion) || !isTime(change.at)) {
      return invalid("wait");
    }
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.SIEGE_AGGREGATE, id: change.siegeId },
      eventType: S.EVENT_SIEGE_WAIT, payload: { siegeId: change.siegeId, waitRound: change.waitRound } }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.siegeId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", siegeId: change.siegeId };
      if (row.open !== 1) return { ok: false, reason: "STATE_MISMATCH", actual: row.state };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      s.wait.run(toBind(change.waitRound), toBind(change.at), change.siegeId, toBind(change.expectedVersion));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
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
    if (f !== null && !isId(f)) return invalid("attackerFactionId");
    const s = stmts(tx);
    const row = f === null ? s.countAll.get() : s.countAttacker.get(toBind(f));
    return { ok: true, count: row.n };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    createSiege,
    transitionSiege,
    noteWait,
    pruneEnded,
    countOpen,
    getSiege: (tx, siegeId) => read(tx, (s) => {
      if (!isText(siegeId, S.MAX_ID_LENGTH)) return invalid("siegeId");
      const row = s.byId.get(siegeId);
      return { ok: true, siege: row ? toSiege(row) : null };
    }),
    getOpenByStation: (tx, stationId) => read(tx, (s) => {
      if (!isText(stationId, S.MAX_ID_LENGTH)) return invalid("stationId");
      const row = s.openByStation.get(stationId);
      return { ok: true, siege: row ? toSiege(row) : null };
    }),
    getLastByStation: (tx, stationId) => read(tx, (s) => {
      if (!isText(stationId, S.MAX_ID_LENGTH)) return invalid("stationId");
      const row = s.lastByStation.get(stationId);
      return { ok: true, siege: row ? toSiege(row) : null };
    }),
    getLastByStationAttacker: (tx, stationId, attackerFactionId) => read(tx, (s) => {
      if (!isText(stationId, S.MAX_ID_LENGTH)) return invalid("stationId");
      if (!isId(attackerFactionId)) return invalid("attackerFactionId");
      const row = s.lastByStationAttacker.get(stationId, toBind(attackerFactionId));
      return { ok: true, siege: row ? toSiege(row) : null };
    }),
    nextSiegeNo: (tx, stationId) => read(tx, (s) => {
      if (!isText(stationId, S.MAX_ID_LENGTH)) return invalid("stationId");
      return { ok: true, siegeNo: s.maxNo.get(stationId).n + 1 };
    }),
    listOpen: (tx, opts) => read(tx, (s) => {
      const limit = opts && isCount(opts.limit) ? opts.limit : 0;
      const rows = s.listOpen.all((opts && opts.afterSiegeId) || "", toBind(limit + 1));
      return { ok: true, sieges: rows.slice(0, limit).map(toSiege), truncated: rows.length > limit };
    }),
    listOpenInSystem: (tx, systemId) => read(tx, (s) => {
      if (!isId(systemId)) return invalid("systemId");
      return { ok: true, sieges: s.openInSystem.all(toBind(systemId)).map(toSiege) };
    }),
    readTotals: (tx, factionId) => read(tx, (s) => {
      if (!isId(factionId)) return invalid("factionId");
      const row = s.totalsOf.get(toBind(factionId));
      return { ok: true, totals: row ? toTotals(row) : null };
    }),
    getChangeCount: () => changes,
  });
}

module.exports = { createSiegeRepository, toSiege };
