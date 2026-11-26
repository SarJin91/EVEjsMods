"use strict";

const WAKE_REFUSALS = Object.freeze(["NO_SEC_CLASS", "SEC_CLASS", "PASS_LIMIT", "SYSTEM_LIMIT", "GLOBAL_LIMIT"]);
const HIGHSEC = "highsec";

const isPoint = (p) => Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function safeHostile(isHostile, characterId) {
  try {
    return typeof isHostile === "function" && isHostile(characterId) === true;
  } catch (_err) {
    return false;
  }
}

function targetsOf(input) {
  const i = input && typeof input === "object" ? input : {};
  const ships = (Array.isArray(i.ships) ? i.ships : []).filter((s) => s && isPoint(s.position));
  const players = Array.isArray(i.players) ? i.players : [];
  const aggressors = i.aggressorEntityIds instanceof Set ? i.aggressorEntityIds : new Set();
  const range = Number.isFinite(i.rangeMeters) && i.rangeMeters > 0 ? i.rangeMeters : 0;
  const rangeSq = range * range;
  const out = [];
  if (ships.length === 0) return out;
  for (const p of players) {
    if (!p || !Number.isSafeInteger(p.characterId) || !Number.isSafeInteger(p.entityId) || !isPoint(p.position)) {
      continue;
    }
    if (p.inWarp === true || p.cloaked === true || p.jumpCloaked === true || p.capsule === true) continue;
    let best = Infinity;
    for (const s of ships) best = Math.min(best, distanceSq(s.position, p.position));
    const retaliation = aggressors.has(p.entityId);
    if (!retaliation && (best > rangeSq || !safeHostile(i.isHostile, p.characterId))) continue;
    out.push({ characterId: p.characterId, entityId: p.entityId, distanceSq: best, retaliation });
  }
  return out.sort((a, b) => (a.distanceSq - b.distanceSq) || (a.entityId - b.entityId));
}

function admitWake(facts, p) {
  const f = facts && typeof facts === "object" ? facts : {};
  const q = p && typeof p === "object" ? p : {};
  if (typeof f.secClass !== "string" || f.secClass === "") return { ok: false, reason: "NO_SEC_CLASS" };
  if (!Array.isArray(f.secClasses) || !f.secClasses.includes(f.secClass)) return { ok: false, reason: "SEC_CLASS" };
  const num = (v) => (Number.isFinite(v) ? v : 0);
  if (num(f.wakesThisPass) >= num(q.hostileMaxWakesPerPass)) return { ok: false, reason: "PASS_LIMIT" };
  const perSystem = f.secClass === HIGHSEC ? num(q.hostileHighsecMaxEngagedPerSystem)
    : num(q.hostileMaxEngagedPerSystem);
  if (num(f.engagedInSystem) >= perSystem) return { ok: false, reason: "SYSTEM_LIMIT" };
  if (num(f.engagedGlobal) >= num(q.hostileMaxEngagedGlobal)) return { ok: false, reason: "GLOBAL_LIMIT" };
  return { ok: true };
}

function orderPlan(ships, targets, maxOrders) {
  const list = Array.isArray(targets) ? targets.filter((t) => t && Number.isSafeInteger(t.entityId)) : [];
  const max = Number.isSafeInteger(maxOrders) && maxOrders > 0 ? maxOrders : 0;
  if (list.length === 0 || max === 0) return [];
  const ids = new Set(list.map((t) => t.entityId));
  const need = (Array.isArray(ships) ? ships : []).filter((s) => s && Number.isSafeInteger(s.entityId)
    && !ids.has(s.attackTargetId));
  return need.slice(0, max).map((s, i) => ({ entityId: s.entityId, targetId: list[i % list.length].entityId }));
}

module.exports = { targetsOf, admitWake, orderPlan, WAKE_REFUSALS };
