"use strict";

const KEEP_ARG = Object.freeze(["NO_TARGET", "NO_HULLS", "NO_HULLS_IN_PRODUCTION"]);
const VIEW_ID = "factions";
const ACTIVE = "ACTIVE";

function noteCode(note) {
  const raw = typeof note === "string" ? note : String(note);
  const at = raw.indexOf(":");
  if (at < 0) return raw;
  const code = raw.slice(0, at);
  return KEEP_ARG.includes(code) ? raw : code;
}

function createNotesTap(saved) {
  const s = saved || {};
  const lastRound = new Map(Array.isArray(s.lastRound) ? s.lastRound : []);
  let day = s.day && typeof s.day === "object" ? JSON.parse(JSON.stringify(s.day)) : {};
  let missedRounds = Number.isSafeInteger(s.missedRounds) ? s.missedRounds : 0;
  let errors = Number.isSafeInteger(s.errors) ? s.errors : 0;
  let lastKey = null;
  const grace = new Set();
  let restarted = false;

  function observe(reviews) {
    for (const r of reviews) {
      if (!r || !Number.isSafeInteger(r.factionId) || !Number.isSafeInteger(r.round)) continue;
      const f = r.factionId;
      const last = lastRound.get(f);
      if (last === r.round) continue;
      if (last === undefined && restarted) grace.add(f);
      else if (grace.has(f)) grace.delete(f);
      else if (last !== undefined && r.round > last + 1) missedRounds += r.round - last - 1;
      lastRound.set(f, r.round);
      const row = day[f] || (day[f] = { reviews: 0, notes: {} });
      row.reviews += 1;
      for (const note of Array.isArray(r.notes) ? r.notes : []) {
        const code = noteCode(note);
        row.notes[code] = (row.notes[code] || 0) + 1;
      }
    }
  }

  function observeViews(views) {
    try {
      const view = views && typeof views.getView === "function" ? views.getView(VIEW_ID) : null;
      if (!view || typeof view.getData !== "function") return;
      const key = typeof view.cacheKey === "function" ? view.cacheKey() : null;
      if (key !== null && key === lastKey) return;
      const data = view.getData({ url: "/", headers: {} });
      if (!data || data.available !== true || !Array.isArray(data.factions)) return;
      lastKey = key;
      observe(data.factions.filter((row) => row.status === ACTIVE && row.lastReview)
        .map((row) => ({ factionId: row.factionId, round: row.lastReview.round, notes: row.lastReview.notes })));
    } catch (_err) {
      errors += 1;
    }
  }

  function drain() {
    const out = { perFaction: day, missedRounds, errors };
    day = {};
    return out;
  }

  function resetRounds() {
    lastRound.clear();
    grace.clear();
    restarted = true;
    lastKey = null;
  }

  function state() {
    return { lastRound: [...lastRound], day: JSON.parse(JSON.stringify(day)), missedRounds, errors };
  }

  return Object.freeze({ observe, observeViews, drain, resetRounds, state });
}

module.exports = { createNotesTap, noteCode, KEEP_ARG };
