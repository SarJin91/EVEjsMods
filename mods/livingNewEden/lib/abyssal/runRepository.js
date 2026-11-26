"use strict";

const { toBind } = require("../persistence/repository");
const S = require("./schema");
const { EVENT, nextState } = require("./machine");

const MAX_DETAIL = 120;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isMs = (v) => Number.isSafeInteger(v) && v >= 0;
const txMissing = (db) => !db || db.inTransaction !== true;
const failed = (err) => ({ ok: false, reason: "ABYSSAL_SQL_FAILED",
  detail: String((err && err.message) || err).slice(0, MAX_DETAIL) });
const textOrNull = (v) => (typeof v === "string" && v !== "" ? v : null);
const keyOfRow = (row) => (row ? Object.freeze({ instanceId: Number(row.instance_id),
  activatedAtMs: Number(row.activated_at_ms) }) : null);

function validSnapshot(s) {
  return Boolean(s) && isId(s.instanceId) && isMs(s.activatedAtMs) && isId(s.ownerCharacterId)
    && Number.isSafeInteger(s.sourceSystemId) && Number.isSafeInteger(s.hostLocationId)
    && Number.isSafeInteger(s.tier) && Array.isArray(s.participants) && Number.isSafeInteger(s.roomIndex)
    && Number.isSafeInteger(s.pocketsCompleted) && isMs(s.expiresAtMs);
}

function participantsJson(list) {
  return JSON.stringify(list.slice(0, S.MAX_PARTICIPANTS).map((p) => ({ c: p.characterId, t: p.shipTypeId,
    s: String(p.status || "") })));
}

function parseParticipants(text) {
  try {
    const list = JSON.parse(text);
    return Object.freeze(Array.isArray(list) ? list.map((p) => Object.freeze({ characterId: Number(p.c) || 0,
      shipTypeId: Number(p.t) || 0, status: String(p.s || "") })) : []);
  } catch (_err) {
    return Object.freeze([]);
  }
}

function toRun(r) {
  const fin = r.finished_at_ms === null || r.finished_at_ms === undefined ? null : Number(r.finished_at_ms);
  return Object.freeze({ instanceId: Number(r.instance_id), activatedAtMs: Number(r.activated_at_ms),
    ownerCharacterId: Number(r.owner_character_id), sourceSystemId: Number(r.source_system_id),
    hostLocationId: Number(r.host_location_id), tier: Number(r.tier), weather: r.weather || null,
    shipClass: r.ship_class || null, participants: parseParticipants(r.participants_json),
    roomIndex: Number(r.room_index), pocketsCompleted: Number(r.pockets_completed),
    expiresAtMs: Number(r.expires_at_ms), state: r.state, vendorOutcome: r.vendor_outcome || null,
    firstSeenMs: Number(r.first_seen_ms), lastSeenMs: Number(r.last_seen_ms), finishedAtMs: fin,
    version: Number(r.version) });
}

function valuesOf(s) {
  return { owner: s.ownerCharacterId, source: s.sourceSystemId, host: s.hostLocationId, tier: s.tier,
    weather: textOrNull(s.weather), shipClass: textOrNull(s.shipClass), participants: participantsJson(s.participants),
    room: s.roomIndex, pockets: s.pocketsCompleted, expires: s.expiresAtMs };
}

function sameValues(row, v, state, outcome) {
  return Number(row.owner_character_id) === v.owner && Number(row.source_system_id) === v.source
    && Number(row.host_location_id) === v.host && Number(row.tier) === v.tier && (row.weather || null) === v.weather
    && (row.ship_class || null) === v.shipClass && row.participants_json === v.participants
    && Number(row.room_index) === v.room && Number(row.pockets_completed) === v.pockets
    && Number(row.expires_at_ms) === v.expires && row.state === state && (row.vendor_outcome || null) === outcome;
}

function createAbyssalRunRepository(opts = {}) {
  const store = opts.store || null;
  const maxListRows = isId(opts.maxListRows) ? opts.maxListRows : S.MAX_LIST_ROWS_DEFAULT;
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE_NAME;
    s = {
      byKey: db.prepare(`SELECT * FROM ${T} WHERE instance_id = ? AND activated_at_ms = ?`),
      newestOfInstance: db.prepare(`SELECT * FROM ${T} WHERE instance_id = ? ORDER BY activated_at_ms DESC LIMIT 1`),
      openOfInstance: db.prepare(`SELECT * FROM ${T} WHERE instance_id = ? AND ${S.OPEN_SQL}
        ORDER BY activated_at_ms DESC LIMIT 1`),
      insert: db.prepare(`INSERT INTO ${T} (instance_id, activated_at_ms, owner_character_id, source_system_id,
        host_location_id, tier, weather, ship_class, participants_json, room_index, pockets_completed, expires_at_ms,
        state, vendor_outcome, first_seen_ms, last_seen_ms, finished_at_ms, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`),
      update: db.prepare(`UPDATE ${T} SET owner_character_id = ?, source_system_id = ?, host_location_id = ?, tier = ?,
        weather = ?, ship_class = ?, participants_json = ?, room_index = ?, pockets_completed = ?, expires_at_ms = ?,
        state = ?, vendor_outcome = ?, last_seen_ms = ?, finished_at_ms = ?, version = version + 1
        WHERE instance_id = ? AND activated_at_ms = ? AND version = ?`),
      lost: db.prepare(`UPDATE ${T} SET state = ?, finished_at_ms = ?, version = version + 1
        WHERE instance_id = ? AND activated_at_ms = ? AND version = ?`),
      open: db.prepare(`SELECT * FROM ${T} WHERE ${S.OPEN_SQL} ORDER BY last_seen_ms, instance_id LIMIT ?`),
      finishedAsc: db.prepare(`SELECT * FROM ${T} WHERE ${S.FINISHED_SQL} AND finished_at_ms > ?
        ORDER BY finished_at_ms, instance_id LIMIT ?`),
      finishedDesc: db.prepare(`SELECT * FROM ${T} WHERE ${S.FINISHED_SQL} AND finished_at_ms > ?
        ORDER BY finished_at_ms DESC, instance_id DESC LIMIT ?`),
      count: db.prepare(`SELECT count(*) AS n FROM ${T}`),
      prune: db.prepare(`DELETE FROM ${T} WHERE rowid IN (SELECT rowid FROM ${T} WHERE ${S.FINISHED_SQL}
        ORDER BY finished_at_ms, instance_id LIMIT ?)`),
    };
    cache.set(db, s);
    return s;
  }

  function rowOf(db, s) {
    const st = stmts(db);
    if (s.activatedAtMs > 0) return st.byKey.get(toBind(s.instanceId), toBind(s.activatedAtMs)) || null;
    return st.openOfInstance.get(toBind(s.instanceId)) || st.newestOfInstance.get(toBind(s.instanceId)) || null;
  }

  function insertRow(db, s, state, outcome, nowMs, finishedAtMs) {
    const v = valuesOf(s);
    const activatedAtMs = s.activatedAtMs > 0 ? s.activatedAtMs : nowMs;
    stmts(db).insert.run(toBind(s.instanceId), toBind(activatedAtMs), toBind(v.owner),
      toBind(v.source), toBind(v.host), toBind(v.tier), v.weather, v.shipClass, v.participants, toBind(v.room),
      toBind(v.pockets), toBind(v.expires), state, outcome, toBind(nowMs), toBind(nowMs),
      finishedAtMs === null ? null : toBind(finishedAtMs));
    return Object.freeze({ instanceId: s.instanceId, activatedAtMs });
  }

  function updateRow(db, row, s, state, outcome, nowMs, finishedAtMs) {
    const v = valuesOf(s);
    const info = stmts(db).update.run(toBind(v.owner), toBind(v.source), toBind(v.host), toBind(v.tier), v.weather,
      v.shipClass, v.participants, toBind(v.room), toBind(v.pockets), toBind(v.expires), state, outcome, toBind(nowMs),
      finishedAtMs === null ? null : toBind(finishedAtMs), toBind(Number(row.instance_id)),
      toBind(Number(row.activated_at_ms)), toBind(Number(row.version)));
    return info.changes === 1;
  }

  function observeInTx(db, s, nowMs) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!validSnapshot(s) || !isMs(nowMs)) return { ok: false, reason: "INVALID_INPUT", detail: "snapshot" };
    try {
      const row = rowOf(db, s);
      const next = nextState(row ? row.state : null, { kind: EVENT.POLL, outcome: s.vendorOutcome });
      if (!next.ok) return { ok: false, reason: "FINISHED" };
      const outcome = textOrNull(s.vendorOutcome) || (row ? row.vendor_outcome || null : null);
      const finishedAtMs = next.final ? nowMs : null;
      if (!row) {
        const key = insertRow(db, s, next.state, outcome, nowMs, finishedAtMs);
        return { ok: true, changed: true, state: next.state, key };
      }
      const key = keyOfRow(row);
      if (sameValues(row, valuesOf(s), next.state, outcome)) return { ok: true, changed: false, state: next.state, key };
      if (!updateRow(db, row, s, next.state, outcome, nowMs, finishedAtMs)) return { ok: false, reason: "STALE_VERSION" };
      return { ok: true, changed: true, state: next.state, key };
    } catch (err) {
      return failed(err);
    }
  }

  function markExitedInTx(db, s, nowMs) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!validSnapshot(s) || !isMs(nowMs)) return { ok: false, reason: "INVALID_INPUT", detail: "snapshot" };
    try {
      const row = rowOf(db, s);
      const next = nextState(row ? row.state : null, { kind: EVENT.EXITED });
      if (!next.ok) return { ok: true, changed: false, key: keyOfRow(row) };
      const outcome = textOrNull(s.vendorOutcome) || "exited";
      if (!row) return { ok: true, changed: true, key: insertRow(db, s, next.state, outcome, nowMs, nowMs) };
      if (!updateRow(db, row, s, next.state, outcome, nowMs, nowMs)) return { ok: false, reason: "STALE_VERSION" };
      return { ok: true, changed: true, key: keyOfRow(row) };
    } catch (err) {
      return failed(err);
    }
  }

  function markLostInTx(db, key, nowMs) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!key || !isId(key.instanceId) || !isMs(key.activatedAtMs) || !isMs(nowMs)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "key" };
    }
    try {
      const st = stmts(db);
      const row = st.byKey.get(toBind(key.instanceId), toBind(key.activatedAtMs)) || null;
      if (!row) return { ok: true, changed: false };
      const next = nextState(row.state, { kind: EVENT.LOST });
      if (!next.ok) return { ok: true, changed: false };
      const info = st.lost.run(next.state, toBind(nowMs), toBind(key.instanceId), toBind(key.activatedAtMs),
        toBind(Number(row.version)));
      if (info.changes !== 1) return { ok: false, reason: "STALE_VERSION" };
      return { ok: true, changed: true };
    } catch (err) {
      return failed(err);
    }
  }

  function pruneInTx(db, maxRows, batch) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(maxRows) || !isId(batch)) return { ok: false, reason: "INVALID_INPUT", detail: "maxRows/batch" };
    try {
      const st = stmts(db);
      const total = Number((st.count.get() || {}).n || 0);
      const excess = total - maxRows;
      if (excess <= 0) return { ok: true, pruned: 0 };
      return { ok: true, pruned: st.prune.run(toBind(Math.min(excess, batch))).changes };
    } catch (err) {
      return failed(err);
    }
  }

  function read(name, fn) {
    if (!store || typeof store.transaction !== "function"
      || (typeof store.isOpen === "function" && store.isOpen() !== true)) {
      return { ok: false, reason: "STORE_CLOSED" };
    }
    const r = store.transaction(name, (db) => {
      try {
        return fn(stmts(db));
      } catch (err) {
        return failed(err);
      }
    });
    if (!r.ok) return { ok: false, reason: String(r.reason || "TX_FAILED") };
    return r.value;
  }

  function listActive() {
    return read("abyssal.listActive", (st) => ({ ok: true,
      runs: Object.freeze(st.open.all(toBind(maxListRows)).map(toRun)) }));
  }

  function listFinished(q) {
    const sinceMs = q && q.sinceMs !== undefined ? q.sinceMs : -1;
    const limit = q ? q.limit : undefined;
    if (!Number.isSafeInteger(sinceMs) || sinceMs < -1 || !isId(limit)) return { ok: false, reason: "INVALID_INPUT" };
    const capped = Math.min(limit, maxListRows);
    return read("abyssal.listFinished", (st) => ({ ok: true,
      runs: Object.freeze((q.newest === true ? st.finishedDesc : st.finishedAsc)
        .all(toBind(sinceMs), toBind(capped)).map(toRun)) }));
  }

  function getRun(instanceId) {
    if (!isId(instanceId)) return { ok: false, reason: "INVALID_INPUT" };
    return read("abyssal.getRun", (st) => {
      const row = st.newestOfInstance.get(toBind(instanceId));
      return { ok: true, run: row ? toRun(row) : null };
    });
  }

  return Object.freeze({ observeInTx, markExitedInTx, markLostInTx, pruneInTx, listActive, listFinished, getRun });
}

module.exports = { createAbyssalRunRepository, toRun, participantsJson };
