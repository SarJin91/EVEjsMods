"use strict";

const MAX_ISK = 1e15;
const HOME_POOL = "HOME_POOL";
const POOL_ROLE = "garrison";
const IDLE = "IDLE";
const ACTIVE = "ACTIVE";
const RAID = "raid";

const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const emptyPlan = () => ({ intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 } });

function homeYieldOf(u, E) {
  const none = { iskDaily: 0, unitsPerPeriod: 0, homeSystems: 0, notes: [] };
  if (!E || !u || u.mode !== "ready") return none;
  const captured = Array.isArray(u.captured) ? u.captured.length : 0;
  const homeSystems = Math.max(0, count(u.controlledCount) - captured);
  const base = count(E.baseUnitsPerPeriod);
  if (u.capturedTruncated === true) {
    return { ...none, unitsPerPeriod: base, homeSystems, notes: ["INVADER_YIELD_TRUNCATED"] };
  }
  return { iskDaily: Math.min(MAX_ISK, homeSystems * count(E.iskPerHomeSystemPerDay)),
    unitsPerPeriod: homeSystems * count(E.unitsPerHomeSystemPerPeriod) + base, homeSystems, notes: [] };
}

function poolHqOf(snapshot, E) {
  const P = E && E.homePool;
  if (!P || !snapshot || !snapshot.faction || snapshot.faction.status !== ACTIVE) return null;
  if (snapshot.doctrine && snapshot.doctrine.hive === true) return null;
  const hq = P.hqSystemId;
  return Number.isSafeInteger(hq) && hq > 0 ? hq : null;
}

const isPoolFleet = (x, hq) => x.fleetRole === POOL_ROLE && x.homeSystemId === hq;

function markHomePool(snapshot, E, pseudo) {
  const hq = poolHqOf(snapshot, E);
  if (hq === null || !Array.isArray(snapshot.fleets)) return [];
  for (const x of snapshot.fleets) {
    if (pseudo.has(x.fleetId) || x.state !== IDLE || x.systemId !== hq || !isPoolFleet(x, hq)) continue;
    pseudo.set(x.fleetId, HOME_POOL);
  }
  return [];
}

function planInvaderHomePool({ snapshot, E, params, slots, budget }) {
  const out = emptyPlan();
  const hq = poolHqOf(snapshot, E);
  if (hq === null || snapshot.fleetsTruncated === true || !Array.isArray(snapshot.fleets)) return out;
  const template = snapshot.doctrine && snapshot.doctrine.templates && snapshot.doctrine.templates[POOL_ROLE];
  if (!Array.isArray(template) || template.length === 0) return out;
  const P = E.homePool;
  const max = count(P.maxFleets);
  if (max === 0) return out;
  const have = snapshot.fleets.filter((x) => isPoolFleet(x, hq)).length;
  if (have >= max) {
    out.notes.push("INVADER_HOME_POOL_FULL");
    return out;
  }
  const room = Math.min(max - have, count(P.mobilizationsPerReview), count(slots && slots.mobilizations));
  if (room === 0) return out;
  const ships = template.reduce((s, e) => s + e.count, 0);
  const mobCost = { resourceUnits: ships * params.mobilizeResourcePerShip,
    reserveUnits: ships * params.mobilizeReservePerShip };
  const left = { resourceUnits: budget.resourceUnits, reserveUnits: budget.reserveUnits };
  const composition = template.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count }));
  for (let n = 0; n < room; n += 1) {
    if (mobCost.resourceUnits > left.resourceUnits || mobCost.reserveUnits > left.reserveUnits) {
      out.notes.push("INSUFFICIENT_RESOURCES");
      break;
    }
    left.resourceUnits -= mobCost.resourceUnits;
    left.reserveUnits -= mobCost.reserveUnits;
    out.cost.resourceUnits += mobCost.resourceUnits;
    out.cost.reserveUnits += mobCost.reserveUnits;
    out.intents.push({ type: "MOBILIZE", slot: n, role: POOL_ROLE, systemId: hq, homeSystemId: hq,
      composition: composition.map((e) => ({ ...e })), cost: { ...mobCost }, stationId: null, hulls: [],
      purpose: HOME_POOL });
  }
  if (out.intents.length > 0) out.notes.unshift(`INVADER_HOME_POOL:${have + out.intents.length}`);
  return out;
}

const raidsOf = (E) => (E && E.raids ? E.raids : null);

function invaderRaidAnchorsOf(footholds, E) {
  if (!raidsOf(E) || !Array.isArray(footholds)) return [];
  return [...new Set(footholds.filter((fh) => fh && fh.home !== true && Number.isSafeInteger(fh.systemId))
    .map((fh) => fh.systemId))].sort((a, b) => a - b);
}

function invaderDoctrineOverlay(doctrine, E) {
  if (!doctrine || !raidsOf(E)) return doctrine;
  const types = Array.isArray(doctrine.operationTypes) ? doctrine.operationTypes : [];
  return Object.freeze({ ...doctrine,
    operationTypes: Object.freeze(types.includes(RAID) ? [...types] : [...types, RAID]), raidsBeyondTheatre: true });
}

function invaderEntryFronts(entryFronts, E) {
  const R = raidsOf(E);
  return R && count(R.maxActiveFronts) > 0 ? R.maxActiveFronts : entryFronts;
}

function invaderRaidNotes(snapshot, E) {
  if (!raidsOf(E) || !snapshot || (snapshot.doctrine && snapshot.doctrine.hive === true)) return [];
  return invaderRaidAnchorsOf(snapshot.footholds || [], E).length === 0 ? ["INVADER_RAIDS_NO_FOOTHOLDS"] : [];
}

module.exports = { homeYieldOf, markHomePool, planInvaderHomePool, HOME_POOL, invaderRaidAnchorsOf,
  invaderDoctrineOverlay, invaderEntryFronts, invaderRaidNotes };
