"use strict";

const OTHER_KEY = "other";
const PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const SEGMENT_RE = /^[a-zA-Z0-9_]+$/;
const LABEL_RE = /^[A-Za-z0-9_]{1,64}$/;

const COUNTER_FRAMES_TOTAL = "persistence.walPerTx.framesTotal";
const COUNTER_ROWS_TOTAL = "persistence.walPerTx.rowsTotal";
const COUNTER_TX_TOTAL = "persistence.walPerTx.txTotal";
const COUNTER_FRAMES_UNKNOWN = "persistence.walPerTx.framesUnknown";
const COUNTER_OVERFLOW = "persistence.walPerTx.overflow";
const FRAMES_PREFIX = "persistence.walFrames.";
const ROWS_PREFIX = "persistence.walRows.";
const TX_PREFIX = "persistence.walTx.";
const BY_NAME_PREFIX = "persistence.walFramesByName.";

function createWalAttribution(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const maxKeys = Number.isSafeInteger(o.maxKeys) && o.maxKeys > 0 ? o.maxKeys : 0;
  const detailModule = typeof o.detailModule === "string" && PREFIX_RE.test(o.detailModule) ? o.detailModule : null;
  const detailPrefix = detailModule === null ? null : `${detailModule}.`;
  const maxDetailNames = Number.isSafeInteger(o.maxDetailNames) && o.maxDetailNames > 0 ? o.maxDetailNames : 0;
  const keys = new Set();
  const details = new Set();

  function keyOf(name, label) {
    const text = String(name);
    const dot = text.indexOf(".");
    const prefix = dot < 0 ? text : text.slice(0, dot);
    if (!PREFIX_RE.test(prefix)) return OTHER_KEY;
    return typeof label === "string" && LABEL_RE.test(label) ? `${prefix}_${label}` : prefix;
  }

  function detailName(name) {
    if (detailPrefix === null || maxDetailNames === 0 || !name.startsWith(detailPrefix)) return null;
    if (details.has(name)) return name;
    if (details.size >= maxDetailNames) return null;
    const segments = name.split(".");
    if (segments.length < 2 || !segments.every((s, i) => (i === 0 ? PREFIX_RE.test(s) : SEGMENT_RE.test(s)))) return null;
    details.add(name);
    return name;
  }

  function note(name, rows, wal) {
    const text = String(name);
    const out = [];
    let key = keyOf(text, wal && typeof wal === "object" ? wal.label : null);
    if (key !== OTHER_KEY && !keys.has(key)) {
      if (keys.size < maxKeys) keys.add(key);
      else {
        key = OTHER_KEY;
        out.push([COUNTER_OVERFLOW, 1]);
      }
    }
    const frames = wal && typeof wal === "object" && typeof wal.frames === "number" && Number.isFinite(wal.frames)
      && wal.frames >= 0 ? wal.frames : null;
    const rowCount = typeof rows === "number" && Number.isFinite(rows) && rows >= 0 ? rows : 0;
    out.push([`${TX_PREFIX}${key}`, 1], [COUNTER_TX_TOTAL, 1]);
    out.push([`${ROWS_PREFIX}${key}`, rowCount], [COUNTER_ROWS_TOTAL, rowCount]);
    if (frames === null) out.push([COUNTER_FRAMES_UNKNOWN, 1]);
    else {
      out.push([`${FRAMES_PREFIX}${key}`, frames], [COUNTER_FRAMES_TOTAL, frames]);
      const detail = detailName(text);
      if (detail !== null) out.push([`${BY_NAME_PREFIX}${detail}`, frames]);
    }
    return out;
  }

  return { note, keyOf };
}

module.exports = { createWalAttribution, OTHER_KEY, COUNTER_FRAMES_TOTAL, COUNTER_ROWS_TOTAL, COUNTER_TX_TOTAL,
  COUNTER_FRAMES_UNKNOWN, COUNTER_OVERFLOW, FRAMES_PREFIX, ROWS_PREFIX, TX_PREFIX, BY_NAME_PREFIX };
