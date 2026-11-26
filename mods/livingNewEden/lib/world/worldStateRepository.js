"use strict";

const { defineTable, updateWithVersion, toBind } = require("../persistence/repository");
const { KIND_APPLY } = require("../persistence/journal");
const { validateChange, toJournalPayload } = require("./changeSet");
const { STATE_TABLE_NAME, INFLUENCE_TABLE_NAME } = require("./schema");

const AGGREGATE_TYPE = "world_system";
const INITIAL_VERSION = 1;

const STATE_TABLE = defineTable({
  name: STATE_TABLE_NAME,
  idColumn: "system_id",
  columns: ["security_class", "controller_faction_id", "occupation_state", "threat_level", "last_state_change_at",
    "next_strategy_review_at", "updated_at", "occupier_faction_id", "previous_controller_faction_id", "phase_seq",
    "phase_due_at", "influence_evaluated_at", "captured_at", "detached_since_at", "home_faction_id"],
});

const INSERT_COLUMNS = "system_id, security_class, controller_faction_id, occupation_state, threat_level, "
  + "last_state_change_at, next_strategy_review_at, updated_at, version, home_faction_id";
const STATE_COLUMNS = `${INSERT_COLUMNS}, occupier_faction_id, previous_controller_faction_id, phase_seq, `
  + "phase_due_at, influence_evaluated_at, captured_at, detached_since_at";
const INFLUENCE_COLUMNS = "system_id, faction_id, influence_score, garrison_strength, local_supply, supply_capacity, "
  + "last_updated_at, version";

const STATE_FIELD_COLUMNS = Object.freeze([
  ["controllerFactionId", "controller_faction_id"],
  ["occupationState", "occupation_state"],
  ["threatLevel", "threat_level"],
  ["nextStrategyReviewAt", "next_strategy_review_at"],
  ["occupierFactionId", "occupier_faction_id"],
  ["previousControllerFactionId", "previous_controller_faction_id"],
  ["phaseSeq", "phase_seq"],
  ["phaseDueAt", "phase_due_at"],
  ["influenceEvaluatedAt", "influence_evaluated_at"],
  ["capturedAt", "captured_at"],
  ["detachedSinceAt", "detached_since_at"],
]);
const STATE_CHANGE_FIELDS = Object.freeze(["controllerFactionId", "occupationState"]);
const INFLUENCE_FIELDS = Object.freeze(["influenceScore", "garrisonStrength", "localSupply", "supplyCapacity"]);

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

function invalid(detail) {
  return { ok: false, reason: "WORLD_INVALID_INPUT", detail };
}

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function toInfluence(row) {
  return Object.freeze({
    systemId: row.system_id,
    factionId: row.faction_id,
    influenceScore: row.influence_score,
    garrisonStrength: row.garrison_strength,
    localSupply: row.local_supply,
    supplyCapacity: row.supply_capacity,
    lastUpdatedAt: row.last_updated_at,
    version: row.version,
  });
}

function toSystem(row, influence) {
  const record = {
    systemId: row.system_id,
    securityClass: row.security_class,
    controllerFactionId: row.controller_faction_id,
    occupationState: row.occupation_state,
    threatLevel: row.threat_level,
    lastStateChangeAt: row.last_state_change_at,
    nextStrategyReviewAt: row.next_strategy_review_at,
    updatedAt: row.updated_at,
    version: row.version,
    occupierFactionId: row.occupier_faction_id,
    previousControllerFactionId: row.previous_controller_faction_id,
    phaseSeq: row.phase_seq,
    phaseDueAt: row.phase_due_at,
    influenceEvaluatedAt: row.influence_evaluated_at,
    capturedAt: row.captured_at,
    detachedSinceAt: row.detached_since_at,
    homeFactionId: row.home_faction_id === null ? null : row.home_faction_id,
  };
  if (influence) record.influence = Object.freeze(influence);
  return Object.freeze(record);
}

function groupInfluence(rows) {
  const bySystem = new Map();
  for (const row of rows) {
    let list = bySystem.get(row.system_id);
    if (!list) {
      list = [];
      bySystem.set(row.system_id, list);
    }
    list.push(toInfluence(row));
  }
  return bySystem;
}

function createWorldStateRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createWorldStateRepository: deps missing");
  const { journal, clock, limits, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("createWorldStateRepository: journal with applyOnce/findByKey required");
  }
  if (!clock || typeof clock.now !== "function") throw new TypeError("createWorldStateRepository: clock.now required");
  if (!limits || typeof limits !== "object") throw new TypeError("createWorldStateRepository: limits missing");
  for (const name of ["maxFactionsPerSystem", "maxBatchReadIds", "maxListLimit"]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`createWorldStateRepository: limits.${name} must be a positive integer, got ${limits[name]}`);
    }
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createWorldStateRepository: onCount must be a function");
  }
  const onInvalidate = typeof deps.onInvalidate === "function" ? deps.onInvalidate : null;
  const frozenLimits = Object.freeze({
    maxFactionsPerSystem: limits.maxFactionsPerSystem,
    maxBatchReadIds: limits.maxBatchReadIds,
    maxListLimit: limits.maxListLimit,
  });

  let changeCount = 0;

  const count = (name, n = 1) => {
    if (!onCount) return;
    try {
      onCount(name, n);
    } catch (_err) {
    }
  };

  const rc = deps.readCache;
  const cacheMax = rc && typeof rc === "object" && typeof rc.txSeq === "function"
    && Number.isSafeInteger(rc.maxSystems) && rc.maxSystems > 0 ? rc.maxSystems : 0;
  const txSeqOf = cacheMax > 0 ? rc.txSeq : null;
  const caches = new WeakMap();
  function cacheOf(db) {
    if (cacheMax === 0) return null;
    let c = caches.get(db);
    if (!c) {
      c = { plain: new Map(), full: new Map(), dirtySeq: -1, dirty: new Set() };
      caches.set(db, c);
    }
    const seq = txSeqOf();
    if (c.dirtySeq !== seq) {
      c.dirty.clear();
      c.dirtySeq = seq;
    }
    return c;
  }
  function invalidate(db, systemId) {
    if (onInvalidate) {
      try {
        onInvalidate(systemId);
      } catch (_err) {
      }
    }
    const c = cacheOf(db);
    if (!c) return;
    c.plain.delete(systemId);
    c.full.delete(systemId);
    c.dirty.add(systemId);
    count("world.readCache.invalidations");
  }
  function cacheRoom(c) {
    if (c.plain.size + c.full.size < 2 * cacheMax) return;
    c.plain.clear();
    c.full.clear();
    count("world.readCache.resets");
  }

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      stateById: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME} WHERE system_id = ?`),
      insertState: db.prepare(`INSERT INTO ${STATE_TABLE_NAME} (${INSERT_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      statesByIds: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE system_id IN (SELECT value FROM json_each(?)) ORDER BY system_id`),
      statesAfter: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE system_id > ? ORDER BY system_id LIMIT ?`),
      activeAfter: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE occupation_state <> 'STABLE' AND system_id > ? ORDER BY system_id LIMIT ?`),
      countActive: db.prepare(`SELECT count(*) AS n FROM ${STATE_TABLE_NAME} WHERE occupation_state <> 'STABLE'`),
      liberatedAfter: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE occupation_state = 'STABLE' AND controller_faction_id IS NULL
          AND previous_controller_faction_id IS NOT NULL AND system_id > ?
        ORDER BY system_id LIMIT ?`),
      liberatedSince: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE occupation_state = 'STABLE' AND controller_faction_id IS NULL
          AND previous_controller_faction_id IS NOT NULL AND last_state_change_at > ?
        ORDER BY last_state_change_at DESC, system_id ASC LIMIT ?`),
      countByController: db.prepare(`SELECT count(*) AS n FROM ${STATE_TABLE_NAME} WHERE controller_faction_id = ?`),
      detachedByController: db.prepare(`SELECT controller_faction_id AS f, count(*) AS n FROM ${STATE_TABLE_NAME}
        WHERE detached_since_at IS NOT NULL AND controller_faction_id IS NOT NULL
        GROUP BY controller_faction_id ORDER BY controller_faction_id`),
      byOccupier: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE occupier_faction_id = ? AND system_id > ? ORDER BY system_id LIMIT ?`),
      byController: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE controller_faction_id = ? AND system_id > ? ORDER BY system_id LIMIT ?`),
      capturedByController: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE controller_faction_id = ? AND captured_at IS NOT NULL AND system_id > ? ORDER BY system_id LIMIT ?`),
      threatenedByController: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        INDEXED BY world_system_state_active
        WHERE occupation_state <> 'STABLE' AND controller_faction_id = ?
        AND occupation_state IN ('CONTESTED','INVASION')
        AND occupier_faction_id IS NOT NULL AND system_id > ? ORDER BY system_id LIMIT ?`),
      threatenedControllers: db.prepare(`SELECT DISTINCT controller_faction_id AS f FROM ${STATE_TABLE_NAME}
        INDEXED BY world_system_state_active
        WHERE occupation_state <> 'STABLE' AND occupation_state IN ('CONTESTED','INVASION')
        AND occupier_faction_id IS NOT NULL AND controller_faction_id IS NOT NULL
        ORDER BY controller_faction_id LIMIT ?`),
      lostHome: db.prepare(`SELECT ${STATE_COLUMNS} FROM ${STATE_TABLE_NAME}
        WHERE home_faction_id = ? AND home_faction_id IS NOT NULL
        AND (controller_faction_id IS NULL OR controller_faction_id <> home_faction_id)
        AND system_id > ? ORDER BY system_id LIMIT ?`),
      clearHome: db.prepare(`UPDATE ${STATE_TABLE_NAME} SET home_faction_id = NULL
        WHERE system_id = ? AND home_faction_id = ?`),
      setHome: db.prepare(`UPDATE ${STATE_TABLE_NAME} SET home_faction_id = ?
        WHERE system_id = ? AND (home_faction_id IS NULL OR home_faction_id <> ?)`),
      influenceOfSystem: db.prepare(`SELECT ${INFLUENCE_COLUMNS} FROM ${INFLUENCE_TABLE_NAME}
        WHERE system_id = ? ORDER BY faction_id`),
      influenceByIds: db.prepare(`SELECT ${INFLUENCE_COLUMNS} FROM ${INFLUENCE_TABLE_NAME}
        WHERE system_id IN (SELECT value FROM json_each(?)) ORDER BY system_id, faction_id`),
      influenceByFaction: db.prepare(`SELECT ${INFLUENCE_COLUMNS} FROM ${INFLUENCE_TABLE_NAME}
        WHERE faction_id = ? AND system_id > ? ORDER BY system_id LIMIT ?`),
      insertInfluence: db.prepare(`INSERT INTO ${INFLUENCE_TABLE_NAME} (${INFLUENCE_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      updateInfluence: db.prepare(`UPDATE ${INFLUENCE_TABLE_NAME} SET influence_score = ?, garrison_strength = ?,
        local_supply = ?, supply_capacity = ?, last_updated_at = ?, version = version + 1
        WHERE system_id = ? AND faction_id = ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function writeState(db, s, change, now) {
    const { systemId, state } = change;
    invalidate(db, systemId);
    if (change.create) {
      if (s.stateById.get(toBind(systemId))) return { ok: false, reason: "SYSTEM_EXISTS" };
      s.insertState.run(toBind(systemId), state.securityClass, toBind(state.controllerFactionId),
        state.occupationState, state.threatLevel, toBind(now), toBind(state.nextStrategyReviewAt),
        toBind(now), toBind(INITIAL_VERSION), toBind(state.controllerFactionId));
      return { ok: true, version: INITIAL_VERSION };
    }
    const row = s.stateById.get(toBind(systemId));
    if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
    const patch = { updated_at: now };
    for (const [field, column] of STATE_FIELD_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(state, field)) patch[column] = state[field];
    }
    const current = { controllerFactionId: row.controller_faction_id, occupationState: row.occupation_state };
    if (STATE_CHANGE_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(state, f) && state[f] !== current[f])) {
      patch.last_state_change_at = now;
    }
    return updateWithVersion(db, STATE_TABLE, systemId, change.expectedVersion, patch);
  }

  function writeInfluence(db, s, change, now) {
    if (change.influence.length === 0) return { ok: true };
    invalidate(db, change.systemId);
    const existing = new Map(s.influenceOfSystem.all(toBind(change.systemId)).map((row) => [row.faction_id, row]));
    const added = change.influence.filter((entry) => !existing.has(entry.factionId)).length;
    const total = existing.size + added;
    if (total > frozenLimits.maxFactionsPerSystem) {
      return { ok: false, reason: "TOO_MANY_FACTIONS", count: total, limit: frozenLimits.maxFactionsPerSystem };
    }
    for (const entry of change.influence) {
      const row = existing.get(entry.factionId);
      if (!row) {
        s.insertInfluence.run(toBind(change.systemId), toBind(entry.factionId), entry.influenceScore || 0,
          toBind(entry.garrisonStrength || 0), toBind(entry.localSupply || 0), toBind(entry.supplyCapacity || 0),
          toBind(now), toBind(INITIAL_VERSION));
        continue;
      }
      const current = { influenceScore: row.influence_score, garrisonStrength: row.garrison_strength,
        localSupply: row.local_supply, supplyCapacity: row.supply_capacity };
      const merged = { ...current };
      for (const field of INFLUENCE_FIELDS) if (entry[field] !== undefined) merged[field] = entry[field];
      if (INFLUENCE_FIELDS.every((field) => merged[field] === current[field])) continue;
      s.updateInfluence.run(merged.influenceScore, toBind(merged.garrisonStrength),
        toBind(merged.localSupply), toBind(merged.supplyCapacity), toBind(now), toBind(change.systemId),
        toBind(entry.factionId));
    }
    return { ok: true };
  }

  function applyChange(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateChange(change, frozenLimits);
    if (!valid.ok) return valid;
    const normalized = valid.normalized;
    const now = clock.now();
    if (!Number.isSafeInteger(now) || now < 0) return invalid("clock.now");
    const spec = { key: idempotencyKey, aggregate: { type: AGGREGATE_TYPE, id: normalized.systemId },
      eventType: normalized.reason, payload: toJournalPayload(normalized) };
    const result = journal.applyOnce(tx, spec, (db) => {
      const s = stmts(db);
      const state = writeState(db, s, normalized, now);
      if (!state.ok) return state;
      const influence = writeInfluence(db, s, normalized, now);
      if (!influence.ok) return influence;
      return { ok: true, version: state.version, created: normalized.create };
    });
    if (!result.ok) {
      if (result.reason === "APPLY_REFUSED") {
        count("world.change.refused");
        return result.refusal;
      }
      return result;
    }
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    changeCount += 1;
    count("world.change.applied");
    return { ok: true, duplicate: false, journalId: result.journalId, systemId: normalized.systemId,
      version: result.value.version, created: result.value.created };
  }

  function isApplied(tx, idempotencyKey) {
    const found = journal.findByKey(tx, idempotencyKey);
    if (!found.ok) return found;
    return { ok: true, applied: found.found && found.entry.kind === KIND_APPLY };
  }

  function includeInfluenceOf(opts) {
    if (opts === undefined || opts === null) return true;
    if (typeof opts !== "object") return undefined;
    if (opts.includeInfluence === undefined) return true;
    return typeof opts.includeInfluence === "boolean" ? opts.includeInfluence : undefined;
  }

  function getSystem(tx, systemId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(systemId)) return invalid("systemId");
    const withInfluence = includeInfluenceOf(opts);
    if (withInfluence === undefined) return invalid("opts.includeInfluence");
    const c = cacheOf(tx);
    if (c) {
      const read = cachedSystems(tx, c, [systemId], withInfluence);
      return { ok: true, system: read.systems.length === 1 ? read.systems[0] : null };
    }
    const s = stmts(tx);
    const row = s.stateById.get(toBind(systemId));
    if (!row) return { ok: true, system: null };
    const influence = withInfluence ? s.influenceOfSystem.all(toBind(systemId)).map(toInfluence) : null;
    return { ok: true, system: toSystem(row, influence) };
  }

  function cachedSystems(tx, c, ids, withInfluence) {
    const map = withInfluence ? c.full : c.plain;
    const got = new Map();
    const misses = [];
    for (const id of ids) {
      if (c.dirty.has(id)) {
        misses.push(id);
        continue;
      }
      const hit = map.get(id);
      if (hit !== undefined) got.set(id, hit);
      else if (c.plain.get(id) === null) got.set(id, null);
      else misses.push(id);
    }
    if (got.size > 0) count("world.readCache.hits", got.size);
    if (misses.length > 0) {
      count("world.readCache.misses", misses.length);
      const s = stmts(tx);
      const rows = s.statesByIds.all(JSON.stringify(misses));
      const systems = withInfluenceRows(s, rows, withInfluence);
      for (const system of systems) got.set(system.systemId, system);
      for (const id of misses) {
        if (!got.has(id)) got.set(id, null);
        if (c.dirty.has(id)) continue;
        cacheRoom(c);
        const value = got.get(id);
        if (value === null) {
          c.plain.set(id, null);
          c.full.delete(id);
        } else {
          map.set(id, value);
        }
      }
    }
    const systems = [];
    const missing = [];
    for (const id of ids) {
      const value = got.get(id);
      if (value === null) missing.push(id);
      else systems.push(value);
    }
    return { systems, missing };
  }

  function withInfluenceRows(s, rows, withInfluence) {
    if (!withInfluence) return rows.map((row) => toSystem(row, null));
    if (rows.length === 0) return [];
    const bySystem = groupInfluence(s.influenceByIds.all(JSON.stringify(rows.map((row) => row.system_id))));
    return rows.map((row) => toSystem(row, bySystem.get(row.system_id) || []));
  }

  function getSystems(tx, systemIds, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(systemIds)) return invalid("systemIds: not an array");
    const withInfluence = includeInfluenceOf(opts);
    if (withInfluence === undefined) return invalid("opts.includeInfluence");
    if (!systemIds.every(isPositiveId)) return invalid("systemIds: positive safe integers only");
    const ids = [...new Set(systemIds)].sort((a, b) => a - b);
    if (ids.length > frozenLimits.maxBatchReadIds) {
      return { ok: false, reason: "BATCH_TOO_LARGE", count: ids.length, limit: frozenLimits.maxBatchReadIds };
    }
    if (ids.length === 0) return { ok: true, systems: [], missing: [] };
    const c = cacheOf(tx);
    if (c) {
      const read = cachedSystems(tx, c, ids, withInfluence);
      return { ok: true, systems: read.systems, missing: read.missing };
    }
    const s = stmts(tx);
    const rows = s.statesByIds.all(JSON.stringify(ids));
    const found = new Set(rows.map((row) => row.system_id));
    return { ok: true, systems: withInfluenceRows(s, rows, withInfluence), missing: ids.filter((id) => !found.has(id)) };
  }

  function readPage(opts) {
    if (!opts || typeof opts !== "object") return invalid("opts");
    const afterSystemId = opts.afterSystemId === undefined ? 0 : opts.afterSystemId;
    if (!Number.isSafeInteger(afterSystemId) || afterSystemId < 0) return invalid("opts.afterSystemId");
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts.limit");
    return { ok: true, afterSystemId, limit: Math.min(opts.limit, frozenLimits.maxListLimit) };
  }

  function listSystems(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const page = readPage(opts);
    if (!page.ok) return page;
    const withInfluence = includeInfluenceOf(opts);
    if (withInfluence === undefined) return invalid("opts.includeInfluence");
    const s = stmts(tx);
    const rows = s.statesAfter.all(toBind(page.afterSystemId), toBind(page.limit));
    const next = rows.length === page.limit ? rows[rows.length - 1].system_id : null;
    return { ok: true, systems: withInfluenceRows(s, rows, withInfluence), nextAfterSystemId: next };
  }

  function listInfluenceByFaction(tx, factionId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(factionId)) return invalid("factionId");
    const page = readPage(opts);
    if (!page.ok) return page;
    const rows = stmts(tx).influenceByFaction.all(toBind(factionId), toBind(page.afterSystemId), toBind(page.limit));
    const next = rows.length === page.limit ? rows[rows.length - 1].system_id : null;
    return { ok: true, rows: rows.map(toInfluence), nextAfterSystemId: next };
  }

  function includeOf(opts) {
    if (opts.includeInfluence === undefined) return false;
    return typeof opts.includeInfluence === "boolean" ? opts.includeInfluence : undefined;
  }

  function statePage(tx, opts, read) {
    if (txMissing(tx)) return TX_REQUIRED;
    const page = readPage(opts);
    if (!page.ok) return page;
    const withInfluence = includeOf(opts);
    if (withInfluence === undefined) return invalid("opts.includeInfluence");
    const s = stmts(tx);
    const rows = read(s, page);
    const next = rows.length === page.limit ? rows[rows.length - 1].system_id : null;
    return { ok: true, systems: withInfluenceRows(s, rows, withInfluence), nextAfterSystemId: next };
  }

  function listActiveOccupations(tx, opts) {
    return statePage(tx, opts, (s, p) => s.activeAfter.all(toBind(p.afterSystemId), toBind(p.limit)));
  }

  function listLiberated(tx, opts) {
    return statePage(tx, opts, (s, p) => s.liberatedAfter.all(toBind(p.afterSystemId), toBind(p.limit)));
  }

  function listLiberatedSince(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || typeof opts !== "object") return invalid("opts");
    if (!Number.isSafeInteger(opts.sinceMs) || opts.sinceMs < 0) return invalid("opts.sinceMs");
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts.limit");
    const limit = Math.min(opts.limit, frozenLimits.maxListLimit);
    const rows = stmts(tx).liberatedSince.all(toBind(opts.sinceMs), toBind(limit + 1));
    const truncated = rows.length > limit;
    return { ok: true, systems: (truncated ? rows.slice(0, limit) : rows).map((row) => toSystem(row, null)), truncated };
  }

  function countActiveOccupations(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: stmts(tx).countActive.get().n };
  }

  function countDetachedByController(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const rows = stmts(tx).detachedByController.all();
    return { ok: true, rows: rows.map((r) => Object.freeze({ factionId: r.f, count: r.n })) };
  }

  function listByOccupier(tx, factionId, opts) {
    if (!isPositiveId(factionId)) return invalid("factionId");
    return statePage(tx, opts, (s, p) => s.byOccupier.all(toBind(factionId), toBind(p.afterSystemId),
      toBind(p.limit)));
  }

  function listControlledByFaction(tx, factionId, opts) {
    if (!isPositiveId(factionId)) return invalid("factionId");
    if (opts && opts.capturedOnly !== undefined && typeof opts.capturedOnly !== "boolean") {
      return invalid("opts.capturedOnly");
    }
    const captured = Boolean(opts && opts.capturedOnly === true);
    return statePage(tx, opts, (s, p) => (captured ? s.capturedByController : s.byController)
      .all(toBind(factionId), toBind(p.afterSystemId), toBind(p.limit)));
  }

  function countControlledByFaction(tx, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(factionId)) return invalid("factionId");
    return { ok: true, count: stmts(tx).countByController.get(toBind(factionId)).n };
  }

  function listThreatened(tx, factionId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(factionId)) return invalid("factionId");
    return statePage(tx, opts, (s, p) => s.threatenedByController.all(toBind(factionId), toBind(p.afterSystemId),
      toBind(p.limit)));
  }

  function listThreatenedControllers(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const rows = stmts(tx).threatenedControllers.all(toBind(frozenLimits.maxListLimit));
    return { ok: true, factionIds: rows.map((r) => r.f), truncated: rows.length >= frozenLimits.maxListLimit };
  }

  function listLostHome(tx, factionId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(factionId)) return invalid("factionId");
    return statePage(tx, opts, (s, p) => s.lostHome.all(toBind(factionId), toBind(p.afterSystemId),
      toBind(p.limit)));
  }

  function clearHomeInTx(tx, systemId, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(systemId) || !isPositiveId(factionId)) return invalid("systemId or factionId");
    const s = stmts(tx);
    invalidate(tx, systemId);
    const res = s.clearHome.run(toBind(systemId), toBind(factionId));
    return { ok: true, changed: res.changes > 0 };
  }

  function setHomeInTx(tx, systemId, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(systemId) || !isPositiveId(factionId)) return invalid("systemId or factionId");
    const s = stmts(tx);
    invalidate(tx, systemId);
    const res = s.setHome.run(toBind(factionId), toBind(systemId), toBind(factionId));
    return { ok: true, changed: res.changes > 0 };
  }

  return Object.freeze({
    applyChange,
    listActiveOccupations,
    listLiberated,
    listLiberatedSince,
    countActiveOccupations,
    countControlledByFaction,
    countDetachedByController,
    listByOccupier,
    listControlledByFaction,
    listThreatened,
    listThreatenedControllers,
    listLostHome,
    clearHomeInTx,
    setHomeInTx,
    isApplied,
    getSystem,
    getSystems,
    listSystems,
    listInfluenceByFaction,
    getChangeCount: () => changeCount,
    limits: frozenLimits,
  });
}

module.exports = { createWorldStateRepository, AGGREGATE_TYPE, STATE_TABLE };
