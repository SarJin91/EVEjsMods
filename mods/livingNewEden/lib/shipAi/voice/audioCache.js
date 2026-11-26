"use strict";

const ID_BYTES = 16;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

function createAudioCache(deps) {
  const maxBytes = Number.isSafeInteger(deps.maxBytes) && deps.maxBytes > 0 ? deps.maxBytes : 0;
  const storeMaxBytes = Math.max(maxBytes, Number.isSafeInteger(deps.storeMaxBytes) ? deps.storeMaxBytes : 0);
  const nowMs = deps.nowMs;
  const randomBytes = deps.randomBytes;
  const entries = new Map();
  const ids = new Map();
  let total = 0;
  let evicted = 0;
  let unique = 0;

  const touch = (key, entry) => {
    entry.lastUsedMs = nowMs();
    entries.delete(key);
    entries.set(key, entry);
  };

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    ids.delete(entry.id);
    total -= entry.bytes.length;
  }

  function newId() {
    for (;;) {
      const id = Buffer.from(randomBytes(ID_BYTES)).toString("base64url");
      if (!ids.has(id)) return id;
    }
  }

  function get(key, owner) {
    if (maxBytes === 0) return null;
    const entry = entries.get(key);
    if (!entry) return null;
    if (Number.isSafeInteger(owner)) entry.owners.add(owner);
    touch(key, entry);
    return { id: entry.id, bytes: entry.bytes };
  }

  function put(key, bytes, owner) {
    const k = maxBytes === 0 ? `${key}#${(unique += 1)}` : key;
    const prev = entries.get(k);
    if (prev) {
      if (Number.isSafeInteger(owner)) prev.owners.add(owner);
      touch(k, prev);
      return { id: prev.id };
    }
    const buf = Buffer.from(bytes);
    for (const old of entries.keys()) {
      if (total + buf.length <= storeMaxBytes) break;
      remove(old);
      evicted += 1;
    }
    const entry = { id: newId(), bytes: buf, owners: new Set(Number.isSafeInteger(owner) ? [owner] : []),
      lastUsedMs: nowMs() };
    entries.set(k, entry);
    ids.set(entry.id, k);
    total += buf.length;
    return { id: entry.id };
  }

  function byId(id, owner) {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    const key = ids.get(id);
    const entry = key === undefined ? null : entries.get(key);
    if (!entry || !entry.owners.has(owner)) return null;
    touch(key, entry);
    return entry.bytes;
  }

  function stats() {
    return { entries: entries.size, bytes: total, evicted };
  }

  function clear() {
    entries.clear();
    ids.clear();
    total = 0;
  }

  return Object.freeze({ get, put, byId, stats, clear });
}

module.exports = { createAudioCache, ID_RE };
