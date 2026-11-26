"use strict";

const S = require("./schema");

const SAVEPOINT_ABORT = Symbol("player-hunt-pursuit-abort");
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const UNAVAILABLE = Object.freeze({ ok: false, reason: "PURSUIT_UNAVAILABLE" });
const FLEET_IDLE = "IDLE";
const MAX_ID_LENGTH = 64;
const PURSUE_KEYS = Object.freeze(["huntId", "at", "targetSystemId", "constraints"]);
const NEXT_KEYS = Object.freeze(["chainId", "hop", "fleetId", "expectedVersion", "fromSystemId", "targetSystemId",
  "at", "constraints"]);
const RETURN_KEYS = Object.freeze(["huntId", "at", "reason", "targetSystemId", "constraints"]);
const HOME_KEYS = Object.freeze(["chainId", "fleetId", "expectedVersion", "fromSystemId", "targetSystemId", "at",
  "constraints"]);
const APPROACH_KEYS = HOME_KEYS;
const NO_RETURN_REASONS = Object.freeze(["PURSUIT", "SPAWN_FAILED"]);

const isText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const txMissing = (tx) => !tx || tx.inTransaction !== true;

function invalid(detail) {
  return { ok: false, reason: "PLAYER_HUNT_INVALID_INPUT", detail };
}

function unknownKey(obj, allowed) {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

function createPursuitWriter(deps) {
  const repo = deps.repo;
  const getFleets = typeof deps.getFleets === "function" ? deps.getFleets : () => null;

  function fleetsOf() {
    let fleets = null;
    try {
      fleets = getFleets();
    } catch (_err) {
      fleets = null;
    }
    const repository = fleets && fleets.repository;
    const travel = fleets && fleets.travel;
    if (!repository || typeof repository.createOperation !== "function" || typeof repository.getFleet !== "function"
      || !travel || typeof travel.planInTx !== "function") return null;
    return { repository, travel };
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "PURSUIT_FAILED" };
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

  function legInTx(tx, F, leg, key) {
    const op = F.repository.createOperation(tx, { operationType: leg.operationType || S.PURSUIT_OPERATION_TYPE,
      objective: leg.objective || S.PURSUIT_OBJECTIVE, factionId: leg.factionId, originSystemId: leg.fromSystemId,
      targetSystemId: leg.targetSystemId, dueAt: leg.at,
      fleets: [{ fleetId: leg.fleetId, expectedVersion: leg.fleetVersion }] }, `${key}:op`);
    if (!op || op.ok !== true) return op || { ok: false, reason: "OPERATION_FAILED" };
    if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:op` };
    const plan = F.travel.planInTx(tx, { fleetId: leg.fleetId, targetSystemId: leg.targetSystemId, at: leg.at,
      constraints: leg.constraints }, `${key}:plan`);
    if (!plan || plan.ok !== true) return plan || { ok: false, reason: "PLAN_FAILED" };
    if (plan.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:plan` };
    return { ok: true, operationId: op.operationId, fleetVersion: plan.version, arriveAt: plan.arriveAt,
      jumps: plan.jumps };
  }

  function pursueInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, PURSUE_KEYS);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.huntId, S.MAX_HUNT_ID_LENGTH)) return invalid("huntId");
    if (!isTime(req.at)) return invalid("at");
    if (!isPositiveId(req.targetSystemId)) return invalid("targetSystemId");
    if (!isPlainObject(req.constraints)) return invalid("constraints");
    const F = fleetsOf();
    if (!F) return UNAVAILABLE;
    const read = repo.readInTx(tx, req.huntId);
    if (!read || read.ok !== true) return read || { ok: false, reason: "READ_FAILED" };
    const hunt = read.hunt;
    if (!hunt) return { ok: false, reason: "HUNT_NOT_FOUND", huntId: req.huntId };
    if (hunt.state === "ENDED") return { ok: false, reason: "ALREADY_ENDED", huntId: req.huntId };
    if (hunt.systemId === req.targetSystemId) return { ok: false, reason: "SAME_SYSTEM" };
    return endThenLeg(tx, F, hunt, req, S.PURSUIT_END_REASON, S.pursueKey(req.huntId), {});
  }

  function endThenLeg(tx, F, hunt, req, reason, key, op) {
    return inSavepoint(tx, () => {
      const end = repo.endInTx(tx, { huntId: req.huntId, at: req.at, reason });
      if (!end || end.ok !== true) return end || { ok: false, reason: "END_FAILED" };
      if (end.duplicate) return { ok: false, reason: "ALREADY_ENDED", huntId: req.huntId };
      if (end.outcome === "DESTROYED") return { ok: false, reason: "FLEET_DESTROYED", huntId: req.huntId };
      const got = F.repository.getFleet(tx, hunt.fleetId);
      if (!got || got.ok !== true) return got || { ok: false, reason: "READ_FAILED" };
      if (!got.fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: hunt.fleetId };
      const leg = legInTx(tx, F, { ...op, factionId: hunt.factionId, fleetId: hunt.fleetId,
        fleetVersion: got.fleet.version, fromSystemId: hunt.systemId, targetSystemId: req.targetSystemId, at: req.at,
        constraints: req.constraints }, key);
      if (!leg.ok) return leg;
      return { ok: true, operationId: leg.operationId, fleetId: hunt.fleetId, fleetVersion: leg.fleetVersion,
        arriveAt: leg.arriveAt, jumps: leg.jumps, losses: end.losses,
        ...(end.repel !== undefined ? { repel: end.repel } : {}) };
    });
  }

  function endWithReturnInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, RETURN_KEYS);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.huntId, S.MAX_HUNT_ID_LENGTH)) return invalid("huntId");
    if (!isTime(req.at)) return invalid("at");
    if (!S.END_REASONS.includes(req.reason) || NO_RETURN_REASONS.includes(req.reason)) return invalid("reason");
    if (!isPositiveId(req.targetSystemId)) return invalid("targetSystemId");
    if (!isPlainObject(req.constraints)) return invalid("constraints");
    const F = fleetsOf();
    if (!F) return UNAVAILABLE;
    const read = repo.readInTx(tx, req.huntId);
    if (!read || read.ok !== true) return read || { ok: false, reason: "READ_FAILED" };
    const hunt = read.hunt;
    if (!hunt) return { ok: false, reason: "HUNT_NOT_FOUND", huntId: req.huntId };
    if (hunt.state === "ENDED") return { ok: false, reason: "ALREADY_ENDED", huntId: req.huntId };
    if (hunt.systemId === req.targetSystemId) return { ok: false, reason: "SAME_SYSTEM" };
    return endThenLeg(tx, F, hunt, req, req.reason, S.returnKey(req.huntId),
      { operationType: S.RETURN_OPERATION_TYPE, objective: S.RETURN_OBJECTIVE });
  }

  function pursueNextInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, NEXT_KEYS);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.chainId, S.MAX_HUNT_ID_LENGTH)) return invalid("chainId");
    if (!Number.isSafeInteger(req.hop) || req.hop < 2) return invalid("hop");
    if (!isText(req.fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
    if (!Number.isSafeInteger(req.expectedVersion) || req.expectedVersion < 1) return invalid("expectedVersion");
    if (!isPositiveId(req.fromSystemId)) return invalid("fromSystemId");
    if (!isPositiveId(req.targetSystemId)) return invalid("targetSystemId");
    if (!isTime(req.at)) return invalid("at");
    if (!isPlainObject(req.constraints)) return invalid("constraints");
    return idleLeg(tx, req, S.hopKey(req.chainId, req.hop), {});
  }

  function idleLeg(tx, req, key, op) {
    const F = fleetsOf();
    if (!F) return UNAVAILABLE;
    const got = F.repository.getFleet(tx, req.fleetId);
    if (!got || got.ok !== true) return got || { ok: false, reason: "READ_FAILED" };
    const fleet = got.fleet;
    if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: req.fleetId };
    if (fleet.state !== FLEET_IDLE) return { ok: false, reason: "FLEET_NOT_IDLE", state: fleet.state };
    if (fleet.version !== req.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: req.expectedVersion,
        actualVersion: fleet.version };
    }
    if (fleet.currentSystemId !== req.fromSystemId) {
      return { ok: false, reason: "FLEET_ELSEWHERE", systemId: fleet.currentSystemId };
    }
    if (fleet.operationId !== null && fleet.operationId !== undefined) {
      return { ok: false, reason: "FLEET_HAS_OPERATION", operationId: fleet.operationId };
    }
    if (fleet.refitPending === true) return { ok: false, reason: "REFIT_PENDING" };
    if (req.fromSystemId === req.targetSystemId) return { ok: false, reason: "SAME_SYSTEM" };
    return inSavepoint(tx, () => legInTx(tx, F, { ...op, factionId: fleet.factionId, fleetId: fleet.fleetId,
      fleetVersion: fleet.version, fromSystemId: req.fromSystemId, targetSystemId: req.targetSystemId, at: req.at,
      constraints: req.constraints }, key));
  }

  function returnHomeInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, HOME_KEYS);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.chainId, S.MAX_HUNT_ID_LENGTH)) return invalid("chainId");
    if (!isText(req.fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
    if (!Number.isSafeInteger(req.expectedVersion) || req.expectedVersion < 1) return invalid("expectedVersion");
    if (!isPositiveId(req.fromSystemId)) return invalid("fromSystemId");
    if (!isPositiveId(req.targetSystemId)) return invalid("targetSystemId");
    if (!isTime(req.at)) return invalid("at");
    if (!isPlainObject(req.constraints)) return invalid("constraints");
    return idleLeg(tx, req, S.homeKey(req.chainId),
      { operationType: S.RETURN_OPERATION_TYPE, objective: S.RETURN_OBJECTIVE });
  }

  function approachInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, APPROACH_KEYS);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.chainId, S.MAX_HUNT_ID_LENGTH)) return invalid("chainId");
    if (!isText(req.fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
    if (!Number.isSafeInteger(req.expectedVersion) || req.expectedVersion < 1) return invalid("expectedVersion");
    if (!isPositiveId(req.fromSystemId)) return invalid("fromSystemId");
    if (!isPositiveId(req.targetSystemId)) return invalid("targetSystemId");
    if (!isTime(req.at)) return invalid("at");
    if (!isPlainObject(req.constraints)) return invalid("constraints");
    return idleLeg(tx, req, S.approachKey(req.chainId), {});
  }

  return Object.freeze({ pursueInTx, pursueNextInTx, endWithReturnInTx, returnHomeInTx, approachInTx });
}

module.exports = { createPursuitWriter };
