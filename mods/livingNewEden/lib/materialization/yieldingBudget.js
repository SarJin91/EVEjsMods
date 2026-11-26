"use strict";

const LIMIT_REASONS = Object.freeze(["GLOBAL_LIMIT", "SYSTEM_LIMIT"]);

function createYieldingBudget(budget, getYielders, clock, opts) {
  const backoffMs = opts && Number.isSafeInteger(opts.backoffMs) && opts.backoffMs > 0 ? opts.backoffMs : 0;
  const onFleetReserve = opts && typeof opts.onFleetReserve === "function" ? opts.onFleetReserve : null;
  const lastYield = new Map();

  const yieldersOf = () => {
    let v;
    try {
      v = typeof getYielders === "function" ? getYielders() : null;
    } catch (_err) {
      v = null;
    }
    return (Array.isArray(v) ? v : [v]).filter((y) => y && typeof y.yieldShips === "function");
  };
  const validRequest = (r) => Boolean(r && typeof r === "object" && Number.isSafeInteger(r.shipCount));
  const limited = (p) => Boolean(p && p.ok !== true && LIMIT_REASONS.includes(p.reason));
  const backedOff = (id, now) => {
    for (const [k, at] of lastYield) if (now - at >= backoffMs) lastYield.delete(k);
    return lastYield.has(id);
  };
  const needOf = (request) => {
    const limits = budget.getLimits();
    const status = budget.getStatus();
    const inSystem = status.reservedBySystem[request.systemId] || 0;
    return { system: Math.max(0, inSystem + request.shipCount - limits.perSystem),
      global: Math.max(0, status.reservedShips + request.shipCount - limits.global) };
  };
  const freeOf = (ys, systemId) => {
    let system = 0;
    let global = 0;
    for (const y of ys) {
      if (typeof y.freeable !== "function") return null;
      const f = y.freeable(systemId);
      system += f && f.system > 0 ? f.system : 0;
      global += f && f.global > 0 ? f.global : 0;
    }
    return { system, global };
  };

  const canReserve = (request) => {
    const p = budget.canReserve(request);
    try {
      if (!limited(p) || !validRequest(request)) return p;
      const ys = yieldersOf();
      if (ys.length === 0 || backedOff(String(request.reservationId), clock.now())) return p;
      const free = freeOf(ys, request.systemId);
      if (free === null) return p;
      const limits = budget.getLimits();
      const status = budget.getStatus();
      const inSystem = status.reservedBySystem[request.systemId] || 0;
      const room = Math.min(limits.perSystem - inSystem + free.system, limits.global - status.reservedShips
        + free.global);
      if (room >= request.shipCount) return { ok: true, reason: "CAPACITY_AVAILABLE", yielding: true };
      return { ...p, available: Math.max(0, room) };
    } catch (_err) {
      return p;
    }
  };

  const reserve = (request) => {
    let veto = null;
    try {
      if (onFleetReserve && request && request.ownerKind === "fleet" && typeof request.ownerId === "string") {
        const h = onFleetReserve(request.ownerId);
        if (h && h.ok === false) veto = { ok: false, reason: String(h.reason || "HAND_OVER_REFUSED") };
      }
    } catch (_err) {
    }
    if (veto !== null) return veto;
    try {
      const ys = validRequest(request) ? yieldersOf() : [];
      if (ys.length > 0 && limited(budget.canReserve(request))) {
        const now = clock.now();
        const id = String(request.reservationId);
        if (!backedOff(id, now)) {
          let need = needOf(request);
          const free = freeOf(ys, request.systemId);
          if (free === null || (free.system >= need.system && free.global >= need.global)) {
            let yielded = false;
            for (const y of ys) {
              if (need.system <= 0 && need.global <= 0) break;
              const f = typeof y.freeable === "function" ? y.freeable(request.systemId) : null;
              const ask = f ? { system: Math.min(need.system, f.system > 0 ? f.system : 0),
                global: Math.min(need.global, f.global > 0 ? f.global : 0) } : need;
              if (ask.system <= 0 && ask.global <= 0) continue;
              const done = y.yieldShips(request.systemId, ask, now);
              if (done && done.ok === true) yielded = true;
              need = needOf(request);
            }
            if (yielded && backoffMs > 0) lastYield.set(id, now);
          }
        }
      }
    } catch (_err) {
    }
    return budget.reserve(request);
  };
  return Object.freeze({ ...budget, canReserve, reserve });
}

module.exports = { createYieldingBudget, LIMIT_REASONS };
