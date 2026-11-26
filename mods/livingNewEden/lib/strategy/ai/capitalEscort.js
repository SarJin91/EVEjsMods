"use strict";

const { bfs } = require("./bfs");
const { fitIskOf } = require("./warChest");
const { eligibleClassesOf } = require("./capitalAttach");
const { strengthOf } = require("./strength");

const NOTE_NONE = "CAPITAL_ESCORT_NONE";
const NOTE_RESOURCES = "CAPITAL_ESCORT_RESOURCES";
const NOTE_ISK = "CAPITAL_ESCORT_ISK";
const CAPITAL_ESCORT_NOTE = "CAPITAL_ESCORT";

const none = (note) => ({ intent: null, note });

function escortDistOf(snapshot, params, target) {
  const E = params && params.capitalEscort;
  if (!E || typeof snapshot.neighbors !== "function") return new Map();
  return bfs([target], snapshot.neighbors, { maxJumps: E.maxJumps, maxSystems: E.maxBfsSystems });
}

const byStation = (dist) => (a, b) => dist.get(a.systemId) - dist.get(b.systemId) || a.systemId - b.systemId
  || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0);

function planCapitalEscort(a) {
  const { snapshot, params } = a;
  const attach = params && params.capitalAttach;
  if (!attach || !params.capitalEscort || !a.lg || typeof a.lg.available !== "function") return none(null);
  const capitalClasses = snapshot.capitalClasses;
  const classes = eligibleClassesOf({ template: [], capitalClasses, attach, level: a.level });
  if (classes.length === 0) return none(NOTE_NONE);
  const dist = a.dist instanceof Map ? a.dist : new Map();
  const stations = (snapshot.stations || []).filter((s) => s.systemId !== a.target && dist.has(s.systemId))
    .sort(byStation(dist));
  let found = null;
  for (const st of stations) {
    const cls = classes.find((c) => a.lg.available(st.stationId, c) >= 1);
    if (cls !== undefined) {
      found = { st, cls };
      break;
    }
  }
  if (found === null) return none(NOTE_NONE);
  const cost = { resourceUnits: params.mobilizeResourcePerShip, reserveUnits: params.mobilizeReservePerShip };
  const budget = a.budget || { resourceUnits: 0, reserveUnits: 0 };
  if (cost.resourceUnits > budget.resourceUnits || cost.reserveUnits > budget.reserveUnits) return none(NOTE_RESOURCES);
  const iskLeft = Number.isSafeInteger(a.iskLeft) ? a.iskLeft : null;
  const war = iskLeft !== null && a.war ? a.war : null;
  const fit = war ? fitIskOf([{ hullGroup: found.cls, count: 1 }], war.valueByGroup, war.fitPermille) : 0;
  if (iskLeft !== null && fit > iskLeft) return none(NOTE_ISK);
  const { st, cls } = found;
  const composition = [{ hullGroup: cls, typeId: capitalClasses[cls], count: 1 }];
  const intent = { type: "MOBILIZE", role: a.role, systemId: st.systemId, homeSystemId: st.systemId, composition, cost,
    stationId: st.stationId, hulls: [{ itemKey: `group:${cls}`, count: 1 }], ...(iskLeft !== null ? { warIsk: fit } : {}) };
  return { intent, strength: strengthOf(composition, params.powerTable), fit, cls };
}

module.exports = { planCapitalEscort, escortDistOf, CAPITAL_ESCORT_NOTE };
