"use strict";

const { BUCKET_HINTS } = require("./data/bucketHints");
const { normalizeLine } = require("./filter");
const { PROFANITY_LEVELS } = require("./schema");

const VOICE_LANE = "voice";
const VOICE_KEY_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;

function bad(detail) {
  return { ok: false, reason: "BAD_CATALOGUE", detail };
}

function hintOf(key) {
  if (Object.prototype.hasOwnProperty.call(BUCKET_HINTS, key)) return BUCKET_HINTS[key];
  const wildcard = `${key.slice(0, key.lastIndexOf(".") + 1)}*`;
  return Object.prototype.hasOwnProperty.call(BUCKET_HINTS, wildcard) ? BUCKET_HINTS[wildcard] : null;
}

function isTextList(list) {
  return Array.isArray(list) && list.every((x) => x && typeof x.text === "string");
}

function isNameList(list) {
  return Array.isArray(list) && list.every((x) => typeof x === "string" && x !== "");
}

function specOf(key, lane, kind, name, lines, closedSet, S, voice) {
  const hint = voice ? voice.hint : hintOf(key);
  if (hint === null) return bad(`no hint for ${key}`);
  if (!isTextList(lines)) return bad(`${key}: lines are not a list of {text}`);
  const texts = lines.map((x) => x.text);
  const used = new Set();
  for (const t of texts) for (const m of t.matchAll(PLACEHOLDER_RE)) used.add(m[1]);
  const spec = {
    key,
    lane,
    kind,
    name,
    hint,
    placeholders: Object.freeze(closedSet.filter((p) => used.has(p))),
    examples: Object.freeze(texts.slice(0, S.promptExamples)),
    staticNormalized: Object.freeze(new Set(texts.map(normalizeLine))),
  };
  if (voice) {
    if (voice.style !== undefined) spec.style = voice.style;
    if (voice.profanityCap !== undefined) spec.profanityCap = voice.profanityCap;
    spec.onDemand = voice.onDemand;
  }
  return { ok: true, spec: Object.freeze(spec) };
}

function voiceSpecs(list, S, out) {
  if (!Array.isArray(list)) return bad("voice: not a list");
  for (let i = 0; i < list.length; i += 1) {
    const v = list[i];
    if (!v || typeof v !== "object") return bad(`voice[${i}]: not an object`);
    if (typeof v.key !== "string" || !VOICE_KEY_RE.test(v.key)) return bad(`voice[${i}]: key is not a dotted name`);
    if (v.lane !== VOICE_LANE) return bad(`${v.key}: lane is not "${VOICE_LANE}"`);
    if (typeof v.hint !== "string" || v.hint.trim() === "") return bad(`${v.key}: no hint`);
    if (v.style !== undefined && (typeof v.style !== "string" || v.style.trim() === "")) {
      return bad(`${v.key}: style is not a text`);
    }
    if (v.profanityCap !== undefined && !PROFANITY_LEVELS.includes(v.profanityCap)) {
      return bad(`${v.key}: profanityCap is not one of ${PROFANITY_LEVELS.join(", ")}`);
    }
    if (typeof v.onDemand !== "boolean") return bad(`${v.key}: onDemand is not a boolean`);
    if (!isNameList(v.placeholders)) return bad(`${v.key}: placeholders is not a name list`);
    const r = specOf(v.key, VOICE_LANE, VOICE_LANE, typeof v.name === "string" ? v.name : v.key, v.lines,
      v.placeholders, S, v);
    if (!r.ok) return r;
    out.push(r.spec);
  }
  return { ok: true };
}

function civilianSpecs(c, S, out) {
  if (!c || typeof c !== "object") return bad("civilian: not an object");
  if (!isNameList(c.BACKGROUND_CATEGORIES) || !isNameList(c.PLACEHOLDERS)) {
    return bad("civilian: BACKGROUND_CATEGORIES / PLACEHOLDERS are not name lists");
  }
  if (!c.BACKGROUND || typeof c.BACKGROUND !== "object" || !c.RUMOURS || typeof c.RUMOURS !== "object") {
    return bad("civilian: BACKGROUND / RUMOURS are not objects");
  }
  for (const cat of c.BACKGROUND_CATEGORIES) {
    const r = specOf(`hs.bg.${cat}`, "civilian", "background", cat, c.BACKGROUND[cat], c.PLACEHOLDERS, S);
    if (!r.ok) return r;
    out.push(r.spec);
  }
  for (const kind of Object.keys(c.RUMOURS)) {
    const r = specOf(`hs.rumour.${kind}`, "civilian", "rumour", kind, c.RUMOURS[kind], c.PLACEHOLDERS, S);
    if (!r.ok) return r;
    out.push(r.spec);
  }
  return { ok: true };
}

function residentSpecs(c, S, out) {
  if (!c || typeof c !== "object") return bad("resident: not an object");
  if (!isNameList(c.CONTEXTS) || !isNameList(c.PLACEHOLDERS)) {
    return bad("resident: CONTEXTS / PLACEHOLDERS are not name lists");
  }
  if (!c.LINES || typeof c.LINES !== "object") return bad("resident: LINES is not an object");
  for (const ctx of c.CONTEXTS) {
    const r = specOf(`fc.${ctx}`, "resident", "resident", ctx, c.LINES[ctx], c.PLACEHOLDERS, S);
    if (!r.ok) return r;
    out.push(r.spec);
  }
  return { ok: true };
}

function buildBucketSpecs(catalogues, S) {
  if (!catalogues || typeof catalogues !== "object") return bad("catalogues: not an object");
  if (!S || !Number.isSafeInteger(S.promptExamples) || S.promptExamples < 0) {
    return bad("settings: promptExamples is not a safe integer >= 0");
  }
  const out = [];
  if (catalogues.civilian !== null && catalogues.civilian !== undefined) {
    const r = civilianSpecs(catalogues.civilian, S, out);
    if (!r.ok) return r;
  }
  if (catalogues.resident !== null && catalogues.resident !== undefined) {
    const r = residentSpecs(catalogues.resident, S, out);
    if (!r.ok) return r;
  }
  if (catalogues.voice !== null && catalogues.voice !== undefined) {
    const r = voiceSpecs(catalogues.voice, S, out);
    if (!r.ok) return r;
    const keys = new Set();
    for (const b of out) {
      if (keys.has(b.key)) return bad(`duplicate bucket key ${b.key}`);
      keys.add(b.key);
    }
  }
  if (out.length === 0) return { ok: false, reason: "NO_BUCKETS", detail: "no bucket in the catalogues" };
  return { ok: true, buckets: Object.freeze(out) };
}

module.exports = { buildBucketSpecs };
