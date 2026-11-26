"use strict";

const { KIND_ORDER, anchorRef } = require("../../fleets/grid/anchors");

const RELATION = Object.freeze({ HOSTILE: "HOSTILE", NONE: "NONE", ALLIED: "ALLIED", OWN: "OWN" });
const GATE_ORDER = Object.freeze([RELATION.HOSTILE, RELATION.NONE, RELATION.ALLIED]);
const STATION_KINDS = Object.freeze(["station", "structure"]);

const rankOf = (kind) => (Object.prototype.hasOwnProperty.call(KIND_ORDER, kind) ? KIND_ORDER[kind]
  : Object.keys(KIND_ORDER).length);
const byKindId = (a, b) => (rankOf(a.kind) - rankOf(b.kind)) || (a.id - b.id);
const byId = (a, b) => a.id - b.id;

function relationOfGate(gate, relationOf) {
  const r = relationOf instanceof Map ? relationOf.get(gate.toSystemId) : undefined;
  return Object.values(RELATION).includes(r) ? r : RELATION.NONE;
}

function rankPosts(input) {
  const anchors = Array.isArray(input && input.anchors) ? input.anchors.filter((a) => a && typeof a === "object") : [];
  const gridOf = input && input.gridOf instanceof Map ? input.gridOf : new Map();
  const own = input && input.ownStationRefs instanceof Set ? input.ownStationRefs : new Set();
  const sieged = input && input.siegeRefs instanceof Set ? input.siegeRefs : new Set();
  const relationOf = input ? input.relationOf : null;
  const cp = input && input.cp ? input.cp : null;
  const gates = anchors.filter((a) => a.kind === "gate");
  const ordered = [];
  const besieged = sieged.size > 0 ? anchors.filter((a) => sieged.has(anchorRef(a.kind, a.id))).sort(byKindId) : [];
  if (besieged.length > 0) {
    ordered.push(...besieged);
  } else {
    if (cp) ordered.push(cp);
    for (const rel of GATE_ORDER) {
      ordered.push(...gates.filter((g) => relationOfGate(g, relationOf) === rel).sort(byId));
    }
    ordered.push(...anchors.filter((a) => STATION_KINDS.includes(a.kind) && own.has(anchorRef(a.kind, a.id)))
      .sort(byKindId));
    ordered.push(...gates.filter((g) => relationOfGate(g, relationOf) === RELATION.OWN).sort(byId));
  }
  const seen = new Set();
  const posts = [];
  for (const a of ordered) {
    const ref = anchorRef(a.kind, a.id);
    const grid = gridOf.get(ref) || ref;
    if (seen.has(grid)) continue;
    seen.add(grid);
    posts.push(a);
  }
  return posts;
}

function pickPost(input) {
  const posts = Array.isArray(input && input.posts) ? input.posts : [];
  if (posts.length === 0) return { anchor: null, index: -1 };
  const ids = Array.isArray(input.defenderIds) ? input.defenderIds : [];
  const at = ids.indexOf(input.fleetId);
  const k = at < 0 ? ids.length : at;
  const maxPosts = Number.isSafeInteger(input.maxPosts) && input.maxPosts > 0 ? input.maxPosts : 1;
  const index = k % Math.min(posts.length, maxPosts);
  return { anchor: posts[index], index };
}

function relationOfControllers(systems, factionId, isHostile) {
  const out = new Map();
  for (const s of Array.isArray(systems) ? systems : []) {
    if (!s || typeof s !== "object") continue;
    const c = s.controllerFactionId;
    let rel;
    if (c === factionId) rel = RELATION.OWN;
    else if (!(Number.isSafeInteger(c) && c > 0)) rel = RELATION.NONE;
    else {
      let h = false;
      try {
        h = typeof isHostile === "function" && isHostile(factionId, c) === true;
      } catch (_err) {
        h = false;
      }
      rel = h ? RELATION.HOSTILE : RELATION.ALLIED;
    }
    out.set(s.systemId, rel);
  }
  return out;
}

module.exports = { rankPosts, pickPost, relationOfControllers, RELATION };
