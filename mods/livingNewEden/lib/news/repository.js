"use strict";

const S = require("./schema");

const PARAGRAPH_SEP = "\n\n";
const MAX_LIST = 1000;
const MAX_CANDIDATES = 5000;
const MAX_KEYS = 10000;
const MAX_ERROR_CHARS = 200;

function isNonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isPosInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isKey(v) {
  return typeof v === "string" && v.length >= 1 && v.length <= S.MAX_FACT_KEY;
}

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

function bodyOf(paragraphs) {
  return paragraphs.map((p) => String(p).replace(/\s+/g, " ").trim()).filter((p) => p !== "").join(PARAGRAPH_SEP);
}

function paragraphsOf(body) {
  return typeof body === "string" && body !== "" ? body.split(PARAGRAPH_SEP) : [];
}

function factOfRow(r) {
  let data = {};
  try {
    data = JSON.parse(r.data_json);
  } catch (_err) {
    data = {};
  }
  return { factKey: String(r.fact_key), kind: String(r.kind), at: Number(r.at),
    systemId: r.system_id === null ? null : Number(r.system_id), weight: Number(r.weight), data,
    merges: Number(r.merges), editionId: r.edition_id === null ? null : String(r.edition_id),
    selected: Number(r.selected) === 1 };
}

function editionOfRow(r) {
  if (!r) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return { editionId: String(r.edition_id), boundaryAt: Number(r.boundary_at), seq: Number(r.seq),
    state: String(r.state), source: r.source === null ? null : String(r.source), language: String(r.language),
    fallbackTitle: String(r.fallback_title), fallbackParagraphs: paragraphsOf(r.fallback_body),
    title: r.title === null ? null : String(r.title), paragraphs: paragraphsOf(r.body),
    factCount: Number(r.fact_count), aiAttempts: Number(r.ai_attempts),
    aiReason: r.ai_reason === null ? null : String(r.ai_reason), tokens: Number(r.tokens),
    recipients: Number(r.recipients), createdAt: Number(r.created_at), readyAt: num(r.ready_at),
    publishedAt: num(r.published_at), version: Number(r.version) };
}

function validFact(f) {
  return f && typeof f === "object" && isKey(f.factKey) && S.KINDS.includes(f.kind) && isNonNegInt(f.at)
    && (f.systemId === null || isNonNegInt(f.systemId)) && Number.isSafeInteger(f.weight)
    && f.data && typeof f.data === "object" && (f.merge === undefined || f.merge === "battle");
}

function mergedBattle(row, f, weightOf) {
  const old = factOfRow(row);
  const od = old.data || {};
  const nd = f.data || {};
  const destroyed = (Number.isSafeInteger(od.destroyed) ? od.destroyed : 0)
    + (Number.isSafeInteger(nd.destroyed) ? nd.destroyed : 0);
  const countOf = (d) => (Number.isSafeInteger(d.battles) ? d.battles : 1);
  const battles = countOf(od) + countOf(nd);
  const newer = f.at >= old.at;
  const hasLost = Number.isSafeInteger(od.lost) || Number.isSafeInteger(nd.lost);
  const lostOf = (d) => (Number.isSafeInteger(d.lost) ? d.lost : 0);
  const data = { ...od, ...(newer ? { outcome: nd.outcome === undefined ? null : nd.outcome } : {}), destroyed,
    battles, systemName: od.systemName || nd.systemName || null, regionName: od.regionName || nd.regionName || null,
    factionA: od.factionA || nd.factionA || null, factionB: od.factionB || nd.factionB || null,
    ...(hasLost ? { lost: lostOf(od) + lostOf(nd) } : {}) };
  return { at: Math.max(old.at, f.at), data, weight: weightOf(f.kind, data) };
}

function createNewsRepository(deps) {
  const weightOf = deps && typeof deps.weightOf === "function" ? deps.weightOf : (_k, _d) => 0;

  function readStateInTx(tx) {
    const r = tx.prepare(`SELECT journal_cursor AS c, updated_at AS u FROM ${S.STATE_TABLE} WHERE id = 1`).get();
    return { ok: true, state: r ? { cursor: Number(r.c), updatedAt: Number(r.u) } : null };
  }

  function writeCursorInTx(tx, cursor, now) {
    if (!isNonNegInt(cursor)) return invalid("cursor");
    if (!isNonNegInt(now)) return invalid("now");
    tx.prepare(`INSERT INTO ${S.STATE_TABLE} (id, journal_cursor, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET journal_cursor = excluded.journal_cursor, updated_at = excluded.updated_at`)
      .run(cursor, now);
    return { ok: true };
  }

  function upsertFactsInTx(tx, facts, now) {
    if (!Array.isArray(facts)) return invalid("facts");
    if (!isNonNegInt(now)) return invalid("now");
    for (let i = 0; i < facts.length; i += 1) if (!validFact(facts[i])) return invalid(`facts[${i}]`);
    const plain = tx.prepare(`INSERT INTO ${S.FACTS_TABLE} (fact_key, kind, at, system_id, weight, data_json, merges,
      edition_id, selected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 0, ?, ?)
      ON CONFLICT(fact_key) DO NOTHING`);
    const find = tx.prepare(`SELECT * FROM ${S.FACTS_TABLE} WHERE fact_key = ?`);
    const merge = tx.prepare(`INSERT INTO ${S.FACTS_TABLE} (fact_key, kind, at, system_id, weight, data_json, merges,
      edition_id, selected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 0, ?, ?)
      ON CONFLICT(fact_key) DO UPDATE SET merges = lne_news_facts.merges + 1, at = ?, weight = ?, data_json = ?,
        updated_at = ? WHERE lne_news_facts.edition_id IS NULL`);
    let inserted = 0;
    let merged = 0;
    let late = 0;
    let duplicates = 0;
    let tooLarge = 0;
    for (const f of facts) {
      const json = JSON.stringify(f.data);
      if (Buffer.byteLength(json, "utf8") > S.MAX_DATA_BYTES) {
        tooLarge += 1;
        continue;
      }
      if (f.merge !== "battle") {
        const info = plain.run(f.factKey, f.kind, f.at, f.systemId, f.weight, json, now, now);
        if (info.changes > 0) inserted += 1;
        else duplicates += 1;
        continue;
      }
      const row = find.get(f.factKey);
      if (!row) {
        merge.run(f.factKey, f.kind, f.at, f.systemId, f.weight, json, now, now, f.at, f.weight, json, now);
        inserted += 1;
        continue;
      }
      const m = mergedBattle(row, f, weightOf);
      const mergedJson = JSON.stringify(m.data);
      const info = merge.run(f.factKey, f.kind, f.at, f.systemId, f.weight, json, now, now, m.at, m.weight,
        Buffer.byteLength(mergedJson, "utf8") > S.MAX_DATA_BYTES ? row.data_json : mergedJson, now);
      if (info.changes > 0) merged += 1;
      else late += 1;
    }
    return { ok: true, inserted, merged, late, duplicates, tooLarge };
  }

  function readFactsByKeysInTx(tx, keys) {
    if (!Array.isArray(keys) || keys.length > MAX_KEYS || !keys.every(isKey)) return invalid("keys");
    const facts = new Map();
    if (keys.length === 0) return { ok: true, facts };
    const rows = tx.prepare(`SELECT * FROM ${S.FACTS_TABLE} WHERE fact_key IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(keys));
    for (const r of rows) facts.set(String(r.fact_key), factOfRow(r));
    return { ok: true, facts };
  }

  function listOpenFactsInTx(tx, opts) {
    const o = opts || {};
    if (!isNonNegInt(o.before)) return invalid("before");
    const since = o.since === undefined ? 0 : o.since;
    if (!Number.isSafeInteger(since)) return invalid("since");
    if (!isPosInt(o.limit) || o.limit > MAX_CANDIDATES) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.FACTS_TABLE} WHERE edition_id IS NULL AND at < ? AND at >= ?
      ORDER BY at DESC LIMIT ?`).all(o.before, since, o.limit);
    return { ok: true, facts: rows.map(factOfRow) };
  }

  function listRecentFactsInTx(tx, opts) {
    const o = opts || {};
    if (!isNonNegInt(o.since)) return invalid("since");
    if (!isPosInt(o.limit) || o.limit > MAX_CANDIDATES) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.FACTS_TABLE} WHERE at >= ? ORDER BY weight DESC, at DESC, fact_key
      LIMIT ?`).all(o.since, o.limit);
    return { ok: true, facts: rows.map(factOfRow) };
  }

  function getEditionInTx(tx, editionId) {
    if (!isKey(editionId)) return invalid("editionId");
    const r = tx.prepare(`SELECT * FROM ${S.EDITIONS_TABLE} WHERE edition_id = ?`).get(editionId);
    return { ok: true, edition: editionOfRow(r) };
  }

  function latestEditionInTx(tx) {
    const r = tx.prepare(`SELECT * FROM ${S.EDITIONS_TABLE} ORDER BY boundary_at DESC LIMIT 1`).get();
    return { ok: true, edition: editionOfRow(r) };
  }

  function listUnfinishedInTx(tx, opts) {
    const limit = opts && opts.limit;
    if (!isPosInt(limit) || limit > MAX_LIST) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.EDITIONS_TABLE} WHERE state IN ('DRAFTING', 'READY')
      ORDER BY boundary_at ASC LIMIT ?`).all(limit);
    return { ok: true, editions: rows.map(editionOfRow) };
  }

  function nextSeqInTx(tx) {
    const m = tx.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${S.EDITIONS_TABLE} WHERE state <> 'SKIPPED'`).get().m;
    return { ok: true, seq: Number(m) + 1 };
  }

  function openEditionInTx(tx, spec) {
    const o = spec || {};
    if (!isKey(o.editionId)) return invalid("editionId");
    if (!isNonNegInt(o.boundaryAt)) return invalid("boundaryAt");
    if (!S.LANGUAGES.includes(o.language)) return invalid("language");
    if (typeof o.skipped !== "boolean") return invalid("skipped");
    if (!o.fallback || typeof o.fallback.title !== "string" || !Array.isArray(o.fallback.paragraphs)) {
      return invalid("fallback");
    }
    if (!Array.isArray(o.selectedKeys) || !o.selectedKeys.every(isKey)) return invalid("selectedKeys");
    if (!Array.isArray(o.droppedKeys) || !o.droppedKeys.every(isKey)) return invalid("droppedKeys");
    if (!isNonNegInt(o.now)) return invalid("now");
    const known = tx.prepare(`SELECT * FROM ${S.EDITIONS_TABLE} WHERE edition_id = ? OR boundary_at = ?`)
      .get(o.editionId, o.boundaryAt);
    if (known) return { ok: true, created: false, edition: editionOfRow(known) };
    const seq = nextSeqInTx(tx).seq;
    const state = o.skipped ? S.EDITION_STATE.SKIPPED : S.EDITION_STATE.DRAFTING;
    tx.prepare(`INSERT INTO ${S.EDITIONS_TABLE} (edition_id, boundary_at, seq, state, source, language, fallback_title,
      fallback_body, title, body, fact_count, ai_attempts, ai_reason, tokens, recipients, created_at, ready_at,
      published_at, version) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, 0, NULL, 0, 0, ?, NULL, NULL, 1)`)
      .run(o.editionId, o.boundaryAt, seq, state, o.language, o.fallback.title, bodyOf(o.fallback.paragraphs),
        o.selectedKeys.length, o.now);
    const assign = tx.prepare(`UPDATE ${S.FACTS_TABLE} SET edition_id = ?, selected = ?, updated_at = ?
      WHERE fact_key = ? AND edition_id IS NULL`);
    for (const k of o.selectedKeys) assign.run(o.editionId, 1, o.now, k);
    for (const k of o.droppedKeys) assign.run(o.editionId, 0, o.now, k);
    const got = getEditionInTx(tx, o.editionId);
    return got.ok && got.edition ? { ok: true, created: true, edition: got.edition }
      : { ok: false, reason: "EDITION_MISSING" };
  }

  function readyEditionInTx(tx, spec) {
    const o = spec || {};
    if (!isKey(o.editionId)) return invalid("editionId");
    if (!isPosInt(o.expectedVersion)) return invalid("expectedVersion");
    if (!Object.values(S.SOURCE).includes(o.source)) return invalid("source");
    if (typeof o.title !== "string" || o.title === "") return invalid("title");
    if (!Array.isArray(o.paragraphs)) return invalid("paragraphs");
    const tokens = o.tokens === undefined ? 0 : o.tokens;
    if (!isNonNegInt(tokens)) return invalid("tokens");
    if (o.aiReason !== undefined && o.aiReason !== null && typeof o.aiReason !== "string") return invalid("aiReason");
    if (!isNonNegInt(o.now)) return invalid("now");
    const info = tx.prepare(`UPDATE ${S.EDITIONS_TABLE} SET state = 'READY', source = ?, title = ?, body = ?,
      tokens = tokens + ?, ai_reason = COALESCE(?, ai_reason), ready_at = ?, version = version + 1
      WHERE edition_id = ? AND state = 'DRAFTING' AND version = ?`)
      .run(o.source, o.title, bodyOf(o.paragraphs), tokens, o.aiReason === undefined ? null : o.aiReason, o.now,
        o.editionId, o.expectedVersion);
    if (info.changes !== 1) return { ok: false, reason: "STALE" };
    return { ok: true, edition: getEditionInTx(tx, o.editionId).edition };
  }

  function publishEditionInTx(tx, spec) {
    const o = spec || {};
    if (!isKey(o.editionId)) return invalid("editionId");
    if (!isPosInt(o.expectedVersion)) return invalid("expectedVersion");
    if (!isNonNegInt(o.recipients)) return invalid("recipients");
    if (!isNonNegInt(o.now)) return invalid("now");
    const info = tx.prepare(`UPDATE ${S.EDITIONS_TABLE} SET state = 'PUBLISHED', recipients = ?, published_at = ?,
      version = version + 1 WHERE edition_id = ? AND state = 'READY' AND version = ?`)
      .run(o.recipients, o.now, o.editionId, o.expectedVersion);
    if (info.changes !== 1) return { ok: false, reason: "STALE" };
    return { ok: true, edition: getEditionInTx(tx, o.editionId).edition };
  }

  function listEditionFactsInTx(tx, editionId) {
    if (!isKey(editionId)) return invalid("editionId");
    const rows = tx.prepare(`SELECT * FROM ${S.FACTS_TABLE} WHERE edition_id = ? AND selected = 1
      ORDER BY weight DESC, at DESC, fact_key ASC LIMIT ?`).all(editionId, MAX_LIST);
    return { ok: true, facts: rows.map(factOfRow) };
  }

  function attemptEditionInTx(tx, spec) {
    const o = spec || {};
    if (!isKey(o.editionId)) return invalid("editionId");
    if (!isPosInt(o.expectedVersion)) return invalid("expectedVersion");
    const info = tx.prepare(`UPDATE ${S.EDITIONS_TABLE} SET ai_attempts = ai_attempts + 1, version = version + 1
      WHERE edition_id = ? AND state = 'DRAFTING' AND version = ?`).run(o.editionId, o.expectedVersion);
    if (info.changes !== 1) return { ok: false, reason: "STALE" };
    return { ok: true, edition: getEditionInTx(tx, o.editionId).edition };
  }

  function noteAiReasonInTx(tx, spec) {
    const o = spec || {};
    if (!isKey(o.editionId)) return invalid("editionId");
    if (!isPosInt(o.expectedVersion)) return invalid("expectedVersion");
    if (typeof o.aiReason !== "string" || o.aiReason === "") return invalid("aiReason");
    const tokens = o.tokens === undefined ? 0 : o.tokens;
    if (!isNonNegInt(tokens)) return invalid("tokens");
    const info = tx.prepare(`UPDATE ${S.EDITIONS_TABLE} SET ai_reason = ?, tokens = tokens + ?, version = version + 1
      WHERE edition_id = ? AND state = 'DRAFTING' AND version = ?`)
      .run(o.aiReason, tokens, o.editionId, o.expectedVersion);
    if (info.changes !== 1) return { ok: false, reason: "STALE" };
    return { ok: true, edition: getEditionInTx(tx, o.editionId).edition };
  }

  function listEditionsInTx(tx, opts) {
    const limit = opts && opts.limit;
    if (!isPosInt(limit) || limit > MAX_LIST) return invalid("limit");
    const rows = tx.prepare(`SELECT * FROM ${S.EDITIONS_TABLE} ORDER BY boundary_at DESC LIMIT ?`).all(limit);
    return { ok: true, editions: rows.map(editionOfRow) };
  }

  function pruneInTx(tx, opts) {
    const o = opts || {};
    if (!Number.isSafeInteger(o.factsBefore)) return invalid("factsBefore");
    if (!Number.isSafeInteger(o.openBefore)) return invalid("openBefore");
    if (!isPosInt(o.keepEditions)) return invalid("keepEditions");
    if (!isPosInt(o.batch)) return invalid("batch");
    let room = o.batch;
    let facts = 0;
    let editions = 0;
    let deliveries = 0;
    const del = (sql, ...args) => {
      if (room <= 0) return 0;
      const n = tx.prepare(sql).run(...args, room).changes;
      room -= n;
      return n;
    };
    facts += del(`DELETE FROM ${S.FACTS_TABLE} WHERE rowid IN (SELECT rowid FROM ${S.FACTS_TABLE} WHERE at < ?
      LIMIT ?)`, o.factsBefore);
    facts += del(`DELETE FROM ${S.FACTS_TABLE} WHERE rowid IN (SELECT rowid FROM ${S.FACTS_TABLE}
      WHERE edition_id IS NULL AND at < ? LIMIT ?)`, o.openBefore);
    const old = tx.prepare(`SELECT edition_id AS id FROM ${S.EDITIONS_TABLE} ORDER BY boundary_at DESC
      LIMIT ? OFFSET ?`).all(MAX_LIST, o.keepEditions).map((r) => String(r.id));
    for (const id of old) {
      if (room <= 0) break;
      facts += del(`DELETE FROM ${S.FACTS_TABLE} WHERE rowid IN (SELECT rowid FROM ${S.FACTS_TABLE}
        WHERE edition_id = ? LIMIT ?)`, id);
      if (room <= 0) break;
      deliveries += del(`DELETE FROM ${S.DELIVERIES_TABLE} WHERE rowid IN (SELECT rowid FROM ${S.DELIVERIES_TABLE}
        WHERE edition_id = ? LIMIT ?)`, id);
      if (room <= 0) break;
      const left = tx.prepare(`SELECT 1 FROM ${S.FACTS_TABLE} WHERE edition_id = ? LIMIT 1`).get(id)
        || tx.prepare(`SELECT 1 FROM ${S.DELIVERIES_TABLE} WHERE edition_id = ? LIMIT 1`).get(id);
      if (!left) {
        editions += tx.prepare(`DELETE FROM ${S.EDITIONS_TABLE} WHERE edition_id = ?`).run(id).changes;
        room -= 1;
      }
    }
    return { ok: true, facts, editions, deliveries };
  }

  function touchReadersInTx(tx, characterIds, now) {
    if (!Array.isArray(characterIds) || characterIds.length > MAX_KEYS || !characterIds.every(isPosInt)) {
      return invalid("characterIds");
    }
    if (!isNonNegInt(now)) return invalid("now");
    const up = tx.prepare(`INSERT INTO ${S.READERS_TABLE} (character_id, first_seen_at, last_seen_at, opted_out,
      updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(character_id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at`);
    let touched = 0;
    for (const id of characterIds) touched += up.run(id, now, now, now).changes;
    return { ok: true, touched };
  }

  function setOptOutInTx(tx, spec) {
    const o = spec || {};
    if (!isPosInt(o.characterId)) return invalid("characterId");
    if (typeof o.optedOut !== "boolean") return invalid("optedOut");
    if (!isNonNegInt(o.now)) return invalid("now");
    const flag = o.optedOut ? 1 : 0;
    const before = tx.prepare(`SELECT opted_out AS f FROM ${S.READERS_TABLE} WHERE character_id = ?`)
      .get(o.characterId);
    tx.prepare(`INSERT INTO ${S.READERS_TABLE} (character_id, first_seen_at, last_seen_at, opted_out, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET opted_out = excluded.opted_out,
      updated_at = excluded.updated_at`).run(o.characterId, o.now, o.now, flag, o.now);
    return { ok: true, changed: !before || Number(before.f) !== flag };
  }

  function queueDeliveriesInTx(tx, spec) {
    const o = spec || {};
    if (!isKey(o.editionId)) return invalid("editionId");
    if (!Number.isSafeInteger(o.activeSince)) return invalid("activeSince");
    if (!isPosInt(o.limit) || o.limit > MAX_KEYS) return invalid("limit");
    if (!isNonNegInt(o.now)) return invalid("now");
    const eligible = Number(tx.prepare(`SELECT COUNT(*) AS n FROM ${S.READERS_TABLE} WHERE opted_out = 0
      AND last_seen_at >= ?`).get(o.activeSince).n);
    const info = tx.prepare(`INSERT INTO ${S.DELIVERIES_TABLE} (edition_id, character_id, state, sender_id, sent_date,
      title, message_id, error, created_at, updated_at)
      SELECT ?, character_id, 'PENDING', NULL, NULL, NULL, NULL, NULL, ?, ? FROM ${S.READERS_TABLE}
      WHERE opted_out = 0 AND last_seen_at >= ? ORDER BY last_seen_at DESC, character_id ASC LIMIT ?
      ON CONFLICT(edition_id, character_id) DO NOTHING`).run(o.editionId, o.now, o.now, o.activeSince, o.limit);
    return { ok: true, queued: info.changes, eligible };
  }

  function deliveryOfRow(r) {
    if (!r) return null;
    return { editionId: String(r.edition_id), characterId: Number(r.character_id), state: String(r.state),
      senderId: r.sender_id === null ? null : Number(r.sender_id), sentDate: r.sent_date === null ? null
        : String(r.sent_date), title: r.title === null ? null : String(r.title),
      messageId: r.message_id === null ? null : Number(r.message_id), error: r.error === null ? null : String(r.error),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  }

  function listDeliveriesInTx(tx, spec) {
    const o = spec || {};
    if (!Object.values(S.DELIVERY_STATE).includes(o.state)) return invalid("state");
    if (!isPosInt(o.limit) || o.limit > MAX_LIST) return invalid("limit");
    const before = o.before === undefined ? Number.MAX_SAFE_INTEGER : o.before;
    if (!Number.isSafeInteger(before)) return invalid("before");
    const rows = tx.prepare(`SELECT * FROM ${S.DELIVERIES_TABLE} WHERE state = ? AND created_at < ?
      ORDER BY created_at ASC, edition_id ASC, character_id ASC LIMIT ?`).all(o.state, before, o.limit);
    return { ok: true, deliveries: rows.map(deliveryOfRow) };
  }

  function openDeliveryInTx(tx, spec) {
    const o = spec || {};
    if (!isKey(o.editionId) || !isPosInt(o.characterId)) return invalid("delivery");
    if (!isPosInt(o.senderId)) return invalid("senderId");
    if (typeof o.sentDate !== "string" || typeof o.title !== "string") return invalid("fingerprint");
    if (!isNonNegInt(o.now)) return invalid("now");
    const info = tx.prepare(`UPDATE ${S.DELIVERIES_TABLE} SET state = 'SENDING', sender_id = ?, sent_date = ?,
      title = ?, updated_at = ? WHERE edition_id = ? AND character_id = ? AND state = 'PENDING'`)
      .run(o.senderId, o.sentDate, o.title, o.now, o.editionId, o.characterId);
    if (info.changes !== 1) return { ok: false, reason: "STALE" };
    return { ok: true };
  }

  function finishDeliveryInTx(tx, spec) {
    const o = spec || {};
    if (!isKey(o.editionId) || !isPosInt(o.characterId)) return invalid("delivery");
    const ends = [S.DELIVERY_STATE.SENT, S.DELIVERY_STATE.FAILED, S.DELIVERY_STATE.LOST, S.DELIVERY_STATE.PENDING];
    if (!ends.includes(o.outcome)) return invalid("outcome");
    if (!isNonNegInt(o.now)) return invalid("now");
    const messageId = isPosInt(o.messageId) ? o.messageId : null;
    const error = typeof o.error === "string" ? o.error.slice(0, MAX_ERROR_CHARS) : null;
    const undo = o.outcome === S.DELIVERY_STATE.PENDING;
    const info = tx.prepare(`UPDATE ${S.DELIVERIES_TABLE} SET state = ?, message_id = ?, error = ?, updated_at = ?,
      sender_id = CASE WHEN ? THEN NULL ELSE sender_id END, sent_date = CASE WHEN ? THEN NULL ELSE sent_date END,
      title = CASE WHEN ? THEN NULL ELSE title END
      WHERE edition_id = ? AND character_id = ? AND state = 'SENDING'`)
      .run(o.outcome, messageId, error, o.now, undo ? 1 : 0, undo ? 1 : 0, undo ? 1 : 0, o.editionId, o.characterId);
    if (info.changes !== 1) return { ok: false, reason: "STALE" };
    return { ok: true };
  }

  function expireDeliveriesInTx(tx, spec) {
    const o = spec || {};
    if (!Number.isSafeInteger(o.before)) return invalid("before");
    if (!isPosInt(o.limit)) return invalid("limit");
    if (!isNonNegInt(o.now)) return invalid("now");
    const info = tx.prepare(`UPDATE ${S.DELIVERIES_TABLE} SET state = 'EXPIRED', updated_at = ?
      WHERE rowid IN (SELECT rowid FROM ${S.DELIVERIES_TABLE} WHERE state = 'PENDING' AND created_at < ? LIMIT ?)`)
      .run(o.now, o.before, o.limit);
    return { ok: true, expired: info.changes };
  }

  function deliveryCountsInTx(tx, editionId) {
    const n = (state) => Number(tx.prepare(`SELECT COUNT(*) AS n FROM ${S.DELIVERIES_TABLE} WHERE state = ?`)
      .get(state).n);
    const sent = isKey(editionId) ? Number(tx.prepare(`SELECT COUNT(*) AS n FROM ${S.DELIVERIES_TABLE}
      WHERE edition_id = ? AND state = 'SENT'`).get(editionId).n) : 0;
    return { ok: true, pending: n("PENDING"), sending: n("SENDING"), sent };
  }

  function latestPublishedInTx(tx) {
    const r = tx.prepare(`SELECT * FROM ${S.EDITIONS_TABLE} WHERE state = 'PUBLISHED' ORDER BY boundary_at DESC
      LIMIT 1`).get();
    return { ok: true, edition: editionOfRow(r) };
  }

  function pruneReadersInTx(tx, spec) {
    const o = spec || {};
    if (!Number.isSafeInteger(o.before)) return invalid("before");
    if (!isPosInt(o.limit)) return invalid("limit");
    const info = tx.prepare(`DELETE FROM ${S.READERS_TABLE} WHERE rowid IN (SELECT rowid FROM ${S.READERS_TABLE}
      WHERE opted_out = 0 AND last_seen_at < ? LIMIT ?)`).run(o.before, o.limit);
    return { ok: true, readers: info.changes };
  }

  function getReaderInTx(tx, characterId) {
    if (!isPosInt(characterId)) return invalid("characterId");
    const r = tx.prepare(`SELECT * FROM ${S.READERS_TABLE} WHERE character_id = ?`).get(characterId);
    return { ok: true, reader: r ? { characterId: Number(r.character_id), lastSeenAt: Number(r.last_seen_at),
      optedOut: Number(r.opted_out) === 1 } : null };
  }

  return Object.freeze({ readStateInTx, writeCursorInTx, upsertFactsInTx, readFactsByKeysInTx, listOpenFactsInTx,
    getEditionInTx, latestEditionInTx, listUnfinishedInTx, nextSeqInTx, openEditionInTx, readyEditionInTx, publishEditionInTx,
    listEditionsInTx, pruneInTx, listEditionFactsInTx, attemptEditionInTx, noteAiReasonInTx,
    touchReadersInTx, setOptOutInTx, queueDeliveriesInTx, listDeliveriesInTx, openDeliveryInTx, finishDeliveryInTx,
    expireDeliveriesInTx, deliveryCountsInTx, latestPublishedInTx, pruneReadersInTx, getReaderInTx,
    listRecentFactsInTx });
}

module.exports = { createNewsRepository, PARAGRAPH_SEP };
