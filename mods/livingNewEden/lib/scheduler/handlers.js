"use strict";

const { getEventType } = require("./eventTypes");

function createHandlerRegistry() {
  const byType = new Map();

  function register(type, fn, opts) {
    if (!getEventType(type)) return { ok: false, reason: "UNKNOWN_EVENT_TYPE" };
    if (typeof fn !== "function" || (fn.constructor && fn.constructor.name === "AsyncFunction")) {
      return { ok: false, reason: "INVALID_HANDLER" };
    }
    if (opts !== undefined && (opts === null || typeof opts !== "object")) return { ok: false, reason: "INVALID_HANDLER" };
    const quota = opts === undefined ? undefined : opts.maxPerPass;
    if (quota !== undefined && (!Number.isSafeInteger(quota) || quota < 1)) {
      return { ok: false, reason: "INVALID_HANDLER" };
    }
    if (byType.has(type)) return { ok: false, reason: "HANDLER_EXISTS" };
    const entry = { fn, quota: quota === undefined ? null : quota };
    byType.set(type, entry);
    let active = true;
    return {
      ok: true,
      unregister() {
        if (active && byType.get(type) === entry) byType.delete(type);
        active = false;
      },
    };
  }

  function get(type) {
    const entry = byType.get(type);
    return entry ? entry.fn : null;
  }

  function quotaOf(type) {
    const entry = byType.get(type);
    return entry ? entry.quota : null;
  }

  function types() {
    return [...byType.keys()].sort();
  }

  return Object.freeze({ register, get, quotaOf, types });
}

module.exports = { createHandlerRegistry };
