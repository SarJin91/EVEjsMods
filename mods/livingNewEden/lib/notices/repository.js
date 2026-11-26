"use strict";

const S = require("./schema");

function isPosInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isNonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isText(v, max) {
  return typeof v === "string" && v.length >= 1 && v.length <= max;
}

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

function placeholders(n) {
  return new Array(n).fill("?").join(",");
}

function createNoticeRepository() {
  function enqueueItemsInTx(tx, items, now) {
    if (!Array.isArray(items)) return invalid("items");
    if (!isNonNegInt(now)) return invalid("now");
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (!it || typeof it !== "object") return invalid(`items[${i}]`);
      if (!isText(it.eventKey, S.MAX_EVENT_KEY)) return invalid(`items[${i}].eventKey`);
      if (!isPosInt(it.characterId)) return invalid(`items[${i}].characterId`);
      if (!isText(it.kind, S.MAX_KIND)) return invalid(`items[${i}].kind`);
      if (!isNonNegInt(it.systemId)) return invalid(`items[${i}].systemId`);
      if (!isText(it.line, S.MAX_LINE)) return invalid(`items[${i}].line`);
      if (!isNonNegInt(it.eventAt)) return invalid(`items[${i}].eventAt`);
    }
    const find = tx.prepare(`SELECT item_id FROM ${S.ITEMS_TABLE} WHERE event_key = ? AND character_id = ?`);
    const insert = tx.prepare(`INSERT INTO ${S.ITEMS_TABLE} (event_key, character_id, kind, system_id, line, state,
      batch_key, attempts, event_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, 0, ?, ?, ?)`);
    let inserted = 0;
    let duplicates = 0;
    for (const it of items) {
      if (find.get(it.eventKey, it.characterId)) {
        duplicates += 1;
        continue;
      }
      insert.run(it.eventKey, it.characterId, it.kind, it.systemId, it.line, it.eventAt, now, now);
      inserted += 1;
    }
    return { ok: true, inserted, duplicates };
  }

  function listDueCharactersInTx(tx, opts) {
    const o = opts || {};
    if (!isNonNegInt(o.now)) return invalid("now");
    if (!isNonNegInt(o.minMailIntervalMs)) return invalid("minMailIntervalMs");
    if (!isPosInt(o.limit)) return invalid("limit");
    const kinds = o.priorityKinds === undefined ? [] : o.priorityKinds;
    if (!Array.isArray(kinds) || kinds.length > S.MAX_PRIORITY_KINDS || !kinds.every((k) => isText(k, S.MAX_KIND))) {
      return invalid("priorityKinds");
    }
    if (kinds.length > 0) {
      if (!isNonNegInt(o.priorityMinIntervalMs)) return invalid("priorityMinIntervalMs");
      const held = `SELECT 1 FROM ${S.BATCHES_TABLE} b WHERE b.character_id = d.c
        AND (b.state = 'SENDING' OR (b.state = 'SENT' AND b.created_at > ?))`;
      const due = tx.prepare(`SELECT d.c AS c FROM (SELECT i.character_id AS c, MIN(i.item_id) AS first,
          MIN(CASE WHEN i.kind IN (SELECT value FROM json_each(?)) THEN i.item_id END) AS pfirst
          FROM ${S.ITEMS_TABLE} i WHERE i.state = 'PENDING' AND i.kind <> ? GROUP BY i.character_id) d
        WHERE NOT EXISTS (${held}) OR (d.pfirst IS NOT NULL AND NOT EXISTS (${held}))
        ORDER BY (d.pfirst IS NULL) ASC, COALESCE(d.pfirst, d.first) ASC LIMIT ?`)
        .all(JSON.stringify(kinds), S.KIND_HUNT_WARNING, o.now - o.minMailIntervalMs,
          o.now - o.priorityMinIntervalMs, o.limit);
      return { ok: true, characterIds: due.map((r) => Number(r.c)) };
    }
    const rows = tx.prepare(`SELECT i.character_id AS c, MIN(i.item_id) AS first FROM ${S.ITEMS_TABLE} i
      WHERE i.state = 'PENDING' AND i.kind <> ? AND NOT EXISTS (SELECT 1 FROM ${S.BATCHES_TABLE} b
        WHERE b.character_id = i.character_id AND (b.state = 'SENDING' OR (b.state = 'SENT' AND b.created_at > ?)))
      GROUP BY i.character_id ORDER BY first ASC LIMIT ?`)
      .all(S.KIND_HUNT_WARNING, o.now - o.minMailIntervalMs, o.limit);
    return { ok: true, characterIds: rows.map((r) => Number(r.c)) };
  }

  function openBatchInTx(tx, opts) {
    const o = opts || {};
    if (!isPosInt(o.characterId)) return invalid("characterId");
    if (!isPosInt(o.senderId)) return invalid("senderId");
    if (!isNonNegInt(o.now)) return invalid("now");
    if (!isPosInt(o.maxItems)) return invalid("maxItems");
    if (typeof o.render !== "function") return invalid("render");
    if (o.eventKey !== undefined && !isText(o.eventKey, S.MAX_EVENT_KEY)) return invalid("eventKey");
    const kinds = o.priorityKinds === undefined ? [] : o.priorityKinds;
    if (!Array.isArray(kinds) || kinds.length > S.MAX_PRIORITY_KINDS || !kinds.every((k) => isText(k, S.MAX_KIND))) {
      return invalid("priorityKinds");
    }
    let rows;
    if (o.eventKey === undefined && kinds.length > 0) {
      rows = tx.prepare(`SELECT item_id AS id, line, attempts FROM ${S.ITEMS_TABLE}
        WHERE character_id = ? AND state = 'PENDING' AND kind <> ?
        ORDER BY CASE WHEN kind IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END, item_id LIMIT ?`)
        .all(o.characterId, S.KIND_HUNT_WARNING, JSON.stringify(kinds), o.maxItems);
    } else if (o.eventKey === undefined) {
      rows = tx.prepare(`SELECT item_id AS id, line, attempts FROM ${S.ITEMS_TABLE}
        WHERE character_id = ? AND state = 'PENDING' AND kind <> ? ORDER BY item_id ASC LIMIT ?`)
        .all(o.characterId, S.KIND_HUNT_WARNING, o.maxItems);
    } else {
      rows = tx.prepare(`SELECT item_id AS id, line, attempts FROM ${S.ITEMS_TABLE}
        WHERE character_id = ? AND state = 'PENDING' AND event_key = ? ORDER BY item_id ASC LIMIT ?`)
        .all(o.characterId, o.eventKey, o.maxItems);
    }
    if (rows.length === 0) return { ok: true, batch: null };
    const lines = rows.map((r) => String(r.line));
    const text = o.render(lines);
    if (!text || !isText(text.title, S.MAX_TITLE) || typeof text.body !== "string") {
      return { ok: false, reason: "RENDER_INVALID" };
    }
    const batchKey = S.batchKeyOf(o.characterId, o.now);
    if (batchKey.length > S.MAX_BATCH_KEY) return invalid("batchKey");
    const sentDate = S.filetimeOf(o.now);
    const itemIds = rows.map((r) => Number(r.id));
    const attempt = Math.max(...rows.map((r) => Number(r.attempts))) + 1;
    const moved = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'SENDING', batch_key = ?, attempts = attempts + 1,
      updated_at = ? WHERE state = 'PENDING' AND item_id IN (${placeholders(itemIds.length)})`)
      .run(batchKey, o.now, ...itemIds);
    if (Number(moved.changes) !== itemIds.length) return { ok: false, reason: "STATE_MISMATCH", detail: "items" };
    tx.prepare(`INSERT INTO ${S.BATCHES_TABLE} (batch_key, character_id, sender_id, state, sent_date, title, items,
      attempt, message_id, error, created_at, updated_at) VALUES (?, ?, ?, 'SENDING', ?, ?, ?, ?, NULL, NULL, ?, ?)`)
      .run(batchKey, o.characterId, o.senderId, sentDate, text.title, itemIds.length, attempt, o.now, o.now);
    return { ok: true, batch: { batchKey, characterId: o.characterId, senderId: o.senderId, sentDate,
      title: text.title, body: text.body, itemIds } };
  }

  function finishBatchInTx(tx, batchKey, opts) {
    const o = opts || {};
    if (!isText(batchKey, S.MAX_BATCH_KEY)) return invalid("batchKey");
    if (!S.FINISH_OUTCOMES.includes(o.outcome)) return invalid("outcome");
    if (!isNonNegInt(o.now)) return invalid("now");
    if (!isPosInt(o.maxAttempts)) return invalid("maxAttempts");
    if (o.failItems !== undefined && o.failItems !== true && o.failItems !== false) return invalid("failItems");
    if (o.failItems === true && o.outcome !== S.BATCH_STATE.FAILED) return invalid("failItems");
    const messageId = o.outcome === S.BATCH_STATE.SENT && isPosInt(o.messageId) ? o.messageId : null;
    const error = typeof o.error === "string" && o.error.length > 0 ? o.error.slice(0, S.MAX_ERROR) : null;
    const closed = tx.prepare(`UPDATE ${S.BATCHES_TABLE} SET state = ?, message_id = ?, error = ?, updated_at = ?
      WHERE batch_key = ? AND state = 'SENDING'`).run(o.outcome, messageId, error, o.now, batchKey);
    if (Number(closed.changes) !== 1) return { ok: false, reason: "STATE_MISMATCH", detail: "batch" };
    if (o.outcome === S.BATCH_STATE.SENT) {
      const sent = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'SENT', updated_at = ?
        WHERE batch_key = ? AND state = 'SENDING'`).run(o.now, batchKey);
      return { ok: true, outcome: o.outcome, items: Number(sent.changes), requeued: 0, failed: 0 };
    }
    const failed = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'FAILED', updated_at = ?
      WHERE batch_key = ? AND state = 'SENDING' AND (attempts >= ? OR kind = ?)`).run(o.now, batchKey,
      o.failItems === true ? 0 : o.maxAttempts, S.KIND_HUNT_WARNING);
    const requeued = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'PENDING', batch_key = NULL, updated_at = ?
      WHERE batch_key = ? AND state = 'SENDING'`).run(o.now, batchKey);
    const f = Number(failed.changes);
    const r = Number(requeued.changes);
    return { ok: true, outcome: o.outcome, items: f + r, requeued: r, failed: f };
  }

  function cancelBatchInTx(tx, batchKey, opts) {
    const o = opts || {};
    if (!isText(batchKey, S.MAX_BATCH_KEY)) return invalid("batchKey");
    if (!isNonNegInt(o.now)) return invalid("now");
    const gone = tx.prepare(`DELETE FROM ${S.BATCHES_TABLE} WHERE batch_key = ? AND state = 'SENDING'`).run(batchKey);
    if (Number(gone.changes) !== 1) return { ok: false, reason: "STATE_MISMATCH", detail: "batch" };
    const closed = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'FAILED', batch_key = NULL,
      attempts = MAX(attempts - 1, 0), updated_at = ? WHERE batch_key = ? AND state = 'SENDING' AND kind = ?`)
      .run(o.now, batchKey, S.KIND_HUNT_WARNING);
    const back = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'PENDING', batch_key = NULL,
      attempts = MAX(attempts - 1, 0), updated_at = ? WHERE batch_key = ? AND state = 'SENDING'`).run(o.now, batchKey);
    const c = Number(closed.changes);
    return { ok: true, items: c + Number(back.changes), closed: c };
  }

  function listSendingInTx(tx, limit, before) {
    if (!isPosInt(limit)) return invalid("limit");
    if (before !== undefined && !isNonNegInt(before)) return invalid("before");
    const bound = before === undefined ? Number.MAX_SAFE_INTEGER : before;
    const rows = tx.prepare(`SELECT batch_key, character_id, sender_id, sent_date, title, created_at
      FROM ${S.BATCHES_TABLE} WHERE state = 'SENDING' AND created_at < ? ORDER BY created_at ASC, batch_key ASC
      LIMIT ?`).all(bound, limit);
    return { ok: true, batches: rows.map((r) => ({ batchKey: String(r.batch_key), characterId: Number(r.character_id),
      senderId: Number(r.sender_id), sentDate: String(r.sent_date), title: String(r.title),
      createdAt: Number(r.created_at) })) };
  }

  function expireInTx(tx, opts) {
    const o = opts || {};
    if (!isNonNegInt(o.before)) return invalid("before");
    if (!isNonNegInt(o.limit)) return invalid("limit");
    if (!isNonNegInt(o.now)) return invalid("now");
    if (o.limit === 0) return { ok: true, expired: 0 };
    const r = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'EXPIRED', updated_at = ? WHERE item_id IN (
      SELECT item_id FROM ${S.ITEMS_TABLE} WHERE state = 'PENDING' AND event_at < ? ORDER BY item_id ASC LIMIT ?)`)
      .run(o.now, o.before, o.limit);
    return { ok: true, expired: Number(r.changes) };
  }

  function expireUrgentInTx(tx, opts) {
    const o = opts || {};
    if (!isNonNegInt(o.limit)) return invalid("limit");
    if (!isNonNegInt(o.now)) return invalid("now");
    if (o.limit === 0) return { ok: true, expired: 0 };
    const r = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'EXPIRED', updated_at = ? WHERE item_id IN (
      SELECT item_id FROM ${S.ITEMS_TABLE} WHERE state = 'PENDING' AND kind = ? ORDER BY item_id ASC LIMIT ?)`)
      .run(o.now, S.KIND_HUNT_WARNING, o.limit);
    return { ok: true, expired: Number(r.changes) };
  }

  function capPendingInTx(tx, opts) {
    const o = opts || {};
    if (!isPosInt(o.characterId)) return invalid("characterId");
    if (!isNonNegInt(o.max)) return invalid("max");
    if (!isNonNegInt(o.now)) return invalid("now");
    if (o.limit !== undefined && !isNonNegInt(o.limit)) return invalid("limit");
    const row = tx.prepare(`SELECT count(*) AS n FROM ${S.ITEMS_TABLE} WHERE character_id = ? AND state = 'PENDING'`)
      .get(o.characterId);
    const excess = o.limit === undefined ? Number(row.n) - o.max : Math.min(Number(row.n) - o.max, o.limit);
    if (excess <= 0) return { ok: true, dropped: 0 };
    const r = tx.prepare(`UPDATE ${S.ITEMS_TABLE} SET state = 'DROPPED', updated_at = ? WHERE item_id IN (
      SELECT item_id FROM ${S.ITEMS_TABLE} WHERE character_id = ? AND state = 'PENDING' ORDER BY item_id ASC LIMIT ?)`)
      .run(o.now, o.characterId, excess);
    return { ok: true, dropped: Number(r.changes) };
  }

  function pruneInTx(tx, opts) {
    const o = opts || {};
    if (!isNonNegInt(o.before)) return invalid("before");
    if (!isNonNegInt(o.limit)) return invalid("limit");
    if (o.limit === 0) return { ok: true, items: 0, batches: 0 };
    const items = tx.prepare(`DELETE FROM ${S.ITEMS_TABLE} WHERE item_id IN (SELECT item_id FROM ${S.ITEMS_TABLE}
      WHERE state IN ${S.ITEM_TERMINAL_SQL} AND updated_at < ? ORDER BY updated_at ASC LIMIT ?)`)
      .run(o.before, o.limit);
    const batches = tx.prepare(`DELETE FROM ${S.BATCHES_TABLE} WHERE batch_key IN (SELECT batch_key
      FROM ${S.BATCHES_TABLE} WHERE state IN ${S.BATCH_TERMINAL_SQL} AND updated_at < ? ORDER BY updated_at ASC
      LIMIT ?)`).run(o.before, o.limit);
    return { ok: true, items: Number(items.changes), batches: Number(batches.changes) };
  }

  function listImpactContributorsInTx(tx, opts) {
    const o = opts || {};
    if (!isNonNegInt(o.systemId)) return invalid("systemId");
    if (!isNonNegInt(o.since)) return invalid("since");
    if (!isPosInt(o.limit)) return invalid("limit");
    const rows = tx.prepare(`SELECT DISTINCT character_id AS c FROM ${S.ITEMS_TABLE}
      WHERE system_id = ? AND kind = ? AND event_at >= ? ORDER BY character_id ASC LIMIT ?`)
      .all(o.systemId, S.KIND_PLAYER_IMPACT, o.since, o.limit);
    return { ok: true, characterIds: rows.map((r) => Number(r.c)) };
  }

  function listMailEventKeysInTx(tx, opts) {
    const o = opts || {};
    if (!isPosInt(o.characterId)) return invalid("characterId");
    if (!isPosInt(o.messageId)) return invalid("messageId");
    if (!isPosInt(o.limit)) return invalid("limit");
    const batch = tx.prepare(`SELECT batch_key FROM ${S.BATCHES_TABLE} WHERE character_id = ? AND message_id = ?
      AND state = 'SENT' LIMIT 1`).get(o.characterId, o.messageId);
    if (!batch) return { ok: true, eventKeys: [] };
    const rows = tx.prepare(`SELECT DISTINCT event_key AS k FROM ${S.ITEMS_TABLE}
      WHERE batch_key IS NOT NULL AND batch_key = ? ORDER BY event_key ASC LIMIT ?`)
      .all(String(batch.batch_key), o.limit);
    return { ok: true, eventKeys: rows.map((r) => String(r.k)) };
  }

  return Object.freeze({
    enqueueItemsInTx,
    listDueCharactersInTx,
    openBatchInTx,
    finishBatchInTx,
    cancelBatchInTx,
    listSendingInTx,
    expireInTx,
    expireUrgentInTx,
    capPendingInTx,
    pruneInTx,
    listImpactContributorsInTx,
    listMailEventKeysInTx,
  });
}

module.exports = { createNoticeRepository };
