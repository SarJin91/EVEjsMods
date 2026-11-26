"use strict";

const POLICY = Object.freeze(["shed", "disable", "refuse"]);
const SHED_ORDER = Object.freeze(["prop", "ewar", "remoteCapacitor", "localRep", "remote", "alwaysOn"]);
const SHED_ORDER_REMOTE_LAST = Object.freeze(["prop", "ewar", "localRep", "alwaysOn", "remoteCapacitor", "remote"]);
const CAP_STATE = Object.freeze(["stable", "shed", "disabled", "refused"]);
const PEAK_FACTOR = 2.5;
const MS_PER_S = 1000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function drainOf(module) {
  const durationS = num(module && module.durationMs) / MS_PER_S;
  const capNeed = Math.max(0, num(module && module.capNeed));
  return durationS > 0 ? capNeed / durationS : 0;
}

function peakOf(capacityGJ, rechargeMs) {
  const rechargeS = num(rechargeMs) / MS_PER_S;
  return rechargeS > 0 ? (PEAK_FACTOR * Math.max(0, num(capacityGJ))) / rechargeS : 0;
}

function decide(input) {
  const src = input || {};
  const modules = Array.isArray(src.modules) ? src.modules.filter((m) => m && typeof m === "object") : [];
  const policy = POLICY.includes(src.policy) ? src.policy : "shed";
  const peakGJs = peakOf(src.capacityGJ, src.rechargeMs);
  const incomeGJs = Math.max(0, num(src.incomeGJs));
  const shedOrder = src.remoteLast === true ? SHED_ORDER_REMOTE_LAST : SHED_ORDER;
  const limit = peakGJs * Math.max(0, num(src.stableFactorPct)) / 100 + incomeGJs;
  const weapons = modules.filter((m) => m.kind === "weapon");
  const active = modules.filter((m) => m.kind !== "weapon");
  const weaponDrain = src.includeWeapons === true ? weapons.reduce((sum, m) => sum + drainOf(m), 0) : 0;
  const activeDrain = active.reduce((sum, m) => sum + drainOf(m), 0);
  const drainGJs = weaponDrain + activeDrain;
  const kept = new Set(active.map((m) => m.id));
  const out = (cap, shed) => ({ stable: cap === "stable", cap, peakGJs, drainGJs, incomeGJs, kept, shed,
    refused: cap === "refused" });
  if (drainGJs <= limit) return out("stable", []);
  if (policy === "refuse") {
    kept.clear();
    return out("refused", []);
  }
  const all = active.map((m) => m.id);
  if (policy === "disable") {
    kept.clear();
    return out("disabled", all);
  }
  const rank = (m) => {
    const at = shedOrder.indexOf(m.kind);
    return at < 0 ? -1 : at;
  };
  const order = [...active].sort((a, b) => rank(a) - rank(b) || drainOf(b) - drainOf(a) || num(a.id) - num(b.id));
  const shed = [];
  let drain = drainGJs;
  for (const m of order) {
    if (drain <= limit) break;
    if (drainOf(m) <= 0) continue;
    kept.delete(m.id);
    shed.push(m.id);
    drain = weaponDrain + active.filter((k) => kept.has(k.id)).reduce((sum, k) => sum + drainOf(k), 0);
  }
  if (drain > limit || kept.size === 0) {
    kept.clear();
    return out("disabled", all);
  }
  return out("shed", shed);
}

module.exports = { POLICY, SHED_ORDER, SHED_ORDER_REMOTE_LAST, CAP_STATE, PEAK_FACTOR, decide, drainOf, peakOf };
