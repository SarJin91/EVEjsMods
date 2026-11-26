"use strict";

function readSystemList(authorityExports, key) {
  if (typeof key !== "string" || key.trim() === "") return { ok: false, reason: "INVALID_INPUT", detail: "key" };
  if (!authorityExports || typeof authorityExports.getSystemList !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "getSystemList" };
  }
  let list;
  try {
    list = authorityExports.getSystemList(key);
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `threw: ${String((err && err.message) || err)}` };
  }
  if (!Array.isArray(list)) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "not_an_array" };
  const ids = new Set();
  for (const v of list) {
    const n = Number(v);
    if (Number.isSafeInteger(n) && n > 0) ids.add(n);
  }
  if (ids.size === 0) return { ok: false, reason: "EMPTY", detail: key };
  return { ok: true, systemIds: Object.freeze([...ids].sort((a, b) => a - b)) };
}

module.exports = { readSystemList };
