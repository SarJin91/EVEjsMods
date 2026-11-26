"use strict";

const { stableHash32 } = require("../util/rng");
const { REJECT_REASONS, PROFANITY_LEVELS } = require("./schema");
const { BANNED } = require("./data/bannedWords");
const { LANGUAGES } = require("./data/languages");

const BULLET = String.fromCharCode(0x2022);
const LIST_PREFIX_RE = new RegExp(`^\\s*(\\d+[.)]|[-*${BULLET}])\\s*`);
const BASE_CHARSET = "A-Za-z0-9 .,!?'\":;()\\-/%+*{}\\[\\]";
const BASE_LANGUAGE = "en";
const DEFAULT_CAP = "mild";
const BANNED_CATEGORIES = Object.freeze({
  off: Object.freeze(["meta", "slurs", "strong", "mild"]),
  mild: Object.freeze(["meta", "slurs", "strong"]),
  full: Object.freeze(["meta", "slurs"]),
});
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;
const DOMAIN_RE = /\b[a-z0-9-]+\.(com|net|org|io|gg|ru|de|pl|co|uk|info|xyz|app|dev)\b/;
const DIGITS_RE = /\d{5,}/;
const QUOTES = Object.freeze(['"', "'"]);
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;
const THINK_OPEN_RE = /<think>/i;
const THINK_CLOSE_RE = /<\/think>/gi;

function normalizeLine(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function escapeClass(chars) {
  return String(chars).replace(/[\\\]\[^-]/g, "\\$&");
}

const CHARSET_BY_LANGUAGE = Object.freeze(Object.fromEntries(Object.entries(LANGUAGES).map(([code, p]) =>
  [code, new RegExp(`^[${BASE_CHARSET}${escapeClass(p.extraChars)}]+$`, "u")])));

function languageCodeOf(S) {
  const code = S && S.language;
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(LANGUAGES, code) ? code : BASE_LANGUAGE;
}

function charsetOf(code) {
  return Object.prototype.hasOwnProperty.call(CHARSET_BY_LANGUAGE, code) ? CHARSET_BY_LANGUAGE[code]
    : CHARSET_BY_LANGUAGE[BASE_LANGUAGE];
}

function foldTypography(line, code) {
  let out = String(line);
  for (const [from, to] of LANGUAGES[code].foldTypography) out = out.split(from).join(to);
  return out;
}

function levelIndex(level, fallback) {
  const i = PROFANITY_LEVELS.indexOf(level);
  return i >= 0 ? i : PROFANITY_LEVELS.indexOf(fallback);
}

function effectiveProfanity(globalLevel, bucketCap) {
  return PROFANITY_LEVELS[Math.min(levelIndex(globalLevel, DEFAULT_CAP), levelIndex(bucketCap, DEFAULT_CAP))];
}

function parseCompletion(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: "BAD_SHAPE" };
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { ok: false, reason: "BAD_SHAPE" };
  const first = choices[0];
  const message = first && typeof first === "object" ? first.message : null;
  if (!message || typeof message !== "object") return { ok: false, reason: "BAD_SHAPE" };
  const usage = json.usage && typeof json.usage === "object" ? json.usage : null;
  const total = usage ? usage.total_tokens : undefined;
  const totalTokens = Number.isSafeInteger(total) && total >= 0 ? total : null;
  const content = message.content;
  if (content === null || content === undefined) return { ok: false, reason: "EMPTY", totalTokens };
  if (typeof content !== "string") return { ok: false, reason: "BAD_SHAPE" };
  const text = stripReasoning(content);
  if (text.trim() === "") return { ok: false, reason: "EMPTY", totalTokens };
  const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : null;
  return { ok: true, text, finishReason, totalTokens };
}

function stripReasoning(content) {
  let text = content.replace(THINK_BLOCK_RE, "");
  const open = text.search(THINK_OPEN_RE);
  if (open >= 0) text = text.slice(0, open);
  const closes = [...text.matchAll(THINK_CLOSE_RE)];
  if (closes.length > 0) {
    const last = closes[closes.length - 1];
    text = text.slice(last.index + last[0].length);
  }
  return text;
}

function cleanLine(raw) {
  let line = String(raw).replace(LIST_PREFIX_RE, "").trim();
  if (line.length >= 2 && QUOTES.includes(line[0]) && line[line.length - 1] === line[0]) {
    line = line.slice(1, -1).trim();
  }
  return line;
}

function placeholdersOk(line, allowed) {
  let ok = true;
  const rest = line.replace(PLACEHOLDER_RE, (_m, name) => {
    if (!allowed.includes(name)) ok = false;
    return "";
  });
  return ok && !rest.includes("{") && !rest.includes("}");
}

function hasLink(line) {
  const lower = line.toLowerCase();
  return lower.includes("://") || lower.includes("www.") || DOMAIN_RE.test(lower);
}

function bannedPatterns(S, code, level) {
  const extra = S && Array.isArray(S.bannedWordList) ? S.bannedWordList : [];
  const categories = BANNED_CATEGORIES[level] || BANNED_CATEGORIES[DEFAULT_CAP];
  const langs = code === BASE_LANGUAGE ? [BASE_LANGUAGE] : [BASE_LANGUAGE, code];
  const entries = [];
  for (const lang of langs) {
    const lists = BANNED[lang];
    if (!lists) continue;
    for (const cat of categories) entries.push(...(lists[cat] || []));
  }
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
  for (const w of extra) {
    const n = normalizeLine(w);
    if (n !== "") words.add(` ${n} `);
  }
  return { words: [...words], prefixes: [...prefixes], infixes: [...infixes] };
}

function bannedHit(normalized, banned) {
  const padded = ` ${normalized} `;
  return banned.words.some((p) => padded.includes(p)) || banned.prefixes.some((p) => padded.includes(p))
    || banned.infixes.some((p) => normalized.includes(p));
}

function ruleMiss(line, normalized, bucket, S, banned, charset) {
  if (line.length < S.minTemplateChars || line.length > S.maxTemplateChars || normalized === "") return "LENGTH";
  return contentMiss(line, normalized, bucket.placeholders, banned, charset);
}

function contentMiss(line, normalized, placeholders, banned, charset) {
  if (!charset.test(line)) return "CHARSET";
  if (!placeholdersOk(line, placeholders)) return "PLACEHOLDER";
  if (hasLink(line)) return "LINK";
  if (DIGITS_RE.test(line)) return "DIGITS";
  if (line[0] === "!" || line[0] === "/") return "COMMAND";
  if (bannedHit(normalized, banned)) return "BANNED";
  return null;
}

function filterTemplates(text, bucket, S, known) {
  const rejected = {};
  for (const r of REJECT_REASONS) rejected[r] = 0;
  const accepted = [];
  if (typeof text !== "string" || !bucket || !S) return { accepted, rejected };
  const code = languageCodeOf(S);
  const charset = charsetOf(code);
  const banned = bannedPatterns(S, code, effectiveProfanity(S.profanity, bucket.profanityCap));
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    if (accepted.length >= S.linesPerRequest) break;
    const line = cleanLine(foldTypography(raw, code));
    if (line === "") continue;
    const normalized = normalizeLine(line);
    let reason = ruleMiss(line, normalized, bucket, S, banned, charset);
    if (reason === null && ((known && known.has(normalized)) || seen.has(normalized))) reason = "DUPLICATE";
    if (reason !== null) {
      rejected[reason] += 1;
      continue;
    }
    seen.add(normalized);
    accepted.push({ id: `ai-${bucket.key}-${stableHash32(normalized).toString(16)}`, text: line });
  }
  return { accepted, rejected };
}

const MIN_MASK_NAME_CHARS = 3;
const NAME_MASK = "Pilot";

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripQuotes(line) {
  const t = line.trim();
  return t.length >= 2 && QUOTES.includes(t[0]) && t[t.length - 1] === t[0] ? t.slice(1, -1).trim() : t;
}

function stripSpeaker(line, speakerName) {
  let out = line;
  if (typeof speakerName === "string" && speakerName.trim() !== "") {
    const name = speakerName.trim().toLowerCase();
    if (out.toLowerCase().startsWith(name) && out.slice(name.length).trimStart().startsWith(":")) {
      out = out.slice(name.length).trimStart().slice(1);
    }
  }
  return stripQuotes(out);
}

function maskNames(line, spec) {
  const list = Array.isArray(spec.names) ? spec.names.slice() : [];
  if (typeof spec.speakerName === "string") list.push(spec.speakerName);
  const names = [...new Set(list.filter((n) => typeof n === "string").map((n) => n.trim())
    .filter((n) => n.length >= MIN_MASK_NAME_CHARS))].sort((a, b) => b.length - a.length);
  let out = line;
  for (const n of names) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, "giu"), NAME_MASK);
  }
  return out;
}

function filterTalkLine(text, spec, S) {
  try {
    if (typeof text !== "string" || !spec || typeof spec !== "object" || !S) return { ok: false, reason: "EMPTY" };
    const code = languageCodeOf(S);
    let line = "";
    for (const raw of text.split(/\r?\n/)) {
      line = stripSpeaker(cleanLine(foldTypography(raw, code)), spec.speakerName);
      if (line !== "") break;
    }
    if (line === "") return { ok: false, reason: "EMPTY" };
    const normalized = normalizeLine(line);
    if (line.length < spec.minChars || line.length > spec.maxChars || normalized === "") {
      return { ok: false, reason: "LENGTH" };
    }
    const masked = maskNames(line, spec);
    const banned = bannedPatterns(S, code, effectiveProfanity(S.profanity, spec.profanityCap));
    const miss = contentMiss(masked, normalizeLine(masked), [], banned, charsetOf(code));
    if (miss !== null) return { ok: false, reason: miss };
    const recent = Array.isArray(spec.recent) ? spec.recent : [];
    if (recent.some((r) => typeof r === "string" && normalizeLine(r) === normalized)) {
      return { ok: false, reason: "DUPLICATE" };
    }
    return { ok: true, line };
  } catch (_err) {
    return { ok: false, reason: "EMPTY" };
  }
}

const NEWS_FOLD = Object.freeze(LANGUAGES.pl.foldTypography);

function newsLineMiss(line, normalized, banned, charset) {
  if (!charset.test(line)) return "CHARSET";
  if (hasLink(line)) return "LINK";
  if (line[0] === "!" || line[0] === "/") return "COMMAND";
  if (bannedHit(normalized, banned)) return "BANNED";
  return null;
}

function filterNewsText(text, spec, S) {
  try {
    if (typeof text !== "string" || !spec || typeof spec !== "object" || !S) return { ok: false, reason: "EMPTY" };
    const code = languageCodeOf(S);
    const charset = charsetOf(code);
    const banned = bannedPatterns(S, code, effectiveProfanity(S.profanity, DEFAULT_CAP));
    const out = [];
    let any = false;
    for (const raw of text.split(/\r?\n/)) {
      let line = foldTypography(raw, code);
      for (const [from, to] of NEWS_FOLD) line = line.split(from).join(to);
      line = cleanLine(line);
      out.push(line);
      if (line === "") continue;
      any = true;
      const miss = newsLineMiss(line, normalizeLine(line), banned, charset);
      if (miss !== null) return { ok: false, reason: miss };
    }
    if (!any) return { ok: false, reason: "EMPTY" };
    const joined = out.join("\n").trim();
    if (joined.length < spec.minChars || joined.length > spec.maxChars) return { ok: false, reason: "LENGTH" };
    return { ok: true, text: joined };
  } catch (_err) {
    return { ok: false, reason: "EMPTY" };
  }
}

function filterPlotText(text, spec) {
  try {
    if (typeof text !== "string" || !spec || typeof spec !== "object") return { ok: false, reason: "EMPTY" };
    const t = text.trim();
    if (t === "") return { ok: false, reason: "EMPTY" };
    if (t.length < spec.minChars || t.length > spec.maxChars) return { ok: false, reason: "LENGTH" };
    return { ok: true, text: t };
  } catch (_err) {
    return { ok: false, reason: "EMPTY" };
  }
}

function filterPlotField(text, opts, S) {
  try {
    if (typeof text !== "string" || !opts || typeof opts !== "object") return { ok: false, reason: "EMPTY" };
    const code = languageCodeOf(S);
    let line = foldTypography(text, code);
    for (const [from, to] of NEWS_FOLD) line = line.split(from).join(to);
    line = line.trim();
    const normalized = normalizeLine(line);
    if (line === "" || normalized === "") return { ok: false, reason: "EMPTY" };
    if (line.length > opts.maxChars) return { ok: false, reason: "LENGTH" };
    const banned = bannedPatterns(S, code, effectiveProfanity(S ? S.profanity : DEFAULT_CAP, DEFAULT_CAP));
    const miss = contentMiss(line, normalized, [], banned, charsetOf(code));
    return miss === null ? { ok: true, text: line } : { ok: false, reason: miss };
  } catch (_err) {
    return { ok: false, reason: "EMPTY" };
  }
}

module.exports = { parseCompletion, filterTemplates, normalizeLine, effectiveProfanity, charsetOf, bannedPatterns,
  bannedHit, hasLink, filterTalkLine, filterNewsText, filterPlotText, filterPlotField };
