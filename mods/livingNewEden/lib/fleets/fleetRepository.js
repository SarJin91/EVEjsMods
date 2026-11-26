"use strict";

const { defineTable, updateWithVersion, toBind, stateListSql } = require("../persistence/repository");
const { KIND_APPLY } = require("../persistence/journal");
const { deriveSeed } = require("../util/rng");
const {
  FLEETS_TABLE_NAME, OPERATIONS_TABLE_NAME, FLEET_STATES, OPERATION_STATES, INITIAL_FLEET_STATE, DESTROYED_STATE,
  INITIAL_OPERATION_STATE, TERMINAL_OPERATION_STATES, OPEN_OPERATION_STATES, ORDERED_FLEET_STATES,
  ASSIGNABLE_FLEET_STATES, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES, SUPPLY_MIN, SUPPLY_MAX, DEFAULT_SUPPLY_STATE,
  MAX_ID_LENGTH, FLEET_INDEXES,
} = require("./schema");
const { canTransitionFleet, canTransitionOperation, clearedOnEntry, checkFleetInvariants } = require("./stateMachine");
const { normalizeComposition, normalizeLosses, subtractLosses, addHulls, removeHulls, normalizeCargo, jsonBytes } =
  require("./composition");

const FLEET_AGGREGATE = "fleet";
const OPERATION_AGGREGATE = "operation";
const INITIAL_VERSION = 1;
const INITIAL_LEG_SEQ = 0;
const MAX_UINT32 = 0xFFFFFFFF;
const ENGAGED_STATE = "ENGAGED";
const MATERIALIZED_STATE = "MATERIALIZED";

const LIMIT_NAMES = Object.freeze(["maxVirtualFleets", "maxCompositionEntries", "maxShipsPerFleet",
  "maxFleetsPerOperation", "maxJsonBytes", "maxListLimit"]);

const FLEET_COLUMNS = "fleet_id, faction_id, corporation_id, current_system_id, target_system_id, home_system_id, "
  + "route_json, route_graph_version, leg_seq, fleet_role, doctrine_id, composition_json, ship_count, supply_state, "
  + "cargo_manifest, operation_id, state, next_action_at, created_at, updated_at, version, refit_pending";
const OPERATION_COLUMNS = "operation_id, idempotency_key, operation_type, faction_id, origin_system_id, "
  + "target_system_id, fleet_ids, objective, state, planned_at, due_at, completed_at, seed, result_json, updated_at, "
  + "version";

const STATE_LIST_SQL = Object.freeze({
  inSystemStates: (lit) => `SELECT ${FLEET_COLUMNS} FROM ${FLEETS_TABLE_NAME}
    WHERE current_system_id = ? AND fleet_id > ? AND state IN ${lit} ORDER BY fleet_id LIMIT ?`,
  byFactionStates: (lit) => `SELECT ${FLEET_COLUMNS} FROM ${FLEETS_TABLE_NAME}
    WHERE faction_id = ? AND fleet_id > ? AND state IN ${lit} ORDER BY fleet_id LIMIT ?`,
  byFactionLiveStates: (lit) => `SELECT ${FLEET_COLUMNS} FROM ${FLEETS_TABLE_NAME}
    INDEXED BY ${FLEET_INDEXES.factionLive}
    WHERE faction_id = ? AND state <> '${DESTROYED_STATE}' AND fleet_id > ? AND state IN ${lit}
    ORDER BY fleet_id LIMIT ?`,
  byFactionLiveStatesRole: (lit) => `SELECT ${FLEET_COLUMNS} FROM ${FLEETS_TABLE_NAME}
    INDEXED BY ${FLEET_INDEXES.factionLive}
    WHERE faction_id = ? AND state <> '${DESTROYED_STATE}' AND fleet_id > ? AND state IN ${lit} AND fleet_role = ?
    ORDER BY fleet_id LIMIT ?`,
  inSystemsStates: (lit) => `SELECT ${FLEET_COLUMNS} FROM (SELECT ${FLEET_COLUMNS},
    row_number() OVER (PARTITION BY current_system_id ORDER BY fleet_id) AS rn
    FROM ${FLEETS_TABLE_NAME} INDEXED BY ${FLEET_INDEXES.system}
    WHERE current_system_id IN (SELECT value FROM json_each(?)) AND state IN ${lit})
    WHERE rn <= ? ORDER BY current_system_id, fleet_id`,
});

const FLEET_TABLE = defineTable({
  name: FLEETS_TABLE_NAME,
  idColumn: "fleet_id",
  columns: ["current_system_id", "target_system_id", "home_system_id", "route_json", "route_graph_version", "leg_seq",
    "composition_json", "ship_count", "supply_state", "cargo_manifest", "operation_id", "state", "next_action_at",
    "updated_at", "refit_pending"],
});
const FLEET_ROLE_TABLE = defineTable({
  name: FLEETS_TABLE_NAME,
  idColumn: "fleet_id",
  columns: ["fleet_role", "updated_at"],
});
const OPERATION_TABLE = defineTable({
  name: OPERATIONS_TABLE_NAME,
  idColumn: "operation_id",
  columns: ["state", "completed_at", "result_json", "updated_at"],
});

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const SUMMARY_MAX_LINES = 50;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function invalid(detail) {
  return { ok: false, reason: "FLEET_INVALID_INPUT", detail };
}

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isText(value, max) {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((key) => !allowed.includes(key));
}

function parseJson(text) {
  return text === null ? null : JSON.parse(text);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function toDraft(row) {
  return {
    fleetId: row.fleet_id,
    factionId: row.faction_id,
    corporationId: row.corporation_id,
    currentSystemId: row.current_system_id,
    targetSystemId: row.target_system_id,
    homeSystemId: row.home_system_id,
    route: parseJson(row.route_json),
    routeGraphVersion: row.route_graph_version,
    legSeq: row.leg_seq,
    fleetRole: row.fleet_role,
    doctrineId: row.doctrine_id,
    composition: JSON.parse(row.composition_json),
    shipCount: row.ship_count,
    supplyState: row.supply_state,
    cargo: parseJson(row.cargo_manifest),
    operationId: row.operation_id,
    state: row.state,
    nextActionAt: row.next_action_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    refitPending: row.refit_pending === 1,
  };
}

function toFleet(row) {
  return deepFreeze(toDraft(row));
}

function toOperation(row) {
  return deepFreeze({
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    operationType: row.operation_type,
    factionId: row.faction_id,
    originSystemId: row.origin_system_id,
    targetSystemId: row.target_system_id,
    fleetIds: JSON.parse(row.fleet_ids),
    objective: row.objective,
    state: row.state,
    plannedAt: row.planned_at,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    seed: row.seed,
    result: parseJson(row.result_json),
    updatedAt: row.updated_at,
    version: row.version,
  });
}

const nullOr = (check) => (value) => (value === null || check(value) ? { ok: true, value } : null);
const PATCH_FIELDS = Object.freeze({
  currentSystemId: (v) => (isPositiveId(v) ? { ok: true, value: v } : null),
  targetSystemId: nullOr(isPositiveId),
  homeSystemId: nullOr(isPositiveId),
  route: (v, limits) => {
    if (v === null) return { ok: true, value: null };
    if (!isPlainObject(v)) return null;
    const size = jsonBytes(v, "patch.route");
    if (!size.ok) return size;
    if (size.bytes > limits.maxJsonBytes) return invalid(`patch.route: ${size.bytes} bytes > ${limits.maxJsonBytes}`);
    return { ok: true, value: v };
  },
  routeGraphVersion: nullOr(isPositiveId),
  legSeq: (v) => (isNonNegativeInt(v) ? { ok: true, value: v } : null),
  operationId: nullOr((v) => isText(v, MAX_ID_LENGTH)),
  nextActionAt: nullOr(isNonNegativeInt),
  supplyState: (v) => (Number.isSafeInteger(v) && v >= SUPPLY_MIN && v <= SUPPLY_MAX ? { ok: true, value: v } : null),
  cargo: (v, limits) => {
    const r = normalizeCargo(v, limits);
    return r.ok ? { ok: true, value: r.cargo } : r;
  },
  refitPending: (v) => (typeof v === "boolean" ? { ok: true, value: v } : null),
});
const PATCH_KEYS = Object.freeze(Object.keys(PATCH_FIELDS));

const CREATE_KEYS = Object.freeze(["factionId", "corporationId", "currentSystemId", "homeSystemId", "fleetRole",
  "doctrineId", "composition", "supplyState", "cargo", "fleetId"]);
const OPERATION_KEYS = Object.freeze(["operationType", "factionId", "originSystemId", "targetSystemId", "objective",
  "dueAt", "fleets", "operationId"]);

function createFleetRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createFleetRepository: deps missing");
  const { journal, clock, ids, worldSeed, limits, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("createFleetRepository: journal with applyOnce/findByKey required");
  }
  if (!clock || typeof clock.now !== "function") throw new TypeError("createFleetRepository: clock.now required");
  if (!ids || typeof ids.next !== "function") throw new TypeError("createFleetRepository: ids.next required");
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0 || worldSeed > MAX_UINT32) {
    throw new TypeError(`createFleetRepository: worldSeed must be a uint32, got ${worldSeed}`);
  }
  if (!limits || typeof limits !== "object") throw new TypeError("createFleetRepository: limits missing");
  for (const name of LIMIT_NAMES) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`createFleetRepository: limits.${name} must be a positive integer, got ${limits[name]}`);
    }
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createFleetRepository: onCount must be a function");
  }
  const L = Object.freeze(Object.fromEntries(LIMIT_NAMES.map((name) => [name, limits[name]])));

  const count = (name) => {
    if (!onCount) return;
    try {
      onCount(name, 1);
    } catch (_err) {
    }
  };
  const refused = (result) => {
    count("fleets.refused");
    return result;
  };

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const F = FLEETS_TABLE_NAME;
    const O = OPERATIONS_TABLE_NAME;
    s = {
      fleetById: db.prepare(`SELECT ${FLEET_COLUMNS} FROM ${F} WHERE fleet_id = ?`),
      fleetsByIds: db.prepare(`SELECT ${FLEET_COLUMNS} FROM ${F}
        WHERE fleet_id IN (SELECT value FROM json_each(?)) ORDER BY fleet_id`),
      insertFleet: db.prepare(`INSERT INTO ${F} (${FLEET_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      countActive: db.prepare(`SELECT count(*) AS n FROM ${F} WHERE state <> ?`),
      inSystem: db.prepare(`SELECT ${FLEET_COLUMNS} FROM ${F}
        WHERE current_system_id = ? AND fleet_id > ? ORDER BY fleet_id LIMIT ?`),
      byStates: new Map(),
      byFaction: db.prepare(`SELECT ${FLEET_COLUMNS} FROM ${F}
        WHERE faction_id = ? AND fleet_id > ? ORDER BY fleet_id LIMIT ?`),
      byState: db.prepare(`SELECT ${FLEET_COLUMNS} FROM ${F}
        WHERE state = ? AND fleet_id > ? ORDER BY fleet_id LIMIT ?`),
      byStateRole: db.prepare(`SELECT ${FLEET_COLUMNS} FROM ${F}
        WHERE state = ? AND fleet_role = ? AND fleet_id > ? ORDER BY fleet_id LIMIT ?`),
      ofOperation: db.prepare(`SELECT ${FLEET_COLUMNS} FROM ${F} WHERE operation_id = ?
        ORDER BY (state = ?), fleet_id LIMIT ?`),
      liveMembersOfOperation: db.prepare(`SELECT count(*) AS n FROM ${F}
        WHERE operation_id = ? AND state <> ? AND fleet_id <> ?`),
      orderedOfOperation: db.prepare(`SELECT count(*) AS n FROM ${F}
        WHERE operation_id = ? AND state IN (SELECT value FROM json_each(?))`),
      countByState: db.prepare(`SELECT state, count(*) AS n FROM ${F} GROUP BY state`),
      overdueInFlight: db.prepare(`SELECT count(*) AS n FROM ${F}
        WHERE state IN ('TRAVELLING', 'RETREATING') AND next_action_at < ?`),
      opsCountByState: db.prepare(`SELECT state, count(*) AS n FROM ${O} GROUP BY state`),
      stationaryCounts: db.prepare(`SELECT current_system_id AS s, state, faction_id AS f, count(*) AS n,
        sum(ship_count) AS ships FROM ${F} WHERE state IN (SELECT value FROM json_each(?))
        GROUP BY current_system_id, state, faction_id`),
      stationaryLines: db.prepare(`SELECT fleet_id, faction_id, current_system_id, state, ship_count, operation_id
        FROM (SELECT fleet_id, faction_id, current_system_id, state, ship_count, operation_id,
          row_number() OVER (PARTITION BY current_system_id ORDER BY fleet_id) AS rn
          FROM ${F} WHERE state IN (SELECT value FROM json_each(?)))
        WHERE rn <= ? ORDER BY current_system_id, fleet_id`),
      summaryByFactionState: db.prepare(`SELECT faction_id AS f, state, count(*) AS n, sum(ship_count) AS ships
        FROM ${F} WHERE state IN (SELECT value FROM json_each(?)) GROUP BY faction_id, state`),
      summaryHullsByFaction: db.prepare(`SELECT v.faction_id AS f, json_extract(e.value, '$.hullGroup') AS g,
        sum(json_extract(e.value, '$.count')) AS n
        FROM ${F} v, json_each(v.composition_json) e
        WHERE v.state IN (SELECT value FROM json_each(?)) GROUP BY v.faction_id, g`),
      operationById: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O} WHERE operation_id = ?`),
      insertOperation: db.prepare(`INSERT INTO ${O} (${OPERATION_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      opsAll: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O} WHERE operation_id > ? ORDER BY operation_id LIMIT ?`),
      opsByFaction: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O}
        WHERE faction_id = ? AND operation_id > ? ORDER BY operation_id LIMIT ?`),
      opsByFactionState: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O}
        WHERE faction_id = ? AND state = ? AND operation_id > ? ORDER BY operation_id LIMIT ?`),
      opsByFactionStates: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O}
        WHERE faction_id = ? AND state IN (SELECT value FROM json_each(?)) AND operation_id > ?
        ORDER BY operation_id LIMIT ?`),
      opsByState: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O}
        WHERE state = ? AND operation_id > ? ORDER BY operation_id LIMIT ?`),
      opsByStateTypes: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O}
        WHERE state = ? AND operation_type IN (SELECT value FROM json_each(?)) AND operation_id > ?
        ORDER BY operation_id LIMIT ?`),
      opsByTarget: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O} WHERE target_system_id = ?
        AND state IN (SELECT value FROM json_each(?)) ORDER BY operation_id LIMIT ?`),
      opsByTargetType: db.prepare(`SELECT ${OPERATION_COLUMNS} FROM ${O} WHERE target_system_id = ?
        AND state IN (SELECT value FROM json_each(?)) AND operation_type = ? ORDER BY operation_id LIMIT ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function statesStmt(db, name, states) {
    const s = stmts(db);
    const lit = stateListSql(states, FLEET_STATES);
    const key = `${name}|${lit}`;
    let st = s.byStates.get(key);
    if (!st) {
      st = db.prepare(STATE_LIST_SQL[name](lit));
      s.byStates.set(key, st);
    }
    return st;
  }

  function readNow() {
    const now = clock.now();
    return Number.isSafeInteger(now) && now >= 0 ? now : undefined;
  }

  function idOfKey(tx, key, aggregateType) {
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    if (found.found && found.entry.kind === KIND_APPLY && found.entry.aggregateType === aggregateType) {
      return { ok: true, id: found.entry.aggregateId };
    }
    return { ok: true, id: undefined };
  }

  function writeFleet(db, draft, expectedVersion, now) {
    return updateWithVersion(db, FLEET_TABLE, draft.fleetId, expectedVersion, {
      current_system_id: draft.currentSystemId,
      target_system_id: draft.targetSystemId,
      home_system_id: draft.homeSystemId,
      route_json: draft.route === null ? null : jsonBytes(draft.route, "route").text,
      route_graph_version: draft.routeGraphVersion,
      leg_seq: draft.legSeq,
      composition_json: jsonBytes(draft.composition, "composition").text,
      ship_count: draft.shipCount,
      supply_state: draft.supplyState,
      cargo_manifest: draft.cargo === null ? null : jsonBytes(draft.cargo, "cargo").text,
      operation_id: draft.operationId,
      state: draft.state,
      next_action_at: draft.nextActionAt,
      updated_at: now,
      refit_pending: draft.refitPending ? 1 : 0,
    });
  }

  function loadFleet(s, fleetId, expectedVersion, from) {
    const row = s.fleetById.get(fleetId);
    if (!row) return { ok: false, reason: "ROW_NOT_FOUND", fleetId };
    if (row.version !== expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion, actualVersion: row.version };
    }
    if (from !== undefined && row.state !== from) {
      return { ok: false, reason: "STATE_MISMATCH", expected: from, actual: row.state };
    }
    return { ok: true, row };
  }

  function clearOnEntry(draft, state) {
    for (const field of clearedOnEntry(state)) draft[field] = null;
  }

  function validateCreate(spec) {
    if (!isPlainObject(spec)) return invalid("spec");
    const extra = unknownKeys(spec, CREATE_KEYS);
    if (extra.length > 0) return invalid(`spec: field ${extra[0]}`);
    if (!isPositiveId(spec.factionId)) return invalid("factionId");
    const corporationId = spec.corporationId === undefined ? null : spec.corporationId;
    if (corporationId !== null && !isPositiveId(corporationId)) return invalid("corporationId");
    if (!isPositiveId(spec.currentSystemId)) return invalid("currentSystemId");
    const homeSystemId = spec.homeSystemId === undefined ? null : spec.homeSystemId;
    if (homeSystemId !== null && !isPositiveId(homeSystemId)) return invalid("homeSystemId");
    if (typeof spec.fleetRole !== "string") return invalid("fleetRole");
    if (!FLEET_ROLES.includes(spec.fleetRole)) {
      return { ok: false, reason: "UNKNOWN_FLEET_ROLE", fleetRole: spec.fleetRole };
    }
    const doctrineId = spec.doctrineId === undefined ? null : spec.doctrineId;
    if (doctrineId !== null && !isText(doctrineId, MAX_ID_LENGTH)) return invalid("doctrineId");
    const composition = normalizeComposition(spec.composition, L);
    if (!composition.ok) return composition;
    const supplyState = spec.supplyState === undefined ? DEFAULT_SUPPLY_STATE : spec.supplyState;
    if (!Number.isSafeInteger(supplyState) || supplyState < SUPPLY_MIN || supplyState > SUPPLY_MAX) {
      return invalid("supplyState");
    }
    const cargo = normalizeCargo(spec.cargo, L);
    if (!cargo.ok) return cargo;
    if (spec.fleetId !== undefined && !isText(spec.fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
    return { ok: true, shipCount: composition.shipCount, normalized: { factionId: spec.factionId, corporationId,
      currentSystemId: spec.currentSystemId, homeSystemId, fleetRole: spec.fleetRole, doctrineId,
      composition: composition.composition, supplyState, cargo: cargo.cargo } };
  }

  function createFleet(tx, spec, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateCreate(spec);
    if (!valid.ok) return refused(valid);
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    let fleetId = spec.fleetId;
    if (fleetId === undefined) {
      const earlier = idOfKey(tx, idempotencyKey, FLEET_AGGREGATE);
      if (!earlier.ok) return refused(earlier);
      fleetId = earlier.id !== undefined ? earlier.id : ids.next("fleet");
    }
    const n = valid.normalized;
    const result = journal.applyOnce(tx, { key: idempotencyKey, aggregate: { type: FLEET_AGGREGATE, id: fleetId },
      eventType: "FLEET_CREATED", payload: n }, (db) => {
      const s = stmts(db);
      const active = s.countActive.get(DESTROYED_STATE).n;
      if (active >= L.maxVirtualFleets) {
        return { ok: false, reason: "FLEET_LIMIT", limit: L.maxVirtualFleets, count: active };
      }
      if (s.fleetById.get(fleetId)) return { ok: false, reason: "FLEET_EXISTS", fleetId };
      s.insertFleet.run(fleetId, toBind(n.factionId), toBind(n.corporationId), toBind(n.currentSystemId), null,
        toBind(n.homeSystemId), null, null, toBind(INITIAL_LEG_SEQ), n.fleetRole, n.doctrineId,
        jsonBytes(n.composition, "composition").text, toBind(valid.shipCount), toBind(n.supplyState),
        n.cargo === null ? null : jsonBytes(n.cargo, "cargo").text, null, INITIAL_FLEET_STATE, null, toBind(now),
        toBind(now), toBind(INITIAL_VERSION), toBind(0));
      return { ok: true };
    });
    if (!result.ok) {
      const refusal = result.reason === "APPLY_REFUSED" ? result.refusal : result;
      if (refusal.reason === "FLEET_LIMIT") count("fleets.limit");
      return refused(refusal);
    }
    if (result.duplicate) return { ok: true, duplicate: true, fleetId, journalId: result.journalId };
    count("fleets.created");
    return { ok: true, duplicate: false, fleetId, version: INITIAL_VERSION, journalId: result.journalId };
  }

  function validatePatch(patch, to) {
    if (patch === undefined) return { ok: true, patch: {} };
    if (!isPlainObject(patch)) return invalid("patch");
    const extra = unknownKeys(patch, PATCH_KEYS);
    if (extra.length > 0) return invalid(`patch: field ${extra[0]}`);
    const out = {};
    for (const key of PATCH_KEYS) {
      if (!has(patch, key)) continue;
      const r = PATCH_FIELDS[key](patch[key], L);
      if (r === null) return invalid(`patch.${key}`);
      if (!r.ok) return r;
      out[key] = r.value;
    }
    for (const field of clearedOnEntry(to)) {
      if (has(out, field) && out[field] !== null) return invalid(`patch.${field}: cleared on entry into ${to}`);
    }
    return { ok: true, patch: out };
  }

  function validateTransition(change) {
    if (!isPlainObject(change)) return invalid("change");
    const extra = unknownKeys(change, ["fleetId", "expectedVersion", "from", "to", "patch"]);
    if (extra.length > 0) return invalid(`change: field ${extra[0]}`);
    if (!isText(change.fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < INITIAL_VERSION) {
      return invalid("expectedVersion");
    }
    const edge = canTransitionFleet(change.from, change.to);
    if (!edge.ok) return edge;
    return validatePatch(change.patch, change.to);
  }

  function applyTransition(db, change, patch, now) {
    const s = stmts(db);
    const loaded = loadFleet(s, change.fleetId, change.expectedVersion, change.from);
    if (!loaded.ok) return loaded;
    const draft = toDraft(loaded.row);
    if (has(patch, "legSeq") && patch.legSeq < draft.legSeq) {
      return { ok: false, reason: "LEG_SEQ_REGRESSION", legSeq: patch.legSeq, current: draft.legSeq };
    }
    const joins = has(patch, "operationId") && patch.operationId !== null;
    if (joins && patch.operationId !== draft.operationId) {
      const members = s.liveMembersOfOperation.get(patch.operationId, DESTROYED_STATE, draft.fleetId).n;
      if (members >= L.maxFleetsPerOperation) {
        return { ok: false, reason: "TOO_MANY_FLEETS", operationId: patch.operationId, count: members + 1,
          limit: L.maxFleetsPerOperation };
      }
    }
    Object.assign(draft, patch);
    draft.state = change.to;
    clearOnEntry(draft, change.to);
    if (change.to === DESTROYED_STATE) draft.refitPending = false;
    if (joins || (ORDERED_FLEET_STATES.includes(change.to) && draft.operationId !== null)) {
      const op = s.operationById.get(draft.operationId);
      if (!op) return { ok: false, reason: "OPERATION_NOT_FOUND", operationId: draft.operationId };
      if (!OPEN_OPERATION_STATES.includes(op.state)) {
        return { ok: false, reason: "OPERATION_CLOSED", operationId: draft.operationId, state: op.state };
      }
      if (op.faction_id !== draft.factionId) {
        return { ok: false, reason: "FLEET_FACTION_MISMATCH", fleetId: draft.fleetId, factionId: draft.factionId,
          operationFactionId: op.faction_id };
      }
    }
    const inv = checkFleetInvariants(draft);
    if (!inv.ok) return inv;
    const written = writeFleet(db, draft, change.expectedVersion, now);
    if (!written.ok) return written;
    return { ok: true, version: written.version, state: change.to };
  }

  function transition(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateTransition(change);
    if (!valid.ok) return refused(valid);
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const patch = valid.patch;
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: FLEET_AGGREGATE, id: change.fleetId }, eventType: "FLEET_TRANSITION",
      payload: { fleetId: change.fleetId, from: change.from, to: change.to, patch } },
    (db) => applyTransition(db, change, patch, now));
    if (!result.ok) return refused(result.reason === "APPLY_REFUSED" ? result.refusal : result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("fleets.transition");
    return { ok: true, duplicate: false, fleetId: change.fleetId, version: result.value.version,
      state: result.value.state, journalId: result.journalId };
  }

  function reassignRole(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(change)) return refused(invalid("change"));
    const extra = unknownKeys(change, ["fleetId", "expectedVersion", "from", "to"]);
    if (extra.length > 0) return refused(invalid(`change: field ${extra[0]}`));
    if (!isText(change.fleetId, MAX_ID_LENGTH)) return refused(invalid("fleetId"));
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < INITIAL_VERSION) {
      return refused(invalid("expectedVersion"));
    }
    for (const field of ["from", "to"]) {
      if (!FLEET_ROLES.includes(change[field])) {
        return refused({ ok: false, reason: "UNKNOWN_FLEET_ROLE", fleetRole: change[field] });
      }
    }
    if (change.from === change.to) return refused(invalid("to: same role as from"));
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: FLEET_AGGREGATE, id: change.fleetId }, eventType: "FLEET_ROLE_CHANGED",
      payload: { fleetId: change.fleetId, from: change.from, to: change.to } }, (db) => {
      const loaded = loadFleet(stmts(db), change.fleetId, change.expectedVersion, INITIAL_FLEET_STATE);
      if (!loaded.ok) return loaded;
      if (loaded.row.refit_pending === 1) return { ok: false, reason: "STATE_MISMATCH", detail: "refit_pending" };
      if (loaded.row.fleet_role !== change.from) {
        return { ok: false, reason: "ROLE_MISMATCH", expected: change.from, actual: loaded.row.fleet_role };
      }
      return updateWithVersion(db, FLEET_ROLE_TABLE, change.fleetId, change.expectedVersion,
        { fleet_role: change.to, updated_at: now });
    });
    if (!result.ok) return refused(result.reason === "APPLY_REFUSED" ? result.refusal : result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("fleets.roleChanged");
    return { ok: true, duplicate: false, fleetId: change.fleetId, version: result.value.version,
      journalId: result.journalId };
  }

  function applyLosses(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(change)) return refused(invalid("change"));
    const extra = unknownKeys(change, ["fleetId", "expectedVersion", "losses"]);
    if (extra.length > 0) return refused(invalid(`change: field ${extra[0]}`));
    if (!isText(change.fleetId, MAX_ID_LENGTH)) return refused(invalid("fleetId"));
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < INITIAL_VERSION) {
      return refused(invalid("expectedVersion"));
    }
    const losses = normalizeLosses(change.losses, L);
    if (!losses.ok) return refused(losses);
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: FLEET_AGGREGATE, id: change.fleetId }, eventType: "FLEET_LOSSES",
      payload: { fleetId: change.fleetId, losses: losses.losses } }, (db) => {
      const loaded = loadFleet(stmts(db), change.fleetId, change.expectedVersion, undefined);
      if (!loaded.ok) return loaded;
      const draft = toDraft(loaded.row);
      if (draft.state !== ENGAGED_STATE && draft.state !== MATERIALIZED_STATE) {
        return { ok: false, reason: "FLEET_NOT_ENGAGED", state: draft.state };
      }
      const left = subtractLosses(draft.composition, losses.losses);
      if (!left.ok) return left;
      draft.composition = left.composition;
      draft.shipCount = left.shipCount;
      const destroyed = left.shipCount === 0;
      if (destroyed) {
        draft.state = DESTROYED_STATE;
        clearOnEntry(draft, DESTROYED_STATE);
        draft.refitPending = false;
      }
      const inv = checkFleetInvariants(draft);
      if (!inv.ok) return inv;
      const written = writeFleet(db, draft, change.expectedVersion, now);
      if (!written.ok) return written;
      return { ok: true, version: written.version, shipCount: left.shipCount, destroyed,
        composition: left.composition };
    });
    if (!result.ok) return refused(result.reason === "APPLY_REFUSED" ? result.refusal : result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("fleets.losses");
    if (result.value.destroyed) count("fleets.destroyed");
    return { ok: true, duplicate: false, fleetId: change.fleetId, ...result.value, journalId: result.journalId };
  }

  function replenish(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(change)) return refused(invalid("change"));
    const extra = unknownKeys(change, ["fleetId", "expectedVersion", "systemId", "add"]);
    if (extra.length > 0) return refused(invalid(`change: field ${extra[0]}`));
    if (!isText(change.fleetId, MAX_ID_LENGTH)) return refused(invalid("fleetId"));
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < INITIAL_VERSION) {
      return refused(invalid("expectedVersion"));
    }
    if (!isPositiveId(change.systemId)) return refused(invalid("systemId"));
    const probe = addHulls([], change.add, L);
    if (!probe.ok) return refused(probe);
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: FLEET_AGGREGATE, id: change.fleetId }, eventType: "FLEET_REPLENISHED",
      payload: { fleetId: change.fleetId, systemId: change.systemId, add: probe.add } }, (db) => {
      const loaded = loadFleet(stmts(db), change.fleetId, change.expectedVersion, INITIAL_FLEET_STATE);
      if (!loaded.ok) return loaded;
      if (loaded.row.refit_pending === 1) return { ok: false, reason: "REFIT_PENDING" };
      if (loaded.row.current_system_id !== change.systemId) {
        return { ok: false, reason: "LOCATION_MISMATCH", expected: change.systemId,
          actual: loaded.row.current_system_id };
      }
      const draft = toDraft(loaded.row);
      const next = addHulls(draft.composition, probe.add, L);
      if (!next.ok) return next;
      if (next.shipCount > L.maxShipsPerFleet) {
        return { ok: false, reason: "FLEET_SHIP_LIMIT", limit: L.maxShipsPerFleet, shipCount: next.shipCount };
      }
      draft.composition = next.composition;
      draft.shipCount = next.shipCount;
      const inv = checkFleetInvariants(draft);
      if (!inv.ok) return inv;
      const written = writeFleet(db, draft, change.expectedVersion, now);
      if (!written.ok) return written;
      return { ok: true, version: written.version, shipCount: next.shipCount, composition: next.composition };
    });
    if (!result.ok) return refused(result.reason === "APPLY_REFUSED" ? result.refusal : result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("fleets.replenished");
    return { ok: true, duplicate: false, fleetId: change.fleetId, ...result.value, journalId: result.journalId };
  }

  function disband(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(change)) return refused(invalid("change"));
    const extra = unknownKeys(change, ["fleetId", "expectedVersion", "systemId", "fleetRole", "allowRefitPending"]);
    if (extra.length > 0) return refused(invalid(`change: field ${extra[0]}`));
    if (!isText(change.fleetId, MAX_ID_LENGTH)) return refused(invalid("fleetId"));
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < INITIAL_VERSION) {
      return refused(invalid("expectedVersion"));
    }
    if (!isPositiveId(change.systemId)) return refused(invalid("systemId"));
    if (!FLEET_ROLES.includes(change.fleetRole)) return refused(invalid("fleetRole"));
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: FLEET_AGGREGATE, id: change.fleetId }, eventType: "FLEET_DISBANDED",
      payload: { fleetId: change.fleetId, systemId: change.systemId, fleetRole: change.fleetRole } }, (db) => {
      const loaded = loadFleet(stmts(db), change.fleetId, change.expectedVersion, INITIAL_FLEET_STATE);
      if (!loaded.ok) return loaded;
      const row = loaded.row;
      if (row.refit_pending === 1 && !change.allowRefitPending) return { ok: false, reason: "REFIT_PENDING" };
      if (row.operation_id !== null) return { ok: false, reason: "OPERATION_SET", operationId: row.operation_id };
      if (row.current_system_id !== change.systemId) {
        return { ok: false, reason: "LOCATION_MISMATCH", expected: change.systemId, actual: row.current_system_id };
      }
      if (row.fleet_role !== change.fleetRole) {
        return { ok: false, reason: "ROLE_MISMATCH", expected: change.fleetRole, actual: row.fleet_role };
      }
      const draft = toDraft(row);
      const removed = draft.composition.map((e) => ({ hullGroup: e.hullGroup, count: e.count }));
      draft.state = DESTROYED_STATE;
      clearOnEntry(draft, DESTROYED_STATE);
      draft.refitPending = false;
      draft.composition = [];
      draft.shipCount = 0;
      const inv = checkFleetInvariants(draft);
      if (!inv.ok) return inv;
      const written = writeFleet(db, draft, change.expectedVersion, now);
      if (!written.ok) return written;
      return { ok: true, version: written.version, removed };
    });
    if (!result.ok) return refused(result.reason === "APPLY_REFUSED" ? result.refusal : result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("fleets.disbanded");
    return { ok: true, duplicate: false, fleetId: change.fleetId, ...result.value, journalId: result.journalId };
  }

  function upgradeComposition(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(change)) return refused(invalid("change"));
    const extra = unknownKeys(change, ["fleetId", "expectedVersion", "systemId", "fleetRole", "add", "remove"]);
    if (extra.length > 0) return refused(invalid(`change: field ${extra[0]}`));
    if (!isText(change.fleetId, MAX_ID_LENGTH)) return refused(invalid("fleetId"));
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < INITIAL_VERSION) {
      return refused(invalid("expectedVersion"));
    }
    if (!isPositiveId(change.systemId)) return refused(invalid("systemId"));
    if (!FLEET_ROLES.includes(change.fleetRole)) return refused(invalid("fleetRole"));
    if (!Array.isArray(change.add) || !Array.isArray(change.remove)) return refused(invalid("add/remove"));
    if (change.add.length === 0 && change.remove.length === 0) return refused(invalid("add/remove: both empty"));
    const addProbe = change.add.length > 0 ? addHulls([], change.add, L) : { ok: true, add: [], added: 0 };
    if (!addProbe.ok) return refused(addProbe);
    const removeList = change.remove.length > 0 ? addHulls([], change.remove, L) : { ok: true, add: [] };
    if (!removeList.ok) return refused(removeList);
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: FLEET_AGGREGATE, id: change.fleetId }, eventType: "FLEET_UPGRADED",
      payload: { fleetId: change.fleetId, systemId: change.systemId, fleetRole: change.fleetRole,
        add: addProbe.add, remove: removeList.add } }, (db) => {
      const loaded = loadFleet(stmts(db), change.fleetId, change.expectedVersion, INITIAL_FLEET_STATE);
      if (!loaded.ok) return loaded;
      const row = loaded.row;
      if (row.refit_pending === 1) return { ok: false, reason: "REFIT_PENDING" };
      if (row.operation_id !== null) return { ok: false, reason: "OPERATION_SET", operationId: row.operation_id };
      if (row.current_system_id !== change.systemId) {
        return { ok: false, reason: "LOCATION_MISMATCH", expected: change.systemId, actual: row.current_system_id };
      }
      if (row.fleet_role !== change.fleetRole) {
        return { ok: false, reason: "ROLE_MISMATCH", expected: change.fleetRole, actual: row.fleet_role };
      }
      const draft = toDraft(row);
      let next = { composition: draft.composition, shipCount: draft.shipCount };
      if (removeList.add.length > 0) {
        next = removeHulls(next.composition, removeList.add, L);
        if (!next.ok) return next;
      }
      if (addProbe.add.length > 0) {
        next = addHulls(next.composition, addProbe.add, L);
        if (!next.ok) return next;
      }
      if (next.shipCount < 1 || next.shipCount > L.maxShipsPerFleet) {
        return { ok: false, reason: "FLEET_SHIP_LIMIT", limit: L.maxShipsPerFleet, shipCount: next.shipCount };
      }
      draft.composition = next.composition;
      draft.shipCount = next.shipCount;
      const inv = checkFleetInvariants(draft);
      if (!inv.ok) return inv;
      const written = writeFleet(db, draft, change.expectedVersion, now);
      if (!written.ok) return written;
      return { ok: true, version: written.version, shipCount: next.shipCount, composition: next.composition,
        added: addProbe.add.reduce((n, e) => n + e.count, 0),
        removed: removeList.add.reduce((n, e) => n + e.count, 0) };
    });
    if (!result.ok) return refused(result.reason === "APPLY_REFUSED" ? result.refusal : result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("fleets.upgraded");
    return { ok: true, duplicate: false, fleetId: change.fleetId, ...result.value, journalId: result.journalId };
  }

  function validateOperation(spec) {
    if (!isPlainObject(spec)) return invalid("spec");
    const extra = unknownKeys(spec, OPERATION_KEYS);
    if (extra.length > 0) return invalid(`spec: field ${extra[0]}`);
    if (typeof spec.operationType !== "string") return invalid("operationType");
    if (!OPERATION_TYPES.includes(spec.operationType)) {
      return { ok: false, reason: "UNKNOWN_OPERATION_TYPE", operationType: spec.operationType };
    }
    if (typeof spec.objective !== "string") return invalid("objective");
    if (!OBJECTIVES.includes(spec.objective)) {
      return { ok: false, reason: "UNKNOWN_OBJECTIVE", objective: spec.objective };
    }
    for (const key of ["factionId", "originSystemId", "targetSystemId"]) {
      if (!isPositiveId(spec[key])) return invalid(key);
    }
    const dueAt = spec.dueAt === undefined ? null : spec.dueAt;
    if (dueAt !== null && !isNonNegativeInt(dueAt)) return invalid("dueAt");
    if (!Array.isArray(spec.fleets)) return invalid("fleets: not an array");
    if (spec.fleets.length === 0) return invalid("fleets: empty");
    if (spec.fleets.length > L.maxFleetsPerOperation) {
      return { ok: false, reason: "TOO_MANY_FLEETS", count: spec.fleets.length, limit: L.maxFleetsPerOperation };
    }
    const fleets = [];
    for (let i = 0; i < spec.fleets.length; i += 1) {
      const f = spec.fleets[i];
      if (!isPlainObject(f) || unknownKeys(f, ["fleetId", "expectedVersion"]).length > 0) {
        return invalid(`fleets[${i}]`);
      }
      if (!isText(f.fleetId, MAX_ID_LENGTH)) return invalid(`fleets[${i}].fleetId`);
      if (!Number.isSafeInteger(f.expectedVersion) || f.expectedVersion < INITIAL_VERSION) {
        return invalid(`fleets[${i}].expectedVersion`);
      }
      fleets.push({ fleetId: f.fleetId, expectedVersion: f.expectedVersion });
    }
    if (new Set(fleets.map((f) => f.fleetId)).size !== fleets.length) return invalid("fleets: duplicate fleetId");
    if (spec.operationId !== undefined && !isText(spec.operationId, MAX_ID_LENGTH)) return invalid("operationId");
    return { ok: true, fleets, normalized: { operationType: spec.operationType, factionId: spec.factionId,
      originSystemId: spec.originSystemId, targetSystemId: spec.targetSystemId, objective: spec.objective, dueAt,
      fleetIds: fleets.map((f) => f.fleetId) } };
  }

  function createOperation(tx, spec, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateOperation(spec);
    if (!valid.ok) return refused(valid);
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    let operationId = spec.operationId;
    if (operationId === undefined) {
      const earlier = idOfKey(tx, idempotencyKey, OPERATION_AGGREGATE);
      if (!earlier.ok) return refused(earlier);
      operationId = earlier.id !== undefined ? earlier.id : ids.next("op");
    }
    const seed = deriveSeed(worldSeed, OPERATION_AGGREGATE, operationId);
    const n = valid.normalized;
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: OPERATION_AGGREGATE, id: operationId }, eventType: "OPERATION_CREATED", payload: n }, (db) => {
      const s = stmts(db);
      if (s.operationById.get(operationId)) return { ok: false, reason: "OPERATION_EXISTS", operationId };
      s.insertOperation.run(operationId, idempotencyKey, n.operationType, toBind(n.factionId),
        toBind(n.originSystemId), toBind(n.targetSystemId), JSON.stringify(n.fleetIds), n.objective,
        INITIAL_OPERATION_STATE, toBind(now), toBind(n.dueAt), null, toBind(seed), null, toBind(now),
        toBind(INITIAL_VERSION));
      for (const f of valid.fleets) {
        const row = s.fleetById.get(f.fleetId);
        if (!row) return { ok: false, reason: "ROW_NOT_FOUND", fleetId: f.fleetId };
        if (row.faction_id !== n.factionId) {
          return { ok: false, reason: "FLEET_FACTION_MISMATCH", fleetId: f.fleetId, factionId: row.faction_id,
            operationFactionId: n.factionId };
        }
        if (!ASSIGNABLE_FLEET_STATES.includes(row.state)) {
          return { ok: false, reason: "ILLEGAL_TRANSITION", from: row.state, to: "PLANNED", fleetId: f.fleetId };
        }
        const r = transition(db, { fleetId: f.fleetId, expectedVersion: f.expectedVersion, from: row.state,
          to: "PLANNED", patch: { operationId } }, `${idempotencyKey}:fleet:${f.fleetId}`);
        if (!r.ok) return { ...r, fleetId: f.fleetId };
        if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", fleetId: f.fleetId };
      }
      return { ok: true };
    });
    if (!result.ok) return refused(result.reason === "APPLY_REFUSED" ? result.refusal : result);
    if (result.duplicate) return { ok: true, duplicate: true, operationId, journalId: result.journalId };
    count("fleets.operation.created");
    return { ok: true, duplicate: false, operationId, seed, version: INITIAL_VERSION, journalId: result.journalId };
  }

  function transitionOperation(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(change)) return refused(invalid("change"));
    const extra = unknownKeys(change, ["operationId", "expectedVersion", "from", "to", "result"]);
    if (extra.length > 0) return refused(invalid(`change: field ${extra[0]}`));
    if (!isText(change.operationId, MAX_ID_LENGTH)) return refused(invalid("operationId"));
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < INITIAL_VERSION) {
      return refused(invalid("expectedVersion"));
    }
    const edge = canTransitionOperation(change.from, change.to);
    if (!edge.ok) return refused(edge);
    const terminal = TERMINAL_OPERATION_STATES.includes(change.to);
    const resultValue = change.result === undefined ? null : change.result;
    let resultJson = null;
    if (resultValue !== null) {
      if (!terminal) return refused(invalid("result: only on a terminal state"));
      const size = jsonBytes(resultValue, "result");
      if (!size.ok) return refused(size);
      if (size.bytes > L.maxJsonBytes) return refused(invalid(`result: ${size.bytes} bytes > ${L.maxJsonBytes}`));
      resultJson = size.text;
    }
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: OPERATION_AGGREGATE, id: change.operationId }, eventType: "OPERATION_TRANSITION",
      payload: { operationId: change.operationId, from: change.from, to: change.to, result: resultValue } }, (db) => {
      const s = stmts(db);
      const row = s.operationById.get(change.operationId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", operationId: change.operationId };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.state !== change.from) {
        return { ok: false, reason: "STATE_MISMATCH", expected: change.from, actual: row.state };
      }
      const patch = { state: change.to, updated_at: now };
      if (terminal) {
        const ordered = s.orderedOfOperation.get(change.operationId, JSON.stringify(ORDERED_FLEET_STATES)).n;
        if (ordered > 0) return { ok: false, reason: "OPERATION_HAS_FLEETS", count: ordered };
        patch.completed_at = now;
        patch.result_json = resultJson;
      }
      return updateWithVersion(db, OPERATION_TABLE, change.operationId, change.expectedVersion, patch);
    });
    if (!result.ok) return refused(result.reason === "APPLY_REFUSED" ? result.refusal : result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    if (terminal) count("fleets.operation.closed");
    return { ok: true, duplicate: false, operationId: change.operationId, version: result.value.version,
      state: change.to, journalId: result.journalId };
  }

  function readPage(opts, afterKey) {
    if (!isPlainObject(opts)) return invalid("opts");
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts.limit");
    const after = opts[afterKey] === undefined ? "" : opts[afterKey];
    if (typeof after !== "string" || after.length > MAX_ID_LENGTH) return invalid(`opts.${afterKey}`);
    return { ok: true, after, limit: Math.min(opts.limit, L.maxListLimit) };
  }

  function fleetPage(rows, limit) {
    return { ok: true, fleets: rows.map(toFleet),
      nextAfterFleetId: rows.length === limit ? rows[rows.length - 1].fleet_id : null };
  }

  function getFleet(tx, fleetId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
    const row = stmts(tx).fleetById.get(fleetId);
    return { ok: true, fleet: row ? toFleet(row) : null };
  }

  function getFleets(tx, fleetIds) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(fleetIds) || !fleetIds.every((id) => isText(id, MAX_ID_LENGTH))) return invalid("fleetIds");
    const list = [...new Set(fleetIds)].sort();
    if (list.length > L.maxListLimit) {
      return { ok: false, reason: "BATCH_TOO_LARGE", count: list.length, limit: L.maxListLimit };
    }
    if (list.length === 0) return { ok: true, fleets: [], missing: [] };
    const rows = stmts(tx).fleetsByIds.all(JSON.stringify(list));
    const found = new Set(rows.map((row) => row.fleet_id));
    return { ok: true, fleets: rows.map(toFleet), missing: list.filter((id) => !found.has(id)) };
  }

  function listFleetsInSystem(tx, systemId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(systemId)) return invalid("systemId");
    const page = readPage(opts, "afterFleetId");
    if (!page.ok) return page;
    const s = stmts(tx);
    if (opts.states === undefined) {
      return fleetPage(s.inSystem.all(toBind(systemId), page.after, toBind(page.limit)), page.limit);
    }
    if (!Array.isArray(opts.states) || opts.states.length === 0) return invalid("opts.states");
    const unknown = opts.states.find((st) => !FLEET_STATES.includes(st));
    if (unknown !== undefined) return { ok: false, reason: "UNKNOWN_STATE", state: unknown };
    return fleetPage(statesStmt(tx, "inSystemStates", opts.states).all(toBind(systemId), page.after,
      toBind(page.limit)), page.limit);
  }

  function listFleetsInSystems(tx, systemIds, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(systemIds) || !systemIds.every(isPositiveId)) return invalid("systemIds");
    if (!isPlainObject(opts)) return invalid("opts");
    if (!Number.isSafeInteger(opts.limitPerSystem) || opts.limitPerSystem < 1) return invalid("opts.limitPerSystem");
    if (!Array.isArray(opts.states) || opts.states.length === 0) return invalid("opts.states");
    const unknown = opts.states.find((st) => !FLEET_STATES.includes(st));
    if (unknown !== undefined) return { ok: false, reason: "UNKNOWN_STATE", state: unknown };
    const list = [...new Set(systemIds)].sort((a, b) => a - b);
    if (list.length > L.maxListLimit) {
      return { ok: false, reason: "BATCH_TOO_LARGE", count: list.length, limit: L.maxListLimit };
    }
    const bySystem = new Map(list.map((id) => [id, []]));
    if (list.length === 0) return { ok: true, bySystem };
    const limit = Math.min(opts.limitPerSystem, L.maxListLimit);
    const rows = statesStmt(tx, "inSystemsStates", opts.states).all(JSON.stringify(list), toBind(limit));
    for (const row of rows) bySystem.get(row.current_system_id).push(toFleet(row));
    return { ok: true, bySystem };
  }

  function listFleetsByFaction(tx, factionId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(factionId)) return invalid("factionId");
    const page = readPage(opts, "afterFleetId");
    if (!page.ok) return page;
    const s = stmts(tx);
    if (opts.states === undefined) {
      if (opts.role !== undefined) return invalid("opts.role");
      return fleetPage(s.byFaction.all(toBind(factionId), page.after, toBind(page.limit)), page.limit);
    }
    if (!Array.isArray(opts.states) || opts.states.length === 0) return invalid("opts.states");
    const unknown = opts.states.find((st) => !FLEET_STATES.includes(st));
    if (unknown !== undefined) return { ok: false, reason: "UNKNOWN_STATE", state: unknown };
    if (opts.role !== undefined) {
      if (!FLEET_ROLES.includes(opts.role)) return { ok: false, reason: "UNKNOWN_FLEET_ROLE", fleetRole: opts.role };
      if (opts.states.includes(DESTROYED_STATE)) return invalid("opts.role");
      return fleetPage(statesStmt(tx, "byFactionLiveStatesRole", opts.states).all(toBind(factionId), page.after,
        opts.role, toBind(page.limit)), page.limit);
    }
    const stmt = statesStmt(tx, opts.states.includes(DESTROYED_STATE) ? "byFactionStates" : "byFactionLiveStates",
      opts.states);
    return fleetPage(stmt.all(toBind(factionId), page.after, toBind(page.limit)), page.limit);
  }

  function listFleetsByState(tx, state, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!FLEET_STATES.includes(state)) return { ok: false, reason: "UNKNOWN_STATE", state };
    const page = readPage(opts, "afterFleetId");
    if (!page.ok) return page;
    if (opts.role !== undefined) {
      if (!FLEET_ROLES.includes(opts.role)) return { ok: false, reason: "UNKNOWN_FLEET_ROLE", fleetRole: opts.role };
      return fleetPage(stmts(tx).byStateRole.all(state, opts.role, page.after, toBind(page.limit)), page.limit);
    }
    return fleetPage(stmts(tx).byState.all(state, page.after, toBind(page.limit)), page.limit);
  }

  function listFleetsOfOperation(tx, operationId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(operationId, MAX_ID_LENGTH)) return invalid("operationId");
    const rows = stmts(tx).ofOperation.all(operationId, DESTROYED_STATE, toBind(L.maxFleetsPerOperation + 1));
    const truncated = rows.length > L.maxFleetsPerOperation;
    return { ok: true, fleets: (truncated ? rows.slice(0, L.maxFleetsPerOperation) : rows).map(toFleet), truncated };
  }

  function getOperation(tx, operationId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(operationId, MAX_ID_LENGTH)) return invalid("operationId");
    const row = stmts(tx).operationById.get(operationId);
    return { ok: true, operation: row ? toOperation(row) : null };
  }

  function listOperations(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const page = readPage(opts, "afterOperationId");
    if (!page.ok) return page;
    const factionId = opts.factionId;
    if (factionId !== undefined && !isPositiveId(factionId)) return invalid("opts.factionId");
    const state = opts.state;
    if (state !== undefined && !OPERATION_STATES.includes(state)) return { ok: false, reason: "UNKNOWN_STATE", state };
    const s = stmts(tx);
    const limit = toBind(page.limit);
    let rows;
    if (opts.operationTypes !== undefined) {
      if (state === undefined || factionId !== undefined || opts.states !== undefined
        || !Array.isArray(opts.operationTypes) || opts.operationTypes.length === 0) {
        return invalid("opts.operationTypes");
      }
      const unknown = opts.operationTypes.find((t) => !OPERATION_TYPES.includes(t));
      if (unknown !== undefined) return { ok: false, reason: "UNKNOWN_OPERATION_TYPE", operationType: unknown };
      rows = s.opsByStateTypes.all(state, JSON.stringify(opts.operationTypes), page.after, limit);
    }
    else if (opts.states !== undefined) {
      if (state !== undefined || factionId === undefined) return invalid("opts.states");
      if (!Array.isArray(opts.states) || opts.states.length === 0) return invalid("opts.states");
      const unknown = opts.states.find((st) => !OPERATION_STATES.includes(st));
      if (unknown !== undefined) return { ok: false, reason: "UNKNOWN_STATE", state: unknown };
      rows = s.opsByFactionStates.all(toBind(factionId), JSON.stringify(opts.states), page.after, limit);
    }
    else if (factionId !== undefined && state !== undefined) {
      rows = s.opsByFactionState.all(toBind(factionId), state, page.after, limit);
    }
    else if (factionId !== undefined) rows = s.opsByFaction.all(toBind(factionId), page.after, limit);
    else if (state !== undefined) rows = s.opsByState.all(state, page.after, limit);
    else rows = s.opsAll.all(page.after, limit);
    return { ok: true, operations: rows.map(toOperation),
      nextAfterOperationId: rows.length === page.limit ? rows[rows.length - 1].operation_id : null };
  }

  function listOperationsByTarget(tx, systemId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(systemId)) return invalid("systemId");
    if (!isPlainObject(opts)) return invalid("opts");
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts.limit");
    if (!Array.isArray(opts.states) || opts.states.length === 0) return invalid("opts.states");
    const unknown = opts.states.find((st) => !OPERATION_STATES.includes(st));
    if (unknown !== undefined) return { ok: false, reason: "UNKNOWN_STATE", state: unknown };
    if (opts.operationType !== undefined && !OPERATION_TYPES.includes(opts.operationType)) {
      return invalid("opts.operationType");
    }
    const limit = toBind(Math.min(opts.limit, L.maxListLimit));
    const rows = opts.operationType === undefined
      ? stmts(tx).opsByTarget.all(toBind(systemId), JSON.stringify(opts.states), limit)
      : stmts(tx).opsByTargetType.all(toBind(systemId), JSON.stringify(opts.states), opts.operationType, limit);
    return { ok: true, operations: rows.map(toOperation) };
  }

  function countByState(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const counts = {};
    let active = 0;
    for (const row of stmts(tx).countByState.all()) {
      counts[row.state] = row.n;
      if (row.state !== DESTROYED_STATE) active += row.n;
    }
    return { ok: true, counts, active };
  }

  function countOperationsByState(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const counts = {};
    for (const row of stmts(tx).opsCountByState.all()) counts[row.state] = row.n;
    return { ok: true, counts };
  }

  function summarizeStationary(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || !Array.isArray(opts.states) || opts.states.length === 0) return invalid("opts.states");
    const unknown = opts.states.find((st) => !FLEET_STATES.includes(st));
    if (unknown !== undefined) return { ok: false, reason: "UNKNOWN_STATE", state: unknown };
    const maxLines = opts.maxLinesPerSystem;
    if (!isNonNegativeInt(maxLines) || maxLines > SUMMARY_MAX_LINES) return invalid("opts.maxLinesPerSystem");
    const s = stmts(tx);
    const states = JSON.stringify(opts.states);
    const bySystem = new Map();
    for (const row of s.stationaryCounts.all(states)) {
      const systemId = Number(row.s);
      let sys = bySystem.get(systemId);
      if (!sys) {
        sys = { systemId, counts: {}, fleets: 0, ships: 0, lines: [], byFaction: new Map() };
        bySystem.set(systemId, sys);
      }
      const n = Number(row.n);
      const ships = Number(row.ships);
      sys.counts[row.state] = (sys.counts[row.state] || 0) + n;
      sys.fleets += n;
      sys.ships += ships;
      const factionId = Number(row.f);
      let fac = sys.byFaction.get(factionId);
      if (!fac) {
        fac = { fleets: 0, ships: 0, counts: {}, shipCounts: {} };
        sys.byFaction.set(factionId, fac);
      }
      fac.fleets += n;
      fac.ships += ships;
      fac.counts[row.state] = (fac.counts[row.state] || 0) + n;
      fac.shipCounts[row.state] = (fac.shipCounts[row.state] || 0) + ships;
    }
    if (maxLines > 0) {
      for (const row of s.stationaryLines.all(states, toBind(maxLines))) {
        const sys = bySystem.get(Number(row.current_system_id));
        if (!sys) continue;
        sys.lines.push({ fleetId: row.fleet_id, factionId: Number(row.faction_id), state: row.state,
          shipCount: Number(row.ship_count), operationId: row.operation_id === null ? null : row.operation_id });
      }
    }
    return { ok: true, systems: [...bySystem.values()].sort((a, b) => a.systemId - b.systemId) };
  }

  function summarizeFactions(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || !Array.isArray(opts.states) || opts.states.length === 0) return invalid("opts.states");
    const unknown = opts.states.find((st) => !FLEET_STATES.includes(st));
    if (unknown !== undefined) return { ok: false, reason: "UNKNOWN_STATE", state: unknown };
    const s = stmts(tx);
    const states = JSON.stringify(opts.states);
    const byFaction = new Map();
    const entry = (factionId) => {
      let fac = byFaction.get(factionId);
      if (!fac) {
        fac = { factionId, fleets: 0, ships: 0, byState: {}, hullMap: new Map() };
        byFaction.set(factionId, fac);
      }
      return fac;
    };
    for (const row of s.summaryByFactionState.all(states)) {
      const fac = entry(Number(row.f));
      const n = Number(row.n);
      fac.fleets += n;
      fac.ships += Number(row.ships) || 0;
      fac.byState[row.state] = (fac.byState[row.state] || 0) + n;
    }
    for (const row of s.summaryHullsByFaction.all(states)) {
      if (typeof row.g !== "string" || row.g === "") continue;
      const fac = entry(Number(row.f));
      fac.hullMap.set(row.g, (fac.hullMap.get(row.g) || 0) + (Number(row.n) || 0));
    }
    const factions = [...byFaction.values()].sort((a, b) => a.factionId - b.factionId).map((fac) => ({
      factionId: fac.factionId, fleets: fac.fleets, ships: fac.ships, byState: fac.byState,
      hulls: [...fac.hullMap].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    }));
    return { ok: true, factions };
  }

  function countOverdueInFlight(tx, beforeMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isNonNegativeInt(beforeMs)) return invalid("beforeMs");
    return { ok: true, count: stmts(tx).overdueInFlight.get(toBind(beforeMs)).n };
  }

  function isApplied(tx, idempotencyKey) {
    const found = journal.findByKey(tx, idempotencyKey);
    if (!found.ok) return found;
    return { ok: true, applied: found.found && found.entry.kind === KIND_APPLY };
  }

  return Object.freeze({
    createFleet,
    transition,
    reassignRole,
    applyLosses,
    replenish,
    disband,
    upgradeComposition,
    createOperation,
    transitionOperation,
    getFleet,
    getFleets,
    listFleetsInSystem,
    listFleetsInSystems,
    listFleetsByFaction,
    listFleetsByState,
    listFleetsOfOperation,
    getOperation,
    listOperations,
    listOperationsByTarget,
    countByState,
    countOperationsByState,
    countOverdueInFlight,
    summarizeStationary,
    summarizeFactions,
    isApplied,
    limits: L,
  });
}

module.exports = { createFleetRepository, FLEET_AGGREGATE, OPERATION_AGGREGATE, FLEET_TABLE, OPERATION_TABLE };
