"use strict";

const EPOCH_BYTES = 8;
const MAX_RETIRED = 32;
const PENDING = "PENDING";
const READY = "READY";

function createVoiceQueue(deps) {
  const S = deps.S;
  const nowMs = deps.nowMs;
  const epoch = Buffer.from(deps.randomBytes(EPOCH_BYTES)).toString("base64url");
  const players = new Map();
  const retired = [];
  let seq = 0;
  const counts = { dropped: 0, superseded: 0, noListener: 0, pendingExpired: 0 };
  const pendingMaxMs = (Number.isSafeInteger(S.voicePiperTimeoutMs) ? S.voicePiperTimeoutMs : 0) + S.voicePollMs;

  const alive = (entry, now) => now - entry.lastPollMs <= S.voiceListenerIdleMs;

  function pruneLines(entry, now) {
    while (entry.lines.length > 0 && now - entry.lines[0].atMs > S.voiceLineTtlMs) {
      entry.lines.shift();
      counts.dropped += 1;
    }
  }

  function retire(sid) {
    retired.push(sid);
    while (retired.length > MAX_RETIRED) retired.shift();
  }

  function attach(playerId, sid) {
    const now = nowMs();
    for (const [id, e] of players) {
      if (now - e.lastPollMs > S.voiceSessionTtlMs) players.delete(id);
    }
    const prev = players.get(playerId);
    const superseded = Boolean(prev) && prev.sid !== sid;
    if (superseded) {
      counts.superseded += 1;
      retire(prev.sid);
    }
    players.set(playerId, { sid, lastPollMs: now, lines: [] });
    return { ok: true, superseded };
  }

  function detach(playerId, sid) {
    const entry = players.get(playerId);
    if (!entry || (sid !== undefined && entry.sid !== sid)) return { ended: false, sid: null };
    players.delete(playerId);
    return { ended: true, sid: entry.sid };
  }

  function listenerOf(playerId) {
    const entry = players.get(playerId);
    return entry ? entry.sid : null;
  }

  function push(playerId, parts, lang, opts) {
    const clean = Array.isArray(parts) ? parts.filter((p) => typeof p === "string" && p !== "") : [];
    if (clean.length === 0) return { ok: false, reason: "EMPTY" };
    const entry = players.get(playerId);
    const now = nowMs();
    if (!entry || !alive(entry, now)) {
      if (entry) entry.lines.length = 0;
      counts.noListener += 1;
      return { ok: false, reason: "NO_LISTENER" };
    }
    pruneLines(entry, now);
    seq += 1;
    entry.lines.push({ seq, parts: Object.freeze(clean.slice()), lang: String(lang), atMs: now,
      state: opts && opts.pending === true ? PENDING : READY, audioId: null });
    while (entry.lines.length > S.voiceQueueMax) {
      entry.lines.shift();
      counts.dropped += 1;
    }
    return { ok: true, seq };
  }

  function resolve(playerId, lineSeq, audioId) {
    const entry = players.get(playerId);
    const line = entry ? entry.lines.find((l) => l.seq === lineSeq) : null;
    if (!line || line.state !== PENDING) return false;
    line.state = READY;
    line.audioId = typeof audioId === "string" && audioId !== "" ? audioId : null;
    return true;
  }

  function awaitsAudio(playerId, lineSeq) {
    const entry = players.get(playerId);
    if (!entry) return false;
    const now = nowMs();
    if (!alive(entry, now)) return false;
    const line = entry.lines.find((l) => l.seq === lineSeq);
    return Boolean(line) && line.state === PENDING && now - line.atMs <= pendingMaxMs
      && now - line.atMs <= S.voiceLineTtlMs;
  }

  function take(playerId, sid, afterSeq) {
    if (retired.includes(sid)) return { ok: false, reason: "SUPERSEDED" };
    const entry = players.get(playerId);
    if (!entry) return { ok: false, reason: "NO_LISTENER" };
    if (entry.sid !== sid) return { ok: false, reason: "SUPERSEDED" };
    const now = nowMs();
    if (!alive(entry, now)) entry.lines.length = 0;
    entry.lastPollMs = now;
    pruneLines(entry, now);
    const after = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    const lines = [];
    for (const l of entry.lines) {
      if (l.state === PENDING && now - l.atMs > pendingMaxMs) {
        l.state = READY;
        counts.pendingExpired += 1;
      }
      if (l.state === PENDING) break;
      if (l.seq <= after) continue;
      lines.push(l.audioId ? { seq: l.seq, parts: [...l.parts], lang: l.lang, audioId: l.audioId }
        : { seq: l.seq, parts: [...l.parts], lang: l.lang });
    }
    return { ok: true, epoch, next: lines.length > 0 ? lines[lines.length - 1].seq : after, lines };
  }

  function drop(playerId) {
    players.delete(playerId);
  }

  function listening(playerId) {
    const entry = players.get(playerId);
    return Boolean(entry) && alive(entry, nowMs());
  }

  function status() {
    const now = nowMs();
    let listeners = 0;
    let buffered = 0;
    for (const e of players.values()) {
      if (!alive(e, now)) continue;
      listeners += 1;
      buffered += e.lines.length;
    }
    const out = { listeners, buffered, dropped: counts.dropped, superseded: counts.superseded,
      noListener: counts.noListener };
    if (counts.pendingExpired > 0) out.pendingExpired = counts.pendingExpired;
    return out;
  }

  function clear() {
    players.clear();
    retired.length = 0;
  }

  function isRetired(sid) {
    return retired.includes(sid);
  }

  return Object.freeze({ attach, detach, push, resolve, awaitsAudio, take, drop, listening, listenerOf, isRetired,
    status, clear, epoch });
}

module.exports = { createVoiceQueue };
