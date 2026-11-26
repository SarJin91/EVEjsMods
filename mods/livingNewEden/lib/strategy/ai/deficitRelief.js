"use strict";

const RELIEF_ROLES = Object.freeze(["invasion", "patrol"]);
const RELIEF_REASON = "UPKEEP";
const IDLE = "IDLE";
const ACTIVE = "ACTIVE";
const READY = "ready";
const HULLS_REQUIRED = "required";

const shipsOf = (f) => (Number.isSafeInteger(f.shipCount) && f.shipCount > 0 ? f.shipCount : 0);
const byShipsThenId = (a, b) => shipsOf(a) - shipsOf(b)
  || (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function returnHullsOf(snapshot, params) {
  const pr = params.production;
  return Boolean(pr) && pr.mobilizeHulls === HULLS_REQUIRED && Boolean(snapshot.production)
    && snapshot.production.mode === READY && Boolean(snapshot.doctrine) && snapshot.doctrine.hullsRequired !== false;
}

function planDeficitRelief(snapshot, supply, params, relief, used) {
  const none = { intents: [], notes: [] };
  if (!relief || !Number.isSafeInteger(relief.ships) || relief.ships <= 0) return none;
  const U = params.upkeep;
  const max = U && Number.isSafeInteger(U.maxDisbandsPerReview) ? U.maxDisbandsPerReview : 0;
  if (max <= 0) return none;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== READY) return none;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return none;
  const stationSystems = supply && Array.isArray(supply.stationSystems) ? supply.stationSystems : [];
  const stations = Array.isArray(snapshot.stations) ? snapshot.stations : [];
  if (stationSystems.length === 0 || stations.length === 0) return none;
  const pool = (snapshot.fleets || []).filter((f) => f.state === IDLE
    && (f.operationId === null || f.operationId === undefined) && f.refitPending !== true
    && RELIEF_ROLES.includes(f.fleetRole) && !used.has(f.fleetId) && stationSystems.includes(f.systemId)
    && stations.some((s) => s.systemId === f.systemId)).sort(byShipsThenId);
  if (pool.length === 0) return { intents: [], notes: ["UPKEEP_DEMOBILIZE_NO_FLEET"] };
  const returnHulls = returnHullsOf(snapshot, params);
  const intents = [];
  let removed = 0;
  for (const f of pool) {
    if (removed >= relief.ships || intents.length >= max) break;
    const here = stations.find((s) => s.systemId === f.systemId);
    intents.push({ type: "DISBAND", fleetId: f.fleetId, expectedVersion: f.version, systemId: f.systemId,
      stationId: here.stationId, reason: RELIEF_REASON, returnHulls, fleetRole: f.fleetRole });
    used.add(f.fleetId);
    removed += shipsOf(f);
  }
  return { intents, notes: [`UPKEEP_DEMOBILIZE:${removed}`] };
}

module.exports = { planDeficitRelief, RELIEF_ROLES, RELIEF_REASON };
