"use strict";

const { runTx } = require("../tx");

const MAX_TRACKED = 10000;

function createReaders(deps) {
  const { store, repo } = deps;
  const m = deps.settings.mail;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const lastTouch = new Map();

  function presenceIds() {
    try {
      const p = deps.getPresence();
      if (!p || typeof p.getStatus !== "function" || typeof p.listPresence !== "function") return null;
      const st = p.getStatus();
      if (!st || st.available !== true || st.stale === true) return null;
      const ids = new Set();
      for (const sys of p.listPresence() || []) {
        for (const c of (sys && sys.characters) || []) {
          if (c && Number.isSafeInteger(c.characterId) && c.characterId > 0) ids.add(c.characterId);
        }
      }
      return [...ids].sort((a, b) => a - b);
    } catch (_err) {
      return null;
    }
  }

  function touch(now) {
    const ids = presenceIds();
    if (ids === null) return { ok: true, touched: 0, skipped: "PRESENCE_UNAVAILABLE" };
    const due = ids.filter((id) => {
      const at = lastTouch.get(id);
      return at === undefined || now - at >= m.readerTouchMs;
    });
    if (due.length === 0) return { ok: true, touched: 0 };
    const chunk = Math.max(1, deps.rowsCap(due.length));
    let touched = 0;
    for (let i = 0; i < due.length; i += chunk) {
      const part = due.slice(i, i + chunk);
      const r = runTx(store, "news.readers", (db) => repo.touchReadersInTx(db, part, now));
      if (!r.ok) return r;
      if (lastTouch.size + part.length > MAX_TRACKED) lastTouch.clear();
      for (const id of part) lastTouch.set(id, now);
      touched += part.length;
    }
    bump("readersTouched", touched);
    return { ok: true, touched };
  }

  function optOut(characterId, optedOut, now) {
    const r = runTx(store, "news.optout", (db) => repo.setOptOutInTx(db, { characterId, optedOut, now }));
    if (!r.ok) {
      log(`optout ${r.reason}`);
      return r;
    }
    if (r.value.changed && optedOut) bump("optOuts");
    return { ok: true, changed: r.value.changed };
  }

  return Object.freeze({ touch, optOut });
}

module.exports = { createReaders, MAX_TRACKED };
