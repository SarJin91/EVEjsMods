"use strict";

const ENTITIES = Object.freeze({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'",
  "&nbsp;": " " });
const LINK_RE = /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi;
const TAG_RE = /<\/?[A-Za-z][^>]*>/g;
const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos|nbsp);/g;
const URL_RE = /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi;
const NOISE_RE = /[\p{Cc}\p{Cf}\p{Extended_Pictographic}\u{FE00}-\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu;
const SPEAKABLE_RE = /[\p{L}\p{N}]/u;
const SENTENCE_END_RE = /[.!?\u2026]+(?=\s|$)/g;
const LANG_TAGS = Object.freeze({ pl: "pl-PL", en: "en-US" });
const DEFAULT_LANG_TAG = "en-US";
const MIN_SENTENCE_CUT_DIVISOR = 2;

function cutAt(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  let best = -1;
  for (const m of head.matchAll(SENTENCE_END_RE)) {
    const end = m.index + m[0].length;
    if (end <= max) best = end;
  }
  if (best >= Math.floor(max / MIN_SENTENCE_CUT_DIVISOR)) return text.slice(0, best).trim();
  const space = head.lastIndexOf(" ");
  return (space > 0 ? text.slice(0, space) : text.slice(0, max)).trim();
}

function toSpeechText(line, opts) {
  const max = opts && Number.isSafeInteger(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 0;
  if (max === 0 || typeof line !== "string") return null;
  const text = line.replace(LINK_RE, " ").replace(TAG_RE, " ").replace(ENTITY_RE, (e) => ENTITIES[e])
    .replace(URL_RE, " ").replace(NOISE_RE, " ").replace(/\s+/g, " ").replace(/ ([.,!?;:\u2026])/g, "$1").trim();
  if (!SPEAKABLE_RE.test(text)) return null;
  const cut = cutAt(text, max);
  return SPEAKABLE_RE.test(cut) ? cut : null;
}

function splitSentences(text, maxPartChars) {
  const max = Number.isSafeInteger(maxPartChars) && maxPartChars > 0 ? maxPartChars : 1;
  const src = String(text ?? "").trim();
  if (src === "") return [];
  const sentences = [];
  let from = 0;
  for (const m of src.matchAll(SENTENCE_END_RE)) {
    const end = m.index + m[0].length;
    sentences.push(src.slice(from, end).trim());
    from = end;
  }
  sentences.push(src.slice(from).trim());
  const parts = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > max) {
      const head = cutAt(rest, max);
      parts.push(head);
      rest = rest.slice(head.length).trim();
    }
    if (SPEAKABLE_RE.test(rest)) parts.push(rest);
  }
  return parts.filter((p) => SPEAKABLE_RE.test(p));
}

function langTagOf(language) {
  return LANG_TAGS[language] || DEFAULT_LANG_TAG;
}

module.exports = { toSpeechText, splitSentences, langTagOf };
