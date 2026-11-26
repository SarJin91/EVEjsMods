"use strict";

const { AI_VOICES, GLYPH_VOICES, FACTION_VOICE, STYLES, PROFANITY_CAPS } = require("./data/voices");
const { CONTEXTS, FAME_CONTEXTS, PLACEHOLDERS, CONTEXT_HINTS, LINES } = require("./data/voiceLines");
const { glyphLine } = require("./glyphs");

const PERMILLE = 1000;
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;
const MARKUP_RE = /[<>&]/g;
const AI_ID_PREFIX = "ai-";
const BUCKET_PREFIX = "fv";
const VOICE_LANE = "voice";

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function voiceOf(factionId) {
  return Number.isSafeInteger(factionId) && hasOwn(FACTION_VOICE, factionId) ? FACTION_VOICE[factionId] : null;
}

function isGlyphVoice(voice) {
  return GLYPH_VOICES.includes(voice);
}

function bucketKeyOf(voice, context) {
  return `${BUCKET_PREFIX}.${voice}.${context}`;
}

function fillVoiceTemplate(text, values, maxChars) {
  if (typeof text !== "string") return null;
  let bad = false;
  const out = text.replace(PLACEHOLDER_RE, (_m, name) => {
    const raw = PLACEHOLDERS.includes(name) && values && typeof values === "object" ? values[name] : undefined;
    const v = raw === null || raw === undefined ? "" : String(raw).replace(MARKUP_RE, "").trim();
    if (v === "") {
      bad = true;
      return "";
    }
    return v;
  });
  if (bad || out.includes("{") || out.includes("}")) return null;
  if (Number.isSafeInteger(maxChars) && out.length > maxChars) return null;
  return out;
}

function firstFitting(list, start, values, maxChars, recent) {
  let fallback = null;
  let fallbackAge = Infinity;
  for (let k = 0; k < list.length; k += 1) {
    const t = list[(start + k) % list.length];
    const text = fillVoiceTemplate(t.text, values, maxChars);
    if (text === null) continue;
    const at = recent.lastIndexOf(t.id);
    if (at < 0) return { id: t.id, text };
    if (at < fallbackAge) {
      fallback = { id: t.id, text };
      fallbackAge = at;
    }
  }
  return fallback;
}

function safeLinesOf(ai, bucketKey) {
  let list = null;
  try {
    list = typeof ai.linesOf === "function" ? ai.linesOf(bucketKey) : null;
  } catch (_err) {
    list = null;
  }
  if (!Array.isArray(list)) return [];
  return list.filter((t) => t && typeof t.id === "string" && t.id.startsWith(AI_ID_PREFIX) && typeof t.text === "string");
}

function pickVoiceLine(input) {
  const s = input && typeof input === "object" ? input : {};
  const voice = s.voice;
  const glyph = isGlyphVoice(voice);
  if (!glyph && !AI_VOICES.includes(voice)) return { ok: false, reason: "NO_VOICE" };
  if (!s.rng || typeof s.rng.nextUint32 !== "function") return { ok: false, reason: "NO_LINE" };
  const lineIdx = s.rng.nextUint32();
  const aiRoll = s.rng.nextInt(0, PERMILLE - 1);
  const aiIdx = s.rng.nextUint32();

  if (glyph) {
    const g = s.glyphs;
    const text = g && g.rng ? glyphLine(g.rng, g.alphabet, g.settings) : null;
    if (text === null || (Number.isSafeInteger(s.maxChars) && text.length > s.maxChars)) {
      return { ok: false, reason: "NO_LINE" };
    }
    return { ok: true, text, lineId: `glyph.${voice}`, source: "glyph", bucketKey: null };
  }
  if (!CONTEXTS.includes(s.context) && !FAME_CONTEXTS.includes(s.context)) return { ok: false, reason: "NO_LINE" };
  const values = s.values && typeof s.values === "object" ? s.values : {};
  const recent = Array.isArray(s.recentLineIds) ? s.recentLineIds : [];
  const bucketKey = bucketKeyOf(voice, s.context);
  const list = LINES[voice][s.context];
  const chosen = list.length > 0 ? firstFitting(list, lineIdx % list.length, values, s.maxChars, recent) : null;
  if (!chosen) return { ok: false, reason: "NO_LINE" };
  const ai = s.ai;
  if (ai && Number.isSafeInteger(ai.permille) && aiRoll < ai.permille) {
    const pool = safeLinesOf(ai, bucketKey);
    const aiChosen = pool.length > 0 ? firstFitting(pool, aiIdx % pool.length, values, s.maxChars, recent) : null;
    if (aiChosen) return { ok: true, text: aiChosen.text, lineId: aiChosen.id, source: "ai", bucketKey };
  }
  return { ok: true, text: chosen.text, lineId: chosen.id, source: "static", bucketKey };
}

function voiceCatalogue() {
  return { VOICES: AI_VOICES, CONTEXTS, FAME_CONTEXTS, PLACEHOLDERS, LINES, STYLES, CONTEXT_HINTS, PROFANITY_CAPS };
}

function voiceBucketEntries(opts) {
  const c = voiceCatalogue();
  const out = [];
  const add = (voice, context) => out.push(Object.freeze({ key: bucketKeyOf(voice, context), lane: VOICE_LANE,
    name: `${voice}.${context}`, hint: c.CONTEXT_HINTS[context], style: c.STYLES[voice],
    profanityCap: c.PROFANITY_CAPS[voice], onDemand: true, placeholders: c.PLACEHOLDERS,
    lines: c.LINES[voice][context] }));
  for (const voice of c.VOICES) {
    for (const context of c.CONTEXTS) add(voice, context);
  }
  if (opts && opts.fame === true) {
    for (const voice of c.VOICES) {
      for (const context of c.FAME_CONTEXTS) add(voice, context);
    }
  }
  return Object.freeze(out);
}

module.exports = { voiceOf, isGlyphVoice, bucketKeyOf, fillVoiceTemplate, pickVoiceLine, voiceCatalogue,
  voiceBucketEntries };
