"use strict";

const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 37;
const MAX_SPACE_COUNT = 2;
const CHARSET_RE = /^[\p{L}\p{N}' -]+$/u;
const DIGIT_RE = /\p{N}/u;
const RESERVED_PREFIXES = Object.freeze(["ccp ", "gm ", "isd "]);
const RESERVED_KEYS = Object.freeze(["elysian", "john elysian", "gm elysian"]);

function nameKey(name) {
  return String(name === null || name === undefined ? "" : name).normalize("NFKC").trim().replace(/\s+/g, " ")
    .toLowerCase();
}

function isValidCharacterName(name) {
  if (typeof name !== "string") return { ok: false, reason: "CHARSET" };
  const trimmed = name.normalize("NFKC").trim();
  if (trimmed.length < MIN_NAME_LENGTH) return { ok: false, reason: "TOO_SHORT" };
  if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, reason: "TOO_LONG" };
  if (/\s{2,}/.test(trimmed) || (trimmed.match(/ /g) || []).length > MAX_SPACE_COUNT) {
    return { ok: false, reason: "SPACES" };
  }
  if (!CHARSET_RE.test(trimmed)) return { ok: false, reason: "CHARSET" };
  if (DIGIT_RE.test(trimmed)) return { ok: false, reason: "DIGIT" };
  const key = nameKey(trimmed);
  if (RESERVED_KEYS.includes(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p))) {
    return { ok: false, reason: "RESERVED" };
  }
  return { ok: true };
}

module.exports = { nameKey, isValidCharacterName, MIN_NAME_LENGTH, MAX_NAME_LENGTH, MAX_SPACE_COUNT };
