"use strict";

const { PERSONA, STATIC, DATA_RULE } = require("./data/persona");
const { PERSONA_PRESETS, PRESET_TONES, PRESET_TONE, NO_CARE, PROFANITY_LINE, CUSTOM_TONE, PRECEDENCE, STYLE_RULE,
  STATIC_PRESETS } = require("./data/personaPresets");
const { validatePersonaCustom, DDL_MAX_CHARS } = require("./personaCustom");
const { STATIC_KINDS, LANGUAGE_CODES, PROFANITY_LEVELS } = require("./schema");
const { TRIGGER_TEXT } = require("./data/triggers");
const { sanitizeGameText } = require("./context");

const BASE_LANGUAGE = "en";
const MAX_NAME_CHARS = 40;
const DEFAULT_PLAYER = "captain";
const DEFAULT_PRESET = "default";
const DEFAULT_PROFANITY = "mild";
const FUNCTIONAL_KINDS = Object.freeze(["HELP", "INVITE_SENT", "OFFLINE", "BUSY"]);

const langOf = (language) => (LANGUAGE_CODES.includes(language) ? language : BASE_LANGUAGE);
const presetOf = (preset) => (PERSONA_PRESETS.includes(preset) ? preset : DEFAULT_PRESET);

function promptName(value, fallback) {
  const text = String(value ?? "").replace(/[\p{Cc}\p{Cf}<>{}`]/gu, " ").replace(/\s+/g, " ").trim()
    .slice(0, MAX_NAME_CHARS);
  return text === "" ? fallback : text;
}

function fill(text, values) {
  return text.replace(/\{(ai|player|lines)\}/g, (_m, key) => String(values[key]));
}

function resolvePersona(pref, defaultPreset) {
  const fallback = PERSONA_PRESETS.includes(defaultPreset) && defaultPreset !== "custom" ? defaultPreset
    : DEFAULT_PRESET;
  const p = pref && typeof pref === "object" ? pref : null;
  if (!p || !PERSONA_PRESETS.includes(p.preset)) return { preset: fallback, custom: null };
  if (p.preset === "custom") {
    return typeof p.custom === "string" && p.custom !== "" ? { preset: "custom", custom: p.custom }
      : { preset: fallback, custom: null };
  }
  return { preset: p.preset, custom: null };
}

function personaToneOf(preset) {
  return PRESET_TONES[presetOf(preset)];
}

function buildSystemPrompt(spec) {
  const s = spec || {};
  const lang = langOf(s.language);
  const p = PERSONA[lang];
  const values = { ai: promptName(s.aiName, "Jin"), player: promptName(s.playerName, DEFAULT_PLAYER),
    lines: Number.isSafeInteger(s.maxLines) && s.maxLines > 0 ? s.maxLines : 1 };
  const profanity = PROFANITY_LEVELS.includes(s.profanity) ? s.profanity : DEFAULT_PROFANITY;
  let preset = presetOf(s.preset);
  let wish = null;
  if (preset === "custom") {
    const checked = validatePersonaCustom(s.custom, { language: lang, profanity,
      personaCustomMaxChars: Number.isSafeInteger(s.customMaxChars) ? s.customMaxChars : DDL_MAX_CHARS });
    if (checked.ok) wish = checked.text;
    else preset = DEFAULT_PRESET;
  }
  const tone = wish !== null
    ? [CUSTOM_TONE[lang], `STYLE ${JSON.stringify({ wish })}`]
    : [...PRESET_TONE[preset][lang], NO_CARE[lang]];
  const rows = [...p.intro, ...tone, ...p.style];
  if (preset === "savage") rows.push(PROFANITY_LINE[profanity][lang]);
  rows.push(...p.rules, PRECEDENCE[lang]);
  const text = rows.map((row) => fill(row, values)).join("\n").concat("\n", DATA_RULE);
  return wish !== null ? text.concat("\n", STYLE_RULE) : text;
}

function staticLine(kind, language, seed, preset) {
  const lang = langOf(language);
  const k = STATIC_KINDS.includes(kind) ? kind : "SIGNAL_LOST";
  const own = !FUNCTIONAL_KINDS.includes(k) && STATIC_PRESETS[preset] && STATIC_PRESETS[preset][lang]
    ? STATIC_PRESETS[preset][lang][k] : null;
  const variants = Array.isArray(own) && own.length > 0 ? own : STATIC[lang][k];
  const n = Number.isSafeInteger(seed) ? Math.abs(seed) : 0;
  return variants[n % variants.length];
}

const VALUE_MAX_CHARS = 60;
const ISK_STEPS = Object.freeze([
  Object.freeze({ at: 1e9, pl: "mld", en: "billion" }),
  Object.freeze({ at: 1e6, pl: "mln", en: "million" }),
  Object.freeze({ at: 1e3, pl: "tys.", en: "thousand" }),
]);

function numberText(value, lang) {
  if (Number.isSafeInteger(value)) return String(value);
  const text = String(Math.round(value * 10) / 10);
  return lang === "pl" ? text.replace(".", ",") : text;
}

function formatIsk(isk, language) {
  const lang = langOf(language);
  const v = Number(isk);
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  const step = ISK_STEPS.find((s) => abs >= s.at);
  if (!step) return `${numberText(Math.round(v), lang)} ISK`;
  return `${numberText(Math.round((v / step.at) * 10) / 10, lang)} ${step[lang]} ISK`;
}

function staticLineWith(kind, language, seed, values, preset) {
  const lang = langOf(language);
  const own = TRIGGER_TEXT[lang] && Object.prototype.hasOwnProperty.call(TRIGGER_TEXT[lang], kind)
    ? TRIGGER_TEXT[lang][kind] : null;
  const presetOwn = STATIC_PRESETS[preset] && STATIC_PRESETS[preset][lang] ? STATIC_PRESETS[preset][lang][kind] : null;
  let template;
  if (own) {
    const variants = Array.isArray(presetOwn) && presetOwn.length > 0 ? presetOwn : own;
    template = variants[(Number.isSafeInteger(seed) ? Math.abs(seed) : 0) % variants.length];
  } else if (STATIC_KINDS.includes(kind)) {
    template = staticLine(kind, lang, seed, preset);
  } else {
    return "";
  }
  const v = values && typeof values === "object" ? values : {};
  let missing = false;
  const text = template.replace(/\{([a-zA-Z]+)\}/g, (_m, key) => {
    const value = Object.prototype.hasOwnProperty.call(v, key) ? v[key] : undefined;
    let out = "";
    if (typeof value === "number" && Number.isFinite(value)) out = numberText(value, lang);
    else if (typeof value === "string") out = sanitizeGameText(value, VALUE_MAX_CHARS);
    if (out === "") missing = true;
    return out;
  });
  return missing ? "" : text;
}

module.exports = { buildSystemPrompt, staticLine, promptName, resolvePersona, personaToneOf, staticLineWith,
  formatIsk };
