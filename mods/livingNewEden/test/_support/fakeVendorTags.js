"use strict";

function createFakeVendorTags(opts = {}) {
  const escrows = new Map();
  const wrecks = new Map();
  let clock = Number.isSafeInteger(opts.at) ? opts.at : 1;
  const put = (map, key, tag, same) => {
    const existing = map.get(key);
    if (existing) return same(existing) ? { ok: true, outcome: "PRESENT", tag: existing }
      : { ok: false, reason: "TAG_CONFLICT", tag: existing };
    map.set(key, tag);
    return { ok: true, outcome: "WRITTEN", tag };
  };
  const del = (map, ids) => {
    let deleted = 0;
    for (const id of Array.isArray(ids) ? ids : []) if (map.delete(id)) deleted += 1;
    return { ok: true, deleted };
  };
  return {
    escrows,
    wrecks,
    setNow: (t) => { clock = t; },
    legacyRead: opts.legacyRead !== false,
    pruneMax: Number.isSafeInteger(opts.pruneMax) ? opts.pruneMax : 200,
    pruneGraceMs: Number.isSafeInteger(opts.pruneGraceMs) ? opts.pruneGraceMs : 60000,
    now: () => clock,
    getEscrowTag: (orderId) => ({ ok: true, tag: escrows.get(orderId) || null }),
    listEscrowTags: () => ({ ok: true, tags: [...escrows.values()] }),
    putEscrowTag: ({ orderId, offerId, at }) => put(escrows, orderId, { orderId, offerId, createdAt: at },
      (e) => e.offerId === offerId),
    deleteEscrowTags: (ids) => del(escrows, ids),
    getWreckTag: (wreckId) => ({ ok: true, tag: wrecks.get(wreckId) || null }),
    listWreckTags: () => ({ ok: true, tags: [...wrecks.values()] }),
    putWreckTag: ({ wreckId, anomalyId, slot, at }) => put(wrecks, wreckId, { wreckId, anomalyId, slot, createdAt: at },
      (w) => w.anomalyId === anomalyId && w.slot === slot),
    deleteWreckTags: (ids) => del(wrecks, ids),
  };
}

module.exports = { createFakeVendorTags };
