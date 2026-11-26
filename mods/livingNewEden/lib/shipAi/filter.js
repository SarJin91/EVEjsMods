"use strict";

const { normalizeLine, charsetOf, bannedPatterns, bannedHit, hasLink } = require("../chatterAi/filter");
const { LANGUAGES } = require("../chatterAi/data/languages");
const { BOUNDARIES, META_ALLOWED } = require("./data/boundaries");
const { WORD_FIXES } = require("./data/wordFixes");
const { LANGUAGE_CODES } = require("./schema");

const BASE_LANGUAGE = "en";
const PICTOGRAPH_RE = /[\p{Extended_Pictographic}\u{FE0E}\u{FE0F}\u{200D}]/gu;
const MARKDOWN_RE = /[*_#`]/g;
const SENTENCE_RE = /(?:\d\.\d|[^.!?])+(?:[.!?]+["')\]]*|$)/g;
const FOLD_PAIRS = Object.freeze(Object.values(LANGUAGES).flatMap((p) => p.foldTypography));
const NO_EXTRA = Object.freeze({ bannedWordList: Object.freeze([]) });

const bannedCache = new Map();
const boundaryCache = new Map();

const langOf = (language) => (LANGUAGE_CODES.includes(language) ? language : BASE_LANGUAGE);

function bannedOf(code, level) {
  const key = `${code}|${level}`;
  let b = bannedCache.get(key);
  if (!b) {
    const raw = bannedPatterns(NO_EXTRA, code, level);
    const allowed = new Set(META_ALLOWED.map((w) => ` ${normalizeLine(w)} `));
    b = Object.freeze({ words: raw.words.filter((w) => !allowed.has(w)), prefixes: raw.prefixes,
      infixes: raw.infixes });
    bannedCache.set(key, b);
  }
  return b;
}

function compile(entries) {
  const words = new Set();
  const prefixes = new Set();
  const infixes = new Set();
  for (const raw of entries) {
    const w = String(raw);
    if (w.length > 2 && w.startsWith("*") && w.endsWith("*")) {
      const n = normalizeLine(w.slice(1, -1));
      if (n !== "") infixes.add(n);
    } else if (w.length > 1 && w.endsWith("*")) {
      const n = normalizeLine(w.slice(0, -1));
      if (n !== "") prefixes.add(` ${n}`);
    } else {
      const n = normalizeLine(w);
      if (n !== "") words.add(` ${n} `);
    }
  }
  return Object.freeze({ words: [...words], prefixes: [...prefixes], infixes: [...infixes] });
}

function boundariesOf(code, category) {
  const key = `${code}|${category}`;
  let b = boundaryCache.get(key);
  if (!b) {
    const langs = code === BASE_LANGUAGE ? [BASE_LANGUAGE] : [BASE_LANGUAGE, code];
    b = compile(langs.flatMap((l) => (BOUNDARIES[l] && BOUNDARIES[l][category]) || []));
    boundaryCache.set(key, b);
  }
  return b;
}

const WORD_RE = /\p{L}+/gu;
const fixCache = new Map();

function fixesOf(code) {
  let f = fixCache.get(code);
  if (!f) {
    const exact = new Map();
    const stems = [];
    for (const [from, to] of WORD_FIXES[code] || []) {
      if (from.endsWith("*")) stems.push([from.slice(0, -1), to.replace(/\*$/, "")]);
      else exact.set(from, to);
    }
    stems.sort((a, b) => b[0].length - a[0].length);
    f = Object.freeze({ exact, stems, empty: exact.size === 0 && stems.length === 0 });
    fixCache.set(code, f);
  }
  return f;
}

function fixWords(text, language) {
  const f = fixesOf(langOf(language));
  if (f.empty) return text;
  return text.replace(WORD_RE, (word) => {
    const low = word.toLowerCase();
    let out = f.exact.get(low);
    if (out === undefined) {
      const stem = f.stems.find(([from]) => low.startsWith(from));
      if (!stem) return word;
      out = stem[1] + low.slice(stem[0].length);
    }
    return word[0] !== low[0] ? out[0].toUpperCase() + out.slice(1) : out;
  });
}

function cleanReply(text) {
  let out = String(text).replace(PICTOGRAPH_RE, "");
  for (const [from, to] of FOLD_PAIRS) out = out.split(from).join(to);
  return out.replace(MARKDOWN_RE, "").replace(/\s+/g, " ").trim();
}

function splitWords(sentence, max) {
  const pieces = [];
  let cur = "";
  for (const word of sentence.split(" ")) {
    if (word === "") continue;
    if (word.length > max) return null;
    if (cur === "") cur = word;
    else if (cur.length + 1 + word.length <= max) cur = `${cur} ${word}`;
    else {
      pieces.push(cur);
      cur = word;
    }
  }
  if (cur !== "") pieces.push(cur);
  return pieces;
}

function toLines(text, maxLineChars, maxLines) {
  const lines = [];
  let cur = "";
  const push = (line) => {
    if (lines.length < maxLines) lines.push(line);
  };
  for (const raw of text.match(SENTENCE_RE) || []) {
    const sentence = raw.trim();
    if (sentence === "") continue;
    if (sentence.length > maxLineChars) {
      const pieces = splitWords(sentence, maxLineChars);
      if (pieces === null) break;
      if (cur !== "") push(cur);
      cur = "";
      for (const piece of pieces) push(piece);
    } else if (cur === "") cur = sentence;
    else if (cur.length + 1 + sentence.length <= maxLineChars) cur = `${cur} ${sentence}`;
    else {
      push(cur);
      cur = sentence;
    }
    if (lines.length >= maxLines) {
      cur = "";
      break;
    }
  }
  if (cur !== "") push(cur);
  return lines;
}

function filterReply(text, S, language) {
  if (typeof text !== "string" || !S) return { ok: false, reason: "EMPTY" };
  const code = langOf(language);
  const line = fixWords(cleanReply(text), code);
  if (line === "") return { ok: false, reason: "EMPTY" };
  if (hasLink(line)) return { ok: false, reason: "LINK" };
  if (!charsetOf(code).test(line)) return { ok: false, reason: "CHARSET" };
  const normalized = normalizeLine(line);
  if (normalized === "") return { ok: false, reason: "EMPTY" };
  if (bannedHit(normalized, bannedOf(code, S.profanity))) return { ok: false, reason: "BANNED" };
  if (bannedHit(normalized, boundariesOf(code, "sexual"))) return { ok: false, reason: "SEXUAL" };
  if (bannedHit(normalized, boundariesOf(code, "meta"))) return { ok: false, reason: "META" };
  const lines = toLines(line, S.maxLineChars, S.maxLinesPerReply);
  if (lines.length === 0) return { ok: false, reason: "LENGTH" };
  return { ok: true, lines };
}

module.exports = { filterReply, cleanReply, fixWords, bannedOf, boundariesOf, langOf, compile };
