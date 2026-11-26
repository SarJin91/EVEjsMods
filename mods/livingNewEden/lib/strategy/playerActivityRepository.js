"use strict";

const { toBind } = require("../persistence/repository");
const { PLAYER_ACTIVITY_TABLE_NAME, MAX_PLAYER_ACTIVITY_KILLS } = require("./schema");

const COLUMNS = "faction_id, system_id, kills, first_at, last_at, last_victim_id, updated_at, version";
const KILL_FIELDS = Object.freeze(["factionId", "systemId", "at", "victimId"]);
const LIMIT_KEYS = Object.freeze(["playerActivityWindowMs", "playerActivityMaxKills",
  "maxPlayerActivityRowsPerFaction"]);
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

function toRecord(row) {
  return Object.freeze({ kills: Number(row.kills), firstAt: Number(row.first_at), lastAt: Number(row.last_at) });
}

function createPlayerActivityRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createPlayerActivityRepository: deps missing");
  const { limits, onCount } = deps;
  for (const name of LIMIT_KEYS) {
    if (!limits || !Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`createPlayerActivityRepository: limits.${name} must be a positive integer`);
    }
  }
  const L = Object.freeze(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k]])));
  const maxKills = Math.min(L.playerActivityMaxKills, MAX_PLAYER_ACTIVITY_KILLS);
  const count = (name) => {
    if (typeof onCount !== "function") return;
    try {
      onCount(name, 1);
    } catch (_err) {
    }
  };

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const T = PLAYER_ACTIVITY_TABLE_NAME;
    s = {
      byKey: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE faction_id = ? AND system_id = ?`),
      countOf: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ?`),
      oldest: db.prepare(`SELECT system_id FROM ${T} WHERE faction_id = ? ORDER BY last_at, system_id LIMIT 1`),
      remove: db.prepare(`DELETE FROM ${T} WHERE faction_id = ? AND system_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, 1, ?, ?, ?, ?, 1)`),
      update: db.prepare(`UPDATE ${T} SET kills = ?, first_at = ?, last_at = ?, last_victim_id = ?, updated_at = ?,
        version = version + 1 WHERE faction_id = ? AND system_id = ? AND version = ?`),
      active: db.prepare(`SELECT system_id, kills FROM ${T} WHERE faction_id = ? AND last_at >= ?
        ORDER BY system_id LIMIT ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function validate(kill) {
    if (!isPlainObject(kill)) return "kill";
    for (const key of Object.keys(kill)) if (!KILL_FIELDS.includes(key)) return `kill.${key}`;
    if (!isId(kill.factionId)) return "kill.factionId";
    if (!isId(kill.systemId)) return "kill.systemId";
    if (!isTime(kill.at)) return "kill.at";
    if (kill.victimId !== null && kill.victimId !== undefined && !isId(kill.victimId)) return "kill.victimId";
    return null;
  }

  function recordKillInTx(tx, kill) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    const bad = validate(kill);
    if (bad !== null) return invalid(bad);
    const victimId = isId(kill.victimId) ? kill.victimId : null;
    const s = stmts(tx);
    const f = toBind(kill.factionId);
    const sys = toBind(kill.systemId);
    const row = s.byKey.get(f, sys) || null;
    if (row !== null && victimId !== null && Number(row.last_at) === kill.at && row.last_victim_id !== null
      && Number(row.last_victim_id) === victimId) {
      count("strategy.playerActivity.duplicate");
      return { ok: true, duplicate: true, evicted: 0, record: toRecord(row) };
    }
    let evicted = 0;
    if (row !== null) {
      const lastAt = Number(row.last_at);
      const inWindow = lastAt >= kill.at - L.playerActivityWindowMs;
      const kills = inWindow ? Math.min(Number(row.kills) + 1, maxKills) : 1;
      const firstAt = inWindow ? Number(row.first_at) : kill.at;
      const latest = kill.at >= lastAt;
      const lastVictim = latest ? victimId : (row.last_victim_id === null ? null : Number(row.last_victim_id));
      const r = s.update.run(toBind(kills), toBind(firstAt), toBind(Math.max(lastAt, kill.at)),
        lastVictim === null ? null : toBind(lastVictim), toBind(kill.at), f, sys, toBind(row.version));
      if (r.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
    } else {
      if (Number(s.countOf.get(f).n) >= L.maxPlayerActivityRowsPerFaction) {
        const old = s.oldest.get(f);
        if (old) {
          s.remove.run(f, old.system_id);
          evicted = 1;
        }
      }
      s.insert.run(f, sys, toBind(kill.at), toBind(kill.at), victimId === null ? null : toBind(victimId),
        toBind(kill.at));
    }
    count("strategy.playerActivity.recorded");
    if (evicted === 1) count("strategy.playerActivity.evicted");
    return { ok: true, record: toRecord(s.byKey.get(f, sys)), evicted };
  }

  function listActive(tx, factionId, at, limit) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!isTime(at)) return invalid("at");
    if (!isId(limit)) return invalid("limit");
    const n = Math.min(limit, L.maxPlayerActivityRowsPerFaction);
    const edge = Math.max(0, at - L.playerActivityWindowMs);
    return { ok: true, items: Object.freeze(stmts(tx).active.all(toBind(factionId), toBind(edge), toBind(n))
      .map((row) => Object.freeze({ systemId: Number(row.system_id), kills: Number(row.kills) }))) };
  }

  return Object.freeze({ recordKillInTx, listActive, limits: L });
}

module.exports = { createPlayerActivityRepository };
