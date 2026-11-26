"use strict";

const NO_NAME = "a pilot";
const KINDS = new Set(["player", "npc"]);
const TAG_RE = /<[^>]*>/g;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g; // eslint-disable-line no-control-regex
const ch = (code) => String.fromCharCode(code);
const INVISIBLE_RE = new RegExp(`[${ch(0xad)}${ch(0x200b)}-${ch(0x200f)}${ch(0x202a)}-${ch(0x202e)}`
  + `${ch(0x2060)}-${ch(0x2064)}${ch(0x2066)}-${ch(0x2069)}${ch(0xfeff)}]`, "g");
const SPACE_RE = /\s+/g;

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sanitizeLine(text, lineChars) {
  if (typeof text !== "string") return null;
  const clean = text.replace(TAG_RE, "").replace(CONTROL_RE, " ").replace(INVISIBLE_RE, "")
    .replace(SPACE_RE, " ").trim();
  if (clean === "" || clean.startsWith("!") || clean.startsWith("/")) return null;
  const signs = [...clean];
  return signs.length > lineChars ? signs.slice(0, lineChars).join("").trim() : clean;
}

function createTranscript(opts) {
  const o = opts || {};
  const maxLines = Math.max(1, Math.floor(Number(o.maxLinesPerSystem) || 0));
  const maxSystems = Math.max(1, Math.floor(Number(o.maxSystems) || 0));
  const maxAgeMs = Math.max(0, Math.floor(Number(o.maxAgeMs) || 0));
  const lineChars = Math.max(1, Math.floor(Number(o.lineChars) || 0));
  const sharePlayerText = o.sharePlayerText !== false;
  const nameOf = typeof o.nameOf === "function" ? o.nameOf : () => null;
  const isSystem = typeof o.isSystem === "function" ? o.isSystem : null;
  const maxNames = maxSystems * maxLines;
  const rings = new Map();
  let snapshot = new Set();
  const names = new Map();

  function inSnapshot(systemId) {
    if (isSystem !== null) {
      try {
        return isSystem(systemId) === true;
      } catch (_err) {
        return false;
      }
    }
    return snapshot.has(systemId);
  }

  function nameFor(characterId) {
    const hit = names.get(characterId);
    if (hit !== undefined) return hit;
    let name = null;
    try {
      name = nameOf(characterId);
    } catch (_err) {
      name = null;
    }
    if (typeof name !== "string" || name.trim() === "") return NO_NAME;
    const clean = name.trim();
    if (names.size >= maxNames) names.delete(names.keys().next().value);
    names.set(characterId, clean);
    return clean;
  }

  function prune(ring, nowMs) {
    const cutoff = nowMs - maxAgeMs;
    let i = 0;
    while (i < ring.length && ring[i].atMs <= cutoff) i += 1;
    if (i > 0) ring.splice(0, i);
  }

  function setSystems(ids) {
    const next = new Set();
    if (ids && typeof ids[Symbol.iterator] === "function") {
      for (const id of ids) if (isPositiveInt(id)) next.add(id);
    }
    snapshot = next;
  }

  function note(line) {
    if (!line || typeof line !== "object" || !KINDS.has(line.kind)) return false;
    const { systemId, characterId, atMs } = line;
    if (!isPositiveInt(systemId) || !isPositiveInt(characterId) || !Number.isFinite(atMs)) return false;
    if (line.kind === "player" && !sharePlayerText) return false;
    if (!inSnapshot(systemId)) return false;
    const text = sanitizeLine(line.text, lineChars);
    if (text === null) return false;
    let ring = rings.get(systemId);
    if (ring) {
      rings.delete(systemId);
    } else {
      ring = [];
    }
    rings.set(systemId, ring);
    ring.push({ kind: line.kind, characterId, text, atMs });
    prune(ring, atMs);
    if (ring.length > maxLines) ring.splice(0, ring.length - maxLines);
    while (rings.size > maxSystems) rings.delete(rings.keys().next().value);
    return true;
  }

  function view(entry) {
    return Object.freeze({ kind: entry.kind, characterId: entry.characterId, name: nameFor(entry.characterId),
      text: entry.text, atMs: entry.atMs });
  }

  function recent(systemId, n, nowMs) {
    const ring = rings.get(systemId);
    if (!ring || !Number.isSafeInteger(n) || n <= 0 || !Number.isFinite(nowMs)) return Object.freeze([]);
    const cutoff = nowMs - maxAgeMs;
    const young = ring.filter((e) => e.atMs > cutoff);
    return Object.freeze(young.slice(Math.max(0, young.length - n)).map(view));
  }

  function lastPlayerLine(systemId, nowMs) {
    const ring = rings.get(systemId);
    if (!ring || !Number.isFinite(nowMs)) return null;
    const cutoff = nowMs - maxAgeMs;
    for (let i = ring.length - 1; i >= 0; i -= 1) {
      const e = ring[i];
      if (e.atMs <= cutoff) break;
      if (e.kind === "player") return view(e);
    }
    return null;
  }

  function size() {
    let lines = 0;
    for (const ring of rings.values()) lines += ring.length;
    return lines;
  }

  return Object.freeze({
    setSystems,
    note,
    recent,
    lastPlayerLine,
    drop: (systemId) => {
      rings.delete(systemId);
    },
    clear: () => {
      rings.clear();
      names.clear();
      snapshot = new Set();
    },
    size,
    systems: () => rings.size,
  });
}

module.exports = { createTranscript, sanitizeLine, NO_NAME };
