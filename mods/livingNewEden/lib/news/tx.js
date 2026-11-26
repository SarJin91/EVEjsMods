"use strict";

const { createAbortSentinel } = require("../persistence/store");

const ABORT = createAbortSentinel("news.refused");

function messageOf(err) {
  return String((err && err.message) || err);
}

function runTx(store, name, fn) {
  let refused = null;
  let r;
  try {
    r = store.transaction(name, (db) => {
      const out = fn(db);
      if (!out || out.ok !== true) {
        refused = out || { ok: false, reason: "NO_RESULT" };
        throw ABORT;
      }
      return out;
    });
  } catch (err) {
    return { ok: false, reason: "TX_THREW", detail: messageOf(err) };
  }
  if (r && r.ok) return { ok: true, value: r.value };
  if (refused && r && r.error === ABORT) {
    return { ok: false, reason: String(refused.reason || "REFUSED"),
      ...(refused.detail ? { detail: String(refused.detail) } : {}) };
  }
  return { ok: false, reason: r ? String(r.reason || "TX_FAILED") : "TX_FAILED",
    ...(r && r.error && r.error !== ABORT ? { detail: messageOf(r.error) } : {}) };
}

module.exports = { runTx };
