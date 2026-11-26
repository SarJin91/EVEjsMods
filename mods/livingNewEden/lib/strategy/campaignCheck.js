"use strict";

const NULLSEC = "nullsec";

function refusal(reason, systemId, detail) {
  return Object.freeze({ ok: false, reason, ...(systemId === undefined ? {} : { systemId }),
    ...(detail === undefined ? {} : { detail }) });
}

function check(campaign, registry, graph, maxJumps) {
  for (const factionId of [campaign.ownerFactionId, ...campaign.defenders.map((d) => d.factionId)]) {
    if (typeof registry.isActive === "function" && !registry.isActive(factionId)) {
      return refusal("CAMPAIGN_FACTION_INACTIVE", undefined, `faction ${factionId}`);
    }
  }
  const theatre = [...campaign.systemIds].sort((a, b) => a - b);
  for (const systemId of theatre) {
    if (!graph.hasSystem(systemId)) return refusal("CAMPAIGN_SYSTEM_UNKNOWN", systemId);
    const vertex = graph.getSystem(systemId);
    if (vertex.secClass !== NULLSEC) return refusal("CAMPAIGN_NOT_NULLSEC", systemId, vertex.secClass);
    if (vertex.regionId !== campaign.regionId) {
      return refusal("CAMPAIGN_REGION_MISMATCH", systemId, String(vertex.regionId));
    }
  }
  const inConstellations = new Set();
  for (const constellationId of campaign.constellationIds) {
    for (const systemId of graph.getSystemsInConstellation(constellationId)) inConstellations.add(systemId);
  }
  const fromGraph = [...inConstellations].sort((a, b) => a - b);
  const length = Math.max(fromGraph.length, theatre.length);
  for (let i = 0; i < length; i += 1) {
    if (fromGraph[i] !== theatre[i]) {
      const drift = fromGraph[i] === undefined ? theatre[i]
        : (theatre[i] === undefined ? fromGraph[i] : Math.min(fromGraph[i], theatre[i]));
      return refusal("CAMPAIGN_CONSTELLATION_DRIFT", drift);
    }
  }

  const inTheatre = new Set(theatre);
  const dist = new Map([[campaign.baseSystemId, 0]]);
  const queue = [campaign.baseSystemId];
  let eccentricity = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    const d = dist.get(at);
    if (d > eccentricity) eccentricity = d;
    for (const next of graph.getNeighbors(at) || []) {
      if (!inTheatre.has(next) || dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  const unreached = theatre.find((systemId) => !dist.has(systemId));
  if (unreached !== undefined) return refusal("CAMPAIGN_DISCONNECTED", unreached);

  const defenderJumps = {};
  for (const defender of campaign.defenders) {
    const route = typeof graph.findRoute === "function"
      ? graph.findRoute(defender.stagingSystemId, defender.entrySystemId, { maxJumps })
      : { ok: false, reason: "FIND_ROUTE_UNAVAILABLE" };
    if (!route || route.ok !== true) {
      return refusal("CAMPAIGN_DEFENDER_UNREACHABLE", defender.stagingSystemId,
        `faction ${defender.factionId}: ${(route && route.reason) || "no_result"}`);
    }
    defenderJumps[defender.factionId] = route.jumps;
  }

  for (const factionId of [campaign.ownerFactionId, ...campaign.defenders.map((d) => d.factionId)]) {
    const faction = registry.getFaction(factionId);
    if (!faction) return refusal("FACTION_SYSTEM_UNKNOWN", undefined, `faction ${factionId} not in registry`);
    for (const systemId of [faction.hqSystemId, ...faction.startStations.map((s) => s.systemId)]) {
      if (!graph.hasSystem(systemId)) return refusal("FACTION_SYSTEM_UNKNOWN", systemId, `faction ${factionId}`);
    }
  }
  return Object.freeze({ ok: true, systems: theatre.length, eccentricity,
    defenderJumps: Object.freeze(defenderJumps) });
}

function validateCampaign(campaign, registry, graph, opts) {
  try {
    if (!campaign || !registry || !graph || typeof graph.hasSystem !== "function") {
      return refusal("CAMPAIGN_CHECK_INVALID", undefined, "campaign, registry and graph required");
    }
    const maxJumps = opts && Number.isSafeInteger(opts.maxJumps) && opts.maxJumps >= 0 ? opts.maxJumps : undefined;
    if (maxJumps === undefined) return refusal("CAMPAIGN_CHECK_INVALID", undefined, "opts.maxJumps");
    return check(campaign, registry, graph, maxJumps);
  } catch (err) {
    return refusal("CAMPAIGN_CHECK_FAILED", undefined, String((err && err.message) || err));
  }
}

module.exports = { validateCampaign };
