"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const D = require("../data/capsuleers");
const { ACTION, decideStep, ratStepDueAt, ratLastAtOf } = require("./tripMachine");
const { hostilesPresent, stepKills, bountyOf, PRESENT_STATES, CAPSULEER_ROLE, CAPSULEER_ROLES, MERC_ROLE } =
  require("./rattingRules");
const { KIND_OPERATION } = require("./contractRules");
const { salvageTimes, planSalvageReturn, ACTION: SALVAGE_ACTION } = require("../../fleets/salvageOps");
const { nextReconcileKey } = require("../../economy/reconcileSlots");
const { createHostility } = require("../../battle/data/hostility");

const ROUTE_SKIP_REASONS = Object.freeze(["SAME_SYSTEM", "TOO_FAR", "UNREACHABLE", "UNKNOWN_SYSTEM",
  "NO_RETREAT_TARGET", "FLEET_PINNED"]);
const ASSIGNABLE = Object.freeze(["IDLE", "STAGED"]);
const RELEASABLE = Object.freeze(["STAGED", "PLANNED"]);
const DUE_KEYS = Object.freeze(["phaseSeq", "round", "tripId"]);
const NUDGE_KEYS = Object.freeze(["at", "fleetId", "legSeq", "state"]);
const SAVEPOINT_ABORT = Symbol("capsuleers-savepoint-abort");
const MAX_DETAIL = 120;
const MS_DECIMALS = 100;
const KEY_SUFFIX_ROOM = 24;
const SUM_CAP = 1e15;

const METRIC_RAT_STARTS = "capsuleers.ratStarts";
const METRIC_STEPS = "capsuleers.steps";
const METRIC_KILLS = "capsuleers.kills";
const METRIC_KILLS_APPLIED = "capsuleers.killsApplied";
const METRIC_KILLS_DUPLICATE = "capsuleers.killsDuplicate";
const METRIC_KILLS_RATE_LIMITED = "capsuleers.killsRateLimited";
const METRIC_KILLS_IGNORED = "capsuleers.killsIgnored";
const METRIC_KILLS_UNREPORTED = "capsuleers.killsUnreported";
const METRIC_BOUNTY_ISK = "capsuleers.bountyIsk";
const METRIC_WALLET_FULL = "capsuleers.walletFull";
const METRIC_ABORT_HOSTILES = "capsuleers.abortHostiles";
const METRIC_ABORT_DIVERTED = "capsuleers.abortDiverted";
const METRIC_ABORT_CONTROL_LOST = "capsuleers.abortControlLost";
const METRIC_DOCKED = "capsuleers.docked";
const METRIC_ABORTED = "capsuleers.aborted";
const METRIC_LOST = "capsuleers.lost";
const METRIC_WAITS = "capsuleers.waits";
const METRIC_RESEEKS = "capsuleers.reseeks";
const METRIC_TIMEOUTS = "capsuleers.timeouts";
const METRIC_TRIP_STALE = "capsuleers.tripStale";
const METRIC_TRIP_IGNORED = "capsuleers.tripIgnored";
const METRIC_TRIPS_RECONCILED = "capsuleers.tripsReconciled";
const METRIC_RECONCILE_EXHAUSTED = "capsuleers.reconcileExhausted";
const METRIC_TRIPS_OPEN = "capsuleers.tripsOpen";
const METRIC_TRIP_STEP_MS = "capsuleers.tripStepMs";
const METRIC_GUARD_STEPS = "capsuleers.guardSteps";
const METRIC_SALVAGE_STARTS = "capsuleers.salvageStarts";
const METRIC_SALVAGE_COLLECTED = "capsuleers.salvageCollected";
const METRIC_SALVAGE_UNITS = "capsuleers.salvageUnits";
const METRIC_SALVAGE_ISK = "capsuleers.salvageIsk";
const METRIC_SALVAGE_EMPTY = "capsuleers.salvageEmpty";
const METRIC_SALVAGE_FIELD_GONE = "capsuleers.salvageFieldGone";
const METRIC_SALVAGE_TOO_LATE = "capsuleers.salvageTooLate";
const METRIC_SALVAGE_UNITS_LOST = "capsuleers.salvageUnitsLost";
const METRIC_CLAIM_RAT_STEPS = "capsuleers.claimRatSteps";
const COUNTERS = Object.freeze({ ratStarts: METRIC_RAT_STARTS, steps: METRIC_STEPS, kills: METRIC_KILLS,
  killsApplied: METRIC_KILLS_APPLIED, killsDuplicate: METRIC_KILLS_DUPLICATE,
  killsRateLimited: METRIC_KILLS_RATE_LIMITED, killsIgnored: METRIC_KILLS_IGNORED,
  killsUnreported: METRIC_KILLS_UNREPORTED, bountyIsk: METRIC_BOUNTY_ISK, walletFull: METRIC_WALLET_FULL,
  abortHostiles: METRIC_ABORT_HOSTILES, abortDiverted: METRIC_ABORT_DIVERTED,
  abortControlLost: METRIC_ABORT_CONTROL_LOST, docked: METRIC_DOCKED, aborted: METRIC_ABORTED, lost: METRIC_LOST,
  waits: METRIC_WAITS, reseeks: METRIC_RESEEKS, timeouts: METRIC_TIMEOUTS, tripStale: METRIC_TRIP_STALE,
  tripIgnored: METRIC_TRIP_IGNORED, tripsReconciled: METRIC_TRIPS_RECONCILED,
  reconcileExhausted: METRIC_RECONCILE_EXHAUSTED, guardSteps: METRIC_GUARD_STEPS,
  salvageStarts: METRIC_SALVAGE_STARTS, salvageCollected: METRIC_SALVAGE_COLLECTED,
  salvageUnits: METRIC_SALVAGE_UNITS, salvageIsk: METRIC_SALVAGE_ISK, salvageEmpty: METRIC_SALVAGE_EMPTY,
  salvageFieldGone: METRIC_SALVAGE_FIELD_GONE, salvageTooLate: METRIC_SALVAGE_TOO_LATE,
  salvageUnitsLost: METRIC_SALVAGE_UNITS_LOST, claimRatSteps: METRIC_CLAIM_RAT_STEPS });
const CONTRACT_TRIP_STATES = Object.freeze([S.OUTBOUND, S.RATTING]);
const OPERATION_PAIRS = Object.freeze(Object.values(KIND_OPERATION));
const ABORT_COUNTERS = Object.freeze({ HOSTILES: "abortHostiles", DIVERTED: "abortDiverted",
  CONTROL_LOST: "abortControlLost", WORLD_UNAVAILABLE: "abortControlLost",
  FIELD_GONE: "salvageFieldGone", WRECKS_UNAVAILABLE: "salvageFieldGone", TOO_LATE: "salvageTooLate",
  EMPTY: "salvageEmpty" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= S.MAX_ID_LENGTH;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const sameKeys = (p, keys) => Object.keys(p).sort().join() === keys.join();

function parseStepPayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (sameKeys(p, DUE_KEYS)) {
    if (!isText(p.tripId) || !isTime(p.phaseSeq) || !isTime(p.round)) return null;
    return { kind: "due", tripId: p.tripId, phaseSeq: p.phaseSeq, round: p.round };
  }
  if (sameKeys(p, NUDGE_KEYS)) {
    if (!isText(p.fleetId) || !isTime(p.legSeq) || typeof p.state !== "string" || !isTime(p.at)) return null;
    return { kind: "nudge", fleetId: p.fleetId, legSeq: p.legSeq, state: p.state, at: p.at };
  }
  return null;
}

function createRattingService(deps) {
  const { store, journal, trips, corps, fleets, scheduler, clock, ids, config } = deps;
  const C = config.capsuleers;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const isHostile = typeof deps.isHostile === "function" ? deps.isHostile : createHostility();
  const machineParams = Object.freeze({ maxWatchRounds: C.tripMaxWatchRounds, rattingStepMs: C.rattingStepMs,
    mercStepMs: C.mercStepMs });
  const counters = Object.fromEntries(Object.keys(COUNTERS).map((n) => [n, 0]));
  const memory = new Map();
  let memoryVersion = 0;
  let state = "running";
  let lastRefusal = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", COUNTERS[name], n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function soft(getter) {
    try {
      return typeof getter === "function" ? getter() || null : null;
    } catch (_err) {
      return null;
    }
  }

  const stopped = () => state !== "running";

  function openCount() {
    let n = 0;
    for (const t of memory.values()) if (S.OPEN_TRIP_STATES.includes(t.state)) n += 1;
    return n;
  }

  function remember(trip) {
    if (!trip || !trip.tripId) return;
    memory.set(trip.tripId, trip);
    memoryVersion += 1;
  }

  function setTrips(list) {
    memory.clear();
    for (const t of list || []) if (t && t.tripId) memory.set(t.tripId, t);
    memoryVersion += 1;
    metric("gauge", METRIC_TRIPS_OPEN, openCount());
  }

  function listTrips() {
    return [...memory.values()].sort((a, b) => (a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0));
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "CAPSULEERS_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function enqueueStep(tx, tripId, phaseSeq, round, dueAt) {
    const r = scheduler.enqueue(S.STEP_EVENT, tripId, dueAt, { tripId, phaseSeq, round },
      S.stepKey(tripId, phaseSeq, round), { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "step" };
    return { ok: true };
  }

  function getFleet(tx, fleetId) {
    const f = fleets.repository.getFleet(tx, fleetId);
    return f && f.ok ? f : (f || { ok: false, reason: "FLEET_READ_FAILED" });
  }

  function release(tx, fleet, operationIds, key, close) {
    if (fleet && RELEASABLE.includes(fleet.state) && fleet.operationId && operationIds.includes(fleet.operationId)) {
      const r = fleets.repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: fleet.state, to: "IDLE" }, `${key}:rel`);
      if (!r.ok) return { ...r, stage: "release" };
      if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:rel` };
    }
    for (const id of operationIds.filter((x) => x)) {
      const o = fleets.repository.getOperation(tx, id);
      if (!o.ok) return o;
      const op = o.operation;
      if (!op || !["PLANNED", "ACTIVE"].includes(op.state)) continue;
      const to = op.state === "PLANNED" ? "CANCELLED" : close.to;
      const c = fleets.repository.transitionOperation(tx, { operationId: id, expectedVersion: op.version,
        from: op.state, to, result: close.result }, `${key}:close:${id}`);
      if (!c.ok) {
        if (c.reason === "OPERATION_HAS_FLEETS") continue;
        return { ...c, stage: "close" };
      }
    }
    return { ok: true };
  }

  function isPirate(registry, factionId) {
    if (!isId(factionId) || !registry || typeof registry.getFaction !== "function") return false;
    const f = registry.getFaction(factionId);
    if (!f || f.kind !== "pirate") return false;
    return typeof registry.isActive !== "function" || registry.isActive(factionId) === true;
  }

  function controlOf(tx, systemId) {
    const world = soft(deps.getWorld);
    const repo = world && world.repository && typeof world.repository.getSystems === "function"
      ? world.repository : null;
    const registry = soft(deps.getRegistry);
    if (!repo || !registry) return { controlled: null, controller: null, rawController: undefined };
    const r = repo.getSystems(tx, [systemId], { includeInfluence: false });
    if (!r || r.ok !== true) return { controlled: null, controller: null, rawController: undefined };
    const sys = (r.systems || []).find((x) => x && x.systemId === systemId);
    const rawController = sys ? sys.controllerFactionId : undefined;
    if (!sys || !isPirate(registry, sys.controllerFactionId)) {
      return { controlled: false, controller: null, rawController };
    }
    return { controlled: true, controller: sys.controllerFactionId, rawController };
  }

  function hostilesIn(tx, systemId) {
    const list = fleets.repository.listFleetsInSystem(tx, systemId, { states: PRESENT_STATES,
      limit: C.hostileScanMaxFleets + 1 });
    if (!list || list.ok !== true) return list || { ok: false, reason: "FLEETS_READ_FAILED" };
    return { ok: true, hostiles: hostilesPresent(list.fleets, { selfFactionId: D.CAPSULEER_FACTION_ID, isHostile,
      truncated: list.fleets.length > C.hostileScanMaxFleets }) };
  }

  function dispatchInTx(tx, spec, key) {
    if (stopped()) return { ok: false, reason: "CAPSULEERS_STOPPED" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    const p = spec || {};
    const merc = p.kind === S.MERC_TRIP_KIND;
    const salvage = p.kind === S.SALVAGE_TRIP_KIND;
    const outbound = p.kind === "rat" || merc || salvage;
    if (!S.TRIP_KINDS.includes(p.kind) || !isId(p.slot) || !isText(p.fleetId) || !isId(p.baseSystemId)
      || !isTime(p.at) || !Number.isSafeInteger(p.expectedVersion) || p.expectedVersion < 1
      || (outbound ? !isId(p.targetSystemId) : p.targetSystemId !== null)
      || typeof key !== "string" || key.length < 1 || key.length > S.MAX_KEY_LENGTH - KEY_SUFFIX_ROOM) {
      return { ok: false, reason: "CAPSULEERS_INVALID_INPUT" };
    }
    if (merc ? (!isText(p.tripId) || !isText(p.contractId) || !OPERATION_PAIRS.some((o) => o.operationType
      === p.operationType && o.objective === p.objective))
      : ["tripId", "contractId", "operationType", "objective"].some((k) => p[k] !== undefined)) {
      return { ok: false, reason: "CAPSULEERS_INVALID_INPUT" };
    }
    if (salvage ? !(typeof p.fieldId === "string" && p.fieldId.length >= 1
      && p.fieldId.length <= S.MAX_FIELD_ID_LENGTH) : p.fieldId !== undefined) {
      return { ok: false, reason: "CAPSULEERS_INVALID_INPUT" };
    }
    const tripKey = `${key}:trip`;
    const earlier = trips.tripIdOfKey(tx, tripKey);
    if (!earlier.ok) return earlier;
    if (earlier.duplicate) {
      const t = trips.getTrip(tx, earlier.tripId);
      if (!t.ok) return t;
      return { ok: true, duplicate: true, tripId: earlier.tripId, state: t.trip ? t.trip.state : null };
    }
    const f = getFleet(tx, p.fleetId);
    if (!f.ok) return f;
    const fleet = f.fleet;
    const roleOk = p.kind === "rat" || salvage ? fleet && fleet.fleetRole === CAPSULEER_ROLE
      : merc ? fleet && fleet.fleetRole === MERC_ROLE : fleet && CAPSULEER_ROLES.includes(fleet.fleetRole);
    if (!fleet || fleet.factionId !== D.CAPSULEER_FACTION_ID || !roleOk) {
      return { ok: false, reason: "NOT_A_CAPSULEER_FLEET" };
    }
    if (fleet.version !== p.expectedVersion) return { ok: false, reason: "VERSION_CONFLICT" };
    if (fleet.state !== "IDLE") return { ok: false, reason: "FLEET_NOT_IDLE", state: fleet.state };
    if (fleet.refitPending === true) return { ok: false, reason: "REFIT_PENDING" };
    const open = trips.findOpenByFleet(tx, fleet.fleetId);
    if (!open.ok) return open;
    if (open.trip) return { ok: false, reason: "TRIP_OPEN", tripId: open.trip.tripId };
    const rat = outbound;
    const dest = rat ? p.targetSystemId : p.baseSystemId;
    if (fleet.currentSystemId === dest) return { ok: false, reason: "SAME_SYSTEM" };
    const tripId = merc ? p.tripId : ids.next("ct");
    const tripState = rat ? S.OUTBOUND : S.RETURNING;
    const operationType = merc ? p.operationType : salvage ? S.SALVAGE_OPERATION_TYPE
      : rat ? S.RATTING_OPERATION_TYPE : S.RETURN_OPERATION_TYPE;
    const objective = merc ? p.objective : salvage ? S.OBJECTIVE_SALVAGE : rat ? S.OBJECTIVE_RAT : S.OBJECTIVE_RETURN;
    return inSavepoint(tx, () => {
      const op = fleets.repository.createOperation(tx, { operationType, factionId: D.CAPSULEER_FACTION_ID,
        originSystemId: fleet.currentSystemId, targetSystemId: dest, objective, dueAt: null,
        fleets: [{ fleetId: fleet.fleetId, expectedVersion: fleet.version }] }, `${key}:op`);
      if (!op.ok) return op;
      if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:op` };
      const created = trips.createTrip(tx, { tripId, idempotencyKey: key, kind: p.kind, slot: p.slot,
        fleetId: fleet.fleetId, originSystemId: fleet.currentSystemId, baseSystemId: p.baseSystemId,
        targetSystemId: rat ? p.targetSystemId : null, outboundOperationId: rat ? op.operationId : null,
        returnOperationId: rat ? null : op.operationId, state: tripState, dispatchedAt: p.at,
        ...(merc ? { contractId: p.contractId } : {}), ...(salvage ? { fieldId: p.fieldId } : {}) }, tripKey);
      if (!created.ok) return created;
      const plan = fleets.travel.planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: dest, at: p.at },
        `${key}:plan`, { chained: true });
      if (!plan.ok) return plan;
      const ev = enqueueStep(tx, tripId, 0, 0, plan.arriveAt + C.tripWatchGraceMs);
      if (!ev.ok) return ev;
      const t = trips.getTrip(tx, tripId);
      return { ok: true, duplicate: false, tripId, state: tripState, arriveAt: plan.arriveAt,
        trip: t.ok ? t.trip : null };
    });
  }

  function sweepInTx(tx, spec, key) {
    if (stopped()) return { ok: false, reason: "CAPSULEERS_STOPPED" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    const p = spec || {};
    if (!isText(p.fleetId) || !Number.isSafeInteger(p.expectedVersion) || p.expectedVersion < 1
      || typeof key !== "string" || key.length < 1 || key.length > S.MAX_KEY_LENGTH - KEY_SUFFIX_ROOM) {
      return { ok: false, reason: "CAPSULEERS_INVALID_INPUT" };
    }
    const skip = (skipped) => ({ ok: true, released: false, skipped });
    const f = getFleet(tx, p.fleetId);
    if (!f.ok) return f;
    const fleet = f.fleet;
    if (!fleet || fleet.factionId !== D.CAPSULEER_FACTION_ID || !CAPSULEER_ROLES.includes(fleet.fleetRole)
      || !RELEASABLE.includes(fleet.state) || !fleet.operationId) return skip("NOT_ORPHAN");
    const open = trips.findOpenByFleet(tx, fleet.fleetId);
    if (!open.ok) return open;
    if (open.trip) return skip("NOT_ORPHAN");
    if (fleet.version !== p.expectedVersion) return skip("VERSION_CONFLICT");
    const o = fleets.repository.getOperation(tx, fleet.operationId);
    if (!o.ok) return o;
    if (!o.operation || o.operation.factionId !== D.CAPSULEER_FACTION_ID) return skip("FOREIGN_OPERATION");
    return inSavepoint(tx, () => {
      const rel = release(tx, fleet, [fleet.operationId], key, { to: "FAILED",
        result: { closedBy: "capsuleers", reason: "ORPHAN" } });
      if (!rel.ok) return rel;
      return { ok: true, released: true };
    });
  }

  function planHome(tx, trip, at, key, out, patch, roundIfNone) {
    const f = getFleet(tx, trip.fleetId);
    if (!f.ok) return f;
    const fleet = f.fleet;
    let plan = null;
    if (fleet && ASSIGNABLE.includes(fleet.state) && fleet.currentSystemId !== trip.baseSystemId) {
      plan = inSavepoint(tx, () => {
        const op = fleets.repository.createOperation(tx, { operationType: S.RETURN_OPERATION_TYPE,
          factionId: D.CAPSULEER_FACTION_ID, originSystemId: fleet.currentSystemId, targetSystemId: trip.baseSystemId,
          objective: S.OBJECTIVE_RETURN, dueAt: null, fleets: [{ fleetId: fleet.fleetId,
            expectedVersion: fleet.version }] }, `${key}:ret:op`);
        if (!op.ok) return op;
        if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:ret:op` };
        const r = fleets.travel.planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: trip.baseSystemId, at },
          `${key}:ret:plan`, { chained: true });
        if (!r.ok) return r;
        return { ok: true, operationId: op.operationId, arriveAt: r.arriveAt };
      });
      if (!plan.ok && !ROUTE_SKIP_REASONS.includes(plan.reason)) return plan;
    }
    const next = trip.phaseSeq + 1;
    const planned = Boolean(plan && plan.ok);
    const round = planned ? 0 : roundIfNone;
    const moved = trips.transitionTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version, from: trip.state,
      to: S.RETURNING, patch: { ...patch, phaseSeq: next, watchRound: round,
        returnOperationId: planned ? plan.operationId : null } }, `${key}:trip`);
    if (!moved.ok) return moved;
    if (!planned) out.noRoute = plan ? plan.reason : "NO_DEPARTURE";
    const home = fleet && ASSIGNABLE.includes(fleet.state) && fleet.currentSystemId === trip.baseSystemId;
    const due = planned ? plan.arriveAt + C.tripWatchGraceMs : (home ? at : at + C.tripWatchRecheckMs);
    return enqueueStep(tx, trip.tripId, next, round, due);
  }

  function returnInTx(tx, trip, fleet, reason, at, key, out, extra) {
    const shiftEnd = reason === "SHIFT_END";
    const rel = release(tx, fleet, [trip.outboundOperationId], key, { to: shiftEnd ? "COMPLETED" : "FAILED",
      result: { closedBy: "capsuleers", reason } });
    if (!rel.ok) return rel;
    out.returned = reason;
    return planHome(tx, trip, at, key, out, { ...(extra || {}), abortReason: shiftEnd ? null : reason }, 0);
  }

  function wreckRepo() {
    const w = soft(deps.getWrecks);
    const repo = w && w.repository;
    return repo && typeof repo.get === "function" && typeof repo.recordSalvageInTx === "function" ? repo : null;
  }

  function collectInTx(tx, trip, fleet, facts, at, key, out) {
    const repo = wreckRepo();
    const field = facts.field || null;
    if (!repo || !field) return { ok: false, reason: "WRECKS_UNAVAILABLE", stage: "collect" };
    const d = planSalvageReturn({ travelMs: 0 }, field, at, config.salvage.claimPermille);
    if (!d.ok) return d;
    if (d.action === SALVAGE_ACTION.EXHAUST) return returnInTx(tx, trip, fleet, d.reason, at, key, out);
    const taken = repo.recordSalvageInTx(tx, { fieldId: field.fieldId, expectedVersion: field.version,
      salvageUnits: d.salvaged.salvageUnits, lootUnits: d.salvaged.lootUnits, at }, `${key}:collect`);
    if (!taken.ok) return { ...taken, stage: "collect" };
    if (taken.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:collect` };
    const haul = Math.min(S.MAX_HAUL_UNITS, d.haul.salvage + d.haul.loot);
    out.haul = haul;
    return returnInTx(tx, trip, fleet, "SHIFT_END", at, key, out, { haulUnits: haul });
  }

  function salvagePayInTx(tx, trip, at, key, out) {
    const g = corps.getCorp(tx, trip.corpSlot);
    if (!g.ok) return g;
    const corp = g.corp;
    let paid = 0;
    if (corp && corp.state === "ACTIVE") {
      const amount = bountyOf(trip.haulUnits, corp.iskBalance, { rattingBountyIskPerKill: C.salvageIskPerUnit,
        maxIskBalance: C.maxIskBalance });
      if (amount > 0) {
        const w = journal.applyOnce(tx, { key: `${key}:wallet`, aggregate: { type: S.CORP_AGGREGATE,
          id: trip.corpSlot }, eventType: S.EVENT_WALLET, payload: { kind: "salvage", slot: trip.corpSlot,
          tripId: trip.tripId, haulUnits: trip.haulUnits, amount } },
        (db) => corps.credit(db, { slot: trip.corpSlot, expectedVersion: corp.version, amount,
          maxBalance: C.maxIskBalance, at }));
        if (w.ok) paid = amount;
        else if (w.reason === "APPLY_REFUSED") out.walletFull = true;
        else return w;
      } else if (C.salvageIskPerUnit > 0) out.walletFull = true;
    }
    if (paid === 0) out.unitsLost = trip.haulUnits;
    out.salvageIsk = paid;
    return { ok: true, paid };
  }

  function ratInTx(tx, trip, fleet, facts, at, key, out) {
    const g = corps.getCorp(tx, trip.corpSlot);
    if (!g.ok) return g;
    const corp = g.corp;
    const members = corp && Array.isArray(corp.memberIds) ? corp.memberIds : [];
    const characterIds = members.length > 0 ? members.slice() : (corp && isId(corp.ceoCharacterId)
      ? [corp.ceoCharacterId] : []);
    const claim = facts.claim === true;
    const kills = claim ? [] : stepKills({ tripId: trip.tripId, phaseSeq: trip.phaseSeq, round: trip.watchRound,
      systemId: trip.targetSystemId, victimFactionId: facts.controller, atMs: at, characterIds },
    { rattingKillsPerStep: C.rattingKillsPerStep });
    const killCount = claim ? Math.max(0, C.rattingKillsPerStep) : kills.length;
    const perKill = claim ? Math.floor(C.rattingBountyIskPerKill * C.claimBountyPermille / 1000)
      : C.rattingBountyIskPerKill;
    let paid = 0;
    if (killCount > 0 && corp && corp.state === "ACTIVE" && perKill > 0) {
      const amount = bountyOf(killCount, corp.iskBalance, { rattingBountyIskPerKill: perKill,
        maxIskBalance: C.maxIskBalance });
      if (amount > 0) {
        const w = journal.applyOnce(tx, { key: `${key}:wallet`, aggregate: { type: S.CORP_AGGREGATE,
          id: trip.corpSlot }, eventType: S.EVENT_WALLET, payload: { kind: claim ? "claimBounty" : "bounty",
          slot: trip.corpSlot, tripId: trip.tripId, phaseSeq: trip.phaseSeq, round: trip.watchRound, amount } },
        (db) => corps.credit(db, { slot: trip.corpSlot, expectedVersion: corp.version, amount,
          maxBalance: C.maxIskBalance, at }));
        if (w.ok) paid = amount;
        else if (w.reason === "APPLY_REFUSED") out.walletFull = true;
        else return w;
      } else out.walletFull = true;
    }
    const stepped = trips.stepTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version,
      watchRound: trip.watchRound + 1, kills: killCount, iskEarned: paid }, `${key}:step`);
    if (!stepped.ok) return stepped;
    if (!stepped.trip) return { ok: false, reason: "ROW_NOT_FOUND" };
    out.kills = kills;
    out.bounty = paid;
    if (claim) out.claim = true;
    const ends = isTime(trip.rattingEndsAt) ? trip.rattingEndsAt : at;
    if (at >= ends) return returnInTx(tx, stepped.trip, fleet, "SHIFT_END", at, key, out);
    return enqueueStep(tx, trip.tripId, trip.phaseSeq, trip.watchRound + 1, ratStepDueAt(trip, at, machineParams));
  }

  function guardInTx(tx, trip, fleet, at, key, out) {
    const stepped = trips.stepTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version,
      watchRound: trip.watchRound + 1, kills: 0, iskEarned: 0 }, `${key}:step`);
    if (!stepped.ok) return stepped;
    if (!stepped.trip) return { ok: false, reason: "ROW_NOT_FOUND" };
    const ends = isTime(trip.rattingEndsAt) ? trip.rattingEndsAt : at;
    if (at >= ends) return returnInTx(tx, stepped.trip, fleet, "SHIFT_END", at, key, out);
    return enqueueStep(tx, trip.tripId, trip.phaseSeq, trip.watchRound + 1, ratStepDueAt(trip, at, machineParams));
  }

  function endInTx(tx, trip, fleet, to, reason, at, key, closeTo, extra) {
    const rel = release(tx, fleet, [trip.returnOperationId, trip.outboundOperationId], key,
      { to: closeTo, result: { closedBy: "capsuleers", reason } });
    if (!rel.ok) return rel;
    const patch = { ...(extra || {}), phaseSeq: trip.phaseSeq + 1, endedAt: at, endReason: reason };
    if (to === S.ABORTED && trip.abortReason === null) patch.abortReason = reason;
    return trips.transitionTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version, from: trip.state, to,
      patch }, `${key}:end`);
  }

  function readFacts(tx, trip, fleet, trigger, at) {
    const facts = { at, trigger, hostiles: false, controlled: null, controller: null };
    const target = trip.targetSystemId;
    if (trip.kind === S.MERC_TRIP_KIND || target === null || !fleet || fleet.state !== "STAGED" || fleet.currentSystemId !== target
      || (trip.state !== S.OUTBOUND && trip.state !== S.RATTING)) return { ok: true, facts };
    const h = hostilesIn(tx, target);
    if (!h.ok) return h;
    facts.hostiles = h.hostiles;
    if (trip.kind === S.SALVAGE_TRIP_KIND) {
      Object.assign(facts, { field: null, fieldAlive: null, tooLate: false, recoveryMs: null });
      const repo = wreckRepo();
      const g = repo && trip.fieldId ? repo.get(tx, trip.fieldId) : null;
      if (!g || g.ok !== true) return { ok: true, facts };
      const field = g.field;
      facts.field = field;
      if (!field || field.state !== "ACTIVE" || !(field.expiresAt > at)) {
        facts.fieldAlive = false;
        return { ok: true, facts };
      }
      const t = salvageTimes(config.salvage, { jumps: 0, shipsLost: field.shipsLost });
      if (!t.ok) return { ok: true, facts };
      facts.fieldAlive = true;
      facts.recoveryMs = t.recoveryMs;
      facts.tooLate = trip.state === S.OUTBOUND && at + t.recoveryMs >= field.expiresAt;
      return { ok: true, facts };
    }
    const c = controlOf(tx, target);
    facts.controlled = c.controlled;
    facts.controller = c.controller;
    if (C.claimsEnabled === true && deps.claims && c.controlled === false && c.rawController === null) {
      const h = deps.claims.findHeldBySystem(tx, target);
      if (!h || h.ok !== true) return h || { ok: false, reason: "CLAIMS_READ_FAILED" };
      if (h.claim && h.claim.corpSlot === trip.corpSlot) {
        facts.controlled = true;
        facts.controller = null;
        facts.claim = true;
      }
    }
    return { ok: true, facts };
  }

  function act(tx, trip, fleet, facts, d, at, key, out) {
    switch (d.action) {
      case ACTION.STALE:
      case ACTION.IGNORE:
        return { ok: true };
      case ACTION.WAIT: {
        const round = trip.watchRound + 1;
        const w = trips.watchTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version, state: trip.state,
          watchRound: round, waitRound: (trip.waitRound || 0) + 1 }, `${key}:wait`);
        if (!w.ok) return w;
        const flightDue = fleet && isTime(fleet.nextActionAt) ? fleet.nextActionAt + C.tripWatchGraceMs : 0;
        return enqueueStep(tx, trip.tripId, trip.phaseSeq, round, Math.max(at + C.tripWatchRecheckMs, flightDue));
      }
      case ACTION.START_RATTING: {
        const merc = trip.kind === S.MERC_TRIP_KIND;
        const salvage = trip.kind === S.SALVAGE_TRIP_KIND;
        if (salvage && !isTime(facts.recoveryMs)) return { ok: false, reason: "WRECKS_UNAVAILABLE", stage: "start" };
        const contracts = deps.contracts || null;
        const endsAt = at + (salvage ? facts.recoveryMs : merc ? (contracts ? contracts.guardMsOf(tx, trip.contractId)
          : C.mercGuardMs) : C.rattingShiftMs);
        const moved = trips.transitionTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version,
          from: S.OUTBOUND, to: S.RATTING, patch: { phaseSeq: trip.phaseSeq + 1, watchRound: 0,
            rattingStartedAt: at, rattingEndsAt: endsAt } }, `${key}:trip`);
        if (!moved.ok) return moved;
        return enqueueStep(tx, trip.tripId, trip.phaseSeq + 1, 0,
          ratStepDueAt({ kind: trip.kind, rattingEndsAt: endsAt }, at, machineParams));
      }
      case ACTION.RAT:
        return ratInTx(tx, trip, fleet, facts, at, key, out);
      case ACTION.COLLECT:
        return collectInTx(tx, trip, fleet, facts, at, key, out);
      case ACTION.GUARD:
        return guardInTx(tx, trip, fleet, at, key, out);
      case ACTION.RETURN:
        return returnInTx(tx, trip, fleet, d.reason || "DIVERTED", at, key, out);
      case ACTION.RESEEK: {
        const rel = release(tx, fleet, [trip.returnOperationId, trip.outboundOperationId], key, { to: "FAILED",
          result: { closedBy: "capsuleers", reason: "RESEEK" } });
        if (!rel.ok) return rel;
        return planHome(tx, trip, at, key, out, {}, trip.watchRound + 1);
      }
      case ACTION.DOCK: {
        let extra;
        if (trip.kind === S.SALVAGE_TRIP_KIND && trip.haulUnits > 0) {
          if (trip.abortReason) out.unitsLost = trip.haulUnits;
          else {
            const pay = salvagePayInTx(tx, trip, at, key, out);
            if (!pay.ok) return pay;
            extra = { iskEarned: Math.min(SUM_CAP, trip.iskEarned + pay.paid) };
          }
        }
        return endInTx(tx, trip, fleet, trip.abortReason ? S.ABORTED : S.DOCKED, trip.abortReason || "DOCKED", at,
          key, "COMPLETED", extra);
      }
      case ACTION.END:
        if (trip.haulUnits > 0) out.unitsLost = trip.haulUnits;
        return endInTx(tx, trip, fleet, S.ABORTED, d.reason || "ABORTED", at, key, "FAILED");
      case ACTION.LOSE:
        if (trip.haulUnits > 0) out.unitsLost = trip.haulUnits;
        return endInTx(tx, trip, fleet, S.LOST, d.reason || "FLEET_DESTROYED", at, key, "FAILED");
      default:
        return { ok: false, reason: "UNKNOWN_ACTION", permanent: true };
    }
  }

  function step(tx, ev, p, trigger) {
    const out = { ok: true, action: ACTION.STALE, reason: null, tripId: null, kills: [], bounty: 0, trip: null };
    const key = ev.idempotencyKey;
    let trip;
    if (p.kind === "due") {
      const t = trips.getTrip(tx, p.tripId);
      if (!t.ok) return t;
      trip = t.trip;
      out.tripId = p.tripId;
      if (!trip || trip.phaseSeq !== p.phaseSeq || trip.watchRound !== p.round) return out;
    } else {
      const t = trips.findOpenByFleet(tx, p.fleetId);
      if (!t.ok) return t;
      trip = t.trip;
      if (!trip) {
        out.action = ACTION.IGNORE;
        out.reason = "NO_TRIP";
        return out;
      }
    }
    const f = getFleet(tx, trip.fleetId);
    if (!f.ok) return f;
    const fleet = f.fleet;
    const at = p.kind === "nudge" ? p.at : ev.dueAt;
    const facts = readFacts(tx, trip, fleet, trigger, at);
    if (!facts.ok) return facts;
    const d = decideStep(trip, fleet, facts.facts, machineParams);
    out.action = d.action;
    out.reason = d.reason || null;
    out.tripId = trip.tripId;
    const r = act(tx, trip, fleet, facts.facts, d, at, key, out);
    if (!r || r.ok !== true) return r || { ok: false, reason: "STEP_FAILED" };
    const after = trips.getTrip(tx, trip.tripId);
    if (after.ok) out.trip = after.trip;
    if (trip.kind === S.MERC_TRIP_KIND && deps.contracts) {
      const h = contractHook(tx, trip, after.ok ? after.trip : null, d, at, key, out);
      if (!h || h.ok !== true) return h || { ok: false, reason: "CONTRACT_HOOK_FAILED" };
    }
    return out;
  }

  function contractHook(tx, before, after, d, at, key, out) {
    if (!after) return { ok: false, reason: "ROW_NOT_FOUND", stage: "contract" };
    const contracts = deps.contracts;
    const res = { station: null, closed: null };
    if (d.action === ACTION.START_RATTING) {
      const s = contracts.onStationInTx(tx, after, at, key);
      if (!s || s.ok !== true) return s || { ok: false, reason: "CONTRACT_STATION_FAILED" };
      res.station = s.station || null;
    }
    if (CONTRACT_TRIP_STATES.includes(before.state) && !CONTRACT_TRIP_STATES.includes(after.state)) {
      const c = contracts.closeForTripInTx(tx, after, out.returned || d.reason || d.action, at, key);
      if (!c || c.ok !== true) return c || { ok: false, reason: "CONTRACT_CLOSE_FAILED" };
      res.closed = c.closed || null;
    }
    out.contract = res;
    return { ok: true };
  }

  function onCommitted(v) {
    if (!v || v.ok !== true) return;
    switch (v.action) {
      case ACTION.STALE: bump("tripStale"); break;
      case ACTION.IGNORE: bump("tripIgnored"); break;
      case ACTION.WAIT: bump("waits"); break;
      case ACTION.START_RATTING:
        bump(v.trip && v.trip.kind === S.SALVAGE_TRIP_KIND ? "salvageStarts" : "ratStarts");
        break;
      case ACTION.RAT:
        bump("steps");
        if (v.claim === true) bump("claimRatSteps");
        break;
      case ACTION.GUARD: bump("guardSteps"); break;
      case ACTION.RESEEK: bump("reseeks"); break;
      case ACTION.LOSE: bump("lost"); break;
      default: break;
    }
    const early = v.action === ACTION.RETURN ? v.reason : (v.action === ACTION.COLLECT ? v.returned || null : null);
    if (early && ABORT_COUNTERS[early]) bump(ABORT_COUNTERS[early]);
    if (v.reason === "TIMEOUT") bump("timeouts");
    if (v.walletFull) bump("walletFull");
    bump("bountyIsk", v.bounty || 0);
    if (v.action === ACTION.COLLECT && v.haul > 0) {
      bump("salvageCollected");
      bump("salvageUnits", v.haul);
    }
    bump("salvageIsk", v.salvageIsk || 0);
    bump("salvageUnitsLost", v.unitsLost || 0);
    if (v.trip) {
      if (v.trip.state === S.DOCKED) bump("docked");
      else if (v.trip.state === S.ABORTED) bump("aborted");
      remember(v.trip);
      metric("gauge", METRIC_TRIPS_OPEN, openCount());
    }
    if (v.action === ACTION.LOSE) log(`capsuleers: trip ${v.tripId} LOST ${v.reason || ""}`);
    if (v.contract && deps.contracts && typeof deps.contracts.onStepCommitted === "function") {
      try {
        deps.contracts.onStepCommitted(v.contract);
      } catch (_err) {
      }
    }
    reportKills(Array.isArray(v.kills) ? v.kills : []);
  }

  function reportKills(kills) {
    if (kills.length === 0) return;
    bump("kills", kills.length);
    const lib = soft(deps.getLiberation);
    if (!lib || typeof lib.onNpcKill !== "function") {
      bump("killsUnreported", kills.length);
      return;
    }
    for (const k of kills) {
      let r;
      try {
        r = lib.onNpcKill({ characterId: k.characterId, victimFactionId: k.victimFactionId, systemId: k.systemId,
          atMs: k.atMs, victimId: k.victimId, virtual: true });
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (!r || r.ok !== true) {
        bump("killsUnreported");
        lastRefusal = `KILL_${String((r && r.reason) || "REFUSED")}`;
      } else if (r.outcome === "APPLIED") bump("killsApplied");
      else if (r.outcome === "DUPLICATE") bump("killsDuplicate");
      else if (r.outcome === "RATE_LIMITED") bump("killsRateLimited");
      else bump("killsIgnored");
    }
  }

  function handler(ev, _hctx) {
    try {
      const p = parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "CAPSULEERS_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "CAPSULEERS_STOPPED" };
      const trigger = p.kind === "nudge" ? "arrival"
        : (String(ev.idempotencyKey).startsWith(S.RECONCILE_PREFIX) ? "reconcile" : "due");
      const t0 = nowMs();
      return { ok: true, outcome: "STEP", effect: (tx) => {
        const r = step(tx, ev, p, trigger);
        metric("observe", METRIC_TRIP_STEP_MS, Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
        if (!r || r.ok !== true) lastRefusal = String((r && r.reason) || "STEP_FAILED");
        return r;
      }, onCommitted };
    } catch (err) {
      return { ok: false, reason: `CAPSULEERS_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function onArrival(tx, a) {
    if (stopped() || !a || !CAPSULEER_ROLES.includes(a.fleetRole)) return;
    scheduler.enqueue(S.STEP_EVENT, a.fleetId, a.at, { fleetId: a.fleetId, legSeq: a.legSeq, state: a.state,
      at: a.at }, S.nudgeKey(a.fleetId, a.legSeq, a.state), { tx, chained: true });
  }

  function reconcile() {
    try {
      if (stopped()) return { ok: false, reason: "CAPSULEERS_STOPPED" };
      const listed = store.transaction("capsuleers.tripReconcileRead", (db) => trips.listOpen(db,
        { limit: C.tripReconcileMaxTrips }));
      const r = listed.ok ? listed.value : listed;
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
      let enqueued = 0;
      let exhausted = 0;
      const now = clock.now();
      for (const t of r.trips) {
        const slot = nextReconcileKey(scheduler, { dueKey: S.stepKey(t.tripId, t.phaseSeq, t.watchRound),
          baseKey: S.reconcileKey(t.tripId, t.phaseSeq, t.watchRound), maxAttempts: C.tripReconcileMaxAttempts });
        if (!slot.ok) return slot;
        if (slot.open) continue;
        if (slot.exhausted) {
          exhausted += 1;
          log(`capsuleers: reconcile ${t.tripId} exhausted ${C.tripReconcileMaxAttempts} attempts`);
          continue;
        }
        const lastAt = ratLastAtOf(t);
        const term = lastAt === null ? null : ratStepDueAt(t, lastAt, machineParams);
        const dueAt = isTime(term) ? Math.max(now, term) : now;
        const e = scheduler.enqueue(S.STEP_EVENT, t.tripId, dueAt, { tripId: t.tripId, phaseSeq: t.phaseSeq,
          round: t.watchRound }, slot.key);
        if (e && e.ok && !e.duplicate) enqueued += 1;
        else if (!e || !e.ok) log(`capsuleers: reconcile ${t.tripId} refused ${(e && e.reason) || "?"}`);
      }
      bump("tripsReconciled", enqueued);
      bump("reconcileExhausted", exhausted);
      setTrips(r.trips);
      return { ok: true, open: r.trips.length, enqueued, exhausted };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  return Object.freeze({
    dispatchInTx,
    sweepInTx,
    handler,
    onArrival,
    reconcile,
    setTrips,
    listTrips,
    getMemoryVersion: () => memoryVersion,
    getStatus: () => Object.freeze({ counters: Object.freeze({ ...counters }), tripsOpen: openCount(), lastRefusal }),
    stop() {
      state = "stopped";
    },
    isStopped: stopped,
  });
}

module.exports = { createRattingService, parseStepPayload, COUNTERS, ROUTE_SKIP_REASONS };
