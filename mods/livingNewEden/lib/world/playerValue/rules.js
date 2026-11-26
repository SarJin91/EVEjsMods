"use strict";

const METENOX_TYPE_ID = 81826;
const ANSIBLEX_TYPE_ID = 35841;

const VALUE_KINDS = Object.freeze(["citadelM", "citadelL", "citadelXL", "engineeringM", "engineeringL",
  "engineeringXL", "refineryM", "refineryL", "metenox", "ansiblex", "trigBridge", "flexOther", "skyhook", "sentry",
  "listeningPost", "heavySentry"]);

const SKIPPED_STATES = Object.freeze(["ANCHORING", "UNANCHORED"]);

const SIZE_SUFFIX = Object.freeze({ STRUCTURE_SIZE_MEDIUM: "M", STRUCTURE_SIZE_LARGE: "L",
  STRUCTURE_SIZE_EXTRA_LARGE: "XL" });

const SIZED_FAMILIES = Object.freeze(["citadel", "engineering", "refinery"]);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function kindOfStructure(s) {
  if (!s || typeof s !== "object") return null;
  if (SKIPPED_STATES.includes(String(s.state || "").toUpperCase())) return null;
  if (s.typeId === METENOX_TYPE_ID) return "metenox";
  if (s.family === "flex") {
    if (s.typeId === ANSIBLEX_TYPE_ID) return s.trig === true ? "trigBridge" : "ansiblex";
    return "flexOther";
  }
  if (!SIZED_FAMILIES.includes(s.family) || !hasOwn(SIZE_SUFFIX, s.size)) return null;
  const kind = `${s.family}${SIZE_SUFFIX[s.size]}`;
  return VALUE_KINDS.includes(kind) ? kind : null;
}

function systemValueOf(counts, weights, caps) {
  const maxCount = caps && Number.isSafeInteger(caps.maxCountPerKind) && caps.maxCountPerKind > 0
    ? caps.maxCountPerKind : 0;
  const cap = caps && Number.isSafeInteger(caps.valueCap) && caps.valueCap >= 0 ? caps.valueCap : 0;
  let raw = 0;
  for (const kind of Object.keys(counts || {}).sort()) {
    const n = counts[kind];
    const w = weights && hasOwn(weights, kind) ? weights[kind] : 0;
    if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(w) || w <= 0) continue;
    raw += w * Math.min(n, maxCount);
  }
  return raw > cap ? { value: cap, capped: true } : { value: raw, capped: false };
}

module.exports = { METENOX_TYPE_ID, ANSIBLEX_TYPE_ID, VALUE_KINDS, SKIPPED_STATES, kindOfStructure, systemValueOf };
