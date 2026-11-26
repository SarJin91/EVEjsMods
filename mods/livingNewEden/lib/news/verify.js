"use strict";

const TITLE_RE = /^\s*(?:title|tytuł|tytul)\s*:\s*(.*)$/iu;
const DIGITS_RE = /\d+/g;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const MIN_NAME_CHARS = 3;
const PL_MAX_ENDING = 4;
const PL_FINAL_VOWEL_RE = /[aeiouyąęó]$/iu;
const PL_ALTERNATIONS = Object.freeze([["ch", "sz"], ["t", "c"], ["d", "dz"], ["r", "rz"], ["k", "c"], ["g", "dz"],
  ["ł", "l"]]);
const BOUND_BEFORE = "(?<![\\p{L}\\p{N}])";
const BOUND_AFTER = "(?![\\p{L}\\p{N}])";
const ARTICLE_RE = /^The /;

function fail(reason) {
  return { ok: false, reason };
}

function isWordChar(ch) {
  return ch !== undefined && ch !== "" && WORD_CHAR_RE.test(ch);
}

function findWhole(hay, needle) {
  if (needle === "") return -1;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + needle.length])) return i;
    i = hay.indexOf(needle, i + 1);
  }
  return -1;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plStems(word) {
  const out = [];
  const base = PL_FINAL_VOWEL_RE.test(word) ? word.slice(0, -1) : word;
  if (base.length >= 2 && base !== word) out.push(base);
  const lower = base.toLowerCase();
  for (const [from, to] of PL_ALTERNATIONS) {
    if (lower.endsWith(from) && base.length - from.length >= 1) {
      out.push(`${base.slice(0, base.length - from.length)}${to}`);
      break;
    }
  }
  return out;
}

function factRegex(name, pl) {
  const words = name.split(" ");
  const last = words.pop();
  const head = words.map((w) => `${escapeRe(w)}\\s+`).join("");
  let tail = escapeRe(last);
  if (pl && last.length >= MIN_NAME_CHARS) {
    const ending = `(?:['’-]?\\p{L}{1,${PL_MAX_ENDING}})`;
    const stems = plStems(last).map((st) => `${escapeRe(st)}${ending}`);
    tail = `(?:${escapeRe(last)}${ending}?${stems.map((st) => `|${st}`).join("")})`;
  }
  return new RegExp(`${BOUND_BEFORE}${head}${tail}${BOUND_AFTER}`, "giu");
}

function cutAll(hay, re) {
  return hay.replace(re, (m) => " ".repeat(m.length));
}

function cleanNames(list) {
  const out = [];
  if (!list || typeof list[Symbol.iterator] !== "function") return out;
  for (const n of list) {
    if (typeof n !== "string") continue;
    const v = n.replace(/\s+/g, " ").trim();
    if (v !== "") out.push(v);
  }
  return out;
}

function intOf(v, fallback) {
  return Number.isSafeInteger(v) ? v : fallback;
}

function shapeOf(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (i >= lines.length) return null;
  const m = TITLE_RE.exec(lines[i]);
  if (!m) return null;
  const title = m[1].replace(/\s+/g, " ").trim();
  if (title === "") return null;
  const paragraphs = [];
  let current = [];
  for (const line of lines.slice(i + 1)) {
    const t = line.trim();
    if (t === "") {
      if (current.length > 0) paragraphs.push(current.join(" "));
      current = [];
    } else current.push(t);
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return { title, paragraphs: paragraphs.map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p !== "") };
}

function verifyNewsText(text, ctx) {
  try {
    const c = ctx || {};
    const s = c.settings || {};
    if (typeof text !== "string") return fail("SHAPE");
    const shape = shapeOf(text);
    if (shape === null) return fail("SHAPE");
    const { title, paragraphs } = shape;
    if (paragraphs.length < intOf(s.minParagraphs, 1) || paragraphs.length > intOf(s.maxParagraphs, Infinity)) {
      return fail("SHAPE");
    }
    const body = paragraphs.join("\n\n");
    if (title.length > intOf(s.maxTitleChars, Infinity) || body.length < intOf(s.minBodyChars, 0)
      || body.length > intOf(s.maxBodyChars, Infinity)) return fail("LENGTH");
    const all = `${title}\n${body}`;
    const numbers = c.numbers instanceof Set ? c.numbers : new Set();
    for (const m of all.matchAll(DIGITS_RE)) {
      if (!numbers.has(m[0]) && !numbers.has(String(Number(m[0])))) return fail("NUMBER_UNSOURCED");
    }
    const pl = c.language === "pl";
    const factNames = cleanNames(c.factNames);
    const factSet = new Set(factNames.map((n) => n.toLowerCase()));
    const entries = factNames.map((name) => ({ name, fact: true }));
    for (const name of cleanNames(c.knownNames)) {
      if (name.length >= MIN_NAME_CHARS && !factSet.has(name.toLowerCase())) entries.push({ name, fact: false });
    }
    entries.sort((a, b) => (b.name.length - a.name.length) || (Number(b.fact) - Number(a.fact)));
    let rest = all;
    for (const e of entries) {
      if (e.fact) rest = cutAll(rest, factRegex(e.name, pl));
      else if (findWhole(rest, e.name) >= 0 || (ARTICLE_RE.test(e.name)
        && findWhole(rest, e.name.replace(ARTICLE_RE, "the ")) >= 0)) return fail("NAME_UNSOURCED");
    }
    for (const n of cleanNames(c.topSystemNames)) {
      if (!factRegex(n, pl).test(all)) return fail("COVERAGE");
    }
    return { ok: true, title, paragraphs };
  } catch (_err) {
    return fail("SHAPE");
  }
}

module.exports = { verifyNewsText, findWhole };
