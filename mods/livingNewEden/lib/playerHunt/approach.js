"use strict";

const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 1;

function secClassOf(graph, systemId) {
  const s = graph.getSystem(systemId);
  return s && typeof s.secClass === "string" ? s.secClass : null;
}

function approachSystems(graph, fromSystemId, opts) {
  const o = opts || {};
  if (!graph || typeof graph.getNeighbors !== "function" || typeof graph.getSystem !== "function"
    || !isPositiveId(fromSystemId) || !isCount(o.maxJumps) || !isCount(o.maxSystems)
    || !Array.isArray(o.avoidSecClasses)) return { ok: false, reason: "INVALID_ARGUMENT" };
  try {
    if (graph.getNeighbors(fromSystemId) === null) return { ok: false, reason: "UNKNOWN_SYSTEM" };
    const avoid = new Set(o.avoidSecClasses);
    if (avoid.has(secClassOf(graph, fromSystemId))) return { ok: false, reason: "TARGET_AVOIDED" };
    const seen = new Set([fromSystemId]);
    const systems = [];
    let frontier = [fromSystemId];
    for (let jumps = 1; jumps <= o.maxJumps && frontier.length > 0 && systems.length < o.maxSystems; jumps += 1) {
      const ring = [];
      for (const id of frontier) {
        for (const n of graph.getNeighbors(id) || []) {
          if (!isPositiveId(n) || seen.has(n)) continue;
          seen.add(n);
          if (graph.getNeighbors(n) === null || avoid.has(secClassOf(graph, n))) continue;
          ring.push(n);
        }
      }
      ring.sort((a, b) => a - b);
      for (const systemId of ring) {
        if (systems.length >= o.maxSystems) break;
        systems.push({ systemId, jumps });
      }
      frontier = ring;
    }
    return { ok: true, systems };
  } catch (_err) {
    return { ok: false, reason: "INVALID_ARGUMENT" };
  }
}

function orderApproachCandidates(bySystem, jumpsOf) {
  if (!(bySystem instanceof Map) || !(jumpsOf instanceof Map)) return [];
  const rows = [];
  for (const [systemId, fleets] of bySystem) {
    if (!jumpsOf.has(systemId) || !Array.isArray(fleets)) continue;
    for (const f of fleets) if (f && typeof f.fleetId === "string") rows.push({ f, jumps: jumpsOf.get(systemId) });
  }
  rows.sort((a, b) => a.jumps - b.jumps || (a.f.fleetId < b.f.fleetId ? -1 : a.f.fleetId > b.f.fleetId ? 1 : 0));
  return rows.map((r) => r.f);
}

module.exports = { approachSystems, orderApproachCandidates };
