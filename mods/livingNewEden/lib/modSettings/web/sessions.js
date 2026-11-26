"use strict";

const crypto = require("node:crypto");

const SECRET_BYTES = 32;
const BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_NAME_CHARS = 64;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function bytesOf(text) {
  if (typeof text !== "string" || !BASE64URL_RE.test(text)) return null;
  const buf = Buffer.from(text, "base64url");
  return buf.length === SECRET_BYTES ? buf : null;
}

function same(a, b) {
  return a !== null && b !== null && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function actorOf(actor) {
  const a = actor && typeof actor === "object" ? actor : {};
  return Object.freeze({
    characterId: Number.isSafeInteger(a.characterId) && a.characterId > 0 ? a.characterId : null,
    characterName: typeof a.characterName === "string"
      ? a.characterName.replace(CONTROL_RE, " ").slice(0, MAX_NAME_CHARS) : null,
  });
}

function createSessions(deps) {
  const linkTtlMs = deps.linkTtlMs;
  const sessionTtlMs = deps.sessionTtlMs;
  const maxSessions = deps.maxSessions;
  const clock = deps.clock;
  const randomBytes = typeof deps.randomBytes === "function" ? deps.randomBytes : crypto.randomBytes;
  const tokens = [];
  const sessions = [];
  const counts = { issued: 0, redeemed: 0, refused: 0, evicted: 0, expired: 0 };

  function prune(now) {
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (tokens[i].expiresAtMs <= now) {
        tokens.splice(i, 1);
        counts.expired += 1;
      }
    }
    for (let i = sessions.length - 1; i >= 0; i -= 1) {
      if (sessions[i].lastUsedMs + sessionTtlMs <= now) {
        sessions.splice(i, 1);
        counts.expired += 1;
      }
    }
  }

  function secret() {
    const buf = Buffer.from(randomBytes(SECRET_BYTES));
    return { buf, text: buf.toString("base64url") };
  }

  function issueToken(actor) {
    const now = clock.now();
    prune(now);
    const t = secret();
    tokens.push({ bytes: t.buf, actor: actorOf(actor), expiresAtMs: now + linkTtlMs });
    while (tokens.length > maxSessions) tokens.shift();
    counts.issued += 1;
    return { ok: true, token: t.text, expiresAtMs: now + linkTtlMs };
  }

  function redeem(token) {
    const now = clock.now();
    prune(now);
    const bytes = bytesOf(token);
    let index = -1;
    for (let i = 0; i < tokens.length; i += 1) {
      if (same(tokens[i].bytes, bytes)) index = i;
    }
    if (index === -1) {
      counts.refused += 1;
      return { ok: false, reason: "BAD_TOKEN" };
    }
    const [hit] = tokens.splice(index, 1);
    const sid = secret();
    const csrf = secret();
    sessions.push({ sid: sid.buf, csrfBytes: csrf.buf, actor: hit.actor, createdAtMs: now, lastUsedMs: now });
    while (sessions.length > maxSessions) {
      sessions.shift();
      counts.evicted += 1;
    }
    counts.redeemed += 1;
    return { ok: true, sid: sid.text, csrf: csrf.text, actor: hit.actor };
  }

  function indexOf(sid) {
    const bytes = bytesOf(sid);
    let index = -1;
    for (let i = 0; i < sessions.length; i += 1) {
      if (same(sessions[i].sid, bytes)) index = i;
    }
    return index;
  }

  function sessionOf(sid) {
    const now = clock.now();
    prune(now);
    const index = indexOf(sid);
    if (index === -1) return null;
    const s = sessions[index];
    s.lastUsedMs = now;
    return { actor: s.actor, createdAtMs: s.createdAtMs, lastUsedMs: s.lastUsedMs, csrfBytes: s.csrfBytes };
  }

  function csrfMatches(session, csrf) {
    return Boolean(session && session.csrfBytes) && same(session.csrfBytes, bytesOf(csrf));
  }

  function end(sid) {
    const index = indexOf(sid);
    if (index === -1) return false;
    sessions.splice(index, 1);
    return true;
  }

  function revokeActor(characterId) {
    let removed = 0;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (tokens[i].actor.characterId !== null && tokens[i].actor.characterId === characterId) {
        tokens.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  function status() {
    prune(clock.now());
    return { tokens: tokens.length, sessions: sessions.length, ...counts };
  }

  function clear() {
    tokens.length = 0;
    sessions.length = 0;
  }

  return Object.freeze({ issueToken, redeem, sessionOf, csrfMatches, end, revokeActor, status, clear });
}

module.exports = { SECRET_BYTES, createSessions };
