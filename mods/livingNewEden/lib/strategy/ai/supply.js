"use strict";

const { bfs } = require("./bfs");

const ACTIVE = "ACTIVE";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const CLAIM_FRONT_STATES = Object.freeze(["CONTESTED", "INVASION"]);
const RAID_OPERATION_TYPE = "raid";

function kindsByType(kinds) {
  const map = new Map();
  for (const k of kinds) {
    if (!map.has(k.operationType)) map.set(k.operationType, []);
    map.get(k.operationType).push(k);
  }
  return map;
}

function mergeMin(a, b) {
  const out = new Map(a);
  for (const [id, jumps] of b) {
    const prev = out.get(id);
    if (prev === undefined || jumps < prev) out.set(id, jumps);
  }
  return out;
}

function controllersOf(snapshot) {
  return new Map(snapshot.systems.map((s) => [s.systemId, s.controllerFactionId]));
}

function evaluateSupplyAndFronts(snapshot, params) {
  const f = snapshot.factionId;
  const controllers = controllersOf(snapshot);
  const own = (id) => controllers.get(id) === f;
  const stationSystems = snapshot.stationsMode === "ready"
    ? [...new Set(snapshot.stations.map((s) => s.systemId))].sort((a, b) => a - b) : [];
  const home = snapshot.faction.homeSystemId;
  const footholds = Array.isArray(snapshot.footholds) ? snapshot.footholds : [];
  const footholdSystems = footholds.map((fh) => fh.systemId);
  const bases = [...new Set([...stationSystems, ...footholdSystems, ...(home === null ? [] : [home])])].sort((a, b) => a - b);
  const maxSystems = params.maxBfsSystems;
  const chainJumps = snapshot.doctrine.hive === true ? 0 : params.supplyChainJumps;
  const chain = bfs(bases, snapshot.neighbors, { maxJumps: chainJumps, maxSystems, through: own });
  const anchors = [...chain.entries()].filter(([id, jumps]) => jumps === 0 || own(id)).map(([id]) => id)
    .sort((a, b) => a - b);
  const reachJumps = Math.max(0, Math.min(snapshot.doctrine.reachJumps, params.maxReachJumps, params.routeMaxJumps));
  const b = snapshot.border;
  const border = b && b.mode === "ready" && b.reach instanceof Map ? b.reach : new Map();
  const fromAnchors = bfs(anchors, snapshot.neighbors, { maxJumps: reachJumps, maxSystems });
  const reach = border.size > 0 ? mergeMin(fromAnchors, border) : fromAnchors;
  const captureJumps = Math.max(0, Math.min(params.captureRangeFromStationJumps, params.routeMaxJumps));
  const anchorsOfCapture = snapshot.stationsMode === "ready" && Array.isArray(snapshot.captureAnchors)
    ? snapshot.captureAnchors : stationSystems;
  const fromStations = anchorsOfCapture.length === 0 ? new Map()
    : bfs(anchorsOfCapture, snapshot.neighbors, { maxJumps: captureJumps, maxSystems });
  let captureReach = b && b.captures === true && border.size > 0 && snapshot.stationsMode === "ready"
    ? mergeMin(fromStations, border) : fromStations;
  const capturesStations = snapshot.doctrine.capturesStations !== false;
  if (!capturesStations && footholds.length > 0) {
    const footholdGroups = footholds.map((fh) => ({
      starts: [fh.systemId],
      jumps: Math.min(fh.jumps, params.routeMaxJumps),
    }));
    const fromFootholds = footholdGroups.reduce((acc, group) => {
      const bfsResult = bfs(group.starts, snapshot.neighbors, { maxJumps: group.jumps, maxSystems });
      return mergeMin(acc, bfsResult);
    }, new Map());
    captureReach = mergeMin(captureReach, fromFootholds);
  }

  const byType = kindsByType(params.kinds);
  const fronts = new Set();
  for (const op of snapshot.operations) {
    if (!OPEN_OPERATION_STATES.includes(op.state)) continue;
    const kinds = byType.get(op.operationType) || [];
    if (kinds.some((k) => k.opensFront === true)) fronts.add(op.targetSystemId);
  }
  const grace = Number.isFinite(params.claimFrontGraceMs) ? params.claimFrontGraceMs : 0;
  for (const o of snapshot.occupations || []) {
    if (o.occupier !== f || !CLAIM_FRONT_STATES.includes(o.state)) continue;
    if (Number.isSafeInteger(o.phaseDueAt) && snapshot.at <= o.phaseDueAt + grace) fronts.add(o.systemId);
  }
  const sg = snapshot.siege;
  if (sg && Array.isArray(sg.attacking)) for (const a of sg.attacking) fronts.add(a.systemId);
  const frontTargets = [...fronts].sort((a, b) => a - b);
  const frontLimit = Math.max(0, Math.min(snapshot.faction.frontLimit, snapshot.entry.maxActiveFronts,
    params.frontLimitCap));
  const canOpenFront = frontTargets.length < frontLimit && snapshot.faction.status === ACTIVE && home !== null
    && snapshot.operationsTruncated !== true;

  const capturedCount = Array.isArray(snapshot.capturedIds) ? snapshot.capturedIds.length : null;
  const ownClaims = (snapshot.occupations || []).filter((o) => o.occupier === f
    && CLAIM_FRONT_STATES.includes(o.state) && o.homeOwn !== true).length;
  const captureRoomKnown = snapshot.territoryTruncated !== true;
  const cap = params.maxCapturedSystemsPerFaction;
  const captureRoom = cap === undefined ? null : (captureRoomKnown ? Math.max(0, cap - (capturedCount || 0) - ownClaims) : 0);
  const raidFronts = params.raidFrontLimitEnabled === true
    ? { raidFrontTargets: [...new Set(snapshot.operations.filter((op) => OPEN_OPERATION_STATES.includes(op.state)
      && op.operationType === RAID_OPERATION_TYPE).map((op) => op.targetSystemId))].sort((a, b) => a - b) }
    : {};

  return {
    bases, anchors, stationSystems, reach, captureReach, frontTargets, frontCount: frontTargets.length, frontLimit,
    canOpenFront, reachJumps, captureJumps, border, borderCount: border.size,
    affordable: { resourceUnits: snapshot.faction.resourceUnits, reserveUnits: snapshot.faction.reserveUnits },
    footholds: footholds.length,
    footholdSystems,
    capturedCount, ownClaims, captureRoomKnown, captureRoom,
    ...raidFronts
  };
}

module.exports = { evaluateSupplyAndFronts, kindsByType, controllersOf, mergeMin };
