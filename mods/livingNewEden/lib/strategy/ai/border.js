"use strict";

const { bfs } = require("./bfs");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../data/expansion");

const SOVEREIGNTY_SELF = "self";
const SOVEREIGNTY_FRIENDLY = "friendly";
const EXCLUDED = new Set(EXPANSION_EXCLUDED_REGION_IDS);

const OFF_NO_OWN_SPACE = Object.freeze({ mode: "off", reason: "NO_OWN_SPACE" });
const OFF_NO_SOURCES = Object.freeze({ mode: "off", reason: "NO_SOURCES" });

function ownSpaceBelt(input) {
  const space = input.ownSpace;
  if (!space || !Array.isArray(space.secClasses) || space.secClasses.length === 0) return OFF_NO_OWN_SPACE;
  const friendly = space.sovereignty === SOVEREIGNTY_FRIENDLY;
  const isFriendly = typeof input.isFriendly === "function" ? input.isFriendly : () => false;
  const own = new Set();
  const self = friendly ? new Set() : own;
  for (const secClass of space.secClasses) {
    for (const id of input.systemsOfClass(secClass) || []) {
      const v = input.getSystem(id);
      if (!v) continue;
      if (friendly) {
        if (v.factionId === input.factionId) self.add(id);
        else if (!(Number.isSafeInteger(v.factionId) && v.factionId > 0 && isFriendly(v.factionId) === true)) continue;
      } else if (space.sovereignty === SOVEREIGNTY_SELF && v.factionId !== input.factionId) continue;
      own.add(id);
    }
  }
  if (own.size === 0) return OFF_NO_OWN_SPACE;
  const home = new Set(input.homeRegionIds || []);
  const sources = [...self].filter((id) => {
    const v = input.getSystem(id);
    if (!v || !home.has(v.regionId)) return false;
    const list = input.neighbors(id);
    return Array.isArray(list) && list.some((nb) => !own.has(nb));
  }).sort((a, b) => a - b);
  if (sources.length === 0) return OFF_NO_SOURCES;
  const all = bfs(sources, input.neighbors, { maxJumps: Math.max(0, input.maxJumps), maxSystems: input.maxSystems,
    through: (id) => {
      if (own.has(id)) return false;
      const sys = input.getSystem(id);
      return !sys || !EXCLUDED.has(sys.regionId);
    } });
  const reach = new Map();
  for (const [id, jumps] of all) if (!own.has(id)) reach.set(id, jumps);
  const line = Object.freeze(sources.map((id) => Object.freeze({ systemId: id,
    outside: Object.freeze([...new Set(input.neighbors(id))].filter((nb) => !own.has(nb)).sort((a, b) => a - b)) })));
  return { mode: "ready", reach, sources: sources.length, line };
}

function territoryLine(systemIds, neighbors) {
  const own = new Set(systemIds || []);
  const out = [];
  for (const id of [...own].sort((a, b) => a - b)) {
    const list = neighbors(id);
    if (!Array.isArray(list)) continue;
    const outside = [...new Set(list)].filter((nb) => !own.has(nb)).sort((a, b) => a - b);
    if (outside.length > 0) out.push({ systemId: id, outside });
  }
  return out;
}

function borderCandidates(input) {
  if (!(input.reach instanceof Map) || !(input.limit > 0)) return [];
  const skip = new Set([...(input.theatre || []), ...(input.expansion || [])]);
  const classes = new Set(input.secClasses || []);
  const accept = typeof input.accept === "function" ? input.accept : null;
  return [...input.reach.entries()].filter(([id]) => {
    if (skip.has(id)) return false;
    const v = input.getSystem(id);
    if (!v || !classes.has(v.secClass) || EXCLUDED.has(v.regionId)) return false;
    return accept === null || accept(id) === true;
  }).sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, input.limit).map(([id]) => id);
}

function borderLineOf(input) {
  const own = input.own;
  let line = [];
  if (own && own.ok === true && own.mode === "ready" && Array.isArray(own.line)) line = own.line;
  else if (!own || (own.ok === true && own.reason === "NO_OWN_SPACE")) {
    line = territoryLine(input.territoryIds, input.neighbors);
  }
  const classes = new Set(input.secClasses || []);
  return line.filter((x) => classes.has(input.secClassOf(x.systemId)))
    .slice(0, Math.max(0, input.maxSystems || 0));
}

function isBorderTarget(row, factionId, isHostile) {
  if (!row) return false;
  const controller = row.controllerFactionId;
  if (controller === null) return true;
  return controller !== factionId && isHostile(controller) === true;
}

module.exports = { ownSpaceBelt, borderCandidates, isBorderTarget, territoryLine, borderLineOf };
