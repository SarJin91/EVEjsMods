"use strict";

const { KIND_APPLY } = require("../../persistence/journal");
const { toBind, stateListSql } = require("../../persistence/repository");
const S = require("./schema");
const { canTransitionBuild } = require("./buildMachine");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const OPEN_LIT = stateListSql(S.OPEN_BUILD_STATES, S.OPEN_BUILD_STATES);
const COUNT_SQL = Object.freeze({
  all: (lit) => `SELECT count(*) AS n FROM ${S.BUILDS_TABLE_NAME} WHERE state IN ${lit}`,
  faction: (lit) => `SELECT count(*) AS n FROM ${S.BUILDS_TABLE_NAME} WHERE state IN ${lit} AND faction_id = ?`,
  system: (lit) => `SELECT count(*) AS n FROM ${S.BUILDS_TABLE_NAME} WHERE state IN ${lit} AND system_id = ?`,
  factionSystem: (lit) => `SELECT count(*) AS n FROM ${S.BUILDS_TABLE_NAME} WHERE state IN ${lit}
    AND faction_id = ? AND system_id = ?`,
});
const CARGO_KEY_RE = /^[a-z]{1,16}\/[a-z]{1,16}:[0-9a-z_]{1,32}$/;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isCargo = (v, min) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).every((k) => CARGO_KEY_RE.test(k) && Number.isSafeInteger(v[k]) && v[k] >= min);
const nullOr = (check) => (v) => v === null || check(v);
const PATCH = Object.freeze({
  phaseSeq: ["phase_seq", isCount],
  watchRound: ["watch_round", isCount],
  delivered: ["delivered_json", (v) => isCargo(v, 0)],
  convoysDelivered: ["convoys_delivered", isCount],
  convoysLost: ["convoys_lost", isCount],
  lostUnits: ["lost_units", isCount],
  surplusUnits: ["surplus_units", isCount],
  anchorStartedAt: ["anchor_started_at", nullOr(isTime)],
  anchorUntilAt: ["anchor_until_at", nullOr(isTime)],
  endedAt: ["ended_at", nullOr(isTime)],
  endReason: ["end_reason", nullOr((v) => isText(v, S.MAX_END_REASON_LENGTH))],
});
const JSON_FIELDS = Object.freeze(["delivered"]);

const invalid = (detail) => ({ ok: false, reason: "CONSTRUCTION_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;

function toBuild(row) {
  return Object.freeze({
    stationId: row.station_id, idempotencyKey: row.idempotency_key, factionId: row.faction_id,
    systemId: row.system_id, kitId: row.kit_id, state: row.state, phaseSeq: row.phase_seq,
    watchRound: row.watch_round, required: Object.freeze(JSON.parse(row.required_json)),
    delivered: Object.freeze(JSON.parse(row.delivered_json)), convoysDelivered: row.convoys_delivered,
    convoysLost: row.convoys_lost, lostUnits: row.lost_units, surplusUnits: row.surplus_units,
    supplyDeadlineAt: row.supply_deadline_at, anchorStartedAt: row.anchor_started_at,
    anchorUntilAt: row.anchor_until_at, endedAt: row.ended_at, endReason: row.end_reason, createdAt: row.created_at,
    updatedAt: row.updated_at, version: row.version,
  });
}

function createBuildRepository(deps) {
  const journal = deps && deps.journal;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("buildRepository: journal");
  }
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.BUILDS_TABLE_NAME;
    const open = `state IN ${OPEN_LIT}`;
    s = {
      updates: new Map(),
      byId: db.prepare(`SELECT * FROM ${T} WHERE station_id = ?`),
      openAt: db.prepare(`SELECT station_id FROM ${T} WHERE faction_id = ? AND system_id = ? AND ${open}`),
      insert: db.prepare(`INSERT INTO ${T} (station_id, idempotency_key, faction_id, system_id, kit_id, state,
        phase_seq, watch_round, required_json, delivered_json, convoys_delivered, convoys_lost, lost_units,
        surplus_units, supply_deadline_at, anchor_started_at, anchor_until_at, ended_at, end_reason, created_at,
        updated_at, version)
        VALUES (?, ?, ?, ?, ?, 'SUPPLYING', 0, 0, ?, '{}', 0, 0, 0, 0, ?, NULL, NULL, NULL, NULL, ?, ?, 1)`),
      watch: db.prepare(`UPDATE ${T} SET watch_round = ?, updated_at = ?, version = version + 1
        WHERE station_id = ? AND version = ?`),
      listOpen: db.prepare(`SELECT * FROM ${T} WHERE ${open} AND station_id > ? ORDER BY station_id LIMIT ?`),
      openOfFaction: db.prepare(`SELECT * FROM ${T} WHERE faction_id = ? AND state IN ${OPEN_LIT}
        ORDER BY station_id LIMIT ?`),
      lastOfFaction: db.prepare(`SELECT MAX(created_at) AS at FROM ${T} WHERE faction_id = ?`),
      counts: new Map(),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function buildIdOfKey(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    if (found.found && found.entry.kind === KIND_APPLY && found.entry.aggregateType === S.BUILD_AGGREGATE) {
      return { ok: true, stationId: found.entry.aggregateId, duplicate: true };
    }
    if (found.found) return { ok: false, reason: "IDEMPOTENCY_CONFLICT", detail: key };
    return { ok: true, stationId: null, duplicate: false };
  }

  function createBuild(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isText(spec.stationId, S.MAX_ID_LENGTH) || !isText(spec.idempotencyKey, S.MAX_KEY_LENGTH)
      || !isId(spec.factionId) || !isId(spec.systemId) || !isText(spec.kitId, S.MAX_KIT_ID_LENGTH)
      || !isCargo(spec.required, 1) || Object.keys(spec.required).length === 0 || !isTime(spec.supplyDeadlineAt)
      || !isTime(spec.at)) {
      return invalid("spec");
    }
    const payload = { stationId: spec.stationId, factionId: spec.factionId, systemId: spec.systemId,
      kitId: spec.kitId };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.BUILD_AGGREGATE, id: spec.stationId },
      eventType: S.EVENT_BUILD_CREATED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(spec.stationId)) return { ok: false, reason: "BUILD_EXISTS", stationId: spec.stationId };
      if (s.openAt.get(toBind(spec.factionId), toBind(spec.systemId))) {
        return { ok: false, reason: "BUILD_OPEN_IN_SYSTEM" };
      }
      s.insert.run(spec.stationId, spec.idempotencyKey, toBind(spec.factionId), toBind(spec.systemId), spec.kitId,
        JSON.stringify(spec.required), toBind(spec.supplyDeadlineAt), toBind(spec.at), toBind(spec.at));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true, stationId: spec.stationId };
  }

  function transitionBuild(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.stationId, S.MAX_ID_LENGTH)) return invalid("stationId");
    if (!isId(change.expectedVersion)) return invalid("expectedVersion");
    if (!isTime(change.at)) return invalid("at");
    const edge = canTransitionBuild(change.from, change.to);
    if (!edge.ok) return edge;
    const patch = change.patch || {};
    const sets = [];
    const values = [];
    for (const k of Object.keys(patch).sort()) {
      const spec = PATCH[k];
      if (!spec || !spec[1](patch[k])) return invalid(`patch.${k}`);
      sets.push(`${spec[0]} = ?`);
      values.push(JSON_FIELDS.includes(k) ? JSON.stringify(patch[k]) : toBind(patch[k]));
    }
    const payload = { stationId: change.stationId, from: change.from, to: change.to,
      ...(typeof patch.endReason === "string" ? { endReason: patch.endReason } : {}) };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.BUILD_AGGREGATE, id: change.stationId },
      eventType: S.EVENT_BUILD_TRANSITION, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.stationId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", stationId: change.stationId };
      if (row.state !== change.from) return { ok: false, reason: "STATE_MISMATCH", expected: change.from,
        actual: row.state };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      const sql = `UPDATE ${S.BUILDS_TABLE_NAME} SET ${[...sets, "state = ?", "updated_at = ?",
        "version = version + 1"].join(", ")} WHERE station_id = ? AND version = ?`;
      if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
      s.updates.get(sql).run(...values, change.to, toBind(change.at), change.stationId,
        toBind(change.expectedVersion));
      return { ok: true, build: toBuild(s.byId.get(change.stationId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(change.stationId);
      return { ok: true, duplicate: true, build: row ? toBuild(row) : null };
    }
    changes += 1;
    return { ok: true, duplicate: false, build: r.value.build };
  }

  function watchBuild(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.stationId, S.MAX_ID_LENGTH) || !S.OPEN_BUILD_STATES.includes(change.state)
      || !isCount(change.watchRound) || !isId(change.expectedVersion) || !isTime(change.at)) {
      return invalid("watch");
    }
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.BUILD_AGGREGATE, id: change.stationId },
      eventType: S.EVENT_BUILD_WAIT, payload: { stationId: change.stationId, state: change.state,
        watchRound: change.watchRound } }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.stationId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", stationId: change.stationId };
      if (row.state !== change.state) return { ok: false, reason: "STATE_MISMATCH", expected: change.state,
        actual: row.state };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      s.watch.run(toBind(change.watchRound), toBind(change.at), change.stationId, toBind(change.expectedVersion));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true };
  }

  function countOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    const states = o.states === undefined ? S.OPEN_BUILD_STATES : o.states;
    if (!Array.isArray(states) || !states.every((st) => S.OPEN_BUILD_STATES.includes(st))) {
      return invalid("opts.states");
    }
    const f = o.factionId === undefined ? null : o.factionId;
    const sys = o.systemId === undefined ? null : o.systemId;
    if ((f !== null && !isId(f)) || (sys !== null && !isId(sys))) return invalid("opts");
    const s = stmts(tx);
    const bySystem = sys !== null ? "system" : "all";
    const kind = f !== null ? (sys !== null ? "factionSystem" : "faction") : bySystem;
    const lit = stateListSql(states, S.OPEN_BUILD_STATES);
    const key = `${kind}|${lit}`;
    let stmt = s.counts.get(key);
    if (!stmt) {
      stmt = tx.prepare(COUNT_SQL[kind](lit));
      s.counts.set(key, stmt);
    }
    let row;
    if (kind === "factionSystem") row = stmt.get(toBind(f), toBind(sys));
    else if (kind === "faction") row = stmt.get(toBind(f));
    else if (kind === "system") row = stmt.get(toBind(sys));
    else row = stmt.get();
    return { ok: true, count: row.n };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    buildIdOfKey,
    createBuild,
    transitionBuild,
    watchBuild,
    countOpen,
    getBuild: (tx, stationId) => read(tx, (s) => {
      const row = s.byId.get(stationId);
      return { ok: true, build: row ? toBuild(row) : null };
    }),
    listOpen: (tx, opts) => read(tx, (s) => ({ ok: true, builds: s.listOpen.all(
      (opts && opts.after) || "", toBind((opts && opts.limit) || 1)).map(toBuild) })),
    listOpenOfFaction: (tx, factionId, limit) => read(tx, (s) => ({ ok: true,
      builds: s.openOfFaction.all(toBind(factionId), toBind(limit)).map(toBuild) })),
    lastCreatedAtOfFaction: (tx, factionId) => (isId(factionId) ? read(tx, (s) => {
      const at = s.lastOfFaction.get(toBind(factionId)).at;
      return { ok: true, at: at === null || at === undefined ? null : Number(at) };
    }) : invalid("factionId")),
    listRecentEnded: (tx, opts) => read(tx, (s) => {
      if (!s.recentEnded) {
        s.recentEnded = tx.prepare(`SELECT * FROM ${S.BUILDS_TABLE_NAME} WHERE ended_at IS NOT NULL
          ORDER BY ended_at DESC, station_id LIMIT ?`);
      }
      return { ok: true, builds: s.recentEnded.all(toBind((opts && opts.limit) || 1)).map(toBuild) };
    }),
    getChangeCount: () => changes,
  });
}

module.exports = { createBuildRepository, toBuild };
