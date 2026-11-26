"use strict";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function regionsOf(observed, graph, maxRegions) {
  const bySystems = new Map();
  for (const id of Array.isArray(observed) ? observed : []) {
    const sys = graph && typeof graph.getSystem === "function" ? graph.getSystem(id) : null;
    if (!sys || !isId(sys.regionId)) continue;
    bySystems.set(sys.regionId, (bySystems.get(sys.regionId) || 0) + 1);
  }
  return [...bySystems.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, maxRegions).map(([r]) => r);
}

function sampleActivityInTx(tx, spec, repo) {
  const regions = regionsOf(spec.observed, spec.graph, spec.maxRegions);
  for (const regionId of regions) {
    const r = repo.upsertActivityInTx(tx, { bucketAt: spec.bucketAt, regionId, add: 1 });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "NO_RESULT", detail: r && r.detail };
  }
  return { ok: true, regions: regions.length };
}

module.exports = { sampleActivityInTx, regionsOf };
