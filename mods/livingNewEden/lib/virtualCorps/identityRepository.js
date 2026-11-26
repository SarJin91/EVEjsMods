"use strict";

const {
  IDENTITY_KINDS,
  IDENTITY_STATES,
  MAX_IDENTITY_KEY_LENGTH,
  MAX_FOUNDING_OP_LENGTH,
  MAX_KIND_LENGTH,
  MAX_OWNER_KIND_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TICKER_LENGTH,
  MAX_STATE_LENGTH,
  MAX_REASON_LENGTH,
  foundingOpOf,
  identityKeyForAlliance,
  identityKeyForCorporation,
  identityKeyForCharacter,
  parseIdentityKey,
  REASON_INVALID_AT,
  isValidAt,
} = require("./schema");

const TABLE = "world_virtual_identities";

function createRepository(db) {
  const stmtInsert = db.prepare(`
    INSERT INTO ${TABLE} (
      identity_key, founding_op, kind, owner_kind, owner_id,
      evejs_id, state, name, ticker, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const stmtUpdate = db.prepare(`
    UPDATE ${TABLE} SET
      evejs_id = ?, state = ?, name = ?, ticker = ?, updated_at = ?, version = version + 1
    WHERE identity_key = ? AND version = ?
  `);

  const stmtUpdateState = db.prepare(`
    UPDATE ${TABLE} SET state = ?, updated_at = ?, version = version + 1
    WHERE identity_key = ? AND version = ?
  `);

  const stmtUpdateStateWithReason = db.prepare(`
    UPDATE ${TABLE} SET state = ?, updated_at = ?, reason = ?, version = version + 1
    WHERE identity_key = ? AND version = ?
  `);

  const stmtUpdateEvejsId = db.prepare(`
    UPDATE ${TABLE} SET evejs_id = ?, state = ?, updated_at = ?, version = version + 1
    WHERE identity_key = ? AND version = ?
  `);

  const stmtUpdateEvejsIdWithReason = db.prepare(`
    UPDATE ${TABLE} SET evejs_id = ?, state = ?, updated_at = ?, reason = ?, version = version + 1
    WHERE identity_key = ? AND version = ?
  `);

  const stmtGetByKey = db.prepare(`
    SELECT * FROM ${TABLE} WHERE identity_key = ?
  `);

  const stmtGetByEvejsId = db.prepare(`
    SELECT * FROM ${TABLE} WHERE kind = ? AND evejs_id = ?
  `);

  const stmtListByOwner = db.prepare(`
    SELECT * FROM ${TABLE} WHERE owner_kind = ? AND owner_id = ? ORDER BY identity_key
  `);

  const stmtListPending = db.prepare(`
    SELECT * FROM ${TABLE} WHERE state IN (?, ?) ORDER BY identity_key
  `);

  const stmtListByState = db.prepare(`
    SELECT * FROM ${TABLE} WHERE state = ? ORDER BY identity_key
  `);

  const stmtCountByOwner = db.prepare(`
    SELECT COUNT(*) as cnt FROM ${TABLE} WHERE owner_kind = ? AND owner_id = ?
  `);

  const stmtCountByState = db.prepare(`
    SELECT COUNT(*) as cnt FROM ${TABLE} WHERE state = ?
  `);

  const stmtDeleteByOwner = db.prepare(`
    DELETE FROM ${TABLE} WHERE owner_kind = ? AND owner_id = ?
  `);

  const stmtCharactersByEvejsId = db.prepare(`
    SELECT * FROM ${TABLE} WHERE kind = 'character' AND evejs_id = ? ORDER BY identity_key
  `);

  const stmtInsertAdopted = db.prepare(`
    INSERT INTO ${TABLE} (
      identity_key, founding_op, kind, owner_kind, owner_id,
      evejs_id, state, name, ticker, race_id, bloodline_id, gender, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1)
  `);

  return {
    insert(entry) {
      const now = entry && entry.at;
      if (!isValidAt(now)) return { ok: false, reason: REASON_INVALID_AT };
      try {
        const info = stmtInsert.run(
          entry.key,
          entry.foundingOp,
          entry.kind,
          entry.ownerKind,
          entry.ownerId,
          null,
          entry.state,
          entry.name || null,
          entry.ticker || null,
          now,
          now
        );
        if (info.changes !== 1) return { ok: false, reason: "INSERT_FAILED" };
        return { ok: true };
      } catch (err) {
        if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
          return { ok: false, reason: "DUPLICATE_KEY" };
        }
        return { ok: false, reason: `insert: ${err.message}` };
      }
    },

    insertMany(entries) {
      const tx = db.transaction((entries) => {
        let count = 0;
        for (const e of entries) {
          const res = this.insert(e);
          if (!res.ok) throw new Error(res.reason);
          count++;
        }
        return count;
      });
      try {
        const count = tx(entries);
        return { ok: true, count };
      } catch (err) {
        return { ok: false, reason: err.message, count: 0 };
      }
    },

    getByKey(key) {
      try {
        const row = stmtGetByKey.get(key);
        if (!row) return { ok: false, reason: "NOT_FOUND" };
        return { ok: true, row };
      } catch (err) {
        return { ok: false, reason: `getByKey: ${err.message}` };
      }
    },

    getByEvejsId(kind, evejsId) {
      try {
        const row = stmtGetByEvejsId.get(kind, evejsId);
        if (!row) return { ok: false, reason: "NOT_FOUND" };
        return { ok: true, row };
      } catch (err) {
        return { ok: false, reason: `getByEvejsId: ${err.message}` };
      }
    },

    updateState(key, expectedVersion, newState, extra = {}) {
      const now = extra && extra.at;
      if (!isValidAt(now)) return { ok: false, reason: REASON_INVALID_AT };
      try {
        let info;
        const hasReason = extra.reason !== undefined && extra.reason !== null && extra.reason !== "";
        let reason = extra.reason;
        if (hasReason && typeof reason === "string" && reason.length > MAX_REASON_LENGTH) {
          reason = reason.substring(0, MAX_REASON_LENGTH);
        }
        if (extra.evejsId !== undefined) {
          if (hasReason) {
            info = stmtUpdateEvejsIdWithReason.run(extra.evejsId, newState, now, reason, key, expectedVersion);
          } else {
            info = stmtUpdateEvejsId.run(extra.evejsId, newState, now, key, expectedVersion);
          }
        } else {
          if (hasReason) {
            info = stmtUpdateStateWithReason.run(newState, now, reason, key, expectedVersion);
          } else {
            info = stmtUpdateState.run(newState, now, key, expectedVersion);
          }
        }
        if (info.changes !== 1) return { ok: false, reason: "CAS_FAILED" };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `updateState: ${err.message}` };
      }
    },

    update(key, expectedVersion, fields) {
      const now = fields && fields.at;
      if (!isValidAt(now)) return { ok: false, reason: REASON_INVALID_AT };
      try {
        const info = stmtUpdate.run(
          fields.evejsId ?? null,
          fields.state ?? null,
          fields.name ?? null,
          fields.ticker ?? null,
          now,
          key,
          expectedVersion
        );
        if (info.changes !== 1) return { ok: false, reason: "CAS_FAILED" };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `update: ${err.message}` };
      }
    },

    listByOwner(ownerKind, ownerId) {
      return stmtListByOwner.all(ownerKind, ownerId);
    },

    listPending() {
      return stmtListPending.all(IDENTITY_STATES.PLANNED, IDENTITY_STATES.RESERVED);
    },

    listByState(state) {
      return stmtListByState.all(state);
    },

    readByState(state) {
      return { ok: true, rows: stmtListByState.all(state) };
    },

    countByOwner(ownerKind, ownerId) {
      const row = stmtCountByOwner.get(ownerKind, ownerId);
      return row ? row.cnt : 0;
    },

    countByState(state) {
      const row = stmtCountByState.get(state);
      return row ? row.cnt : 0;
    },

    deleteByOwner(ownerKind, ownerId) {
      const info = stmtDeleteByOwner.run(ownerKind, ownerId);
      return info.changes;
    },

    foundingOpExists(foundingOp) {
      const row = db.prepare(`SELECT 1 FROM ${TABLE} WHERE founding_op = ?`).get(foundingOp);
      return !!row;
    },

    listCharactersByEvejsId(evejsId) {
      if (!Number.isSafeInteger(evejsId) || evejsId <= 0) return { ok: false, reason: "INVALID_INPUT" };
      try {
        return { ok: true, rows: stmtCharactersByEvejsId.all(evejsId) };
      } catch (err) {
        return { ok: false, reason: `listCharactersByEvejsId: ${err.message}` };
      }
    },

    adoptCharacter(a) {
      const at = a && a.at;
      if (!isValidAt(at)) return { ok: false, reason: REASON_INVALID_AT };
      const entry = a.entry;
      const characterId = a.characterId;
      if (!entry || entry.kind !== IDENTITY_KINDS.CHARACTER || typeof entry.key !== "string"
        || typeof entry.foundingOp !== "string" || !Number.isSafeInteger(characterId) || characterId <= 0) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
      const run = db.transaction(() => {
        const existing = stmtGetByKey.get(entry.key);
        if (existing) {
          return { ok: true, adopted: Number(existing.evejs_id) === characterId, duplicate: true };
        }
        const sources = stmtCharactersByEvejsId.all(characterId).filter((r) => r.identity_key !== entry.key
          && (r.state === IDENTITY_STATES.LINKED || r.state === IDENTITY_STATES.CREATED));
        if (sources.length === 0) {
          const res = this.insert({ key: entry.key, foundingOp: entry.foundingOp, kind: entry.kind,
            ownerKind: entry.ownerKind, ownerId: entry.ownerId, state: IDENTITY_STATES.PLANNED, at });
          if (!res.ok) throw new Error(res.reason);
          return { ok: true, adopted: false, reason: "NO_SOURCE" };
        }
        const first = sources[0];
        stmtInsertAdopted.run(entry.key, entry.foundingOp, entry.kind, entry.ownerKind, entry.ownerId, characterId,
          IDENTITY_STATES.CREATED, first.name || null, first.race_id ?? null, first.bloodline_id ?? null,
          first.gender || null, at, at);
        for (const s of sources) {
          const info = stmtUpdateState.run(IDENTITY_STATES.RELEASED, at, s.identity_key, s.version);
          if (info.changes !== 1) throw new Error(`CAS_FAILED ${s.identity_key}`);
        }
        return { ok: true, adopted: true, released: sources.length };
      });
      try {
        return run();
      } catch (err) {
        return { ok: false, reason: `adoptCharacter: ${String((err && err.message) || err).slice(0, 120)}` };
      }
    },

    findOrCreate(entry) {
      const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE founding_op = ?`).get(entry.foundingOp);
      if (existing) {
        return { ok: true, row: existing, created: false };
      }
      const res = this.insert(entry);
      if (!res.ok) return { ok: false, reason: res.reason, created: false };
      const row = this.getByKey(entry.key);
      return { ok: true, row: row.row, created: true };
    },
  };
}

const STORE_METHOD_FALLBACKS = Object.freeze({
  insert: "result",
  insertMany: "result",
  getByKey: "result",
  getByEvejsId: "result",
  updateState: "result",
  update: "result",
  findOrCreate: "result",
  listCharactersByEvejsId: "result",
  adoptCharacter: "result",
  listByOwner: "list",
  listPending: "list",
  listByState: "list",
  countByOwner: "number",
  countByState: "number",
  deleteByOwner: "number",
  foundingOpExists: "boolean",
});

const TX_NESTED_COUNTER = "virtualCorps.txNested";
const STORE_FAILED_COUNTER = "virtualCorps.storeFailed";
let txNestedLogged = false;
let storeFailedLogged = false;

function _resetLogFlagsForTest() {
  txNestedLogged = false;
  storeFailedLogged = false;
}

function fallbackOf(kind, reason) {
  if (kind === "result") return { ok: false, reason };
  if (kind === "list") return [];
  if (kind === "number") return 0;
  return false;
}

function createStoreRepository(store, opts = {}) {
  const telemetry = opts.telemetry || null;
  const logger = opts.logger || null;
  let base = null;
  let baseDb = null;

  function baseOf(db) {
    if (base === null || baseDb !== db) {
      base = createRepository(db);
      baseDb = db;
    }
    return base;
  }

  function nested(method, kind) {
    if (telemetry && typeof telemetry.count === "function") telemetry.count(TX_NESTED_COUNTER);
    if (!txNestedLogged && logger && typeof logger.log === "function") {
      txNestedLogged = true;
      logger.log(`virtualCorps: repository call ${method} inside an open store transaction refused (TX_NESTED)`);
    }
    return fallbackOf(kind, "TX_NESTED");
  }

  const repo = {};
  for (const [method, kind] of Object.entries(STORE_METHOD_FALLBACKS)) {
    repo[method] = (...args) => {
      if (typeof store.isInTransaction === "function" && store.isInTransaction()) return nested(method, kind);
      const tx = store.transaction(`virtualCorps.${method}`, (db) => baseOf(db)[method](...args));
      if (tx && tx.reason === "TX_NESTED") return nested(method, kind);
      if (!tx || tx.ok !== true) {
        const reason = (tx && tx.reason) || "TX_FAILED";
        if (telemetry && typeof telemetry.count === "function") telemetry.count(STORE_FAILED_COUNTER);
        if (!storeFailedLogged && logger && typeof logger.log === "function") {
          storeFailedLogged = true;
          logger.log(`virtualCorps: repository call ${method} failed (${reason})`);
        }
        return fallbackOf(kind, reason);
      }
      return tx.value;
    };
  }
  repo.readByState = (state) => {
    if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
      if (telemetry && typeof telemetry.count === "function") telemetry.count(TX_NESTED_COUNTER);
      if (!txNestedLogged && logger && typeof logger.log === "function") {
        txNestedLogged = true;
        logger.log(`virtualCorps: repository call readByState inside an open store transaction refused (TX_NESTED)`);
      }
      return { ok: false, reason: "TX_NESTED" };
    }
    const tx = store.transaction("virtualCorps.readByState", (db) => baseOf(db).listByState(state));
    if (tx && tx.reason === "TX_NESTED") {
      if (telemetry && typeof telemetry.count === "function") telemetry.count(TX_NESTED_COUNTER);
      if (!txNestedLogged && logger && typeof logger.log === "function") {
        txNestedLogged = true;
        logger.log(`virtualCorps: repository call readByState inside an open store transaction refused (TX_NESTED)`);
      }
      return { ok: false, reason: "TX_NESTED" };
    }
    if (!tx || tx.ok !== true) {
      const reason = (tx && tx.reason) || "TX_FAILED";
      if (telemetry && typeof telemetry.count === "function") telemetry.count(STORE_FAILED_COUNTER);
      if (!storeFailedLogged && logger && typeof logger.log === "function") {
        storeFailedLogged = true;
        logger.log(`virtualCorps: repository call readByState failed (${reason})`);
      }
      return { ok: false, reason };
    }
    return { ok: true, rows: tx.value };
  };

  return Object.freeze(repo);
}

module.exports = { createRepository, createStoreRepository, STORE_METHOD_FALLBACKS, _resetLogFlagsForTest };