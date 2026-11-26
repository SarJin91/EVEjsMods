"use strict";

const { performance } = require("node:perf_hooks");
const { KIND_APPLY } = require("../persistence/journal");
const { MAX_ID_LENGTH, FLEET_ROLES } = require("./schema");
const { STATE: EVENT_STATE } = require("../scheduler/schema");
const { jumpMsForComposition, buildLeg, positionAt, validateLegShape, LEG_VERSION_WH, hasWormholeEdges,
  gateSegments, wormholeCut } = require("./travel");
const { createWormholeTransits } = require("./wormholeTransits");
const { entryOf } = require("./grid/entry");

const MODE_TRAVEL = "travel";
const MODE_RETREAT = "retreat";
const PLAN_STATES = Object.freeze({
  travel: Object.freeze(["PLANNED", "TRAVELLING"]),
  retreat: Object.freeze(["TRAVELLING", "STAGED", "RETREATING"]),
});
const TARGET_STATE = Object.freeze({ travel: "TRAVELLING", retreat: "RETREATING" });
const IN_FLIGHT = Object.freeze(["TRAVELLING", "RETREATING"]);
const ARRIVAL_STATE = Object.freeze({ TRAVELLING: "STAGED", RETREATING: "REFITTING" });
const RELEASED_ON_COMPLETE = Object.freeze(["PLANNED", "STAGED"]);
const INPUT_KEYS = Object.freeze(["fleetId", "targetSystemId", "constraints", "at", "expectedVersion"]);
const ROUTE_REFUSALS = Object.freeze({ TOO_FAR: "TOO_FAR", UNREACHABLE: "UNREACHABLE", UNKNOWN_SYSTEM: "UNKNOWN_SYSTEM",
  INVALID_CONSTRAINTS: "INVALID_CONSTRAINTS" });
const RETREAT_SKIP_REASONS = Object.freeze(["SAME_SYSTEM", "TOO_FAR", "UNREACHABLE", "UNKNOWN_SYSTEM",
  "NO_RETREAT_TARGET", "FLEET_PINNED"]);
const RELEASE_KEYS = Object.freeze(["fleetId", "expectedVersion", "at", "disposition", "retreatTargets"]);
const REFIT_REQUEST_KEYS = Object.freeze(["fleetId", "expectedVersion", "at"]);
const BROKEN_EDGE = "BROKEN_EDGE";
const UNKNOWN_SYSTEM = "UNKNOWN_SYSTEM";
const MS_DECIMALS = 10;

const OUTCOME = Object.freeze({
  STALE: "STALE", ARRIVED: "ARRIVED", REPLANNED: "REPLANNED", HALTED: "ROUTE_BROKEN_HALTED", REFITTED: "REFITTED",
  WAITING: "WAITING", COMPLETED: "COMPLETED",
  RESEEK: "RESEEK", STRANDED: "STRANDED", SEEK_REFIT: "SEEK_REFIT", SEEK_GO: "SEEK_GO", SEEK_GAVE_UP: "SEEK_GAVE_UP",
});
const REFIT_MODE = Object.freeze({ LEGACY: "legacy", STATION: "station", PENDING: "pending" });
const POLICY_ANYWHERE = "anywhere";

const ADVICE_ROLE_COUNTERS = Object.freeze([...FLEET_ROLES, "other"].map((r) => `adviceRefused_${r}`));
const COUNTER_NAMES = Object.freeze(["planned", "replanned", "retreats", "arrivals", "staleArrivals", "routeBroken",
  "routeUnchecked", "accelerated", "refusals", "effectRefused", "refits", "operationsCompleted", "operationsOverdue",
  "listenerErrors", "refitAtStation", "reseek", "stranded", "refitSeek", "refitSeekGaveUp", "refitLegacy",
  "refitResumed", "refitSeekReadFailed", "refitRequested", "refitStationLost", "guardErrors",
  "wormholeReplanned", "wormholeHalted", "wormholeStale", "wormholeSyncHeld",
  "intercepts",
  "departureListenerErrors",
  "stagedInPlace",
  "gridRecordErrors",
  "routeAdvised", "routeAdviceRefused", "advisorErrors",
  "routeTooFar", "routeUnreachable", "routeAdviceRefusedTooFar", "routeAdviceRefusedNoPath",
  "routeAdviceRefusedNoPathTooFar", "replanAdviceHalted",
  "routeAdvisedSoft", "routeAdviceSoftKept",
  ...ADVICE_ROLE_COUNTERS]);
const ADVICE_DETAILS = Object.freeze(["FORTRESS_AVOID", "TRANSIT_RISK"]);
const INTERCEPT_KEYS = Object.freeze(["at", "expectedVersion", "fleetId", "legSeq", "systemIndex"]);
const STAGE_IN_PLACE_KEYS = Object.freeze(["at", "fleetId"]);
const CUT_ROUTE_REFUSALS = Object.freeze(["UNREACHABLE", "TOO_FAR", "SAME_SYSTEM", "WORMHOLE_CLOSES_EN_ROUTE",
  "WORMHOLE_NOT_YET_OPEN"]);
const WORMHOLE_SYNC_PENDING = "WORMHOLE_SYNC_PENDING";

const SAVEPOINT_ABORT = Symbol("travel-savepoint-abort");

const arrivalKey = (fleetId, legSeq) => `arrival:${fleetId}:${legSeq}`;
const refitKey = (fleetId, legSeq) => `refit:${fleetId}:${legSeq}`;
const opDoneKey = (operationId) => `opdone:${operationId}`;
const refitSeekKey = (fleetId, legSeq, round) => `refitseek:${fleetId}:${legSeq}:${round}`;
const shipCountOf = (fleet) => (Array.isArray(fleet.composition)
  ? fleet.composition.reduce((sum, e) => sum + (Number.isSafeInteger(e && e.count) ? e.count : 0), 0) : null);
const OPEN_EVENT_STATES = Object.freeze([EVENT_STATE.QUEUED, EVENT_STATE.CLAIMED, EVENT_STATE.RETRY]);

function invalid(detail) {
  return { ok: false, reason: "FLEET_INVALID_INPUT", detail };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isText(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH;
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function createTravel(deps) {
  const { store, repository, journal, clock, settings } = deps;
  const scheduler = deps.scheduler || null;
  const graph = deps.graph || null;
  const presence = deps.presence || null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getStations = typeof deps.getStations === "function" ? deps.getStations : null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const getWormholes = typeof deps.getWormholes === "function" ? deps.getWormholes : null;
  const transits = createWormholeTransits();
  const gridRecorder = deps.gridRecorder && typeof deps.gridRecorder.recordArrivalInTx === "function"
    ? deps.gridRecorder : null;
  const bootAt = clock.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let lastRefitMode = null;
  let lastRefusal = null;
  let stopped = false;
  const arrivalListeners = [];
  const departureGuards = [];
  const departureListeners = [];
  const routeAdvisors = [];

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    counters[name] += n;
    metric("count", `fleets.travel.${name}`, n);
  }

  function refusedCount(result) {
    bump("refusals");
    lastRefusal = result && result.reason ? String(result.reason) : "UNKNOWN";
    return result;
  }

  function schedulerReady() {
    try {
      return Boolean(scheduler && typeof scheduler.enqueue === "function" && typeof scheduler.getStatus === "function"
        && scheduler.getStatus().state === "ready");
    } catch (_err) {
      return false;
    }
  }

  function currentGraph() {
    try {
      const r = graph && typeof graph.getGraph === "function" ? graph.getGraph() : null;
      return r && r.ok === true && r.graph ? r.graph : null;
    } catch (_err) {
      return null;
    }
  }

  function refitMode() {
    let mode = REFIT_MODE.LEGACY;
    let locator = null;
    if (getStations && settings.refitPolicy !== POLICY_ANYWHERE) {
      let st = null;
      try {
        st = getStations();
      } catch (_err) {
        st = null;
      }
      let m = null;
      try {
        m = st && typeof st.getMode === "function" ? st.getMode() : null;
      } catch (_err) {
        m = "off";
      }
      if (m === null) mode = settings.stationsConfigured === true ? REFIT_MODE.PENDING : REFIT_MODE.LEGACY;
      else if (m === "ready" && (st.refitLocator || st.locator)) {
        mode = REFIT_MODE.STATION;
        locator = st.refitLocator || st.locator;
      } else if (m === "pending") mode = REFIT_MODE.PENDING;
    }
    if (getStations && mode !== lastRefitMode) {
      lastRefitMode = mode;
      if (logger) {
        try {
          logger.log(mode === REFIT_MODE.LEGACY ? "fleets: refit mode legacy - repair in place (no station service "
            + `or fleets.refitPolicy=${settings.refitPolicy})` : `fleets: refit mode ${mode}`);
        } catch (_err) {
        }
      }
    }
    return { mode, locator };
  }

  function observedRoute(systems) {
    if (clock.timeScale === undefined || clock.timeScale === 1) return true;
    try {
      if (!presence || typeof presence.getStatus !== "function") return true;
      const st = presence.getStatus();
      if (!st || st.available !== true || st.stale === true) return true;
      return systems.some((id) => presence.isObserved(id) === true);
    } catch (_err) {
      return true;
    }
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "TRAVEL_FAILED" };
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

  function validateInput(input, mode) {
    if (!isPlainObject(input)) return invalid("input");
    for (const key of Object.keys(input)) if (!INPUT_KEYS.includes(key)) return invalid(`input.${key}`);
    if (!isText(input.fleetId)) return invalid("fleetId");
    if (input.targetSystemId !== undefined && !isPositiveId(input.targetSystemId)) return invalid("targetSystemId");
    if (mode === MODE_TRAVEL && input.targetSystemId === undefined) return invalid("targetSystemId");
    if (input.at !== undefined && !isTime(input.at)) return invalid("at");
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion)
      || input.expectedVersion < 1)) return invalid("expectedVersion");
    return { ok: true };
  }

  function mapRoute(found) {
    if (found.reason === ROUTE_REFUSALS.TOO_FAR) return { ok: false, reason: "TOO_FAR", jumps: found.jumps };
    if (found.reason === ROUTE_REFUSALS.UNKNOWN_SYSTEM) return { ok: false, reason: "UNKNOWN_SYSTEM",
      detail: found.detail };
    if (found.reason === ROUTE_REFUSALS.INVALID_CONSTRAINTS) return { ok: false, reason: "INVALID_CONSTRAINTS",
      detail: found.detail };
    if (found.reason === ROUTE_REFUSALS.UNREACHABLE) return { ok: false, reason: "UNREACHABLE", detail: found.detail };
    return { ok: false, reason: "UNREACHABLE", detail: "ROUTE_FAILED" };
  }

  function wormholePlan(constraints, found, at, jumpMs) {
    if (!constraints || constraints.wormholes !== true) return { ok: true, legPart: {} };
    const edges = Array.isArray(found.wormholeEdges) ? found.wormholeEdges : [];
    const margin = Number.isSafeInteger(settings.wormholeExpiryMarginMs) ? settings.wormholeExpiryMarginMs : 0;
    for (const e of edges) {
      if (e.createdAt > 0 && at + (e.i + 1) * jumpMs < e.createdAt) {
        return { ok: false, reason: "WORMHOLE_NOT_YET_OPEN", pairKey: e.pairKey, i: e.i };
      }
    }
    for (const e of edges) {
      if (e.expiresAt > 0 && at + (e.i + 1) * jumpMs + margin > e.expiresAt) {
        return { ok: false, reason: "WORMHOLE_CLOSES_EN_ROUTE", pairKey: e.pairKey, i: e.i };
      }
    }
    return { ok: true, legPart: { constraints: JSON.parse(JSON.stringify(constraints)),
      wormholeEdges: edges.map((e) => ({ i: e.i, pairKey: e.pairKey, expiresAt: e.expiresAt })) } };
  }

  function planInTx(tx, input, idempotencyKey, opts) {
    if (stopped) return { ok: false, reason: "TRAVEL_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    const o = opts || {};
    const mode = o.mode === undefined ? MODE_TRAVEL : o.mode;
    if (mode !== MODE_TRAVEL && mode !== MODE_RETREAT) return invalid("opts.mode");
    const valid = validateInput(input, mode);
    if (!valid.ok) return valid;
    let fleet;
    if (mode === MODE_TRAVEL) {
      const read = repository.getFleet(tx, input.fleetId);
      if (!read.ok) return read;
      fleet = read.fleet;
      if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: input.fleetId };
      for (const guard of departureGuards.slice()) {
        let g;
        try {
          g = guard(tx, fleet, input, o);
        } catch (err) {
          bump("guardErrors");
          g = { ok: true };
        }
        if (!g || g.ok !== true) return { ok: false, reason: g && g.reason ? g.reason : "FLEET_PINNED",
          detail: g && g.detail };
      }
    }
    const seen = journal.findByKey(tx, idempotencyKey);
    if (!seen.ok) return seen;
    if (seen.found) {
      const e = seen.entry;
      if (e.kind === KIND_APPLY && e.aggregateType === "fleet" && e.aggregateId === input.fleetId) {
        return { ok: true, duplicate: true, journalId: e.journalId };
      }
      return { ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: e.journalId };
    }
    if (!schedulerReady()) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    const g = currentGraph();
    if (!g) return { ok: false, reason: "GRAPH_NOT_READY" };
    if (!fleet) {
      const read = repository.getFleet(tx, input.fleetId);
      if (!read.ok) return read;
      fleet = read.fleet;
    }
    if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: input.fleetId };
    if (input.expectedVersion !== undefined && fleet.version !== input.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: input.expectedVersion,
        actualVersion: fleet.version };
    }
    if (fleet.state === "ENGAGED") {
      if (!(mode === MODE_RETREAT && o.allowEngaged === true)) return { ok: false, reason: "FLEET_ENGAGED" };
    } else if (!PLAN_STATES[mode].includes(fleet.state)
      && !(mode === MODE_RETREAT && o.allowIdle === true && fleet.state === "IDLE")) {
      return { ok: false, reason: "STATE_NOT_TRAVELLABLE", state: fleet.state };
    }
    let target = input.targetSystemId;
    if (target === undefined) {
      target = fleet.homeSystemId;
      if (target === null || target === undefined) return { ok: false, reason: "NO_RETREAT_TARGET" };
    }
    const now = clock.now();
    const at = input.at === undefined ? now : input.at;
    if (at > now) return invalid("at: in the future");
    let start;
    if (o.startSystemId !== undefined) {
      if (!isPositiveId(o.startSystemId)) return invalid("opts.startSystemId");
      start = o.startSystemId;
    } else if (IN_FLIGHT.includes(fleet.state)) {
      const pos = positionAt(fleet, at);
      if (pos.inFlight && at < pos.departAt) return invalid("at: before the departure of the current leg");
      start = pos.systemId;
    } else {
      start = fleet.currentSystemId;
    }
    if (start === target) return { ok: false, reason: "SAME_SYSTEM", systemId: start };
    let found = g.findRoute(start, target, input.constraints);
    if (!found || found.ok !== true) {
      const m = mapRoute(found || {});
      bump(m.reason === "TOO_FAR" ? "routeTooFar" : "routeUnreachable");
      return m;
    }
    if (mode === MODE_TRAVEL && routeAdvisors.length > 0 && o.skipAdvice !== true) {
      const advised = adviseRoute(tx, g, fleet, { start, target, at }, found, input.constraints);
      if (!advised.ok) return advised;
      found = advised.found;
    }
    const systems = [...found.route];
    const base = jumpMsForComposition(fleet.composition, { timeFactor: settings.travelTimeFactor });
    if (!base.ok) return base;
    const observed = observedRoute(systems);
    const jumpMs = Math.max(1, clock.travelDurationMs(base.baseJumpMs, { observed }));
    const wh = wormholePlan(input.constraints, found, at, jumpMs);
    if (!wh.ok) return wh;
    const built = buildLeg({ systems, departAt: at, jumpMs, graphVersion: found.graphVersion, mode, observed,
      ...wh.legPart });
    if (!built.ok) return built;
    const leg = built.leg;
    const legSeq = fleet.legSeq + 1;
    return inSavepoint(tx, () => {
      const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: fleet.state, to: TARGET_STATE[mode], patch: { currentSystemId: start, targetSystemId: target, route: leg,
          routeGraphVersion: found.graphVersion, nextActionAt: leg.arriveAt, legSeq,
          ...(o.markRefitPending === true ? { refitPending: true } : {}) } }, idempotencyKey);
      if (!moved.ok) return moved;
      if (moved.duplicate) return { ok: true, duplicate: true, journalId: moved.journalId };
      let operationActivated = false;
      if (fleet.state === "PLANNED" && fleet.operationId !== null) {
        const op = repository.getOperation(tx, fleet.operationId);
        if (!op.ok) return op;
        if (op.operation && op.operation.state === "PLANNED") {
          const act = repository.transitionOperation(tx, { operationId: fleet.operationId,
            expectedVersion: op.operation.version, from: "PLANNED", to: "ACTIVE" }, `${idempotencyKey}:op-active`);
          if (!act.ok) return act;
          operationActivated = !act.duplicate;
        }
      }
      const rows = transits.insertForLegInTx(tx, { fleetId: fleet.fleetId, legSeq, leg });
      if (!rows.ok) return rows;
      if (mode === MODE_TRAVEL && departureListeners.length > 0) {
        notifyDeparture(tx, { fleetId: fleet.fleetId, factionId: fleet.factionId, fleetRole: fleet.fleetRole,
          shipCount: shipCountOf(fleet), operationId: fleet.operationId, legSeq, leg: { systems: [...leg.systems],
            departAt: leg.departAt,
            jumpMs: leg.jumpMs }, wormholes: hasWormholeEdges(leg), chained: o.chained === true });
      }
      const ev = scheduler.enqueue("FLEET_ARRIVAL", fleet.fleetId, leg.arriveAt, { fleetId: fleet.fleetId, legSeq },
        arrivalKey(fleet.fleetId, legSeq), { tx, chained: o.chained === true });
      if (!ev || ev.ok !== true) return { ok: false, reason: (ev && ev.reason) || "ENQUEUE_FAILED", stage: "arrival" };
      return { ok: true, duplicate: false, fleetId: fleet.fleetId, mode, from: fleet.state, legSeq,
        departAt: leg.departAt, arriveAt: leg.arriveAt, jumps: systems.length - 1, jumpMs, baseJumpMs: base.baseJumpMs,
        observed, version: moved.version, eventId: ev.duplicate ? ev.eventId : ev.event.eventId, operationActivated };
    });
  }

  function countPlan(result) {
    if (!result || result.ok !== true || result.duplicate) return;
    if (result.mode === MODE_RETREAT) bump("retreats");
    else if (IN_FLIGHT.includes(result.from)) bump("replanned");
    else bump("planned");
    if (!result.observed) bump("accelerated");
    metric("observe", "fleets.travel.jumps", result.jumps);
  }

  function planWith(mode, input, idempotencyKey) {
    const t0 = nowMs();
    const tx = store.transaction(mode === MODE_RETREAT ? "fleets.retreat" : "fleets.planTravel",
      (db) => planInTx(db, input, idempotencyKey, { mode }));
    let result;
    if (tx.ok) result = tx.value;
    else {
      result = { ok: false, reason: tx.reason || "TX_FAILED" };
      for (const field of ["code", "detail", "rows", "limit"]) if (tx[field] !== undefined) result[field] = tx[field];
    }
    metric("observe", "fleets.travel.planMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    if (!result || result.ok !== true) return refusedCount(result);
    countPlan(result);
    return result;
  }

  const planTravel = (input, key) => planWith(MODE_TRAVEL, input, key);
  const retreat = (input, key) => planWith(MODE_RETREAT, input, key);

  function getPosition(fleetId, at) {
    if (!isText(fleetId)) return invalid("fleetId");
    if (at !== undefined && !isTime(at)) return invalid("at");
    const tx = store.transaction("fleets.getPosition", (db) => repository.getFleet(db, fleetId));
    if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
    if (!tx.value.ok) return tx.value;
    const fleet = tx.value.fleet;
    if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId };
    return { ok: true, fleet, position: positionAt(fleet, at === undefined ? clock.now() : at) };
  }

  function readTx(label, fn) {
    const tx = store.transaction(label, fn);
    if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
    return tx.value;
  }

  const guard = (fn) => (ev, hctx) => {
    try {
      return fn(ev, hctx);
    } catch (err) {
      return { ok: false, reason: `HANDLER_FAILED: ${messageOf(err)}` };
    }
  };

  const effectOf = (fn) => (tx, ev) => {
    const r = fn(tx, ev);
    if (!r || r.ok !== true) {
      bump("effectRefused");
      return r || { ok: false, reason: "EFFECT_FAILED" };
    }
    return r;
  };

  function enqueueRefit(tx, fleetId, legSeq, due, chained) {
    const ev = scheduler.enqueue("FLEET_REFIT_COMPLETE", fleetId, due, { fleetId, legSeq }, refitKey(fleetId, legSeq),
      { tx, chained });
    if (!ev || ev.ok !== true) return { ok: false, reason: (ev && ev.reason) || "ENQUEUE_FAILED", stage: "refit" };
    return { ok: true };
  }

  function enqueueOperationDone(tx, operation, base, chained) {
    const ev = scheduler.enqueue("FLEET_OPERATION_COMPLETE", operation.operationId,
      Math.max(operation.dueAt, base), { operationId: operation.operationId, round: 0 },
      opDoneKey(operation.operationId), { tx, chained });
    if (!ev || ev.ok !== true) return { ok: false, reason: (ev && ev.reason) || "ENQUEUE_FAILED", stage: "opdone" };
    return { ok: true };
  }

  function arriveEffect(fleet, operation, systemId, base, atStation) {
    return effectOf((tx) => {
      const to = ARRIVAL_STATE[fleet.state];
      const refitDue = base + settings.refitMs;
      const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: fleet.state, to, patch: { currentSystemId: systemId, route: null, routeGraphVersion: null,
          nextActionAt: to === "REFITTING" ? refitDue : null } }, arrivalKey(fleet.fleetId, fleet.legSeq));
      if (!moved.ok) return moved;
      if (to === "REFITTING") {
        const r = enqueueRefit(tx, fleet.fleetId, fleet.legSeq, refitDue, true);
        if (!r.ok) return r;
        if (atStation === true) bump("refitAtStation");
      } else if (operation && operation.dueAt !== null && (operation.state === "PLANNED"
        || operation.state === "ACTIVE")) {
        const r = enqueueOperationDone(tx, operation, base, true);
        if (!r.ok) return r;
      }
      bump("arrivals");
      notifyArrival(tx, { fleetId: fleet.fleetId, factionId: fleet.factionId, systemId, at: base, state: to,
        legSeq: fleet.legSeq, fleetRole: fleet.fleetRole, entry: entryOf(fleet.route, systemId) },
      arrivalContext(fleet, operation, true));
      return { ok: true };
    });
  }

  function interceptInTx(tx, spec, idempotencyKey, opts) {
    if (stopped) return { ok: false, reason: "TRAVEL_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlainObject(spec) || Object.keys(spec).sort().join() !== INTERCEPT_KEYS.join()) return invalid("spec");
    if (!isText(spec.fleetId)) return invalid("fleetId");
    if (!Number.isSafeInteger(spec.expectedVersion) || spec.expectedVersion < 1) return invalid("expectedVersion");
    if (!Number.isSafeInteger(spec.legSeq) || spec.legSeq < 0) return invalid("legSeq");
    if (!Number.isSafeInteger(spec.systemIndex) || spec.systemIndex < 0) return invalid("systemIndex");
    if (!isTime(spec.at)) return invalid("at");
    if (!isText(idempotencyKey)) return invalid("idempotencyKey");
    const read = repository.getFleet(tx, spec.fleetId);
    if (!read.ok) return read;
    const fleet = read.fleet;
    if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: spec.fleetId };
    const seen = journal.findByKey(tx, idempotencyKey);
    if (!seen.ok) return seen;
    if (seen.found) {
      const e = seen.entry;
      if (e.kind === KIND_APPLY && e.aggregateType === "fleet" && e.aggregateId === spec.fleetId) {
        return { ok: true, duplicate: true, systemId: fleet.currentSystemId };
      }
      return { ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: e.journalId };
    }
    if (fleet.state !== "TRAVELLING" || fleet.legSeq !== spec.legSeq) {
      return { ok: false, reason: "STALE_LEG", state: fleet.state, legSeq: fleet.legSeq };
    }
    if (fleet.version !== spec.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: spec.expectedVersion,
        actualVersion: fleet.version };
    }
    const leg = fleet.route;
    if (!validateLegShape(leg).ok) return { ok: false, reason: "STALE_LEG", detail: "route" };
    if (hasWormholeEdges(leg)) return { ok: false, reason: "LEG_HAS_WORMHOLES" };
    const i = spec.systemIndex;
    const from = leg.departAt + i * leg.jumpMs;
    if (i <= 0 || i >= leg.systems.length - 1 || spec.at < from || spec.at >= from + leg.jumpMs) {
      return { ok: false, reason: "NOT_CROSSING", systemIndex: i };
    }
    let operation = null;
    if (fleet.operationId !== null) {
      const o = repository.getOperation(tx, fleet.operationId);
      if (!o.ok) return o;
      operation = o.operation;
    }
    const systemId = leg.systems[i];
    return inSavepoint(tx, () => {
      const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: "TRAVELLING", to: "STAGED", patch: { currentSystemId: systemId, route: null, routeGraphVersion: null,
          nextActionAt: null } }, idempotencyKey);
      if (!moved.ok) return moved;
      if (moved.duplicate) return { ok: true, duplicate: true, systemId };
      if (operation && operation.dueAt !== null && (operation.state === "PLANNED" || operation.state === "ACTIVE")) {
        const r = enqueueOperationDone(tx, operation, spec.at, Boolean(opts && opts.chained === true));
        if (!r.ok) return r;
      }
      bump("intercepts");
      notifyArrival(tx, { fleetId: fleet.fleetId, factionId: fleet.factionId, systemId, at: spec.at, state: "STAGED",
        legSeq: fleet.legSeq, fleetRole: fleet.fleetRole, intercepted: true, entry: entryOf(leg, systemId, i) },
      arrivalContext(fleet, operation, Boolean(opts && opts.chained === true)));
      return { ok: true, duplicate: false, systemId };
    });
  }

  function stageInPlaceInTx(tx, spec, idempotencyKey, opts) {
    if (stopped) return { ok: false, reason: "TRAVEL_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlainObject(spec) || Object.keys(spec).sort().join() !== STAGE_IN_PLACE_KEYS.join()) return invalid("spec");
    if (!isText(spec.fleetId)) return invalid("fleetId");
    if (!isTime(spec.at)) return invalid("at");
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) return invalid("idempotencyKey");
    const read = repository.getFleet(tx, spec.fleetId);
    if (!read.ok) return read;
    const fleet = read.fleet;
    if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: spec.fleetId };
    const seen = journal.findByKey(tx, idempotencyKey);
    if (!seen.ok) return seen;
    if (seen.found) {
      const e = seen.entry;
      if (e.kind === KIND_APPLY && e.aggregateType === "fleet" && e.aggregateId === spec.fleetId) {
        return { ok: true, duplicate: true, systemId: fleet.currentSystemId, operationActivated: false };
      }
      return { ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: e.journalId };
    }
    if (fleet.state !== "PLANNED" || fleet.operationId === null || fleet.operationId === undefined) {
      return { ok: false, reason: "NOT_PLANNED", state: fleet.state };
    }
    const o = repository.getOperation(tx, fleet.operationId);
    if (!o.ok) return o;
    const operation = o.operation;
    if (!operation || operation.dueAt === null || operation.dueAt === undefined
      || (operation.state !== "PLANNED" && operation.state !== "ACTIVE")) {
      return { ok: false, reason: "OPERATION_NOT_OPEN", operationId: fleet.operationId };
    }
    if (operation.targetSystemId !== fleet.currentSystemId) {
      return { ok: false, reason: "NOT_IN_TARGET", systemId: fleet.currentSystemId,
        targetSystemId: operation.targetSystemId };
    }
    const systemId = fleet.currentSystemId;
    return inSavepoint(tx, () => {
      const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: "PLANNED", to: "STAGED", patch: { route: null, routeGraphVersion: null, nextActionAt: null } },
      idempotencyKey);
      if (!moved.ok) return moved;
      if (moved.duplicate) return { ok: true, duplicate: true, systemId, operationActivated: false };
      let operationActivated = false;
      if (operation.state === "PLANNED") {
        const act = repository.transitionOperation(tx, { operationId: operation.operationId,
          expectedVersion: operation.version, from: "PLANNED", to: "ACTIVE" }, `${idempotencyKey}:op-active`);
        if (!act.ok) return act;
        operationActivated = !act.duplicate;
      }
      const r = enqueueOperationDone(tx, operation, spec.at, Boolean(opts && opts.chained === true));
      if (!r.ok) return r;
      bump("stagedInPlace");
      return { ok: true, duplicate: false, systemId, operationActivated };
    });
  }

  function notifyArrival(tx, arrival, context) {
    if (gridRecorder !== null) {
      try {
        gridRecorder.recordArrivalInTx(tx, Object.freeze({ ...arrival }), context);
      } catch (err) {
        if (!tx || tx.inTransaction === false) throw err;
        bump("gridRecordErrors");
      }
    }
    for (const fn of arrivalListeners.slice()) {
      try {
        fn(tx, Object.freeze({ ...arrival }));
      } catch (err) {
        if (!tx || tx.inTransaction === false) throw err;
        bump("listenerErrors");
      }
    }
  }

  function arrivalContext(fleet, operation, chained) {
    return Object.freeze({ fleet: Object.freeze({ fleetId: fleet.fleetId, factionId: fleet.factionId,
      fleetRole: fleet.fleetRole, composition: fleet.composition }),
    operation: operation ? Object.freeze({ operationType: operation.operationType, objective: operation.objective })
      : null, chained });
  }

  function addArrivalListener(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_LISTENER" };
    arrivalListeners.push(fn);
    let active = true;
    return { ok: true, remove() {
      if (!active) return;
      active = false;
      const i = arrivalListeners.indexOf(fn);
      if (i >= 0) arrivalListeners.splice(i, 1);
    } };
  }

  function notifyDeparture(tx, departure) {
    const frozen = Object.freeze({ ...departure, leg: Object.freeze({ ...departure.leg,
      systems: Object.freeze([...departure.leg.systems]) }) });
    for (const fn of departureListeners.slice()) {
      try {
        fn(tx, frozen);
      } catch (err) {
        if (!tx || tx.inTransaction === false) throw err;
        bump("departureListenerErrors");
      }
    }
  }

  function addDepartureListener(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_LISTENER" };
    departureListeners.push(fn);
    let active = true;
    return { ok: true, remove() {
      if (!active) return;
      active = false;
      const i = departureListeners.indexOf(fn);
      if (i >= 0) departureListeners.splice(i, 1);
    } };
  }

  function addDepartureGuard(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_GUARD" };
    departureGuards.push(fn);
    let active = true;
    return { ok: true, remove() {
      if (!active) return;
      active = false;
      const i = departureGuards.indexOf(fn);
      if (i >= 0) departureGuards.splice(i, 1);
    } };
  }

  function adviseRoute(tx, g, fleet, query, found, constraints) {
    let cur = found;
    let c = constraints;
    const who = Object.freeze({ fleetId: fleet.fleetId, factionId: fleet.factionId, fleetRole: fleet.fleetRole,
      shipCount: shipCountOf(fleet) });
    for (const fn of routeAdvisors.slice()) {
      const wormholes = Boolean(c && c.wormholes === true && Array.isArray(cur.wormholeEdges)
        && cur.wormholeEdges.length > 0);
      let advice;
      try {
        advice = fn(who, Object.freeze({ start: query.start, target: query.target, at: query.at, route: cur.route,
          wormholes }));
      } catch (err) {
        if (!tx || tx.inTransaction === false) throw err;
        bump("advisorErrors");
        continue;
      }
      if (advice === null || advice === undefined) continue;
      if (!isPlainObject(advice) || !Array.isArray(advice.avoidSystemIds)
        || !Number.isSafeInteger(advice.detourMaxJumps) || advice.detourMaxJumps < 0) {
        bump("advisorErrors");
        continue;
      }
      if ((advice.soft !== undefined && typeof advice.soft !== "boolean")
        || (advice.detail !== undefined && !ADVICE_DETAILS.includes(advice.detail))) {
        bump("advisorErrors");
        continue;
      }
      const soft = advice.soft === true;
      const detail = advice.detail || "FORTRESS_AVOID";
      const route = cur.route;
      const inside = advice.avoidSystemIds.filter((id, k, all) => all.indexOf(id) === k && route.indexOf(id) > 0
        && route.indexOf(id) < route.length - 1);
      if (inside.length === 0) continue;
      const base = c && Array.isArray(c.forbiddenSystems) ? c.forbiddenSystems : [];
      const c2 = { ...(c || {}), forbiddenSystems: [...base, ...inside.filter((id) => !base.includes(id))] };
      const alt = g.findRoute(query.start, query.target, c2);
      if (alt && alt.ok === true && alt.jumps - cur.jumps <= advice.detourMaxJumps) {
        cur = alt;
        c = c2;
        bump("routeAdvised");
        if (soft) bump("routeAdvisedSoft");
        continue;
      }
      if (soft) {
        bump("routeAdviceSoftKept");
        continue;
      }
      bump("routeAdviceRefused");
      bump(alt && alt.ok === true ? "routeAdviceRefusedTooFar" : "routeAdviceRefusedNoPath");
      if (!(alt && alt.ok === true) && alt && alt.reason === ROUTE_REFUSALS.TOO_FAR) bump("routeAdviceRefusedNoPathTooFar");
      bump(`adviceRefused_${FLEET_ROLES.includes(who.fleetRole) ? who.fleetRole : "other"}`);
      if (alt && alt.ok === true) return { ok: false, reason: "TOO_FAR", jumps: alt.jumps, detail };
      return { ...mapRoute(alt || {}), detail };
    }
    return { ok: true, found: cur, constraints: c };
  }

  function addRouteAdvisor(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_ADVISOR" };
    routeAdvisors.push(fn);
    let active = true;
    return { ok: true, remove() {
      if (!active) return;
      active = false;
      const i = routeAdvisors.indexOf(fn);
      if (i >= 0) routeAdvisors.splice(i, 1);
    } };
  }

  function releaseFromBattleInTx(tx, spec, idempotencyKey, opts) {
    if (stopped) return { ok: false, reason: "TRAVEL_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlainObject(spec)) return invalid("spec");
    for (const key of Object.keys(spec)) {
      if (!RELEASE_KEYS.includes(key)) return invalid(`spec.${key}`);
    }
    if (!isText(spec.fleetId)) return invalid("fleetId");
    if (!Number.isSafeInteger(spec.expectedVersion) || spec.expectedVersion < 1) return invalid("expectedVersion");
    if (!isTime(spec.at)) return invalid("at");
    if (spec.disposition !== "STAY" && spec.disposition !== "RETREAT") return invalid("disposition");
    const targets = spec.retreatTargets === undefined ? [] : spec.retreatTargets;
    if (!Array.isArray(targets) || !targets.every(isPositiveId)) return invalid("retreatTargets");
    const chained = Boolean(opts && opts.chained === true);
    const seen = journal.findByKey(tx, idempotencyKey);
    if (!seen.ok) return seen;
    if (seen.found) {
      const e = seen.entry;
      if (e.kind === KIND_APPLY && e.aggregateType === "fleet" && e.aggregateId === spec.fleetId) {
        return { ok: true, duplicate: true, disposition: null, retreatTo: null, legSeq: null };
      }
      return { ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: e.journalId };
    }
    if (!schedulerReady()) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    const read = repository.getFleet(tx, spec.fleetId);
    if (!read.ok) return read;
    const fleet = read.fleet;
    if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: spec.fleetId };
    if (fleet.version !== spec.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: spec.expectedVersion,
        actualVersion: fleet.version };
    }
    if (fleet.state !== "ENGAGED") return { ok: false, reason: "FLEET_NOT_ENGAGED", state: fleet.state };
    if (spec.disposition === "STAY") return stayInTx(tx, fleet, spec.at, idempotencyKey, chained);
    const rm = refitMode();
    if (rm.mode === REFIT_MODE.PENDING) return { ok: false, reason: "STATIONS_NOT_READY" };
    if (rm.mode === REFIT_MODE.STATION) {
      return releaseToStationInTx(tx, fleet, spec, targets, idempotencyKey, chained, rm.locator);
    }
    for (const target of targets) {
      const r = planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: target, at: spec.at,
        expectedVersion: fleet.version }, idempotencyKey, { mode: MODE_RETREAT, allowEngaged: true, chained });
      if (r.ok) {
        return { ok: true, duplicate: r.duplicate === true, disposition: "RETREATING", retreatTo: target,
          legSeq: r.duplicate ? null : r.legSeq };
      }
      if (!RETREAT_SKIP_REASONS.includes(r.reason)) return r;
    }
    const legSeq = fleet.legSeq + 1;
    const due = spec.at + settings.refitMs;
    return inSavepoint(tx, () => {
      const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: "ENGAGED", to: "REFITTING", patch: { nextActionAt: due, legSeq } }, idempotencyKey);
      if (!moved.ok) return moved;
      if (moved.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", fleetId: fleet.fleetId };
      const ev = enqueueRefit(tx, fleet.fleetId, legSeq, due, chained);
      if (!ev.ok) return ev;
      if (getStations) bump("refitLegacy");
      return { ok: true, duplicate: false, disposition: "REFITTING", retreatTo: null, legSeq };
    });
  }

  function enqueueSeek(tx, fleetId, legSeq, round, due, chained) {
    const ev = scheduler.enqueue("FLEET_REFIT_SEEK", fleetId, due, { fleetId, legSeq, round, at: due },
      refitSeekKey(fleetId, legSeq, round), { tx, chained });
    if (!ev || ev.ok !== true) return { ok: false, reason: (ev && ev.reason) || "ENQUEUE_FAILED", stage: "refitseek" };
    return { ok: true };
  }

  function targetList(here, ...lists) {
    const out = [];
    for (const list of lists) for (const id of list) if (id !== here && !out.includes(id)) out.push(id);
    return out;
  }

  function releaseToStationInTx(tx, fleet, spec, fallback, idempotencyKey, chained, locator) {
    const here = fleet.currentSystemId;
    const found = locator.findNearestStations(tx, { factionId: fleet.factionId, fromSystemId: here });
    if (!found || found.ok !== true) return found || { ok: false, reason: "STATIONS_READ_FAILED" };
    const legSeq = fleet.legSeq + 1;
    if (found.targets[0] === here) {
      const due = spec.at + settings.refitMs;
      return inSavepoint(tx, () => {
        const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
          from: "ENGAGED", to: "REFITTING", patch: { nextActionAt: due, legSeq, refitPending: true } }, idempotencyKey);
        if (!moved.ok) return moved;
        if (moved.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", fleetId: fleet.fleetId };
        const ev = enqueueRefit(tx, fleet.fleetId, legSeq, due, chained);
        if (!ev.ok) return ev;
        bump("refitAtStation");
        return { ok: true, duplicate: false, disposition: "REFITTING", retreatTo: null, legSeq };
      });
    }
    for (const target of targetList(here, found.targets, fallback)) {
      const r = planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: target, at: spec.at,
        expectedVersion: fleet.version }, idempotencyKey,
      { mode: MODE_RETREAT, allowEngaged: true, chained, markRefitPending: true });
      if (r.ok) {
        return { ok: true, duplicate: r.duplicate === true, disposition: "RETREATING", retreatTo: target,
          legSeq: r.duplicate ? null : r.legSeq };
      }
      if (!RETREAT_SKIP_REASONS.includes(r.reason)) return r;
    }
    return inSavepoint(tx, () => {
      const r = strandInTx(tx, fleet, { from: "ENGAGED", at: spec.at, key: idempotencyKey, chained });
      if (!r.ok) return r;
      return { ok: true, duplicate: false, disposition: "IDLE", retreatTo: null, legSeq };
    });
  }

  function strandInTx(tx, fleet, { from, at, key, chained, systemId }) {
    const legSeq = fleet.legSeq + 1;
    const patch = { legSeq, refitPending: true };
    if (systemId !== undefined) patch.currentSystemId = systemId;
    const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version, from,
      to: "IDLE", patch }, key);
    if (!moved.ok) return moved;
    if (moved.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", fleetId: fleet.fleetId };
    const ev = enqueueSeek(tx, fleet.fleetId, legSeq, 0, at + settings.refitSeekRecheckMs, chained);
    if (!ev.ok) return ev;
    bump("stranded");
    return { ok: true, legSeq };
  }

  function routable(from, list) {
    const g = currentGraph();
    if (!g) return [...list];
    return list.filter((id) => {
      try {
        const r = g.findRoute(from, id);
        return Boolean(r && r.ok === true && r.jumps > 0);
      } catch (_err) {
        return false;
      }
    });
  }

  function stationDecision(fleet, systemId, locator) {
    return readTx("fleets.arrivalStations", (tx) => {
      const has = locator.hasRepairStation(tx, fleet.factionId, systemId);
      if (!has || has.ok !== true) return has || { ok: false, reason: "STATIONS_READ_FAILED" };
      if (has.stationId !== null) return { ok: true, kind: "REFIT", targets: [] };
      const near = locator.findNearestStations(tx, { factionId: fleet.factionId, fromSystemId: systemId });
      if (!near || near.ok !== true) return near || { ok: false, reason: "STATIONS_READ_FAILED" };
      const targets = routable(systemId, targetList(systemId, near.targets));
      return { ok: true, kind: targets.length > 0 ? "SEEK" : "STRANDED", targets };
    });
  }

  function stationArrival(fleet, operation, systemId, base, locator, outcomeOfRefit) {
    const decision = stationDecision(fleet, systemId, locator);
    if (!decision.ok) return { ok: false, reason: decision.reason };
    if (decision.kind === "REFIT") {
      return { ok: true, outcome: outcomeOfRefit, effect: arriveEffect(fleet, operation, systemId, base, true) };
    }
    const strandEffect = (tx) => {
      const r = strandInTx(tx, fleet, { from: "RETREATING", at: base, key: arrivalKey(fleet.fleetId, fleet.legSeq),
        chained: true, systemId });
      if (!r.ok) return r;
      bump("arrivals");
      notifyArrival(tx, { fleetId: fleet.fleetId, factionId: fleet.factionId, systemId, at: base, state: "IDLE",
        legSeq: fleet.legSeq, fleetRole: fleet.fleetRole, entry: entryOf(fleet.route, systemId) },
      arrivalContext(fleet, operation, true));
      return { ok: true };
    };
    if (decision.kind === "STRANDED") return { ok: true, outcome: OUTCOME.STRANDED, effect: effectOf(strandEffect) };
    return { ok: true, outcome: OUTCOME.RESEEK, effect: effectOf((tx) => {
      for (const target of decision.targets) {
        const r = planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: target, at: base,
          expectedVersion: fleet.version }, `${arrivalKey(fleet.fleetId, fleet.legSeq)}:reseek`,
        { mode: MODE_RETREAT, startSystemId: systemId, chained: true });
        if (r.ok) {
          if (!r.duplicate) bump("reseek");
          return { ok: true };
        }
        if (!RETREAT_SKIP_REASONS.includes(r.reason)) return r;
      }
      return strandEffect(tx);
    }) };
  }

  function stayInTx(tx, fleet, at, idempotencyKey, chained) {
    let operation = null;
    if (fleet.operationId !== null) {
      const o = repository.getOperation(tx, fleet.operationId);
      if (!o.ok) return o;
      operation = o.operation;
    }
    const staged = Boolean(operation && operation.state === "ACTIVE" && operation.factionId === fleet.factionId);
    const to = staged ? "STAGED" : "IDLE";
    const seek = fleet.refitPending === true;
    const legSeq = seek ? fleet.legSeq + 1 : fleet.legSeq;
    return inSavepoint(tx, () => {
      const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: "ENGAGED", to, ...(seek ? { patch: { legSeq } } : {}) }, idempotencyKey);
      if (!moved.ok) return moved;
      if (moved.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", fleetId: fleet.fleetId };
      if (staged && operation.dueAt !== null) {
        const r = enqueueOperationDone(tx, operation, at, chained);
        if (!r.ok) return r;
      }
      if (seek) {
        const ev = enqueueSeek(tx, fleet.fleetId, legSeq, 0, at, chained);
        if (!ev.ok) return ev;
        bump("refitResumed");
      }
      return { ok: true, duplicate: false, disposition: to, retreatTo: null, legSeq };
    });
  }

  function wormholeHeld(ev) {
    if (settings.wormholeHold !== true || !getWormholes) return false;
    const recheckMs = settings.wormholeSyncHoldRecheckMs;
    if (!Number.isSafeInteger(recheckMs) || recheckMs < 1) return false;
    if (!Number.isSafeInteger(settings.wormholeSyncHoldMaxMs) || clock.now() - bootAt >= settings.wormholeSyncHoldMaxMs) {
      return false;
    }
    let synced = false;
    try {
      const wh = getWormholes();
      synced = Boolean(wh && typeof wh.isSynced === "function" && wh.isSynced() === true);
    } catch (_err) {
      synced = false;
    }
    if (synced) return false;
    const read = readTx("fleets.wormholeHoldRead", (tx) => repository.getFleet(tx, ev.payload.fleetId));
    return Boolean(read && read.ok === true && read.fleet && read.fleet.legSeq === ev.payload.legSeq
      && hasWormholeEdges(read.fleet.route));
  }

  function replanOrHalt(fleet, operation, systemId, at, rm, wormhole) {
    const leg = fleet.route;
    const constraints = leg.v === LEG_VERSION_WH ? leg.constraints : undefined;
    const station = rm.mode === REFIT_MODE.STATION;
    const halt = () => (station ? stationArrival(fleet, operation, systemId, at, rm.locator, OUTCOME.HALTED)
      : { ok: true, outcome: OUTCOME.HALTED, effect: arriveEffect(fleet, operation, systemId, at) });
    const g = currentGraph();
    let probe = null;
    try {
      probe = g ? g.findRoute(systemId, fleet.targetSystemId, constraints) : null;
    } catch (_err) {
      probe = null;
    }
    if (!probe || probe.ok !== true || !(probe.jumps > 0)) {
      if (wormhole) bump("wormholeHalted");
      return halt();
    }
    const stop = halt();
    if (!stop.ok) return stop;
    const mode = fleet.state === "RETREATING" ? MODE_RETREAT : MODE_TRAVEL;
    return { ok: true, outcome: OUTCOME.REPLANNED, effect: effectOf((tx, ev) => {
      const r = planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: fleet.targetSystemId, at,
        expectedVersion: fleet.version, ...(constraints === undefined ? {} : { constraints }) },
      `${arrivalKey(fleet.fleetId, fleet.legSeq)}:replan`, { mode, startSystemId: systemId, chained: true });
      if (r.ok) {
        if (!r.duplicate) bump(wormhole ? "wormholeReplanned" : "replanned");
        return { ok: true };
      }
      if (!CUT_ROUTE_REFUSALS.includes(r.reason)) return r;
      if (wormhole) bump("wormholeHalted");
      if (r.detail === "FORTRESS_AVOID") bump("replanAdviceHalted");
      return stop.effect(tx, ev);
    }) };
  }

  function onWormholeExpire(ev) {
    const p = ev.payload;
    if (!p || !isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0) {
      return { ok: false, reason: "WORMHOLE_EXPIRE_PAYLOAD_INVALID", permanent: true };
    }
    const read = readTx("fleets.wormholeExpireRead", (tx) => {
      const f = repository.getFleet(tx, p.fleetId);
      if (!f.ok) return f;
      const fleet = f.fleet;
      if (!fleet || fleet.legSeq !== p.legSeq || !IN_FLIGHT.includes(fleet.state) || !hasWormholeEdges(fleet.route)) {
        return { ok: true, fleet: null };
      }
      let operation = null;
      if (fleet.operationId !== null) {
        const o = repository.getOperation(tx, fleet.operationId);
        if (!o.ok) return o;
        operation = o.operation;
      }
      const t = transits.listForLeg(tx, fleet.fleetId, fleet.legSeq);
      if (!t.ok) return t;
      return { ok: true, fleet, operation, legTransits: t.transits };
    });
    if (!read.ok) return { ok: false, reason: read.reason };
    const fleet = read.fleet;
    const stale = () => {
      bump("wormholeStale");
      return { ok: true, outcome: OUTCOME.STALE };
    };
    if (!fleet || !validateLegShape(fleet.route).ok) return stale();
    const cut = wormholeCut(fleet.route, read.legTransits);
    if (!cut.cut || cut.at > clock.now()) return stale();
    const rm = fleet.state === "RETREATING" ? refitMode() : { mode: REFIT_MODE.LEGACY, locator: null };
    if (rm.mode === REFIT_MODE.PENDING) return { ok: false, reason: "STATIONS_NOT_READY" };
    return replanOrHalt(fleet, read.operation, cut.systemId, cut.at, rm, true);
  }

  function onArrival(ev) {
    const p = ev.payload;
    if (!p || !isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0) {
      return { ok: false, reason: "ARRIVAL_PAYLOAD_INVALID", permanent: true };
    }
    if (wormholeHeld(ev)) {
      bump("wormholeSyncHeld");
      return { ok: false, reason: WORMHOLE_SYNC_PENDING,
        deferUntil: clock.now() + settings.wormholeSyncHoldRecheckMs };
    }
    const read = readTx("fleets.arrivalRead", (tx) => {
      const f = repository.getFleet(tx, p.fleetId);
      if (!f.ok) return f;
      let operation = null;
      if (f.fleet && f.fleet.operationId !== null) {
        const o = repository.getOperation(tx, f.fleet.operationId);
        if (!o.ok) return o;
        operation = o.operation;
      }
      let legTransits = null;
      if (f.fleet && f.fleet.legSeq === p.legSeq && IN_FLIGHT.includes(f.fleet.state)
        && hasWormholeEdges(f.fleet.route)) {
        const t = transits.listForLeg(tx, f.fleet.fleetId, f.fleet.legSeq);
        if (!t.ok) return t;
        legTransits = t.transits;
      }
      return { ok: true, fleet: f.fleet, operation, legTransits };
    });
    if (!read.ok) return { ok: false, reason: read.reason };
    const fleet = read.fleet;
    if (!fleet || fleet.legSeq !== p.legSeq || !IN_FLIGHT.includes(fleet.state)) {
      bump("staleArrivals");
      return { ok: true, outcome: OUTCOME.STALE };
    }
    const leg = fleet.route;
    const shaped = validateLegShape(leg).ok;
    const base = shaped ? leg.arriveAt : ev.dueAt;
    const g = shaped ? currentGraph() : null;
    let brokenAt = null;
    if (g) {
      for (const part of gateSegments(leg)) {
        const checked = g.validateRoute(part.systems);
        if (checked && checked.ok === false) {
          if (checked.reason === BROKEN_EDGE) brokenAt = part.offset + checked.at;
          else if (checked.reason === UNKNOWN_SYSTEM && part.offset + checked.at > 0) {
            brokenAt = part.offset + checked.at - 1;
          }
          if (brokenAt === null) bump("routeUnchecked");
          break;
        }
      }
    } else {
      bump("routeUnchecked");
    }
    const rm = fleet.state === "RETREATING" ? refitMode() : { mode: REFIT_MODE.LEGACY, locator: null };
    if (rm.mode === REFIT_MODE.PENDING) return { ok: false, reason: "STATIONS_NOT_READY" };
    const station = rm.mode === REFIT_MODE.STATION;
    if (shaped && read.legTransits !== null) {
      const cut = wormholeCut(leg, read.legTransits);
      if (cut.cut) return replanOrHalt(fleet, read.operation, cut.systemId, cut.at, rm, true);
    }
    if (brokenAt === null) {
      if (station) {
        return stationArrival(fleet, read.operation, fleet.targetSystemId, base, rm.locator, OUTCOME.ARRIVED);
      }
      return { ok: true, outcome: OUTCOME.ARRIVED, effect: arriveEffect(fleet, read.operation, fleet.targetSystemId,
        base) };
    }
    bump("routeBroken");
    if (leg.v === LEG_VERSION_WH) {
      return replanOrHalt(fleet, read.operation, leg.systems[brokenAt], leg.departAt + (brokenAt + 1) * leg.jumpMs, rm,
        false);
    }
    const stuck = leg.systems[brokenAt];
    const at = leg.departAt + (brokenAt + 1) * leg.jumpMs;
    const probe = g.findRoute(stuck, fleet.targetSystemId);
    if (probe && probe.ok === true && probe.jumps > 0) {
      const mode = fleet.state === "RETREATING" ? MODE_RETREAT : MODE_TRAVEL;
      return { ok: true, outcome: OUTCOME.REPLANNED, effect: effectOf((tx) => {
        const r = planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: fleet.targetSystemId, at,
          expectedVersion: fleet.version }, `${arrivalKey(fleet.fleetId, fleet.legSeq)}:replan`,
        { mode, startSystemId: stuck, chained: true, skipAdvice: true });
        if (r.ok && !r.duplicate) bump("replanned");
        return r.ok ? { ok: true } : r;
      }) };
    }
    if (station) return stationArrival(fleet, read.operation, stuck, at, rm.locator, OUTCOME.HALTED);
    return { ok: true, outcome: OUTCOME.HALTED, effect: arriveEffect(fleet, read.operation, stuck, at) };
  }

  function onRefit(ev) {
    const p = ev.payload;
    if (!p || !isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0) {
      return { ok: false, reason: "REFIT_PAYLOAD_INVALID", permanent: true };
    }
    const rm = refitMode();
    const read = readTx("fleets.refitRead", (tx) => {
      const f = repository.getFleet(tx, p.fleetId);
      if (!f.ok || !f.fleet || f.fleet.refitPending !== true || rm.mode !== REFIT_MODE.STATION) return f;
      const has = rm.locator.hasRepairStation(tx, f.fleet.factionId, f.fleet.currentSystemId);
      if (!has || has.ok !== true) return has || { ok: false, reason: "STATIONS_READ_FAILED" };
      return { ok: true, fleet: f.fleet, stationLost: has.stationId === null };
    });
    if (!read.ok) return { ok: false, reason: read.reason };
    const fleet = read.fleet;
    if (!fleet || fleet.state !== "REFITTING" || fleet.legSeq !== p.legSeq) return { ok: true, outcome: OUTCOME.STALE };
    if (fleet.refitPending === true && rm.mode === REFIT_MODE.PENDING) {
      return { ok: false, reason: "STATIONS_NOT_READY" };
    }
    if (read.stationLost === true) {
      return { ok: true, outcome: OUTCOME.STRANDED, effect: effectOf((tx) => {
        const r = strandInTx(tx, fleet, { from: "REFITTING", at: ev.dueAt, key: `refit-done:${fleet.fleetId}:`
          + `${fleet.legSeq}`, chained: true });
        if (!r.ok) return r;
        bump("refitStationLost");
        return { ok: true };
      }) };
    }
    return { ok: true, outcome: OUTCOME.REFITTED, effect: effectOf((tx) => {
      const r = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version, from: "REFITTING",
        to: "IDLE", ...(fleet.refitPending === true ? { patch: { refitPending: false } } : {}) },
      `refit-done:${fleet.fleetId}:${fleet.legSeq}`);
      if (r.ok) bump("refits");
      return r;
    }) };
  }

  function stationSeekDecision(tx, fleet, locator) {
    const found = locator.findNearestStations(tx, { factionId: fleet.factionId, fromSystemId: fleet.currentSystemId });
    if (!found || found.ok !== true) return { ok: true, kind: "READ_FAILED", targets: [] };
    if (found.targets[0] === fleet.currentSystemId) return { ok: true, kind: "HERE", targets: [] };
    const targets = routable(fleet.currentSystemId, targetList(fleet.currentSystemId, found.targets));
    return { ok: true, kind: targets.length > 0 ? "GO" : "NONE", targets };
  }

  function refitInPlaceInTx(tx, fleet, at, key, chained) {
    const legSeq = fleet.legSeq + 1;
    const due = at + settings.refitMs;
    const moved = repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version, from: "IDLE",
      to: "REFITTING", patch: { nextActionAt: due, legSeq } }, `${key}:refit`);
    if (!moved.ok) return moved;
    if (moved.duplicate) return { ok: true, duplicate: true };
    const r = enqueueRefit(tx, fleet.fleetId, legSeq, due, chained);
    if (!r.ok) return r;
    return { ok: true, duplicate: false };
  }

  function goToStationInTx(tx, fleet, targets, at, key, chained) {
    for (const target of targets) {
      const r = planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: target, at, expectedVersion: fleet.version },
        `${key}:go`, { mode: MODE_RETREAT, allowIdle: true, chained });
      if (r.ok) return { ok: true, planned: true, duplicate: r.duplicate === true };
      if (!RETREAT_SKIP_REASONS.includes(r.reason)) return r;
    }
    return { ok: true, planned: false, duplicate: false };
  }

  function requestRefitInTx(tx, spec, idempotencyKey, opts) {
    if (stopped) return { ok: false, reason: "TRAVEL_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlainObject(spec)) return invalid("spec");
    for (const key of Object.keys(spec)) if (!REFIT_REQUEST_KEYS.includes(key)) return invalid(`spec.${key}`);
    if (!isText(spec.fleetId)) return invalid("fleetId");
    if (!Number.isSafeInteger(spec.expectedVersion) || spec.expectedVersion < 1) return invalid("expectedVersion");
    if (!isTime(spec.at)) return invalid("at");
    if (typeof idempotencyKey !== "string" || idempotencyKey === "") return invalid("idempotencyKey");
    const chained = Boolean(opts && opts.chained === true);
    if (!schedulerReady()) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    const read = repository.getFleet(tx, spec.fleetId);
    if (!read.ok) return read;
    const fleet = read.fleet;
    if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: spec.fleetId };
    if (fleet.version !== spec.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: spec.expectedVersion,
        actualVersion: fleet.version };
    }
    if (fleet.state !== "IDLE" || fleet.refitPending !== true) {
      return { ok: false, reason: "FLEET_NOT_STRANDED", state: fleet.state };
    }
    const none = { ok: true, outcome: "NONE", duplicate: false };
    const rm = refitMode();
    if (rm.mode === REFIT_MODE.PENDING) return none;
    const refit = (counter) => inSavepoint(tx, () => {
      const r = refitInPlaceInTx(tx, fleet, spec.at, idempotencyKey, chained);
      if (!r.ok) return r;
      if (!r.duplicate) {
        bump(counter);
        bump("refitRequested");
      }
      return { ok: true, outcome: "REFIT", duplicate: r.duplicate };
    });
    if (rm.mode === REFIT_MODE.LEGACY) return refit("refitLegacy");
    const d = stationSeekDecision(tx, fleet, rm.locator);
    if (d.kind === "READ_FAILED") {
      bump("refitSeekReadFailed");
      return none;
    }
    if (d.kind === "HERE") return refit("refitAtStation");
    if (d.kind === "NONE") return none;
    const g = goToStationInTx(tx, fleet, d.targets, spec.at, idempotencyKey, chained);
    if (!g.ok) return g;
    if (!g.planned) return none;
    if (!g.duplicate) {
      bump("refitSeek");
      bump("refitRequested");
    }
    return { ok: true, outcome: "GO", duplicate: g.duplicate };
  }

  function onRefitSeek(ev) {
    const p = ev.payload;
    if (!p || !isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0 || !Number.isSafeInteger(p.round)
      || p.round < 0 || !isTime(p.at)) {
      return { ok: false, reason: "REFIT_SEEK_PAYLOAD_INVALID", permanent: true };
    }
    const read = readTx("fleets.refitSeekRead", (tx) => repository.getFleet(tx, p.fleetId));
    if (!read.ok) return { ok: false, reason: read.reason };
    const fleet = read.fleet;
    if (!fleet || fleet.state === "DESTROYED" || fleet.refitPending !== true || fleet.legSeq !== p.legSeq) {
      return { ok: true, outcome: OUTCOME.STALE };
    }
    const key = refitSeekKey(fleet.fleetId, p.legSeq, p.round);
    const nextRound = () => {
      if (p.round + 1 >= settings.refitSeekMaxRounds) {
        bump("refitSeekGaveUp");
        return { ok: true, outcome: OUTCOME.SEEK_GAVE_UP };
      }
      const due = p.at + settings.refitSeekRecheckMs;
      return { ok: true, outcome: OUTCOME.WAITING, reschedule: { dueAt: due,
        payload: { fleetId: fleet.fleetId, legSeq: p.legSeq, round: p.round + 1, at: due },
        idempotencyKey: refitSeekKey(fleet.fleetId, p.legSeq, p.round + 1) } };
    };
    if (fleet.state !== "IDLE") return nextRound();
    const rm = refitMode();
    if (rm.mode === REFIT_MODE.PENDING) return nextRound();
    const refitHere = (counter) => ({ ok: true, outcome: OUTCOME.SEEK_REFIT, effect: effectOf((tx) => {
      const r = refitInPlaceInTx(tx, fleet, p.at, key, true);
      if (!r.ok) return r;
      if (!r.duplicate) bump(counter);
      return { ok: true };
    }) });
    if (rm.mode === REFIT_MODE.LEGACY) return refitHere("refitLegacy");
    const decided = readTx("fleets.refitSeekStations", (tx) => stationSeekDecision(tx, fleet, rm.locator));
    if (!decided || decided.ok !== true || decided.kind === "READ_FAILED") {
      bump("refitSeekReadFailed");
      return nextRound();
    }
    if (decided.kind === "HERE") return refitHere("refitAtStation");
    if (decided.kind === "NONE") return nextRound();
    const targets = decided.targets;
    return { ok: true, outcome: OUTCOME.SEEK_GO, effect: effectOf((tx) => {
      const g = goToStationInTx(tx, fleet, targets, p.at, key, true);
      if (!g.ok) return g;
      if (g.planned) {
        if (!g.duplicate) bump("refitSeek");
        return { ok: true };
      }
      const fallback = nextRound();
      if (!fallback.reschedule) return { ok: true };
      const n = fallback.reschedule;
      const ev2 = scheduler.enqueue("FLEET_REFIT_SEEK", fleet.fleetId, n.dueAt, n.payload, n.idempotencyKey,
        { tx, chained: true });
      if (!ev2 || ev2.ok !== true) return { ok: false, reason: (ev2 && ev2.reason) || "ENQUEUE_FAILED" };
      return { ok: true };
    }) };
  }

  function openArrivals(travelling) {
    let dueAt = null;
    for (const f of travelling) {
      const found = scheduler.findByKey(arrivalKey(f.fleetId, f.legSeq));
      if (!found || found.ok !== true) return { ok: false, reason: (found && found.reason) || "FIND_FAILED" };
      if (found.found && OPEN_EVENT_STATES.includes(found.event.state)) {
        dueAt = dueAt === null ? found.event.dueAt : Math.max(dueAt, found.event.dueAt);
      }
    }
    return { ok: true, dueAt };
  }

  function onOperationComplete(ev) {
    const p = ev.payload;
    if (!p || !isText(p.operationId) || !Number.isSafeInteger(p.round) || p.round < 0
      || (p.overdue !== undefined && (!Number.isSafeInteger(p.overdue) || p.overdue < 0))) {
      return { ok: false, reason: "OPERATION_PAYLOAD_INVALID", permanent: true };
    }
    const read = readTx("fleets.operationRead", (tx) => {
      const o = repository.getOperation(tx, p.operationId);
      if (!o.ok) return o;
      if (!o.operation) return { ok: true, operation: null, fleets: [] };
      const members = repository.listFleetsOfOperation(tx, p.operationId);
      if (!members.ok) return members;
      return { ok: true, operation: o.operation, fleets: members.fleets };
    });
    if (!read.ok) return { ok: false, reason: read.reason };
    const op = read.operation;
    if (!op || op.state !== "ACTIVE") return { ok: true, outcome: OUTCOME.STALE };
    const base = opDoneKey(op.operationId);
    const travelling = read.fleets.filter((f) => f.state === "TRAVELLING");
    if (travelling.length > 0) {
      const latest = Math.max(...travelling.map((f) => (isTime(f.nextActionAt) ? f.nextActionAt : 0)));
      if (latest > ev.dueAt) {
        return { ok: true, outcome: OUTCOME.WAITING, reschedule: { dueAt: latest,
          payload: { operationId: op.operationId, round: p.round + 1, overdue: 0 },
          idempotencyKey: `${base}:next:${p.round + 1}` } };
      }
      const open = openArrivals(travelling);
      if (!open.ok) return { ok: false, reason: open.reason };
      const prevOverdue = p.overdue === undefined ? 0 : p.overdue;
      if (open.dueAt !== null) {
        return { ok: true, outcome: OUTCOME.WAITING, reschedule: {
          dueAt: Math.max(ev.dueAt, open.dueAt) + settings.recheckMs,
          payload: { operationId: op.operationId, round: p.round + 1, overdue: prevOverdue },
          idempotencyKey: `${base}:next:${p.round + 1}` } };
      }
      const overdue = prevOverdue + 1;
      if (overdue > settings.maxOverdueRounds) {
        bump("operationsOverdue");
        return { ok: false, permanent: true, reason: `OPERATION_MEMBERS_OVERDUE: rounds=${p.round} fleets=`
          + travelling.map((f) => `${f.fleetId}@${f.nextActionAt}`).join(",") };
      }
      const stepMs = Math.min(settings.recheckMaxMs, settings.recheckMs * 2 ** (overdue - 1));
      return { ok: true, outcome: OUTCOME.WAITING, reschedule: { dueAt: ev.dueAt + stepMs,
        payload: { operationId: op.operationId, round: p.round + 1, overdue },
        idempotencyKey: `${base}:next:${p.round + 1}` } };
    }
    return { ok: true, outcome: OUTCOME.COMPLETED, effect: effectOf((tx) => {
      let arrived = 0;
      for (const f of read.fleets) {
        if (!RELEASED_ON_COMPLETE.includes(f.state)) continue;
        if (f.state === "STAGED") arrived += 1;
        const r = repository.transition(tx, { fleetId: f.fleetId, expectedVersion: f.version, from: f.state,
          to: "IDLE" }, `${base}:fleet:${f.fleetId}`);
        if (!r.ok) return { ...r, fleetId: f.fleetId };
      }
      const closed = repository.transitionOperation(tx, { operationId: op.operationId, expectedVersion: op.version,
        from: "ACTIVE", to: "COMPLETED", result: { arrived } }, `${base}:close`);
      if (closed.ok) bump("operationsCompleted");
      return closed;
    }) };
  }

  const handlers = Object.freeze({
    FLEET_ARRIVAL: guard(onArrival),
    FLEET_REFIT_COMPLETE: guard(onRefit),
    FLEET_OPERATION_COMPLETE: guard(onOperationComplete),
    FLEET_REFIT_SEEK: guard(onRefitSeek),
    WORMHOLE_EXPIRE: guard(onWormholeExpire),
  });

  function getCounters() {
    return Object.freeze({ ...counters, lastRefusal });
  }

  function stop() {
    stopped = true;
  }

  return Object.freeze({ planInTx, releaseFromBattleInTx, requestRefitInTx, interceptInTx, stageInPlaceInTx,
    planTravel, retreat, getPosition, positionAt, handlers,
    addArrivalListener, addDepartureGuard, addDepartureListener, addRouteAdvisor, getCounters, stop, isStopped: () => stopped, refitMode: () => refitMode().mode });
}

module.exports = { createTravel, OUTCOME, REFIT_MODE, arrivalKey, refitKey, opDoneKey, refitSeekKey, RETREAT_SKIP_REASONS };
