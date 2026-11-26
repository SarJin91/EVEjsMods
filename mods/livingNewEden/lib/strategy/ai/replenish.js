"use strict";

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const EXEMPT_ROLES = Object.freeze(["mining", "logistics"]);

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function countsOf(list) {
  if (!Array.isArray(list)) return null;
  const out = {};
  for (const e of list) {
    if (e && typeof e.hullGroup === "string" && Number.isSafeInteger(e.count) && e.count > 0) {
      out[e.hullGroup] = (out[e.hullGroup] || 0) + e.count;
    }
  }
  return out;
}

function fleetDeficit(fleet, template) {
  const have = countsOf(fleet && fleet.composition);
  const want = countsOf(template);
  if (!have || !want) return {};
  const out = {};
  for (const g of Object.keys(want)) {
    const d = want[g] - (have[g] || 0);
    if (d > 0) out[g] = d;
  }
  return out;
}

function isReplenishedRole(snapshot, role) {
  const t = snapshot.doctrine && snapshot.doctrine.templates && snapshot.doctrine.templates[role];
  return !EXEMPT_ROLES.includes(role) && Array.isArray(t) && t.length > 0;
}

function cut(add, n) {
  const out = [];
  let left = n;
  for (const a of add) {
    if (left <= 0) break;
    const c = Math.min(a.count, left);
    out.push({ hullGroup: a.hullGroup, count: c });
    left -= c;
  }
  return out;
}

const shipsOf = (add) => add.reduce((n, a) => n + a.count, 0);

function planReplenish(snapshot, supply, params, ledger) {
  const cost = { resourceUnits: 0, reserveUnits: 0 };
  const R = params.replenish;
  const PP = params.production;
  const pr = snapshot.production;
  const none = () => ({ intents: [], notes: [], cost, fleetIds: [] });
  if (!R || !PP || !ledger || typeof ledger.available !== "function") return none();
  if (snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== "ready") return none();
  if (!pr || pr.mode !== "ready" || pr.truncated === true || snapshot.fleetsTruncated === true) return none();
  const perR = params.mobilizeResourcePerShip;
  const perV = params.mobilizeReservePerShip;
  const intents = [];
  const notes = [];
  const fleetIds = [];
  const candidates = snapshot.fleets.filter((x) => x.state === IDLE && x.refitPending !== true && !x.operationId
    && isReplenishedRole(snapshot, x.fleetRole) && Array.isArray(x.composition))
    .sort((a, b) => byId(a.fleetId, b.fleetId));
  for (const fleet of candidates) {
    const stations = pr.stations.filter((s) => s.systemId === fleet.systemId)
      .sort((a, b) => byId(a.stationId, b.stationId));
    if (stations.length === 0) continue;
    const missing = fleetDeficit(fleet, snapshot.doctrine.templates[fleet.fleetRole]);
    const groups = PP.hullGroups.filter((g) => missing[g] > 0);
    if (groups.length === 0) continue;
    if (intents.length >= R.maxReplenishPerReview) {
      notes.push("REPLENISH_LIMIT");
      break;
    }
    const free = R.freeHulls === true && typeof ledger.needs === "function" && ledger.needs(fleet.fleetRole) === false;
    let pick = free ? { station: stations[0], score: 0 } : null;
    for (const s of free ? [] : stations) {
      const score = groups.reduce((n, g) => n + Math.min(missing[g], ledger.available(s.stationId, g)), 0);
      if (score > 0 && (pick === null || score > pick.score)) pick = { station: s, score };
    }
    if (!pick) {
      notes.push("REPLENISH_NO_STOCK");
      continue;
    }
    let add = groups.map((g) => ({ hullGroup: g,
      count: free ? missing[g] : Math.min(missing[g], ledger.available(pick.station.stationId, g)) }))
      .filter((a) => a.count > 0);
    const room = Math.max(0, R.maxShipsPerFleet - fleet.shipCount);
    const leftR = supply.affordable.resourceUnits - cost.resourceUnits;
    const leftV = supply.affordable.reserveUnits - cost.reserveUnits;
    const byBudget = Math.min(perR > 0 ? Math.floor(leftR / perR) : Number.MAX_SAFE_INTEGER,
      perV > 0 ? Math.floor(leftV / perV) : Number.MAX_SAFE_INTEGER);
    const n = Math.min(shipsOf(add), room, byBudget);
    if (n <= 0) {
      notes.push(room <= 0 ? "REPLENISH_SHIP_LIMIT" : "REPLENISH_INSUFFICIENT_RESOURCES");
      continue;
    }
    add = cut(add, n);
    const unit = { resourceUnits: n * perR, reserveUnits: n * perV };
    cost.resourceUnits += unit.resourceUnits;
    cost.reserveUnits += unit.reserveUnits;
    if (!free) ledger.take(pick.station.stationId, add.map((a) => ({ itemKey: `group:${a.hullGroup}`, count: a.count })));
    fleetIds.push(fleet.fleetId);
    notes.push("REPLENISH");
    intents.push({ type: "REPLENISH", slot: intents.length, fleetId: fleet.fleetId, expectedVersion: fleet.version,
      stationId: pick.station.stationId, systemId: fleet.systemId, add, cost: unit,
      ...(free ? { freeHulls: true } : {}) });
  }
  return { intents, notes, cost, fleetIds };
}

module.exports = { planReplenish, fleetDeficit, isReplenishedRole, EXEMPT_ROLES };
