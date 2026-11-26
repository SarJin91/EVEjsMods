"use strict";

const { rowsBound } = require("../world/occupation/schema");
const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function taleSystemIdsOf(systemIds, maxSystems) {
  const out = [];
  for (const id of Array.isArray(systemIds) ? systemIds : []) {
    if (out.length >= maxSystems) break;
    if (isId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function planConstellationDrops(input) {
  const x = input || {};
  const defeated = x.outcome === S.OUTCOME.DEFEATED;
  if ((!defeated && x.outcome !== S.OUTCOME.EXPIRED) || x.effect === S.EFFECT.FAILED) return [];
  const points = defeated ? x.defeatPoints : x.expirePoints;
  if (!Number.isFinite(points) || !(points > 0)) return [];
  const claimStates = Array.isArray(x.claimStates) ? x.claimStates : [];
  const byId = new Map((Array.isArray(x.systems) ? x.systems : []).filter((s) => s && isId(s.systemId))
    .map((s) => [s.systemId, s]));
  const out = [];
  for (const systemId of taleSystemIdsOf(x.systemIds, x.maxSystems)) {
    const sys = byId.get(systemId);
    if (!sys || sys.occupierFactionId !== x.claimantFactionId || !claimStates.includes(sys.occupationState)) continue;
    if (defeated) {
      if (systemId === x.targetSystemId && !S.TARGET_DROP_EFFECTS.includes(x.effect)) continue;
      out.push({ systemId, factionId: x.claimantFactionId, points, kind: "drop" });
    } else {
      const controller = sys.controllerFactionId;
      if (!isId(controller) || controller === x.claimantFactionId) continue;
      out.push({ systemId, factionId: controller, points, kind: "hold" });
    }
  }
  return out.sort((a, b) => a.systemId - b.systemId);
}

function settleRowsBound(maxFactionsPerSystem, maxSystems) {
  return 2 + (1 + rowsBound(maxFactionsPerSystem)) + maxSystems * rowsBound(maxFactionsPerSystem);
}

module.exports = { planConstellationDrops, settleRowsBound, taleSystemIdsOf };
