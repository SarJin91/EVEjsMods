"use strict";

const MOD_RECEIPT_PREFIX = "lne:";
const RECEIPTS_FIELD = "standingOperationReceipts";
const MAX_DETAIL = 120;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isCharacterId = (v) => Number.isSafeInteger(v) && v > 0;
const isModKey = (k) => typeof k === "string" && k.startsWith(MOD_RECEIPT_PREFIX)
  && k.length > MOD_RECEIPT_PREFIX.length;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function receiptsOf(record) {
  const r = record && typeof record === "object" ? record[RECEIPTS_FIELD] : null;
  return r && typeof r === "object" && !Array.isArray(r) ? r : null;
}

function listReceiptKeysFrom(characterState, characterId, prefix) {
  try {
    if (!isModKey(prefix)) return { ok: false, reason: "PREFIX_FOREIGN" };
    const peek = characterState && characterState.peekCharacterRecord;
    if (typeof peek !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
    if (!isCharacterId(characterId)) return { ok: true, found: false, keys: [] };
    const record = peek.call(characterState, characterId);
    if (!record || typeof record !== "object") return { ok: true, found: false, keys: [] };
    const receipts = receiptsOf(record);
    const keys = receipts ? Object.keys(receipts).filter((k) => k.startsWith(prefix)) : [];
    return { ok: true, found: true, keys };
  } catch (err) {
    return { ok: false, reason: "RECEIPT_READ_THREW", detail: messageOf(err) };
  }
}

function pruneReceiptsFrom(characterState, characterId, keys) {
  try {
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isModKey)) {
      return { ok: false, reason: "KEY_FOREIGN", permanent: true };
    }
    const peek = characterState && characterState.peekCharacterRecord;
    const update = characterState && characterState.updateCharacterRecord;
    if (typeof peek !== "function" || typeof update !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
    }
    if (!isCharacterId(characterId)) return { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true };
    const current = receiptsOf(peek.call(characterState, characterId));
    const present = current ? keys.filter((k) => hasOwn(current, k)) : [];
    if (present.length === 0) return { ok: true, removed: 0, written: false };
    let removed = 0;
    const r = update.call(characterState, characterId, (record) => {
      const receipts = receiptsOf(record);
      if (!receipts) return record;
      const next = { ...receipts };
      for (const k of present) {
        if (hasOwn(next, k)) {
          delete next[k];
          removed += 1;
        }
      }
      record[RECEIPTS_FIELD] = next;
      return record;
    });
    if (r && r.success === true) return { ok: true, removed, written: true };
    const errorMsg = r && typeof r.errorMsg === "string" ? r.errorMsg : "";
    if (errorMsg === "CHARACTER_NOT_FOUND") return { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true };
    return { ok: false, reason: "RECEIPT_WRITE_FAILED", permanent: false, detail: (errorMsg || "no result")
      .slice(0, MAX_DETAIL) };
  } catch (err) {
    return { ok: false, reason: "RECEIPT_THREW", permanent: false, detail: messageOf(err) };
  }
}

module.exports = { listReceiptKeysFrom, pruneReceiptsFrom, MOD_RECEIPT_PREFIX };
