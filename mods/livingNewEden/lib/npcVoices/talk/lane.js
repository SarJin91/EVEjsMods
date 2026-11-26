"use strict";

const { createRng, deriveSeed } = require("../../util/rng");
const { voiceOf, isGlyphVoice, pickVoiceLine } = require("../lines");
const { PROFANITY_CAPS } = require("../data/voices");
const { TALK_LANE_COUNTER_NAMES, METRICS } = require("../schema");
const { buildTalkMessages, voiceLabelOf, LABEL_PLAYER, LABEL_OTHER } = require("./prompt");

const PERMILLE = 1000;
const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const MIN_NAME_WORD = 3;
const NO_SOCKET = "NO_SOCKET";
const TALK_LANE = "talk";
const KEY_PREFIX = "fv.talk.";
const WORD_SPLIT_RE = /[^\p{L}\p{N}]+/u;
const MAX_REASON = 40;

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function soft(getter) {
  try {
    return typeof getter === "function" ? getter() || null : null;
  } catch (_err) {
    return null;
  }
}

function wordsOf(text) {
  return String(text || "").toLowerCase().split(WORD_SPLIT_RE).filter((w) => w !== "");
}

function createTalkLane(opts) {
  const { T, V, worldSeed, now, metric, send, transcript } = opts;
  const chatter = opts.chatter || {};
  const counters = Object.fromEntries(TALK_LANE_COUNTER_NAMES.map((n) => [n, 0]));
  const systems = new Map();
  const hours = new Map();
  const repliedAt = new Map();
  const minute = [];
  let generation = 0;
  let seq = 0;
  let lastSendError = null;

  function bump(name) {
    counters[name] += 1;
  }

  function nameOf(characterId) {
    try {
      const n = typeof opts.nameOf === "function" ? opts.nameOf(characterId) : null;
      return typeof n === "string" && n.trim() !== "" ? n.trim() : null;
    } catch (_err) {
      return null;
    }
  }

  function systemName(graph, systemId) {
    try {
      return typeof opts.systemNameOf === "function" ? opts.systemNameOf(graph, systemId) : null;
    } catch (_err) {
      return null;
    }
  }

  function minuteCount(at) {
    while (minute.length > 0 && minute[0] + MINUTE_MS <= at) minute.shift();
    return minute.length;
  }

  function hourOf(systemId, at) {
    let h = hours.get(systemId);
    if (!h) {
      h = [];
      hours.set(systemId, h);
    }
    while (h.length > 0 && h[0] + HOUR_MS <= at) h.shift();
    return h;
  }

  function inFlightCount() {
    let n = 0;
    for (const st of systems.values()) if (st.inFlight) n += 1;
    return n;
  }

  function gapOf(systemId, slot) {
    return createRng(deriveSeed(worldSeed, "fv-talk", systemId, slot)).nextInt(T.minGapMs, T.maxGapMs);
  }

  function noteCrews(bySystem) {
    if (!(bySystem instanceof Map)) return;
    const at = now();
    const next = new Map();
    for (const [systemId, list] of bySystem) {
      if (next.size >= T.maxSystems) break;
      if (!isPositiveInt(systemId) || !Array.isArray(list)) continue;
      const crews = list.filter((c) => c && isPositiveInt(c.characterId) && isPositiveInt(c.factionId))
        .map((c) => Object.freeze({ characterId: c.characterId, factionId: c.factionId }));
      if (crews.length > 0) next.set(systemId, Object.freeze(crews));
    }
    for (const id of [...systems.keys()]) if (!next.has(id)) systems.delete(id);
    for (const [systemId, crews] of next) {
      const st = systems.get(systemId);
      if (st) {
        st.crews = crews;
        continue;
      }
      const slot = Math.floor(at / T.minGapMs);
      systems.set(systemId, { crews, slot: slot + 1, nextAt: at + gapOf(systemId, slot), replyAt: null, followAt: null,
        followTo: null, followRow: 0, replySeq: 0, lastNpc: null, inFlight: null, recentIds: [] });
    }
  }

  function onLine(line) {
    if (!line || typeof line !== "object") return;
    const st = systems.get(line.systemId);
    if (!st || !isPositiveInt(line.characterId)) return;
    if (line.kind === "npc") {
      st.lastNpc = line.characterId;
      return;
    }
    if (line.kind !== "player") return;
    st.followRow = 0;
    const at = Number.isFinite(line.atMs) ? line.atMs : now();
    if (st.replyAt !== null) return;
    const last = repliedAt.get(line.characterId);
    if (last !== undefined && at - last < T.replyCooldownMs) return;
    const rng = createRng(deriveSeed(worldSeed, "fv-talk-reply", line.systemId, st.replySeq));
    st.replySeq += 1;
    const roll = rng.nextInt(0, PERMILLE - 1);
    const delay = rng.nextInt(T.replyDelayMinMs, T.replyDelayMaxMs);
    if (roll >= T.replyPermille) return;
    st.replyAt = at + delay;
    repliedAt.set(line.characterId, at);
  }

  function hasPlayer(presence, systemId) {
    if (T.requirePlayer !== true) return true;
    let sp = null;
    try {
      sp = presence && typeof presence.getSystemPresence === "function" ? presence.getSystemPresence(systemId) : null;
    } catch (_err) {
      sp = null;
    }
    return Boolean(sp && Array.isArray(sp.characters) && sp.characters.some((c) => c && isPositiveInt(c.characterId)));
  }

  function chooseSpeaker(kind, st, idx, replyLine) {
    const crews = st.crews;
    if (kind === "REPLY") {
      if (replyLine) {
        const words = new Set(wordsOf(replyLine.text));
        for (const c of crews) {
          const first = wordsOf(nameOf(c.characterId))[0];
          if (first && first.length >= MIN_NAME_WORD && words.has(first)) return c;
        }
      }
      const last = crews.find((c) => c.characterId === st.lastNpc);
      return last || crews[idx % crews.length];
    }
    const avoid = kind === "FOLLOW_UP" && st.followTo !== null ? st.followTo : st.lastNpc;
    const others = crews.filter((c) => c.characterId !== avoid);
    if (others.length === 0) return kind === "FOLLOW_UP" ? null : crews[idx % crews.length];
    return others[idx % others.length];
  }

  function deliver(systemId, st, fl, text, source, at, lineId) {
    const hour = hourOf(systemId, at);
    if (hour.length >= T.maxLinesPerSystemPerHour || minuteCount(at) >= T.maxLinesPerMinute) {
      bump("rateLimited");
      return;
    }
    minute.push(at);
    let sent = null;
    try {
      sent = send({ systemId, characterId: fl.speakerId, text });
    } catch (_err) {
      sent = { ok: false, reason: "SEND_THREW" };
    }
    if (!sent || sent.ok !== true) {
      lastSendError = sent && typeof sent.reason === "string" ? sent.reason.slice(0, MAX_REASON) : "SEND_FAILED";
      minute.pop();
      bump(lastSendError === NO_SOCKET ? "noSocket" : "sendFailed");
      return;
    }
    hour.push(at);
    metric("count", METRICS.talkLines, 1);
    metric("observe", METRICS.talkMs, Math.max(0, at - fl.atMs));
    if (source === "ai") bump("aiLines");
    else if (source === "glyph") bump("glyphLines");
    else {
      bump("fallbackLines");
      metric("count", METRICS.talkFallback, 1);
    }
    if (fl.kind === "REPLY") {
      bump("replies");
      metric("count", METRICS.talkReplies, 1);
    } else if (fl.kind === "FOLLOW_UP") {
      bump("followUps");
    }
    st.nextAt = Math.max(st.nextAt, at + T.minGapMs);
    st.lastNpc = fl.speakerId;
    st.followRow = fl.kind === "FOLLOW_UP" ? st.followRow + 1 : 0;
    if (lineId && T.contextLines > 0) {
      st.recentIds.push(lineId);
      while (st.recentIds.length > T.contextLines) st.recentIds.shift();
    }
    const follow = createRng(deriveSeed(worldSeed, "fv-talk-follow", systemId, fl.requestId));
    const roll = follow.nextInt(0, PERMILLE - 1);
    const delay = follow.nextInt(T.followUpDelayMinMs, T.followUpDelayMaxMs);
    if (st.followAt === null && st.followRow < T.maxFollowUpsInRow && st.crews.length > 1
      && roll < T.followUpPermille) {
      st.followAt = at + delay;
      st.followTo = fl.speakerId;
    }
  }

  function fail(systemId, st, fl, at) {
    bump("failed");
    metric("count", METRICS.talkFailed, 1);
    if (fl.fallbackRoll >= T.fallbackPermille) return;
    if (!st.crews.some((c) => c.characterId === fl.speakerId)) return;
    const pilot = fl.kind === "REPLY" ? fl.target : null;
    const pick = pickVoiceLine({ voice: fl.voice, context: pilot ? "ADDRESS" : "CHATTER", rng: fl.rng,
      values: { system: systemName(soft(opts.getGraph), systemId), pilot }, recentLineIds: st.recentIds, ai: null,
      maxChars: Math.min(V.maxLineChars, T.maxLineChars), glyphs: null });
    if (!pick.ok) {
      bump("noLine");
      return;
    }
    deliver(systemId, st, fl, pick.text, "static", at, pick.lineId);
  }

  function onResult(systemId, fl, res) {
    try {
      if (fl.done) return;
      fl.done = true;
      const st = systems.get(systemId);
      if (fl.gen !== generation || !st || st.inFlight !== fl) {
        bump("stale");
        return;
      }
      st.inFlight = null;
      const at = now();
      if (at - fl.atMs > T.staleMs) {
        bump("stale");
        fail(systemId, st, fl, at);
        return;
      }
      if (!st.crews.some((c) => c.characterId === fl.speakerId)) {
        fail(systemId, st, fl, at);
        return;
      }
      if (res && res.ok === true && typeof res.line === "string" && res.line !== "") {
        deliver(systemId, st, fl, res.line, "ai", at, null);
      } else {
        fail(systemId, st, fl, at);
      }
    } catch (_err) {
    }
  }

  function dueOf(st, at) {
    if (st.inFlight) return null;
    if (st.replyAt !== null && st.replyAt <= at) return { kind: "REPLY", at: st.replyAt };
    if (st.followAt !== null && st.followAt <= at) return { kind: "FOLLOW_UP", at: st.followAt };
    if (st.nextAt <= at) return { kind: "AMBIENT", at: st.nextAt };
    return null;
  }

  function turn(systemId, st, kind, at, view) {
    bump("turns");
    const rng = createRng(deriveSeed(worldSeed, "fv-talk", systemId, st.slot));
    st.slot += 1;
    const gap = rng.nextInt(T.minGapMs, T.maxGapMs);
    const speakerIdx = rng.nextUint32();
    const fallbackRoll = rng.nextInt(0, PERMILLE - 1);
    let replyLine = null;
    let target = null;
    if (kind === "REPLY") {
      st.replyAt = null;
      replyLine = transcript.lastPlayerLine(systemId, at);
      target = replyLine ? replyLine.name : null;
    } else if (kind === "FOLLOW_UP") {
      st.followAt = null;
      target = st.followTo !== null ? nameOf(st.followTo) : null;
    } else {
      st.nextAt = at + gap;
    }
    if (hourOf(systemId, at).length >= T.maxLinesPerSystemPerHour || minuteCount(at) >= T.maxLinesPerMinute) {
      bump("rateLimited");
      return;
    }
    const speaker = chooseSpeaker(kind, st, speakerIdx, replyLine);
    if (!speaker) {
      bump("noSpeaker");
      return;
    }
    const voice = voiceOf(speaker.factionId);
    if (voice === null) {
      bump("noVoice");
      return;
    }
    seq += 1;
    const fl = { requestId: seq, gen: generation, kind, speakerId: speaker.characterId, voice, atMs: at, target, rng,
      fallbackRoll, done: false };
    if (isGlyphVoice(voice)) {
      const alphabet = typeof opts.glyphAlphabetOf === "function" ? opts.glyphAlphabetOf(voice) : null;
      const pick = pickVoiceLine({ voice, context: "CHATTER", rng, maxChars: V.maxLineChars,
        glyphs: { rng, alphabet, settings: V.glyphs } });
      if (!pick.ok) {
        bump("noLine");
        return;
      }
      deliver(systemId, st, fl, pick.text, "glyph", at, null);
      return;
    }
    const ai = view.chatterAi;
    if (!ai || typeof ai.complete !== "function") {
      fail(systemId, st, fl, at);
      return;
    }
    if (inFlightCount() >= T.maxInFlight) {
      bump("rateLimited");
      return;
    }
    const lines = transcript.recent(systemId, T.contextLines, at);
    const crewVoice = new Map(st.crews.map((c) => [c.characterId, voiceOf(c.factionId)]));
    const speakerName = nameOf(speaker.characterId);
    const messages = buildTalkMessages({ voice, speakerName, systemName: systemName(view.graph, systemId), lines,
      turn: { kind, targetName: target }, language: chatter.language, swearing: chatter.profanity,
      maxChars: T.maxLineChars,
      labelOf: (l) => (l.kind === "player" ? LABEL_PLAYER
        : crewVoice.get(l.characterId) ? voiceLabelOf(crewVoice.get(l.characterId)) : LABEL_OTHER) });
    const names = [...new Set(lines.map((l) => l.name).concat(target ? [target] : []))];
    st.inFlight = fl;
    let promise = null;
    try {
      promise = ai.complete({ lane: TALK_LANE, key: `${KEY_PREFIX}${voice}`, messages, maxChars: T.maxLineChars,
        minChars: T.minLineChars, profanityCap: PROFANITY_CAPS[voice], ...(speakerName ? { speakerName } : {}), names,
        recent: lines.map((l) => l.text) });
    } catch (_err) {
      promise = null;
    }
    if (!promise || typeof promise.then !== "function") {
      st.inFlight = null;
      fl.done = true;
      fail(systemId, st, fl, at);
      return;
    }
    promise.then((res) => onResult(systemId, fl, res), () => onResult(systemId, fl, { ok: false, reason: "REJECTED" }));
  }

  function pass() {
    bump("passes");
    const at = now();
    for (const [systemId, st] of systems) {
      const fl = st.inFlight;
      if (fl && at - fl.atMs > T.staleMs) {
        st.inFlight = null;
        fl.done = true;
        bump("stale");
        fail(systemId, st, fl, at);
      }
    }
    const due = [];
    for (const [systemId, st] of systems) {
      const d = dueOf(st, at);
      if (d) due.push([systemId, st, d]);
    }
    if (due.length > 0) {
      due.sort((a, b) => a[2].at - b[2].at || a[0] - b[0]);
      const presence = soft(opts.getPresence);
      const view = { chatterAi: soft(opts.getChatterAi), graph: soft(opts.getGraph) };
      for (const [systemId, st, d] of due) {
        if (!hasPlayer(presence, systemId)) continue;
        turn(systemId, st, d.kind, at, view);
      }
    }
    for (const [id, t] of repliedAt) if (at - t >= T.replyCooldownMs) repliedAt.delete(id);
    for (const [id, h] of hours) {
      while (h.length > 0 && h[0] + HOUR_MS <= at) h.shift();
      if (h.length === 0 && !systems.has(id)) hours.delete(id);
    }
  }

  function getStatus() {
    return { systems: systems.size, inFlight: inFlightCount(), counters: { ...counters },
      ...(lastSendError !== null ? { lastSendError } : {}) };
  }

  function clear() {
    generation += 1;
    systems.clear();
    hours.clear();
    repliedAt.clear();
    minute.length = 0;
  }

  return Object.freeze({ noteCrews, onLine, pass, getStatus, clear });
}

module.exports = { createTalkLane };
