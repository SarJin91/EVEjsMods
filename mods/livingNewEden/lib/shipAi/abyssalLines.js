"use strict";

const { TRIGGER_PRIORITY, ABYSSAL_FAIL_TEXT } = require("./data/triggers");

const KIND = "ABYSSAL";
const OPEN_STATES = Object.freeze(["ACTIVE", "COMPLETED"]);
const EXITED = "EXITED";
const FAILED = "FAILED";
const ROOMS = 3;
const MS_PER_MINUTE = 60000;
const MS_PER_SECOND = 1000;
const WARN_MIN_MS = 10000;
const WARN_MAX_MS = 1200000;
const WARN_MAX_MARKS = 4;
const WARN_MARK_RE = /^\d{1,7}$/;

const isObj = (v) => Boolean(v) && typeof v === "object";
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const textOrNull = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function parseWarnList(text) {
  if (typeof text !== "string") return null;
  if (text.trim() === "") return [];
  const out = [];
  for (const part of text.split(",")) {
    const token = part.trim();
    if (!WARN_MARK_RE.test(token)) return null;
    const ms = Number(token);
    if (ms < WARN_MIN_MS || ms > WARN_MAX_MS) return null;
    if (!out.includes(ms)) out.push(ms);
  }
  if (out.length > WARN_MAX_MARKS) return null;
  return out.sort((a, b) => b - a);
}

const takesPart = (run, playerId) => run.ownerCharacterId === playerId
  || (Array.isArray(run.participants) && run.participants.some((p) => isObj(p) && p.characterId === playerId));

function candidatesOf(run, nowMs, warnAt, lang) {
  const base = `aby:${run.instanceId}:${Number.isSafeInteger(run.activatedAtMs) ? run.activatedAtMs : 0}`;
  const out = [];
  const open = OPEN_STATES.includes(run.state);
  const expires = Number.isSafeInteger(run.expiresAtMs) ? run.expiresAtMs : 0;
  const left = expires > 0 ? expires - nowMs : 0;
  if (open) {
    const values = {};
    if (Number.isSafeInteger(run.tier) && run.tier >= 0) values.tier = run.tier;
    const weather = textOrNull(run.weather);
    if (weather !== null) values.weather = weather;
    if (left > 0) values.minutes = Math.ceil(left / MS_PER_MINUTE);
    const full = values.tier !== undefined && values.weather !== undefined && values.minutes !== undefined;
    out.push({ key: `${base}:enter`, template: full ? "ABYSSAL_ENTER" : "ABYSSAL_ENTER_PLAIN", values: full ? values
      : {} });
  }
  const pockets = Number.isSafeInteger(run.pocketsCompleted) ? run.pocketsCompleted : 0;
  for (let n = 1; n < ROOMS; n += 1) {
    if (pockets >= n) out.push({ key: `${base}:room:${n}`, template: "ABYSSAL_ROOM", values: { room: n, rooms: ROOMS } });
  }
  if (open && left > 0) {
    const crossed = warnAt.filter((th) => left <= th);
    if (crossed.length > 0) {
      const smallest = Math.min(...crossed);
      for (const th of crossed) {
        if (th !== smallest) out.push({ key: `${base}:warn:${th}`, silent: true });
      }
      out.push(left >= MS_PER_MINUTE
        ? { key: `${base}:warn:${smallest}`, template: "ABYSSAL_WARN", values: { minutes: Math.ceil(left / MS_PER_MINUTE) } }
        : { key: `${base}:warn:${smallest}`, template: "ABYSSAL_WARN_SECONDS",
          values: { seconds: Math.max(1, Math.ceil(left / MS_PER_SECOND)) } });
    }
  }
  if (run.state === EXITED) out.push({ key: `${base}:exited`, template: "ABYSSAL_EXITED", values: {} });
  if (run.state === FAILED) {
    const table = ABYSSAL_FAIL_TEXT[lang] || ABYSSAL_FAIL_TEXT.en;
    const code = textOrNull(run.vendorOutcome);
    const reason = code !== null && Object.prototype.hasOwnProperty.call(table, code) ? table[code] : null;
    out.push(reason !== null ? { key: `${base}:failed`, template: "ABYSSAL_FAILED", values: { reason } }
      : { key: `${base}:failed`, template: "ABYSSAL_FAILED_PLAIN", values: {} });
  }
  return out;
}

function planAbyssal(state, reading, playerId, nowMs, S) {
  const prev = isObj(state) && state.seen instanceof Map ? state.seen : null;
  const first = prev === null;
  const seen = new Map(prev || []);
  const entries = [];
  const settings = isObj(S) ? S : {};
  const warnAt = Array.isArray(settings.abyssalWarnAtMs) ? settings.abyssalWarnAtMs
    : parseWarnList(settings.abyssalWarnAtMs) || [];
  const lang = settings.language === "pl" ? "pl" : "en";
  const runs = isObj(reading) && Array.isArray(reading.runs) ? reading.runs : [];
  for (const run of runs) {
    if (!isObj(run) || !isPosInt(run.instanceId) || !takesPart(run, playerId)) continue;
    for (const c of candidatesOf(run, nowMs, warnAt, lang)) {
      if (seen.has(c.key)) {
        seen.delete(c.key);
        seen.set(c.key, nowMs);
        continue;
      }
      seen.set(c.key, nowMs);
      if (first || c.silent === true) continue;
      entries.push(Object.freeze({ kind: KIND, priority: TRIGGER_PRIORITY[KIND], key: c.key, model: false,
        values: Object.freeze({ ...c.values }), template: c.template, at: nowMs }));
    }
  }
  const max = Number.isSafeInteger(settings.abyssalSeenMax) && settings.abyssalSeenMax > 0 ? settings.abyssalSeenMax : 1;
  for (const [key, at] of seen) {
    if (seen.size <= max || at >= nowMs) break;
    seen.delete(key);
  }
  return { state: { seen }, entries };
}

module.exports = { planAbyssal, parseWarnList, ABYSSAL_KIND: KIND, WARN_MIN_MS, WARN_MAX_MS, WARN_MAX_MARKS };
