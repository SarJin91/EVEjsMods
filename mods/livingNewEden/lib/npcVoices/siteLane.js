"use strict";

const { createRng, deriveSeed, stableHash32 } = require("../util/rng");
const { voiceOf, isGlyphVoice, bucketKeyOf, pickVoiceLine } = require("./lines");
const { alphabetOf } = require("./glyphs");
const { systemNameOf } = require("./localLane");
const { SPEAKERS, COLORS } = require("./data/voices");
const { SITE_COUNTER_NAMES, EXCHANGE_STATE, METRIC_SITE_ENTRIES, METRIC_SITE_EXCHANGES, METRIC_SITE_LINES,
  METRIC_AI_LINES, METRIC_GLYPH_LINES, METRIC_SEND_FAILED, METRIC_RATE_LIMITED } = require("./schema");

const PERMILLE = 1000;
const HOUR_MS = 3600000;
const ENTRY_ROOM = "room:entry";
const ABYSSAL_FAMILY = "abyssal";
const MARKUP_RE = /[<>&]/g;
const COLOR_RE = /^0x[0-9a-f]{8}$/;
const CONTEXT_ARRIVAL = "SITE_ARRIVAL";
const CONTEXT_BANTER = "SITE_BANTER";
const GONE = Object.freeze({ NO_SESSION: "noSession", LEFT_SYSTEM: "leftSystem" });
const MAX_NAME_CHARS = 64;
const MAX_REASON_CHARS = 40;

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

function formatSiteLine(label, color, text, colorSpeakers) {
  const body = String(text ?? "").replace(MARKUP_RE, "");
  const who = String(label ?? "").replace(MARKUP_RE, "");
  return colorSpeakers === true && COLOR_RE.test(String(color)) ? `<color=${color}>${who}</color>: ${body}`
    : `${who}: ${body}`;
}

function entryOf(ev) {
  if (!ev || typeof ev !== "object") return null;
  const instanceId = ev.instanceId;
  const okInstance = isPositiveInt(instanceId) || (typeof instanceId === "string" && instanceId !== "");
  if (!isPositiveInt(ev.characterId) || !isPositiveInt(ev.systemId) || !okInstance) return null;
  const roomKey = typeof ev.roomKey === "string" && ev.roomKey.trim() !== "" ? ev.roomKey.trim() : ENTRY_ROOM;
  const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  return Object.freeze({ characterId: ev.characterId, systemId: ev.systemId, instanceId, roomKey,
    siteKind: lower(ev.siteKind), siteFamily: lower(ev.siteFamily),
    factionId: isPositiveInt(ev.factionId) ? ev.factionId : null,
    pilotName: typeof ev.pilotName === "string" ? ev.pilotName.replace(MARKUP_RE, "").trim().slice(0, MAX_NAME_CHARS)
      : "",
    atMs: Number.isSafeInteger(ev.atMs) ? ev.atMs : null });
}

function createSiteLane(opts) {
  const { S, V, worldSeed, now, metric, send } = opts;
  const counters = Object.fromEntries(SITE_COUNTER_NAMES.map((n) => [n, 0]));
  const queue = [];
  const exchanges = new Map();
  const roomSeen = new Map();
  const characterSeen = new Map();
  const hour = [];
  const characterHour = new Map();
  let lastSendError = null;

  function bump(name, n = 1) {
    counters[name] += n;
  }

  function noteEntry(ev) {
    if (queue.length >= S.maxEntryQueue) {
      bump("queueFull");
      return;
    }
    const entry = entryOf(ev);
    if (entry === null) return;
    queue.push(entry);
    bump("entries");
    metric("count", METRIC_SITE_ENTRIES, 1);
  }

  function roomKeyOf(e) {
    return `${e.characterId}|${e.instanceId}|${e.roomKey}`;
  }

  function prune(at) {
    while (hour.length > 0 && hour[0] + HOUR_MS <= at) hour.shift();
    for (const [id, list] of characterHour) {
      while (list.length > 0 && list[0] + HOUR_MS <= at) list.shift();
      if (list.length === 0) characterHour.delete(id);
    }
    for (const [k, t] of roomSeen) if (at - t >= S.roomCooldownMs) roomSeen.delete(k);
    for (const [id, t] of characterSeen) if (at - t >= S.characterCooldownMs) characterSeen.delete(id);
  }

  function rateLimited() {
    bump("rateLimited");
    metric("count", METRIC_RATE_LIMITED, 1);
  }

  function refusalOf(e, voice, key, mine) {
    if (!S.siteKinds.includes(e.siteKind) || e.siteFamily === ABYSSAL_FAMILY) return "kindFiltered";
    if (e.factionId === null) return "noFaction";
    if (voice === null) return "noVoice";
    if (exchanges.has(key) || roomSeen.has(key) || characterSeen.has(e.characterId)) return "cooldown";
    if (hour.length >= S.maxExchangesPerHour || mine.length >= S.maxExchangesPerCharacterPerHour) return "rateLimited";
    if (exchanges.size >= S.maxPending) return "pendingFull";
    return null;
  }

  function admit(e, at) {
    const voice = e.factionId === null ? null : voiceOf(e.factionId);
    const key = roomKeyOf(e);
    const mine = characterHour.get(e.characterId) || [];
    const refusal = refusalOf(e, voice, key, mine);
    if (refusal === "rateLimited") {
      rateLimited();
      return;
    }
    if (refusal !== null) {
      bump(refusal);
      return;
    }
    const parts = [e.characterId, e.instanceId, stableHash32(e.roomKey)];
    const rng = createRng(deriveSeed(worldSeed, "fv-site", ...parts));
    const roomRoll = rng.nextInt(0, PERMILLE - 1);
    const lineCount = rng.nextInt(S.minLines, S.maxLines);
    const speakers = SPEAKERS[voice] || [];
    const aIdx = speakers.length > 0 ? rng.nextUint32() % speakers.length : 0;
    const offset = rng.nextUint32();
    const bIdx = speakers.length > 1 ? (aIdx + 1 + (offset % (speakers.length - 1))) % speakers.length : aIdx;
    const base = e.atMs !== null && e.atMs <= at ? e.atMs : at;
    const times = [base + S.firstDelayMs];
    for (let i = 1; i < lineCount; i += 1) times.push(times[i - 1] + rng.nextInt(S.lineGapMinMs, S.lineGapMaxMs));
    if (e.roomKey !== ENTRY_ROOM && roomRoll >= S.otherRoomPermille) {
      bump("roomRoll");
      return;
    }
    if (speakers.length === 0) {
      bump("noVoice");
      return;
    }
    roomSeen.set(key, at);
    characterSeen.set(e.characterId, at);
    hour.push(at);
    mine.push(at);
    characterHour.set(e.characterId, mine);
    exchanges.set(key, { key, entry: e, voice, state: EXCHANGE_STATE.PLANNED, rng,
      glyphRng: createRng(deriveSeed(worldSeed, "fv-site-glyph", ...parts)), speakers: [speakers[aIdx], speakers[bIdx]],
      times, next: 0, recent: [] });
    bump("exchanges");
    metric("count", METRIC_SITE_EXCHANGES, 1);
  }

  function abort(ex, counter) {
    ex.state = EXCHANGE_STATE.ABORTED;
    exchanges.delete(ex.key);
    bump("aborted");
    if (counter) bump(counter);
  }

  function speak(ex, view) {
    const i = ex.next;
    const context = i === 0 ? CONTEXT_ARRIVAL : CONTEXT_BANTER;
    const label = ex.speakers[i % 2 === 1 ? 1 : 0];
    const glyph = isGlyphVoice(ex.voice);
    let ai = null;
    if (!glyph) {
      if (view.chatterAi && typeof view.chatterAi.demand === "function") {
        try {
          view.chatterAi.demand(bucketKeyOf(ex.voice, context));
        } catch (_err) {
        }
      }
      ai = view.overlay();
    }
    ex.state = EXCHANGE_STATE.SPEAKING;
    const glyphs = glyph ? { rng: ex.glyphRng, alphabet: alphabetOf(ex.voice, V.glyphs.extended), settings: V.glyphs }
      : null;
    const pick = pickVoiceLine({ voice: ex.voice, context, rng: ex.rng,
      values: { system: systemNameOf(view.graph, ex.entry.systemId), pilot: ex.entry.pilotName || null },
      recentLineIds: ex.recent, ai, maxChars: V.maxLineChars, glyphs });
    ex.next += 1;
    if (!pick.ok) {
      bump("noLine");
    } else {
      const text = formatSiteLine(label, COLORS[ex.voice], pick.text, S.colorSpeakers);
      let sent = null;
      try {
        sent = send({ characterId: ex.entry.characterId, systemId: ex.entry.systemId, text });
      } catch (_err) {
        sent = { ok: false, reason: "SEND_THREW" };
      }
      if (!sent || sent.ok !== true) {
        const reason = sent && typeof sent.reason === "string" ? sent.reason.slice(0, MAX_REASON_CHARS) : "SEND_FAILED";
        if (Object.prototype.hasOwnProperty.call(GONE, reason)) {
          abort(ex, GONE[reason]);
          return;
        }
        lastSendError = reason;
        bump("sendFailed");
        metric("count", METRIC_SEND_FAILED, 1);
        abort(ex, null);
        return;
      }
      bump("lines");
      metric("count", METRIC_SITE_LINES, 1);
      if (pick.source === "ai") {
        bump("aiLines");
        metric("count", METRIC_AI_LINES, 1);
      } else if (pick.source === "glyph") {
        bump("glyphLines");
        metric("count", METRIC_GLYPH_LINES, 1);
      } else {
        bump("staticLines");
      }
      ex.recent.push(pick.lineId);
    }
    if (ex.next >= ex.times.length) {
      ex.state = EXCHANGE_STATE.DONE;
      exchanges.delete(ex.key);
      bump("done");
    }
  }

  function pass() {
    const at = now();
    bump("passes");
    prune(at);
    while (queue.length > 0) admit(queue.shift(), at);
    const due = [...exchanges.values()].filter((ex) => ex.times[ex.next] <= at);
    if (due.length === 0) return;
    const chatterAi = soft(opts.getChatterAi);
    let overlayRead = false;
    let overlay = null;
    const view = { graph: soft(opts.getGraph), chatterAi,
      overlay() {
        if (!overlayRead) {
          overlayRead = true;
          try {
            const r = chatterAi && typeof chatterAi.overlay === "function" ? chatterAi.overlay() : null;
            overlay = r && r.ok === true ? { permille: r.permille, linesOf: r.linesOf } : null;
          } catch (_err) {
            overlay = null;
          }
        }
        return overlay;
      } };
    for (const ex of due) speak(ex, view);
  }

  function getStatus() {
    return { pending: exchanges.size, queued: queue.length, counters: { ...counters },
      ...(lastSendError !== null ? { lastSendError } : {}) };
  }

  function clear() {
    for (const ex of [...exchanges.values()]) abort(ex, null);
    queue.length = 0;
    roomSeen.clear();
    characterSeen.clear();
    hour.length = 0;
    characterHour.clear();
  }

  return Object.freeze({ noteEntry, pass, getStatus, clear, bump });
}

module.exports = { createSiteLane, formatSiteLine, ENTRY_ROOM };
