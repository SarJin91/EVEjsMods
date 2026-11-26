"use strict";

const { bfs } = require("./bfs");
const { fleetDeficit, isReplenishedRole } = require("./replenish");

const REPLENISH_RETURN_PURPOSE = "REPLENISH_RETURN";
const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const READY = "ready";

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function planReplenishReturns(snapshot, params, ledger, used) {
  const none = () => ({ intents: [], notes: [] });
  const RR = params.replenishReturn;
  const R = params.replenish;
  const PP = params.production;
  const pr = snapshot.production;
  if (!RR || !R || !PP || !ledger || typeof ledger.available !== "function") return none();
  if (RR.maxPerReview === 0 || params.returnKindEnabled === false) return none();
  if (!Array.isArray(params.returnFleetRoles) || params.returnFleetRoles.length === 0) return none();
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== READY) return none();
  if (!pr || pr.mode !== READY || pr.truncated === true || !Array.isArray(pr.stations)) return none();
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return none();
  if (snapshot.doctrine && snapshot.doctrine.hullsRequired === false) return none();

  const promised = new Map();
  const avail = (stationId, g) => Math.max(0,
    ledger.available(stationId, g) - (promised.get(`${stationId}|${g}`) || 0));
  const scoreOf = (stationId, groups, missing) => groups.reduce((n, g) => n + Math.min(missing[g], avail(stationId, g)), 0);
  const intents = [];
  const notes = [];
  let searches = 0;
  const candidates = snapshot.fleets.filter((x) => x.state === IDLE && !x.operationId && x.refitPending !== true
    && !used.has(x.fleetId) && params.returnFleetRoles.includes(x.fleetRole) && isReplenishedRole(snapshot, x.fleetRole)
    && Array.isArray(x.composition) && x.shipCount < R.maxShipsPerFleet)
    .sort((a, b) => byId(a.fleetId, b.fleetId));
  for (const fleet of candidates) {
    const template = snapshot.doctrine.templates[fleet.fleetRole];
    const missing = fleetDeficit(fleet, template);
    const groups = PP.hullGroups.filter((g) => missing[g] > 0);
    if (groups.length === 0) continue;
    const missingTotal = Object.keys(missing).reduce((n, g) => n + missing[g], 0);
    const templateTotal = template.reduce((n, e) => n + (Number.isSafeInteger(e && e.count) ? e.count : 0), 0);
    if (missingTotal * 1000 < RR.minMissingPermille * templateTotal) continue;
    if (!Number.isSafeInteger(fleet.updatedAt)) {
      notes.push("RETURN_NO_IDLE_SINCE");
      continue;
    }
    if (snapshot.at - fleet.updatedAt < params.returnAfterIdleMs) continue;
    if (pr.stations.some((s) => s.systemId === fleet.systemId && scoreOf(s.stationId, groups, missing) > 0)) continue;
    if (intents.length >= RR.maxPerReview) {
      notes.push("REPLENISH_RETURN_LIMIT");
      break;
    }
    if (searches >= RR.maxSearches) {
      notes.push("REPLENISH_RETURN_SEARCH_LIMIT");
      break;
    }
    searches += 1;
    const dist = bfs([fleet.systemId], snapshot.neighbors, { maxJumps: RR.maxJumps, maxSystems: params.maxBfsSystems });
    let pick = null;
    for (const s of pr.stations) {
      if (s.systemId === fleet.systemId || !dist.has(s.systemId)) continue;
      const score = scoreOf(s.stationId, groups, missing);
      if (score <= 0) continue;
      const jumps = dist.get(s.systemId);
      if (pick === null || score > pick.score || (score === pick.score && (jumps < pick.jumps
        || (jumps === pick.jumps && byId(s.stationId, pick.station.stationId) < 0)))) {
        pick = { station: s, score, jumps };
      }
    }
    if (pick === null) {
      notes.push("REPLENISH_RETURN_NO_STOCK");
      continue;
    }
    intents.push({ type: "LAUNCH", kind: "return", target: { kind: "system", systemId: pick.station.systemId, ref: null },
      originSystemId: fleet.systemId, fleets: [{ fleetId: fleet.fleetId, expectedVersion: fleet.version }], mobilize: [],
      dueAt: snapshot.at + params.returnWindowMs, purpose: REPLENISH_RETURN_PURPOSE });
    used.add(fleet.fleetId);
    for (const g of groups) {
      const take = Math.min(missing[g], avail(pick.station.stationId, g));
      if (take > 0) promised.set(`${pick.station.stationId}|${g}`, (promised.get(`${pick.station.stationId}|${g}`) || 0) + take);
    }
    notes.push("REPLENISH_RETURN");
  }
  return { intents, notes: [...new Set(notes)].sort() };
}

function relabelNoStock(notes, params) {
  if (!params || !params.replenishReturn) return notes;
  return notes.map((n) => (n === "REPLENISH_NO_STOCK" ? "REPLENISH_NO_STOCK_LOCAL" : n));
}

module.exports = { planReplenishReturns, relabelNoStock, REPLENISH_RETURN_PURPOSE };
