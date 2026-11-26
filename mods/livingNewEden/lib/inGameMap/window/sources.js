"use strict";

const STATE_ID = "galaxy-state";

function keyOfView(view) {
  if (typeof view.cacheKey !== "function") return null;
  try {
    const k = view.cacheKey();
    return k === undefined || k === null ? null : String(k);
  } catch (_err) {
    return null;
  }
}

function createSources(deps) {
  const memo = new Map();

  function fromMemo(id, reason) {
    const m = memo.get(id);
    return m ? { ok: true, key: m.key, data: m.data, stale: true } : { ok: false, reason };
  }

  function fetch(view) {
    try {
      const data = view.getData();
      if (!data || typeof data !== "object") return { ok: false, reason: "NO_RESULT" };
      if (data.available !== true) return { ok: false, reason: String(data.reason || "UNAVAILABLE") };
      return { ok: true, data };
    } catch (_err) {
      return { ok: false, reason: "THREW" };
    }
  }

  function read(id) {
    const views = deps.views;
    const view = views && typeof views.getView === "function" ? views.getView(id) : null;
    if (!view || typeof view.getData !== "function") {
      memo.delete(id);
      return { ok: false, reason: "NOT_REGISTERED" };
    }
    const now = deps.clock.now();
    const key = keyOfView(view);
    const m = memo.get(id);
    if (key === null) {
      if (m) return fromMemo(id, "NO_KEY");
      const got = fetch(view);
      if (!got.ok) return got;
      const after = keyOfView(view);
      if (after === null) return { ok: false, reason: "NO_KEY" };
      memo.set(id, { key: after, data: got.data, atMs: now });
      return { ok: true, key: after, data: got.data, stale: false };
    }
    if (m && m.key === key) return { ok: true, key: m.key, data: m.data, stale: false };
    if (m && id === STATE_ID && now - m.atMs < deps.stateMinRefreshMs) {
      return { ok: true, key: m.key, data: m.data, stale: false };
    }
    const got = fetch(view);
    if (!got.ok) return fromMemo(id, got.reason);
    memo.set(id, { key, data: got.data, atMs: now });
    return { ok: true, key, data: got.data, stale: false };
  }

  return Object.freeze({ read, clear: () => memo.clear() });
}

module.exports = { STATE_ID, createSources };
