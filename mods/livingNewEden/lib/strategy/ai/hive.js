"use strict";

const { liveCombatFleets } = require("./operations");

const ACTIVE = "ACTIVE";
const READY = "ready";
const HIVE_ROLE = "patrol";
const PERMILLE = 1000;

const none = () => ({ intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 } });

function hiveFleetTarget(nodes, controlled, homeSystems, P) {
  const held = homeSystems > 0 ? Math.min(PERMILLE, Math.floor((controlled * PERMILLE) / homeSystems)) : 0;
  return Math.min(P.maxFleets, Math.ceil((nodes * P.fleetsPerNode * held) / PERMILLE));
}

function planHiveBrood({ snapshot, params, slots, budget, mobilized }) {
  const out = none();
  const P = params && params.hive;
  const d = snapshot && snapshot.doctrine;
  if (!P || !d || d.hive !== true) return out;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out;
  const template = d.templates && d.templates[HIVE_ROLE];
  if (!Array.isArray(template) || template.length === 0) return out;
  const u = snapshot.upkeep;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true || !u || u.mode !== READY) {
    out.notes.push("HIVE_SKIPPED");
    return out;
  }
  const nodes = [...new Set((snapshot.footholds || []).map((x) => x.systemId).filter(Number.isSafeInteger))];
  const homeSystems = snapshot.hive && Number.isSafeInteger(snapshot.hive.homeSystems) ? snapshot.hive.homeSystems : 0;
  const controlled = Number.isSafeInteger(u.controlledCount) ? u.controlledCount : 0;
  const cap = Number.isSafeInteger(params.maxFleetsPerFaction) ? Math.min(P.maxFleets, params.maxFleetsPerFaction)
    : P.maxFleets;
  const target = hiveFleetTarget(nodes.length, controlled, homeSystems, { ...P, maxFleets: cap });
  const have = liveCombatFleets(snapshot.fleets) + (Number.isSafeInteger(mobilized) ? mobilized : 0);
  const room = Math.min(target - have, slots && Number.isSafeInteger(slots.mobilizations) ? slots.mobilizations : 0);
  if (!(room > 0) || nodes.length === 0) return out;

  const count = new Map(nodes.map((id) => [id, 0]));
  for (const f of snapshot.fleets) if (count.has(f.homeSystemId)) count.set(f.homeSystemId, count.get(f.homeSystemId) + 1);
  const ships = template.reduce((s, e) => s + e.count, 0);
  const mobCost = { resourceUnits: ships * params.mobilizeResourcePerShip,
    reserveUnits: ships * params.mobilizeReservePerShip };
  const left = { resourceUnits: budget.resourceUnits, reserveUnits: budget.reserveUnits };
  const composition = template.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count }));
  let slot = 0;
  for (let n = 0; n < room; n += 1) {
    if (mobCost.resourceUnits > left.resourceUnits || mobCost.reserveUnits > left.reserveUnits) {
      out.notes.push("INSUFFICIENT_RESOURCES");
      break;
    }
    const node = nodes.reduce((best, id) => (best === null || count.get(id) < count.get(best)
      || (count.get(id) === count.get(best) && id < best) ? id : best), null);
    count.set(node, count.get(node) + 1);
    left.resourceUnits -= mobCost.resourceUnits;
    left.reserveUnits -= mobCost.reserveUnits;
    out.cost.resourceUnits += mobCost.resourceUnits;
    out.cost.reserveUnits += mobCost.reserveUnits;
    out.intents.push({ type: "MOBILIZE", slot: slot++, role: HIVE_ROLE, systemId: node, homeSystemId: node,
      composition: composition.map((e) => ({ ...e })), cost: { ...mobCost }, stationId: null, hulls: [] });
  }
  return out;
}

module.exports = { planHiveBrood, hiveFleetTarget, HIVE_ROLE };
