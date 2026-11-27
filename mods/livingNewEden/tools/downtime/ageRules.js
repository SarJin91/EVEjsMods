"use strict";

const MIN_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1);
const FILETIME_UNIX_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000;
const FILETIME_MIN_NUMBER = 1e17;
const FILETIME_STRING = /^\d{17,18}$/;
const DAY_MS = 86400000;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_VENDOR_TABLES = Object.freeze(["scheduledJobs", "dynamicResourceRuntime", "sovereignty"]);
const LNE_TIME_COLUMN = /(^|_)(at|until)(_ms)?$/;
const MS_KEY_SUFFIX = "Ms";
const WILDCARD = "*";
const NUMERIC_KEY = /^\d+$/;

const inMsWindow = (v) => typeof v === "number" && Number.isFinite(v) && v >= MIN_EPOCH_MS && v < MAX_EPOCH_MS;

function filetimeTicksInWindow(ticks) {
  const ms = (ticks - FILETIME_UNIX_OFFSET) / BigInt(FILETIME_TICKS_PER_MS);
  return ms >= BigInt(MIN_EPOCH_MS) && ms < BigInt(MAX_EPOCH_MS);
}

function shiftOf(days) {
  if (!Number.isSafeInteger(days) || days < MIN_DAYS || days > MAX_DAYS) return { ok: false, reason: "DAYS_INVALID" };
  return { ok: true, shiftMs: days * DAY_MS };
}

function shiftLeaf(value, key, shiftMs) {
  if (typeof value === "string") {
    if (!FILETIME_STRING.test(value)) return null;
    const ticks = BigInt(value);
    if (!filetimeTicksInWindow(ticks)) return null;
    return { value: String(ticks - BigInt(shiftMs) * BigInt(FILETIME_TICKS_PER_MS)), kind: "filetime" };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= FILETIME_MIN_NUMBER) {
    const ms = value / FILETIME_TICKS_PER_MS - Number(FILETIME_UNIX_OFFSET / BigInt(FILETIME_TICKS_PER_MS));
    if (!inMsWindow(ms)) return null;
    return { value: value - shiftMs * FILETIME_TICKS_PER_MS, kind: "filetime" };
  }
  if (typeof key === "string" && key.endsWith(MS_KEY_SUFFIX) && inMsWindow(value)) {
    return { value: value - shiftMs, kind: "ms" };
  }
  return null;
}

function shiftJson(value, shiftMs, sink) {
  let changed = 0;
  const walk = (node, key, pathParts) => {
    if (Array.isArray(node)) {
      let out = null;
      node.forEach((item, i) => {
        const next = walk(item, key, [...pathParts, WILDCARD]);
        if (next !== item) {
          if (out === null) out = node.slice();
          out[i] = next;
        }
      });
      return out === null ? node : out;
    }
    if (node !== null && typeof node === "object") {
      let out = null;
      for (const k of Object.keys(node)) {
        const item = node[k];
        const next = walk(item, k, [...pathParts, NUMERIC_KEY.test(k) ? WILDCARD : k]);
        if (next !== item) {
          if (out === null) out = { ...node };
          out[k] = next;
        }
      }
      return out === null ? node : out;
    }
    const leaf = shiftLeaf(node, key, shiftMs);
    const where = pathParts.join(".");
    if (leaf) {
      changed += 1;
      sink.onShift(where, leaf.kind, node);
      return leaf.value;
    }
    if (inMsWindow(node) && !(typeof key === "string" && key.endsWith(MS_KEY_SUFFIX))) sink.onSuspect(where);
    return node;
  };
  const result = walk(value, null, []);
  return { value: result, changed };
}

function isLneTimeColumn(name, declaredType) {
  return typeof name === "string" && LNE_TIME_COLUMN.test(name) && /INT/i.test(String(declaredType || ""));
}

function hasStaleIdentity(jobID, originals) {
  if (typeof jobID !== "string" || !Array.isArray(originals)) return false;
  return originals.some((v) => (typeof v === "number" || typeof v === "string") && String(v).length > 0
    && jobID.includes(String(v)));
}

module.exports = {
  MIN_EPOCH_MS,
  MAX_EPOCH_MS,
  FILETIME_UNIX_OFFSET,
  FILETIME_TICKS_PER_MS,
  DAY_MS,
  MIN_DAYS,
  MAX_DAYS,
  DEFAULT_VENDOR_TABLES,
  LNE_TIME_COLUMN,
  inMsWindow,
  shiftOf,
  shiftJson,
  isLneTimeColumn,
  hasStaleIdentity,
};
