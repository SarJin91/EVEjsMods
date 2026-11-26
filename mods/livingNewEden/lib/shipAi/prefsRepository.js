"use strict";

const { toBind } = require("../persistence/repository");
const S = require("./schema");
const { parseVoicePrefs, VOICE_PREFS_MAX_CHARS } = require("./voice/voicePrefs");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const txMissing = (db) => !db || db.inTransaction !== true;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const SHA_RE = /^[0-9a-f]{64}$/;
const failed = (err) => ({ ok: false, reason: "SHIP_AI_SQL_FAILED",
  detail: String((err && err.message) || err).slice(0, 120) });

function mutedOf(text) {
  if (typeof text !== "string" || text === "") return Object.freeze([]);
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return Object.freeze([]);
    return Object.freeze([...new Set(parsed.filter((k) => S.MUTE_KINDS.includes(k)))].sort());
  } catch (_err) {
    return Object.freeze([]);
  }
}

function autostartOf(text) {
  if (typeof text !== "string" || text === "" || text.length > S.AUTOSTART_PREFS_MAX_CHARS) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== S.AUTOSTART_STEPS.length || !S.AUTOSTART_STEPS.every((k) => typeof parsed[k] === "boolean")) {
    return null;
  }
  if (!parsed.room && !parsed.voice) return null;
  return Object.freeze({ room: parsed.room, voice: parsed.voice });
}

function toRow(r) {
  return Object.freeze({ playerId: Number(r.player_character_id), aiId: Number(r.ai_character_id),
    name: String(r.ai_name), language: r.language === null || r.language === undefined ? null : String(r.language),
    quiet: Number(r.quiet) === 1, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    version: Number(r.version),
    lastProactiveAt: r.last_proactive_at === null || r.last_proactive_at === undefined ? null
      : Number(r.last_proactive_at),
    portraitSha: typeof r.portrait_sha === "string" ? r.portrait_sha : null,
    mailMode: S.MAIL_MODES.includes(r.mail_mode) ? r.mail_mode : "on",
    mailSeenId: r.mail_seen_id === null || r.mail_seen_id === undefined ? null : Number(r.mail_seen_id),
    personaPreset: S.PERSONA_PRESETS.includes(r.persona_preset) ? r.persona_preset : null,
    personaCustom: typeof r.persona_custom === "string" && r.persona_custom !== "" ? r.persona_custom : null,
    calloutMode: S.ALERT_MODES.includes(r.callout_mode) ? r.callout_mode : "on",
    dscanMode: S.ALERT_MODES.includes(r.dscan_mode) ? r.dscan_mode : "on",
    mutedKinds: mutedOf(r.muted_kinds),
    lastSeenAt: r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    voicePrefs: parseVoicePrefs(r.voice_prefs),
    autostartPrefs: autostartOf(r.autostart_prefs) });
}

function createShipAiPrefsRepository() {
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE_NAME;
    s = {
      byPlayer: db.prepare(`SELECT * FROM ${T} WHERE player_character_id = ?`),
      count: db.prepare(`SELECT COUNT(*) AS n FROM ${T}`),
      page: db.prepare(`SELECT * FROM ${T} WHERE player_character_id > ? ORDER BY player_character_id LIMIT ?`),
      insert: db.prepare(`INSERT INTO ${T} (player_character_id, ai_character_id, ai_name, language, quiet,
        portrait_sha, created_at, updated_at, last_proactive_at, version)
        VALUES (?, ?, ?, NULL, 0, NULL, ?, ?, NULL, 1)`),
      rename: db.prepare(`UPDATE ${T} SET ai_name = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
      quiet: db.prepare(`UPDATE ${T} SET quiet = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
      proactive: db.prepare(`UPDATE ${T} SET last_proactive_at = ? WHERE player_character_id = ?`),
      lastSeen: db.prepare(`UPDATE ${T} SET last_seen_at = ? WHERE player_character_id = ?`),
      portrait: db.prepare(`UPDATE ${T} SET portrait_sha = ?, updated_at = ? WHERE player_character_id = ?`),
      mailMode: db.prepare(`UPDATE ${T} SET mail_mode = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
      mailSeen: db.prepare(`UPDATE ${T} SET mail_seen_id = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ? AND (mail_seen_id IS NULL OR mail_seen_id < ?)`),
      personaKeep: db.prepare(`UPDATE ${T} SET persona_preset = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
      personaBoth: db.prepare(`UPDATE ${T} SET persona_preset = ?, persona_custom = ?, updated_at = ?,
        version = version + 1 WHERE player_character_id = ?`),
      calloutMode: db.prepare(`UPDATE ${T} SET callout_mode = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
      dscanMode: db.prepare(`UPDATE ${T} SET dscan_mode = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
      mutedKinds: db.prepare(`UPDATE ${T} SET muted_kinds = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
      voicePrefs: db.prepare(`UPDATE ${T} SET voice_prefs = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
      autostart: db.prepare(`UPDATE ${T} SET autostart_prefs = ?, updated_at = ?, version = version + 1
        WHERE player_character_id = ?`),
    };
    cache.set(db, s);
    return s;
  }

  function getByPlayer(db, playerId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(playerId)) return { ok: false, reason: "INVALID_INPUT", detail: "playerId" };
    try {
      const r = stmts(db).byPlayer.get(toBind(playerId));
      return { ok: true, row: r ? toRow(r) : null };
    } catch (err) {
      return failed(err);
    }
  }

  function countRows(db) {
    if (txMissing(db)) return TX_REQUIRED;
    try {
      return { ok: true, count: Number(stmts(db).count.get().n) };
    } catch (err) {
      return failed(err);
    }
  }

  function listAfter(db, afterPlayerId, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!Number.isSafeInteger(afterPlayerId) || afterPlayerId < 0 || !isId(limit)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "afterPlayerId/limit" };
    }
    try {
      return { ok: true, rows: stmts(db).page.all(toBind(afterPlayerId), toBind(limit)).map(toRow) };
    } catch (err) {
      return failed(err);
    }
  }

  function insert(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || !isId(s.aiId) || typeof s.name !== "string" || s.name === ""
      || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "prefs row" };
    }
    try {
      stmts(db).insert.run(toBind(s.playerId), toBind(s.aiId), s.name, toBind(s.nowMs), toBind(s.nowMs));
      return { ok: true, row: toRow(stmts(db).byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  function updateName(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || typeof s.name !== "string" || s.name === "" || !Number.isSafeInteger(s.nowMs)
      || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "name" };
    }
    try {
      const st = stmts(db);
      const changed = Number(st.rename.run(s.name, toBind(s.nowMs), toBind(s.playerId)).changes);
      if (changed === 0) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, row: toRow(st.byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  function setQuiet(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || typeof s.quiet !== "boolean" || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "quiet" };
    }
    try {
      const st = stmts(db);
      const changed = Number(st.quiet.run(s.quiet ? 1 : 0, toBind(s.nowMs), toBind(s.playerId)).changes);
      if (changed === 0) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, row: toRow(st.byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  function setLastProactive(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || (s.atMs !== null && (!Number.isSafeInteger(s.atMs) || s.atMs < 0))) {
      return { ok: false, reason: "INVALID_INPUT", detail: "atMs" };
    }
    try {
      return { ok: true, changed: Number(stmts(db).proactive.run(s.atMs === null ? null : toBind(s.atMs),
        toBind(s.playerId)).changes) };
    } catch (err) {
      return failed(err);
    }
  }

  function setLastSeen(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || !Number.isSafeInteger(s.atMs) || s.atMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "atMs" };
    }
    try {
      return { ok: true, changed: Number(stmts(db).lastSeen.run(toBind(s.atMs), toBind(s.playerId)).changes) };
    } catch (err) {
      return failed(err);
    }
  }

  function setPortraitSha(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || typeof s.sha !== "string" || !SHA_RE.test(s.sha) || !Number.isSafeInteger(s.nowMs)
      || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "portraitSha" };
    }
    try {
      const changed = Number(stmts(db).portrait.run(s.sha, toBind(s.nowMs), toBind(s.playerId)).changes);
      return changed === 0 ? { ok: false, reason: "NOT_FOUND" } : { ok: true, changed };
    } catch (err) {
      return failed(err);
    }
  }

  function setMailMode(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || !S.MAIL_MODES.includes(s.mode) || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "mailMode" };
    }
    try {
      const st = stmts(db);
      const changed = Number(st.mailMode.run(s.mode, toBind(s.nowMs), toBind(s.playerId)).changes);
      if (changed === 0) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, row: toRow(st.byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  function advanceMailSeen(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || !Number.isSafeInteger(s.seenId) || s.seenId < 0 || !Number.isSafeInteger(s.nowMs)
      || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "mailSeenId" };
    }
    try {
      const changed = Number(stmts(db).mailSeen.run(toBind(s.seenId), toBind(s.nowMs), toBind(s.playerId),
        toBind(s.seenId)).changes);
      return { ok: true, changed: changed > 0 ? 1 : 0 };
    } catch (err) {
      return failed(err);
    }
  }

  function setPersona(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    const customOk = s.custom === undefined || s.custom === null
      || (typeof s.custom === "string" && s.custom.length >= 1 && s.custom.length <= 400);
    if (!isId(s.playerId) || (s.preset !== null && !S.PERSONA_PRESETS.includes(s.preset)) || !customOk
      || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "persona" };
    }
    try {
      const st = stmts(db);
      const info = s.custom === undefined
        ? st.personaKeep.run(s.preset, toBind(s.nowMs), toBind(s.playerId))
        : st.personaBoth.run(s.preset, s.custom, toBind(s.nowMs), toBind(s.playerId));
      if (Number(info.changes) === 0) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, row: toRow(st.byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  function setSwitch(db, spec, key, detail) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.playerId) || !S.ALERT_MODES.includes(s.mode) || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail };
    }
    try {
      const st = stmts(db);
      const changed = Number(st[key].run(s.mode, toBind(s.nowMs), toBind(s.playerId)).changes);
      if (changed === 0) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, row: toRow(st.byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  function setCalloutMode(db, spec) {
    return setSwitch(db, spec, "calloutMode", "calloutMode");
  }

  function setDscanMode(db, spec) {
    return setSwitch(db, spec, "dscanMode", "dscanMode");
  }

  function setMutedKinds(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    const kinds = Array.isArray(s.kinds) ? [...new Set(s.kinds)].sort() : null;
    const json = kinds && kinds.length > 0 ? JSON.stringify(kinds) : null;
    if (!isId(s.playerId) || !kinds || !kinds.every((k) => S.MUTE_KINDS.includes(k))
      || (json !== null && json.length > S.MUTED_KINDS_MAX_CHARS) || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "mutedKinds" };
    }
    try {
      const st = stmts(db);
      const changed = Number(st.mutedKinds.run(json, toBind(s.nowMs), toBind(s.playerId)).changes);
      if (changed === 0) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, row: toRow(st.byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  function setVoicePrefs(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    const prefsOk = s.prefs === null || (s.prefs !== undefined && typeof s.prefs === "object" && !Array.isArray(s.prefs));
    const json = prefsOk && s.prefs !== null ? JSON.stringify(s.prefs) : null;
    if (!isId(s.playerId) || !prefsOk || (json !== null && json.length > VOICE_PREFS_MAX_CHARS)
      || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "voicePrefs" };
    }
    try {
      const st = stmts(db);
      const changed = Number(st.voicePrefs.run(json, toBind(s.nowMs), toBind(s.playerId)).changes);
      if (changed === 0) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, row: toRow(st.byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  function setAutostart(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const s = spec || {};
    const p = s.prefs;
    const prefsOk = p === null || (p !== undefined && typeof p === "object" && typeof p.room === "boolean"
      && typeof p.voice === "boolean");
    if (!isId(s.playerId) || !prefsOk || !Number.isSafeInteger(s.nowMs) || s.nowMs < 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "autostartPrefs" };
    }
    const json = p && (p.room || p.voice) ? JSON.stringify({ room: p.room, voice: p.voice }) : null;
    try {
      const st = stmts(db);
      const changed = Number(st.autostart.run(json, toBind(s.nowMs), toBind(s.playerId)).changes);
      if (changed === 0) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, row: toRow(st.byPlayer.get(toBind(s.playerId))) };
    } catch (err) {
      return failed(err);
    }
  }

  return Object.freeze({ getByPlayer, countRows, listAfter, insert, updateName, setQuiet, setLastProactive, setLastSeen,
    setPortraitSha, setMailMode, advanceMailSeen, setPersona, setCalloutMode, setDscanMode, setMutedKinds,
    setVoicePrefs, setAutostart });
}

module.exports = { createShipAiPrefsRepository };
