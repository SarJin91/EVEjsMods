"use strict";

const { bfs } = require("./bfs");
const { mergeMin } = require("./supply");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../data/expansion");

const NULLSEC = "nullsec";
const EXCLUDED = new Set(EXPANSION_EXCLUDED_REGION_IDS);

function isExpansionTarget(v) {
  return Boolean(v) && v.secClass === NULLSEC && !EXCLUDED.has(v.regionId);
}

function rangeCandidates(input) {
  if (!(input.reach instanceof Map) || !(input.limit > 0) || !(input.jumps >= 0)) return [];
  const theatre = new Set(input.theatre);
  const skip = input.excludeRegionIds instanceof Set ? input.excludeRegionIds : null;
  return [...input.reach.entries()].filter(([id, jumps]) => {
    if (jumps > input.jumps || theatre.has(id)) return false;
    const v = input.getSystem(id);
    return isExpansionTarget(v) && !(skip !== null && skip.has(v.regionId));
  })
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, input.limit).map(([id]) => id);
}

function expansionCandidates(input) {
  if (input.enabled !== true || !(input.limit > 0)) return [];
  const hasGroups = Array.isArray(input.groups) && input.groups.length > 0;
  if (!hasGroups && input.reach instanceof Map) {
    if (!Array.isArray(input.stationSystems) || input.stationSystems.length === 0 || !(input.jumps >= 0)) return [];
    return rangeCandidates({ reach: input.reach, theatre: input.theatre, getSystem: input.getSystem,
      jumps: input.jumps, limit: input.limit });
  }
  const theatre = new Set(input.theatre);
  const groups = Array.isArray(input.groups) && input.groups.length > 0
    ? input.groups
    : [{ starts: input.stationSystems, jumps: input.jumps }];
  const mergedReach = groups.reduce((acc, group) => {
    if (!Array.isArray(group.starts) || group.starts.length === 0 || !(group.jumps >= 0)) return acc;
    const bfsResult = bfs(group.starts, input.neighbors, { maxJumps: group.jumps, maxSystems: input.maxSystems });
    return mergeMin(acc, bfsResult);
  }, new Map());
  return [...mergedReach.entries()].filter(([id]) => {
    if (theatre.has(id)) return false;
    return isExpansionTarget(input.getSystem(id));
  }).sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, input.limit).map(([id]) => id);
}

function pickExpansion(scan, accept, limit) {
  const out = [];
  if (!Array.isArray(scan) || !(limit > 0)) return out;
  for (const id of scan) {
    if (out.length >= limit) break;
    if (accept(id)) out.push(id);
  }
  return out;
}

module.exports = { expansionCandidates, rangeCandidates, isExpansionTarget, pickExpansion };
