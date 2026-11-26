"use strict";

const { performance } = require("node:perf_hooks");
const { createRng, deriveSeed } = require("../util/rng");
const { voiceOf, isGlyphVoice, bucketKeyOf, pickVoiceLine, fillVoiceTemplate } = require("./lines");
const { alphabetOf } = require("./glyphs");
const { FAME_CONTEXTS } = require("./data/voiceLines");
const { LOCAL_COUNTER_NAMES, METRIC_LOCAL_LINES, METRIC_AI_LINES, METRIC_GLYPH_LINES, METRIC_SEND_FAILED,
  METRIC_RATE_LIMITED, METRIC_PASS_MS } = require("./schema");

const PERMILLE = 1000;
const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const MS_DECIMALS = 10;
const NO_CREWS = Object.freeze([]);
const NO_SOCKET = "NO_SOCKET";
const FAME_STREAM = "fv-fame";

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function createMinuteLimiter(max) {
  const cap = Number.isSafeInteger(max) && max > 0 ? max : 0;
  const times = [];
  const expire = (now) => {
    while (times.length > 0 && times[0] + MINUTE_MS <= now) times.shift();
  };
  return Object.freeze({
    tryTake(now) {
      expire(now);
      if (times.length >= cap) return false;
      times.push(now);
      return true;
    },
    inWindow(now) {
      expire(now);
      return times.length;
    },
    release() {
      times.pop();
    },
  });
}

function systemNameOf(graphOrFacade, systemId) {
  try {
    let g = graphOrFacade;
    if (g && typeof g.getSystem !== "function" && typeof g.getGraph === "function") {
      const r = g.getGraph();
      g = r && r.ok === true ? r.graph : null;
    }
    const sys = g && typeof g.getSystem === "function" ? g.getSystem(systemId) : null;
    return sys && typeof sys.name === "string" && sys.name !== "" ? sys.name : null;
  } catch (_err) {
    return null;
  }
}

function soft(getter) {
  try {
    return typeof getter === "function" ? getter() || null : null;
  } catch (_err) {
    return null;
  }
}

function softCall(fn) {
  try {
    return fn() || null;
  } catch (_err) {
    return null;
  }
}

const isFameContext = (c) => FAME_CONTEXTS.includes(c);

function createLocalLane(opts) {
  const { L, V, worldSeed, now, metric, send } = opts;
  const counters = Object.fromEntries(LOCAL_COUNTER_NAMES.map((n) => [n, 0]));
  let pending = null;
  const systems = new Map();
  const addressedAt = new Map();
  const recognizedAt = new Map();
  const limiter = createMinuteLimiter(L.maxLinesPerMinute);
  let lastSendError = null;
  let muted = false;

  function bump(name, n = 1) {
    counters[name] += n;
  }

  function noteFactionCrews(bySystem) {
    if (!(bySystem instanceof Map)) return;
    const copy = new Map();
    for (const [systemId, list] of bySystem) {
      if (!isPositiveInt(systemId) || !Array.isArray(list)) continue;
      const crews = list.filter((c) => c && isPositiveInt(c.characterId) && isPositiveInt(c.factionId))
        .map((c) => Object.freeze({ characterId: c.characterId, factionId: c.factionId }));
      if (crews.length > 0) copy.set(systemId, Object.freeze(crews));
    }
    pending = copy;
    bump("notes");
  }

  function gapOf(systemId, slot) {
    return createRng(deriveSeed(worldSeed, "fv-gap", systemId, slot)).nextInt(L.minGapMs, L.maxGapMs);
  }

  function applyPending(at) {
    if (pending === null) return;
    const next = pending;
    pending = null;
    for (const [systemId, st] of systems) if (!next.has(systemId)) st.crews = NO_CREWS;
    for (const [systemId, crews] of next) {
      const slot = Math.floor(at / L.minGapMs);
      const first = createRng(deriveSeed(worldSeed, "fv-first", systemId, slot)).nextInt(0, L.minGapMs);
      const st = systems.get(systemId);
      if (st) {
        if (st.crews.length === 0) st.nextAt = Math.max(st.nextAt, at + first);
        st.crews = crews;
        continue;
      }
      if (systems.size >= L.maxSystems) {
        let victim = systems.keys().next().value;
        for (const [id, s] of systems) {
          if (s.crews.length === 0) {
            victim = id;
            break;
          }
        }
        systems.delete(victim);
        bump("systemsDropped");
      }
      systems.set(systemId, { crews, nextAt: at + first, slot, recent: [], hour: [], lastSpeaker: null });
    }
  }

  function pruneQuiet(at) {
    for (const [systemId, st] of systems) {
      if (st.crews.length > 0) continue;
      while (st.hour.length > 0 && st.hour[0] + HOUR_MS <= at) st.hour.shift();
      if (st.hour.length === 0) systems.delete(systemId);
    }
  }

  function playersOf(presence, systemId, at) {
    let sp = null;
    try {
      sp = presence && typeof presence.getSystemPresence === "function" ? presence.getSystemPresence(systemId) : null;
    } catch (_err) {
      sp = null;
    }
    const list = sp && Array.isArray(sp.characters) ? sp.characters : [];
    return list.filter((c) => c && isPositiveInt(c.characterId) && typeof c.name === "string" && c.name !== ""
      && !(addressedAt.has(c.characterId) && at - addressedAt.get(c.characterId) < L.addressCooldownMs));
  }

  function famePolicy() {
    const fame = soft(opts.getFame);
    const pol = fame && typeof fame.localPolicy === "function" ? softCall(() => fame.localPolicy()) : null;
    return pol && typeof fame.tierOf === "function" && pol.contextOf ? { fame, pol } : null;
  }

  function recognize(systemId, st, at, speaker, players) {
    const fp = famePolicy();
    if (!fp) return null;
    const { fame, pol } = fp;
    const fr = createRng(deriveSeed(worldSeed, FAME_STREAM, systemId, st.slot));
    const roll = fr.nextInt(0, PERMILLE - 1);
    const pickIdx = fr.nextUint32();
    if (roll >= pol.permille) return null;
    const famed = [];
    for (const c of players.slice(0, pol.maxCandidates)) {
      if (recognizedAt.has(c.characterId) && at - recognizedAt.get(c.characterId) < pol.cooldownMs) {
        bump("fameCooldown");
        continue;
      }
      const t = softCall(() => fame.tierOf(c.characterId, speaker.factionId));
      const ctx = t && typeof t.tier === "string" && t.tier !== "NONE" ? pol.contextOf[t.tier] : null;
      if (isFameContext(ctx)) famed.push({ c, ctx });
    }
    if (famed.length === 0) {
      bump("fameNoCandidate");
      return null;
    }
    return famed[pickIdx % famed.length];
  }

  function rateLimited() {
    bump("rateLimited");
    metric("count", METRIC_RATE_LIMITED, 1);
  }

  function speak(systemId, st, at, view) {
    while (st.hour.length > 0 && st.hour[0] + HOUR_MS <= at) st.hour.shift();
    if (st.hour.length >= L.maxLinesPerSystemPerHour || limiter.inWindow(at) >= L.maxLinesPerMinute) {
      rateLimited();
      return;
    }
    const rng = createRng(deriveSeed(worldSeed, "fv-chat", systemId, st.slot));
    const speakerIdx = rng.nextUint32();
    const addressRoll = rng.nextInt(0, PERMILLE - 1);
    const pilotIdx = rng.nextUint32();
    const crews = st.crews;
    let idx = speakerIdx % crews.length;
    if (crews[idx].characterId === st.lastSpeaker && crews.length > 1) idx = (idx + 1) % crews.length;
    const speaker = crews[idx];
    const voice = voiceOf(speaker.factionId);
    if (voice === null) {
      bump("noVoice");
      return;
    }
    const glyph = isGlyphVoice(voice);
    let context = "CHATTER";
    let pilot = null;
    if (!glyph && addressRoll < L.addressPermille) {
      const players = playersOf(view.presence, systemId, at);
      if (players.length > 0) {
        context = "ADDRESS";
        pilot = players[pilotIdx % players.length];
        const famed = recognize(systemId, st, at, speaker, players);
        if (famed) {
          pilot = famed.c;
          context = famed.ctx;
        }
      }
    }
    let ai = null;
    if (!glyph) {
      if (view.chatterAi && typeof view.chatterAi.demand === "function") {
        try {
          view.chatterAi.demand(bucketKeyOf(voice, context));
        } catch (_err) {
        }
      }
      ai = view.overlay();
    }
    const glyphs = glyph ? { rng: createRng(deriveSeed(worldSeed, "fv-glyph", systemId, st.slot)),
      alphabet: alphabetOf(voice, V.glyphs.extended), settings: V.glyphs } : null;
    const pick = pickVoiceLine({ voice, context, rng, values: { system: systemNameOf(view.graph, systemId),
      pilot: pilot ? pilot.name : null }, recentLineIds: st.recent, ai, maxChars: V.maxLineChars, glyphs });
    if (!pick.ok) {
      bump("noLine");
      return;
    }
    if (!limiter.tryTake(at)) {
      rateLimited();
      return;
    }
    let sent = null;
    try {
      sent = send({ systemId, characterId: speaker.characterId, text: pick.text });
    } catch (_err) {
      sent = { ok: false, reason: "SEND_THREW" };
    }
    if (!sent || sent.ok !== true) {
      lastSendError = sent && typeof sent.reason === "string" ? sent.reason.slice(0, 40) : "SEND_FAILED";
      if (lastSendError === NO_SOCKET) {
        bump("noSocket");
        limiter.release();
        return;
      }
      bump("sendFailed");
      metric("count", METRIC_SEND_FAILED, 1);
      return;
    }
    bump("lines");
    metric("count", METRIC_LOCAL_LINES, 1);
    if (pick.source === "ai") {
      bump("aiLines");
      metric("count", METRIC_AI_LINES, 1);
    } else if (pick.source === "glyph") {
      bump("glyphLines");
      metric("count", METRIC_GLYPH_LINES, 1);
    } else {
      bump("staticLines");
    }
    st.hour.push(at);
    st.lastSpeaker = speaker.characterId;
    if (L.recentLinesPerSystem > 0) {
      st.recent.push(pick.lineId);
      while (st.recent.length > L.recentLinesPerSystem) st.recent.shift();
    }
    if (context === "ADDRESS" || isFameContext(context)) {
      if (context === "ADDRESS") bump("addressLines");
      else {
        bump("fameLines");
        recognizedAt.set(pilot.characterId, at);
      }
      const named = fillVoiceTemplate("{pilot}", { pilot: pilot.name });
      if (named !== null && pick.text.includes(named)) addressedAt.set(pilot.characterId, at);
    }
  }

  function pass() {
    const t0 = performance.now();
    const at = now();
    applyPending(at);
    bump("passes");
    pruneQuiet(at);
    const due = muted ? [] : [...systems].filter(([, st]) => st.crews.length > 0 && st.nextAt <= at)
      .sort((a, b) => a[1].nextAt - b[1].nextAt || a[0] - b[0]);
    if (due.length > 0) {
      const chatterAi = soft(opts.getChatterAi);
      let overlayRead = false;
      let overlay = null;
      const view = { presence: soft(opts.getPresence), graph: soft(opts.getGraph), chatterAi,
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
      for (const [systemId, st] of due) {
        speak(systemId, st, at, view);
        st.slot += 1;
        st.nextAt = at + gapOf(systemId, st.slot);
      }
    }
    for (const [id, t] of addressedAt) if (at - t >= L.addressCooldownMs) addressedAt.delete(id);
    if (recognizedAt.size > 0) {
      const fp = famePolicy();
      if (!fp) recognizedAt.clear();
      else for (const [id, t] of recognizedAt) if (at - t >= fp.pol.cooldownMs) recognizedAt.delete(id);
    }
    metric("observe", METRIC_PASS_MS, Math.round((performance.now() - t0) * MS_DECIMALS) / MS_DECIMALS);
  }

  function getStatus() {
    return { systems: systems.size, counters: { ...counters },
      ...(lastSendError !== null ? { lastSendError } : {}) };
  }

  function clear() {
    pending = null;
    systems.clear();
    addressedAt.clear();
    recognizedAt.clear();
  }

  function setMuted(on) {
    muted = on === true;
  }

  return Object.freeze({ noteFactionCrews, pass, getStatus, clear, bump, setMuted });
}

module.exports = { createLocalLane, createMinuteLimiter, systemNameOf };
