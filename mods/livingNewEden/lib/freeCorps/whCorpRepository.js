"use strict";

const { toBind } = require("../persistence/repository");
const { MAX_END_REASON_LENGTH } = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const VERSION_CONFLICT = Object.freeze({ ok: false, reason: "VERSION_CONFLICT" });
const NOT_FOUND = Object.freeze({ ok: false, reason: "NOT_FOUND" });
const J_TAKEN = Object.freeze({ ok: false, reason: "J_TAKEN" });
const EXISTS = Object.freeze({ ok: false, reason: "EXISTS" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isJ = (v) => Number.isSafeInteger(v) && v >= 31000000 && v <= 31999999;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));

const COLUMNS = "corp_id, j_system_id, staging_system_id, open, loot_isk, gas_isk, cargo_loot_isk, cargo_gas_isk, "
  + "cargo_venture_seq, pi_isk_total, sold_isk_total, home_done, haul_done, raid_done, founded_at, updated_at, "
  + "ended_at, end_reason, version";
const INT_COLUMNS = Object.freeze(["corp_id", "j_system_id", "staging_system_id", "open", "loot_isk", "gas_isk",
  "cargo_loot_isk", "cargo_gas_isk", "cargo_venture_seq", "pi_isk_total", "sold_isk_total", "home_done", "haul_done",
  "raid_done", "founded_at", "updated_at", "ended_at", "version"]);
const MUTABLE = Object.freeze(["loot_isk", "gas_isk", "cargo_loot_isk", "cargo_gas_isk", "cargo_venture_seq",
  "pi_isk_total", "sold_isk_total", "home_done", "haul_done", "raid_done"]);
const VIEW_INT_COLUMNS = Object.freeze(["corp_id", "j_system_id", "staging_system_id", "loot_isk", "gas_isk",
  "cargo_loot_isk", "cargo_gas_isk", "cargo_venture_seq", "pi_isk_total", "sold_isk_total", "home_done", "haul_done",
  "raid_done", "founded_at", "isk", "v_system_id", "v_step", "v_steps_total"]);

function rowOf(r) {
  const out = { ...r };
  for (const c of INT_COLUMNS) out[c] = num(r[c]);
  out.end_reason = r.end_reason === null || r.end_reason === undefined ? null : String(r.end_reason);
  return Object.freeze(out);
}

function isUnique(err) {
  return Boolean(err && typeof err.code === "string"
    && (err.code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || err.code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")))
    || Boolean(err && /UNIQUE constraint failed/.test(String(err.message)));
}

function createFreeCorpWhCorpRepository() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      getOpen: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_wh_homes WHERE open = 1 AND corp_id = ?`),
      any: db.prepare("SELECT EXISTS (SELECT 1 FROM world_free_corp_wh_homes WHERE open = 1) AS hit"),
      taken: db.prepare("SELECT 1 AS hit FROM world_free_corp_wh_homes WHERE open = 1 AND j_system_id = ? LIMIT 1"),
      byPk: db.prepare("SELECT version, open FROM world_free_corp_wh_homes WHERE corp_id = ?"),
      insert: db.prepare(`INSERT INTO world_free_corp_wh_homes (corp_id, j_system_id, staging_system_id, open,
        founded_at, updated_at, version) VALUES (?, ?, ?, 1, ?, ?, 1)`),
      update: db.prepare("UPDATE world_free_corp_wh_homes SET loot_isk = ?, gas_isk = ?, cargo_loot_isk = ?, "
        + "cargo_gas_isk = ?, cargo_venture_seq = ?, pi_isk_total = ?, sold_isk_total = ?, home_done = ?, "
        + "haul_done = ?, raid_done = ?, version = version + 1, updated_at = ? "
        + "WHERE corp_id = ? AND version = ? AND open = 1"),
      orphans: db.prepare("SELECT h.corp_id, h.version FROM world_free_corp_wh_homes h WHERE h.open = 1 "
        + "AND NOT EXISTS (SELECT 1 FROM world_free_corps c WHERE c.corp_id = h.corp_id AND c.open = 1) "
        + "ORDER BY h.corp_id LIMIT ?"),
      close: db.prepare("UPDATE world_free_corp_wh_homes SET open = 0, ended_at = ?, end_reason = ?, "
        + "cargo_loot_isk = 0, cargo_gas_isk = 0, cargo_venture_seq = NULL, version = version + 1, updated_at = ? "
        + "WHERE corp_id = ? AND version = ? AND open = 1"),
      viewList: db.prepare("SELECT h.corp_id, h.j_system_id, h.staging_system_id, h.loot_isk, h.gas_isk, "
        + "h.cargo_loot_isk, h.cargo_gas_isk, h.cargo_venture_seq, h.pi_isk_total, h.sold_isk_total, h.home_done, "
        + "h.haul_done, h.raid_done, h.founded_at, c.name, c.ticker, c.isk, v.kind AS v_kind, v.state AS v_state, "
        + "v.system_id AS v_system_id, v.step AS v_step, v.steps_total AS v_steps_total "
        + "FROM world_free_corp_wh_homes h JOIN world_free_corps c ON c.corp_id = h.corp_id "
        + "LEFT JOIN world_free_corp_ventures v ON v.corp_id = h.corp_id AND v.open = 1 "
        + "WHERE h.open = 1 ORDER BY h.corp_id LIMIT ?"),
      viewStats: db.prepare("SELECT COUNT(*) AS open, COALESCE(SUM(loot_isk), 0) AS loot, "
        + "COALESCE(SUM(gas_isk), 0) AS gas, COALESCE(SUM(cargo_loot_isk + cargo_gas_isk), 0) AS cargo, "
        + "COALESCE(SUM(pi_isk_total), 0) AS pi, COALESCE(SUM(sold_isk_total), 0) AS sold, "
        + "COALESCE(SUM(home_done), 0) AS home_done, COALESCE(SUM(haul_done), 0) AS haul_done, "
        + "COALESCE(SUM(raid_done), 0) AS raid_done FROM world_free_corp_wh_homes WHERE open = 1"),
    };
    cache.set(db, s);
    return s;
  }

  function missOf(tx, corpId) {
    const r = stmts(tx).byPk.get(toBind(corpId));
    return r && num(r.open) === 1 ? VERSION_CONFLICT : NOT_FOUND;
  }

  function getOpenInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    const r = stmts(tx).getOpen.get(toBind(corpId));
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function anyOpenInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, any: num(stmts(tx).any.get().hit) === 1 };
  }

  function isJTakenInTx(tx, jSystemId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isJ(jSystemId)) return invalid("jSystemId");
    return { ok: true, taken: Boolean(stmts(tx).taken.get(toBind(jSystemId))) };
  }

  function insertInTx(tx, { corpId, jSystemId, stagingSystemId, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isJ(jSystemId) || !isId(stagingSystemId) || !isTime(now)) return invalid("insert");
    const s = stmts(tx);
    if (s.byPk.get(toBind(corpId))) return EXISTS;
    if (s.taken.get(toBind(jSystemId))) return J_TAKEN;
    try {
      s.insert.run(toBind(corpId), toBind(jSystemId), toBind(stagingSystemId), toBind(now), toBind(now));
    } catch (err) {
      if (isUnique(err)) return J_TAKEN;
      throw err;
    }
    return { ok: true };
  }

  function updateInTx(tx, { corpId, expectedVersion, patch, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(expectedVersion) || !isTime(now) || !patch || typeof patch !== "object") {
      return invalid("update");
    }
    for (const k of Object.keys(patch)) if (!MUTABLE.includes(k)) return invalid(k);
    const g = stmts(tx).getOpen.get(toBind(corpId));
    if (!g) return NOT_FOUND;
    const cur = rowOf(g);
    if (cur.version !== expectedVersion) return VERSION_CONFLICT;
    const next = { ...cur };
    for (const k of MUTABLE) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
    for (const k of MUTABLE) {
      if (k === "cargo_venture_seq") {
        if (next[k] !== null && !isId(next[k])) return invalid(k);
      } else if (!isTime(next[k])) {
        return invalid(k);
      }
    }
    const info = stmts(tx).update.run(toBind(next.loot_isk), toBind(next.gas_isk), toBind(next.cargo_loot_isk),
      toBind(next.cargo_gas_isk), next.cargo_venture_seq === null ? null : toBind(next.cargo_venture_seq),
      toBind(next.pi_isk_total), toBind(next.sold_isk_total), toBind(next.home_done), toBind(next.haul_done),
      toBind(next.raid_done), toBind(now), toBind(corpId), toBind(expectedVersion));
    if (info.changes !== 1) return missOf(tx, corpId);
    return { ok: true, row: Object.freeze({ ...next, version: expectedVersion + 1, updated_at: now }) };
  }

  function listOrphansInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).orphans.all(toBind(limit)).map((r) => Object.freeze({ corp_id: num(r.corp_id),
      version: num(r.version) }));
    return { ok: true, rows };
  }

  function closeInTx(tx, { corpId, expectedVersion, reason, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(expectedVersion) || !isTime(now) || typeof reason !== "string" || reason === "") {
      return invalid("close");
    }
    const info = stmts(tx).close.run(toBind(now), reason.slice(0, MAX_END_REASON_LENGTH), toBind(now), toBind(corpId),
      toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : missOf(tx, corpId);
  }

  function listOpenForViewInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const raw = stmts(tx).viewList.all(toBind(limit + 1));
    const truncated = raw.length > limit;
    const rows = raw.slice(0, limit).map((r) => {
      const out = { ...r };
      for (const c of VIEW_INT_COLUMNS) out[c] = num(r[c]);
      out.name = String(r.name);
      out.ticker = String(r.ticker);
      out.v_kind = r.v_kind === null || r.v_kind === undefined ? null : String(r.v_kind);
      out.v_state = r.v_state === null || r.v_state === undefined ? null : String(r.v_state);
      return Object.freeze(out);
    });
    return { ok: true, rows: Object.freeze(rows), truncated };
  }

  function statsForViewInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const r = stmts(tx).viewStats.get();
    return { ok: true, open: num(r.open), lootIsk: num(r.loot), gasIsk: num(r.gas), cargoIsk: num(r.cargo),
      piIskTotal: num(r.pi), soldIskTotal: num(r.sold), homeDone: num(r.home_done), haulDone: num(r.haul_done),
      raidDone: num(r.raid_done) };
  }

  return Object.freeze({ getOpenInTx, anyOpenInTx, isJTakenInTx, insertInTx, updateInTx, listOrphansInTx,
    closeInTx, listOpenForViewInTx, statsForViewInTx });
}

module.exports = { createFreeCorpWhCorpRepository };
