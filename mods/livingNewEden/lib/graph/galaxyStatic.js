"use strict";

const { projectTopDown } = require("./galaxyProjection");

const GALAXY_SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);
const LAYOUT = "topdown";
const SECURITY_TENTHS = 10;

function buildGalaxyStatic(graph, opts) {
  const ids = [];
  const points = [];
  const sec = [];
  const cls = [];
  const regionOf = [];
  const name = [];
  const regionIndex = new Map();
  const index = new Map();
  let skippedNoPosition = 0;
  for (const id of graph.getSystemIds()) {
    const v = graph.getSystem(id);
    const c = v ? GALAXY_SEC_CLASSES.indexOf(v.secClass) : -1;
    if (c === -1) continue;
    if (!v.position) {
      skippedNoPosition += 1;
      continue;
    }
    index.set(id, ids.length);
    ids.push(id);
    points.push(v.position);
    sec.push(Math.round(v.security * SECURITY_TENTHS));
    cls.push(c);
    if (!regionIndex.has(v.regionId)) regionIndex.set(v.regionId, null);
    regionOf.push(v.regionId);
    name.push(v.name);
  }
  if (ids.length === 0) return { available: false, reason: "NO_POSITIONS", skippedNoPosition };

  const regionIds = [...regionIndex.keys()].sort((a, b) => a - b);
  regionIds.forEach((rid, i) => regionIndex.set(rid, i));
  const regions = regionIds.map((rid) => [rid, graph.getRegionName(rid)]);

  const edges = [];
  let skippedEdges = 0;
  for (let a = 0; a < ids.length; a += 1) {
    for (const nb of graph.getNeighbors(ids[a]) || []) {
      const b = index.get(nb);
      if (b === undefined) skippedEdges += 1;
      else if (nb > ids[a]) edges.push(a, b);
    }
  }

  const projected = projectTopDown(points, opts.gridSize);
  return {
    available: true,
    layout: LAYOUT,
    grid: { width: projected.width, height: projected.height },
    secClasses: [...GALAXY_SEC_CLASSES],
    systems: { count: ids.length, id: ids, x: Array.from(projected.x), y: Array.from(projected.y), sec, cls,
      region: regionOf.map((rid) => regionIndex.get(rid)), name },
    regions,
    edges,
    stats: { systems: ids.length, edges: edges.length / 2, skippedNoPosition, skippedEdges },
  };
}

module.exports = { GALAXY_SEC_CLASSES, LAYOUT, buildGalaxyStatic };
