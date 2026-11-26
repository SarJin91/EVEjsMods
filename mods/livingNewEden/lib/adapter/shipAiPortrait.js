"use strict";

const EXTENSIONS = Object.freeze(["jpg", "png"]);
const MAX_DETAIL = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const detailOf = (value) => String(value ?? "").slice(0, MAX_DETAIL);

function storeAiPortraitWith(storeExports, aiId, bytes, extension) {
  const store = storeExports && typeof storeExports.storeCharacterPortrait === "function" ? storeExports : null;
  if (!store) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "storeCharacterPortrait" };
  if (typeof store.clearCharacterPortraits !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "clearCharacterPortraits" };
  }
  if (!isId(aiId) || !Buffer.isBuffer(bytes) || bytes.length === 0 || !EXTENSIONS.includes(extension)) {
    return { ok: false, reason: "STORE_FAILED", detail: "input" };
  }
  try {
    store.clearCharacterPortraits(aiId);
  } catch (err) {
    return { ok: false, reason: "STORE_FAILED", detail: detailOf(`clear:${(err && (err.code || err.message)) || err}`) };
  }
  try {
    const res = store.storeCharacterPortrait(aiId, bytes, { extension });
    if (!res || res.success !== true) return { ok: false, reason: "STORE_FAILED", detail: detailOf(res && res.errorMsg) };
    const sizes = res.data && Array.isArray(res.data.sizes) ? res.data.sizes.length : 0;
    return { ok: true, sizes };
  } catch (err) {
    return { ok: false, reason: "STORE_FAILED", detail: detailOf((err && (err.code || err.message)) || err) };
  }
}

module.exports = { storeAiPortraitWith };
