"use strict";

const { defineTable, updateWithVersion, toBind } = require("../persistence/repository");
const { membersOf, lossesOf } = require("../playerHunt/huntRepository");
const S = require("./schema");

const T = S.TABLE_NAME;
const EXPOSURE_TABLE = defineTable({ name: T, idColumn: "exposure_id",
  columns: ["state", "members_json", "ended_at", "end_reason", "losses_json", "updated_at"] });
const COLUMNS = "exposure_id, fleet_id, faction_id, kind, system_id, operation_id, from_state, leg_seq, character_id, "
  + "state, members_json, started_at, ended_at, end_reason, losses_json, updated_at, version";
const MAX_ID_LENGTH = 64;
const MAX_OPERATION_ID_LENGTH = 96;
const MAX_MEMBER_KEY_LENGTH = 128;
const MAX_LIST_LIMIT = 1000;
const FLEET_STAGED = "STAGED";
const FLEET_IDLE = "IDLE";
const FLEET_REFITTING = "REFITTING";
const FLEET_MATERIALIZED = "MATERIALIZED";
const FLEET_DESTROYED = "DESTROYED";
const FLEET_GONE = "FLEET_GONE";
const PRESENCE = "PRESENCE";
const INITIAL_VERSION = 1;
const OPERATION_GONE_REASONS = Object.freeze(["OPERATION_NOT_FOUND", "OPERATION_CLOSED", "FLEET_FACTION_MISMATCH"]);
const EVENT = Object.freeze({ CLAIM: "FLEET_EXPOSURE_CLAIMED", LOSS: "FLEET_EXPOSURE_LOSS",
  END: "FLEET_EXPOSURE_ENDED" });
const END_ROWS = 6 + 1;
const CLAIM_FIELDS = Object.freeze(["exposureId", "fleetId", "expectedVersion", "kind", "systemId", "operationId",
  "at", "characterId", "members", "destroyed", "crossing"]);

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isIndex = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typeOf = (typeId) => (typeId === undefined ? null : typeId);

function invalid(detail) {
  return { ok: false, reason: "FLEET_EXPOSURE_INVALID_INPUT", detail };
}

function unknownKey(obj, allowed) {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

function parseJson(text) {
  return text === null || text === undefined ? null : JSON.parse(text);
}

function toExposure(row) {
  return {
    exposureId: row.exposure_id, fleetId: row.fleet_id, factionId: row.faction_id, kind: row.kind,
    systemId: row.system_id, operationId: row.kind === PRESENCE && row.operation_id === S.NO_OPERATION_ID ? null
      : row.operation_id, fromState: row.from_state, legSeq: row.leg_seq,
    characterId: row.character_id, state: row.state, members: JSON.parse(row.members_json),
    startedAt: row.started_at, endedAt: row.ended_at, endReason: row.end_reason, losses: parseJson(row.losses_json),
    updatedAt: row.updated_at, version: row.version,
  };
}

function validateClaim(spec) {
  if (!isPlainObject(spec)) return invalid("spec");
  const extra = unknownKey(spec, CLAIM_FIELDS);
  if (extra !== undefined) return invalid(`spec: field ${extra}`);
  const missing = CLAIM_FIELDS.find((k) => !has(spec, k));
  if (missing !== undefined) return invalid(`spec: missing ${missing}`);
  if (!isText(spec.fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
  if (!Number.isSafeInteger(spec.expectedVersion) || spec.expectedVersion < 1) return invalid("expectedVersion");
  if (!isText(spec.exposureId, S.MAX_EXPOSURE_ID_LENGTH)
    || spec.exposureId !== S.exposureIdOf(spec.fleetId, spec.expectedVersion)) return invalid("exposureId");
  if (!S.KINDS.includes(spec.kind)) return invalid("kind");
  if (!isPositiveId(spec.systemId)) return invalid("systemId");
  if (!(spec.kind === PRESENCE && spec.operationId === null) && !isText(spec.operationId, MAX_OPERATION_ID_LENGTH)) {
    return invalid("operationId");
  }
  if (!isTime(spec.at)) return invalid("at");
  if (spec.characterId !== null && !isPositiveId(spec.characterId)) return invalid("characterId");
  if (!Array.isArray(spec.members) || spec.members.length === 0) return invalid("members");
  const keys = new Set();
  for (const m of spec.members) {
    if (!isPlainObject(m) || unknownKey(m, ["memberKey", "hullGroup", "typeId"]) !== undefined) return invalid("members");
    if (!isText(m.memberKey, MAX_MEMBER_KEY_LENGTH) || !isText(m.hullGroup, MAX_MEMBER_KEY_LENGTH)) {
      return invalid("members");
    }
    if (m.typeId !== null && m.typeId !== undefined && !isPositiveId(m.typeId)) return invalid("members");
    if (keys.has(m.memberKey)) return invalid("members: duplicate memberKey");
    keys.add(m.memberKey);
  }
  if (!Array.isArray(spec.destroyed) || new Set(spec.destroyed).size !== spec.destroyed.length
    || !spec.destroyed.every((k) => keys.has(k))) return invalid("destroyed");
  if (spec.kind === "CONVOY" || (spec.kind === PRESENCE && spec.crossing !== null)) {
    const c = spec.crossing;
    if (!isPlainObject(c) || unknownKey(c, ["legSeq", "systemIndex"]) !== undefined || !isIndex(c.legSeq)
      || !isIndex(c.systemIndex)) return invalid("crossing");
    if (spec.kind === PRESENCE && !isText(spec.operationId, MAX_OPERATION_ID_LENGTH)) return invalid("operationId");
  } else if (spec.crossing !== null) return invalid("crossing");
  return { ok: true };
}

const unwrap = (r) => (r.reason === "APPLY_REFUSED" ? r.refusal : r);

function releaseTargetOf(fromState, fleet, at) {
  if (fromState === FLEET_IDLE) return { to: FLEET_IDLE, patch: {} };
  if (fromState !== FLEET_REFITTING) return { to: FLEET_STAGED, patch: {} };
  if (Number.isSafeInteger(fleet.nextActionAt) && at < fleet.nextActionAt) return { to: FLEET_REFITTING, patch: {} };
  return { to: FLEET_IDLE, patch: fleet.refitPending === true ? { refitPending: false } : {} };
}

function callReleaseContact(hook, db, info) {
  if (hook === null) return;
  try {
    hook(db, info);
  } catch (_err) {
  }
}

function createExposureRepository(deps) {
  const { journal, fleetRepository } = deps || {};
  if (!journal || typeof journal.applyOnce !== "function") {
    throw new TypeError("createExposureRepository: journal.applyOnce required");
  }
  for (const fn of ["getFleet", "transition", "applyLosses"]) {
    if (!fleetRepository || typeof fleetRepository[fn] !== "function") {
      throw new TypeError(`createExposureRepository: fleetRepository.${fn} required`);
    }
  }
  const getTravel = typeof deps.getTravel === "function" ? deps.getTravel : () => null;
  const getCrews = typeof deps.getCrews === "function" ? deps.getCrews : () => null;
  const crewMaxRows = Number.isSafeInteger(deps.crewMaxRows) && deps.crewMaxRows > 0 ? deps.crewMaxRows : undefined;
  const releaseContact = typeof deps.releaseContact === "function" ? deps.releaseContact : null;

  function crewLossInTx(db, fleetId, at, key) {
    try {
      const crews = getCrews();
      if (!crews || typeof crews.reconcileGuardedInTx !== "function") return;
      crews.reconcileGuardedInTx(db, fleetId, { cause: "LIVE", at, ...(crewMaxRows ? { maxRows: crewMaxRows } : {}) },
        key);
    } catch (err) {
      if (!db || db.inTransaction !== true) throw err;
    }
  }

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      byId: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE exposure_id = ?`),
      openOfFleet: db.prepare(`SELECT exposure_id FROM ${T} WHERE fleet_id = ? AND state = 'HELD'`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      listOpen: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state = 'HELD' AND exposure_id > ?
        ORDER BY exposure_id LIMIT ?`),
    };
    perDb.set(db, s);
    return s;
  }

  const txMissing = (tx) => !tx || tx.inTransaction !== true;

  function travelOf() {
    try {
      const t = getTravel();
      return t && typeof t.interceptInTx === "function" ? t : null;
    } catch (_err) {
      return null;
    }
  }

  function checkFleet(fleet, spec) {
    if (!S.ROLES_OF_KIND[spec.kind].includes(fleet.fleetRole)) {
      return { ok: false, reason: "FLEET_NOT_EXPOSABLE", detail: "fleetRole", fleetRole: fleet.fleetRole };
    }
    const crossingState = spec.kind === PRESENCE && (spec.crossing !== null) !== (fleet.state === S.CROSSING_STATE);
    if (!S.CLAIM_STATES_OF_KIND[spec.kind].includes(fleet.state) || crossingState) {
      return { ok: false, reason: "FLEET_NOT_EXPOSABLE", detail: "state", state: fleet.state };
    }
    const fleetOperationId = fleet.operationId === undefined ? null : fleet.operationId;
    if (fleetOperationId !== spec.operationId) {
      return { ok: false, reason: "FLEET_NOT_EXPOSABLE", detail: "operationId", operationId: fleet.operationId };
    }
    if (spec.crossing === null) {
      if (fleet.currentSystemId !== spec.systemId) {
        return { ok: false, reason: "FLEET_NOT_EXPOSABLE", detail: "systemId", systemId: fleet.currentSystemId };
      }
      return { ok: true };
    }
    if (fleet.legSeq !== spec.crossing.legSeq) {
      return { ok: false, reason: "STALE_LEG", state: fleet.state, legSeq: fleet.legSeq };
    }
    const systems = fleet.route && Array.isArray(fleet.route.systems) ? fleet.route.systems : null;
    if (!systems || systems[spec.crossing.systemIndex] !== spec.systemId) {
      return { ok: false, reason: "STALE_LEG", detail: "systemId" };
    }
    return { ok: true };
  }

  function checkMembers(fleet, spec) {
    const known = new Map(membersOf(fleet.fleetId, fleet.composition).map((m) => [m.memberKey, m]));
    for (const m of spec.members) {
      const k = known.get(m.memberKey);
      if (!k || k.hullGroup !== m.hullGroup || k.typeId !== typeOf(m.typeId)) {
        return invalid(`members: ${m.memberKey} not in the fleet composition`);
      }
    }
    return { ok: true };
  }

  function claimInTx(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateClaim(spec);
    if (!valid.ok) return valid;
    const id = spec.exposureId;
    const destroyed = [...spec.destroyed].sort();
    const payload = { exposureId: id, fleetId: spec.fleetId, kind: spec.kind, systemId: spec.systemId,
      operationId: spec.operationId, at: spec.at, characterId: spec.characterId,
      memberKeys: spec.members.map((m) => m.memberKey).sort(), destroyed,
      crossing: spec.crossing === null ? null : { legSeq: spec.crossing.legSeq, systemIndex: spec.crossing.systemIndex } };
    const result = journal.applyOnce(tx, { key: S.claimKey(id), aggregate: { type: S.AGGREGATE, id },
      eventType: EVENT.CLAIM, payload }, (db) => {
      const got = fleetRepository.getFleet(db, spec.fleetId);
      if (!got.ok) return got;
      let fleet = got.fleet;
      if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: spec.fleetId };
      if (fleet.version !== spec.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: spec.expectedVersion,
          actualVersion: fleet.version };
      }
      const s = stmts(db);
      const open = s.openOfFleet.get(spec.fleetId);
      if (open) return { ok: false, reason: "EXPOSURE_OPEN", exposureId: open.exposure_id };
      const fit = checkFleet(fleet, spec);
      if (!fit.ok) return fit;
      const members = checkMembers(fleet, spec);
      if (!members.ok) return members;
      if (spec.crossing !== null) {
        const travel = travelOf();
        if (!travel) return { ok: false, reason: "TRAVEL_UNAVAILABLE" };
        const halt = travel.interceptInTx(db, { fleetId: spec.fleetId, expectedVersion: spec.expectedVersion,
          legSeq: spec.crossing.legSeq, systemIndex: spec.crossing.systemIndex, at: spec.at }, S.haltKey(id));
        if (!halt.ok) return halt;
        if (halt.duplicate) return { ok: false, reason: "HALT_ALREADY_APPLIED", exposureId: id };
        if (halt.systemId !== spec.systemId) return { ok: false, reason: "STALE_LEG", systemId: halt.systemId };
        const after = fleetRepository.getFleet(db, spec.fleetId);
        if (!after.ok) return after;
        if (!after.fleet || after.fleet.state !== FLEET_STAGED) {
          return { ok: false, reason: "STALE_LEG", detail: "not STAGED after the halt" };
        }
        fleet = after.fleet;
      }
      const fromState = spec.kind === PRESENCE ? fleet.state : FLEET_STAGED;
      const lock = fleetRepository.transition(db, { fleetId: spec.fleetId, expectedVersion: fleet.version,
        from: fromState, to: FLEET_MATERIALIZED, patch: {} }, S.lockKey(id));
      if (!lock.ok) return lock;
      if (lock.duplicate) return { ok: false, reason: "LOCK_ALREADY_APPLIED", exposureId: id };
      const lost = new Set(destroyed);
      const rows = spec.members.map((m) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup, typeId: typeOf(m.typeId),
        state: lost.has(m.memberKey) ? "DESTROYED" : "SPAWNED" }));
      s.insert.run(id, spec.fleetId, toBind(fleet.factionId), spec.kind, toBind(spec.systemId),
        spec.operationId === null ? S.NO_OPERATION_ID : spec.operationId,
        spec.kind === PRESENCE ? fromState : S.FROM_STATE_OF_KIND[spec.kind], toBind(fleet.legSeq), spec.characterId === null ? null
          : toBind(spec.characterId), "HELD", JSON.stringify(rows), toBind(spec.at), null, null, null, toBind(spec.at),
        toBind(INITIAL_VERSION));
      return { ok: true };
    });
    if (!result.ok) return unwrap(result);
    const row = stmts(tx).byId.get(id);
    return { ok: true, duplicate: result.duplicate === true, exposure: row ? toExposure(row) : null };
  }

  function markDestroyedInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, ["exposureId", "memberKey", "at"]);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.exposureId, S.MAX_EXPOSURE_ID_LENGTH)) return invalid("exposureId");
    if (!isText(req.memberKey, MAX_MEMBER_KEY_LENGTH)) return invalid("memberKey");
    if (!isTime(req.at)) return invalid("at");
    const read = stmts(tx).byId.get(req.exposureId);
    if (!read) return { ok: false, reason: "EXPOSURE_NOT_FOUND", exposureId: req.exposureId };
    const known = JSON.parse(read.members_json).find((m) => m.memberKey === req.memberKey);
    if (!known) return { ok: false, reason: "MEMBER_NOT_FOUND", memberKey: req.memberKey };
    if (known.state === "DESTROYED") return { ok: true, duplicate: true };
    if (read.state !== "HELD") return { ok: false, reason: "NOT_HELD", state: read.state };
    const result = journal.applyOnce(tx, { key: S.lossKey(req.exposureId, req.memberKey),
      aggregate: { type: S.AGGREGATE, id: req.exposureId }, eventType: EVENT.LOSS,
      payload: { exposureId: req.exposureId, memberKey: req.memberKey, at: req.at } }, (db) => {
      const row = stmts(db).byId.get(req.exposureId);
      if (!row || row.state !== "HELD") return { ok: false, reason: "NOT_HELD", state: row ? row.state : null };
      const members = JSON.parse(row.members_json)
        .map((m) => (m.memberKey === req.memberKey ? { ...m, state: "DESTROYED" } : m));
      return updateWithVersion(db, EXPOSURE_TABLE, req.exposureId, row.version,
        { members_json: JSON.stringify(members), updated_at: toBind(Math.max(req.at, row.updated_at)) });
    });
    if (!result.ok) return unwrap(result);
    return { ok: true, duplicate: result.duplicate === true };
  }

  function endInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, ["exposureId", "at", "reason"]);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.exposureId, S.MAX_EXPOSURE_ID_LENGTH)) return invalid("exposureId");
    if (!isTime(req.at)) return invalid("at");
    if (!S.END_REASONS.includes(req.reason)) return invalid("reason");
    const read = stmts(tx).byId.get(req.exposureId);
    if (!read) return { ok: false, reason: "EXPOSURE_NOT_FOUND", exposureId: req.exposureId };
    if (read.state === "ENDED") return endedOf(tx, read);
    const result = journal.applyOnce(tx, { key: S.settleKey(req.exposureId),
      aggregate: { type: S.AGGREGATE, id: req.exposureId }, eventType: EVENT.END,
      payload: { exposureId: req.exposureId, at: req.at, reason: req.reason } }, (db) => {
      const row = stmts(db).byId.get(req.exposureId);
      if (!row || row.state !== "HELD") return { ok: false, reason: "EXPOSURE_NOT_FOUND", exposureId: req.exposureId };
      const losses = lossesOf(JSON.parse(row.members_json));
      const got = fleetRepository.getFleet(db, row.fleet_id);
      if (!got.ok) return got;
      if (!got.fleet || got.fleet.state !== FLEET_MATERIALIZED) {
        const w = updateWithVersion(db, EXPOSURE_TABLE, req.exposureId, row.version, { state: "ENDED",
          ended_at: toBind(req.at), end_reason: FLEET_GONE, losses_json: JSON.stringify([]),
          updated_at: toBind(Math.max(req.at, row.updated_at)) });
        if (!w.ok) return w;
        const outcome = !got.fleet || got.fleet.state === FLEET_DESTROYED ? "DESTROYED" : "RELEASED";
        return { ok: true, outcome, losses: [], endReason: FLEET_GONE };
      }
      let version = got.fleet.version;
      let destroyed = false;
      if (losses.length > 0) {
        const lost = fleetRepository.applyLosses(db, { fleetId: row.fleet_id, expectedVersion: version, losses },
          S.lossesKey(req.exposureId));
        if (!lost.ok) return lost;
        if (lost.duplicate) return { ok: false, reason: "LOSSES_ALREADY_APPLIED", exposureId: req.exposureId };
        version = lost.version;
        destroyed = lost.destroyed === true;
        crewLossInTx(db, row.fleet_id, req.at, S.lossesKey(req.exposureId));
      }
      if (!destroyed) {
        const release = (to, patch) => fleetRepository.transition(db, { fleetId: row.fleet_id, expectedVersion: version,
          from: FLEET_MATERIALIZED, to, patch }, S.releaseKey(req.exposureId));
        const target = releaseTargetOf(row.from_state, got.fleet, req.at);
        let rel = release(target.to, target.patch);
        if (!rel.ok && target.to === FLEET_STAGED && OPERATION_GONE_REASONS.includes(rel.reason)) {
          rel = release(FLEET_IDLE, {});
        }
        if (!rel.ok) return rel;
        if (rel.duplicate) return { ok: false, reason: "RELEASE_ALREADY_APPLIED", exposureId: req.exposureId };
      }
      const w = updateWithVersion(db, EXPOSURE_TABLE, req.exposureId, row.version, { state: "ENDED",
        ended_at: toBind(req.at), end_reason: req.reason, losses_json: JSON.stringify(losses),
        updated_at: toBind(Math.max(req.at, row.updated_at)) });
      if (!w.ok) return w;
      if (!destroyed) {
        callReleaseContact(releaseContact, db, { releaseId: req.exposureId, fleetId: row.fleet_id,
          systemId: got.fleet.currentSystemId, at: req.at });
      }
      return { ok: true, outcome: destroyed ? "DESTROYED" : "RELEASED", losses };
    });
    if (!result.ok) return unwrap(result);
    if (result.duplicate) {
      const row = stmts(tx).byId.get(req.exposureId);
      return row ? endedOf(tx, row) : { ok: true, duplicate: true, outcome: "RELEASED", losses: [] };
    }
    return { ok: true, duplicate: false, outcome: result.value.outcome, losses: result.value.losses,
      ...(result.value.endReason ? { endReason: result.value.endReason } : {}) };
  }

  function endedOf(tx, row) {
    const got = fleetRepository.getFleet(tx, row.fleet_id);
    const gone = got.ok && got.fleet !== null && got.fleet.state === FLEET_DESTROYED;
    return { ok: true, duplicate: true, outcome: gone ? "DESTROYED" : "RELEASED", losses: parseJson(row.losses_json) || [] };
  }

  function listOpenInTx(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = isPlainObject(opts) ? opts : {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > MAX_LIST_LIMIT) return invalid("limit");
    const after = has(o, "afterExposureId") && o.afterExposureId !== null ? o.afterExposureId : "";
    if (typeof after !== "string") return invalid("afterExposureId");
    const rows = stmts(tx).listOpen.all(after, toBind(o.limit));
    return { ok: true, exposures: rows.map(toExposure),
      nextAfterExposureId: rows.length === o.limit ? rows[rows.length - 1].exposure_id : null };
  }

  function getInTx(tx, exposureId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(exposureId, S.MAX_EXPOSURE_ID_LENGTH)) return invalid("exposureId");
    const row = stmts(tx).byId.get(exposureId);
    return { ok: true, exposure: row ? toExposure(row) : null };
  }

  return Object.freeze({ claimInTx, markDestroyedInTx, endInTx, listOpenInTx, getInTx });
}

module.exports = { createExposureRepository, END_ROWS, EVENT };
