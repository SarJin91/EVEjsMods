"use strict";

const NO_PRICE = Object.freeze({ ok: false, reason: "NO_PRICE" });
const INVALID_PRICE = Object.freeze({ ok: false, reason: "INVALID_PRICE" });

function validRefs(refs) {
  if (!refs || typeof refs !== "object") return false;
  const { bidMilli, askMilli, baseMilli } = refs;
  if (bidMilli !== null && (!Number.isSafeInteger(bidMilli) || bidMilli < 0)) return false;
  if (askMilli !== null && (!Number.isSafeInteger(askMilli) || askMilli < 0)) return false;
  if (baseMilli !== null && (!Number.isSafeInteger(baseMilli) || baseMilli < 0)) return false;
  return true;
}

function createPriceCache(opts) {
  const ttlMs = Number.isSafeInteger(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 3600000;
  const cache = new Map();
  let sourceFn = null;

  function put(typeId, refs, at) {
    if (!Number.isSafeInteger(typeId) || typeId <= 0) return INVALID_PRICE;
    if (!validRefs(refs)) return INVALID_PRICE;
    if (!Number.isSafeInteger(at) || at < 0) return INVALID_PRICE;
    cache.set(typeId, { refs: Object.freeze({ ...refs }), storedAt: at });
    return { ok: true };
  }

  function peek(typeId, at) {
    if (!Number.isSafeInteger(typeId) || typeId <= 0) return null;
    if (!Number.isSafeInteger(at) || at < 0) return null;
    const entry = cache.get(typeId);
    if (!entry) return null;
    if (at - entry.storedAt > ttlMs) return null;
    return entry.refs;
  }

  function setSource(fn) {
    if (typeof fn === "function") sourceFn = fn;
  }

  function getStatus() {
    let newestAt = null;
    for (const entry of cache.values()) {
      if (newestAt === null || entry.storedAt > newestAt) newestAt = entry.storedAt;
    }
    return Object.freeze({
      entries: cache.size,
      source: sourceFn ? "set" : "none",
      newestAt,
    });
  }

  return Object.freeze({ put, peek, setSource, getStatus });
}

module.exports = { createPriceCache, NO_PRICE, INVALID_PRICE };