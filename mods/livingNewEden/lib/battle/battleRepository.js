"use strict";

const { defineTable, updateWithVersion, toBind } = require("../persistence/repository");
const { KIND_APPLY } = require("../persistence/journal");
const { settlementSeed } = require("../util/rng");
const { isId } = require("../util/ids");
const { stableJson, fingerprint } = require("../util/fingerprint");
const {
  BATTLES_TABLE_NAME, PARTICIPANTS_TABLE_NAME, LOSSES_TABLE_NAME, BATTLE_STATES, INITIAL_BATTLE_STATE, OPEN_BATTLE_STATES, BATTLE_MODES,
  MAX_HOLD_REASON_LENGTH, MAX_KEY_LENGTH, MAX_CREATE_KEY_LENGTH, MAX_ENUM_LENGTH,
} = require("./schema");
const { canTransitionBattle, checkMode, checkBattleInvariants, CLAIMABLE_STATES, STATES_WITH_ERROR } =
  require("./stateMachine");
const { validateInput, validateResult, hashInput, buildFleetSnapshot } = require("./contract");
const { FLEETS_TABLE_NAME } = require("../fleets/schema");
const { settlementRowBound } = require("./settlementPlan");

const BATTLE_AGGREGATE = "battle";
const CREATED_EVENT = "BATTLE_CREATED";
const INITIAL_VERSION = 1;
const MAX_UINT32 = 0xFFFFFFFF;
const MAX_ID_LENGTH = 64;
const MAX_ERROR_REASON_LENGTH = 64;
const MAX_ERROR_DETAIL_LENGTH = 1000;
const ENGAGED = "ENGAGED";
const UNAVAILABLE_FLEET_STATES = Object.freeze(["DESTROYED", "MATERIALIZED"]);

const LIMIT_NAMES = Object.freeze(["maxFleetsPerSide", "maxCompositionEntries", "maxShipsPerFleet",
  "maxResolutionMs", "maxInputBytes", "maxResultBytes", "maxListLimit", "maxSettlementRows"]);

const COLUMNS = "battle_id, idempotency_key, system_id, environment, objective, mode, state, resolver_version, "
  + "input_hash, seed, input_json, fleet_ids, result_json, hold_reason, error_json, settlement_key, claim_seq, "
  + "created_at, updated_at, settled_at, version, grid_kind, grid_id";
const B_COLUMNS = COLUMNS.split(", ").map((c) => `b.${c}`).join(", ");

const BATTLE_TABLE = defineTable({
  name: BATTLES_TABLE_NAME,
  idColumn: "battle_id",
  columns: ["mode", "state", "claim_seq", "result_json", "hold_reason", "error_json", "settlement_key", "updated_at",
    "settled_at"],
});

const SPEC_KEYS = Object.freeze(["systemId", "environment", "objective", "resolverVersion", "maxResolutionMs",
  "garrison", "sideA", "sideB", "battleId", "structureId", "structureTypeId", "structureSide", "fixedDefenses",
  "grid"]);
const SPEC_STRUCTURE_KEYS = Object.freeze(["structureId", "structureTypeId", "structureSide"]);
const PATCH_KEYS = Object.freeze(["holdReason", "result", "settlementKey", "error"]);
const LOSS_ROW_KEYS = Object.freeze(["fleetId", "factionId", "hullGroup", "typeId", "count"]);
const MAX_HULL_GROUP_LENGTH = 32;
const OPEN_SUMMARY_MAX_LIMIT = 5000;
const VIRTUAL_LOSSES_MAX_LIMIT = 20000;
const VIRTUAL_LOSSES_SQL = `SELECT r.system_id, r.settled_at, l.faction_id, l.type_id, l.count, l.hull_group
  FROM ${BATTLES_TABLE_NAME} r JOIN ${LOSSES_TABLE_NAME} l ON l.battle_id = r.battle_id
  WHERE r.settled_at IS NOT NULL AND r.settled_at >= ? AND r.mode = 'VIRTUAL'
  ORDER BY r.settled_at DESC, r.battle_id, l.fleet_id, l.hull_group, l.type_id
  LIMIT ?`;
const SETTLED_AFTER_MAX_LIMIT = 1000;
const SETTLED_AFTER_SQL = `SELECT battle_id, settled_at FROM ${BATTLES_TABLE_NAME}
  WHERE settled_at IS NOT NULL AND settled_at >= ? AND +state = 'COMPLETED'
    AND (settled_at > ? OR battle_id > ?)
  ORDER BY settled_at, battle_id LIMIT ?`;

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isVersion = (v) => Number.isSafeInteger(v) && v >= INITIAL_VERSION;
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const inputInvalid = (detail) => ({ ok: false, reason: "INPUT_INVALID", detail });
const invalid = (detail) => ({ ok: false, reason: "BATTLE_INVALID_INPUT", detail });
const parseJson = (text) => (text === null ? null : JSON.parse(text));

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
    battleId: row.battle_id,
    idempotencyKey: row.idempotency_key,
    systemId: row.system_id,
    environment: row.environment,
    objective: row.objective,
    mode: row.mode,
    state: row.state,
    resolverVersion: row.resolver_version,
    inputHash: row.input_hash,
    seed: row.seed,
    input: JSON.parse(row.input_json),
    fleetIds: JSON.parse(row.fleet_ids),
    result: parseJson(row.result_json),
    holdReason: row.hold_reason,
    error: parseJson(row.error_json),
    settlementKey: row.settlement_key,
    claimSeq: row.claim_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
    version: row.version,
    grid: row.grid_kind === null || row.grid_kind === undefined ? null
      : { kind: row.grid_kind, id: Number(row.grid_id) },
  };
}

const toBattle = (row) => deepFreeze(toDraft(row));

function createBattleRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createBattleRepository: deps missing");
  const { journal, fleetRepository, clock, ids, worldSeed, limits, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("createBattleRepository: journal with applyOnce/findByKey required");
  }
  if (!fleetRepository || typeof fleetRepository.transition !== "function"
    || typeof fleetRepository.getFleets !== "function") {
    throw new TypeError("createBattleRepository: fleetRepository with transition/getFleets required");
  }
  if (!clock || typeof clock.now !== "function") throw new TypeError("createBattleRepository: clock.now required");
  if (!ids || typeof ids.next !== "function") throw new TypeError("createBattleRepository: ids.next required");
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0 || worldSeed > MAX_UINT32) {
    throw new TypeError(`createBattleRepository: worldSeed must be a uint32, got ${worldSeed}`);
  }
  if (!limits || typeof limits !== "object") throw new TypeError("createBattleRepository: limits missing");
  for (const name of LIMIT_NAMES) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`createBattleRepository: limits.${name} must be a positive integer, got ${limits[name]}`);
    }
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createBattleRepository: onCount must be a function");
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
    count("battle.refused");
    if (result.reason === "FLEET_BUSY") count("battle.busy");
    return result;
  };
  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const B = BATTLES_TABLE_NAME;
    const P = PARTICIPANTS_TABLE_NAME;
    s = {
      byId: db.prepare(`SELECT ${COLUMNS} FROM ${B} WHERE battle_id = ?`),
      insert: db.prepare(`INSERT INTO ${B} (${COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertParticipant: db.prepare(`INSERT INTO ${P} (battle_id, fleet_id, side, faction_id) VALUES (?, ?, ?, ?)`),
      openOfFleet: db.prepare(`SELECT p.battle_id FROM ${P} p JOIN ${B} b ON b.battle_id = p.battle_id
        WHERE p.fleet_id = ? AND b.state IN (SELECT value FROM json_each(?)) LIMIT 1`),
      byFleet: db.prepare(`SELECT ${B_COLUMNS} FROM ${P} p JOIN ${B} b ON b.battle_id = p.battle_id
        WHERE p.fleet_id = ? ORDER BY b.created_at DESC, b.battle_id LIMIT ?`),
      byFleetStates: db.prepare(`SELECT ${B_COLUMNS} FROM ${P} p JOIN ${B} b ON b.battle_id = p.battle_id
        WHERE p.fleet_id = ? AND b.state IN (SELECT value FROM json_each(?))
        ORDER BY b.created_at DESC, b.battle_id LIMIT ?`),
      byState: db.prepare(`SELECT ${COLUMNS} FROM ${B} WHERE state = ? AND battle_id > ? ORDER BY battle_id LIMIT ?`),
      countByState: db.prepare(`SELECT state, count(*) AS n FROM ${B} GROUP BY state`),
      participantsOf: db.prepare(`SELECT fleet_id, faction_id FROM ${P} WHERE battle_id = ?`),
      insertLoss: db.prepare(`INSERT INTO ${LOSSES_TABLE_NAME} (battle_id, fleet_id, faction_id, hull_group, type_id, count)
        VALUES (?, ?, ?, ?, ?, ?)`),
      openBattles: db.prepare(`SELECT battle_id, system_id, state, hold_reason, created_at FROM ${B}
        WHERE state IN (SELECT value FROM json_each(?)) ORDER BY created_at, battle_id LIMIT ?`),
      openSides: db.prepare(`SELECT p.battle_id, p.side, p.faction_id, count(*) AS n, sum(f.ship_count) AS ships
        FROM ${P} p JOIN ${FLEETS_TABLE_NAME} f ON f.fleet_id = p.fleet_id
        WHERE p.battle_id IN (SELECT value FROM json_each(?)) GROUP BY p.battle_id, p.side, p.faction_id`),
      lossesOf: db.prepare(`SELECT fleet_id, faction_id, hull_group, type_id, count FROM ${LOSSES_TABLE_NAME}
        WHERE battle_id = ? ORDER BY fleet_id, hull_group, type_id`),
      openInSystem: db.prepare(`SELECT ${COLUMNS} FROM ${B} WHERE system_id = ?
        AND state IN (SELECT value FROM json_each(?)) ORDER BY created_at, battle_id LIMIT ?`),
      inSystemRecent: db.prepare(`SELECT battle_id, state, mode, hold_reason, created_at, settled_at,
        json_extract(result_json, '$.outcome') AS outcome
        FROM ${B} WHERE system_id = ? ORDER BY created_at DESC, battle_id DESC LIMIT ?`),
      virtualLossesSince: db.prepare(VIRTUAL_LOSSES_SQL),
      settledAfter: db.prepare(SETTLED_AFTER_SQL),
    };
    perDb.set(db, s);
    return s;
  }

  function readNow() {
    const now = clock.now();
    return Number.isSafeInteger(now) && now >= 0 ? now : undefined;
  }

  function validateSpec(spec, key) {
    if (!isText(key, MAX_CREATE_KEY_LENGTH)) return inputInvalid("idempotencyKey");
    if (!isPlainObject(spec)) return inputInvalid("spec");
    const extra = Object.keys(spec).filter((k) => !SPEC_KEYS.includes(k));
    if (extra.length > 0) return inputInvalid(`spec: field ${extra[0]}`);
    if (spec.battleId !== undefined && !isId(spec.battleId, "battle")) return inputInvalid("battleId");
    const withFixed = spec.fixedDefenses !== undefined && spec.fixedDefenses !== null;
    const sides = {};
    const all = [];
    for (const name of ["sideA", "sideB"]) {
      const side = spec[name];
      if (!isPlainObject(side) || Object.keys(side).some((k) => k !== "factionId" && k !== "fleets")) {
        return inputInvalid(name);
      }
      if (withFixed && name === "sideB") {
        if (side.factionId !== null || !Array.isArray(side.fleets) || side.fleets.length !== 0) {
          return inputInvalid("sideB: {factionId:null, fleets:[]} with fixedDefenses");
        }
        sides[name] = { factionId: null, fleets: [] };
        continue;
      }
      if (!Number.isSafeInteger(side.factionId) || side.factionId < 1) return inputInvalid(`${name}.factionId`);
      if (!Array.isArray(side.fleets) || side.fleets.length === 0) return inputInvalid(`${name}.fleets: empty`);
      if (side.fleets.length > L.maxFleetsPerSide) {
        return inputInvalid(`${name}.fleets: ${side.fleets.length} > maxFleetsPerSide ${L.maxFleetsPerSide}`);
      }
      const fleets = [];
      for (let i = 0; i < side.fleets.length; i += 1) {
        const f = side.fleets[i];
        if (!isPlainObject(f) || Object.keys(f).some((k) => k !== "fleetId" && k !== "expectedVersion")) {
          return inputInvalid(`${name}.fleets[${i}]`);
        }
        if (!isText(f.fleetId, MAX_ID_LENGTH)) return inputInvalid(`${name}.fleets[${i}].fleetId`);
        if (!isVersion(f.expectedVersion)) return inputInvalid(`${name}.fleets[${i}].expectedVersion`);
        fleets.push({ fleetId: f.fleetId, expectedVersion: f.expectedVersion });
        all.push(f.fleetId);
      }
      sides[name] = { factionId: side.factionId, fleets };
    }
    if (new Set(all).size !== all.length) return inputInvalid("fleets: duplicate fleetId");
    let grid = null;
    if (spec.grid !== undefined && spec.grid !== null) {
      const g = spec.grid;
      if (!isPlainObject(g) || Object.keys(g).some((k) => k !== "kind" && k !== "id")
        || !isText(g.kind, MAX_ENUM_LENGTH) || !Number.isSafeInteger(g.id) || g.id < 1) return inputInvalid("grid");
      grid = { kind: g.kind, id: g.id };
    }
    return { ok: true, sides, fleetIds: [...all].sort(), withFixed, grid };
  }

  function precheckFleets(sides, byId) {
    for (const name of ["sideA", "sideB"]) {
      for (const f of sides[name].fleets) {
        const rec = byId.get(f.fleetId);
        if (!rec) return { ok: false, reason: "ROW_NOT_FOUND", fleetId: f.fleetId };
        if (rec.state === ENGAGED) return { ok: false, reason: "FLEET_BUSY", fleetId: f.fleetId };
        if (UNAVAILABLE_FLEET_STATES.includes(rec.state)) {
          return { ok: false, reason: "FLEET_UNAVAILABLE", fleetId: f.fleetId, state: rec.state };
        }
        if (rec.version !== f.expectedVersion) {
          return { ok: false, reason: "VERSION_CONFLICT", fleetId: f.fleetId, expectedVersion: f.expectedVersion,
            actualVersion: rec.version };
        }
        if (rec.factionId !== sides[name].factionId) {
          return { ok: false, reason: "FLEET_FACTION_MISMATCH", fleetId: f.fleetId, factionId: rec.factionId,
            sideFactionId: sides[name].factionId };
        }
      }
    }
    return { ok: true };
  }

  function createBattle(tx, spec, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateSpec(spec, idempotencyKey);
    if (!valid.ok) return refused(valid);
    const now = readNow();
    if (now === undefined) return refused(inputInvalid("clock.now"));
    const found = journal.findByKey(tx, idempotencyKey);
    if (!found.ok) return refused(found);
    if (found.found) {
      const e = found.entry;
      const same = e.kind === KIND_APPLY && e.aggregateType === BATTLE_AGGREGATE && e.eventType === CREATED_EVENT
        && (spec.battleId === undefined || spec.battleId === e.aggregateId);
      if (!same) return refused({ ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: e.journalId });
      let sameFleets = false;
      try {
        sameFleets = Boolean(e.payload) && stableJson(e.payload.fleetIds) === stableJson(valid.fleetIds);
      } catch (_err) {
        sameFleets = false;
      }
      if (!sameFleets) return refused({ ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: e.journalId });
      return { ok: true, duplicate: true, battleId: e.aggregateId, journalId: e.journalId };
    }
    const battleId = spec.battleId !== undefined ? spec.battleId : ids.next("battle");
    const seed = settlementSeed(worldSeed, BATTLE_AGGREGATE, battleId);

    const read = fleetRepository.getFleets(tx, valid.fleetIds);
    if (!read.ok) return refused(read);
    const byId = new Map(read.fleets.map((f) => [f.fleetId, f]));
    const pre = precheckFleets(valid.sides, byId);
    if (!pre.ok) return refused(pre);
    const recordsOf = (name) => valid.sides[name].fleets.map((f) => byId.get(f.fleetId));
    const rawBase = { v: 1, battleId, seed, systemId: spec.systemId, environment: spec.environment,
      objective: spec.objective, garrison: spec.garrison === undefined ? null : spec.garrison,
      resolverVersion: spec.resolverVersion, maxResolutionMs: spec.maxResolutionMs,
      sideA: buildFleetSnapshot(valid.sides.sideA.factionId, recordsOf("sideA")),
      sideB: buildFleetSnapshot(valid.sides.sideB.factionId, recordsOf("sideB")) };
    const raw = { ...rawBase };
    for (const key of SPEC_STRUCTURE_KEYS) if (spec[key] !== undefined) raw[key] = spec[key];
    if (valid.withFixed) raw.fixedDefenses = spec.fixedDefenses;
    const checked = validateInput(raw, L);
    if (!checked.ok) return refused(checked);
    const input = checked.input;
    const settleRows = settlementRowBound(input);
    if (settleRows > L.maxSettlementRows) {
      return refused({ ok: false, reason: "BATTLE_TOO_LARGE_TO_SETTLE", rows: settleRows, limit: L.maxSettlementRows });
    }
    let inputHash;
    let inputJson;
    try {
      inputHash = hashInput(input);
      inputJson = stableJson(input);
    } catch (err) {
      return refused(inputInvalid(String((err && err.message) || err)));
    }
    const bytes = Buffer.byteLength(inputJson, "utf8");
    if (bytes > L.maxInputBytes) {
      return refused({ ok: false, reason: "BATTLE_INPUT_TOO_LARGE", bytes, limit: L.maxInputBytes });
    }
    const participants = [];
    for (const [name, side] of [["sideA", "A"], ["sideB", "B"]]) {
      for (const f of valid.sides[name].fleets) {
        participants.push({ ...f, side, factionId: valid.sides[name].factionId, from: byId.get(f.fleetId).state });
      }
    }

    const result = journal.applyOnce(tx, { key: idempotencyKey, aggregate: { type: BATTLE_AGGREGATE, id: battleId },
      eventType: CREATED_EVENT, payload: { inputHash, systemId: input.systemId, fleetIds: valid.fleetIds } }, (db) => {
      const s = stmts(db);
      if (s.byId.get(battleId)) return { ok: false, reason: "BATTLE_EXISTS", battleId };
      const open = JSON.stringify(OPEN_BATTLE_STATES);
      for (const p of participants) {
        const busy = s.openOfFleet.get(p.fleetId, open);
        if (busy) return { ok: false, reason: "FLEET_BUSY", fleetId: p.fleetId, battleId: busy.battle_id };
      }
      s.insert.run(battleId, idempotencyKey, toBind(input.systemId), input.environment, input.objective, null,
        INITIAL_BATTLE_STATE, input.resolverVersion, inputHash, toBind(seed), inputJson,
        JSON.stringify(valid.fleetIds), null, null, null, null, toBind(0), toBind(now), toBind(now), null,
        toBind(INITIAL_VERSION), valid.grid === null ? null : valid.grid.kind,
        valid.grid === null ? null : toBind(valid.grid.id));
      for (const p of participants) s.insertParticipant.run(battleId, p.fleetId, p.side, toBind(p.factionId));
      for (const p of participants) {
        const r = fleetRepository.transition(db, { fleetId: p.fleetId, expectedVersion: p.expectedVersion,
          from: p.from, to: ENGAGED, patch: { currentSystemId: input.systemId, route: null, routeGraphVersion: null,
            nextActionAt: null } }, `${idempotencyKey}:fleet:${p.fleetId}`);
        if (!r.ok) {
          if (r.reason === "ILLEGAL_TRANSITION") {
            return r.from === ENGAGED ? { ok: false, reason: "FLEET_BUSY", fleetId: p.fleetId }
              : { ok: false, reason: "FLEET_UNAVAILABLE", fleetId: p.fleetId, state: r.from };
          }
          return { ...r, fleetId: p.fleetId };
        }
        if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", fleetId: p.fleetId };
      }
      return { ok: true };
    });
    if (!result.ok) return refused(unwrap(result));
    if (result.duplicate) return { ok: true, duplicate: true, battleId, journalId: result.journalId };
    count("battle.created");
    return { ok: true, duplicate: false, battleId, seed, inputHash, version: INITIAL_VERSION,
      journalId: result.journalId };
  }

  function loadRow(s, battleId, expectedVersion) {
    const row = s.byId.get(battleId);
    if (!row) return { ok: false, reason: "ROW_NOT_FOUND", battleId };
    if (row.version !== expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion, actualVersion: row.version };
    }
    return { ok: true, row };
  }

  function write(db, draft, expectedVersion, now) {
    return updateWithVersion(db, BATTLE_TABLE, draft.battleId, expectedVersion, {
      mode: draft.mode,
      state: draft.state,
      claim_seq: draft.claimSeq,
      result_json: draft.result === null ? null : stableJson(draft.result),
      hold_reason: draft.holdReason,
      error_json: draft.error === null ? null : stableJson(draft.error),
      settlement_key: draft.settlementKey,
      updated_at: now,
      settled_at: draft.settledAt,
    });
  }

  function claim(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(change)) return refused(invalid("change"));
    const extra = Object.keys(change).filter((k) => !["battleId", "expectedVersion", "mode"].includes(k));
    if (extra.length > 0) return refused(invalid(`change: field ${extra[0]}`));
    if (!isText(change.battleId, MAX_ID_LENGTH)) return refused(invalid("battleId"));
    if (!isVersion(change.expectedVersion)) return refused(invalid("expectedVersion"));
    if (!BATTLE_MODES.includes(change.mode)) return refused({ ok: false, reason: "UNKNOWN_MODE", mode: change.mode });
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: BATTLE_AGGREGATE, id: change.battleId }, eventType: "BATTLE_CLAIMED",
      payload: { battleId: change.battleId, mode: change.mode } }, (db) => {
      const loaded = loadRow(stmts(db), change.battleId, change.expectedVersion);
      if (!loaded.ok) return loaded;
      const draft = toDraft(loaded.row);
      if (!CLAIMABLE_STATES.includes(draft.state)) {
        return { ok: false, reason: "ILLEGAL_TRANSITION", from: draft.state, to: "CLAIMED" };
      }
      if (draft.state === "CLAIMED" && draft.mode === change.mode) {
        return { ok: false, reason: "MODE_UNCHANGED", mode: change.mode };
      }
      draft.state = "CLAIMED";
      draft.mode = change.mode;
      draft.claimSeq += 1;
      draft.holdReason = null;
      const inv = checkBattleInvariants(draft);
      if (!inv.ok) return inv;
      const written = write(db, draft, change.expectedVersion, now);
      if (!written.ok) return written;
      return { ok: true, version: written.version, claimSeq: draft.claimSeq };
    });
    if (!result.ok) return refused(unwrap(result));
    if (result.duplicate) return { ok: true, duplicate: true, battleId: change.battleId, journalId: result.journalId };
    count("battle.claimed");
    return { ok: true, duplicate: false, battleId: change.battleId, version: result.value.version, state: "CLAIMED",
      mode: change.mode, claimSeq: result.value.claimSeq, journalId: result.journalId };
  }

  function validateTransition(change) {
    if (!isPlainObject(change)) return invalid("change");
    const extra = Object.keys(change).filter((k) => !["battleId", "expectedVersion", "from", "to", "patch"].includes(k));
    if (extra.length > 0) return invalid(`change: field ${extra[0]}`);
    if (!isText(change.battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isVersion(change.expectedVersion)) return invalid("expectedVersion");
    if (change.to === "CLAIMED") {
      return { ok: false, reason: "ILLEGAL_TRANSITION", from: change.from, to: change.to, detail: "use claim" };
    }
    const edge = canTransitionBattle(change.from, change.to);
    if (!edge.ok) return edge;
    const patch = change.patch === undefined ? {} : change.patch;
    if (!isPlainObject(patch)) return invalid("patch");
    const extraPatch = Object.keys(patch).filter((k) => !PATCH_KEYS.includes(k));
    if (extraPatch.length > 0) return invalid(`patch: field ${extraPatch[0]}`);
    const to = change.to;
    const out = {};
    const payload = { battleId: change.battleId, from: change.from, to };
    if (has(patch, "holdReason")) {
      if (to !== "PENDING") return invalid("patch.holdReason: only on PENDING");
      if (patch.holdReason !== null && !isText(patch.holdReason, MAX_HOLD_REASON_LENGTH)) {
        return invalid("patch.holdReason");
      }
      out.holdReason = patch.holdReason;
      payload.holdReason = patch.holdReason;
    } else if (to === "PENDING") return invalid("patch.holdReason: required on PENDING -> PENDING");
    if (has(patch, "result")) {
      if (to !== "SETTLING") return invalid("patch.result: only on entry into SETTLING");
      let text;
      try {
        text = stableJson(patch.result);
        payload.resultHash = fingerprint(patch.result);
      } catch (err) {
        return invalid(`patch.result: ${(err && err.message) || err}`);
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > L.maxResultBytes) {
        return { ok: false, reason: "BATTLE_RESULT_TOO_LARGE", bytes, limit: L.maxResultBytes };
      }
      out.result = patch.result;
    } else if (to === "SETTLING") return invalid("patch.result: required on entry into SETTLING");
    if (has(patch, "settlementKey")) {
      if (to !== "COMPLETED") return invalid("patch.settlementKey: only on entry into COMPLETED");
      if (!isText(patch.settlementKey, MAX_KEY_LENGTH)) return invalid("patch.settlementKey");
      out.settlementKey = patch.settlementKey;
      payload.settlementKey = patch.settlementKey;
    } else if (to === "COMPLETED") return invalid("patch.settlementKey: required on entry into COMPLETED");
    if (has(patch, "error")) {
      if (!STATES_WITH_ERROR.includes(to)) return invalid("patch.error: only on FAILED / QUARANTINED");
      const e = patch.error;
      if (!isPlainObject(e) || Object.keys(e).some((k) => k !== "reason" && k !== "detail")
        || !isText(e.reason, MAX_ERROR_REASON_LENGTH)
        || (e.detail !== undefined && !isText(e.detail, MAX_ERROR_DETAIL_LENGTH))) {
        return invalid("patch.error");
      }
      out.error = e.detail === undefined ? { reason: e.reason } : { reason: e.reason, detail: e.detail };
      payload.error = out.error;
    } else if (STATES_WITH_ERROR.includes(to)) return invalid("patch.error: required on FAILED / QUARANTINED");
    return { ok: true, patch: out, payload };
  }

  function transition(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateTransition(change);
    if (!valid.ok) return refused(valid);
    const now = readNow();
    if (now === undefined) return refused(invalid("clock.now"));
    const patch = valid.patch;
    const result = journal.applyOnce(tx, { key: idempotencyKey,
      aggregate: { type: BATTLE_AGGREGATE, id: change.battleId }, eventType: "BATTLE_TRANSITION",
      payload: valid.payload }, (db) => {
      const loaded = loadRow(stmts(db), change.battleId, change.expectedVersion);
      if (!loaded.ok) return loaded;
      const draft = toDraft(loaded.row);
      if (draft.state !== change.from) {
        return { ok: false, reason: "STATE_MISMATCH", expected: change.from, actual: draft.state };
      }
      const mode = checkMode(change.to, draft.mode);
      if (!mode.ok) return mode;
      if (has(patch, "result")) {
        const r = validateResult(draft.input, patch.result, L);
        if (!r.ok) return r;
        draft.result = r.result;
      }
      if (has(patch, "holdReason")) draft.holdReason = patch.holdReason;
      if (has(patch, "settlementKey")) draft.settlementKey = patch.settlementKey;
      if (has(patch, "error")) draft.error = patch.error;
      if (change.to !== "PENDING") draft.holdReason = null;
      if (change.to === "COMPLETED") draft.settledAt = now;
      draft.state = change.to;
      const inv = checkBattleInvariants(draft);
      if (!inv.ok) return inv;
      const written = write(db, draft, change.expectedVersion, now);
      if (!written.ok) return written;
      return { ok: true, version: written.version };
    });
    if (!result.ok) return refused(unwrap(result));
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("battle.transition");
    return { ok: true, duplicate: false, battleId: change.battleId, version: result.value.version, state: change.to,
      journalId: result.journalId };
  }

  function readLimit(opts) {
    if (opts.limit === undefined) return { ok: true, limit: L.maxListLimit };
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts.limit");
    return { ok: true, limit: Math.min(opts.limit, L.maxListLimit) };
  }

  function checkStates(states) {
    if (!Array.isArray(states) || states.length === 0) return invalid("opts.states");
    const unknown = states.find((st) => !BATTLE_STATES.includes(st));
    return unknown === undefined ? { ok: true } : { ok: false, reason: "UNKNOWN_STATE", state: unknown };
  }

  function getBattle(tx, battleId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    const row = stmts(tx).byId.get(battleId);
    return { ok: true, battle: row ? toBattle(row) : null };
  }

  function getByFleet(tx, fleetId, opts = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
    if (!isPlainObject(opts)) return invalid("opts");
    const page = readLimit(opts);
    if (!page.ok) return page;
    const s = stmts(tx);
    if (opts.states === undefined) return { ok: true, battles: s.byFleet.all(fleetId, toBind(page.limit)).map(toBattle) };
    const st = checkStates(opts.states);
    if (!st.ok) return st;
    return { ok: true,
      battles: s.byFleetStates.all(fleetId, JSON.stringify(opts.states), toBind(page.limit)).map(toBattle) };
  }

  function listByState(tx, state, opts = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!BATTLE_STATES.includes(state)) return { ok: false, reason: "UNKNOWN_STATE", state };
    if (!isPlainObject(opts)) return invalid("opts");
    const page = readLimit(opts);
    if (!page.ok) return page;
    const after = opts.afterId === undefined ? "" : opts.afterId;
    if (typeof after !== "string" || after.length > MAX_ID_LENGTH) return invalid("opts.afterId");
    const rows = stmts(tx).byState.all(state, after, toBind(page.limit));
    return { ok: true, battles: rows.map(toBattle),
      nextAfterId: rows.length === page.limit ? rows[rows.length - 1].battle_id : null };
  }

  function listOpenInSystem(tx, systemId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Number.isSafeInteger(systemId) || systemId < 1) return invalid("systemId");
    if (!isPlainObject(opts)) return invalid("opts");
    const page = readLimit(opts);
    if (!page.ok) return page;
    const st = checkStates(opts.states);
    if (!st.ok) return st;
    const rows = stmts(tx).openInSystem.all(toBind(systemId), JSON.stringify(opts.states), toBind(page.limit));
    return { ok: true, battles: rows.map(toBattle) };
  }

  function countByState(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const counts = {};
    for (const row of stmts(tx).countByState.all()) counts[row.state] = row.n;
    return { ok: true, counts };
  }

  function summarizeOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(opts)) return invalid("opts");
    const limit = opts.limit;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > OPEN_SUMMARY_MAX_LIMIT) return invalid("opts.limit");
    if (limit === 0) return { ok: true, battles: [], truncated: false };
    const s = stmts(tx);
    const rows = s.openBattles.all(JSON.stringify(OPEN_BATTLE_STATES), toBind(limit + 1));
    const truncated = rows.length > limit;
    const battles = rows.slice(0, limit).map((r) => ({ battleId: r.battle_id, systemId: Number(r.system_id),
      state: r.state, holdReason: r.hold_reason === null ? null : r.hold_reason, createdAt: Number(r.created_at),
      sides: { A: null, B: null } }));
    sidesInto(s, battles);
    return { ok: true, battles, truncated };
  }

  function sidesInto(s, battles) {
    if (battles.length === 0) return;
    const byId = new Map(battles.map((b) => [b.battleId, b]));
    for (const r of s.openSides.all(JSON.stringify(battles.map((b) => b.battleId)))) {
      const battle = byId.get(r.battle_id);
      if (!battle || (r.side !== "A" && r.side !== "B")) continue;
      const cand = { factionId: Number(r.faction_id), fleets: Number(r.n), ships: Number(r.ships) || 0 };
      const cur = battle.sides[r.side];
      if (!cur || cand.fleets > cur.fleets || (cand.fleets === cur.fleets && cand.factionId < cur.factionId)) {
        battle.sides[r.side] = cand;
      }
    }
  }

  function summarizeInSystem(tx, systemId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Number.isSafeInteger(systemId) || systemId < 1) return invalid("systemId");
    if (!isPlainObject(opts)) return invalid("opts");
    const limit = opts.limit;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > OPEN_SUMMARY_MAX_LIMIT) return invalid("opts.limit");
    if (limit === 0) return { ok: true, battles: [] };
    const s = stmts(tx);
    const battles = s.inSystemRecent.all(toBind(systemId), toBind(limit)).map((r) => ({ battleId: r.battle_id,
      state: r.state, mode: r.mode === null ? null : r.mode, holdReason: r.hold_reason === null ? null : r.hold_reason,
      createdAt: Number(r.created_at), settledAt: r.settled_at === null ? null : Number(r.settled_at),
      outcome: r.outcome === null ? null : r.outcome, sides: { A: null, B: null } }));
    sidesInto(s, battles);
    return { ok: true, battles };
  }

  function validateLossRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return invalid("rows: empty or not an array");
    if (rows.length > L.maxSettlementRows) {
      return { ok: false, reason: "SETTLEMENT_TOO_LARGE", rows: rows.length, limit: L.maxSettlementRows };
    }
    const seen = new Set();
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (!isPlainObject(r) || Object.keys(r).some((k) => !LOSS_ROW_KEYS.includes(k))) return invalid(`rows[${i}]`);
      if (!isText(r.fleetId, MAX_ID_LENGTH)) return invalid(`rows[${i}].fleetId`);
      if (!Number.isSafeInteger(r.factionId) || r.factionId < 1) return invalid(`rows[${i}].factionId`);
      if (!isText(r.hullGroup, MAX_HULL_GROUP_LENGTH)) return invalid(`rows[${i}].hullGroup`);
      if (!Number.isSafeInteger(r.typeId) || r.typeId < 0) return invalid(`rows[${i}].typeId`);
      if (!Number.isSafeInteger(r.count) || r.count < 1) return invalid(`rows[${i}].count`);
      const pk = `${r.fleetId}|${r.hullGroup}|${r.typeId}`;
      if (seen.has(pk)) return invalid(`rows[${i}]: duplicate ${pk}`);
      seen.add(pk);
      out.push({ fleetId: r.fleetId, factionId: r.factionId, hullGroup: r.hullGroup, typeId: r.typeId, count: r.count });
    }
    out.sort((a, b) => (a.fleetId !== b.fleetId ? (a.fleetId < b.fleetId ? -1 : 1)
      : a.hullGroup !== b.hullGroup ? (a.hullGroup < b.hullGroup ? -1 : 1) : a.typeId - b.typeId));
    return { ok: true, rows: out };
  }

  function recordLosses(tx, battleId, rows, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return refused(invalid("battleId"));
    const valid = validateLossRows(rows);
    if (!valid.ok) return refused(valid);
    let lossesHash;
    try {
      lossesHash = fingerprint(valid.rows);
    } catch (err) {
      return refused(invalid(String((err && err.message) || err)));
    }
    const result = journal.applyOnce(tx, { key: idempotencyKey, aggregate: { type: BATTLE_AGGREGATE, id: battleId },
      eventType: "BATTLE_LOSSES", payload: { battleId, rows: valid.rows.length, lossesHash } }, (db) => {
      const s = stmts(db);
      if (!s.byId.get(battleId)) return { ok: false, reason: "ROW_NOT_FOUND", battleId };
      const members = new Map(s.participantsOf.all(battleId).map((p) => [p.fleet_id, p.faction_id]));
      for (const r of valid.rows) {
        if (!members.has(r.fleetId)) return { ok: false, reason: "NOT_A_PARTICIPANT", fleetId: r.fleetId };
        if (members.get(r.fleetId) !== r.factionId) {
          return { ok: false, reason: "FLEET_FACTION_MISMATCH", fleetId: r.fleetId, factionId: r.factionId };
        }
      }
      for (const r of valid.rows) {
        s.insertLoss.run(battleId, r.fleetId, toBind(r.factionId), r.hullGroup, toBind(r.typeId), toBind(r.count));
      }
      return { ok: true };
    });
    if (!result.ok) return refused(unwrap(result));
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("battle.losses");
    return { ok: true, duplicate: false, rows: valid.rows.length, journalId: result.journalId };
  }

  function getLosses(tx, battleId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    const losses = stmts(tx).lossesOf.all(battleId).map((r) => Object.freeze({ fleetId: r.fleet_id,
      factionId: r.faction_id, hullGroup: r.hull_group, typeId: r.type_id === 0 ? null : r.type_id, count: r.count }));
    return { ok: true, losses: Object.freeze(losses) };
  }

  function listVirtualLossesSince(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(opts)) return { ok: false, reason: "INVALID_ARGUMENT", detail: "opts" };
    if (!Number.isSafeInteger(opts.sinceMs) || opts.sinceMs < 0) {
      return { ok: false, reason: "INVALID_ARGUMENT", detail: "opts.sinceMs" };
    }
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > VIRTUAL_LOSSES_MAX_LIMIT) {
      return { ok: false, reason: "INVALID_ARGUMENT", detail: "opts.limit" };
    }
    const rows = stmts(tx).virtualLossesSince.all(toBind(opts.sinceMs), toBind(opts.limit + 1));
    const truncated = rows.length > opts.limit;
    const losses = rows.slice(0, opts.limit).map((r) => ({ systemId: Number(r.system_id),
      settledAt: Number(r.settled_at), factionId: Number(r.faction_id), typeId: Number(r.type_id),
      count: Number(r.count), hullGroup: String(r.hull_group) }));
    return { ok: true, losses, truncated };
  }

  function listSettledAfter(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(opts)) return { ok: false, reason: "INVALID_ARGUMENT", detail: "opts" };
    if (!Number.isSafeInteger(opts.afterMs) || opts.afterMs < 0) {
      return { ok: false, reason: "INVALID_ARGUMENT", detail: "opts.afterMs" };
    }
    if (typeof opts.afterBattleId !== "string" || opts.afterBattleId.length > MAX_ID_LENGTH) {
      return { ok: false, reason: "INVALID_ARGUMENT", detail: "opts.afterBattleId" };
    }
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > SETTLED_AFTER_MAX_LIMIT) {
      return { ok: false, reason: "INVALID_ARGUMENT", detail: "opts.limit" };
    }
    const rows = stmts(tx).settledAfter.all(toBind(opts.afterMs), toBind(opts.afterMs), opts.afterBattleId,
      toBind(opts.limit)).map((r) => ({ battleId: r.battle_id, settledAt: Number(r.settled_at) }));
    return { ok: true, rows };
  }

  function isApplied(tx, idempotencyKey) {
    const found = journal.findByKey(tx, idempotencyKey);
    if (!found.ok) return found;
    return { ok: true, applied: found.found && found.entry.kind === KIND_APPLY };
  }

  return Object.freeze({
    createBattle,
    claim,
    transition,
    getBattle,
    getByFleet,
    listByState,
    listOpenInSystem,
    countByState,
    summarizeOpen,
    summarizeInSystem,
    recordLosses,
    getLosses,
    listVirtualLossesSince,
    listSettledAfter,
    isApplied,
    limits: L,
  });
}

module.exports = { createBattleRepository, BATTLE_AGGREGATE, BATTLE_TABLE, VIRTUAL_LOSSES_SQL, VIRTUAL_LOSSES_MAX_LIMIT,
  SETTLED_AFTER_SQL, SETTLED_AFTER_MAX_LIMIT };
