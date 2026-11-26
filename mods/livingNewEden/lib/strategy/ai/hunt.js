"use strict";

const { bfs } = require("./bfs");
const { fitIskOf } = require("./warChest");
const { planCapitalAttach, byItemKey } = require("./capitalAttach");
const { huntLevelOf } = require("./capitalLevel");

const IDLE = "IDLE";
const ACTIVE = "ACTIVE";
const HUNTER_ROLE = "hunter";
const HUNT_KIND = "hunt";

const byStation = (home) => (a, b) => (a.systemId === home ? 0 : 1) - (b.systemId === home ? 0 : 1)
  || a.systemId - b.systemId || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0);

function planHunts({ snapshot, params, budget, ledger, war }) {
  const intents = [];
  const notes = [];
  const cost = { resourceUnits: 0, reserveUnits: 0 };
  const out = () => ({ intents, notes, cost });
  const P = params && params.hunt;
  if (!P || P.enabled !== true) return out();
  if (snapshot.huntReady !== true) return out();
  if (!snapshot.doctrine || snapshot.doctrine.fieldsHunters !== true) return out();
  if (snapshot.faction.status !== ACTIVE || snapshot.fleetsTruncated === true) {
    notes.push("HUNT_SKIPPED");
    return out();
  }
  const home = snapshot.faction.homeSystemId;
  const stations = [...(snapshot.stations || [])].sort(byStation(home));
  const hunters = (snapshot.fleets || []).filter((f) => f.fleetRole === HUNTER_ROLE);
  let slot = 0;
  const own = new Set((snapshot.systems || []).filter((s) => s.controllerFactionId === snapshot.factionId)
    .map((s) => s.systemId));
  const core = new Set(snapshot.coreOwners instanceof Map ? [...snapshot.coreOwners.keys()] : []);
  const reach = stations.length > 0 ? bfs(stations.map((s) => s.systemId), snapshot.neighbors,
    { maxJumps: P.strikeMaxJumps, maxSystems: P.maxBfsSystems }) : new Map();
  const candidates = [...reach.keys()].filter((id) => own.has(id) && id !== home && !core.has(id))
    .sort((a, b) => a - b);

  const template = Array.isArray(snapshot.doctrine.hunterTemplate) ? snapshot.doctrine.hunterTemplate : [];
  if (hunters.length < P.maxHuntersPerFaction && template.length > 0) {
    const ships = template.reduce((s, e) => s + e.count, 0);
    const mobCost = { resourceUnits: ships * params.mobilizeResourcePerShip,
      reserveUnits: ships * params.mobilizeReservePerShip };
    let st = null;
    let hulls = [];
    let cap = null;
    const isk = war && Number.isSafeInteger(budget.isk) ? budget.isk : null;
    const fit = isk !== null ? fitIskOf(template, war.valueByGroup, war.fitPermille) : 0;
    if (mobCost.resourceUnits > budget.resourceUnits || mobCost.reserveUnits > budget.reserveUnits) {
      notes.push("HUNT_INSUFFICIENT_RESOURCES");
    } else if (isk !== null && fit > isk) {
      notes.push("HUNT_WAR_CHEST_SHORT");
    } else if (stations.length === 0) {
      notes.push("HUNT_NO_STATION");
    } else if (ledger && ledger.needs(HUNTER_ROLE)) {
      const inProduction = (snapshot.production && snapshot.production.inProduction) || {};
      const r = ledger.pickWithNote(template, stations, inProduction);
      if (r.picked) {
        ledger.take(r.picked.stationId, r.picked.hulls);
        st = { systemId: r.picked.systemId, stationId: r.picked.stationId };
        hulls = r.picked.hulls;
        if (params.capitalAttach) {
          const level = params.capitalLevel ? huntLevelOf(snapshot, params, candidates, template).level : undefined;
          cap = planCapitalAttach({ template, role: HUNTER_ROLE, stationId: st.stationId, lg: ledger,
            capitalClasses: snapshot.capitalClasses, attach: params.capitalAttach,
            iskLeft: isk !== null ? isk - fit : null, war, level });
          if (cap.items.length > 0) {
            ledger.take(st.stationId, cap.items);
            hulls = [...hulls, ...cap.items].sort(byItemKey);
          }
          if (cap.note) notes.push(cap.note);
        }
      } else notes.push(r.note);
    } else st = stations[0];
    if (st) {
      const capFit = cap ? cap.fitIsk : 0;
      cost.resourceUnits += mobCost.resourceUnits;
      cost.reserveUnits += mobCost.reserveUnits;
      if (isk !== null) cost.isk = fit + capFit;
      intents.push({ type: "MOBILIZE", slot: slot++, role: HUNTER_ROLE, systemId: st.systemId,
        homeSystemId: st.systemId, composition: [...template.map((e) => ({ hullGroup: e.hullGroup, typeId: null,
          count: e.count })), ...(cap ? cap.entries.map((e) => ({ ...e })) : [])], cost: mobCost,
        stationId: st.stationId, hulls, ...(isk !== null ? { warIsk: fit + capFit } : {}),
        ...(cap && cap.gated === true ? { capitalGated: true } : {}) });
    }
  }

  const idle = hunters.filter((f) => f.state === IDLE && f.operationId === null && f.refitPending !== true
    && Number.isSafeInteger(f.systemId))
    .sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
  if (idle.length === 0) return out();
  const taken = new Set();
  let noTarget = false;
  for (const h of idle) {
    const free = (id) => !taken.has(id) && id !== h.systemId;
    const target = candidates.find((id) => id > h.systemId && free(id)) ?? candidates.find(free);
    if (target === undefined) {
      noTarget = true;
      continue;
    }
    taken.add(target);
    intents.push({ type: "LAUNCH", slot: slot++, kind: HUNT_KIND, target: { kind: "system", systemId: target, ref: null },
      originSystemId: h.systemId, fleets: [{ fleetId: h.fleetId, expectedVersion: h.version }], mobilize: [],
      dueAt: snapshot.at + P.dwellMs });
  }
  if (noTarget) notes.push("HUNT_NO_PATROL_TARGET");
  return out();
}

module.exports = { planHunts, HUNTER_ROLE };
