"use strict";

const { ESCROW_OFFER, WRECK_ANOMALY, WRECK_SLOT } = require("./vendorTagFields");
const { orderIdKey } = require("./tradeMarket");
const { REQUIRED_FUNCTIONS } = require("./nativeWrecks");

const TAG_STORE_METHODS = Object.freeze(["getEscrowTag", "listEscrowTags", "putEscrowTag", "deleteEscrowTags",
  "getWreckTag", "listWreckTags", "putWreckTag", "deleteWreckTags"]);
const WRECK_OVERRIDES = new Set(["getNativeWreck", "listNativeWrecks", "upsertNativeWreck", "removeNativeWreckCascade"]);

function isTagStore(tags) {
  return Boolean(tags) && typeof tags === "object" && TAG_STORE_METHODS.every((m) => typeof tags[m] === "function");
}

function unavailable() {
  return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "vendorTags" };
}

function tagRead(res, what) {
  if (!res || res.ok !== true) throw new Error(`vendor tag ${what} failed: ${(res && res.reason) || "no_result"}`);
  return res;
}

function quietly(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function hookOf(hooks, name) {
  const fn = hooks && hooks[name];
  return typeof fn === "function" ? (...args) => quietly(() => fn(...args)) : () => {};
}

function wreckIdOf(value) {
  const n = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function hasText(value) {
  return typeof value === "string" && value !== "";
}

function staleIds(tags, seen, idOf, store) {
  if (!(store.pruneMax > 0)) return [];
  const cutoff = store.now() - store.pruneGraceMs;
  const out = [];
  for (const tag of tags) {
    if (out.length >= store.pruneMax) break;
    const id = idOf(tag);
    if (!seen.has(id) && tag.createdAt < cutoff) out.push(id);
  }
  return out;
}

function createTaggedEscrowState(escrowState, tags, hooks) {
  if (!isTagStore(tags)) return unavailable();
  const onLegacy = hookOf(hooks, "onLegacy");
  const onPrune = hookOf(hooks, "onPrune");

  const decorate = (rec, tag) => {
    const out = { ...rec };
    if (tag) out[ESCROW_OFFER] = tag.offerId;
    else if (!tags.legacyRead) delete out[ESCROW_OFFER];
    else if (hasText(out[ESCROW_OFFER])) onLegacy();
    return out;
  };

  const view = Object.create(null);
  if (escrowState && escrowState.TABLE !== undefined) view.TABLE = escrowState.TABLE;

  view.getEscrowRecord = (orderId) => {
    const rec = escrowState.getEscrowRecord(orderId);
    if (!rec || typeof rec !== "object") return null;
    const key = orderIdKey(rec.orderId !== undefined ? rec.orderId : orderId);
    const tag = key === null ? null : tagRead(tags.getEscrowTag(key), "read").tag;
    return decorate(rec, tag);
  };

  view.listEscrowRecords = () => {
    const list = escrowState.listEscrowRecords() || [];
    const all = tagRead(tags.listEscrowTags(), "list").tags || [];
    const byId = new Map(all.map((t) => [t.orderId, t]));
    const seen = new Set();
    const out = [];
    for (const rec of list) {
      if (!rec || typeof rec !== "object") continue;
      const key = orderIdKey(rec.orderId);
      if (key !== null) seen.add(key);
      out.push(decorate(rec, key === null ? null : byId.get(key) || null));
    }
    quietly(() => {
      const stale = staleIds(all, seen, (t) => t.orderId, tags);
      const res = stale.length > 0 ? tags.deleteEscrowTags(stale) : null;
      if (res && res.ok === true && res.deleted > 0) onPrune(res.deleted, 0);
    });
    return out;
  };

  view.putEscrowRecordDurable = (record) => {
    const offer = record && record[ESCROW_OFFER];
    const clean = { ...(record || {}) };
    delete clean[ESCROW_OFFER];
    const key = orderIdKey(clean.orderId);
    let written = false;
    if (hasText(offer) && key !== null) {
      const res = tags.putEscrowTag({ orderId: key, offerId: offer, at: tags.now() });
      if (!res || res.ok !== true) {
        return { success: false, errorMsg: `VENDOR_TAG_${(res && res.reason) || "FAILED"}` };
      }
      written = res.outcome === "WRITTEN";
    }
    const result = escrowState.putEscrowRecordDurable(clean);
    if ((!result || result.success !== true) && written) quietly(() => tags.deleteEscrowTags([key]));
    return result;
  };

  view.removeEscrowRecordDurable = (orderId) => {
    const result = escrowState.removeEscrowRecordDurable(orderId);
    const key = orderIdKey(orderId);
    if (result && result.success === true && key !== null) quietly(() => tags.deleteEscrowTags([key]));
    return result;
  };

  return { ok: true, view };
}

function createTaggedWreckStore(store, tags, hooks) {
  if (!isTagStore(tags)) return unavailable();
  const onLegacy = hookOf(hooks, "onLegacy");
  const onPrune = hookOf(hooks, "onPrune");

  const decorate = (rec, tag) => {
    const out = { ...rec };
    if (tag) {
      out[WRECK_ANOMALY] = tag.anomalyId;
      out[WRECK_SLOT] = tag.slot;
    } else if (!tags.legacyRead) {
      delete out[WRECK_ANOMALY];
      delete out[WRECK_SLOT];
    } else if (hasText(out[WRECK_ANOMALY])) {
      onLegacy();
    }
    return out;
  };
  const forget = (wreckId) => {
    const id = wreckIdOf(wreckId);
    if (id <= 0) return { ok: true, deleted: 0 };
    try {
      return tags.deleteWreckTags([id]);
    } catch (_err) {
      return { ok: false, reason: "TX_FAILED" };
    }
  };

  const view = Object.create(null);
  if (store && store.TABLE !== undefined) view.TABLE = store.TABLE;
  for (const name of REQUIRED_FUNCTIONS.store) {
    if (WRECK_OVERRIDES.has(name) || !store || typeof store[name] !== "function") continue;
    view[name] = (...args) => store[name](...args);
  }

  if (store && typeof store.getNativeWreck === "function") {
    view.getNativeWreck = (wreckId) => {
      const rec = store.getNativeWreck(wreckId);
      if (!rec || typeof rec !== "object") return null;
      const id = wreckIdOf(rec.wreckID !== undefined ? rec.wreckID : wreckId);
      const tag = id > 0 ? tagRead(tags.getWreckTag(id), "read").tag : null;
      return decorate(rec, tag);
    };
  }

  view.listNativeWrecks = () => {
    const list = store.listNativeWrecks() || [];
    const all = tagRead(tags.listWreckTags(), "list").tags || [];
    const byId = new Map(all.map((t) => [t.wreckId, t]));
    const seen = new Set();
    const out = [];
    for (const rec of list) {
      if (!rec || typeof rec !== "object") continue;
      const id = wreckIdOf(rec.wreckID);
      if (id > 0) seen.add(id);
      out.push(decorate(rec, id > 0 ? byId.get(id) || null : null));
    }
    quietly(() => {
      const stale = staleIds(all, seen, (t) => t.wreckId, tags);
      const res = stale.length > 0 ? tags.deleteWreckTags(stale) : null;
      if (res && res.ok === true && res.deleted > 0) onPrune(0, res.deleted);
    });
    return out;
  };

  view.upsertNativeWreck = (record, options) => {
    const anomaly = record && record[WRECK_ANOMALY];
    const slot = record && record[WRECK_SLOT];
    const clean = { ...(record || {}) };
    delete clean[WRECK_ANOMALY];
    delete clean[WRECK_SLOT];
    const id = wreckIdOf(clean.wreckID);
    let written = false;
    if (hasText(anomaly) && id > 0) {
      const res = tags.putWreckTag({ wreckId: id, anomalyId: anomaly, slot: Number.isSafeInteger(slot) ? slot : -1,
        at: tags.now() });
      if (!res || res.ok !== true) {
        return { success: false, errorMsg: `VENDOR_TAG_${(res && res.reason) || "FAILED"}` };
      }
      written = res.outcome === "WRITTEN";
    }
    const result = store.upsertNativeWreck(clean, options);
    if ((!result || result.success !== true) && written) forget(id);
    return result;
  };

  view.removeNativeWreckCascade = (wreckId) => {
    const result = store.removeNativeWreckCascade(wreckId);
    if (result && (result.success === true || result.errorMsg === "WRECK_NOT_FOUND")) forget(wreckId);
    return result;
  };

  view.forgetTag = forget;

  return { ok: true, view };
}

module.exports = { TAG_STORE_METHODS, isTagStore, createTaggedEscrowState, createTaggedWreckStore };
