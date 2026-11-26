"use strict";

const T = require("../fleetExposure/transitRules");

const MINUTE_MS = 60000;

function noop() {}

function createTransitSweep(deps) {
  const S = deps.settings;
  const H = deps.heldSettings || {};
  const bump = typeof deps.telemetryBump === "function" ? deps.telemetryBump : noop;
  const endMargin = Number.isSafeInteger(H.transitEndMarginMs) && H.transitEndMarginMs > 0 ? H.transitEndMarginMs : 0;

  let cursor = { stateIdx: 0, after: "" };
  const legs = new Map();
  const bySystem = new Map();
  const byNext = new Map();
  const expiry = new Map();
  const observedSince = new Map();
  const shown = new Map();
  let pageLegs = new Map();
  let missedTotal = 0;
  let stopped = false;

  const crossingKey = (c) => `${c.legSeq}:${c.systemIndex}`;

  function nextKeysOf(state, systems) {
    if (state !== "TRAVELLING") return [];
    const out = [];
    for (let i = 1; i < systems.length; i += 1) if (!out.includes(systems[i])) out.push(systems[i]);
    return out;
  }

  function legRecord(fleet, keys) {
    const r = fleet.route;
    return { fleetId: fleet.fleetId, legSeq: fleet.legSeq, state: fleet.state, departAt: r.departAt, jumpMs: r.jumpMs,
      systems: [...r.systems], keys, nextKeys: nextKeysOf(fleet.state, r.systems),
      expiresAt: r.departAt + (r.systems.length - 1) * r.jumpMs + endMargin };
  }

  function dropFrom(map, keys, fleetId) {
    for (const sys of keys) {
      const set = map.get(sys);
      if (!set) continue;
      set.delete(fleetId);
      if (set.size === 0) map.delete(sys);
    }
  }

  function removeLeg(fleetId) {
    const leg = legs.get(fleetId);
    if (!leg) return;
    legs.delete(fleetId);
    dropFrom(bySystem, leg.keys, fleetId);
    dropFrom(byNext, leg.nextKeys, fleetId);
  }

  function index(fleet, keys, now) {
    const old = legs.get(fleet.fleetId);
    if (old && old.legSeq === fleet.legSeq && old.state === fleet.state) return false;
    if (!old && legs.size >= S.transitIndexMax) {
      bump("presenceTransitIndexFull");
      return false;
    }
    if (old) removeLeg(fleet.fleetId);
    const leg = legRecord(fleet, keys);
    legs.set(fleet.fleetId, leg);
    for (const sys of keys) {
      if (!bySystem.has(sys)) bySystem.set(sys, new Set());
      bySystem.get(sys).add(fleet.fleetId);
    }
    for (const sys of leg.nextKeys) {
      if (!byNext.has(sys)) byNext.set(sys, new Set());
      byNext.get(sys).add(fleet.fleetId);
    }
    const bucket = Math.floor(leg.expiresAt / MINUTE_MS);
    if (!expiry.has(bucket)) expiry.set(bucket, []);
    expiry.get(bucket).push(fleet.fleetId);
    const missed = T.missedWindows(fleet, observedSince, now);
    if (missed > 0) {
      missedTotal += missed;
      bump("presenceTransitMissed", missed);
    }
    bump("presenceTransitIndexed");
    return true;
  }

  function prune(now) {
    const current = Math.floor(now / MINUTE_MS);
    for (const [bucket, ids] of expiry) {
      if (bucket > current) continue;
      const keep = [];
      for (const id of ids) {
        const leg = legs.get(id);
        if (!leg) continue;
        if (leg.expiresAt <= now) removeLeg(id);
        else keep.push(id);
      }
      if (keep.length === 0) expiry.delete(bucket);
      else expiry.set(bucket, keep);
    }
    for (const [id, s] of shown) if (now >= s.until) shown.delete(id);
  }

  function observe(systems, now) {
    if (stopped) return;
    const set = new Set(Array.isArray(systems) ? systems : []);
    for (const id of [...observedSince.keys()]) if (!set.has(id)) observedSince.delete(id);
    for (const id of set) if (!observedSince.has(id)) observedSince.set(id, now);
  }

  function sweepInTx(db, repo, now) {
    pageLegs = new Map();
    if (stopped) return { ok: true, pages: 0, indexed: 0, missed: 0 };
    if (!repo || typeof repo.listFleetsByState !== "function") return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    let pages = 0;
    let indexed = 0;
    const missedBefore = missedTotal;
    for (let p = 0; p < S.transitPagesPerScan; p += 1) {
      const state = T.TRANSIT_STATES[cursor.stateIdx];
      const r = repo.listFleetsByState(db, state, { limit: S.scanMaxTravelling, afterFleetId: cursor.after });
      if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "READ_FAILED" };
      pages += 1;
      for (const f of r.fleets) {
        const keys = T.legIndexKeys(f);
        if (keys.length === 0) {
          removeLeg(f.fleetId);
          continue;
        }
        pageLegs.set(f.fleetId, legRecord(f, keys));
        if (S.transitIndexMax > 0 && index(f, keys, now)) indexed += 1;
      }
      cursor = r.nextAfterFleetId === null
        ? { stateIdx: (cursor.stateIdx + 1) % T.TRANSIT_STATES.length, after: "" }
        : { stateIdx: cursor.stateIdx, after: r.nextAfterFleetId };
    }
    bump("presenceTransitPages", pages);
    return { ok: true, pages, indexed, missed: missedTotal - missedBefore };
  }

  function candidateIds(systems, now) {
    if (stopped) return [];
    prune(now);
    const out = new Set();
    const wanted = new Set(Array.isArray(systems) ? systems : []);
    for (const sys of wanted) for (const id of bySystem.get(sys) || []) out.add(id);
    for (const leg of pageLegs.values()) if (leg.keys.some((s) => wanted.has(s))) out.add(leg.fleetId);
    return [...out].sort();
  }

  function noteShown(fleetId, crossing) {
    shown.set(fleetId, { key: crossingKey(crossing), until: crossing.windowEnd });
  }

  function wasShown(fleetId, crossing) {
    const s = shown.get(fleetId);
    return Boolean(s && s.key === crossingKey(crossing));
  }

  function forget(fleetId) {
    removeLeg(fleetId);
    pageLegs.delete(fleetId);
  }

  function refresh(fleet, now) {
    if (stopped || !fleet) return;
    const keys = T.legIndexKeys(fleet);
    if (keys.length === 0) {
      forget(fleet.fleetId);
      return;
    }
    if (legs.has(fleet.fleetId) && S.transitIndexMax > 0) index(fleet, keys, now);
  }

  function inboundTo(systemId, now, max) {
    if (stopped || !Number.isSafeInteger(systemId) || !Number.isSafeInteger(now)) return [];
    const cap = Number.isSafeInteger(max) && max > 0 ? max : 0;
    if (cap === 0) return [];
    prune(now);
    const cands = new Map();
    for (const id of byNext.get(systemId) || []) {
      const leg = legs.get(id);
      if (leg) cands.set(id, leg);
    }
    if (S.transitIndexMax === 0) {
      for (const leg of pageLegs.values()) if (leg.nextKeys.includes(systemId)) cands.set(leg.fleetId, leg);
    }
    const out = [];
    for (const leg of cands.values()) {
      if (leg.state !== "TRAVELLING" || now < leg.departAt || !(leg.jumpMs > 0)) continue;
      const k = Math.floor((now - leg.departAt) / leg.jumpMs);
      if (k < 0 || k > leg.systems.length - 2) continue;
      if (leg.systems[k + 1] !== systemId || leg.systems[k] === systemId) continue;
      out.push({ fleetId: leg.fleetId, legSeq: leg.legSeq, etaMs: leg.departAt + (k + 1) * leg.jumpMs - now });
    }
    out.sort((a, b) => (a.etaMs - b.etaMs) || (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0)));
    return out.slice(0, cap);
  }

  function hasLegsIn(systemId) {
    return bySystem.has(systemId);
  }

  function getStatus() {
    return { legs: legs.size, cursor: { state: T.TRANSIT_STATES[cursor.stateIdx], after: cursor.after },
      observed: observedSince.size, shown: shown.size, missed: missedTotal };
  }

  function stop() {
    stopped = true;
  }

  return Object.freeze({ observe, sweepInTx, candidateIds, noteShown, wasShown, forget, refresh, hasLegsIn, getStatus,
    stop, inboundTo });
}

module.exports = { createTransitSweep };
