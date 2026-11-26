"use strict";

const crypto = require("node:crypto");
const { createSessions } = require("../../modSettings/web/sessions");
const { resolveObserverUrl } = require("../../inGameMap/format");
const { METRIC } = require("../schema");
const { toSpeechText, splitSentences, langTagOf } = require("./speechText");
const { createVoiceQueue } = require("./queue");
const { createVoiceRoutes } = require("./routes");
const { parsePiperUrl, createPiperTransport, createDefaultPiperTransport } = require("./piperTransport");
const { createAudioCache } = require("./audioCache");
const { createPiperEngine } = require("./piperEngine");
const { lengthScaleOf } = require("./voicePrefs");

const PAGE = "shipai-voice.html";
const PIPER_NOT_BUILT = "PIPER_NOT_BUILT";
const PIPER_URL_MISSING = "PIPER_URL_MISSING";
const REGISTER_REASONS = Object.freeze(["ROUTE_EXISTS", "ROUTE_PREFIX_INVALID"]);

function observerUrlOf(config) {
  return () => resolveObserverUrl(config && config.inGameMap, config && config.observer);
}

function createShipAiVoice(deps) {
  const d = deps || {};
  const S = d.S;
  if (!d.httpRoutes || typeof d.httpRoutes.register !== "function") return { ok: false, reason: "ROUTES_MISSING" };
  const nowMs = d.nowMs;
  const randomBytes = typeof d.randomBytes === "function" ? d.randomBytes : crypto.randomBytes;
  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : null;
  const log = (line) => {
    if (!logger) return;
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const lang = langTagOf(S.language);
  const sessions = createSessions({ linkTtlMs: S.voiceLinkTtlMs, sessionTtlMs: S.voiceSessionTtlMs,
    maxSessions: S.voiceMaxSessions, clock: { now: nowMs }, randomBytes });
  const queue = createVoiceQueue({ S, nowMs, randomBytes });
  let engine = null;
  let cache = null;
  let engineStatus = null;
  if (S.voiceEngine === "piper") {
    const parsed = S.voicePiperUrl === "" ? { ok: false, reason: PIPER_URL_MISSING } : parsePiperUrl(S.voicePiperUrl);
    if (!parsed.ok) {
      engineStatus = parsed.reason;
    } else {
      cache = createAudioCache({ maxBytes: S.voiceCacheMaxBytes, storeMaxBytes: S.voicePiperMaxBytes, nowMs,
        randomBytes });
      const transport = typeof d.piperRequest === "function"
        ? createPiperTransport({ request: d.piperRequest, timeoutSignal: d.piperTimeoutSignal })
        : createDefaultPiperTransport();
      engine = createPiperEngine({ S, transport, cache, url: parsed.synthesizeUrl, voicesUrl: parsed.voicesUrl, nowMs,
        telemetry });
      engineStatus = "running";
    }
  }
  const pageSettings = Object.freeze({ engine: engine ? "piper" : "browser", pollMs: S.voicePollMs,
    rateMilli: S.voiceRateMilli, pitchMilli: S.voicePitchMilli, voiceName: S.voiceName,
    allowRemote: S.voiceAllowRemote, showText: S.voiceShowText, queueMax: S.voiceQueueMax,
    radioFilter: S.voiceRadioFilter, fallbackBrowser: S.voiceFallbackBrowser });
  const pickerOn = S.voicePickerEnabled === true && d.voicePrefs && typeof d.voicePrefs.get === "function"
    && typeof d.voicePrefs.save === "function" && d.persona && typeof d.persona.view === "function"
    && typeof d.persona.apply === "function";
  const prefsOf = (playerId) => {
    if (!pickerOn) return null;
    try {
      return d.voicePrefs.get(playerId) || null;
    } catch (_err) {
      return null;
    }
  };
  const routes = createVoiceRoutes({ sessions, queue, telemetry, log,
    settingsOf: (playerId) => ({ aiName: String(d.aiNameOf(playerId)), lang, settings: pageSettings,
      choice: prefsOf(playerId) }),
    audioOf: (id, playerId) => (cache ? cache.byId(id, playerId) : null),
    picker: pickerOn ? { S, lang, nowMs, engine, voicePrefs: d.voicePrefs, persona: d.persona,
      timeoutSignal: d.testTimeoutSignal } : null,
    panel: S.panelEnabled === true && d.panel ? { S, nowMs, ...d.panel } : null });
  let registered;
  try {
    registered = d.httpRoutes.register(routes);
  } catch (_err) {
    registered = null;
  }
  if (!registered || registered.ok !== true) {
    if (engine) engine.stop();
    const reason = registered && REGISTER_REASONS.includes(registered.reason) ? registered.reason : "ROUTES_MISSING";
    return { ok: false, reason };
  }

  const counters = { links: 0, lines: 0, empty: 0, failed: 0, fallbacks: 0, withAudio: 0 };
  const refused = {};
  const lastLinkAt = new Map();
  let route = registered;

  const refuse = (reason, extra) => {
    refused[reason] = (refused[reason] || 0) + 1;
    return { ok: false, reason, ...(extra || {}) };
  };

  function onDelivered(playerId, lines) {
    try {
      for (const line of Array.isArray(lines) ? lines : []) {
        const text = toSpeechText(line, { maxChars: S.voiceMaxLineChars });
        if (text === null) {
          counters.empty += 1;
          continue;
        }
        const parts = splitSentences(text, S.voiceMaxPartChars);
        const c = prefsOf(playerId);
        const pending = engine !== null && !(c && c.engine === "browser");
        const r = queue.push(playerId, parts, lang, { pending });
        if (!r.ok) continue;
        counters.lines += 1;
        if (telemetry) telemetry.count(METRIC.voiceLines, 1);
        if (pending) synthesizeLine(playerId, r.seq, parts.join(" "), c);
      }
    } catch (_err) {
      counters.failed += 1;
    }
  }

  function synthesizeLine(playerId, seq, text, choice) {
    const settle = (res) => {
      try {
        const ok = Boolean(res && res.ok === true);
        if (ok) counters.withAudio += 1;
        else counters.fallbacks += 1;
        queue.resolve(playerId, seq, ok ? res.audioId : null);
      } catch (_err) {
        counters.failed += 1;
      }
    };
    let p;
    try {
      p = engine.synthesize(playerId, text, lang, { wanted: () => queue.awaitsAudio(playerId, seq),
        voice: choice && choice.piper ? choice.piper : undefined,
        lengthScaleMilli: lengthScaleOf(S.voiceLengthScaleMilli, choice ? choice.rateMilli : null) });
    } catch (_err) {
      p = null;
    }
    if (!p || typeof p.then !== "function") settle(null);
    else p.then(settle, () => settle(null));
  }

  function link(playerId, characterName) {
    const now = nowMs();
    const last = lastLinkAt.get(playerId);
    if (last !== undefined && now - last < S.voiceLinkCooldownMs) {
      return refuse("RATE_LIMITED", { waitMs: S.voiceLinkCooldownMs - (now - last) });
    }
    const url = d.observerUrl();
    if (!url || !url.ok) return refuse("OBSERVER_OFF");
    for (const [id, at] of lastLinkAt) {
      if (now - at >= S.voiceLinkCooldownMs) lastLinkAt.delete(id);
    }
    lastLinkAt.set(playerId, now);
    const issued = sessions.issueToken({ characterId: playerId,
      characterName: typeof characterName === "string" ? characterName : null });
    counters.links += 1;
    return { ok: true, href: `${url.url}${PAGE}#t=${issued.token}`, ttlMs: S.voiceLinkTtlMs };
  }

  function off(playerId) {
    const r = queue.detach(playerId);
    if (r.sid) sessions.end(r.sid);
    const revoked = sessions.revokeActor(playerId);
    return { ok: true, ended: r.ended || revoked > 0 };
  }

  function statusOf(playerId) {
    return { listening: queue.listening(playerId) };
  }

  function getStatus() {
    const q = queue.status();
    const s = sessions.status();
    const r = routes.status();
    const out = { state: route ? "running" : "stopped", engine: S.voiceEngine, links: counters.links,
      lines: counters.lines, empty: counters.empty, failed: counters.failed, sessions: s.sessions,
      sessionsOpened: r.opened, httpRefused: r.refused, listeners: q.listeners, buffered: q.buffered,
      superseded: q.superseded, dropped: q.dropped, noListener: q.noListener };
    if (engineStatus !== null) out.engineStatus = engineStatus;
    if (engine) {
      out.fallbacks = counters.fallbacks;
      out.withAudio = counters.withAudio;
      out.audioServed = r.audio;
      if (q.pendingExpired) out.pendingExpired = q.pendingExpired;
      out.piper = engine.status();
    }
    if (pickerOn) {
      for (const k of ["optionsServed", "choicesSaved", "personaSaved", "tests", "testAudio"]) out[k] = r[k];
      for (const [k, n] of Object.entries(r)) if (k.startsWith("refused_")) out[k] = (out[k] || 0) + n;
    }
    for (const [reason, n] of Object.entries(refused)) {
      const k = `refused_${reason}`;
      out[k] = (out[k] || 0) + n;
    }
    if (r.panel) out.panel = r.panel;
    return out;
  }

  function stop() {
    if (route) {
      try {
        route.unregister();
      } catch (_err) {
        log("shipAi: voice unregister failed");
      }
      route = null;
    }
    if (engine) engine.stop();
    queue.clear();
    sessions.clear();
    lastLinkAt.clear();
  }

  return { ok: true, voice: Object.freeze({ onDelivered, link, off, statusOf, getStatus, stop }) };
}

function voicedDeliver(deliver, voice) {
  return function voiced(playerId, lines) {
    const res = deliver(playerId, lines);
    try {
      if (res && res.room + res.system > 0) voice.onDelivered(playerId, lines);
    } catch (_err) {
    }
    return res;
  };
}

module.exports = { createShipAiVoice, voicedDeliver, observerUrlOf, PAGE, PIPER_NOT_BUILT, PIPER_URL_MISSING };
