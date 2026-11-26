"use strict";

const { bfs } = require("./bfs");
const { composeMiningFleet } = require("./industry");
const { hullsOf } = require("./hulls");
const { canMineIn, stationExemptionOf } = require("./miningControl");
const { mineralCoverOf } = require("./miningCover");
const { intelWithExtra, ttlOf } = require("./targeting");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const MINING_ROLE = "mining";
const MINING_OPERATION_TYPE = "mining";
const ORPHAN_STATES = Object.freeze(["STAGED", "PLANNED"]);
const PERMILLE = 1000;
const REQUIRED = "required";

const scoreOf = (richness, jumps, penalty) => Math.floor((richness * PERMILLE) / (PERMILLE + jumps * penalty));

function planMining(snapshot, supply, params, ledger) {
  const m = snapshot.mining;
  const P = params.mining;
  if (!m || !P) return { intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 }, fleetsWanted: 0 };
  if (m.mode !== "ready") {
    return { intents: [], notes: ["MINING_OFF"], cost: { resourceUnits: 0, reserveUnits: 0 }, fleetsWanted: 0 };
  }
  const releases = planReleases(snapshot, m, P);
  const none = (note, extra = []) => ({ intents: [...releases], notes: [...(note ? [note] : []), ...extra],
    cost: { resourceUnits: 0, reserveUnits: 0 }, fleetsWanted: 0 });
  const f = snapshot.factionId;
  if (snapshot.faction.status !== ACTIVE || snapshot.faction.homeSystemId === null) return none("MINING_INACTIVE");
  if (!snapshot.doctrine.templates || !snapshot.doctrine.templates[MINING_ROLE]) return none("MINING_NOT_IN_DOCTRINE");
  const stations = supply.stationSystems;
  if (snapshot.stationsMode !== "ready" || stations.length === 0) return none("MINING_NO_BASE");
  const maxSystems = params.maxBfsSystems;
  const neighbors = snapshot.neighbors;
  const hostile = new Set();
  const viaExtra = P.candidateIntelEnabled === true;
  if (P.avoidHostileIntel === true) {
    const src = viaExtra ? intelWithExtra(snapshot) : (snapshot.intel || []);
    for (const i of src) {
      const ttl = viaExtra ? ttlOf(i, params) : params.intelTtlMs;
      const bad = i.hostileFleets > 0 || (viaExtra && i.hostileStations > 0);
      if (bad && snapshot.at - i.observedAt <= ttl) hostile.add(i.systemId);
    }
  }
  const cooled = P.beltCooldownEnabled === true && Array.isArray(m.cooldownSystemIds)
    ? new Set(m.cooldownSystemIds) : null;
  let droppedHostile = 0;
  let droppedCooldown = 0;
  const fromStations = bfs(stations, neighbors, { maxJumps: P.maxTripJumps, maxSystems });
  const rows = new Map(snapshot.systems.map((s) => [s.systemId, s]));
  const ownStations = P.ownStationSystemsEnabled === true ? new Set(stations) : null;
  const seen = new Set();
  const candidates = (m.sites || []).filter((site) => {
    if (!(site.richnessPermille > 0) || seen.has(site.systemId) || !fromStations.has(site.systemId)) return false;
    seen.add(site.systemId);
    if (hostile.has(site.systemId)) {
      if (viaExtra) droppedHostile += 1;
      return false;
    }
    if (cooled !== null && cooled.has(site.systemId)) {
      droppedCooldown += 1;
      return false;
    }
    const s = rows.get(site.systemId);
    if (s) {
      return canMineIn(f, s, null, null, null, ownStations ? { ownStationHere: stationExemptionOf({ factionId: f,
        controllerFactionId: s.controllerFactionId, ownStationHere: ownStations.has(site.systemId),
        ownInfluence: s.ownInfluenceRaw, minInfluence: P.ownStationMinInfluence }) } : null);
    }
    return site.projected === true;
  })
    .map((s) => ({ systemId: s.systemId, richness: s.richnessPermille,
      score: scoreOf(s.richnessPermille, fromStations.get(s.systemId), P.distancePenaltyPermille) }))
    .sort((a, b) => b.score - a.score || a.systemId - b.systemId)
    .slice(0, P.maxCandidateSystems);
  const dropNotes = [...(viaExtra && droppedHostile > 0 ? ["MINING_HOSTILE_INTEL"] : []),
    ...(droppedCooldown > 0 ? ["MINING_BELT_COOLDOWN"] : [])];
  if (candidates.length === 0) return none("MINING_NO_CANDIDATE", dropNotes);
  const candidateIds = new Set(candidates.map((c) => c.systemId));

  const used = new Map((m.openByBelt || []).map((x) => [x.systemId, x.n]));
  const busy = new Set(m.busyFleetIds || []);
  const miners = snapshot.fleets.filter((x) => x.fleetRole === MINING_ROLE);
  const intents = [...releases];
  const notes = [...dropNotes];
  const cost = { resourceUnits: 0, reserveUnits: 0 };
  let slot = releases.length;

  const stationCount = Array.isArray(snapshot.stations) ? snapshot.stations.length : stations.length;
  const perStation = Number.isSafeInteger(P.fleetsPerStationPermille)
    ? Math.ceil((stationCount * P.fleetsPerStationPermille) / PERMILLE) : Number.MAX_SAFE_INTEGER;
  const desired = Math.min(P.maxFleetsPerFaction, perStation,
    Math.ceil((candidates.length * P.targetFleetsPerSystemPermille) / PERMILLE));
  let live = miners.length;
  const coverOf = P.stockCoverEnabled === true ? mineralCoverOf(snapshot, params) : null;
  const covered = coverOf !== null && coverOf.cover !== null && coverOf.cover >= P.stockCoverRebuilds;
  if (covered) notes.push(`MINING_STOCK_COVERED:${coverOf.cover}`);
  const template = snapshot.doctrine.templates && snapshot.doctrine.templates[MINING_ROLE];
  const X = params.industry;
  const hasTemplate = Array.isArray(template) && template.length > 0;
  if (covered) {
  } else if (snapshot.fleetsTruncated !== true && live < desired && hasTemplate && X && ledger
    && ledger.policy === REQUIRED) {
    const targeted = new Set();
    for (let k = 0; k < P.maxMobilizationsPerReview && live < desired; k += 1) {
      const best = candidates.find((c) => !used.has(c.systemId) && !targeted.has(c.systemId))
        || candidates.find((c) => !targeted.has(c.systemId));
      if (!best) break;
      targeted.add(best.systemId);
      const dist = bfs([best.systemId], neighbors, { maxJumps: P.maxTripJumps, maxSystems });
      let pick = null;
      for (const st of (snapshot.stations || []).filter((x) => dist.has(x.systemId))) {
        const pool = {};
        for (const g of X.miningGroups) pool[g] = ledger.available(st.stationId, g);
        const c = composeMiningFleet(pool, X);
        if (c.ships === 0 || (Number.isSafeInteger(X.maxShipsPerFleet) && c.ships > X.maxShipsPerFleet)) continue;
        const rate = X.fleetRate(c.composition);
        const jumps = dist.get(st.systemId);
        if (pick === null || rate > pick.rate || (rate === pick.rate && (jumps < pick.jumps
          || (jumps === pick.jumps && (st.systemId < pick.st.systemId
            || (st.systemId === pick.st.systemId && st.stationId < pick.st.stationId)))))) {
          pick = { st, c, rate, jumps };
        }
      }
      if (pick === null) {
        notes.push("MINING_NO_HULLS");
        continue;
      }
      const unit = { resourceUnits: pick.c.ships * params.mobilizeResourcePerShip,
        reserveUnits: pick.c.ships * params.mobilizeReservePerShip };
      if (cost.resourceUnits + unit.resourceUnits > supply.affordable.resourceUnits
        || cost.reserveUnits + unit.reserveUnits > supply.affordable.reserveUnits) {
        notes.push("MINING_INSUFFICIENT_RESOURCES");
        break;
      }
      const hulls = hullsOf(Object.keys(pick.c.paid).map((g) => ({ hullGroup: g, count: pick.c.paid[g] })));
      ledger.take(pick.st.stationId, hulls);
      cost.resourceUnits += unit.resourceUnits;
      cost.reserveUnits += unit.reserveUnits;
      live += 1;
      intents.push({ type: "MOBILIZE", slot: slot++, role: MINING_ROLE, systemId: pick.st.systemId,
        homeSystemId: pick.st.systemId,
        composition: pick.c.composition.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count })),
        cost: unit, stationId: pick.st.stationId, hulls });
    }
  } else if (snapshot.fleetsTruncated !== true && live < desired) {
    if (!Array.isArray(template) || template.length === 0) notes.push("MINING_NO_TEMPLATE");
    else {
      const ships = template.reduce((n, e) => n + e.count, 0);
      const unit = { resourceUnits: ships * params.mobilizeResourcePerShip,
        reserveUnits: ships * params.mobilizeReservePerShip };
      const targeted = new Set();
      for (let k = 0; k < P.maxMobilizationsPerReview && live < desired; k += 1) {
        if (cost.resourceUnits + unit.resourceUnits > supply.affordable.resourceUnits
          || cost.reserveUnits + unit.reserveUnits > supply.affordable.reserveUnits) {
          notes.push("MINING_INSUFFICIENT_RESOURCES");
          break;
        }
        const best = candidates.find((c) => !used.has(c.systemId) && !targeted.has(c.systemId))
          || candidates.find((c) => !targeted.has(c.systemId));
        if (!best) break;
        targeted.add(best.systemId);
        const dist = bfs([best.systemId], neighbors, { maxJumps: P.maxTripJumps, maxSystems });
        let station;
        let hulls = { stationId: null, hulls: [] };
        if (ledger && ledger.needs(MINING_ROLE)) {
          const candidates = (snapshot.stations || []).filter((x) => dist.has(x.systemId))
            .sort((a, b) => dist.get(a.systemId) - dist.get(b.systemId) || a.systemId - b.systemId
              || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));
          const inProduction = (snapshot.production && snapshot.production.inProduction) || {};
          const result = ledger.pickWithNote(template, candidates, inProduction);
          if (!result.picked) {
            notes.push(result.note);
            continue;
          }
          station = result.picked.systemId;
          hulls = { stationId: result.picked.stationId, hulls: result.picked.hulls };
          ledger.take(result.picked.stationId, result.picked.hulls);
        } else {
          station = stations.filter((id) => dist.has(id)).sort((a, b) => dist.get(a) - dist.get(b) || a - b)[0];
        }
        if (station === undefined) continue;
        cost.resourceUnits += unit.resourceUnits;
        cost.reserveUnits += unit.reserveUnits;
        live += 1;
        intents.push({ type: "MOBILIZE", slot: slot++, role: MINING_ROLE, systemId: station, homeSystemId: station,
          composition: template.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count })),
          cost: { ...unit }, stationId: hulls.stationId, hulls: hulls.hulls });
      }
    }
  }

  const free = miners.filter((x) => x.state === IDLE && x.refitPending !== true && !busy.has(x.fleetId))
    .sort((a, b) => (a.fleetId < b.fleetId ? -1 : 1));
  let dispatched = 0;
  let coverStop = false;
  for (const x of free) {
    if (dispatched >= P.maxDispatchesPerReview) break;
    if (covered && busy.size + dispatched >= P.coveredMaxOpenTrips) {
      coverStop = true;
      break;
    }
    const dist = bfs([x.systemId], neighbors, { maxJumps: P.maxTripJumps, maxSystems });
    let pick = null;
    for (const c of candidates) {
      if (!dist.has(c.systemId) || (used.get(c.systemId) || 0) >= P.maxFleetsPerSystem) continue;
      const score = scoreOf(c.richness, dist.get(c.systemId), P.distancePenaltyPermille);
      if (pick === null || score > pick.score || (score === pick.score && c.systemId < pick.systemId)) {
        pick = { systemId: c.systemId, score };
      }
    }
    if (pick === null) continue;
    used.set(pick.systemId, (used.get(pick.systemId) || 0) + 1);
    dispatched += 1;
    intents.push({ type: "MINE_DISPATCH", slot: slot++, fleetId: x.fleetId, expectedVersion: x.version,
      beltSystemId: pick.systemId });
  }
  if (free.length > 0 && dispatched === 0 && candidateIds.size > 0 && !coverStop) notes.push("MINING_NO_ROOM");
  return { intents, notes, cost, fleetsWanted: covered ? Math.min(desired, live) : desired };
}

function planReleases(snapshot, m, P) {
  const max = Math.max(0, P.maxReleasesPerReview || 0);
  if (max === 0 || snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return [];
  const miningOps = new Set((snapshot.operations || []).filter((op) => op.operationType === MINING_OPERATION_TYPE)
    .map((op) => op.operationId));
  const busy = new Set(m.busyFleetIds || []);
  return snapshot.fleets.filter((x) => x.fleetRole === MINING_ROLE && ORPHAN_STATES.includes(x.state)
    && x.operationId !== null && miningOps.has(x.operationId) && !busy.has(x.fleetId))
    .sort((a, b) => (a.fleetId < b.fleetId ? -1 : 1)).slice(0, max)
    .map((x, i) => ({ type: "MINE_RELEASE", slot: i, fleetId: x.fleetId, expectedVersion: x.version }));
}

module.exports = { planMining };
