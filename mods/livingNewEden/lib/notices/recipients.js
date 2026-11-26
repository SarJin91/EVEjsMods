"use strict";

function systemsWithin(graph, systemId, jumps) {
  const seen = new Map([[systemId, 0]]);
  if (!graph || typeof graph.getNeighbors !== "function") return seen;
  let frontier = [systemId];
  for (let d = 0; d < jumps && frontier.length > 0; d += 1) {
    const next = [];
    for (const id of frontier) {
      const neighbors = graph.getNeighbors(id) || [];
      for (const n of neighbors) {
        const nid = Number(n);
        if (seen.has(nid)) continue;
        seen.set(nid, d + 1);
        next.push(nid);
      }
    }
    frontier = next;
  }
  return seen;
}

function proximityRecipients(spec) {
  const { graph, presence, systemId, jumps, max } = spec || {};
  if (!presence || typeof presence.getStatus !== "function" || typeof presence.getSystemPresence !== "function") {
    return { ok: false, reason: "PRESENCE_UNAVAILABLE" };
  }
  const status = presence.getStatus();
  if (!status || status.available !== true) return { ok: false, reason: "PRESENCE_UNAVAILABLE" };
  if (status.stale) return { ok: false, reason: "PRESENCE_STALE" };
  if (!graph || typeof graph.getNeighbors !== "function") return { ok: false, reason: "GRAPH_NOT_READY" };

  const ids = new Set();
  for (const id of systemsWithin(graph, systemId, jumps).keys()) {
    const p = presence.getSystemPresence(id);
    const chars = p && Array.isArray(p.characters) ? p.characters : [];
    for (const c of chars) {
      const cid = Number(c && c.characterId);
      if (Number.isSafeInteger(cid) && cid > 0) ids.add(cid);
    }
  }
  const sorted = [...ids].sort((a, b) => a - b);
  const truncated = sorted.length > max;
  return { ok: true, characterIds: truncated ? sorted.slice(0, max) : sorted, truncated };
}

module.exports = { proximityRecipients, systemsWithin };
