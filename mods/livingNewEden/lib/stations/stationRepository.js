"use strict";

const { defineTable, updateWithVersion, toBind } = require("../persistence/repository");
const {
  STATIONS_TABLE_NAME, STOCK_TABLE_NAME, STATION_AGGREGATE, EVENT_STATION_CREATED, EVENT_STATION_TRANSITION,
  EVENT_STATION_STOCK_CHANGED, EVENT_STATION_CAPTURED, EVENT_STATION_PROJECTED, EVENT_STATION_REASSIGNED, STATION_STATES, INITIAL_STATION_STATE, ANCHORING_STATE,
  CREATE_STATES, DESTROYED_STATION_STATE, REINFORCE_STATES, STATION_KINDS, STATION_ORIGINS, ITEM_KINDS, MAX_STATION_ID_LENGTH, MAX_FAMILY_LENGTH,
  MAX_NAME_LENGTH, MAX_QUANTITY_DDL,
  MAX_KEY_LENGTH, MAX_REASON_LENGTH,
} = require("./schema");
const { canTransitionStation } = require("./stateMachine");

const INITIAL_VERSION = 1;
const COLUMNS = "station_id, kind, npc_station_id, type_id, structure_family, system_id, owner_faction_id, "
  + "owner_corporation_id, state, state_until_at, name, position_json, origin, evejs_item_id, destroyed_at, "
  + "created_at, updated_at, version";
const STATIONS_TABLE = defineTable({ name: STATIONS_TABLE_NAME, idColumn: "station_id",
  columns: ["state", "state_until_at", "destroyed_at", "updated_at", "owner_faction_id", "owner_corporation_id",
    "evejs_item_id", "position_json"] });
const LIMIT_NAMES = Object.freeze(["maxPerSystem", "maxPerSystemPerFaction", "maxPerFaction", "maxStations",
  "maxStockItemsPerStation", "maxStockQuantity", "maxDeltasPerChange"]);
const CREATE_FIELDS = Object.freeze(["stationId", "kind", "npcStationId", "typeId", "structureFamily", "systemId",
  "ownerFactionId", "ownerCorporationId", "name", "position", "origin", "at", "initialState", "stateUntilAt"]);
const ORIGIN_BUILT = "built";
const STOCK_FIELDS = Object.freeze(["stationId", "expectedVersion", "key", "reason", "at", "deltas"]);
const DELTA_FIELDS = Object.freeze(["itemKind", "itemKey", "delta"]);
const TRANSITION_FIELDS = Object.freeze(["stationId", "expectedVersion", "from", "to", "key", "reason", "at",
  "patch", "wipeStock"]);
const CAPTURE_FIELDS = Object.freeze(["stationId", "expectedVersion", "from", "ownerFactionId", "ownerCorporationId",
  "key", "reason", "at"]);
const PROJECTION_FIELDS = Object.freeze(["stationId", "evejsItemId", "position", "key", "at"]);
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const TYPE_KEY_RE = /^type:[1-9][0-9]{0,15}$/;
const GROUP_KEY_RE = /^group:([a-z_]{1,32})$/;
const UNIT_KEY_RE = /^unit:[a-z_]{1,32}$/;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

function unknownField(obj, allowed) {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

function isPosition(v) {
  return isPlainObject(v) && Object.keys(v).length === 3
    && ["x", "y", "z"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k]));
}

function toRecord(row) {
  return Object.freeze({
    stationId: row.station_id,
    kind: row.kind,
    npcStationId: row.npc_station_id,
    typeId: row.type_id,
    structureFamily: row.structure_family,
    systemId: row.system_id,
    ownerFactionId: row.owner_faction_id,
    ownerCorporationId: row.owner_corporation_id,
    state: row.state,
    stateUntilAt: row.state_until_at,
    name: row.name,
    position: row.position_json === null ? null : Object.freeze(JSON.parse(row.position_json)),
    origin: row.origin,
    evejsItemId: row.evejs_item_id,
    destroyedAt: row.destroyed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

const toItem = (row) => Object.freeze({ itemKind: row.item_kind, itemKey: row.item_key, quantity: row.quantity,
  updatedAt: row.updated_at });

function createStationRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createStationRepository: deps missing");
  const { journal, limits, isKnownFaction, hullGroups, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("createStationRepository: journal with applyOnce/findByKey required");
  }
  if (!limits || typeof limits !== "object") throw new TypeError("createStationRepository: limits missing");
  for (const name of LIMIT_NAMES) {
    if (!isId(limits[name])) throw new TypeError(`createStationRepository: limits.${name} must be a positive integer`);
  }
  if (limits.maxStockQuantity > MAX_QUANTITY_DDL) {
    throw new TypeError("createStationRepository: limits.maxStockQuantity above the DDL bound");
  }
  if (typeof isKnownFaction !== "function") throw new TypeError("createStationRepository: isKnownFaction required");
  if (!Array.isArray(hullGroups) || hullGroups.length === 0) {
    throw new TypeError("createStationRepository: hullGroups required");
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createStationRepository: onCount must be a function");
  }
  const L = Object.freeze({ ...Object.fromEntries(LIMIT_NAMES.map((n) => [n, limits[n]])),
    maxPerSystemPerFaction: Math.min(limits.maxPerSystemPerFaction, limits.maxPerSystem) });
  let changeCount = 0;

  const count = (name) => {
    if (!onCount) return;
    try {
      onCount(name, 1);
    } catch (_err) {
    }
  };

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const T = STATIONS_TABLE_NAME;
    const K = STOCK_TABLE_NAME;
    s = {
      byId: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE station_id = ?`),
      byNpc: db.prepare(`SELECT station_id FROM ${T} WHERE npc_station_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      liveInSystem: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE system_id = ? AND state <> ?`),
      liveInSystemOfFaction: db.prepare(`SELECT count(*) AS n FROM ${T}
        WHERE system_id = ? AND owner_faction_id = ? AND state <> ?`),
      liveOfFaction: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE owner_faction_id = ? AND state <> ?`),
      liveAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state <> ?`),
      inSystem: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE system_id = ? ORDER BY station_id LIMIT ?`),
      ofFaction: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE owner_faction_id = ? ORDER BY station_id LIMIT ?`),
      ofFactionStates: db.prepare(`SELECT ${COLUMNS} FROM ${T}
        WHERE owner_faction_id = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY system_id, station_id
        LIMIT ?`),
      live: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state <> ? ORDER BY system_id, station_id LIMIT ?`),
      countBySystem: db.prepare(`SELECT system_id AS s, owner_faction_id AS f, count(*) AS n FROM ${T}
        WHERE state <> ? AND system_id IN (SELECT value FROM json_each(?))
        GROUP BY system_id, owner_faction_id ORDER BY system_id, owner_faction_id`),
      stockItem: db.prepare(`SELECT quantity FROM ${K} WHERE station_id = ? AND item_kind = ? AND item_key = ?`),
      stockCount: db.prepare(`SELECT count(*) AS n FROM ${K} WHERE station_id = ?`),
      stockInsert: db.prepare(`INSERT INTO ${K} (station_id, item_kind, item_key, quantity, updated_at)
        VALUES (?, ?, ?, ?, ?)`),
      stockUpdate: db.prepare(`UPDATE ${K} SET quantity = ?, updated_at = ?
        WHERE station_id = ? AND item_kind = ? AND item_key = ?`),
      stockDelete: db.prepare(`DELETE FROM ${K} WHERE station_id = ? AND item_kind = ? AND item_key = ?`),
      stockOf: db.prepare(`SELECT item_kind, item_key, quantity, updated_at FROM ${K} WHERE station_id = ?
        ORDER BY item_kind, item_key LIMIT ?`),
      stocksOf: db.prepare(`SELECT station_id, item_kind, item_key, quantity, updated_at FROM (SELECT station_id,
        item_kind, item_key, quantity, updated_at,
        row_number() OVER (PARTITION BY station_id ORDER BY item_kind, item_key) AS rn
        FROM ${K} WHERE station_id IN (SELECT value FROM json_each(?)))
        WHERE rn <= ? ORDER BY station_id, item_kind, item_key`),
      stockAll: db.prepare(`SELECT item_kind, item_key, quantity, updated_at FROM ${K} WHERE station_id = ?
        ORDER BY item_kind, item_key`),
      stockWipe: db.prepare(`DELETE FROM ${K} WHERE station_id = ?`),
      stockTotals: db.prepare(`SELECT k.station_id AS id, count(*) AS n, sum(k.quantity) AS total FROM ${K} k
        GROUP BY k.station_id`),
      stockTop: db.prepare(`SELECT station_id, item_kind, item_key, quantity FROM (SELECT station_id, item_kind,
        item_key, quantity, row_number() OVER (PARTITION BY station_id ORDER BY quantity DESC, item_kind, item_key)
        AS rn FROM ${K}) WHERE rn <= ? ORDER BY station_id, rn`),
    };
    perDb.set(db, s);
    return s;
  }

  function readRow(db, stationId) {
    const row = stmts(db).byId.get(stationId);
    return row ? toRecord(row) : null;
  }

  function unwrapApply(result) {
    return result.reason === "APPLY_REFUSED" ? result.refusal : result;
  }

  function validateCreate(spec) {
    if (!isPlainObject(spec)) return "spec";
    const extra = unknownField(spec, CREATE_FIELDS);
    if (extra !== undefined) return `spec.${extra}`;
    if (!isText(spec.stationId, MAX_STATION_ID_LENGTH)) return "spec.stationId";
    if (!STATION_KINDS.includes(spec.kind)) return "spec.kind";
    const opt = (v, check) => v === undefined || v === null || check(v);
    if (!opt(spec.npcStationId, isId)) return "spec.npcStationId";
    if (spec.kind === "npc" && !isId(spec.npcStationId)) return "spec.npcStationId";
    if (!opt(spec.typeId, isId)) return "spec.typeId";
    if (!opt(spec.structureFamily, (v) => isText(v, MAX_FAMILY_LENGTH))) return "spec.structureFamily";
    if (!isId(spec.systemId)) return "spec.systemId";
    if (!isId(spec.ownerFactionId)) return "spec.ownerFactionId";
    if (!isId(spec.ownerCorporationId)) return "spec.ownerCorporationId";
    if (!opt(spec.name, (v) => isText(v, MAX_NAME_LENGTH))) return "spec.name";
    if (!opt(spec.position, isPosition)) return "spec.position";
    if (!STATION_ORIGINS.includes(spec.origin)) return "spec.origin";
    if (!isTime(spec.at)) return "spec.at";
    const state = spec.initialState === undefined ? INITIAL_STATION_STATE : spec.initialState;
    if (!CREATE_STATES.includes(state)) return "spec.initialState";
    if (state === ANCHORING_STATE) {
      if (spec.origin !== ORIGIN_BUILT) return "spec.origin";
      if (!isTime(spec.stateUntilAt)) return "spec.stateUntilAt";
    } else if (spec.stateUntilAt !== undefined && spec.stateUntilAt !== null) return "spec.stateUntilAt";
    return null;
  }

  function createStation(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = validateCreate(spec);
    if (bad !== null) return invalid(bad);
    if (!isText(key, MAX_KEY_LENGTH)) return invalid("key");
    let known = false;
    try {
      known = isKnownFaction(spec.ownerFactionId) === true;
    } catch (_err) {
      known = false;
    }
    if (!known) return { ok: false, reason: "UNKNOWN_FACTION", detail: String(spec.ownerFactionId) };
    const n = (v) => (v === undefined ? null : v);
    const position = spec.position ? { x: spec.position.x, y: spec.position.y, z: spec.position.z } : null;
    const payload = { stationId: spec.stationId, kind: spec.kind, npcStationId: n(spec.npcStationId),
      typeId: n(spec.typeId), structureFamily: n(spec.structureFamily), systemId: spec.systemId,
      ownerFactionId: spec.ownerFactionId, ownerCorporationId: spec.ownerCorporationId, name: n(spec.name),
      position, origin: spec.origin };
    const anchoring = spec.initialState === ANCHORING_STATE;
    if (anchoring) Object.assign(payload, { initialState: ANCHORING_STATE, stateUntilAt: spec.stateUntilAt });
    const state = anchoring ? ANCHORING_STATE : INITIAL_STATION_STATE;
    const stateUntilAt = anchoring ? toBind(spec.stateUntilAt) : null;
    const result = journal.applyOnce(tx, { key, aggregate: { type: STATION_AGGREGATE, id: spec.stationId },
      eventType: EVENT_STATION_CREATED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(spec.stationId)) return { ok: false, reason: "STATION_EXISTS" };
      if (payload.npcStationId !== null && s.byNpc.get(toBind(payload.npcStationId))) {
        return { ok: false, reason: "NPC_STATION_TAKEN", detail: String(payload.npcStationId) };
      }
      const sys = toBind(spec.systemId);
      const fac = toBind(spec.ownerFactionId);
      const D = DESTROYED_STATION_STATE;
      if (s.liveInSystem.get(sys, D).n >= L.maxPerSystem) return { ok: false, reason: "SYSTEM_STATION_LIMIT" };
      if (s.liveInSystemOfFaction.get(sys, fac, D).n >= L.maxPerSystemPerFaction) {
        return { ok: false, reason: "SYSTEM_FACTION_STATION_LIMIT" };
      }
      if (s.liveOfFaction.get(fac, D).n >= L.maxPerFaction) return { ok: false, reason: "FACTION_STATION_LIMIT" };
      if (s.liveAll.get(D).n >= L.maxStations) return { ok: false, reason: "STATION_LIMIT" };
      s.insert.run(spec.stationId, spec.kind, toBind(payload.npcStationId), toBind(payload.typeId),
        payload.structureFamily, sys, fac, toBind(spec.ownerCorporationId), state, stateUntilAt,
        payload.name, position === null ? null : JSON.stringify(position), spec.origin, null, null, toBind(spec.at),
        toBind(spec.at), toBind(INITIAL_VERSION));
      return { ok: true };
    });
    if (!result.ok) return unwrapApply(result);
    if (result.duplicate) return { ok: true, duplicate: true, record: readRow(tx, spec.stationId) };
    changeCount += 1;
    return { ok: true, record: readRow(tx, spec.stationId) };
  }

  function getStation(tx, stationId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(stationId, MAX_STATION_ID_LENGTH)) return invalid("stationId");
    return { ok: true, record: readRow(tx, stationId) };
  }

  function listStationsInSystem(tx, systemId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    const all = Boolean(opts && opts.includeDestroyed === true);
    const rows = stmts(tx).inSystem.all(toBind(systemId), toBind(L.maxStations)).map(toRecord);
    return { ok: true, records: all ? rows : rows.filter((r) => r.state !== DESTROYED_STATION_STATE) };
  }

  function listStationsOfFaction(tx, factionId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    const states = opts && opts.states !== undefined ? opts.states : null;
    if (states !== null && (!Array.isArray(states) || !states.every((st) => STATION_STATES.includes(st)))) {
      return invalid("opts.states");
    }
    const s = stmts(tx);
    const rows = states === null ? s.ofFaction.all(toBind(factionId), toBind(L.maxStations))
      : s.ofFactionStates.all(toBind(factionId), JSON.stringify(states), toBind(L.maxStations));
    return { ok: true, records: rows.map(toRecord) };
  }

  function listLiveStations(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const limit = opts && opts.limit !== undefined ? opts.limit : L.maxStations;
    if (!Number.isSafeInteger(limit) || limit < 0) return invalid("opts.limit");
    const rows = stmts(tx).live.all(DESTROYED_STATION_STATE, toBind(limit + 1));
    return { ok: true, records: rows.slice(0, limit).map(toRecord), truncated: rows.length > limit };
  }

  function countLiveBySystem(tx, systemIds) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(systemIds) || !systemIds.every(isId)) return invalid("systemIds");
    const rows = stmts(tx).countBySystem.all(DESTROYED_STATION_STATE, JSON.stringify(systemIds));
    return { ok: true, rows: rows.map((r) => Object.freeze({ systemId: r.s, factionId: r.f, count: r.n })) };
  }

  function liveCounts(tx, systemId, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    if (!isId(factionId)) return invalid("factionId");
    const s = stmts(tx);
    const sys = toBind(systemId);
    const fac = toBind(factionId);
    const D = DESTROYED_STATION_STATE;
    return { ok: true, inSystem: s.liveInSystem.get(sys, D).n,
      inSystemOfFaction: s.liveInSystemOfFaction.get(sys, fac, D).n, ofFaction: s.liveOfFaction.get(fac, D).n,
      all: s.liveAll.get(D).n };
  }

  function countLiveAll(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: stmts(tx).liveAll.get(DESTROYED_STATION_STATE).n };
  }

  function getStock(tx, stationId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(stationId, MAX_STATION_ID_LENGTH)) return invalid("stationId");
    const limit = opts && opts.limit !== undefined ? opts.limit : L.maxStockItemsPerStation;
    if (!Number.isSafeInteger(limit) || limit < 0) return invalid("opts.limit");
    const rows = stmts(tx).stockOf.all(stationId, toBind(limit + 1));
    return { ok: true, items: rows.slice(0, limit).map(toItem), truncated: rows.length > limit };
  }

  function getStocks(tx, stationIds, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(stationIds) || !stationIds.every((id) => isText(id, MAX_STATION_ID_LENGTH))) {
      return invalid("stationIds");
    }
    const limit = opts && opts.limit !== undefined ? opts.limit : L.maxStockItemsPerStation;
    if (!Number.isSafeInteger(limit) || limit < 0) return invalid("opts.limit");
    const list = [...new Set(stationIds)].sort();
    if (list.length > L.maxStations) {
      return { ok: false, reason: "BATCH_TOO_LARGE", count: list.length, limit: L.maxStations };
    }
    const rowsOf = new Map(list.map((id) => [id, []]));
    if (list.length > 0) {
      for (const row of stmts(tx).stocksOf.all(JSON.stringify(list), toBind(limit + 1))) {
        rowsOf.get(row.station_id).push(row);
      }
    }
    const byStation = new Map();
    for (const [id, rows] of rowsOf) {
      byStation.set(id, { items: rows.slice(0, limit).map(toItem), truncated: rows.length > limit });
    }
    return { ok: true, byStation };
  }

  function summarizeStock(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const top = opts && opts.topLines !== undefined ? opts.topLines : 0;
    if (!Number.isSafeInteger(top) || top < 0) return invalid("opts.topLines");
    const s = stmts(tx);
    const byStation = new Map();
    for (const r of s.stockTotals.all()) byStation.set(r.id, { items: r.n, total: r.total, top: [] });
    if (top > 0) {
      for (const r of s.stockTop.all(toBind(top))) {
        const entry = byStation.get(r.station_id);
        if (entry) entry.top.push(Object.freeze({ itemKind: r.item_kind, itemKey: r.item_key, quantity: r.quantity }));
      }
    }
    return { ok: true, byStation };
  }

  function validItemKey(kind, key) {
    if (typeof key !== "string") return false;
    if (kind === "mineral" || kind === "moon" || kind === "pi") return TYPE_KEY_RE.test(key);
    if (kind === "hull") {
      if (TYPE_KEY_RE.test(key)) return true;
      const m = GROUP_KEY_RE.exec(key);
      return Boolean(m && hullGroups.includes(m[1]));
    }
    return UNIT_KEY_RE.test(key);
  }

  function validateStock(change) {
    if (!isPlainObject(change)) return { detail: "change" };
    const extra = unknownField(change, STOCK_FIELDS);
    if (extra !== undefined) return { detail: `change.${extra}` };
    if (!isText(change.stationId, MAX_STATION_ID_LENGTH)) return { detail: "change.stationId" };
    if (change.expectedVersion !== undefined && !isId(change.expectedVersion)) {
      return { detail: "change.expectedVersion" };
    }
    if (!isText(change.key, MAX_KEY_LENGTH)) return { detail: "change.key" };
    if (!isText(change.reason, MAX_REASON_LENGTH)) return { detail: "change.reason" };
    if (!isTime(change.at)) return { detail: "change.at" };
    const d = change.deltas;
    if (!Array.isArray(d) || d.length === 0 || d.length > L.maxDeltasPerChange) return { detail: "change.deltas" };
    const out = [];
    for (let i = 0; i < d.length; i += 1) {
      const e = d[i];
      const at = `change.deltas[${i}]`;
      if (!isPlainObject(e) || unknownField(e, DELTA_FIELDS) !== undefined) return { detail: at };
      if (!ITEM_KINDS.includes(e.itemKind)) return { detail: `${at}.itemKind` };
      if (!validItemKey(e.itemKind, e.itemKey)) return { detail: `${at}.itemKey` };
      if (!Number.isSafeInteger(e.delta) || e.delta === 0 || Math.abs(e.delta) > L.maxStockQuantity) {
        return { detail: `${at}.delta` };
      }
      out.push({ itemKind: e.itemKind, itemKey: e.itemKey, delta: e.delta });
    }
    out.sort((a, b) => cmp(a.itemKind, b.itemKind) || cmp(a.itemKey, b.itemKey));
    for (let i = 1; i < out.length; i += 1) {
      if (out[i].itemKind === out[i - 1].itemKind && out[i].itemKey === out[i - 1].itemKey) {
        return { detail: "change.deltas: duplicate item" };
      }
    }
    return { deltas: out };
  }

  function applyStockChange(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateStock(change);
    if (valid.detail) return invalid(valid.detail);
    const { deltas } = valid;
    const result = journal.applyOnce(tx, { key: change.key,
      aggregate: { type: STATION_AGGREGATE, id: change.stationId }, eventType: EVENT_STATION_STOCK_CHANGED,
      payload: { stationId: change.stationId, reason: change.reason, deltas } }, (db) => {
      const s = stmts(db);
      const row = readRow(db, change.stationId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
      if (row.state === DESTROYED_STATION_STATE) return { ok: false, reason: "STATION_DESTROYED" };
      if (change.expectedVersion !== undefined && row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      let itemCount = s.stockCount.get(change.stationId).n;
      const plan = [];
      for (const d of deltas) {
        const cur = s.stockItem.get(change.stationId, d.itemKind, d.itemKey);
        const have = cur ? cur.quantity : 0;
        const next = have + d.delta;
        if (next < 0) {
          return { ok: false, reason: "INSUFFICIENT_STOCK", itemKind: d.itemKind, itemKey: d.itemKey, have,
            need: -d.delta };
        }
        if (next > L.maxStockQuantity) {
          return { ok: false, reason: "STOCK_CAP", itemKind: d.itemKind, itemKey: d.itemKey,
            limit: L.maxStockQuantity };
        }
        if (!cur && next > 0) itemCount += 1;
        if (cur && next === 0) itemCount -= 1;
        plan.push({ ...d, exists: Boolean(cur), next });
      }
      if (itemCount > L.maxStockItemsPerStation) {
        return { ok: false, reason: "STOCK_ITEMS_LIMIT", limit: L.maxStockItemsPerStation };
      }
      const at = toBind(change.at);
      for (const p of plan) {
        if (p.next === 0) s.stockDelete.run(change.stationId, p.itemKind, p.itemKey);
        else if (p.exists) s.stockUpdate.run(toBind(p.next), at, change.stationId, p.itemKind, p.itemKey);
        else s.stockInsert.run(change.stationId, p.itemKind, p.itemKey, toBind(p.next), at);
      }
      const updated = updateWithVersion(db, STATIONS_TABLE, change.stationId, row.version,
        { updated_at: change.at });
      if (!updated.ok) return updated;
      return { ok: true, record: readRow(db, change.stationId),
        items: plan.map((p) => Object.freeze({ itemKind: p.itemKind, itemKey: p.itemKey, quantity: p.next })) };
    });
    if (!result.ok) {
      count("stations.stock.refused");
      return unwrapApply(result);
    }
    if (result.duplicate) return { ok: true, duplicate: true };
    changeCount += 1;
    count("stations.stock.changed");
    return { ok: true, record: result.value.record, items: result.value.items };
  }

  function wipeStockInTx(db, stationId) {
    const s = stmts(db);
    const lost = s.stockAll.all(stationId).map((r) => Object.freeze({ itemKind: r.item_kind, itemKey: r.item_key,
      quantity: r.quantity }));
    s.stockWipe.run(stationId);
    return lost;
  }

  function validateTransition(change) {
    if (!isPlainObject(change)) return "change";
    const extra = unknownField(change, TRANSITION_FIELDS);
    if (extra !== undefined) return `change.${extra}`;
    if (!isText(change.stationId, MAX_STATION_ID_LENGTH)) return "change.stationId";
    if (!isId(change.expectedVersion)) return "change.expectedVersion";
    if (!isText(change.key, MAX_KEY_LENGTH)) return "change.key";
    if (!isText(change.reason, MAX_REASON_LENGTH)) return "change.reason";
    if (!isTime(change.at)) return "change.at";
    const patch = change.patch === undefined ? {} : change.patch;
    if (!isPlainObject(patch) || unknownField(patch, ["stateUntilAt"]) !== undefined) return "change.patch";
    if (own(patch, "stateUntilAt") && !(patch.stateUntilAt === null || isTime(patch.stateUntilAt))) {
      return "change.patch.stateUntilAt";
    }
    if (change.wipeStock !== undefined && (change.wipeStock !== true || change.to === DESTROYED_STATION_STATE)) {
      return "change.wipeStock";
    }
    return null;
  }

  function transitionStation(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = validateTransition(change);
    if (bad !== null) return invalid(bad);
    const edge = canTransitionStation(change.from, change.to);
    if (!edge.ok) return edge.reason === "UNKNOWN_STATE" ? invalid("change.from/to") : edge;
    const patch = change.patch === undefined ? {} : { ...change.patch };
    const destroyed = change.to === DESTROYED_STATION_STATE;
    const wipe = destroyed || change.wipeStock === true;
    const payload = { stationId: change.stationId, from: change.from, to: change.to, reason: change.reason, patch };
    if (change.wipeStock === true) payload.wipeStock = true;
    const result = journal.applyOnce(tx, { key: change.key,
      aggregate: { type: STATION_AGGREGATE, id: change.stationId }, eventType: EVENT_STATION_TRANSITION,
      payload }, (db) => {
      const row = readRow(db, change.stationId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
      if (row.state !== change.from) return { ok: false, reason: "STATE_MISMATCH", expected: change.from,
        actual: row.state };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      const lostStock = wipe ? wipeStockInTx(db, change.stationId) : [];
      const columns = { state: change.to, updated_at: change.at };
      if (destroyed) Object.assign(columns, { destroyed_at: change.at, state_until_at: null });
      else if (own(patch, "stateUntilAt")) columns.state_until_at = patch.stateUntilAt;
      const updated = updateWithVersion(db, STATIONS_TABLE, change.stationId, change.expectedVersion, columns);
      if (!updated.ok) return updated;
      return { ok: true, record: readRow(db, change.stationId), lostStock };
    });
    if (!result.ok) return unwrapApply(result);
    if (result.duplicate) return { ok: true, duplicate: true };
    changeCount += 1;
    if (destroyed) count("stations.destroyedWipes");
    return { ok: true, record: result.value.record, lostStock: result.value.lostStock };
  }

  function validateCapture(change) {
    if (!isPlainObject(change)) return "change";
    const extra = unknownField(change, CAPTURE_FIELDS);
    if (extra !== undefined) return `change.${extra}`;
    if (!isText(change.stationId, MAX_STATION_ID_LENGTH)) return "change.stationId";
    if (!isId(change.expectedVersion)) return "change.expectedVersion";
    if (!REINFORCE_STATES.includes(change.from)) return "change.from";
    if (!isId(change.ownerFactionId)) return "change.ownerFactionId";
    if (!isId(change.ownerCorporationId)) return "change.ownerCorporationId";
    if (!isText(change.key, MAX_KEY_LENGTH)) return "change.key";
    if (!isText(change.reason, MAX_REASON_LENGTH)) return "change.reason";
    if (!isTime(change.at)) return "change.at";
    return null;
  }

  function captureStation(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = validateCapture(change);
    if (bad !== null) return invalid(bad);
    const edge = canTransitionStation(change.from, INITIAL_STATION_STATE);
    if (!edge.ok) return edge;
    let known = false;
    try {
      known = isKnownFaction(change.ownerFactionId) === true;
    } catch (_err) {
      known = false;
    }
    if (!known) return { ok: false, reason: "UNKNOWN_FACTION", detail: String(change.ownerFactionId) };
    const payload = { stationId: change.stationId, from: change.from, to: INITIAL_STATION_STATE,
      ownerFactionId: change.ownerFactionId, ownerCorporationId: change.ownerCorporationId, reason: change.reason };
    const result = journal.applyOnce(tx, { key: change.key,
      aggregate: { type: STATION_AGGREGATE, id: change.stationId }, eventType: EVENT_STATION_CAPTURED, payload },
    (db) => {
      const s = stmts(db);
      const row = readRow(db, change.stationId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
      if (row.state !== change.from) return { ok: false, reason: "STATE_MISMATCH", expected: change.from,
        actual: row.state };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.ownerFactionId === change.ownerFactionId) return { ok: false, reason: "SAME_OWNER" };
      const fac = toBind(change.ownerFactionId);
      const D = DESTROYED_STATION_STATE;
      if (s.liveInSystemOfFaction.get(toBind(row.systemId), fac, D).n >= L.maxPerSystemPerFaction) {
        return { ok: false, reason: "SYSTEM_FACTION_STATION_LIMIT" };
      }
      if (s.liveOfFaction.get(fac, D).n >= L.maxPerFaction) return { ok: false, reason: "FACTION_STATION_LIMIT" };
      const lostStock = wipeStockInTx(db, change.stationId);
      const updated = updateWithVersion(db, STATIONS_TABLE, change.stationId, change.expectedVersion,
        { state: INITIAL_STATION_STATE, state_until_at: null, owner_faction_id: change.ownerFactionId,
          owner_corporation_id: change.ownerCorporationId, updated_at: change.at });
      if (!updated.ok) return updated;
      return { ok: true, record: readRow(db, change.stationId), lostStock, previousOwnerFactionId: row.ownerFactionId };
    });
    if (!result.ok) return unwrapApply(result);
    if (result.duplicate) return { ok: true, duplicate: true };
    changeCount += 1;
    count("stations.captured");
    return { ok: true, record: result.value.record, lostStock: result.value.lostStock,
      previousOwnerFactionId: result.value.previousOwnerFactionId };
  }

  function validateReassign(change) {
    if (!isPlainObject(change)) return "change";
    const extra = unknownField(change, CAPTURE_FIELDS);
    if (extra !== undefined) return `change.${extra}`;
    if (!isText(change.stationId, MAX_STATION_ID_LENGTH)) return "change.stationId";
    if (!isId(change.expectedVersion)) return "change.expectedVersion";
    if (change.from !== INITIAL_STATION_STATE) return "change.from";
    if (!isId(change.ownerFactionId)) return "change.ownerFactionId";
    if (!isId(change.ownerCorporationId)) return "change.ownerCorporationId";
    if (!isText(change.key, MAX_KEY_LENGTH)) return "change.key";
    if (!isText(change.reason, MAX_REASON_LENGTH)) return "change.reason";
    if (!isTime(change.at)) return "change.at";
    return null;
  }

  function reassignOwner(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = validateReassign(change);
    if (bad !== null) return invalid(bad);
    let known = false;
    try {
      known = isKnownFaction(change.ownerFactionId) === true;
    } catch (_err) {
      known = false;
    }
    if (!known) return { ok: false, reason: "UNKNOWN_FACTION", detail: String(change.ownerFactionId) };
    const payload = { stationId: change.stationId, from: change.from, to: INITIAL_STATION_STATE,
      ownerFactionId: change.ownerFactionId, ownerCorporationId: change.ownerCorporationId, reason: change.reason };
    const result = journal.applyOnce(tx, { key: change.key,
      aggregate: { type: STATION_AGGREGATE, id: change.stationId }, eventType: EVENT_STATION_REASSIGNED, payload },
    (db) => {
      const s = stmts(db);
      const row = readRow(db, change.stationId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
      if (row.state !== change.from) return { ok: false, reason: "STATE_MISMATCH", expected: change.from,
        actual: row.state };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      if (row.ownerFactionId === change.ownerFactionId) return { ok: false, reason: "SAME_OWNER" };
      const fac = toBind(change.ownerFactionId);
      const D = DESTROYED_STATION_STATE;
      if (s.liveInSystemOfFaction.get(toBind(row.systemId), fac, D).n >= L.maxPerSystemPerFaction) {
        return { ok: false, reason: "SYSTEM_FACTION_STATION_LIMIT" };
      }
      if (s.liveOfFaction.get(fac, D).n >= L.maxPerFaction) return { ok: false, reason: "FACTION_STATION_LIMIT" };
      const lostStock = wipeStockInTx(db, change.stationId);
      const updated = updateWithVersion(db, STATIONS_TABLE, change.stationId, change.expectedVersion,
        { owner_faction_id: change.ownerFactionId, owner_corporation_id: change.ownerCorporationId,
          updated_at: change.at });
      if (!updated.ok) return updated;
      return { ok: true, record: readRow(db, change.stationId), lostStock, previousOwnerFactionId: row.ownerFactionId };
    });
    if (!result.ok) return unwrapApply(result);
    if (result.duplicate) return { ok: true, duplicate: true };
    changeCount += 1;
    count("stations.reassigned");
    return { ok: true, record: result.value.record, lostStock: result.value.lostStock,
      previousOwnerFactionId: result.value.previousOwnerFactionId };
  }

  function validateProjection(p) {
    if (!isPlainObject(p)) return "projection";
    const extra = unknownField(p, PROJECTION_FIELDS);
    if (extra !== undefined) return `projection.${extra}`;
    if (!isText(p.stationId, MAX_STATION_ID_LENGTH)) return "projection.stationId";
    if (!isId(p.evejsItemId)) return "projection.evejsItemId";
    if (!isPosition(p.position)) return "projection.position";
    if (!isText(p.key, MAX_KEY_LENGTH)) return "projection.key";
    if (!isTime(p.at)) return "projection.at";
    return null;
  }

  function recordProjection(tx, projection) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = validateProjection(projection);
    if (bad !== null) return invalid(bad);
    const { stationId, evejsItemId, key, at } = projection;
    const position = { x: projection.position.x, y: projection.position.y, z: projection.position.z };
    const result = journal.applyOnce(tx, { key, aggregate: { type: STATION_AGGREGATE, id: stationId },
      eventType: EVENT_STATION_PROJECTED, payload: { stationId, evejsItemId, position } }, (db) => {
      const row = readRow(db, stationId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
      const updated = updateWithVersion(db, STATIONS_TABLE, stationId, row.version,
        { evejs_item_id: evejsItemId, position_json: JSON.stringify(position), updated_at: at });
      if (!updated.ok) return updated;
      return { ok: true, record: readRow(db, stationId) };
    });
    if (!result.ok) return unwrapApply(result);
    if (result.duplicate) return { ok: true, duplicate: true };
    changeCount += 1;
    return { ok: true, record: result.value.record };
  }

  return Object.freeze({
    createStation,
    recordProjection,
    getStation,
    listStationsInSystem,
    listStationsOfFaction,
    listLiveStations,
    countLiveBySystem,
    liveCounts,
    countLiveAll,
    getStock,
    getStocks,
    summarizeStock,
    applyStockChange,
    transitionStation,
    captureStation,
    reassignOwner,
    wipeStockInTx,
    getChangeCount: () => changeCount,
    limits: L,
  });
}

module.exports = { createStationRepository, STATIONS_TABLE };
