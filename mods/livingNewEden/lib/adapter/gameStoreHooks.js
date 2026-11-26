"use strict";

function errorDetail(err) {
  return String((err && err.message) || err);
}

function registerShutdown(gameStoreExports, name, handler) {
  if (!gameStoreExports || typeof gameStoreExports.registerShutdownHook !== "function") {
    return { ok: false, reason: "SHUTDOWN_HOOK_UNAVAILABLE" };
  }
  try {
    const unregister = gameStoreExports.registerShutdownHook(name, handler);
    return { ok: true, unregister: typeof unregister === "function" ? unregister : () => {} };
  } catch (err) {
    return { ok: false, reason: "SHUTDOWN_HOOK_REJECTED", detail: errorDetail(err) };
  }
}

function subscribeOwnerLost(gameStoreExports, listener) {
  if (!gameStoreExports || typeof gameStoreExports.onPersistenceOwnerLost !== "function") {
    return { ok: false, reason: "OWNER_LOST_UNAVAILABLE" };
  }
  try {
    const unsubscribe = gameStoreExports.onPersistenceOwnerLost(listener);
    return { ok: true, unsubscribe: typeof unsubscribe === "function" ? unsubscribe : () => {} };
  } catch (err) {
    return { ok: false, reason: "OWNER_LOST_REJECTED", detail: errorDetail(err) };
  }
}

module.exports = { registerShutdown, subscribeOwnerLost };
