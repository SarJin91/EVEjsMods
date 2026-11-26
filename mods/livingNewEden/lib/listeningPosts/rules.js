"use strict";

const { NOTICE_KIND, NOTICE_KIND_LARGE } = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const ascending = (a, b) => a - b;
const MAX_LINE = 400;
const MAX_NAME = 64;
const NON_ASCII = /[^\x20-\x7e]/g;

function watchedOf(posts, neighborsOf, rangeJumps) {
  const sets = new Map();
  const add = (systemId, corpId) => {
    if (!isId(systemId)) return;
    if (!sets.has(systemId)) sets.set(systemId, new Set());
    sets.get(systemId).add(corpId);
  };
  for (const p of Array.isArray(posts) ? posts : []) {
    if (!p || p.armed !== true || !isId(p.systemId) || !isId(p.ownerCorpId)) continue;
    add(p.systemId, p.ownerCorpId);
    if (rangeJumps >= 1 && typeof neighborsOf === "function") {
      const list = neighborsOf(p.systemId);
      for (const nb of Array.isArray(list) ? list : []) add(Number(nb), p.ownerCorpId);
    }
  }
  const watched = new Map();
  for (const id of [...sets.keys()].sort(ascending)) watched.set(id, [...sets.get(id)].sort(ascending));
  return { watched };
}

function crossingsOfLeg(leg, watched, maxChecksPerLeg, fromIndex = 0) {
  const out = [];
  if (!leg || !Array.isArray(leg.systems) || !(watched instanceof Map) || watched.size === 0) return out;
  if (!Number.isSafeInteger(leg.departAt) || !Number.isSafeInteger(leg.jumpMs) || leg.jumpMs < 0) return out;
  const start = Number.isSafeInteger(fromIndex) && fromIndex > 0 ? fromIndex : 0;
  for (let i = start; i < leg.systems.length && out.length < maxChecksPerLeg; i += 1) {
    const systemId = leg.systems[i];
    if (watched.has(systemId)) out.push({ systemId, systemIndex: i, enterAt: leg.departAt + i * leg.jumpMs });
  }
  return out;
}

function sizeClassOf(shipCount, settings) {
  if (!Number.isSafeInteger(shipCount) || shipCount < 0) return "medium";
  if (shipCount <= settings.smallMaxShips) return "small";
  if (shipCount >= settings.largeMinShips) return "large";
  return "medium";
}

function shipCountOf(composition) {
  if (!Array.isArray(composition)) return null;
  return composition.reduce((sum, e) => sum + (Number.isSafeInteger(e && e.count) ? e.count : 0), 0);
}

function effectRowsOf(S) {
  const mail = S.mailEnabled === true ? S.maxCorpsPerSighting * S.mailMaxRecipients : 0;
  return 1 + S.pruneBatch + mail + 1;
}

function asciiOf(v) {
  const s = typeof v === "string" ? v.replace(NON_ASCII, "?").trim().slice(0, MAX_NAME) : "";
  return s === "" ? "?" : s;
}

const nameIn = (map, id) => asciiOf(map instanceof Map && isId(id) ? map.get(id) : null);

function timeOf(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return "?";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function sightingLineOf(s, names) {
  const n = names || {};
  const sys = (id) => nameIn(n.systems, id);
  const hasFrom = isId(s.fromSystemId);
  const hasTo = isId(s.toSystemId);
  let move;
  if (hasFrom && hasTo) move = `passed from ${sys(s.fromSystemId)} to ${sys(s.toSystemId)}`;
  else if (hasTo) move = `departed towards ${sys(s.toSystemId)}`;
  else if (hasFrom) move = `arrived from ${sys(s.fromSystemId)}`;
  else move = "ended its route here";
  const line = `Listening post ${sys(s.systemId)}: ${nameIn(n.factions, s.factionId)} ${asciiOf(s.fleetRole)} fleet `
    + `(${asciiOf(s.sizeClass)}) ${move} at ${timeOf(s.seenAt)} EVE.`;
  return line.replace(NON_ASCII, "?").slice(0, MAX_LINE);
}

function noticeKindOf(s) {
  return s && (s.sizeClass === "large" || s.fleetRole === "invasion") ? NOTICE_KIND_LARGE : NOTICE_KIND;
}

function corpSystemsOf(watched) {
  const out = new Map();
  if (!(watched instanceof Map)) return out;
  for (const [systemId, corpIds] of watched) {
    for (const corpId of Array.isArray(corpIds) ? corpIds : []) {
      if (!out.has(corpId)) out.set(corpId, []);
      out.get(corpId).push(systemId);
    }
  }
  for (const list of out.values()) list.sort(ascending);
  return out;
}

function recipientsOf(corpIds, membersOf, maxCorps) {
  const list = (Array.isArray(corpIds) ? corpIds : []).filter(isId)
    .slice(0, Number.isSafeInteger(maxCorps) && maxCorps > 0 ? maxCorps : 0);
  const ids = new Set();
  let refused = 0;
  for (const corpId of list) {
    let r;
    try {
      r = membersOf(corpId);
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !Array.isArray(r.characterIds)) {
      refused += 1;
      continue;
    }
    for (const id of r.characterIds) if (isId(id)) ids.add(id);
  }
  return { characterIds: [...ids].sort(ascending), refused, corps: list.length };
}

module.exports = { watchedOf, crossingsOfLeg, sizeClassOf, shipCountOf, effectRowsOf, sightingLineOf, noticeKindOf,
  corpSystemsOf, recipientsOf };
