"use strict";

const S_ = require("./schema");
const rules = require("./rules");

const { STATE, INTENT, LIVE_OUTCOMES } = S_;
const EMPTY = Object.freeze([]);
const NO_INTENTS = Object.freeze(new Set());
const ACTIVITY_ROLES = Object.freeze({ [INTENT.RAT]: "RATTER", [INTENT.EXPLORE]: "EXPLORER" });

let tokenSeq = 0;

function activityIntentCodes(names) {
  if (!Array.isArray(names)) return EMPTY;
  const out = [];
  for (const name of names) {
    const code = typeof name === "string" ? INTENT[name] : undefined;
    if (Number.isInteger(code) && ACTIVITY_ROLES[code] && !out.includes(code)) out.push(code);
  }
  return out.length > 0 ? Object.freeze(out.sort((a, b) => a - b)) : EMPTY;
}

function activityCandidate(base, p, fromSystemId) {
  return { ok: true, candidate: Object.freeze({ ...base, role: ACTIVITY_ROLES[p.intent], exit: "NONE", fromSystemId,
    toSystemId: 0 }) };
}

function candidateOf(p, event, rs, systemId, intents) {
  if (!p) return { ok: false, reason: "NO_PILOT" };
  if (p.systemId !== systemId) return { ok: false, reason: "MOVED" };
  if (p.state === STATE.POD) return { ok: false, reason: "POD" };
  const acts = intents instanceof Set ? intents : NO_INTENTS;
  const base = { pilotId: p.pilotId, kind: event.kind, shipTypeId: p.shipTypeId, archetype: p.archetype, at: event.at };
  const isActivity = p.state === STATE.ACTIVE && acts.has(p.intent) && Boolean(ACTIVITY_ROLES[p.intent]);
  if (event.kind === "ACTIVITY") {
    return isActivity && p.intent === event.intent ? activityCandidate(base, p, 0) : { ok: false, reason: "LOCAL_ONLY" };
  }
  const onRoute = Boolean(rs && rs.route && rs.route[rs.at] === systemId);
  if (event.kind === "DEPART") {
    if (p.state !== STATE.TRAVEL) return { ok: false, reason: "LOCAL_ONLY" };
    if (!onRoute || rs.at !== 0 || !(rs.route.length > 1)) return { ok: false, reason: "NO_ROUTE" };
    return { ok: true, candidate: Object.freeze({ ...base, role: "UNDOCK", exit: "GATE", fromSystemId: 0,
      toSystemId: rs.route[1] }) };
  }
  if (p.state === STATE.TRAVEL) {
    if (!onRoute || !(rs.at + 1 < rs.route.length)) return { ok: false, reason: "NO_ROUTE" };
    return { ok: true, candidate: Object.freeze({ ...base, role: "HAULER", exit: "GATE", fromSystemId: p.prevId,
      toSystemId: rs.route[rs.at + 1] }) };
  }
  if (p.state === STATE.DOCKED) {
    return { ok: true, candidate: Object.freeze({ ...base, role: "HAULER", exit: "STATION", fromSystemId: p.prevId,
      toSystemId: 0 }) };
  }
  if (p.state === STATE.ACTIVE && p.intent === INTENT.MINE) {
    return { ok: true, candidate: Object.freeze({ ...base, role: "MINER", exit: "NONE", fromSystemId: p.prevId,
      toSystemId: 0 }) };
  }
  if (isActivity && event.kind === "ARRIVE") return activityCandidate(base, p, p.prevId);
  return { ok: false, reason: "LOCAL_ONLY" };
}

function createLiveOwnership(deps) {
  const { S, pilots, queue, near, step, commit, bump, keyOf } = deps;
  const isGroupMember = typeof deps.isGroupMember === "function" ? deps.isGroupMember : () => false;
  const isLiveHull = typeof deps.isLiveHull === "function" ? deps.isLiveHull : () => true;
  const L = S.live;
  const maxOwned = deps.maxOwned;
  const intents = deps.activityIntents instanceof Set ? deps.activityIntents : NO_INTENTS;
  const owned = new Map();
  const used = new Map();

  function considered(event, sys, accept) {
    if (owned.has(event.pilotId) || isGroupMember(event.pilotId)) return null;
    const usedAt = used.get(event.pilotId);
    if (usedAt !== undefined && event.at <= usedAt) return null;
    const p = pilots.get(event.pilotId);
    if (p && !isLiveHull(p.shipTypeId)) {
      bump("hulls.noLiveProfile");
      return null;
    }
    if (p && accept && !accept(p.shipTypeId)) return null;
    const c = candidateOf(p, event, pilots.route(event.pilotId), sys, intents);
    if (c.ok) return c.candidate;
    if (c.reason === "NO_ROUTE") bump("live.noRoute");
    return null;
  }

  function candidatesIn(systemId, sinceMs, limit, acceptHull) {
    const sys = Number(systemId);
    const n = Number.isSafeInteger(limit) && limit > 0 ? limit : L.maxSpawnsPerSystemPass;
    const accept = typeof acceptHull === "function" ? acceptHull : null;
    const out = [];
    for (const event of near.eventsInto(sys, sinceMs, near.ringSize)) {
      if (out.length >= n) break;
      const c = considered(event, sys, accept);
      if (c) out.push(c);
    }
    if (intents.size > 0 && out.length < n) {
      const taken = new Set(out.map((c) => c.pilotId));
      for (const event of near.activitiesInto(sys, sinceMs, near.activityRingSize)) {
        if (out.length >= n) break;
        if (taken.has(event.pilotId)) continue;
        const c = considered(event, sys, accept);
        if (!c) continue;
        out.push(c);
        taken.add(c.pilotId);
        bump("live.activityCandidates");
      }
    }
    return out.length > 0 ? Object.freeze(out) : EMPTY;
  }

  function claim(pilotId, systemId, now) {
    const id = Number(pilotId);
    const p = pilots.get(id);
    let reason = null;
    if (!p) reason = "NO_PILOT";
    else if (p.systemId !== Number(systemId)) reason = "NOT_IN_SYSTEM";
    else if (owned.has(id)) reason = "ALREADY_OWNED";
    else if (p.state === STATE.POD) reason = "POD";
    else if (isGroupMember(id)) reason = "GROUP_MEMBER";
    else if (owned.size >= maxOwned) reason = "OWNED_FULL";
    if (reason !== null) {
      bump("live.claimRefused");
      return { ok: false, reason };
    }
    queue.remove(keyOf(id));
    tokenSeq += 1;
    owned.set(id, { token: tokenSeq, systemId: p.systemId, claimedAt: now });
    bump("live.claimed");
    return { ok: true, token: tokenSeq };
  }

  function release(pilotId, token, outcome, now) {
    if (!LIVE_OUTCOMES.includes(outcome)) return { ok: false, reason: "BAD_OUTCOME" };
    const id = Number(pilotId);
    const e = owned.get(id);
    if (!e || e.token !== token) return { ok: true, applied: false };
    owned.delete(id);
    if (outcome !== "REFUSED") used.set(id, e.claimedAt);
    bump(`live.${outcome}`);
    const p = pilots.get(id);
    if (!p) return { ok: true, applied: true };
    if (outcome === "JUMPED" && p.state === STATE.TRAVEL && p.systemId === e.systemId) {
      step(id, now);
    } else if (outcome === "KILLED" && p.state !== STATE.POD) {
      pilots.setRoute(id, null);
      commit(p, rules.killed(p, S, now).next, now);
    } else {
      const dueAt = Math.max(p.dueAt, now);
      pilots.setDue(id, dueAt);
      queue.schedule(keyOf(id), dueAt, id);
    }
    const after = pilots.get(id);
    return { ok: true, applied: true, state: S_.nameOf(S_.STATE_NAMES, after ? after.state : p.state) };
  }

  function groupOf(leaderId, systemId, now) {
    const id = Number(leaderId);
    const e = owned.get(id);
    if (!e || e.systemId !== Number(systemId)) return { ok: false, reason: "NOT_OWNED" };
    const ids = typeof deps.membersOf === "function" ? deps.membersOf(id) : null;
    if (!ids || ids.length === 0) return { ok: true, members: EMPTY };
    const max = S.groups && Number.isSafeInteger(S.groups.maxSize) ? S.groups.maxSize : ids.length;
    const out = [];
    for (const m of ids) {
      if (out.length >= max) break;
      const p = pilots.get(m);
      if (!p || p.systemId !== e.systemId || p.state === STATE.POD || owned.has(m) || !isGroupMember(m)) continue;
      used.set(m, now);
      out.push(Object.freeze({ pilotId: m, shipTypeId: p.shipTypeId }));
    }
    return { ok: true, members: out.length > 0 ? Object.freeze(out) : EMPTY };
  }

  function releaseMember(memberId, leaderId, token, now) {
    const id = Number(memberId);
    const lid = Number(leaderId);
    const e = owned.get(lid);
    if (!e || e.token !== token || typeof deps.detachMember !== "function") return { ok: true, applied: false };
    const m = pilots.get(id);
    if (!m || m.state === STATE.POD || m.systemId !== e.systemId || pilots.groupOf(id) !== lid || !isGroupMember(id)) {
      return { ok: true, applied: false };
    }
    if (deps.detachMember(id, lid, now) !== true) return { ok: true, applied: false };
    pilots.setRoute(id, null);
    const p = pilots.get(id);
    commit(p, rules.killed(p, S, now).next, now);
    bump("live.memberKilled");
    const after = pilots.get(id);
    return { ok: true, applied: true, state: S_.nameOf(S_.STATE_NAMES, after ? after.state : p.state) };
  }

  function expire(now) {
    let n = 0;
    for (const [id, e] of [...owned]) {
      if (now - e.claimedAt <= L.ownMaxMs) continue;
      bump("live.ownTimeout");
      release(id, e.token, "EXPIRED", now);
      n += 1;
    }
    for (const [id, at] of used) if (now - at > L.maxEventAgeMs) used.delete(id);
    return n;
  }

  function clear() {
    owned.clear();
    used.clear();
  }

  return Object.freeze({ candidatesIn, claim, release, groupOf, releaseMember, expire, clear, size: () => owned.size,
    isOwned: (id) => owned.has(Number(id)) });
}

module.exports = { createLiveOwnership, candidateOf, activityIntentCodes };
