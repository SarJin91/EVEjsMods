"use strict";

const { toBind } = require("../persistence/repository");
const { createAbortSentinel } = require("../persistence/store");
const S = require("./schema");

const EVENTS_ABORT = createAbortSentinel("shipAi.events");
const MS_PER_MINUTE = 60000;
const MAX_KEY_CHARS = 80;
const SEC_RANK = Object.freeze({ highsec: 0, lowsec: 1, nullsec: 2, wormhole: 2 });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const txMissing = (db) => !db || db.inTransaction !== true;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const failed = (err) => ({ ok: false, reason: "SHIP_AI_SQL_FAILED",
  detail: String((err && err.message) || err).slice(0, 120) });
const minuteOf = (ms) => Math.floor(ms / MS_PER_MINUTE);

function payloadJson(payload) {
  const value = payload && typeof payload === "object" ? { ...payload } : {};
  let json = JSON.stringify(value);
  while (json.length > S.EVENT_PAYLOAD_MAX_CHARS) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    keys.sort((a, b) => String(value[b]).length - String(value[a]).length);
    delete value[keys[0]];
    json = JSON.stringify(value);
  }
  return json;
}

function toRow(r) {
  let payload = {};
  try {
    const parsed = JSON.parse(String(r.payload));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch (_err) {
    payload = {};
  }
  return Object.freeze({ key: String(r.event_key), kind: String(r.kind), payload: Object.freeze(payload),
    occurredAt: Number(r.occurred_at),
    mentionedAt: r.mentioned_at === null || r.mentioned_at === undefined ? null : Number(r.mentioned_at) });
}

const WATCH_SQL = S.WATCH_KINDS.map((k) => `'${k}'`).join(", ");
const nonNegative = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

function watchKeepMsOf(settings) {
  const s = settings || {};
  return Math.max(nonNegative(s.watchLookbackMs), nonNegative(s.missionWarnMs), nonNegative(s.watchPendingMaxAgeMs));
}

function createShipAiEventsRepository(settings) {
  const keep = settings && isId(settings.eventsKeep) ? settings.eventsKeep : 1;
  const watchKeepMs = watchKeepMsOf(settings);
  const cache = new WeakMap();
  let lastFailure = null;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.EVENTS_TABLE;
    s = {
      insert: db.prepare(`INSERT OR IGNORE INTO ${T} (player_character_id, event_key, kind, payload, occurred_at,
        mentioned_at) VALUES (?, ?, ?, ?, ?, NULL)`),
      prune: db.prepare(`DELETE FROM ${T} WHERE player_character_id = ? AND kind NOT IN (${WATCH_SQL})
        AND event_key NOT IN (SELECT event_key FROM ${T} WHERE player_character_id = ? AND kind NOT IN (${WATCH_SQL})
        ORDER BY occurred_at DESC, event_key DESC LIMIT ?)`),
      pruneWatch: db.prepare(`DELETE FROM ${T} WHERE player_character_id = ? AND kind IN (${WATCH_SQL})
        AND occurred_at < ? AND event_key NOT IN (SELECT event_key FROM ${T} WHERE player_character_id = ?
        AND kind IN (${WATCH_SQL}) ORDER BY occurred_at DESC, event_key DESC LIMIT ?)`),
      recent: db.prepare(`SELECT * FROM ${T} WHERE player_character_id = ? ORDER BY occurred_at DESC, event_key DESC
        LIMIT ?`),
      fresh: db.prepare(`SELECT * FROM ${T} WHERE player_character_id = ? AND mentioned_at IS NULL AND occurred_at >= ?
        AND kind <> 'LOSS_POD' ORDER BY occurred_at DESC, event_key DESC LIMIT 1`),
      mentionKey: db.prepare(`UPDATE ${T} SET mentioned_at = ? WHERE player_character_id = ? AND event_key = ?
        AND mentioned_at IS NULL`),
      mentionKind: db.prepare(`UPDATE ${T} SET mentioned_at = ? WHERE player_character_id = ? AND kind = ?
        AND mentioned_at IS NULL`),
      pendingPods: db.prepare(`SELECT DISTINCT player_character_id AS p FROM ${T} WHERE kind = 'LOSS_POD'
        AND mentioned_at IS NULL ORDER BY p LIMIT ?`),
      delAll: db.prepare(`DELETE FROM ${T} WHERE player_character_id = ?`),
      unmentioned: db.prepare(`SELECT * FROM ${T} WHERE player_character_id = ? AND occurred_at >= ?
        AND mentioned_at IS NULL ORDER BY occurred_at DESC, event_key DESC`),
    };
    cache.set(db, s);
    return s;
  }

  function noteEventInTx(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || !S.EVENT_KINDS.includes(s.kind) || typeof s.key !== "string" || s.key === ""
      || s.key.length > MAX_KEY_CHARS || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "event" };
    }
    try {
      const st = stmts(tx);
      const inserted = Number(st.insert.run(toBind(s.playerId), s.key, s.kind, payloadJson(s.payload),
        toBind(s.nowMs)).changes) > 0;
      let pruned = 0;
      if (inserted && S.WATCH_KINDS.includes(s.kind)) {
        pruned = Number(st.pruneWatch.run(toBind(s.playerId), toBind(s.nowMs - watchKeepMs), toBind(s.playerId),
          toBind(keep)).changes);
      } else if (inserted) {
        pruned = Number(st.prune.run(toBind(s.playerId), toBind(s.playerId), toBind(keep)).changes);
      }
      return { ok: true, inserted, pruned };
    } catch (err) {
      lastFailure = failed(err);
      throw EVENTS_ABORT;
    }
  }

  function listRecent(tx, playerId, n) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId) || !Number.isSafeInteger(n) || n < 0) return { ok: false, reason: "INVALID_INPUT" };
    if (n === 0) return { ok: true, rows: [] };
    try {
      return { ok: true, rows: stmts(tx).recent.all(toBind(playerId), toBind(n)).map(toRow) };
    } catch (err) {
      return failed(err);
    }
  }

  function latestFresh(tx, playerId, sinceMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId) || !Number.isSafeInteger(sinceMs)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const r = stmts(tx).fresh.get(toBind(playerId), toBind(sinceMs));
      return { ok: true, row: r ? toRow(r) : null };
    } catch (err) {
      return failed(err);
    }
  }

  function markMentionedInTx(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    const s = spec || {};
    const byKey = typeof s.key === "string" && s.key !== "";
    if (!isId(s.playerId) || !Number.isSafeInteger(s.atMs) || s.atMs < 0
      || (!byKey && !S.EVENT_KINDS.includes(s.kind))) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const st = stmts(tx);
      const run = byKey ? st.mentionKey.run(toBind(s.atMs), toBind(s.playerId), s.key)
        : st.mentionKind.run(toBind(s.atMs), toBind(s.playerId), s.kind);
      return { ok: true, changed: Number(run.changes) };
    } catch (err) {
      lastFailure = failed(err);
      throw EVENTS_ABORT;
    }
  }

  function listPendingPods(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      return { ok: true, playerIds: stmts(tx).pendingPods.all(toBind(limit)).map((r) => Number(r.p)) };
    } catch (err) {
      return failed(err);
    }
  }

  function deleteAllInTx(tx, playerId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      return { ok: true, deleted: Number(stmts(tx).delAll.run(toBind(playerId)).changes) };
    } catch (err) {
      lastFailure = failed(err);
      throw EVENTS_ABORT;
    }
  }

  function listUnmentioned(tx, playerId, kinds, sinceMs, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(playerId) || !Array.isArray(kinds) || !Number.isSafeInteger(sinceMs) || !isId(limit)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const wanted = new Set(kinds);
    try {
      const rows = stmts(tx).unmentioned.all(toBind(playerId), toBind(sinceMs)).map(toRow)
        .filter((r) => wanted.has(r.kind));
      return { ok: true, rows: rows.slice(0, limit) };
    } catch (err) {
      return failed(err);
    }
  }

  return Object.freeze({ noteEventInTx, listRecent, latestFresh, markMentionedInTx, listPendingPods, deleteAllInTx,
    listUnmentioned, lastWriteFailure: () => lastFailure });
}

function createObserver() {
  const views = new Map();
  return Object.freeze({ get: (id) => views.get(id) || null, set: (id, view) => views.set(id, Object.freeze(view)),
    delete: (id) => views.delete(id), has: (id) => views.has(id), keys: () => [...views.keys()],
    size: () => views.size, clear: () => views.clear() });
}

const rankOf = (secClass) => (Object.prototype.hasOwnProperty.call(SEC_RANK, secClass) ? SEC_RANK[secClass] : 0);
const isCapsule = (typeId) => S.CAPSULE_TYPE_IDS.includes(typeId);

function detectEvents(prev, next, nowMs) {
  if (!prev || !next) return [];
  const out = [];
  const min = minuteOf(nowMs);
  const place = { system: next.systemName || null };
  const moved = next.systemId !== prev.systemId;
  if (moved && rankOf(next.secClass) >= 1 && rankOf(next.secClass) > rankOf(prev.secClass)) {
    out.push({ kind: "SYSTEM_DANGER", key: `sys:${next.systemId}:${min}`,
      payload: { ...place, security: next.secClass || null } });
  }
  if (moved && isId(next.regionId) && isId(prev.regionId) && next.regionId !== prev.regionId) {
    out.push({ kind: "REGION_ENTER", key: `region:${next.regionId}:${min}`, payload: { region: next.regionName || null } });
  }
  if (prev.stable === "space" && next.stable === "docked") {
    out.push({ kind: "DOCK", key: `dock:${next.systemId}:${min}`, payload: place });
  } else if (prev.stable === "docked" && next.stable === "space") {
    out.push({ kind: "UNDOCK", key: `undock:${next.systemId}:${min}`, payload: place });
  }
  if (isId(prev.shipTypeId) && isId(next.shipTypeId) && prev.shipTypeId !== next.shipTypeId
    && !isCapsule(next.shipTypeId)) {
    out.push({ kind: "SHIP_CHANGE", key: `ship:${next.shipTypeId}:${min}`,
      payload: { ship: next.shipName || null, class: next.shipClass || null } });
  }
  const hostiles = Number.isSafeInteger(next.hostilesHere) ? next.hostilesHere : 0;
  const before = !moved && Number.isSafeInteger(prev.hostilesHere) ? prev.hostilesHere : 0;
  if (hostiles > 0 && before === 0) {
    out.push({ kind: "HOSTILES", key: `hostiles:${next.systemId}:${min}`, payload: { ...place, fleets: hostiles } });
  }
  return out;
}

function lowHpEvent(view, nowMs, settings) {
  const bucket = Math.floor(nowMs / Math.max(1, settings.lowHpCooldownMs));
  return { kind: "LOW_HP", key: `hp:${bucket}`, payload: { armorPermille: view.armorPermille,
    structurePermille: view.structurePermille } };
}

module.exports = { createShipAiEventsRepository, createObserver, detectEvents, lowHpEvent, payloadJson, isCapsule,
  EVENTS_ABORT, SEC_RANK, watchKeepMsOf };
