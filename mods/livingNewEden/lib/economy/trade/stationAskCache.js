"use strict";

const MAX_TYPES_PER_STATION = 64;
const MAX_ERROR = 120;

const keyOf = (stationId) => Number(stationId);
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function createStationAskCache(o) {
  const ttlMs = Number.isSafeInteger(o && o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : 0;
  const maxStations = Number.isSafeInteger(o && o.maxStations) && o.maxStations > 0 ? o.maxStations : 1;
  const maxPending = Number.isSafeInteger(o && o.maxPending) && o.maxPending > 0 ? o.maxPending : maxStations;
  const entries = new Map();
  const pending = new Map();
  let reads = 0;
  let failed = 0;
  let lastError = null;

  function peek(stationId, at) {
    const e = entries.get(keyOf(stationId));
    if (!e || !(at - e.at < ttlMs)) return null;
    return e.asks;
  }

  function note(stationId, asks, at) {
    const k = keyOf(stationId);
    if (!isId(k) || !(asks instanceof Map)) return;
    const prev = entries.get(k);
    const fresh = Boolean(prev) && at - prev.at < ttlMs;
    const merged = new Map(fresh ? prev.asks : []);
    for (const [t, v] of asks) merged.set(t, v);
    entries.delete(k);
    entries.set(k, { at: fresh ? Math.min(prev.at, at) : at, asks: merged });
    while (entries.size > maxStations) entries.delete(entries.keys().next().value);
    reads += 1;
  }

  function want(stationId, typeIds) {
    const k = keyOf(stationId);
    if (!isId(k) || !Array.isArray(typeIds)) return;
    let set = pending.get(k);
    if (!set) {
      if (pending.size >= maxPending) return;
      set = new Set();
      pending.set(k, set);
    }
    for (const t of typeIds) {
      if (set.size >= MAX_TYPES_PER_STATION) break;
      if (isId(t)) set.add(t);
    }
    if (set.size === 0) pending.delete(k);
  }

  function take(n) {
    const out = [];
    const limit = Number.isSafeInteger(n) && n > 0 ? n : 0;
    for (const [stationId, set] of pending) {
      if (out.length >= limit) break;
      out.push({ stationId, typeIds: [...set].sort((a, b) => a - b) });
    }
    for (const j of out) pending.delete(j.stationId);
    return out;
  }

  function fail(reason) {
    failed += 1;
    lastError = String(reason || "FAILED").slice(0, MAX_ERROR);
  }

  function getStatus() {
    return { entries: entries.size, pending: pending.size, reads, failed, lastError };
  }

  return Object.freeze({ peek, note, want, take, fail, getStatus });
}

function createStationAskDrain(deps) {
  const { T, cache, readStationAsks, clock, count } = deps;
  return async function stationAskDrain() {
    if (!(T.warPricingEnabled === true && T.warStationAskGuardEnabled === true)) return;
    if (typeof readStationAsks !== "function") return;
    const jobs = cache.take(T.maxStationAskReadsPerPass);
    for (let i = 0; i < jobs.length; i += 1) {
      let r;
      try {
        r = await readStationAsks({ stationId: jobs[i].stationId, typeIds: jobs[i].typeIds });
      } catch (err) {
        r = { ok: false, reason: "TRANSPORT", detail: String((err && err.message) || err) };
      }
      if (r && r.ok === true) {
        cache.note(jobs[i].stationId, r.asks, clock.now());
        count("stationAskReads", 1);
        continue;
      }
      cache.fail(r && r.reason);
      count("stationAskFailed", 1);
      if (r && r.reason === "REJECTED") continue;
      for (const j of jobs.slice(i)) cache.want(j.stationId, j.typeIds);
      break;
    }
  };
}

module.exports = { createStationAskCache, createStationAskDrain, MAX_TYPES_PER_STATION };
