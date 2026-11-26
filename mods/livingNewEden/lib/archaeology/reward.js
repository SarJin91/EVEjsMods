"use strict";

const MAX_ENTRIES = 4;
const MAX_QUANTITY = 1000;
const MAX_RUNS = 100;
const ENTRY_RE = /^(\d{1,9}):(\d{1,4})(?::(\d{1,3}))?$/;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const inRange = (v, max) => Number.isSafeInteger(v) && v >= 1 && v <= max;
const bad = (detail) => ({ ok: false, reason: "BAD_REWARD", detail });

function isRewardEntry(e) {
  if (!e || typeof e !== "object" || !isId(e.typeId) || !inRange(e.quantity, MAX_QUANTITY)) return false;
  const keys = Object.keys(e);
  if (keys.some((k) => k !== "typeId" && k !== "quantity" && k !== "runs")) return false;
  return e.runs === undefined || inRange(e.runs, MAX_RUNS);
}

function isRewardList(v) {
  return Array.isArray(v) && v.length <= MAX_ENTRIES && v.every(isRewardEntry)
    && new Set(v.map((e) => e.typeId)).size === v.length;
}

function parseRewardCsv(text) {
  if (typeof text !== "string") return bad("not a string");
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, entries: [] };
  const parts = trimmed.split(",").map((s) => s.trim());
  if (parts.length > MAX_ENTRIES) return bad(`more than ${MAX_ENTRIES} entries`);
  const entries = [];
  const seen = new Set();
  for (const part of parts) {
    const m = ENTRY_RE.exec(part);
    if (!m) return bad(`format ${part.slice(0, 32)}`);
    const typeId = Number(m[1]);
    const quantity = Number(m[2]);
    const runs = m[3] === undefined ? undefined : Number(m[3]);
    if (!isId(typeId)) return bad(`typeId ${m[1]}`);
    if (!inRange(quantity, MAX_QUANTITY)) return bad(`quantity ${m[2]}`);
    if (runs !== undefined && !inRange(runs, MAX_RUNS)) return bad(`runs ${m[3]}`);
    if (seen.has(typeId)) return bad(`duplicate ${typeId}`);
    seen.add(typeId);
    entries.push(Object.freeze(runs === undefined ? { typeId, quantity } : { typeId, quantity, runs }));
  }
  return { ok: true, entries: Object.freeze(entries) };
}

function validateReward(entries, facts) {
  const known = facts instanceof Map ? facts : new Map();
  const list = Array.isArray(entries) ? entries : [];
  return { entries: list.filter((e) => known.has(e.typeId)), missing: list.filter((e) => !known.has(e.typeId))
    .map((e) => e.typeId) };
}

function rewardOfJson(text) {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    return isRewardList(v) ? Object.freeze(v.map((e) => Object.freeze({ ...e }))) : null;
  } catch (_err) {
    return null;
  }
}

module.exports = { MAX_ENTRIES, parseRewardCsv, validateReward, rewardOfJson, isRewardList };
