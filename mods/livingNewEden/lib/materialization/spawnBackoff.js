"use strict";

const PERMANENT_REASONS = Object.freeze(["NPC_NATIVE_NO_FREE_SLOT", "NPC_NATIVE_MODULE_TYPE_NOT_FOUND",
  "NPC_NATIVE_CAPABILITY_TYPE_NOT_FOUND"]);

function failureReasonOf(reason, detail) {
  const r = typeof reason === "string" && reason !== "" ? reason : "SPAWN_FAILED";
  if (PERMANENT_REASONS.includes(r)) return r;
  if (typeof detail === "string" && detail !== "") {
    const hit = PERMANENT_REASONS.find((p) => detail.includes(p));
    if (hit) return hit;
  }
  return r;
}

const positive = (v) => Number.isSafeInteger(v) && v > 0;

function createSpawnBackoff(s) {
  const on = Boolean(s && typeof s === "object" && s.enabled === true && positive(s.baseMs) && positive(s.maxMs)
    && positive(s.permanentMs) && positive(s.maxEntries));
  const baseMs = on ? s.baseMs : 0;
  const maxMs = on ? s.maxMs : 0;
  const permanentMs = on ? s.permanentMs : 0;
  const maxEntries = on ? s.maxEntries : 0;
  const permanent = on && Array.isArray(s.permanentReasons) ? [...s.permanentReasons] : [...PERMANENT_REASONS];
  const entries = new Map();

  function waitOf(reason, failures, escalate) {
    if (permanent.includes(reason)) return permanentMs;
    if (escalate === false) return Math.min(baseMs, maxMs);
    let wait = baseMs;
    for (let i = 1; i < failures && wait < maxMs; i += 1) wait *= 2;
    return Math.min(wait, maxMs);
  }

  function evict(keep) {
    let victim = null;
    let at = Infinity;
    for (const [k, e] of entries) {
      if (k !== keep && e.retryAt < at) {
        at = e.retryAt;
        victim = k;
      }
    }
    if (victim !== null) entries.delete(victim);
  }

  function blocked(key, now) {
    if (!on) return null;
    const e = entries.get(String(key));
    if (!e || !(now < e.retryAt)) return null;
    return { retryAt: e.retryAt, reason: e.reason, failures: e.failures };
  }

  function note(key, reason, now, opts) {
    if (!on) return { retryAt: now, failures: 0, first: true };
    const k = String(key);
    const r = String(reason);
    const e = entries.get(k) || { retryAt: now, reason: r, failures: 0, logged: new Set() };
    e.failures += 1;
    e.reason = r;
    e.retryAt = now + waitOf(r, e.failures, opts && opts.escalate);
    const first = !e.logged.has(r);
    e.logged.add(r);
    entries.set(k, e);
    while (entries.size > maxEntries) evict(k);
    return { retryAt: e.retryAt, failures: e.failures, first };
  }

  function clear(key) {
    entries.delete(String(key));
  }

  return Object.freeze({ blocked, note, clear, size: () => entries.size, enabled: on });
}

module.exports = { createSpawnBackoff, failureReasonOf, PERMANENT_REASONS };
