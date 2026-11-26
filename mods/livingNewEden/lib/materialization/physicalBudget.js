// Adapted from X-Eve server/src/space/npc/npcPhysicalBudget.js (MIT, see CREDITS.md): - factory instead of a module singleton (no resetForTests), limits injected instead of the config module; - results { ok, reason } instead of { success }, release returns a structured result;

"use strict";

const OWNER_KINDS = Object.freeze(["battle", "fleet"]);

const REASONS = Object.freeze({
  RESERVED: "RESERVED",
  ALREADY_RESERVED: "ALREADY_RESERVED",
  CAPACITY_AVAILABLE: "CAPACITY_AVAILABLE",
  RELEASED: "RELEASED",
  NOT_RESERVED: "NOT_RESERVED",
  INVALID_REQUEST: "INVALID_REQUEST",
  RESERVATION_ID_CONFLICT: "RESERVATION_ID_CONFLICT",
  GLOBAL_LIMIT: "GLOBAL_LIMIT",
  SYSTEM_LIMIT: "SYSTEM_LIMIT",
});

const COUNTER_NAMES = Object.freeze(["granted", "idempotent", "released", "releaseMisses", "deniedGlobal",
  "deniedSystem", "deniedConflict", "deniedInvalid"]);

const DENIED_COUNTER = Object.freeze({
  [REASONS.GLOBAL_LIMIT]: "deniedGlobal",
  [REASONS.SYSTEM_LIMIT]: "deniedSystem",
  [REASONS.RESERVATION_ID_CONFLICT]: "deniedConflict",
  [REASONS.INVALID_REQUEST]: "deniedInvalid",
});

function isLimit(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeText(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  return value.trim();
}

function copyReservation(reservation) {
  return { ...reservation, metadata: { ...reservation.metadata } };
}

function createPhysicalBudget(opts) {
  const limitsIn = opts && opts.limits;
  if (!limitsIn || !isLimit(limitsIn.perSystem)) throw new RangeError("limits.perSystem");
  if (!isLimit(limitsIn.global)) throw new RangeError("limits.global");
  const limits = Object.freeze({ perSystem: limitsIn.perSystem, global: limitsIn.global });
  const clock = opts.clock && typeof opts.clock.now === "function" ? opts.clock : { now: () => Date.now() };
  const telemetry = opts.telemetry || null;

  const reservations = new Map();
  const bySystem = new Map();
  const byOwnerKind = new Map();
  let reservedShips = 0;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));

  function bump(name) {
    counters[name] += 1;
    if (telemetry) telemetry.count(`materialization.budget.${name}`, 1);
  }

  function publishGauges() {
    if (!telemetry) return;
    telemetry.gauge("materialization.budget.reservedShips", reservedShips);
    telemetry.gauge("materialization.budget.reservations", reservations.size);
    telemetry.gauge("materialization.budget.systems", bySystem.size);
  }

  function addTo(map, key, delta) {
    const next = (map.get(key) || 0) + delta;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  }

  function normalizeRequest(request) {
    const r = request && typeof request === "object" ? request : {};
    return {
      reservationId: normalizeText(r.reservationId),
      ownerKind: r.ownerKind,
      ownerId: normalizeText(r.ownerId),
      systemId: r.systemId,
      shipCount: r.shipCount,
      metadata: r.metadata && typeof r.metadata === "object" ? { ...r.metadata } : {},
    };
  }

  function isValid(n) {
    return n.reservationId !== "" && n.ownerId !== "" && OWNER_KINDS.includes(n.ownerKind)
      && isPositiveInt(n.systemId) && isPositiveInt(n.shipCount);
  }

  function evaluate(n) {
    if (!isValid(n)) return { ok: false, reason: REASONS.INVALID_REQUEST };
    const existing = reservations.get(n.reservationId);
    if (existing) {
      const same = existing.ownerKind === n.ownerKind && existing.ownerId === n.ownerId
        && existing.systemId === n.systemId && existing.shipCount === n.shipCount;
      return same
        ? { ok: true, reason: REASONS.ALREADY_RESERVED, reservation: copyReservation(existing) }
        : { ok: false, reason: REASONS.RESERVATION_ID_CONFLICT, reservation: copyReservation(existing) };
    }
    if (reservedShips + n.shipCount > limits.global) {
      return { ok: false, reason: REASONS.GLOBAL_LIMIT, available: Math.max(0, limits.global - reservedShips) };
    }
    const inSystem = bySystem.get(n.systemId) || 0;
    if (inSystem + n.shipCount > limits.perSystem) {
      return { ok: false, reason: REASONS.SYSTEM_LIMIT, available: Math.max(0, limits.perSystem - inSystem) };
    }
    return { ok: true, reason: REASONS.CAPACITY_AVAILABLE };
  }

  function canReserve(request) {
    return evaluate(normalizeRequest(request));
  }

  function reserve(request) {
    const n = normalizeRequest(request);
    const result = evaluate(n);
    if (!result.ok) {
      bump(DENIED_COUNTER[result.reason]);
      return result;
    }
    if (result.reason === REASONS.ALREADY_RESERVED) {
      bump("idempotent");
      return result;
    }
    const reservation = {
      reservationId: n.reservationId, ownerKind: n.ownerKind, ownerId: n.ownerId, systemId: n.systemId,
      shipCount: n.shipCount, metadata: n.metadata, reservedAtMs: clock.now(),
    };
    reservations.set(reservation.reservationId, reservation);
    reservedShips += reservation.shipCount;
    addTo(bySystem, reservation.systemId, reservation.shipCount);
    addTo(byOwnerKind, reservation.ownerKind, reservation.shipCount);
    bump("granted");
    publishGauges();
    return { ok: true, reason: REASONS.RESERVED, reservation: copyReservation(reservation) };
  }

  function dropReservation(reservation) {
    reservations.delete(reservation.reservationId);
    reservedShips = Math.max(0, reservedShips - reservation.shipCount);
    addTo(bySystem, reservation.systemId, -reservation.shipCount);
    addTo(byOwnerKind, reservation.ownerKind, -reservation.shipCount);
    bump("released");
  }

  function release(reservationId) {
    const reservation = reservations.get(normalizeText(reservationId));
    if (!reservation) {
      bump("releaseMisses");
      return { ok: false, reason: REASONS.NOT_RESERVED };
    }
    dropReservation(reservation);
    publishGauges();
    return { ok: true, reason: REASONS.RELEASED, reservation: copyReservation(reservation) };
  }

  function releaseOwner(ownerKind, ownerId) {
    if (!OWNER_KINDS.includes(ownerKind)) return { ok: false, reason: REASONS.INVALID_REQUEST };
    const owner = ownerId === undefined ? null : normalizeText(ownerId);
    if (owner === "") return { ok: false, reason: REASONS.INVALID_REQUEST };
    const matched = [];
    for (const reservation of reservations.values()) {
      if (reservation.ownerKind !== ownerKind) continue;
      if (owner !== null && reservation.ownerId !== owner) continue;
      matched.push(reservation);
    }
    let ships = 0;
    for (const reservation of matched) {
      dropReservation(reservation);
      ships += reservation.shipCount;
    }
    if (matched.length > 0) publishGauges();
    return { ok: true, released: matched.length, ships };
  }

  function getReservation(reservationId) {
    const reservation = reservations.get(normalizeText(reservationId));
    return reservation ? copyReservation(reservation) : null;
  }

  function getLimits() {
    return { perSystem: limits.perSystem, global: limits.global };
  }

  function getStatus(options) {
    const status = {
      limits: getLimits(),
      reservedShips,
      availableShips: Math.max(0, limits.global - reservedShips),
      reservationCount: reservations.size,
      reservedBySystem: Object.fromEntries(bySystem),
      reservedByOwnerKind: Object.fromEntries(byOwnerKind),
      counters: { ...counters },
    };
    if (options && options.includeReservations === true) {
      status.reservations = Array.from(reservations.values(), copyReservation);
    }
    return status;
  }

  publishGauges();
  return { canReserve, reserve, release, releaseOwner, getReservation, getLimits, getStatus };
}

module.exports = { createPhysicalBudget, OWNER_KINDS, REASONS, COUNTER_NAMES };
