"use strict";

const { gridPositionAt, isVisitValid } = require("./position");
const { anchorRef, controlPointOf } = require("./anchors");
const repo = require("./visitRepository");
const { ANCHOR_KINDS, PURPOSE, UNCAPPED_PURPOSES, VIA } = require("./schema");
const { workTargetOf, workRuleOf, TARGET } = require("./work");
const { inSystemMoveMs } = require("./moveTime");
const { alignRawOf } = require("./transit");

const VIA_GATE = VIA.GATE;
const EVENT_TYPE = "FLEET_GRID_ARRIVAL";
const MOVABLE_STATES = Object.freeze(["IDLE", "STAGED"]);
const ARRIVAL_STATES = Object.freeze(["IDLE", "STAGED", "PLANNED"]);
const MINER_SCAN_STATES = Object.freeze(["IDLE", "STAGED"]);
const MINER_ROLE = "mining";
const WORK_ARRIVAL_STATE = "STAGED";
const OUTCOME = Object.freeze({ STALE: "STALE", ARRIVED: "ARRIVED" });
const MAX_FLEET_ID = 64;
const SAVEPOINT_ABORT = Symbol("grid-move-savepoint-abort");
const PURPOSE_VALUES = Object.freeze(Object.values(PURPOSE));
const MAX_GROUP_MEMBERS = 16;

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isFleetId = (v) => typeof v === "string" && v.length >= 1 && v.length <= MAX_FLEET_ID;
const isAnchorRef = (a) => Boolean(a) && typeof a === "object" && ANCHOR_KINDS.includes(a.kind) && isPosInt(a.id);
const detailOf = (err) => String((err && err.message) || err);
const refuse = (reason, detail) => ({ ok: false, reason, ...(detail === undefined ? {} : { detail: String(detail) }) });

function gridArrivalKey(fleetId, legSeq, moveSeq) {
  return `grid:${fleetId}:${legSeq}:${moveSeq}`;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "spec";
  if (!isFleetId(spec.fleetId)) return "fleetId";
  if (!isPosInt(spec.systemId)) return "systemId";
  if (!isNonNegInt(spec.legSeq)) return "legSeq";
  if (!isNonNegInt(spec.at)) return "at";
  if (!isAnchorRef(spec.to)) return "to";
  if (!PURPOSE_VALUES.includes(spec.purpose)) return "purpose";
  if (spec.targetFleetId !== undefined && spec.targetFleetId !== null && !isFleetId(spec.targetFleetId)) {
    return "targetFleetId";
  }
  if (spec.attempts !== undefined && !isNonNegInt(spec.attempts)) return "attempts";
  if (spec.expectedMoveSeq !== undefined && !isNonNegInt(spec.expectedMoveSeq)) return "expectedMoveSeq";
  return null;
}

function createGridMoves(deps) {
  const { store, repository, clock, settings, systemGrid, bump, observe } = deps;
  const scheduler = deps.scheduler || null;
  const worldSeed = deps.worldSeed;
  const listeners = [];
  let lastRefusal = null;
  let override = null;

  const schedulerReady = () => Boolean(scheduler) && typeof scheduler.enqueue === "function";

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || refuse("ENQUEUE_FAILED");
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

  function sysOf(systemId) {
    const s = systemGrid(systemId);
    if (s.ok) return { ok: true, sys: s.entry };
    return { ok: false, reason: s.reason, sys: { systemId, anchors: [], byRef: new Map(), gridOf: new Map(),
      cp: controlPointOf([], systemId) } };
  }

  function readFleetAndVisit(tx, fleetId) {
    const f = repository.getFleet(tx, fleetId);
    if (!f || f.ok !== true) return f || refuse("FLEET_READ_FAILED");
    const v = repo.getManyInTx(tx, [fleetId]);
    if (!v.ok) return v;
    return { ok: true, fleet: f.fleet, visit: v.visits.get(fleetId) || null };
  }

  function moveInTx(tx, spec, opts) {
    return moveWith(tx, spec, opts, false);
  }

  function moveWith(tx, spec, opts, alignHold) {
    if (!deps.isEnabled()) return refuse("GRID_OFF");
    if (!deps.movesEnabled()) return refuse("MOVES_OFF");
    if (!tx || tx.inTransaction !== true) return refuse("TX_REQUIRED");
    const bad = validateSpec(spec);
    if (bad !== null) return refuse("INVALID_INPUT", bad);
    if (!schedulerReady()) return refuse("SCHEDULER_UNAVAILABLE");
    try {
      const plan = prepareMove(tx, spec, alignHold);
      if (!plan.ok) return plan;
      if (plan.sameGrid) {
        bump("movesSameGrid");
        return { ok: true, moved: false, reason: "SAME_GRID", gridKey: plan.gridKey };
      }
      const chained = Boolean(opts && opts.chained === true);
      const r = inSavepoint(tx, () => writeMove(tx, plan, plan.arriveAt, chained));
      if (r && r.ok === true) {
        bump("movesPlanned");
        if (plan.departAt > spec.at) bump("alignHeld");
        observe("moveMs", plan.moveMs);
      }
      return r;
    } catch (err) {
      if (!tx || tx.inTransaction === false) throw err;
      return refuse("MOVE_FAILED", detailOf(err));
    }
  }

  function prepareMove(tx, spec, alignHold) {
    const read = readFleetAndVisit(tx, spec.fleetId);
    if (!read.ok) return read;
    const { fleet, visit } = read;
    if (!fleet) return refuse("FLEET_NOT_FOUND");
    if (!MOVABLE_STATES.includes(fleet.state)) return refuse("NOT_MOVABLE", fleet.state);
    if (fleet.currentSystemId !== spec.systemId || fleet.legSeq !== spec.legSeq) return refuse("STALE_FLEET");
    const s = systemGrid(spec.systemId);
    if (!s.ok) return refuse("ANCHORS_UNAVAILABLE", s.reason);
    const sys = s.entry;
    const toRef = anchorRef(spec.to.kind, spec.to.id);
    const toAnchor = sys.byRef.get(toRef);
    if (!toAnchor) return refuse("TARGET_UNKNOWN", toRef);
    const valid = isVisitValid(fleet, visit);
    const pos = gridPositionAt(fleet, visit, spec.at, sys);
    if (pos.kind === "warp") return refuse("IN_WARP");
    if (valid && (spec.at < visit.arrivedAt || (visit.departAt !== null && spec.at < visit.departAt))) {
      return refuse("INVALID_INPUT", "at");
    }
    const gridKey = sys.gridOf.get(toRef) || toRef;
    if (pos.gridKey === gridKey) return { ok: true, sameGrid: true, gridKey };
    const current = valid ? visit.moveSeq : 0;
    const freshMoveSeq = visit && visit.legSeq === spec.legSeq ? visit.moveSeq + 1 : 1;
    if (valid && current >= settings.maxMovesPerVisit && !UNCAPPED_PURPOSES.includes(spec.purpose)) {
      bump("movesLimited");
      return refuse("MOVE_LIMIT");
    }
    if (spec.expectedMoveSeq !== undefined && spec.expectedMoveSeq !== current) return refuse("STALE_VISIT");
    const time = inSystemMoveMs(fleet.composition, { position: pos.position || null }, toAnchor,
      { timeFactor: settings.timeFactor });
    if (!time.ok) return time;
    const moveMs = Math.max(1, clock.travelDurationMs(time.baseMs, { observed: false }));
    let departAt = spec.at;
    if (alignHold === true && settings.crossingsEnabled === true && pos.anchorKind === "gate") {
      const alignRaw = alignRawOf(time.hullGroup);
      if (alignRaw > settings.lockMs) {
        const held = clock.travelDurationMs(Math.round(settings.timeFactor * alignRaw), { observed: false });
        departAt = spec.at + Math.min(moveMs - 1, Math.max(0, Number.isFinite(held) ? Math.round(held) : 0));
      }
    }
    return { ok: true, sameGrid: false, spec, valid, current, freshMoveSeq, gridKey, moveMs, departAt,
      arriveAt: spec.at + moveMs, from: Object.freeze({ kind: pos.anchorKind, id: pos.anchorId }),
      to: Object.freeze({ kind: toAnchor.kind, id: toAnchor.id }) };
  }

  function writeMove(tx, plan, arriveAt, chained) {
    const spec = plan.spec;
    const w = repo.writeMoveInTx(tx, { fleetId: spec.fleetId, systemId: spec.systemId, legSeq: spec.legSeq,
      fresh: !plan.valid, expectedMoveSeq: plan.current, moveSeq: plan.freshMoveSeq, at: plan.from, to: plan.to,
      departAt: plan.departAt, arriveAt, purpose: spec.purpose,
      targetFleetId: spec.targetFleetId === undefined ? null : spec.targetFleetId,
      attempts: spec.attempts === undefined ? 0 : spec.attempts });
    if (!w.ok) return w;
    if (!w.written) return refuse("STALE_VISIT");
    const ev = scheduler.enqueue(EVENT_TYPE, spec.fleetId, arriveAt, { fleetId: spec.fleetId,
      systemId: spec.systemId, legSeq: spec.legSeq, moveSeq: w.moveSeq },
    gridArrivalKey(spec.fleetId, spec.legSeq, w.moveSeq), { tx, chained });
    if (!ev || ev.ok !== true) return refuse("ENQUEUE_FAILED", (ev && ev.reason) || "no result");
    if (ev.duplicate === true) return refuse("ENQUEUE_DUPLICATE");
    return { ok: true, moved: true, moveSeq: w.moveSeq, departAt: plan.departAt, arriveAt, from: plan.from, to: plan.to,
      gridKey: plan.gridKey };
  }

  function moveGroupInTx(tx, spec, opts) {
    if (!deps.isEnabled()) return refuse("GRID_OFF");
    if (!deps.movesEnabled()) return refuse("MOVES_OFF");
    if (!tx || tx.inTransaction !== true) return refuse("TX_REQUIRED");
    const members = spec && Array.isArray(spec.members) ? spec.members : null;
    if (!members || members.length < 1 || members.length > MAX_GROUP_MEMBERS
      || new Set(members.map((m) => m && m.fleetId)).size !== members.length
      || !members.every((m) => m && typeof m === "object" && isNonNegInt(m.expectedMoveSeq))) {
      return refuse("GROUP_INVALID");
    }
    const specs = members.map((m) => ({ fleetId: m.fleetId, systemId: spec.systemId, legSeq: m.legSeq, at: spec.at,
      to: spec.to, purpose: spec.purpose, targetFleetId: spec.targetFleetId, attempts: spec.attempts,
      expectedMoveSeq: m.expectedMoveSeq }));
    for (const s of specs) {
      const bad = validateSpec(s);
      if (bad !== null) return { ...refuse("INVALID_INPUT", bad), fleetId: String(s.fleetId) };
    }
    if (!schedulerReady()) return refuse("SCHEDULER_UNAVAILABLE");
    try {
      const plans = [];
      const sameGrid = [];
      for (const s of specs) {
        const plan = prepareMove(tx, s);
        if (!plan.ok) return { ...plan, fleetId: s.fleetId };
        if (plan.sameGrid) sameGrid.push(s.fleetId);
        else plans.push(plan);
      }
      if (plans.length === 0) {
        bump("movesSameGrid", sameGrid.length);
        return { ok: true, arriveAt: null, moved: [], sameGrid };
      }
      const arriveAt = Math.max(...plans.map((p) => p.arriveAt));
      const chained = Boolean(opts && opts.chained === true);
      const r = inSavepoint(tx, () => {
        const moved = [];
        for (const plan of plans) {
          const w = writeMove(tx, plan, arriveAt, chained);
          if (!w || w.ok !== true) return { ...(w || refuse("MOVE_FAILED")), fleetId: plan.spec.fleetId };
          moved.push(Object.freeze({ fleetId: plan.spec.fleetId, moveSeq: w.moveSeq }));
        }
        return { ok: true, arriveAt, moved, sameGrid };
      });
      if (r && r.ok === true) {
        bump("movesPlanned", plans.length);
        if (sameGrid.length > 0) bump("movesSameGrid", sameGrid.length);
        for (const plan of plans) observe("moveMs", arriveAt - plan.spec.at);
      }
      return r;
    } catch (err) {
      if (!tx || tx.inTransaction === false) throw err;
      return refuse("MOVE_FAILED", detailOf(err));
    }
  }

  function refused(fleetId, r) {
    bump("movesRefused");
    lastRefusal = Object.freeze({ reason: String((r && r.reason) || "MOVE_FAILED"), fleetId: String(fleetId) });
    return r && r.ok === false ? r : refuse("MOVE_FAILED");
  }

  function planWorkMoveInTx(tx, arrival, context) {
    if (!deps.movesEnabled()) return { ok: true, moved: false, reason: "MOVES_OFF" };
    if (!context || !context.fleet || !arrival) return { ok: true, moved: false, reason: "NO_CONTEXT" };
    if (arrival.state !== WORK_ARRIVAL_STATE || arrival.intercepted === true) {
      return { ok: true, moved: false, reason: "NOT_WORK_ARRIVAL" };
    }
    const fleet = context.fleet;
    const operation = context.operation || null;
    if (override !== null) {
      let decision = null;
      try {
        decision = override({ fleet, operation, arrival });
      } catch (_err) {
        decision = null;
        bump("workOverrideErrors");
      }
      if (decision && decision.kind === "STAY") {
        bump("movesDeferred");
        return { ok: true, moved: false, reason: "DEFERRED", rule: String(decision.rule || "OVERRIDE") };
      }
    }
    const s = systemGrid(arrival.systemId);
    if (!s.ok) return refused(arrival.fleetId, refuse("ANCHORS_UNAVAILABLE", s.reason));
    let miners = [];
    const rule = workRuleOf(operation, fleet.fleetRole);
    if (rule.target === TARGET.BELT_HOSTILE_MINER || rule.target === TARGET.BELT_OWN_MINER) {
      const page = repository.listFleetsInSystem(tx, arrival.systemId, { states: [...MINER_SCAN_STATES],
        limit: settings.workTargetScanFleets });
      if (!page || page.ok !== true) return refused(arrival.fleetId, page);
      miners = page.fleets.filter((f) => f.fleetRole === MINER_ROLE)
        .map((f) => ({ fleetId: f.fleetId, factionId: f.factionId }));
    }
    const target = workTargetOf({ fleet, operation, sys: s.entry, worldSeed, miners });
    if (target.missing) bump("workTargetMissing");
    if (target.kind === "STAY") {
      bump("movesStay");
      return { ok: true, moved: false, reason: "STAY" };
    }
    const viaGate = Boolean(arrival.entry && arrival.entry.via === VIA_GATE);
    const r = moveWith(tx, { fleetId: arrival.fleetId, systemId: arrival.systemId, legSeq: arrival.legSeq,
      at: arrival.at, to: target.anchor, purpose: PURPOSE.WORK, expectedMoveSeq: 0 },
    { chained: context.chained === true }, viaGate);
    if (!r || r.ok !== true) return refused(arrival.fleetId, r);
    return r.moved ? { ok: true, moved: true } : { ok: true, moved: false, reason: r.reason };
  }

  function isStale(fleet, visit, p) {
    return !fleet || !ARRIVAL_STATES.includes(fleet.state) || fleet.currentSystemId !== p.systemId
      || fleet.legSeq !== p.legSeq || !isVisitValid(fleet, visit) || visit.moveSeq !== p.moveSeq
      || visit.arriveAt === null;
  }

  function payloadOf(fleet, visit) {
    const { sys } = sysOf(visit.systemId);
    const pos = gridPositionAt(fleet, visit, visit.arriveAt, sys);
    return Object.freeze({ fleetId: fleet.fleetId, factionId: fleet.factionId, fleetRole: fleet.fleetRole,
      systemId: visit.systemId, legSeq: visit.legSeq, moveSeq: visit.moveSeq, at: visit.arriveAt,
      purpose: visit.purpose, targetFleetId: visit.targetFleetId, gridKey: pos.gridKey,
      anchor: Object.freeze({ kind: pos.anchorKind, id: pos.anchorId }), source: pos.source });
  }

  function onGridArrival(ev) {
    const p = ev && ev.payload;
    if (!p || !isFleetId(p.fleetId) || !isPosInt(p.systemId) || !isNonNegInt(p.legSeq) || !isPosInt(p.moveSeq)) {
      return { ok: false, permanent: true, reason: "GRID_ARRIVAL_PAYLOAD_INVALID" };
    }
    if (!deps.movesEnabled()) {
      bump("moveArrivalsStale");
      return { ok: true, outcome: OUTCOME.STALE, detail: "MOVES_OFF" };
    }
    const tx = store.transaction("fleets.gridArrivalRead", (db) => readFleetAndVisit(db, p.fleetId));
    if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
    const read = tx.value;
    if (!read || read.ok !== true) return { ok: false, reason: (read && read.reason) || "TX_FAILED" };
    if (isStale(read.fleet, read.visit, p)) {
      bump("moveArrivalsStale");
      return { ok: true, outcome: OUTCOME.STALE };
    }
    if (listeners.length === 0) {
      bump("moveArrivals");
      return { ok: true, outcome: OUTCOME.ARRIVED };
    }
    return { ok: true, outcome: OUTCOME.ARRIVED, effect: (etx) => {
      const again = readFleetAndVisit(etx, p.fleetId);
      if (!again.ok) return again;
      if (isStale(again.fleet, again.visit, p)) {
        bump("moveArrivalsStale");
        return { ok: true };
      }
      const payload = payloadOf(again.fleet, again.visit);
      for (const fn of listeners.slice()) {
        try {
          fn(etx, payload);
        } catch (err) {
          if (!etx || etx.inTransaction === false) throw err;
          bump("gridListenerErrors");
        }
      }
      bump("moveArrivals");
      return { ok: true };
    } };
  }

  const guard = (fn) => (ev, hctx) => {
    try {
      return fn(ev, hctx);
    } catch (err) {
      return { ok: false, reason: `HANDLER_FAILED: ${detailOf(err)}` };
    }
  };

  function addWorkTargetOverride(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_LISTENER" };
    if (override !== null) return { ok: false, reason: "OVERRIDE_TAKEN" };
    override = fn;
    let active = true;
    return { ok: true, remove() {
      if (!active) return;
      active = false;
      if (override === fn) override = null;
    } };
  }

  function addGridArrivalListener(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_LISTENER" };
    listeners.push(fn);
    let active = true;
    return { ok: true, remove() {
      if (!active) return;
      active = false;
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    } };
  }

  return Object.freeze({ moveInTx, moveGroupInTx, planWorkMoveInTx, addGridArrivalListener, addWorkTargetOverride,
    handlers: Object.freeze({ [EVENT_TYPE]: guard(onGridArrival) }), getLastRefusal: () => lastRefusal,
    clearListeners: () => {
      override = null;
      return listeners.splice(0);
    } });
}

module.exports = { createGridMoves, gridArrivalKey, GRID_ARRIVAL_EVENT: EVENT_TYPE };
