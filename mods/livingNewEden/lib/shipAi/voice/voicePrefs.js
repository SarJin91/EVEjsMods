"use strict";

const { VOICE_INTEGER_RANGES } = require("../schema");

const VOICE_PREFS_VERSION = 1;
const VOICE_PREFS_MAX_CHARS = 512;
const BROWSER_VOICE_MAX_CHARS = 128;
const PIPER_NAME_RE = /^([a-z]{2,3})_([A-Z]{2})-([A-Za-z0-9_]+)-(x_low|low|medium|high)$/;
const ENGINES = Object.freeze(["piper", "browser"]);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const VOICE_PREFS_REASONS = Object.freeze(["BAD_BODY", "BAD_ENGINE", "BAD_PIPER_VOICE", "PIPER_UNAVAILABLE",
  "BAD_BROWSER_VOICE", "BAD_RATE", "BAD_PITCH", "BAD_RADIO"]);
const [LENGTH_SCALE_MIN, LENGTH_SCALE_MAX] = VOICE_INTEGER_RANGES.voiceLengthScaleMilli;
const MILLI = 1000;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v) => v === undefined || v === null;

function inRange(v, range) {
  return Number.isSafeInteger(v) && v >= range[0] && v <= range[1];
}

function normalizeVoicePrefs(input, lim) {
  if (!isPlainObject(input) || !isPlainObject(lim)) return { ok: false, reason: "BAD_BODY" };
  const out = { v: VOICE_PREFS_VERSION, engine: null, piper: null, browser: null, rateMilli: null, pitchMilli: null,
    radio: null };
  if (!absent(input.engine)) {
    if (!ENGINES.includes(input.engine)) return { ok: false, reason: "BAD_ENGINE" };
    out.engine = input.engine;
  }
  if (!absent(input.piper)) {
    if (typeof input.piper !== "string" || !PIPER_NAME_RE.test(input.piper)) {
      return { ok: false, reason: "BAD_PIPER_VOICE" };
    }
    if (lim.piperVoices === null || lim.piperVoices === undefined) return { ok: false, reason: "PIPER_UNAVAILABLE" };
    if (!lim.piperVoices.has(input.piper)) return { ok: false, reason: "BAD_PIPER_VOICE" };
    out.piper = input.piper;
  }
  if (!absent(input.browser)) {
    const name = input.browser;
    if (typeof name !== "string" || name === "" || name.length > BROWSER_VOICE_MAX_CHARS || CONTROL_RE.test(name)) {
      return { ok: false, reason: "BAD_BROWSER_VOICE" };
    }
    out.browser = name;
  }
  if (!absent(input.rateMilli)) {
    if (!inRange(input.rateMilli, lim.rateRange)) return { ok: false, reason: "BAD_RATE" };
    out.rateMilli = input.rateMilli;
  }
  if (!absent(input.pitchMilli)) {
    if (!inRange(input.pitchMilli, lim.pitchRange)) return { ok: false, reason: "BAD_PITCH" };
    out.pitchMilli = input.pitchMilli;
  }
  if (!absent(input.radio)) {
    if (typeof input.radio !== "boolean") return { ok: false, reason: "BAD_RADIO" };
    out.radio = input.radio;
  }
  const empty = out.engine === null && out.piper === null && out.browser === null && out.rateMilli === null
    && out.pitchMilli === null && out.radio === null;
  return { ok: true, prefs: empty ? null : Object.freeze(out) };
}

function parseVoicePrefs(text) {
  if (typeof text !== "string" || text === "" || text.length > VOICE_PREFS_MAX_CHARS) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch (_err) {
    return null;
  }
  if (!isPlainObject(value) || value.v !== VOICE_PREFS_VERSION) return null;
  const wide = [0, Number.MAX_SAFE_INTEGER];
  const r = normalizeVoicePrefs({ engine: value.engine, browser: value.browser, rateMilli: value.rateMilli,
    pitchMilli: value.pitchMilli, radio: value.radio }, { piperVoices: null, rateRange: wide, pitchRange: wide });
  if (!r.ok) return null;
  const piper = absent(value.piper) ? null : value.piper;
  if (piper !== null && (typeof piper !== "string" || !PIPER_NAME_RE.test(piper))) return null;
  const base = r.prefs || { v: VOICE_PREFS_VERSION, engine: null, piper: null, browser: null, rateMilli: null,
    pitchMilli: null, radio: null };
  if (piper === null && r.prefs === null) return null;
  return Object.freeze({ ...base, piper });
}

function lengthScaleOf(baseMilli, rateMilli) {
  if (!Number.isSafeInteger(rateMilli) || rateMilli <= 0) return baseMilli;
  const v = Math.round((baseMilli * MILLI) / rateMilli);
  return Math.min(LENGTH_SCALE_MAX, Math.max(LENGTH_SCALE_MIN, v));
}

function piperVoiceLabel(id) {
  const m = PIPER_NAME_RE.exec(String(id));
  return m ? `${m[3]} (${m[4]})` : String(id);
}

module.exports = { normalizeVoicePrefs, parseVoicePrefs, lengthScaleOf, piperVoiceLabel, PIPER_NAME_RE,
  VOICE_PREFS_MAX_CHARS, BROWSER_VOICE_MAX_CHARS, VOICE_PREFS_REASONS, VOICE_PREFS_VERSION };
